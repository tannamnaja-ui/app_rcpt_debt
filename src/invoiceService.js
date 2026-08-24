/**
 * 9 ขั้นตอนของกระบวนการ "ออกใบแจ้งหนี้" (issue debt invoice) สำหรับ 1 VN
 * ทุก VN ที่เลือกรันรวมกันใน transaction เดียว (ผู้เรียกเป็นคนคุม begin/commit/rollback)
 * หากขั้นตอนใดของ VN ใดล้มเหลว ผู้เรียกต้อง rollback ทั้งหมด - ไม่มี VN ใดถูกออกใบแจ้งหนี้
 *
 * financeNumber ถูกสร้างครั้งเดียวโดยผู้เรียก (ต่อการออกใบแจ้งหนี้ 1 ครั้ง) แล้วส่งเข้ามาใช้ร่วมกันทุก VN
 * เพื่อให้ VN หลายรายการที่เลือกพร้อมกันกลายเป็นใบแจ้งหนี้ใบเดียว (เลขที่เดียวกัน)
 * debtDate/debtTime คือวันที่-เวลาที่ออกใบแจ้งหนี้จริง (ปัจจุบัน) ไม่ใช่วันที่เปิด visit
 */

async function runInvoiceSteps(conn, vn, staffLoginName, dbType, financeNumber, debtDate, debtTime) {
    const vercode = await fetchVercode(conn, vn);
    const trListId = await step1TransferList(conn, vn);
    await step2GuidTransfer(conn, vn, trListId);
    await step3TransferDetail(conn, vn, trListId);
    await step4FinanceSummary(conn, vn);
    const { crListId } = await step5ClearList(conn, vn, financeNumber);
    await step55LinkClearList(conn, trListId, crListId);
    await step6ClearDetail(conn, vn, crListId);
    await step7RcptDebt(conn, vn, dbType, financeNumber, vercode, debtDate, debtTime, staffLoginName);
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
// ข้าม hos_guid ที่เคยถูกโอนไปแล้ว (เช่น โอนค้างไว้จาก HOSxP เอง หรือความพยายามโอนครั้งก่อนที่ไม่จบ) เพื่อกัน
// duplicate key ที่ opd_opi_hos_guid_transfer.opi_guid (PK) เพราะค่า hos_guid คงที่ retry ใหม่ก็ชนซ้ำเดิม
async function step2GuidTransfer(conn, vn, trListId) {
    await conn.query(
        `INSERT INTO opd_opi_hos_guid_transfer
            (opi_guid, hos_guid, vn, opd_opi_fn_tr_list_id)
        SELECT oi.hos_guid, oi.hos_guid, oi.vn, :tr_list_id
        FROM opitemrece oi
        WHERE oi.vn = :vn
        AND oi.paidst = '02'
        AND (oi.finance_number IS NULL OR oi.finance_number = '')
        AND NOT EXISTS (
            SELECT 1 FROM opd_opi_hos_guid_transfer t WHERE t.opi_guid = oi.hos_guid
        )`,
        { vn, tr_list_id: trListId }
    );
}

// 3) รายละเอียดรายการโอน — เฉพาะ paidst='02' เท่านั้น (group by income/pttype)
// opitemrece.pttype บางแถวเป็น NULL (ข้อมูลระดับรายการไม่ได้ระบุสิทธิ) แต่คอลัมน์ pttype ปลายทางเป็น NOT NULL
// จึงต้อง COALESCE กับ ovst.pttype (สิทธิของ visit) เป็นค่า fallback
async function step3TransferDetail(conn, vn, trListId) {
    await conn.query(
        `INSERT INTO opd_opi_fn_tr_detail
            (opd_opi_fn_tr_detail_id, opd_opi_fn_tr_list_id, income, pttype,
             amount_paidst_01, amount_paidst_02, amount_paidst_03, total_amount,
             amount_paidst_04, process_order, amount_paidst_04a, amount_paidst_04b)
        SELECT get_serialnumber('opd_opi_fn_tr_detail_id'), :tr_list_id, op.income, COALESCE(op.pttype, o.pttype),
            '0',
            SUM(op.sum_price),
            '0',
            SUM(op.sum_price), '0', '1000', '0', '0'
        FROM opitemrece op
        JOIN ovst o ON o.vn = op.vn
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.income, COALESCE(op.pttype, o.pttype)`,
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
            '0', COALESCE(op.pttype, o.pttype), 'N', '0', '0',
            SUM(op.sum_price),
            SUM(op.sum_price)
        FROM opitemrece op
        JOIN ovst o ON o.vn = op.vn
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY COALESCE(op.pttype, o.pttype), op.vn, op.income`,
        { vn }
    );
}

// 5) เปิดรายการเคลียร์หนี้ (opd_opi_fn_cr_list) โดยใช้ finance_number (เลขที่ใบแจ้งหนี้) ที่ผู้เรียกกำหนดมาให้ (ใช้ร่วมกันได้หลาย VN)
// ต้องกำหนด vp.pttype = o.pttype ด้วย เพราะ visit_pttype อาจมีมากกว่า 1 แถวต่อ VN (เช่น มีประวัติสิทธิเก่าค้างอยู่)
// ถ้าไม่กำหนด SELECT จะ fan-out ได้หลายแถวแต่ทุกแถวใช้ :cr_list_id ค่าเดียวกัน ทำให้ INSERT ชนกันเองภายในคำสั่งเดียว
async function step5ClearList(conn, vn, financeNumber) {
    const idRows = await conn.query(
        "SELECT get_serialnumber('opd_opi_fn_cr_list_id') AS cr_list_id"
    );
    const crListId = idRows[0].cr_list_id;

    await conn.query(
        `INSERT INTO opd_opi_fn_cr_list
            (opd_opi_fn_cr_list_id, vn, pttype,
             opd_opi_fn_cr_date, opd_opi_fn_cr_time, opd_opi_fn_cr_staff,
             clear_amount, finance_number, status_ok)
        SELECT :cr_list_id, o.vn, vp.pttype,
            o.vstdate, o.vsttime, o.staff, v.uc_money, :finance_number, 'Y'
        FROM vn_stat v, ovst o, visit_pttype vp
        WHERE v.vn = o.vn AND vp.vn = o.vn AND vp.pttype = o.pttype AND o.vn = :vn`,
        { vn, cr_list_id: crListId, finance_number: financeNumber }
    );
    return { crListId };
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

// 7) บันทึกใบแจ้งหนี้ (rcpt_debt) — เฉพาะ paidst='02' เท่านั้น (group by vn/hn เท่านั้น = 1 แถวต่อ 1 VN เสมอ)
// debt_date/debt_time/debt_date_time ใช้วันที่-เวลาปัจจุบัน (ตอนออกใบแจ้งหนี้จริง) ไม่ใช่วันที่เปิด visit (vstdate/vsttime)
// staff ที่บันทึกคือเจ้าหน้าที่ที่ออกใบแจ้งหนี้ตอนนี้ (staffLoginName) ไม่ใช่ op.staff ของแต่ละรายการ
// pttype ใช้ค่าของ visit (o.pttype ซึ่งมีค่าเดียวต่อ 1 VN) แทนการอิง op.pttype ระดับรายการ
// เพราะ opitemrece แต่ละแถวอาจมี staff/pttype ต่างกัน ถ้า group by ค่าระดับรายการเหล่านี้จะทำให้ VN เดียวกัน
// ถูกแยกออกเป็นหลายใบแจ้งหนี้โดยไม่จำเป็น - ต้องการแค่ 1 ใบต่อ 1 VN เสมอ
async function step7RcptDebt(conn, vn, dbType, financeNumber, vercode, debtDate, debtTime, staffLoginName) {
    // ใช้ชื่อ parameter แยกกันสำหรับ debt_date/debt_time (ผูกกับคอลัมน์ DATE/TIME โดยตรง)
    // กับ debt_date_txt/debt_time_txt (ใช้ใน CONCAT ต้อง cast เป็น text) แม้ค่าเดียวกัน
    // เพราะ PostgreSQL ไม่ยอมให้ parameter ชื่อเดียวกันถูก deduce เป็นคนละชนิดในคำสั่งเดียวกัน
    const debtDateTimeExpr = dbType === 'pgsql'
        ? "(CONCAT(:debt_date_txt::text, ' ', :debt_time_txt::text))::timestamp"
        : "CAST(CONCAT(:debt_date_txt, ' ', :debt_time_txt) AS DATETIME)";

    await conn.query(
        `INSERT INTO rcpt_debt
            (debt_id, vn, hn, debt_date, debt_time, staff, amount, pt_type,
             computer, finance_number, pttype, discount_amount, total_amount,
             debt_date_time, debt_doc_id, department, special_discount_amount, ofc_paid_amount, sss_approval_code)
        SELECT get_serialnumber('rcpt_debt_id'), op.vn, op.hn, :debt_date, :debt_time, :staff,
            SUM(op.sum_price),
            'OPD', 'App rcpt auto', :finance_number, o.pttype,
            SUM(op.discount),
            SUM(op.sum_price),
            ${debtDateTimeExpr},
            CONCAT(o.pttype, '/1'),
            'OPD', '0', '0', :vercode
        FROM opitemrece op
        JOIN ovst o ON o.vn = op.vn
        WHERE op.vn = :vn
        AND op.paidst = '02'
        GROUP BY op.vn, op.hn, o.pttype`,
        {
            vn, finance_number: financeNumber, vercode, staff: staffLoginName,
            debt_date: debtDate, debt_time: debtTime,
            debt_date_txt: debtDate, debt_time_txt: debtTime,
        }
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

// สร้างชุด placeholder :prefix0, :prefix1, ... สำหรับ IN (...) พร้อมยัดค่าเข้า params
// ใช้แทนการเขียน IN (SELECT ...) เพราะ MySQL (5.x/5.7) ไม่แปลง subquery ใน UPDATE/DELETE
// เป็น semi-join ทำให้กลายเป็น DEPENDENT SUBQUERY -> สแกนทั้งตาราง (opitemrece มีหลายสิบล้านแถว)
// จนค้างและล็อกแถวจำนวนมาก ส่วน PostgreSQL แปลงเป็น semi-join ให้เองจึงไม่มีอาการนี้
function buildInList(values, params, prefix) {
    return values
        .map(function (value, i) {
            const key = prefix + i;
            params[key] = value;
            return ':' + key;
        })
        .join(', ');
}

// 0) บันทึกประวัติการยกเลิกลง rcpt_debt_cancel ก่อนที่ step1 จะเคลียร์ยอดใน rcpt_debt เป็น 0
// (ต้องอ่านค่า amount/total_amount/discount_amount ของใบแจ้งหนี้เดิมไว้ก่อนถูกล้าง)
async function step0LogCancel(conn, debts, reason, cancelStaff) {
    for (const d of debts) {
        const idRows = await conn.query("SELECT get_serialnumber('rcpt_debt_cancel_id') AS id");

        await conn.query(
            `INSERT INTO rcpt_debt_cancel
                (debt_cancel_id, debt_id, vn, hn, debt_date, debt_time, cancel_datetime,
                 staff, cancel_staff, amount, pt_type, computer, cancel_computer,
                 discount_amount, total_amount, reason)
            VALUES
                (:debt_cancel_id, :debt_id, :vn, :hn, :debt_date, :debt_time, CURRENT_TIMESTAMP,
                 :staff, :cancel_staff, :amount, :pt_type, :computer, :cancel_computer,
                 :discount_amount, :total_amount, :reason)`,
            {
                debt_cancel_id: idRows[0].id,
                debt_id: d.debt_id,
                vn: d.vn,
                hn: d.hn,
                debt_date: d.debt_date,
                debt_time: d.debt_time,
                staff: d.staff,
                cancel_staff: cancelStaff,
                amount: d.amount,
                pt_type: d.pt_type,
                computer: d.computer,
                cancel_computer: 'App rcpt auto',
                discount_amount: d.discount_amount,
                total_amount: d.total_amount,
                reason: reason || '',
            }
        );
    }
}

/**
 * 3 ขั้นตอนของกระบวนการ "ยกเลิกใบแจ้งหนี้" (cancel debt invoice) สำหรับ 1 VN
 * ผู้เรียกเป็นคนคุม begin/commit/rollback (transaction เดียวกัน)
 * reason/cancelStaff ใช้บันทึกลง rcpt_debt_cancel ก่อนเริ่มขั้นตอนยกเลิกจริง
 * อ่าน rcpt_debt ของ VN นี้ครั้งเดียวแล้วส่ง debt_id ต่อให้ทุกขั้นตอน แทนการใช้ subquery ซ้ำ ๆ
 */
async function runCancelInvoiceSteps(conn, vn, reason, cancelStaff) {
    const debts = await conn.query(
        `SELECT debt_id, vn, hn, debt_date, debt_time, staff, amount, pt_type,
            computer, discount_amount, total_amount, status
        FROM rcpt_debt
        WHERE vn = :vn`,
        { vn }
    );

    const activeDebts = debts.filter(function (d) { return d.status !== 'ABORT'; });
    const debtIds = debts.map(function (d) { return d.debt_id; });

    await step0LogCancel(conn, activeDebts, reason, cancelStaff);
    await step1CancelDebt(conn, vn, debtIds);
    await step2CancelTransfer(conn, vn, debts.length > 0);
    await step3RevertOrderItems(conn, vn, debts.length > 0);
}

// 1) ยกเลิกลูกหนี้ — เคลียร์ยอดและตั้งสถานะ ABORT ที่ rcpt_debt/rcpt_debt_detail
async function step1CancelDebt(conn, vn, debtIds) {
    if (debtIds.length === 0) return;

    await conn.query(
        "UPDATE rcpt_debt SET amount = 0, total_amount = 0, status = 'ABORT' WHERE vn = :vn",
        { vn }
    );

    const params = {};
    const idList = buildInList(debtIds, params, 'debt_id');
    await conn.query(
        `UPDATE rcpt_debt_detail SET amount = 0, total_amount = 0
        WHERE debt_id IN (${idList})`,
        params
    );
}

// 2) ยกเลิกโอน — ลบรายการโอน/เคลียร์หนี้ที่เปิดไว้ตอนออกใบแจ้งหนี้
async function step2CancelTransfer(conn, vn, hasDebt) {
    if (!hasDebt) return;

    const crRows = await conn.query(
        'SELECT opd_opi_fn_cr_list_id FROM opd_opi_fn_cr_list WHERE vn = :vn',
        { vn }
    );
    const crIds = crRows.map(function (r) { return r.opd_opi_fn_cr_list_id; });

    if (crIds.length > 0) {
        const crParams = {};
        const crList = buildInList(crIds, crParams, 'cr');
        await conn.query(
            `UPDATE opd_opi_fn_cr_detail SET hos_guid = 'Y'
            WHERE opd_opi_fn_cr_list_id IN (${crList})
            AND amount_paidst_03 IS NULL`,
            crParams
        );
        await conn.query(
            `DELETE FROM opd_opi_fn_cr_detail
            WHERE opd_opi_fn_cr_list_id IN (${crList})
            AND amount_paidst_03 IS NULL`,
            crParams
        );
    }

    await conn.query('DELETE FROM opd_opi_fn_cr_list WHERE vn = :vn', { vn });

    const trRows = await conn.query(
        'SELECT opd_opi_fn_tr_list_id FROM opd_opi_fn_tr_list WHERE vn = :vn',
        { vn }
    );
    const trIds = trRows.map(function (r) { return r.opd_opi_fn_tr_list_id; });

    if (trIds.length > 0) {
        const trParams = {};
        const trList = buildInList(trIds, trParams, 'tr');
        await conn.query(
            `DELETE FROM opd_opi_fn_tr_detail
            WHERE opd_opi_fn_tr_list_id IN (${trList})
            AND amount_paidst_03 = 0`,
            trParams
        );
    }

    await conn.query('DELETE FROM opd_opi_fn_tr_list WHERE vn = :vn', { vn });
}

// 3) คืนค่าให้ใบสั่งยา/รายการที่ยังไม่ผ่านการเงิน ให้กลับมาออกใบแจ้งหนี้ใหม่ได้
async function step3RevertOrderItems(conn, vn, hasDebt) {
    if (hasDebt) {
        await conn.query(
            `UPDATE opitemrece SET finance_number = NULL
            WHERE vn = :vn AND paidst NOT IN ('01', '03')`,
            { vn }
        );

        await conn.query(
            `UPDATE opitemrece SET opi_doctor_finance_type_id = NULL, node_id = NULL
            WHERE vn = :vn AND finance_number IS NULL`,
            { vn }
        );

        await conn.query('DELETE FROM opd_opi_hos_guid_transfer WHERE vn = :vn', { vn });
    }

    await conn.query("UPDATE ovst SET finance_lock = 'N' WHERE vn = :vn", { vn });
    await conn.query("UPDATE visit_pttype SET finance_clear_ok = 'Y' WHERE vn = :vn", { vn });
    await conn.query("UPDATE ovst_seq SET finance_status_flag = '2' WHERE vn = :vn", { vn });
}

module.exports = { runInvoiceSteps, getDebtId, runCancelInvoiceSteps };
