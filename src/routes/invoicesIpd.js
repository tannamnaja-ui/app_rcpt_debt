const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../auth');
const { runInvoiceStepsIpd, getDebtIdIpd, runCancelInvoiceStepsIpd } = require('../invoiceServiceIpd');

// คู่ขนานของ getPatientInfoMap (OPD) แต่ค้นหาด้วย an/ipt/ipt_pttype แทน
async function getPatientInfoMapIpd(anList) {
    const params = {};
    const placeholders = anList.map((an, i) => {
        const key = 'an' + i;
        params[key] = an;
        return ':' + key;
    });

    const isPg = db.getType() === 'pgsql';
    const dchdateExpr = isPg
        ? "TO_CHAR(i.dchdate, 'YYYY-MM-DD')"
        : "DATE_FORMAT(i.dchdate, '%Y-%m-%d')";

    const sql = `SELECT i.an, i.hn, ${dchdateExpr} AS dchdate, i.dchtime, i.pttype, pt.name AS pttype_name,
                CONCAT(p.pname, p.fname, ' ', p.lname) AS patient_name,
                SUM(CASE WHEN op.paidst = '02' THEN op.sum_price ELSE 0 END) AS debt_amount
            FROM ipt i
            JOIN patient p ON p.hn = i.hn
            LEFT JOIN pttype pt ON pt.pttype = i.pttype
            JOIN opitemrece op ON op.an = i.an
            WHERE i.an IN (${placeholders.join(', ')})
            GROUP BY i.an, i.hn, i.dchdate, i.dchtime, i.pttype, pt.name, p.pname, p.fname, p.lname`;

    const rows = await db.query(sql, params);
    const map = {};
    rows.forEach((row) => { map[String(row.an)] = row; });
    return map;
}

router.get('/an_items/:an', requireLogin, async (req, res) => {
    const an = String(req.params.an || '').trim();

    if (!an) {
        res.json({ success: false, message: 'ไม่พบ AN' });
        return;
    }

    try {
        const rows = await db.query(
            `SELECT op.icode, COALESCE(d.name, n.name, op.icode) AS item_name, op.qty, op.sum_price
            FROM opitemrece op
            LEFT JOIN drugitems d ON d.icode = op.icode
            LEFT JOIN nondrugitems n ON n.icode = op.icode
            WHERE op.an = :an AND op.paidst = '02'
            ORDER BY op.item_no`,
            { an }
        );

        const totalAmount = rows.reduce((sum, r) => sum + (parseFloat(r.sum_price) || 0), 0);
        res.json({ success: true, data: rows, total_amount: totalAmount });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ข้อมูลใบแจ้งหนี้ของ AN (สำหรับแสดงในป็อปอัพยืนยันก่อนยกเลิก) - rcpt_debt.vn เก็บค่า an ของ IPD ไว้ตรงๆ
router.get('/debt_info_ipd/:an', requireLogin, async (req, res) => {
    const an = String(req.params.an || '').trim();

    if (!an) {
        res.json({ success: false, message: 'ไม่พบ AN' });
        return;
    }

    try {
        const debts = await db.query(
            `SELECT debt_id, vn, hn, staff, amount, total_amount, debt_date_time
            FROM rcpt_debt
            WHERE vn = :an AND (status IS NULL OR status <> 'ABORT')
            ORDER BY debt_id`,
            { an }
        );

        if (debts.length === 0) {
            res.json({ success: false, message: 'ไม่พบใบแจ้งหนี้ของ AN นี้ หรือถูกยกเลิกไปแล้ว' });
            return;
        }

        const params = {};
        const placeholders = debts.map((d, i) => {
            const key = 'd' + i;
            params[key] = d.debt_id;
            return ':' + key;
        });

        const details = await db.query(
            `SELECT rd.income, COALESCE(inc.name, rd.income) AS income_name, rd.amount, rd.total_amount
            FROM rcpt_debt_detail rd
            LEFT JOIN income inc ON inc.income = rd.income
            WHERE rd.debt_id IN (${placeholders.join(', ')})
            ORDER BY rd.income`,
            params
        );

        const totalAmount = debts.reduce((sum, d) => sum + (parseFloat(d.total_amount) || 0), 0);
        res.json({ success: true, debts, details, total_amount: totalAmount });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ยกเลิกใบแจ้งหนี้ของ AN เดียว
router.post('/cancel_invoice_ipd', requireLogin, async (req, res) => {
    const body = req.body || {};
    const an = String(body.an || '').trim();

    if (!an) {
        res.json({ success: false, message: 'ไม่พบ AN' });
        return;
    }

    let conn;

    try {
        conn = await db.getConnection();
        await conn.beginTransaction();
        await runCancelInvoiceStepsIpd(conn, an);
        await conn.commit();
        res.json({ success: true, an, message: 'ยกเลิกใบแจ้งหนี้สำเร็จ' });
    } catch (e) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (e2) {
                // ignore rollback error
            }
        }

        res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + e.message });
    } finally {
        if (conn) conn.release();
    }
});

// ยกเลิกใบแจ้งหนี้หลาย AN พร้อมกัน (all-or-nothing เหมือนฝั่ง OPD)
router.post('/cancel_invoices_ipd', requireLogin, async (req, res) => {
    const body = req.body || {};
    const ans = Array.isArray(body.an) ? body.an : [];

    if (ans.length === 0) {
        res.json({ success: false, message: 'กรุณาเลือกรายการอย่างน้อย 1 รายการ' });
        return;
    }

    const anList = ans.map((an) => String(an));
    let conn;

    try {
        conn = await db.getConnection();
        await conn.beginTransaction();

        for (const an of anList) {
            await runCancelInvoiceStepsIpd(conn, an);
        }

        await conn.commit();
        res.json({ success: true, an: anList, message: 'ยกเลิกใบแจ้งหนี้สำเร็จ ' + anList.length + ' รายการ' });
    } catch (e) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (e2) {
                // ignore rollback error
            }
        }

        res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + e.message });
    } finally {
        if (conn) conn.release();
    }
});

function isDuplicateKeyError(e) {
    return e && (e.code === '23505' || e.code === 'ER_DUP_ENTRY');
}

// รายชื่อ get_serialnumber() ทั้งหมดที่ใช้ตลอด 9 ขั้นตอนออกใบแจ้งหนี้ IPD (runInvoiceStepsIpd ใน invoiceServiceIpd.js)
const REQUIRED_SERIAL_NAMES = [
    'ipt_opi_fn_tr_list_id',
    'ipt_opi_fn_tr_detail_id',
    'ipt_opi_finance_summary_id',
    'ipt_opi_fn_cr_list_id',
    'finance_number',
    'ipt_opi_fn_cr_detail_id',
    'rcpt_debt_id',
];
const warmedSerials = new Set();

// เหตุผลเดียวกับฝั่ง OPD (routes/invoices.js) - "อุ่นเครื่อง" get_serialnumber() แบบ autocommit ก่อนเข้าทรานแซกชันจริง
async function warmUpSerials() {
    for (const name of REQUIRED_SERIAL_NAMES) {
        if (warmedSerials.has(name)) continue;
        await db.query('SELECT get_serialnumber(:name)', { name });
        warmedSerials.add(name);
    }
}

// วันที่/เวลาปัจจุบัน ณ ตอนออกใบแจ้งหนี้ (เป็นวันที่ออกใบแจ้งหนี้จริง ไม่ใช่วันที่จำหน่าย)
function formatNowDateTime() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const time = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    return { date, time };
}

// ออกใบแจ้งหนี้ 1 ครั้ง ให้ AN ทุกรายการที่เลือกใช้เลขที่ใบแจ้งหนี้ (finance_number) เดียวกัน
async function attemptIssueAllIpd(anList, infoMap, staff, dbType) {
    let conn;

    try {
        await warmUpSerials();

        conn = await db.getConnection();
        await conn.beginTransaction();

        const financeIdRows = await conn.query("SELECT get_serialnumber('finance_number') AS finance_number");
        const financeNumber = String(financeIdRows[0].finance_number);
        const { date: debtDate, time: debtTime } = formatNowDateTime();

        const results = [];
        let failedAn = null;
        let failedError = null;

        for (const an of anList) {
            try {
                await runInvoiceStepsIpd(conn, an, staff, dbType, financeNumber, debtDate, debtTime);
                const debtId = await getDebtIdIpd(conn, an, dbType, financeNumber);

                if (!debtId) {
                    throw new Error('AN ' + an + ' ไม่มีรายการค่าใช้จ่ายที่ต้องออกใบแจ้งหนี้ (ไม่พบ AN นี้ หรือไม่มีรายการค้างชำระ)');
                }

                results.push(Object.assign({}, infoMap[an], {
                    an,
                    debt_id: debtId,
                    finance_number: financeNumber,
                    success: true,
                    message: 'ออกใบแจ้งหนี้สำเร็จ',
                }));
            } catch (e) {
                failedAn = an;
                failedError = e;
                break;
            }
        }

        if (failedAn !== null) {
            await conn.rollback();
            return { ok: false, failedAn, failedError, retryable: isDuplicateKeyError(failedError) };
        }

        await conn.commit();
        return { ok: true, results };
    } catch (e) {
        if (conn) {
            try {
                await conn.rollback();
            } catch (e2) {
                // ignore rollback error
            }
        }
        return { ok: false, failedAn: null, failedError: e, retryable: isDuplicateKeyError(e) };
    } finally {
        if (conn) conn.release();
    }
}

router.post('/issue_invoices_ipd', requireLogin, async (req, res) => {
    const body = req.body || {};
    const ans = Array.isArray(body.an) ? body.an : [];

    if (ans.length === 0) {
        res.json({ success: false, message: 'กรุณาเลือกผู้ป่วยอย่างน้อย 1 คน' });
        return;
    }

    const anList = ans.map((an) => String(an));
    const MAX_ATTEMPTS = 3;

    try {
        const dbType = db.getType();
        const staff = req.session.officer.officer_login_name;
        const infoMap = await getPatientInfoMapIpd(anList);

        let outcome;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            outcome = await attemptIssueAllIpd(anList, infoMap, staff, dbType);
            if (outcome.ok || !outcome.retryable || attempt === MAX_ATTEMPTS) {
                break;
            }
        }

        if (!outcome.ok) {
            const failedAn = outcome.failedAn;
            const failedMessage = outcome.failedError ? outcome.failedError.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';

            const data = anList.map((an) => Object.assign({}, infoMap[an], {
                an,
                debt_id: null,
                success: false,
                message: an === failedAn ? failedMessage : 'ยกเลิก เนื่องจากมีรายการอื่นในชุดเดียวกันผิดพลาด',
            }));

            res.json({
                success: false,
                message: failedAn
                    ? 'ยกเลิกการออกใบแจ้งหนี้ทั้งหมด เนื่องจากเกิดข้อผิดพลาด: AN ' + failedAn + ': ' + failedMessage
                    : 'เกิดข้อผิดพลาด: ' + failedMessage,
                data,
            });
            return;
        }

        res.json({ success: true, data: outcome.results });
    } catch (e) {
        res.json({ success: false, message: 'เกิดข้อผิดพลาด: ' + e.message });
    }
});

module.exports = router;
