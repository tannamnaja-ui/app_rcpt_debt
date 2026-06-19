/**
 * 9 ขั้นตอนของกระบวนการ "ออกใบแจ้งหนี้" (issue debt invoice) สำหรับ 1 VN
 * ทุก VN ที่เลือกรันรวมกันใน transaction เดียว (ผู้เรียกเป็นคนคุม begin/commit/rollback)
 * หากขั้นตอนใดของ VN ใดล้มเหลว ผู้เรียกต้อง rollback ทั้งหมด - ไม่มี VN ใดถูกออกใบแจ้งหนี้
 */

async function runInvoiceSteps(conn, vn, staffLoginName, dbType) {
    const vercode = await fetchVercode(conn, vn);
    const trListId = await step1TransferList(conn, vn);
    await step2GuidTransfer(conn, vn, trListId);
    await step3TransferDetail(conn, vn, trListId);
    await step4FinanceSummary(conn, vn);
    const { crListId, financeNumber } = await step5ClearList(conn, vn);
    await step55LinkClearList(conn, trListId, crListId);
    await step6ClearDetail(conn, vn, crListId);
    await step7RcptDebt(conn, vn, dbType, financeNumber, vercode);
    const debtId = await fetchDebtId(conn, vn, dbType, financeNumber);
    await step8RcptDebtDetail(conn, vn, debtId);
    await step9UpdateFinanceNumber(conn, vn, financeNumber);

    return { financeNumber };
}

// Pre-fetch: vercode (auth_code) จาก visit_pttype สำหรับใส่ใน sss_approval_code
async function fetchVercode(conn, vn) {
    const rows = await conn.query(
        'SELECT auth_code FROM visit_pttype WHERE vn = :vn LIMIT 1',
        { vn }
    );
    return (rows.length > 0 && rows[0].auth_code) ? String(rows[0].auth_code) : '';
}

// 1) เปิดรายการโอนเข้าระบบลูกหนี้ (opd_opi_fn_tr_list)
async function step1TransferList(conn, vn) {
    const idRows = await conn.query("SELECT get_serialnumber('opd_opi_fn_tr_list_id') AS id");
    const trListId = idRows[0].id;

    await conn.query(
        `INSERT INTO opd_opi_fn_tr_list
            (opd_opi_fn_tr_list_id, opd_opi_fn_tr_date, opd_opi_fn_tr_time, vn, transfer_amount, opd_opi_fn_tr_staff)
        SELECT :tr_list_id, o.vstdate, o.vsttime, o.vn, v.uc_money, o.staff
        FROM vn_stat v, ovst o
        WHERE v.vn = o.vn AND o.vn = :vn`,
        { vn, tr_list_id: trListId }
    );
    return trListId;
}

// 2) เชื่อม hos_guid ของ opitemrece (เฉพาะ paidst='02' ที่ยังไม่มี finance_number) เข้ากับรายการโอนในขั้นตอนที่ 1
async function step2GuidTransfer(conn, vn, trListId) {
    await conn.query(
        `INSERT INTO opd_opi_hos_guid_transfer
            (opi_guid, hos_guid, vn, opd_opi_fn_tr_list_id)
        SELECT oi.hos_guid, oi.hos_guid, oi.vn, :tr_list_id
        FROM opitemrece oi
        WHERE oi.vn = :vn
        AND oi.paidst = '02'
        AND (oi.finance_number IS NULL OR oi.finance_number = '')`,
        { vn, tr_list_id: trListId }
    );
}

// 3) รายละเอียดรายการโอน — เฉพาะ paidst='02' เท่านั้น (group by income/pttype)
async function step3TransferDetail(conn, vn, trListId) {
    await conn.query(
        `INSERT INTO opd_opi_fn_tr_detail
            (opd_opi_fn_tr_detail_id, opd_opi_fn_tr_list_id, income, pttype,
             amount_paidst_01, amount_paidst_02, amount_paidst_03, total_amount,
             amount_paidst_04, process_order, amount_paidst_04a, amount_paidst_04b)
        SELECT get_serialnumber('opd_opi_fn_tr_detail_id'), :tr_list_id, op.income, op.pttype,
            '0',
            SUM(op.sum_price),
            '0',
            SUM(op.sum_price), '0', '1000', '0', '0'
        FROM opitemrece op
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.income, op.pttype`,
        { vn, tr_list_id: trListId }
    );
}

// 4) สรุปยอดการเงินของ visit (opd_opi_finance_summary) — เฉพาะ paidst='02' เท่านั้น (group by pttype/vn/income)
async function step4FinanceSummary(conn, vn) {
    await conn.query(
        `INSERT INTO opd_opi_finance_summary
            (opd_opi_finance_summary_id, vn, income,
             total_paidst_01, total_paidst_02, total_paidst_03, total_paidst_04,
             total_amount, clear_amount, balance_amount,
             total_balance_01, total_balance_02, total_balance_03, total_balance_04,
             pttype, status_ok, total_paidst_04a, total_paidst_04b, total_balance_04a, total_amount_a)
        SELECT get_serialnumber('opd_opi_finance_summary_id'), op.vn, op.income,
            '0', SUM(op.sum_price), '0',
            '0', SUM(op.sum_price), '0', SUM(op.sum_price),
            '0', SUM(op.sum_price), '0',
            '0', op.pttype, 'N', '0', '0',
            SUM(op.sum_price),
            SUM(op.sum_price)
        FROM opitemrece op
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.pttype, op.vn, op.income`,
        { vn }
    );
}

// 5) เปิดรายการเคลียร์หนี้ (opd_opi_fn_cr_list) พร้อมเลขที่ใบแจ้งหนี้ (finance_number)
async function step5ClearList(conn, vn) {
    const idRows = await conn.query(
        "SELECT get_serialnumber('opd_opi_fn_cr_list_id') AS cr_list_id, get_serialnumber('finance_number') AS finance_number"
    );
    const crListId = idRows[0].cr_list_id;
    const financeNumber = String(idRows[0].finance_number);

    await conn.query(
        `INSERT INTO opd_opi_fn_cr_list
            (opd_opi_fn_cr_list_id, vn, pttype,
             opd_opi_fn_cr_date, opd_opi_fn_cr_time, opd_opi_fn_cr_staff,
             clear_amount, finance_number, status_ok)
        SELECT :cr_list_id, o.vn, vp.pttype,
            o.vstdate, o.vsttime, o.staff, v.uc_money, :finance_number, 'Y'
        FROM vn_stat v, ovst o, visit_pttype vp
        WHERE v.vn = o.vn AND vp.vn = o.vn AND o.vn = :vn`,
        { vn, cr_list_id: crListId, finance_number: financeNumber }
    );
    return { crListId, financeNumber };
}

// 5.5) เชื่อมรายการโอน (opd_opi_fn_tr_detail) เข้ากับรายการเคลียร์หนี้ (opd_opi_fn_cr_list)
async function step55LinkClearList(conn, trListId, crListId) {
    await conn.query(
        `UPDATE opd_opi_fn_tr_detail
        SET opd_opi_fn_cr_list_id = :cr_list_id
        WHERE opd_opi_fn_tr_list_id = :tr_list_id
        AND (opd_opi_fn_cr_list_id IS NULL OR opd_opi_fn_cr_list_id = 0)`,
        { tr_list_id: trListId, cr_list_id: crListId }
    );
}

// 6) รายละเอียดรายการเคลียร์หนี้ — เฉพาะ paidst='02' เท่านั้น (group by income)
async function step6ClearDetail(conn, vn, crListId) {
    await conn.query(
        `INSERT INTO opd_opi_fn_cr_detail
            (opd_opi_fn_cr_detail_id, opd_opi_fn_cr_list_id,
             income, amount_paidst_02, amount_paidst_04, total_amount, original_total_amount)
        SELECT get_serialnumber('opd_opi_fn_cr_detail_id'), :cr_list_id, op.income,
            SUM(op.sum_price),
            '0',
            SUM(op.sum_price),
            SUM(op.sum_price)
        FROM opitemrece op
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.income`,
        { vn, cr_list_id: crListId }
    );
}

// 7) บันทึกใบแจ้งหนี้ (rcpt_debt) — เฉพาะ paidst='02' เท่านั้น (group by vn/hn/vstdate/vsttime/staff/pttype)
async function step7RcptDebt(conn, vn, dbType, financeNumber, vercode) {
    const debtDateTimeExpr = dbType === 'pgsql'
        ? "(CONCAT(op.vstdate::text, ' ', op.vsttime::text))::timestamp"
        : "CAST(CONCAT(op.vstdate, ' ', op.vsttime) AS DATETIME)";

    await conn.query(
        `INSERT INTO rcpt_debt
            (debt_id, vn, hn, debt_date, debt_time, staff, amount, pt_type,
             computer, finance_number, pttype, discount_amount, total_amount,
             debt_date_time, debt_doc_id, department, special_discount_amount, ofc_paid_amount, sss_approval_code)
        SELECT get_serialnumber('rcpt_debt_id'), op.vn, op.hn, op.vstdate, op.vsttime, op.staff,
            SUM(op.sum_price),
            'OPD', 'App rcpt auto', :finance_number, op.pttype,
            SUM(op.discount),
            SUM(op.sum_price),
            ${debtDateTimeExpr},
            CONCAT(op.pttype, '/', ROW_NUMBER() OVER (ORDER BY op.pttype)),
            'OPD', '0', '0', :vercode
        FROM opitemrece op
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.vn, op.hn, op.vstdate, op.vsttime, op.staff, op.pttype`,
        { vn, finance_number: financeNumber, vercode }
    );
}

// ดึง debt_id ของแถวที่สร้างในขั้นตอนที่ 7 (ใช้ได้ทั้งภายใน และภายนอก transaction)
async function fetchDebtId(conn, vn, dbType, financeNumber) {
    const amountExpr = dbType === 'pgsql' ? 'CAST(amount AS NUMERIC)' : 'CAST(amount AS DECIMAL(18,2))';
    const rows = await conn.query(
        `SELECT debt_id FROM rcpt_debt WHERE vn = :vn AND finance_number = :finance_number AND ${amountExpr} <> 0 ORDER BY debt_id LIMIT 1`,
        { vn, finance_number: financeNumber }
    );
    return rows.length > 0 ? rows[0].debt_id : null;
}

// 8) รายละเอียดใบแจ้งหนี้ — เฉพาะ paidst='02' เท่านั้น (group by income) อ้างอิง debt_id จากขั้นตอนที่ 7
async function step8RcptDebtDetail(conn, vn, debtId) {
    await conn.query(
        `INSERT INTO rcpt_debt_detail
            (debt_id, income, amount, discount, total_amount, special_discount)
        SELECT :debt_id, op.income,
            SUM(op.sum_price),
            SUM(op.discount),
            SUM(op.sum_price),
            '0'
        FROM opitemrece op
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.income`,
        { vn, debt_id: debtId }
    );
}

// 9) ปิดยอด opitemrece โดยใส่ finance_number จากขั้นตอนที่ 5 (เฉพาะ paidst='02' ที่ยังไม่มี finance_number)
async function step9UpdateFinanceNumber(conn, vn, financeNumber) {
    await conn.query(
        `UPDATE opitemrece
        SET finance_number = :finance_number
        WHERE vn = :vn
        AND paidst = '02'
        AND (finance_number IS NULL OR finance_number = '')`,
        { vn, finance_number: financeNumber }
    );
}

// เรียกใช้หลัง commit (จาก route) เพื่อดึง debt_id สำหรับแสดงผล
async function getDebtId(conn, vn, dbType, financeNumber) {
    return fetchDebtId(conn, vn, dbType, financeNumber);
}

/**
 * 3 ขั้นตอนของกระบวนการ "ยกเลิกใบแจ้งหนี้" (cancel debt invoice) สำหรับ 1 VN
 * ผู้เรียกเป็นคนคุม begin/commit/rollback (transaction เดียวกัน)
 */
async function runCancelInvoiceSteps(conn, vn) {
    await step1CancelDebt(conn, vn);
    await step2CancelTransfer(conn, vn);
    await step3RevertOrderItems(conn, vn);
}

// 1) ยกเลิกลูกหนี้ — เคลียร์ยอดและตั้งสถานะ ABORT ที่ rcpt_debt/rcpt_debt_detail
async function step1CancelDebt(conn, vn) {
    await conn.query("UPDATE rcpt_debt SET amount = 0 WHERE vn = :vn", { vn });
    await conn.query("UPDATE rcpt_debt SET total_amount = 0 WHERE vn = :vn", { vn });
    await conn.query("UPDATE rcpt_debt SET status = 'ABORT' WHERE vn = :vn", { vn });

    await conn.query(
        `UPDATE rcpt_debt_detail SET amount = 0
        WHERE debt_id IN (SELECT debt_id FROM rcpt_debt WHERE vn = :vn)`,
        { vn }
    );
    await conn.query(
        `UPDATE rcpt_debt_detail SET total_amount = 0
        WHERE debt_id IN (SELECT debt_id FROM rcpt_debt WHERE vn = :vn)`,
        { vn }
    );
}

// 2) ยกเลิกโอน — ลบรายการโอน/เคลียร์หนี้ที่เปิดไว้ตอนออกใบแจ้งหนี้
async function step2CancelTransfer(conn, vn) {
    await conn.query(
        `UPDATE opd_opi_fn_cr_detail SET hos_guid = 'Y'
        WHERE opd_opi_fn_cr_list_id IN (
            SELECT opd_opi_fn_cr_list_id FROM opd_opi_fn_cr_list
            WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)
        )
        AND amount_paidst_03 IS NULL`,
        { vn }
    );

    await conn.query(
        `DELETE FROM opd_opi_fn_cr_detail
        WHERE opd_opi_fn_cr_list_id IN (
            SELECT opd_opi_fn_cr_list_id FROM opd_opi_fn_cr_list
            WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)
        )
        AND amount_paidst_03 IS NULL`,
        { vn }
    );

    await conn.query(
        `DELETE FROM opd_opi_fn_cr_list WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)`,
        { vn }
    );

    await conn.query(
        `DELETE FROM opd_opi_fn_tr_detail
        WHERE opd_opi_fn_tr_list_id IN (
            SELECT opd_opi_fn_tr_list_id FROM opd_opi_fn_tr_list
            WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)
        )
        AND amount_paidst_03 = 0`,
        { vn }
    );

    await conn.query(
        `DELETE FROM opd_opi_fn_tr_list WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)`,
        { vn }
    );
}

// 3) คืนค่าให้ใบสั่งยา/รายการที่ยังไม่ผ่านการเงิน ให้กลับมาออกใบแจ้งหนี้ใหม่ได้
async function step3RevertOrderItems(conn, vn) {
    await conn.query(
        `UPDATE opitemrece SET finance_number = NULL
        WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)
        AND paidst NOT IN ('01', '03')`,
        { vn }
    );

    await conn.query(
        `UPDATE opitemrece SET opi_doctor_finance_type_id = NULL
        WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)
        AND finance_number IS NULL`,
        { vn }
    );

    await conn.query(
        `UPDATE opitemrece SET node_id = NULL
        WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)
        AND finance_number IS NULL`,
        { vn }
    );

    await conn.query(
        `DELETE FROM opd_opi_hos_guid_transfer WHERE vn IN (SELECT vn FROM rcpt_debt WHERE vn = :vn)`,
        { vn }
    );

    await conn.query("UPDATE ovst SET finance_lock = 'N' WHERE vn = :vn", { vn });
    await conn.query("UPDATE visit_pttype SET finance_clear_ok = 'Y' WHERE vn = :vn", { vn });
    await conn.query("UPDATE ovst_seq SET finance_status_flag = '2' WHERE vn = :vn", { vn });
}

module.exports = { runInvoiceSteps, getDebtId, runCancelInvoiceSteps };
