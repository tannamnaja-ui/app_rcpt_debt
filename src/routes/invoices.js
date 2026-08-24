const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../auth');
const { runInvoiceSteps, getDebtId, runCancelInvoiceSteps } = require('../invoiceService');

async function getPatientInfoMap(vnList) {
    const params = {};
    const placeholders = vnList.map((vn, i) => {
        const key = 'vn' + i;
        params[key] = vn;
        return ':' + key;
    });

    const isPg = db.getType() === 'pgsql';
    const vstdateExpr = isPg
        ? "TO_CHAR(o.vstdate, 'YYYY-MM-DD')"
        : "DATE_FORMAT(o.vstdate, '%Y-%m-%d')";

    const sql = `SELECT vp.auth_code, o.vn, o.hn, ${vstdateExpr} AS vstdate, o.vsttime, o.pttype, pt.name AS pttype_name,
                CONCAT(p.pname, p.fname, ' ', p.lname) AS patient_name,
                SUM(CASE WHEN op.paidst = '02' THEN op.sum_price ELSE 0 END) AS debt_amount
            FROM ovst o
            JOIN patient p ON p.hn = o.hn
            LEFT JOIN pttype pt ON pt.pttype = o.pttype
            JOIN opitemrece op ON op.vn = o.vn
            LEFT JOIN visit_pttype vp ON vp.vn = o.vn AND vp.pttype = o.pttype
            WHERE o.vn IN (${placeholders.join(', ')})
            GROUP BY vp.auth_code, o.vn, o.hn, o.vstdate, o.vsttime, o.pttype, pt.name, p.pname, p.fname, p.lname`;

    const rows = await db.query(sql, params);
    const map = {};
    rows.forEach((row) => { map[String(row.vn)] = row; });
    return map;
}

router.get('/vn_items/:vn', requireLogin, async (req, res) => {
    const vn = String(req.params.vn || '').trim();

    if (!vn) {
        res.json({ success: false, message: 'ไม่พบ VN' });
        return;
    }

    try {
        const rows = await db.query(
            `SELECT op.icode, COALESCE(d.name, n.name, op.icode) AS item_name, op.qty, op.sum_price
            FROM opitemrece op
            LEFT JOIN drugitems d ON d.icode = op.icode
            LEFT JOIN nondrugitems n ON n.icode = op.icode
            WHERE op.vn = :vn AND op.paidst = '02'
            ORDER BY op.item_no`,
            { vn }
        );

        const totalAmount = rows.reduce((sum, r) => sum + (parseFloat(r.sum_price) || 0), 0);
        res.json({ success: true, data: rows, total_amount: totalAmount });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ข้อมูลใบแจ้งหนี้ของ VN (สำหรับแสดงในป็อปอัพยืนยันก่อนยกเลิก) - debt_id ที่ยังไม่ถูกยกเลิก (status <> 'ABORT')
router.get('/debt_info/:vn', requireLogin, async (req, res) => {
    const vn = String(req.params.vn || '').trim();

    if (!vn) {
        res.json({ success: false, message: 'ไม่พบ VN' });
        return;
    }

    try {
        const debts = await db.query(
            `SELECT debt_id, vn, hn, staff, amount, total_amount, debt_date_time
            FROM rcpt_debt
            WHERE vn = :vn AND (status IS NULL OR status <> 'ABORT')
            ORDER BY debt_id`,
            { vn }
        );

        if (debts.length === 0) {
            res.json({ success: false, message: 'ไม่พบใบแจ้งหนี้ของ VN นี้ หรือถูกยกเลิกไปแล้ว' });
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

// ยกเลิกใบแจ้งหนี้ของ VN (3 ขั้นตอน: ยกเลิกลูกหนี้ / ยกเลิกโอน / คืนค่าให้ใบสั่งยา)
// ต้องระบุเหตุผลการยกเลิก - บันทึกลง rcpt_debt_cancel ก่อนเริ่มขั้นตอนยกเลิกจริง (step0LogCancel)
router.post('/cancel_invoice', requireLogin, async (req, res) => {
    const body = req.body || {};
    const vn = String(body.vn || '').trim();
    const reason = String(body.reason || '').trim();

    if (!vn) {
        res.json({ success: false, message: 'ไม่พบ VN' });
        return;
    }

    if (!reason) {
        res.json({ success: false, message: 'กรุณาระบุเหตุผลการยกเลิก' });
        return;
    }

    let conn;

    try {
        await warmUpSerials();
        const cancelStaff = req.session.officer.officer_login_name;

        conn = await db.getConnection();
        await conn.beginTransaction();
        await runCancelInvoiceSteps(conn, vn, reason, cancelStaff);
        await conn.commit();
        res.json({ success: true, vn, message: 'ยกเลิกใบแจ้งหนี้สำเร็จ' });
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

// ยกเลิกใบแจ้งหนี้หลาย VN พร้อมกัน (ตามรายการที่เลือกในหน้า "รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้แล้ว (ออกด้วยระบบนี้)")
// ทำใน transaction เดียวกันทั้งหมด (all-or-nothing) เหมือนกับตอนออกใบแจ้งหนี้หลาย VN พร้อมกัน
router.post('/cancel_invoices', requireLogin, async (req, res) => {
    const body = req.body || {};
    const vns = Array.isArray(body.vn) ? body.vn : [];
    const reason = String(body.reason || '').trim();

    if (vns.length === 0) {
        res.json({ success: false, message: 'กรุณาเลือกรายการอย่างน้อย 1 รายการ' });
        return;
    }

    const vnList = vns.map((vn) => String(vn));
    let conn;

    try {
        await warmUpSerials();
        const cancelStaff = req.session.officer.officer_login_name;

        conn = await db.getConnection();
        await conn.beginTransaction();

        for (const vn of vnList) {
            await runCancelInvoiceSteps(conn, vn, reason, cancelStaff);
        }

        await conn.commit();
        res.json({ success: true, vn: vnList, message: 'ยกเลิกใบแจ้งหนี้สำเร็จ ' + vnList.length + ' รายการ' });
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

// ID จาก get_serialnumber() ของระบบ HIS ชนกันได้เป็นบางครั้งภายใต้การใช้งานพร้อมกันจากหลายเครื่อง (duplicate key)
// ไม่ใช่บั๊กของโค้ดนี้ - ถือเป็นเหตุชั่วคราว แก้ด้วยการลองเปิด transaction ใหม่ขอเลขชุดใหม่
function isDuplicateKeyError(e) {
    return e && (e.code === '23505' || e.code === 'ER_DUP_ENTRY');
}

// รายชื่อ get_serialnumber() ทั้งหมดที่ใช้ตลอด 9 ขั้นตอนออกใบแจ้งหนี้ (runInvoiceSteps ใน invoiceService.js)
const REQUIRED_SERIAL_NAMES = [
    'opd_opi_fn_tr_list_id',
    'opd_opi_fn_tr_detail_id',
    'opd_opi_finance_summary_id',
    'opd_opi_fn_cr_list_id',
    'finance_number',
    'opd_opi_fn_cr_detail_id',
    'rcpt_debt_id',
    'rcpt_debt_cancel_id',
];
const warmedSerials = new Set();

// get_serialnumber() สร้าง sequence ของ Postgres แบบ lazy (CREATE SEQUENCE IF NOT EXISTS) โดย seed ค่าเริ่มต้น
// จากตาราง serial ซึ่งเก็บ "เลขที่ใช้ไปล่าสุด" ไม่ใช่เลขถัดไป - ถ้า sequence จริงยังไม่เคยถูกสร้างในฐานข้อมูลนี้มาก่อน
// (เช่น ฐานข้อมูลสำเนา/ทดสอบที่ก็อปปี้มาแต่ข้อมูล ไม่ได้ก็อปปี้ sequence object) การเรียกครั้งแรกจะได้เลขที่ซ้ำกับ
// ข้อมูลที่มีอยู่จริงพอดี (duplicate key) และถ้าเกิดขึ้นในทรานแซกชันที่ rollback การสร้าง sequence นั้นก็จะถูก
// rollback ไปด้วย (CREATE SEQUENCE เป็น DDL แบบ transactional) ทำให้ error เดิมเกิดซ้ำไม่รู้จบทุกครั้งที่ลองใหม่
// จึงต้อง "อุ่นเครื่อง" เรียกแบบ autocommit (นอกทรานแซกชัน ผ่าน db.query ธรรมดา) ก่อนเข้าสู่ทรานแซกชันจริง
// เพื่อให้ sequence ถูกสร้างและขยับผ่านค่าที่ชนกันไปแล้วอย่างถาวร ครั้งเดียวพอต่อการรันของแอปนี้
async function warmUpSerials() {
    for (const name of REQUIRED_SERIAL_NAMES) {
        if (warmedSerials.has(name)) continue;
        await db.query('SELECT get_serialnumber(:name)', { name });
        warmedSerials.add(name);
    }
}

// วันที่/เวลาปัจจุบัน ณ ตอนออกใบแจ้งหนี้ (เป็นวันที่ออกใบแจ้งหนี้จริง ไม่ใช่วันที่เปิด visit)
function formatNowDateTime() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    const time = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    return { date, time };
}

// ออกใบแจ้งหนี้ 1 ครั้ง ให้ VN ทุกรายการที่เลือกใช้เลขที่ใบแจ้งหนี้ (finance_number) เดียวกัน
// รวมเป็นใบแจ้งหนี้ใบเดียว แทนที่จะแยกใบต่อ VN
async function attemptIssueAll(vnList, infoMap, staff, dbType) {
    let conn;

    try {
        await warmUpSerials();

        conn = await db.getConnection();
        await conn.beginTransaction();

        const financeIdRows = await conn.query("SELECT get_serialnumber('finance_number') AS finance_number");
        const financeNumber = String(financeIdRows[0].finance_number);
        const { date: debtDate, time: debtTime } = formatNowDateTime();

        const results = [];
        let failedVn = null;
        let failedError = null;

        for (const vn of vnList) {
            try {
                await runInvoiceSteps(conn, vn, staff, dbType, financeNumber, debtDate, debtTime);
                const debtId = await getDebtId(conn, vn, dbType, financeNumber);
                results.push(Object.assign({}, infoMap[vn], {
                    vn,
                    debt_id: debtId,
                    finance_number: financeNumber,
                    success: true,
                    message: 'ออกใบแจ้งหนี้สำเร็จ',
                }));
            } catch (e) {
                failedVn = vn;
                failedError = e;
                break;
            }
        }

        if (failedVn !== null) {
            await conn.rollback();
            return { ok: false, failedVn, failedError, retryable: isDuplicateKeyError(failedError) };
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
        return { ok: false, failedVn: null, failedError: e, retryable: isDuplicateKeyError(e) };
    } finally {
        if (conn) conn.release();
    }
}

router.post('/issue_invoices', requireLogin, async (req, res) => {
    const body = req.body || {};
    const vns = Array.isArray(body.vn) ? body.vn : [];

    if (vns.length === 0) {
        res.json({ success: false, message: 'กรุณาเลือกผู้ป่วยอย่างน้อย 1 คน' });
        return;
    }

    const vnList = vns.map((vn) => String(vn));
    const MAX_ATTEMPTS = 3;

    try {
        const dbType = db.getType();
        const staff = req.session.officer.officer_login_name;
        const infoMap = await getPatientInfoMap(vnList);

        let outcome;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            outcome = await attemptIssueAll(vnList, infoMap, staff, dbType);
            if (outcome.ok || !outcome.retryable || attempt === MAX_ATTEMPTS) {
                break;
            }
        }

        if (!outcome.ok) {
            const failedVn = outcome.failedVn;
            const failedMessage = outcome.failedError ? outcome.failedError.message : 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ';

            const data = vnList.map((vn) => Object.assign({}, infoMap[vn], {
                vn,
                debt_id: null,
                success: false,
                message: vn === failedVn ? failedMessage : 'ยกเลิก เนื่องจากมีรายการอื่นในชุดเดียวกันผิดพลาด',
            }));

            res.json({
                success: false,
                message: failedVn
                    ? 'ยกเลิกการออกใบแจ้งหนี้ทั้งหมด เนื่องจากเกิดข้อผิดพลาด: VN ' + failedVn + ': ' + failedMessage
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
