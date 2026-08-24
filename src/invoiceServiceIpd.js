/**
 * 9 ขั้นตอนของกระบวนการ "ออกใบแจ้งหนี้" (issue debt invoice) สำหรับผู้ป่วยใน (IPD) 1 AN
 * เป็นคู่ขนานของ invoiceService.js (OPD) แต่ใช้ an/ipt/ipt_pttype และตาราง ipt_opi_* แทน
 * เพราะ opitemrece.vn เป็น NULL สำหรับรายการ IPD (มีแค่ op.an เท่านั้น) จึงอ้างอิงผ่าน an ตลอดทั้งกระบวนการ
 *
 * ทุก AN ที่เลือกรันรวมกันใน transaction เดียว (ผู้เรียกเป็นคนคุม begin/commit/rollback)
 * financeNumber/debtDate/debtTime ใช้ร่วมกันทุก AN เหมือนฝั่ง OPD (รวมเป็นใบแจ้งหนี้ใบเดียว วันที่ปัจจุบัน)
 */

async function runInvoiceStepsIpd(conn, an, staffLoginName, dbType, financeNumber, debtDate, debtTime) {
    const vercode = await fetchVercodeIpd(conn, an);
    const trListId = await step1TransferListIpd(conn, an);
    await step2GuidTransferIpd(conn, an, trListId);
    await step3TransferDetailIpd(conn, an, trListId);
    await step4FinanceSummaryIpd(conn, an);
    const { crListId } = await step5ClearListIpd(conn, an, financeNumber);
    await step55LinkClearListIpd(conn, trListId, crListId);
    await step6ClearDetailIpd(conn, an, crListId, trListId);
    await step65MarkFinanceSummaryClearedIpd(conn, an);
    await step7RcptDebtIpd(conn, an, dbType, financeNumber, vercode, debtDate, debtTime, staffLoginName);
    const debtId = await fetchDebtIdIpd(conn, an, dbType, financeNumber);
    await step8RcptDebtDetailIpd(conn, an, debtId);
    await step9UpdateFinanceNumberIpd(conn, an, financeNumber);
    await step10SetFinanceStatusFlagIpd(conn, an);

    return { financeNumber };
}

// Pre-fetch: vercode (auth_code) จาก ipt_pttype สำหรับใส่ใน sss_approval_code
async function fetchVercodeIpd(conn, an) {
    const rows = await conn.query(
        'SELECT auth_code FROM ipt_pttype WHERE an = :an LIMIT 1',
        { an }
    );
    return (rows.length > 0 && rows[0].auth_code) ? String(rows[0].auth_code) : '';
}

// 1) เปิดรายการโอนเข้าระบบลูกหนี้ (ipt_opi_fn_tr_list) - transfer_amount คำนวณจาก opitemrece ตรง (ไม่มี vn_stat สำหรับ IPD)
async function step1TransferListIpd(conn, an) {
    const idRows = await conn.query("SELECT get_serialnumber('ipt_opi_fn_tr_list_id') AS id");
    const trListId = idRows[0].id;

    await conn.query(
        `INSERT INTO ipt_opi_fn_tr_list
            (ipt_opi_fn_tr_list_id, ipt_opi_fn_tr_date, ipt_opi_fn_tr_time, an, transfer_amount, ipt_opi_fn_tr_staff)
        SELECT :tr_list_id, i.dchdate, i.dchtime, i.an,
            (SELECT COALESCE(SUM(op.sum_price), 0) FROM opitemrece op WHERE op.an = i.an AND op.paidst = '02'),
            i.staff
        FROM ipt i
        WHERE i.an = :an`,
        { an, tr_list_id: trListId }
    );
    return trListId;
}

// 2) เชื่อม hos_guid ของ opitemrece (เฉพาะ paidst='02' ที่ยังไม่มี finance_number) เข้ากับรายการโอนในขั้นตอนที่ 1
// ข้าม hos_guid ที่เคยถูกโอนไปแล้ว กัน duplicate key ที่ ipt_opi_hos_guid_transfer.opi_guid (PK) เหมือนฝั่ง OPD
async function step2GuidTransferIpd(conn, an, trListId) {
    await conn.query(
        `INSERT INTO ipt_opi_hos_guid_transfer
            (opi_guid, an, ipt_opi_fn_tr_list_id)
        SELECT oi.hos_guid, oi.an, :tr_list_id
        FROM opitemrece oi
        WHERE oi.an = :an
        AND oi.paidst = '02'
        AND (oi.finance_number IS NULL OR oi.finance_number = '')
        AND NOT EXISTS (
            SELECT 1 FROM ipt_opi_hos_guid_transfer t WHERE t.opi_guid = oi.hos_guid
        )`,
        { an, tr_list_id: trListId }
    );
}

// 3) รายละเอียดรายการโอน — เฉพาะ paidst='02' เท่านั้น (group by income/pttype)
// opitemrece.pttype บางแถวเป็น NULL จึง COALESCE กับ ipt.pttype เป็นค่า fallback เหมือนฝั่ง OPD
async function step3TransferDetailIpd(conn, an, trListId) {
    await conn.query(
        `INSERT INTO ipt_opi_fn_tr_detail
            (ipt_opi_fn_tr_detail_id, ipt_opi_fn_tr_list_id, income, pttype,
             amount_paidst_01, amount_paidst_02, amount_paidst_03, total_amount,
             amount_paidst_04, amount_paidst_04a, amount_paidst_04b)
        SELECT get_serialnumber('ipt_opi_fn_tr_detail_id'), :tr_list_id, op.income, COALESCE(op.pttype, i.pttype),
            '0',
            SUM(op.sum_price),
            '0',
            SUM(op.sum_price), '0', '0', '0'
        FROM opitemrece op
        JOIN ipt i ON i.an = op.an
        WHERE op.an = :an
        AND op.paidst = '02'
        GROUP BY op.income, COALESCE(op.pttype, i.pttype)`,
        { an, tr_list_id: trListId }
    );
}

// 4) สรุปยอดการเงินของการรับไว้รักษา (ipt_opi_finance_summary) — เฉพาะ paidst='02' เท่านั้น (group by pttype/an/income)
async function step4FinanceSummaryIpd(conn, an) {
    await conn.query(
        `INSERT INTO ipt_opi_finance_summary
            (ipt_opi_finance_summary_id, an, income,
             total_paidst_01, total_paidst_02, total_paidst_03, total_paidst_04,
             total_amount, clear_amount, balance_amount,
             total_balance_01, total_balance_02, total_balance_03, total_balance_04,
             pttype, status_ok, total_paidst_04a, total_paidst_04b, total_balance_04a, total_amount_a)
        SELECT get_serialnumber('ipt_opi_finance_summary_id'), op.an, op.income,
            '0', SUM(op.sum_price), '0',
            '0', SUM(op.sum_price), '0', SUM(op.sum_price),
            '0', SUM(op.sum_price), '0',
            '0', COALESCE(op.pttype, i.pttype), 'N', '0', '0',
            SUM(op.sum_price),
            SUM(op.sum_price)
        FROM opitemrece op
        JOIN ipt i ON i.an = op.an
        WHERE op.an = :an
        AND op.paidst = '02'
        GROUP BY COALESCE(op.pttype, i.pttype), op.an, op.income`,
        { an }
    );
}

// 5) เปิดรายการเคลียร์หนี้ (ipt_opi_fn_cr_list) โดยใช้ finance_number ที่ผู้เรียกกำหนดมาให้ (ใช้ร่วมกันได้หลาย AN)
async function step5ClearListIpd(conn, an, financeNumber) {
    const idRows = await conn.query(
        "SELECT get_serialnumber('ipt_opi_fn_cr_list_id') AS cr_list_id"
    );
    const crListId = idRows[0].cr_list_id;

    await conn.query(
        `INSERT INTO ipt_opi_fn_cr_list
            (ipt_opi_fn_cr_list_id, an, pttype,
             ipt_opi_fn_cr_date, ipt_opi_fn_cr_time, ipt_opi_fn_cr_staff,
             clear_amount, finance_number, status_ok)
        SELECT :cr_list_id, i.an, i.pttype,
            i.dchdate, i.dchtime, i.staff,
            (SELECT COALESCE(SUM(op.sum_price), 0) FROM opitemrece op WHERE op.an = i.an AND op.paidst = '02'),
            :finance_number, 'Y'
        FROM ipt i
        WHERE i.an = :an`,
        { an, cr_list_id: crListId, finance_number: financeNumber }
    );
    return { crListId };
}

// 5.5) เชื่อมรายการโอน (ipt_opi_fn_tr_detail) เข้ากับรายการเคลียร์หนี้ (ipt_opi_fn_cr_list)
async function step55LinkClearListIpd(conn, trListId, crListId) {
    await conn.query(
        `UPDATE ipt_opi_fn_tr_detail
        SET ipt_opi_fn_cr_list_id = :cr_list_id
        WHERE ipt_opi_fn_tr_list_id = :tr_list_id
        AND (ipt_opi_fn_cr_list_id IS NULL OR ipt_opi_fn_cr_list_id = 0)`,
        { tr_list_id: trListId, cr_list_id: crListId }
    );
}

// 6) รายละเอียดรายการเคลียร์หนี้ — เฉพาะ paidst='02' เท่านั้น (group by income)
async function step6ClearDetailIpd(conn, an, crListId, trListId) {
    await conn.query(
        `INSERT INTO ipt_opi_fn_cr_detail
            (ipt_opi_fn_cr_detail_id, ipt_opi_fn_cr_list_id,
             income, amount_paidst_02, amount_paidst_04, total_amount, original_total_amount, ipt_opi_fn_tr_list_id)
        SELECT get_serialnumber('ipt_opi_fn_cr_detail_id'), :cr_list_id, op.income,
            SUM(op.sum_price),
            '0',
            SUM(op.sum_price),
            SUM(op.sum_price),
            :tr_list_id
        FROM opitemrece op
        WHERE op.an = :an
        AND op.paidst = '02'
        GROUP BY op.income`,
        { an, cr_list_id: crListId, tr_list_id: trListId }
    );
}

// 6.5) ปิดสถานะ "เคลียร์แล้ว" ของสรุปยอดการเงินรายหมวด (ipt_opi_finance_summary) ที่เพิ่ง insert ไว้ในขั้นตอนที่ 4
// เทียบกับโปรแกรม HOSxP เอง: หน้าบันทึกใบเสร็จจะขึ้นสถานะ "เขียว" ต่อหมวดค่ารักษา (income) เมื่อ status_ok='Y' เท่านั้น
// ถ้าไม่ update จุดนี้ status_ok จะค้างเป็น 'N' (ค่าตอน insert ตอนขั้นตอนที่ 4) ทำให้ HOSxP ยังขึ้นสถานะแดงแม้ rcpt_debt จะออกใบแจ้งหนี้ไปแล้ว
// WHERE status_ok='N' ปลอดภัยเพราะแถวที่เคลียร์ไปแล้วก่อนหน้าจะเป็น 'Y' อยู่แล้ว ไม่ถูกแตะต้องซ้ำ
async function step65MarkFinanceSummaryClearedIpd(conn, an) {
    await conn.query(
        `UPDATE ipt_opi_finance_summary
        SET clear_amount = total_amount, balance_amount = 0, status_ok = 'Y'
        WHERE an = :an AND status_ok = 'N'`,
        { an }
    );
}

// 7) บันทึกใบแจ้งหนี้ (rcpt_debt - ตารางเดียวกับ OPD) — เฉพาะ paidst='02' เท่านั้น (group by hn เท่านั้น = 1 แถวต่อ 1 AN เสมอ)
// opitemrece.vn เป็น NULL สำหรับ IPD และ ipt.vn บาง AN ก็ไม่มีค่าหรือมีปัญหา (ทำให้ insert ไม่เกิดขึ้นบางกรณี)
// จึงใช้ i.an เก็บลงคอลัมน์ vn ของ rcpt_debt แทนตรงๆ (rcpt_debt ไม่มีคอลัมน์ an ของตัวเอง)
// pt_type/department ใช้ 'IPD' แทน 'OPD' เพื่อแยกประเภทลูกหนี้
async function step7RcptDebtIpd(conn, an, dbType, financeNumber, vercode, debtDate, debtTime, staffLoginName) {
    const debtDateTimeExpr = dbType === 'pgsql'
        ? "(CONCAT(:debt_date_txt::text, ' ', :debt_time_txt::text))::timestamp"
        : "CAST(CONCAT(:debt_date_txt, ' ', :debt_time_txt) AS DATETIME)";

    await conn.query(
        `INSERT INTO rcpt_debt
            (debt_id, vn, hn, debt_date, debt_time, staff, amount, pt_type,
             computer, finance_number, pttype, discount_amount, total_amount,
             debt_date_time, debt_doc_id, department, special_discount_amount, ofc_paid_amount, sss_approval_code)
        SELECT get_serialnumber('rcpt_debt_id'), i.an, op.hn, :debt_date, :debt_time, :staff,
            SUM(op.sum_price),
            'IPD', 'App rcpt auto', :finance_number, COALESCE(op.pttype, i.pttype),
            SUM(op.discount),
            SUM(op.sum_price),
            ${debtDateTimeExpr},
            CONCAT(COALESCE(op.pttype, i.pttype), '/1'),
            'IPD', '0', '0', :vercode
        FROM opitemrece op
        JOIN ipt i ON i.an = op.an
        WHERE op.an = :an
        AND op.paidst = '02'
        GROUP BY op.hn, i.an, COALESCE(op.pttype, i.pttype)`,
        {
            an, finance_number: financeNumber, vercode, staff: staffLoginName,
            debt_date: debtDate, debt_time: debtTime,
            debt_date_txt: debtDate, debt_time_txt: debtTime,
        }
    );
}

// ดึง debt_id ของแถวที่สร้างในขั้นตอนที่ 7 (rcpt_debt.vn เก็บค่า an ของ IPD ไว้โดยตรงแล้ว ไม่ต้อง lookup ผ่าน ipt อีก)
async function fetchDebtIdIpd(conn, an, dbType, financeNumber) {
    const amountExpr = dbType === 'pgsql' ? 'CAST(amount AS NUMERIC)' : 'CAST(amount AS DECIMAL(18,2))';
    const rows = await conn.query(
        `SELECT debt_id FROM rcpt_debt
        WHERE vn = :an
        AND finance_number = :finance_number AND ${amountExpr} <> 0
        ORDER BY debt_id LIMIT 1`,
        { an, finance_number: financeNumber }
    );
    return rows.length > 0 ? rows[0].debt_id : null;
}

// 8) รายละเอียดใบแจ้งหนี้ — เฉพาะ paidst='02' เท่านั้น (group by income) อ้างอิง debt_id จากขั้นตอนที่ 7
async function step8RcptDebtDetailIpd(conn, an, debtId) {
    await conn.query(
        `INSERT INTO rcpt_debt_detail
            (debt_id, income, amount, discount, total_amount, special_discount)
        SELECT :debt_id, op.income,
            SUM(op.sum_price),
            SUM(op.discount),
            SUM(op.sum_price),
            '0'
        FROM opitemrece op
        WHERE op.an = :an
        AND op.paidst = '02'
        GROUP BY op.income`,
        { an, debt_id: debtId }
    );
}

// 9) ปิดยอด opitemrece โดยใส่ finance_number จากขั้นตอนที่ 5 (เฉพาะ paidst='02' ที่ยังไม่มี finance_number)
async function step9UpdateFinanceNumberIpd(conn, an, financeNumber) {
    await conn.query(
        `UPDATE opitemrece
        SET finance_number = :finance_number
        WHERE an = :an
        AND paidst = '02'
        AND (finance_number IS NULL OR finance_number = '')`,
        { an, finance_number: financeNumber }
    );
}

// 10) ปิดสถานะการเงินฝั่ง HOSxP (ipt.finance_status_flag='3', ipt.finance_lock='Y') = เคลียร์การเงินครบแล้ว
// ยืนยันจากข้อมูลจริง (เทียบกับ log ของโปรแกรม HOSxP เอง): AN ที่ออกใบแจ้งหนี้ครบจริงจะมี finance_lock='Y'
// คู่กับ finance_status_flag='3' เสมอ (finance_lock='Y' เพียงอย่างเดียวโดย flag ยัง='2' คือสถานะ "โอนแล้วแต่ยังไม่เคลียร์")
// ถ้าไม่ set ค่านี้ HOSxP จะยังแสดงสถานะว่ายังไม่เสร็จ (ไม่ขึ้นเขียว) แม้ rcpt_debt จะออกใบแจ้งหนี้ไปแล้วก็ตาม
async function step10SetFinanceStatusFlagIpd(conn, an) {
    await conn.query("UPDATE ipt SET finance_status_flag = '3', finance_lock = 'Y' WHERE an = :an", { an });
}

// เรียกใช้หลัง commit (จาก route) เพื่อดึง debt_id สำหรับแสดงผล
async function getDebtIdIpd(conn, an, dbType, financeNumber) {
    return fetchDebtIdIpd(conn, an, dbType, financeNumber);
}

/**
 * 3 ขั้นตอนของกระบวนการ "ยกเลิกใบแจ้งหนี้" (cancel debt invoice) สำหรับผู้ป่วยใน 1 AN
 * ผู้เรียกเป็นคนคุม begin/commit/rollback (transaction เดียวกัน) - เป็นคู่ขนานของ runCancelInvoiceSteps (OPD)
 */
async function runCancelInvoiceStepsIpd(conn, an) {
    const vn = await fetchVnByAn(conn, an);
    await step1CancelDebtIpd(conn, an);
    await step2CancelTransferIpd(conn, an);
    await step3RevertOrderItemsIpd(conn, an, vn);
}

// ใช้เฉพาะสำหรับอัปเดต ovst.finance_lock (ตาราง OPD ที่ผูกกับ vn จริง) ใน step3 เท่านั้น
// ไม่เกี่ยวกับ rcpt_debt แล้ว เพราะ rcpt_debt.vn ของ IPD เก็บค่า an ตรงๆ อยู่แล้ว
async function fetchVnByAn(conn, an) {
    const rows = await conn.query('SELECT vn FROM ipt WHERE an = :an LIMIT 1', { an });
    return rows.length > 0 ? rows[0].vn : null;
}

// สร้างชุด placeholder :prefix0, :prefix1, ... สำหรับ IN (...) พร้อมยัดค่าเข้า params
// ใช้แทน IN (SELECT ...) เพราะ MySQL ไม่แปลง subquery ใน UPDATE/DELETE เป็น semi-join
// ทำให้กลายเป็น DEPENDENT SUBQUERY -> สแกนทั้งตารางจนค้าง (ดู buildInList ใน invoiceService.js)
function buildInListIpd(values, params, prefix) {
    return values
        .map(function (value, i) {
            const key = prefix + i;
            params[key] = value;
            return ':' + key;
        })
        .join(', ');
}

// 1) ยกเลิกลูกหนี้ — เคลียร์ยอดและตั้งสถานะ ABORT ที่ rcpt_debt/rcpt_debt_detail (rcpt_debt.vn เก็บค่า an ของ IPD ไว้ตรงๆ)
async function step1CancelDebtIpd(conn, an) {
    // อ่าน debt_id มาก่อนแล้วส่งเป็น IN (...) แทน IN (SELECT ...) เพราะ MySQL ไม่แปลง subquery
    // ใน UPDATE เป็น semi-join ทำให้สแกน rcpt_debt_detail ทั้งตารางจนค้าง (PostgreSQL ไม่มีอาการนี้)
    const debtRows = await conn.query('SELECT debt_id FROM rcpt_debt WHERE vn = :an', { an });
    if (debtRows.length === 0) return;

    await conn.query(
        "UPDATE rcpt_debt SET amount = 0, total_amount = 0, status = 'ABORT' WHERE vn = :an",
        { an }
    );

    const params = {};
    const idList = buildInListIpd(debtRows.map(function (r) { return r.debt_id; }), params, 'debt_id');

    await conn.query(
        `UPDATE rcpt_debt_detail SET amount = 0, total_amount = 0
        WHERE debt_id IN (${idList})`,
        params
    );
}

// 2) ยกเลิกโอน — ลบรายการโอน/เคลียร์หนี้ที่เปิดไว้ตอนออกใบแจ้งหนี้ (ตาราง ipt_opi_fn_* อ้างอิงด้วย an โดยตรง)
async function step2CancelTransferIpd(conn, an) {
    const crRows = await conn.query(
        'SELECT ipt_opi_fn_cr_list_id FROM ipt_opi_fn_cr_list WHERE an = :an',
        { an }
    );

    if (crRows.length > 0) {
        const crParams = {};
        const crList = buildInListIpd(crRows.map(function (r) { return r.ipt_opi_fn_cr_list_id; }), crParams, 'cr');

        await conn.query(
            `UPDATE ipt_opi_fn_cr_detail SET hos_guid = 'Y'
            WHERE ipt_opi_fn_cr_list_id IN (${crList})
            AND amount_paidst_03 IS NULL`,
            crParams
        );

        await conn.query(
            `DELETE FROM ipt_opi_fn_cr_detail
            WHERE ipt_opi_fn_cr_list_id IN (${crList})
            AND amount_paidst_03 IS NULL`,
            crParams
        );
    }

    await conn.query(`DELETE FROM ipt_opi_fn_cr_list WHERE an = :an`, { an });

    // ยกเลิกใบแจ้งหนี้แล้วต้องคืนสถานะ "ยังไม่เคลียร์" ของสรุปยอดรายหมวด ไม่งั้น status_ok จะค้างเป็น 'Y'
    // (ตั้งไว้ตอนออกใบแจ้งหนี้ใน step65) ทั้งที่ cr_list/cr_detail ถูกลบไปแล้วจริง ทำให้ HOSxP ขึ้นเขียวผิดสถานะ
    await conn.query(
        `UPDATE ipt_opi_finance_summary
        SET clear_amount = 0, balance_amount = total_amount, status_ok = 'N'
        WHERE an = :an AND status_ok = 'Y'`,
        { an }
    );

    const trRows = await conn.query(
        'SELECT ipt_opi_fn_tr_list_id FROM ipt_opi_fn_tr_list WHERE an = :an',
        { an }
    );

    if (trRows.length > 0) {
        const trParams = {};
        const trList = buildInListIpd(trRows.map(function (r) { return r.ipt_opi_fn_tr_list_id; }), trParams, 'tr');

        await conn.query(
            `DELETE FROM ipt_opi_fn_tr_detail
            WHERE ipt_opi_fn_tr_list_id IN (${trList})
            AND amount_paidst_03 = 0`,
            trParams
        );
    }

    await conn.query(`DELETE FROM ipt_opi_fn_tr_list WHERE an = :an`, { an });
}

// 3) คืนค่าให้รายการที่ยังไม่ผ่านการเงิน ให้กลับมาออกใบแจ้งหนี้ใหม่ได้
async function step3RevertOrderItemsIpd(conn, an, vn) {
    await conn.query(
        `UPDATE opitemrece SET finance_number = NULL
        WHERE an = :an
        AND paidst NOT IN ('01', '03')`,
        { an }
    );

    await conn.query(
        `UPDATE opitemrece SET opi_doctor_finance_type_id = NULL
        WHERE an = :an
        AND finance_number IS NULL`,
        { an }
    );

    await conn.query(
        `UPDATE opitemrece SET node_id = NULL
        WHERE an = :an
        AND finance_number IS NULL`,
        { an }
    );

    await conn.query(`DELETE FROM ipt_opi_hos_guid_transfer WHERE an = :an`, { an });

    if (vn) {
        await conn.query("UPDATE ovst SET finance_lock = 'N' WHERE vn = :vn", { vn });
    }
    await conn.query("UPDATE ipt_pttype SET finance_clear_ok = 'Y' WHERE an = :an", { an });
    await conn.query("UPDATE ipt SET finance_status_flag = '2', finance_lock = 'N' WHERE an = :an", { an });
}

module.exports = { runInvoiceStepsIpd, getDebtIdIpd, runCancelInvoiceStepsIpd };
