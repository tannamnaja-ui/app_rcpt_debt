const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireLogin } = require('../auth');

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^\d{2}:\d{2}(:\d{2})?$/;
const PAGE_SIZES = [20, 50, 100, 200, 500, 1000];

router.get('/hipdata_codes', requireLogin, async (req, res) => {
    try {
        const rows = await db.query(
            "SELECT hipdata_code FROM pttype WHERE hipdata_code IS NOT NULL AND hipdata_code <> '' GROUP BY hipdata_code ORDER BY hipdata_code"
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.get('/pttypes', requireLogin, async (req, res) => {
    let hipdataCodes = req.query.hipdata_code;
    if (hipdataCodes === undefined) hipdataCodes = [];
    else if (!Array.isArray(hipdataCodes)) hipdataCodes = [hipdataCodes];
    hipdataCodes = hipdataCodes.map((c) => String(c).trim()).filter(Boolean);

    try {
        const params = {};
        let sql = "SELECT pttype, name, hipdata_code FROM pttype WHERE isuse = 'Y'";

        if (hipdataCodes.length > 0) {
            const placeholders = hipdataCodes.map((code, i) => {
                const key = 'h' + i;
                params[key] = code;
                return ':' + key;
            });
            sql += ` AND hipdata_code IN (${placeholders.join(', ')})`;
        }

        sql += ' ORDER BY pttype';

        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

function buildPatientsBaseQuery(body, opts) {
    opts = opts || {};
    const pttypes = Array.isArray(body.pttype) ? body.pttype : [];
    const dateStart = String(body.date_start || '');
    const dateEnd = String(body.date_end || '');
    const timeStart = String(body.time_start || '00:00');
    const timeEnd = String(body.time_end || '23:59');
    const hn = String(body.hn || '').trim();
    const debtHn = String(body.debt_hn || '').trim();

    if (!DATE_REGEX.test(dateStart) || !DATE_REGEX.test(dateEnd)) {
        return { error: 'รูปแบบวันที่ไม่ถูกต้อง' };
    }

    if (!TIME_REGEX.test(timeStart) || !TIME_REGEX.test(timeEnd)) {
        return { error: 'รูปแบบเวลาไม่ถูกต้อง' };
    }

    const params = { date_start: dateStart, date_end: dateEnd, time_start: timeStart, time_end: timeEnd };
    let pttypeCondition = '';
    if (pttypes.length > 0) {
        const placeholders = pttypes.map((pt, i) => {
            const key = 'pt' + i;
            params[key] = String(pt);
            return ':' + key;
        });
        pttypeCondition = `AND o.pttype IN (${placeholders.join(', ')})`;
    }

    let hnCondition = '';
    if (hn) {
        params.hn = hn;
        hnCondition = 'AND o.hn = :hn';
    }

    // ช่อง HN ใหม่เฉพาะหน้ารายชื่อที่ออกใบแจ้งหนี้แล้ว (แยกจาก hnCondition ข้างบนซึ่งเป็นช่อง HN เดิมในตัวกรองค้นหาหลัก)
    // ค้นหาจาก rcpt_debt.hn โดยตรง ใช้ได้เฉพาะ opts.issued (มี rd join แล้วเท่านั้น)
    let debtHnCondition = '';
    if (opts.issued && debtHn) {
        params.debt_hn = debtHn;
        debtHnCondition = 'AND rd.hn = :debt_hn';
    }

    const isPg = db.getType() === 'pgsql';
    const vstdateExpr = isPg
        ? "TO_CHAR(o.vstdate, 'YYYY-MM-DD')"
        : "DATE_FORMAT(o.vstdate, '%Y-%m-%d')";
    const timeCondition = isPg
        ? 'o.vsttime BETWEEN CAST(:time_start AS time) AND CAST(:time_end AS time)'
        : 'o.vsttime BETWEEN :time_start AND :time_end';
    const amountExpr = isPg ? 'CAST(rd.amount AS NUMERIC)' : 'CAST(rd.amount AS DECIMAL(18,2))';

    // issued = true: เฉพาะรายการที่ออกใบแจ้งหนี้แล้ว
    // hosxp = false (ค่าเริ่มต้น): เฉพาะที่ออกด้วย app นี้ (rcpt_debt.computer = 'App rcpt auto')
    // hosxp = true: เฉพาะที่ออกจากโปรแกรม HOSxP เอง (computer ไม่ใช่ของ app นี้)
    const financeCondition = opts.issued
        ? "op.finance_number IS NOT NULL AND op.finance_number <> ''"
        : "(op.finance_number IS NULL OR op.finance_number = '')";
    const computerCondition = opts.hosxp
        ? "(rd.computer IS NULL OR rd.computer <> 'App rcpt auto')"
        : "rd.computer = 'App rcpt auto'";
    const issuedJoin = opts.issued
        ? `JOIN rcpt_debt rd ON rd.vn = o.vn AND ${computerCondition} AND ${amountExpr} <> 0`
        : '';
    const issuedSelect = opts.issued ? ', rd.debt_id, rd.finance_number, rd.staff, rd.debt_date_time' : '';
    const issuedGroupBy = opts.issued ? ', rd.debt_id, rd.finance_number, rd.staff, rd.debt_date_time' : '';

    const baseSql = `SELECT vp.auth_code, o.vn, o.hn, ${vstdateExpr} AS vstdate, o.vsttime, o.pttype, pt.name AS pttype_name,
                CONCAT(p.pname, p.fname, ' ', p.lname) AS patient_name,
                SUM(CASE WHEN op.paidst = '02' THEN op.sum_price ELSE 0 END) AS debt_amount${issuedSelect}
            FROM ovst o
            JOIN patient p ON p.hn = o.hn
            LEFT JOIN pttype pt ON pt.pttype = o.pttype
            JOIN opitemrece op ON op.vn = o.vn
            JOIN visit_pttype vp ON vp.vn = o.vn AND vp.pttype = o.pttype
            ${issuedJoin}
            WHERE o.vstdate BETWEEN :date_start AND :date_end
            AND ${timeCondition}
            ${pttypeCondition}
            ${hnCondition}
            ${debtHnCondition}
            AND op.paidst = '02'
            AND ${financeCondition}
            AND (vp.auth_code IS NULL OR vp.auth_code NOT LIKE 'EP%')
            AND o.an IS NULL
            GROUP BY vp.auth_code, o.vn, o.hn, o.vstdate, o.vsttime, o.pttype, pt.name, p.pname, p.fname, p.lname${issuedGroupBy}
            HAVING SUM(CASE WHEN op.paidst = '02' THEN op.sum_price ELSE 0 END) > 0`;

    // รายชื่อที่ออกใบแจ้งหนี้แล้วด้วย app นี้ ("ออกด้วยระบบนี้") เรียงตาม vstdate, hn, vn
    // ส่วนรายการค้นหาปกติ/รายชื่อจาก HOSxP ยังคงเรียงตาม vstdate, vsttime, pttype, vn เหมือนเดิม
    const orderBy = (opts.issued && !opts.hosxp)
        ? 'o.vstdate, o.hn, o.vn'
        : 'o.vstdate, o.vsttime, o.pttype, o.vn';

    return { baseSql, params, orderBy };
}

// รัน baseSql แบบแบ่งหน้า (ใช้ร่วมกันระหว่าง /patients และ /patients_issued)
async function sendPaginatedPatients(built, body, res) {
    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    let page = parseInt(body.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    let pageSize = parseInt(body.page_size, 10);
    if (!PAGE_SIZES.includes(pageSize)) pageSize = PAGE_SIZES[0];

    try {
        const { baseSql, params, orderBy } = built;

        const countSql = `SELECT COUNT(*) AS total_count, COALESCE(SUM(debt_amount), 0) AS total_amount FROM (${baseSql}) t`;
        const countRows = await db.query(countSql, params);
        const totalCount = parseInt(countRows[0].total_count, 10) || 0;
        const totalAmount = countRows[0].total_amount || 0;
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 1;

        const pageParams = Object.assign({}, params, { limit_n: pageSize, offset_n: (page - 1) * pageSize });
        const pageSql = `${baseSql} ORDER BY ${orderBy} LIMIT :limit_n OFFSET :offset_n`;
        const rows = await db.query(pageSql, pageParams);

        res.json({
            success: true,
            data: rows,
            total_count: totalCount,
            total_amount: totalAmount,
            page,
            page_size: pageSize,
            total_pages: totalPages,
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
}

router.post('/patients', requireLogin, async (req, res) => {
    const body = req.body || {};
    await sendPaginatedPatients(buildPatientsBaseQuery(body), body, res);
});

// รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้ด้วย app นี้แล้ว (สำหรับปุ่ม "ตรวจสอบรายชื่อคนที่ออกใบแจ้งหนี้แล้ว")
router.post('/patients_issued', requireLogin, async (req, res) => {
    const body = req.body || {};
    await sendPaginatedPatients(buildPatientsBaseQuery(body, { issued: true }), body, res);
});

// รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้แล้วจากโปรแกรม HOSxP เอง (ไม่ใช่ออกด้วย app นี้)
router.post('/patients_issued_hosxp', requireLogin, async (req, res) => {
    const body = req.body || {};
    await sendPaginatedPatients(buildPatientsBaseQuery(body, { issued: true, hosxp: true }), body, res);
});

// คืนรายการ vn + ยอดของผู้ป่วยทั้งหมดที่ตรงเงื่อนไข (ไม่แบ่งหน้า) ใช้สำหรับ "เลือกทั้งหมด/ไม่เลือกทั้งหมด" ข้ามหน้าจอ
router.post('/patients_vns', requireLogin, async (req, res) => {
    const body = req.body || {};
    const built = buildPatientsBaseQuery(body);

    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    try {
        const { baseSql, params } = built;
        const sql = `SELECT vn, debt_amount FROM (${baseSql}) t`;
        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// คืนรายการ vn ทั้งหมดที่ออกใบแจ้งหนี้ด้วย app นี้แล้วตามเงื่อนไขที่ตรง (ไม่แบ่งหน้า)
// ใช้สำหรับ checkbox "เลือกทั้งหมด" ในหน้า "รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้แล้ว (ออกด้วยระบบนี้)" ให้เลือกได้ครบทุกหน้า
router.post('/patients_issued_vns', requireLogin, async (req, res) => {
    const body = req.body || {};
    const built = buildPatientsBaseQuery(body, { issued: true });

    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    try {
        const { baseSql, params } = built;
        const sql = `SELECT vn FROM (${baseSql}) t`;
        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// คืนรายการ vn ทั้งหมดที่ออกใบแจ้งหนี้จากโปรแกรม HOSxP เองตามเงื่อนไขที่ตรง (ไม่แบ่งหน้า)
// ใช้สำหรับ checkbox "เลือกทั้งหมด" ในหน้า "รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้แล้ว (ออกจากโปรแกรม HOSxP)" ให้เลือกได้ครบทุกหน้า
router.post('/patients_issued_hosxp_vns', requireLogin, async (req, res) => {
    const body = req.body || {};
    const built = buildPatientsBaseQuery(body, { issued: true, hosxp: true });

    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    try {
        const { baseSql, params } = built;
        const sql = `SELECT vn FROM (${baseSql}) t`;
        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ประวัติการยกเลิกใบแจ้งหนี้ (rcpt_debt_cancel) - filter ตามวันที่ยกเลิก (cancel_datetime) และ HN
// ไม่บังคับกรอกวันที่ - ถ้าไม่ระบุช่วงวันที่เลยจะแสดงประวัติทั้งหมด
router.post('/cancelled_invoices', requireLogin, async (req, res) => {
    const body = req.body || {};
    const hn = String(body.hn || '').trim();
    const dateStart = String(body.date_start || '');
    const dateEnd = String(body.date_end || '');

    const params = {};
    let dateCondition = '';
    if (dateStart || dateEnd) {
        if (!DATE_REGEX.test(dateStart) || !DATE_REGEX.test(dateEnd)) {
            res.json({ success: false, message: 'รูปแบบวันที่ไม่ถูกต้อง' });
            return;
        }
        const isPg = db.getType() === 'pgsql';
        const cancelDateExpr = isPg ? 'CAST(rc.cancel_datetime AS DATE)' : 'DATE(rc.cancel_datetime)';
        params.date_start = dateStart;
        params.date_end = dateEnd;
        dateCondition = `AND ${cancelDateExpr} BETWEEN :date_start AND :date_end`;
    }

    let hnCondition = '';
    if (hn) {
        params.hn = hn;
        hnCondition = 'AND rc.hn = :hn';
    }

    let page = parseInt(body.page, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    let pageSize = parseInt(body.page_size, 10);
    if (!PAGE_SIZES.includes(pageSize)) pageSize = PAGE_SIZES[0];

    try {
        // debt_date เป็นคอลัมน์ DATE ล้วน ต้อง TO_CHAR/DATE_FORMAT เป็น text ตรงๆ
        // กันไม่ให้ driver แปลงเป็น JS Date แล้วเลื่อนวันผิดตาม timezone (เหมือน vstdateExpr ใน buildPatientsBaseQuery)
        const isPgDate = db.getType() === 'pgsql';
        const debtDateExpr = isPgDate
            ? "TO_CHAR(rc.debt_date, 'YYYY-MM-DD')"
            : "DATE_FORMAT(rc.debt_date, '%Y-%m-%d')";

        const baseSql = `SELECT rc.debt_cancel_id, rc.debt_id, rc.vn, rc.hn,
                    CONCAT(p.pname, p.fname, ' ', p.lname) AS patient_name,
                    ${debtDateExpr} AS debt_date, rc.debt_time, rc.staff,
                    rc.cancel_datetime, rc.cancel_staff,
                    rc.amount, rc.discount_amount, rc.total_amount, rc.reason
                FROM rcpt_debt_cancel rc
                JOIN patient p ON p.hn = rc.hn
                WHERE 1=1 ${hnCondition} ${dateCondition}`;

        const countSql = `SELECT COUNT(*) AS total_count, COALESCE(SUM(total_amount), 0) AS total_amount FROM (${baseSql}) t`;
        const countRows = await db.query(countSql, params);
        const totalCount = parseInt(countRows[0].total_count, 10) || 0;
        const totalAmount = countRows[0].total_amount || 0;
        const totalPages = totalCount > 0 ? Math.ceil(totalCount / pageSize) : 1;

        const pageParams = Object.assign({}, params, { limit_n: pageSize, offset_n: (page - 1) * pageSize });
        const pageSql = `${baseSql} ORDER BY rc.cancel_datetime DESC, rc.debt_cancel_id DESC LIMIT :limit_n OFFSET :offset_n`;
        const rows = await db.query(pageSql, pageParams);

        res.json({
            success: true,
            data: rows,
            total_count: totalCount,
            total_amount: totalAmount,
            page,
            page_size: pageSize,
            total_pages: totalPages,
        });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// ค้นหารายชื่อผู้ป่วยใน (IPD) ที่ยังไม่ออกใบแจ้งหนี้ - ใช้วันที่จำหน่าย (ipt.dchdate) แทนวันที่เปิด visit
// ไม่มีตัวกรองช่วงเวลา (time) เหมือนฝั่ง OPD เพราะ dchdate เป็นระดับวัน ไม่ใช่ระดับเวลา
// opts.issued/opts.hosxp ใช้ค้นรายชื่อที่ออกใบแจ้งหนี้แล้ว (เหมือนฝั่ง OPD ใน buildPatientsBaseQuery)
// rcpt_debt.vn ของ IPD เก็บค่า an ตรงๆ (ไม่ใช่ vn จริง) จึง join ด้วย rd.vn = i.an
function buildIpdPatientsBaseQuery(body, opts) {
    opts = opts || {};
    const pttypes = Array.isArray(body.pttype) ? body.pttype : [];
    const dateStart = String(body.date_start || '');
    const dateEnd = String(body.date_end || '');
    const hn = String(body.hn || '').trim();
    const debtHn = String(body.debt_hn || '').trim();

    if (!DATE_REGEX.test(dateStart) || !DATE_REGEX.test(dateEnd)) {
        return { error: 'รูปแบบวันที่ไม่ถูกต้อง' };
    }

    const params = { date_start: dateStart, date_end: dateEnd };
    let pttypeCondition = '';
    if (pttypes.length > 0) {
        const placeholders = pttypes.map((pt, i) => {
            const key = 'pt' + i;
            params[key] = String(pt);
            return ':' + key;
        });
        pttypeCondition = `AND i.pttype IN (${placeholders.join(', ')})`;
    }

    let hnCondition = '';
    if (hn) {
        params.hn = hn;
        hnCondition = 'AND i.hn = :hn';
    }

    let debtHnCondition = '';
    if (opts.issued && debtHn) {
        params.debt_hn = debtHn;
        debtHnCondition = 'AND rd.hn = :debt_hn';
    }

    const isPg = db.getType() === 'pgsql';
    const dchdateExpr = isPg
        ? "TO_CHAR(i.dchdate, 'YYYY-MM-DD')"
        : "DATE_FORMAT(i.dchdate, '%Y-%m-%d')";
    const amountExpr = isPg ? 'CAST(rd.amount AS NUMERIC)' : 'CAST(rd.amount AS DECIMAL(18,2))';

    // issued = true: เฉพาะรายการที่ออกใบแจ้งหนี้แล้ว
    // hosxp = false (ค่าเริ่มต้น): เฉพาะที่ออกด้วย app นี้ (rcpt_debt.computer = 'App rcpt auto')
    // hosxp = true: เฉพาะที่ออกจากโปรแกรม HOSxP เอง (computer ไม่ใช่ของ app นี้)
    const financeCondition = opts.issued
        ? "op.finance_number IS NOT NULL AND op.finance_number <> ''"
        : "(op.finance_number IS NULL OR op.finance_number = '')";
    const computerCondition = opts.hosxp
        ? "(rd.computer IS NULL OR rd.computer <> 'App rcpt auto')"
        : "rd.computer = 'App rcpt auto'";
    const issuedJoin = opts.issued
        ? `JOIN rcpt_debt rd ON rd.vn = i.an AND ${computerCondition} AND ${amountExpr} <> 0`
        : '';
    const issuedSelect = opts.issued ? ', rd.debt_id, rd.finance_number, rd.staff, rd.debt_date_time' : '';
    const issuedGroupBy = opts.issued ? ', rd.debt_id, rd.finance_number, rd.staff, rd.debt_date_time' : '';

    const baseSql = `SELECT i.an, i.hn, ${dchdateExpr} AS dchdate, i.dchtime, i.pttype,
                pt.name AS pttype_name,
                CONCAT(p.pname, p.fname, ' ', p.lname) AS patient_name,
                SUM(CASE WHEN op.paidst = '02' THEN op.sum_price ELSE 0 END) AS debt_amount${issuedSelect}
            FROM ipt i
            JOIN patient p ON p.hn = i.hn
            LEFT JOIN pttype pt ON pt.pttype = i.pttype
            JOIN opitemrece op ON op.an = i.an
            JOIN ipt_pttype ip ON ip.an = i.an AND ip.pttype = i.pttype
            ${issuedJoin}
            WHERE i.dchdate BETWEEN :date_start AND :date_end
            ${pttypeCondition}
            ${hnCondition}
            ${debtHnCondition}
            AND op.paidst = '02'
            AND ${financeCondition}
            GROUP BY i.an, i.hn, i.dchdate, i.dchtime, i.pttype, pt.name, p.pname, p.fname, p.lname${issuedGroupBy}
            HAVING SUM(CASE WHEN op.paidst = '02' THEN op.sum_price ELSE 0 END) > 0`;

    // รายชื่อที่ออกใบแจ้งหนี้แล้วด้วย app นี้ ("ออกด้วยระบบนี้") เรียงตาม dchdate, hn, an
    // ส่วนรายการค้นหาปกติ/รายชื่อจาก HOSxP ยังคงเรียงตาม dchdate, dchtime, pttype, an เหมือนเดิม
    const orderBy = (opts.issued && !opts.hosxp)
        ? 'i.dchdate, i.hn, i.an'
        : 'i.dchdate, i.dchtime, i.pttype, i.an';

    return { baseSql, params, orderBy };
}

router.post('/patients_ipd', requireLogin, async (req, res) => {
    const body = req.body || {};
    await sendPaginatedPatients(buildIpdPatientsBaseQuery(body), body, res);
});

// รายชื่อผู้ป่วยในที่ออกใบแจ้งหนี้ด้วย app นี้แล้ว (สำหรับปุ่ม "ตรวจสอบรายชื่อคนที่ออกใบแจ้งหนี้แล้ว" ฝั่ง IPD)
router.post('/patients_ipd_issued', requireLogin, async (req, res) => {
    const body = req.body || {};
    await sendPaginatedPatients(buildIpdPatientsBaseQuery(body, { issued: true }), body, res);
});

// รายชื่อผู้ป่วยในที่ออกใบแจ้งหนี้แล้วจากโปรแกรม HOSxP เอง (ไม่ใช่ออกด้วย app นี้)
router.post('/patients_ipd_issued_hosxp', requireLogin, async (req, res) => {
    const body = req.body || {};
    await sendPaginatedPatients(buildIpdPatientsBaseQuery(body, { issued: true, hosxp: true }), body, res);
});

// คืนรายการ an + ยอดของผู้ป่วยในทั้งหมดที่ตรงเงื่อนไข (ไม่แบ่งหน้า) ใช้สำหรับ "เลือกทั้งหมด/ไม่เลือกทั้งหมด" ข้ามหน้าจอ
router.post('/patients_ipd_vns', requireLogin, async (req, res) => {
    const body = req.body || {};
    const built = buildIpdPatientsBaseQuery(body);

    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    try {
        const { baseSql, params } = built;
        const sql = `SELECT an, debt_amount FROM (${baseSql}) t`;
        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// คืนรายการ an ทั้งหมดที่ออกใบแจ้งหนี้ด้วย app นี้แล้วตามเงื่อนไขที่ตรง (ไม่แบ่งหน้า) - "เลือกทั้งหมด" หน้ารายชื่อที่ออกแล้ว (IPD)
router.post('/patients_ipd_issued_vns', requireLogin, async (req, res) => {
    const body = req.body || {};
    const built = buildIpdPatientsBaseQuery(body, { issued: true });

    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    try {
        const { baseSql, params } = built;
        const sql = `SELECT an FROM (${baseSql}) t`;
        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

// คืนรายการ an ทั้งหมดที่ออกใบแจ้งหนี้จากโปรแกรม HOSxP เองตามเงื่อนไขที่ตรง (ไม่แบ่งหน้า) - "เลือกทั้งหมด" (IPD)
router.post('/patients_ipd_issued_hosxp_vns', requireLogin, async (req, res) => {
    const body = req.body || {};
    const built = buildIpdPatientsBaseQuery(body, { issued: true, hosxp: true });

    if (built.error) {
        res.json({ success: false, message: built.error });
        return;
    }

    try {
        const { baseSql, params } = built;
        const sql = `SELECT an FROM (${baseSql}) t`;
        const rows = await db.query(sql, params);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

module.exports = router;
