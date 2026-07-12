(function () {
    console.log('dashboard_ipd.js loaded (IPD copy - date filter uses discharge date, no time filter)');
    var STORAGE_HIPDATA = 'rcpt_debt_hipdata_codes';
    var STORAGE_PTTYPE = 'rcpt_debt_pttypes';

    var hnFilter = document.getElementById('hnFilter');
    var dateStart = document.getElementById('dateStart');
    var dateEnd = document.getElementById('dateEnd');
    var btnSearch = document.getElementById('btnSearch');
    var btnRemember = document.getElementById('btnRemember');
    var btnIssue = document.getElementById('btnIssue');
    var btnLogout = document.getElementById('btnLogout');
    var patientListCard = document.getElementById('patientListCard');
    var btnTogglePatientList = document.getElementById('btnTogglePatientList');
    var btnExpandPatientList = document.getElementById('btnExpandPatientList');
    var checkAll = document.getElementById('checkAll');
    var patientTableBody = document.querySelector('#patientTable tbody');
    var patientSummary = document.getElementById('patientSummary');
    var resultSection = document.getElementById('resultSection');
    var resultTableBody = document.querySelector('#resultTable tbody');
    var alertBox = document.getElementById('alertBox');
    var officerName = document.getElementById('officerName');
    var departmentBadge = document.getElementById('departmentBadge');
    var confirmModal = document.getElementById('confirmModal');
    var confirmMessage = document.getElementById('confirmMessage');
    var confirmOk = document.getElementById('confirmOk');
    var confirmCancel = document.getElementById('confirmCancel');
    var itemModal = document.getElementById('itemModal');
    var itemModalPatientInfo = document.getElementById('itemModalPatientInfo');
    var itemTableBody = document.querySelector('#itemTable tbody');
    var itemModalTotal = document.getElementById('itemModalTotal');
    var itemModalCancel = document.getElementById('itemModalCancel');
    var itemModalConfirm = document.getElementById('itemModalConfirm');
    var cancelInvoiceModal = document.getElementById('cancelInvoiceModal');
    var cancelModalPatientInfo = document.getElementById('cancelModalPatientInfo');
    var cancelItemTableBody = document.querySelector('#cancelItemTable tbody');
    var cancelModalTotal = document.getElementById('cancelModalTotal');
    var cancelModalCancel = document.getElementById('cancelModalCancel');
    var cancelModalConfirm = document.getElementById('cancelModalConfirm');
    var pageSizeSelect = document.getElementById('pageSize');
    var btnPrevPage = document.getElementById('btnPrevPage');
    var btnNextPage = document.getElementById('btnNextPage');
    var pageIndicator = document.getElementById('pageIndicator');
    var btnSelectAll = document.getElementById('btnSelectAll');
    var btnDeselectAll = document.getElementById('btnDeselectAll');
    var btnCheckIssued = document.getElementById('btnCheckIssued');
    var btnCheckIssuedHosxp = document.getElementById('btnCheckIssuedHosxp');
    var issuedSection = document.getElementById('issuedSection');
    var issuedSectionTitle = document.getElementById('issuedSectionTitle');
    var issuedHnFilter = document.getElementById('issuedHnFilter');
    var btnIssuedHnSearch = document.getElementById('btnIssuedHnSearch');
    var issuedTableBody = document.querySelector('#issuedTable tbody');
    var issuedSummary = document.getElementById('issuedSummary');
    var checkAllIssued = document.getElementById('checkAllIssued');
    var btnCancelSelectedIssued = document.getElementById('btnCancelSelectedIssued');
    var issuedPageSizeSelect = document.getElementById('issuedPageSize');
    var btnIssuedPrevPage = document.getElementById('btnIssuedPrevPage');
    var btnIssuedNextPage = document.getElementById('btnIssuedNextPage');
    var issuedPageIndicator = document.getElementById('issuedPageIndicator');

    var currentPage = 1;
    var totalPages = 1;
    var currentIssuedPage = 1;
    var totalIssuedPages = 1;
    var issuedSource = 'app'; // 'app' = ออกด้วย app นี้ / 'hosxp' = ออกจากโปรแกรม HOSxP เอง
    var selectedVns = {}; // vn -> { amount: number, checked: boolean } - คงสถานะการติ๊กเลือกข้ามหน้า
    var selectedIssuedVns = {}; // vn -> true - คงสถานะติ๊กเลือกยกเลิกใบแจ้งหนี้ข้ามหน้า

    function showAlert(message, type) {
        alertBox.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
    }

    function todayStr() {
        var d = new Date();
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var dd = String(d.getDate()).padStart(2, '0');
        return d.getFullYear() + '-' + mm + '-' + dd;
    }

    // ---------- Confirm modal ----------
    var confirmCallback = null;

    function showConfirm(message, callback) {
        confirmMessage.textContent = message;
        confirmCallback = callback;
        confirmModal.classList.add('open');
    }

    function closeConfirm() {
        confirmModal.classList.remove('open');
        confirmCallback = null;
    }

    confirmOk.addEventListener('click', function () {
        var cb = confirmCallback;
        closeConfirm();
        if (typeof cb === 'function') cb();
    });

    confirmCancel.addEventListener('click', closeConfirm);

    confirmModal.addEventListener('click', function (e) {
        if (e.target === confirmModal) closeConfirm();
    });

    // ---------- Item modal (รายการค่าใช้จ่ายรายคน + ออกใบแจ้งหนี้รายคน) ----------
    var currentItemVn = null;

    function closeItemModal() {
        itemModal.classList.remove('open');
        currentItemVn = null;
    }

    function openItemModal(vn, patientLabel) {
        currentItemVn = vn;
        itemModalPatientInfo.textContent = patientLabel;
        itemTableBody.innerHTML = '<tr><td colspan="3">กำลังโหลด...</td></tr>';
        itemModalTotal.textContent = '';
        itemModalConfirm.disabled = true;
        itemModal.classList.add('open');

        fetch('/api/an_items/' + encodeURIComponent(vn))
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    itemTableBody.innerHTML = '<tr><td colspan="3">เกิดข้อผิดพลาด: ' + data.message + '</td></tr>';
                    return;
                }

                itemTableBody.innerHTML = '';

                if (data.data.length === 0) {
                    itemTableBody.innerHTML = '<tr><td colspan="3">ไม่พบรายการค่าใช้จ่าย</td></tr>';
                } else {
                    data.data.forEach(function (row) {
                        var tr = document.createElement('tr');
                        tr.appendChild(makeCell(row.item_name));
                        tr.appendChild(makeCell(row.qty));
                        var tdAmount = makeCell(formatMoney(row.sum_price));
                        tdAmount.className = 'col-amount';
                        tr.appendChild(tdAmount);
                        itemTableBody.appendChild(tr);
                    });
                }

                itemModalTotal.textContent = formatMoney(data.total_amount);
                itemModalConfirm.disabled = false;
            })
            .catch(function (err) {
                itemTableBody.innerHTML = '<tr><td colspan="3">เกิดข้อผิดพลาด: ' + err.message + '</td></tr>';
            });
    }

    function doIssueSingleInvoice(vn) {
        itemModalConfirm.disabled = true;
        itemModalConfirm.textContent = 'กำลังดำเนินการ...';

        fetch('/api/issue_invoices_ipd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ an: [vn] })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.data) {
                    showResults(data.data);
                }
                if (!data.success) {
                    alert('เกิดข้อผิดพลาด: ' + data.message);
                }
                closeItemModal();
            })
            .catch(function (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            })
            .finally(function () {
                itemModalConfirm.disabled = false;
                itemModalConfirm.textContent = 'ยืนยันออกใบแจ้งหนี้';
            });
    }

    itemModalCancel.addEventListener('click', closeItemModal);
    itemModalConfirm.addEventListener('click', function () {
        if (currentItemVn) doIssueSingleInvoice(currentItemVn);
    });
    itemModal.addEventListener('click', function (e) {
        if (e.target === itemModal) closeItemModal();
    });

    // ---------- Cancel invoice modal (ยกเลิกใบแจ้งหนี้รายคน) ----------
    var currentCancelVn = null;

    function closeCancelModal() {
        cancelInvoiceModal.classList.remove('open');
        currentCancelVn = null;
    }

    function openCancelModal(vn, patientLabel) {
        currentCancelVn = vn;
        cancelModalPatientInfo.textContent = patientLabel;
        cancelItemTableBody.innerHTML = '<tr><td colspan="3">กำลังโหลด...</td></tr>';
        cancelModalTotal.textContent = '';
        cancelModalConfirm.disabled = true;
        cancelInvoiceModal.classList.add('open');

        fetch('/api/debt_info_ipd/' + encodeURIComponent(vn))
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    cancelItemTableBody.innerHTML = '<tr><td colspan="3">เกิดข้อผิดพลาด: ' + data.message + '</td></tr>';
                    return;
                }

                cancelItemTableBody.innerHTML = '';

                if (data.details.length === 0) {
                    cancelItemTableBody.innerHTML = '<tr><td colspan="3">ไม่พบรายการค่าใช้จ่าย</td></tr>';
                } else {
                    data.details.forEach(function (row) {
                        var tr = document.createElement('tr');
                        tr.appendChild(makeCell(row.income_name));

                        var tdPrice = makeCell(formatMoney(row.amount));
                        tdPrice.className = 'col-amount';
                        tr.appendChild(tdPrice);

                        var tdTotal = makeCell(formatMoney(row.total_amount));
                        tdTotal.className = 'col-amount';
                        tr.appendChild(tdTotal);

                        cancelItemTableBody.appendChild(tr);
                    });
                }

                cancelModalTotal.textContent = formatMoney(data.total_amount);
                cancelModalConfirm.disabled = false;
            })
            .catch(function (err) {
                cancelItemTableBody.innerHTML = '<tr><td colspan="3">เกิดข้อผิดพลาด: ' + err.message + '</td></tr>';
            });
    }

    function doCancelInvoice(vn) {
        cancelModalConfirm.disabled = true;
        cancelModalConfirm.textContent = 'กำลังดำเนินการ...';

        fetch('/api/cancel_invoice_ipd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ an: vn })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                closeCancelModal();

                if (!data.success) {
                    alert('เกิดข้อผิดพลาด: ' + data.message);
                    return;
                }

                showAlert('ยกเลิกใบแจ้งหนี้สำเร็จ', 'success');
                searchIssued(currentIssuedPage);
            })
            .catch(function (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            })
            .finally(function () {
                cancelModalConfirm.disabled = false;
                cancelModalConfirm.textContent = 'ยืนยันยกเลิกใบแจ้งหนี้';
            });
    }

    cancelModalCancel.addEventListener('click', closeCancelModal);
    cancelModalConfirm.addEventListener('click', function () {
        if (currentCancelVn) doCancelInvoice(currentCancelVn);
    });
    cancelInvoiceModal.addEventListener('click', function (e) {
        if (e.target === cancelInvoiceModal) closeCancelModal();
    });

    function getSavedArray(key) {
        try {
            var raw = localStorage.getItem(key);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr : [];
        } catch (e) {
            return [];
        }
    }

    // ---------- Multi-select dropdown ----------
    var openMultiselects = [];

    function closeAllMultiselects() {
        var toClose = openMultiselects.slice();
        toClose.forEach(function (m) { m.close(); });
    }

    document.addEventListener('click', function () {
        closeAllMultiselects();
    });

    function createMultiselect(rootId, toggleId, labelId, panelId, placeholder) {
        var root = document.getElementById(rootId);
        var toggle = document.getElementById(toggleId);
        var label = document.getElementById(labelId);
        var panel = document.getElementById(panelId);
        var card = root.closest('.card');
        var items = [];
        var changeHandlers = [];
        var self;

        function updateLabel() {
            var selected = items.filter(function (it) { return it.checkbox.checked; });
            if (selected.length === 0) {
                label.textContent = placeholder;
            } else if (selected.length === 1) {
                label.textContent = selected[0].text;
            } else if (selected.length === items.length) {
                label.textContent = 'เลือกทั้งหมด (' + selected.length + ' รายการ)';
            } else {
                label.textContent = 'เลือกแล้ว ' + selected.length + ' รายการ';
            }
        }

        function open() {
            closeAllMultiselects();
            root.classList.add('open');
            if (card) card.style.zIndex = '50';
            openMultiselects.push(self);
        }

        function close() {
            root.classList.remove('open');
            if (card) card.style.zIndex = '';
            var idx = openMultiselects.indexOf(self);
            if (idx !== -1) openMultiselects.splice(idx, 1);
        }

        function setMessage(text) {
            items = [];
            panel.innerHTML = '<div class="multiselect-empty">' + text + '</div>';
            label.textContent = text;
        }

        function setOptions(newItems, preferredValues) {
            items = [];
            panel.innerHTML = '';

            if (newItems.length === 0) {
                setMessage(placeholder);
                return;
            }

            newItems.forEach(function (item) {
                var optLabel = document.createElement('label');
                optLabel.className = 'multiselect-option';

                var cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.value = item.value;
                cb.checked = preferredValues
                    ? preferredValues.indexOf(item.value) !== -1
                    : true;
                cb.addEventListener('change', function () {
                    updateLabel();
                    changeHandlers.forEach(function (fn) { fn(); });
                });

                optLabel.appendChild(cb);
                optLabel.appendChild(document.createTextNode(item.text));
                panel.appendChild(optLabel);

                items.push({ value: item.value, text: item.text, checkbox: cb });
            });

            updateLabel();
        }

        function getSelected() {
            return items.filter(function (it) { return it.checkbox.checked; }).map(function (it) { return it.value; });
        }

        panel.addEventListener('click', function (e) {
            e.stopPropagation();
        });

        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            if (root.classList.contains('open')) {
                close();
            } else {
                open();
            }
        });

        label.textContent = placeholder;

        self = {
            setOptions: setOptions,
            setMessage: setMessage,
            getSelected: getSelected,
            close: close,
            onChange: function (fn) { changeHandlers.push(fn); }
        };

        return self;
    }

    var hipdataMultiselect = createMultiselect('hipdataMultiselect', 'hipdataToggle', 'hipdataLabel', 'hipdataPanel', '-- เลือกกลุ่มสิทธิ (ไม่เลือก = ทั้งหมด) --');
    var pttypeMultiselect = createMultiselect('pttypeMultiselect', 'pttypeToggle', 'pttypeLabel', 'pttypePanel', '-- เลือกสิทธิการรักษา (ไม่เลือก = ทั้งหมด) --');

    function rememberSelections() {
        localStorage.setItem(STORAGE_HIPDATA, JSON.stringify(hipdataMultiselect.getSelected()));
        localStorage.setItem(STORAGE_PTTYPE, JSON.stringify(pttypeMultiselect.getSelected()));
        showAlert('บันทึกค่าที่เลือกไว้เรียบร้อยแล้ว', 'success');
    }

    function loadPttypes(hipdataCodes, restorePreferred) {
        hipdataCodes = hipdataCodes || [];

        pttypeMultiselect.setMessage('กำลังโหลด...');

        var qs = hipdataCodes.map(function (c) { return 'hipdata_code=' + encodeURIComponent(c); }).join('&');

        fetch('/api/pttypes' + (qs ? '?' + qs : ''))
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    pttypeMultiselect.setMessage(data.message);
                    return;
                }

                if (data.data.length === 0) {
                    pttypeMultiselect.setMessage('ไม่พบสิทธิในกลุ่มที่เลือก');
                    return;
                }

                var items = data.data.map(function (row) {
                    return { value: row.pttype, text: row.name + '(' + row.hipdata_code + ')' };
                });

                if (!restorePreferred) {
                    // เปลี่ยนกลุ่มสิทธิ (ติ๊กเข้า/ออก) ระหว่างใช้งาน - เคลียร์สิทธิการรักษาที่เลือกไว้ทั้งหมด
                    pttypeMultiselect.setOptions(items, []);
                    return;
                }

                var saved = getSavedArray(STORAGE_PTTYPE);
                var availableValues = items.map(function (i) { return i.value; });
                var preferred = saved.filter(function (v) { return availableValues.indexOf(v) !== -1; });

                pttypeMultiselect.setOptions(items, preferred.length > 0 ? preferred : null);
            })
            .catch(function (err) {
                pttypeMultiselect.setMessage('เกิดข้อผิดพลาด: ' + err.message);
            });
    }

    function formatMoney(value) {
        var num = parseFloat(value) || 0;
        return num.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function makeCell(text) {
        var td = document.createElement('td');
        td.textContent = text;
        return td;
    }

    function formatVisitDateTime(vstdate, vsttime) {
        var datePart = vstdate || '';
        var timePart = vsttime ? String(vsttime).slice(0, 8) : '';
        return timePart ? (datePart + ' ' + timePart) : datePart;
    }

    // debt_date_time มาจาก timestamp ของ PostgreSQL (ไม่มี timezone) - ตัดเฉพาะส่วนวันที่/เวลาตรงๆ ไม่ผ่าน Date object เพื่อกัน timezone เพี้ยน
    function formatDebtDateTime(value) {
        if (!value) return '';
        var m = String(value).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
        return m ? (m[1] + ' ' + m[2]) : String(value);
    }

    function updateCheckAllState() {
        var boxes = Array.prototype.slice.call(patientTableBody.querySelectorAll('.row-check'));
        checkAll.checked = boxes.length > 0 && boxes.every(function (cb) { return cb.checked; });
    }

    // ปรับ checkbox ของหน้าปัจจุบันให้ตรงกับสถานะใน selectedVns (ใช้หลังเลือก/ไม่เลือกทั้งหมดข้ามหน้า)
    function syncCheckboxesWithSelection() {
        Array.prototype.slice.call(patientTableBody.querySelectorAll('.row-check')).forEach(function (cb) {
            if (selectedVns[cb.value]) cb.checked = selectedVns[cb.value].checked;
        });
        updateCheckAllState();
    }

    // ตั้งค่าเลือก/ไม่เลือกทั้งหมด สำหรับผู้ป่วยทุกรายที่ตรงเงื่อนไข (ทุกหน้า ไม่ใช่แค่หน้าปัจจุบัน)
    function setAllSelection(checked) {
        var pttypes = pttypeMultiselect.getSelected();

        fetch('/api/patients_ipd_vns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pttype: pttypes,
                hn: hnFilter.value.trim(),
                date_start: dateStart.value,
                date_end: dateEnd.value
            })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    alert('เกิดข้อผิดพลาด: ' + data.message);
                    return;
                }

                data.data.forEach(function (row) {
                    selectedVns[row.an] = { amount: parseFloat(row.debt_amount) || 0, checked: checked };
                });

                syncCheckboxesWithSelection();
            })
            .catch(function (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            });
    }

    function renderPatients(rows, totalCount, totalAmount, page, pageSize) {
        patientTableBody.innerHTML = '';

        if (rows.length === 0) {
            patientSummary.textContent = 'ไม่พบรายการค้างชำระตามเงื่อนไขที่เลือก';
            checkAll.checked = true;
            return;
        }

        var startIndex = (page - 1) * pageSize;

        rows.forEach(function (row, index) {
            var tr = document.createElement('tr');

            tr.appendChild(makeCell(startIndex + index + 1));

            var tdCheck = document.createElement('td');
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.className = 'row-check';
            cb.value = row.an;

            if (!selectedVns[row.an]) {
                selectedVns[row.an] = { amount: parseFloat(row.debt_amount) || 0, checked: true };
            } else {
                selectedVns[row.an].amount = parseFloat(row.debt_amount) || 0;
            }
            cb.checked = selectedVns[row.an].checked;

            cb.addEventListener('change', function () {
                selectedVns[cb.value].checked = cb.checked;
                updateCheckAllState();
            });

            tdCheck.appendChild(cb);

            tr.appendChild(tdCheck);
            tr.appendChild(makeCell(row.an));
            tr.appendChild(makeCell(row.hn));
            tr.appendChild(makeCell(row.patient_name));
            tr.appendChild(makeCell(formatVisitDateTime(row.dchdate, row.dchtime)));
            tr.appendChild(makeCell((row.pttype_name || row.pttype)));

            var tdAmount = makeCell(formatMoney(row.debt_amount));
            tdAmount.className = 'col-amount';
            tr.appendChild(tdAmount);

            var tdAction = document.createElement('td');
            var btnIssueOne = document.createElement('button');
            btnIssueOne.type = 'button';
            btnIssueOne.className = 'btn btn-warning btn-sm';
            btnIssueOne.textContent = 'ออกใบแจ้งหนี้';
            btnIssueOne.addEventListener('click', function () {
                openItemModal(row.an, 'HN: ' + row.hn + '  ชื่อ: ' + row.patient_name + '  AN: ' + row.an);
            });
            tdAction.appendChild(btnIssueOne);
            tr.appendChild(tdAction);

            patientTableBody.appendChild(tr);
        });

        updateCheckAllState();
        patientSummary.textContent = 'พบทั้งหมด ' + totalCount + ' รายการ ยอดรวม ' + formatMoney(totalAmount) + ' บาท';
    }

    function updatePagination(page, pages) {
        currentPage = page;
        totalPages = pages;
        pageIndicator.textContent = 'หน้า ' + page + ' / ' + pages;
        btnPrevPage.disabled = page <= 1;
        btnNextPage.disabled = page >= pages;
    }

    function searchPatients(page, resetSelection) {
        var pttypes = pttypeMultiselect.getSelected();

        if (resetSelection) selectedVns = {};

        setPatientListCollapsed(false); // ค้นหาใหม่แล้วขยายกลับมาให้เห็นผลลัพธ์เสมอ
        patientSummary.textContent = 'กำลังค้นหา...';
        patientTableBody.innerHTML = '';
        resultSection.style.display = 'none';

        fetch('/api/patients_ipd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pttype: pttypes,
                hn: hnFilter.value.trim(),
                date_start: dateStart.value,
                date_end: dateEnd.value,
                page: page || 1,
                page_size: parseInt(pageSizeSelect.value, 10)
            })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    patientSummary.textContent = 'เกิดข้อผิดพลาด: ' + data.message;
                    updatePagination(1, 1);
                    return;
                }
                renderPatients(data.data, data.total_count, data.total_amount, data.page, data.page_size);
                updatePagination(data.page, data.total_pages);
            })
            .catch(function (err) {
                patientSummary.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
            });
    }

    function renderIssued(rows, totalCount, totalAmount, page, pageSize) {
        issuedTableBody.innerHTML = '';

        if (rows.length === 0) {
            issuedSummary.textContent = 'ไม่พบรายการที่ออกใบแจ้งหนี้แล้วตามเงื่อนไขที่เลือก';
            return;
        }

        var startIndex = (page - 1) * pageSize;

        rows.forEach(function (row, index) {
            var tr = document.createElement('tr');

            tr.appendChild(makeCell(startIndex + index + 1));

            var tdCheck = document.createElement('td');
            var cbSel = document.createElement('input');
            cbSel.type = 'checkbox';
            cbSel.className = 'issued-row-check';
            cbSel.value = row.an;
            cbSel.checked = !!selectedIssuedVns[row.an];
            cbSel.addEventListener('change', function () {
                if (cbSel.checked) {
                    selectedIssuedVns[cbSel.value] = true;
                } else {
                    delete selectedIssuedVns[cbSel.value];
                }
                updateCheckAllIssuedState();
            });
            tdCheck.appendChild(cbSel);
            tr.appendChild(tdCheck);

            var tdAction = document.createElement('td');
            var btnCancelOne = document.createElement('button');
            btnCancelOne.type = 'button';
            btnCancelOne.className = 'btn btn-danger btn-sm';
            btnCancelOne.textContent = 'ยกเลิกใบแจ้งหนี้';
            btnCancelOne.addEventListener('click', function () {
                openCancelModal(row.an, 'HN: ' + row.hn + '  ชื่อ: ' + row.patient_name + '  AN: ' + row.an + '  เลขที่ใบแจ้งหนี้: ' + row.debt_id);
            });
            tdAction.appendChild(btnCancelOne);
            tr.appendChild(tdAction);

            tr.appendChild(makeCell(row.an));
            tr.appendChild(makeCell(row.hn));
            tr.appendChild(makeCell(row.patient_name));
            tr.appendChild(makeCell(formatVisitDateTime(row.dchdate, row.dchtime)));
            tr.appendChild(makeCell(row.pttype_name || row.pttype));

            var tdAmount = makeCell(formatMoney(row.debt_amount));
            tdAmount.className = 'col-amount';
            tr.appendChild(tdAmount);

            tr.appendChild(makeCell(row.finance_number));
            tr.appendChild(makeCell(row.debt_id));

            var tdStaff = makeCell(row.staff);
            tdStaff.className = 'col-narrow';
            tr.appendChild(tdStaff);

            tr.appendChild(makeCell(formatDebtDateTime(row.debt_date_time)));

            issuedTableBody.appendChild(tr);
        });

        issuedSummary.textContent = 'พบทั้งหมด ' + totalCount + ' รายการ ยอดรวม ' + formatMoney(totalAmount) + ' บาท';
        updateCheckAllIssuedState();
    }

    function updateCheckAllIssuedState() {
        var boxes = Array.prototype.slice.call(issuedTableBody.querySelectorAll('.issued-row-check'));
        checkAllIssued.checked = boxes.length > 0 && boxes.every(function (cb) { return cb.checked; });
    }

    function doCancelSelectedIssued(vns) {
        btnCancelSelectedIssued.disabled = true;
        btnCancelSelectedIssued.textContent = 'กำลังดำเนินการ...';

        fetch('/api/cancel_invoices_ipd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ an: vns })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    alert('เกิดข้อผิดพลาด: ' + data.message);
                    return;
                }

                // ยกเลิกสำเร็จ - ล้างสถานะที่เลือกไว้ของ VN เหล่านี้ทิ้ง (ครอบคลุมทุกหน้า ไม่ใช่แค่หน้าปัจจุบัน)
                vns.forEach(function (vn) { delete selectedIssuedVns[vn]; });
                showAlert(data.message, 'success');
                searchIssued(currentIssuedPage);
            })
            .catch(function (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            })
            .finally(function () {
                btnCancelSelectedIssued.disabled = false;
                btnCancelSelectedIssued.textContent = 'ยกเลิกใบแจ้งหนี้รายการที่เลือก';
            });
    }

    // ยกเลิกตาม VN ที่ถูกติ๊กไว้ใน selectedIssuedVns ซึ่งจำสถานะข้ามหน้าไว้ (ไม่ใช่แค่ checkbox ที่เห็นในหน้าปัจจุบัน)
    function cancelSelectedIssued() {
        var vns = Object.keys(selectedIssuedVns);

        if (vns.length === 0) {
            alert('กรุณาเลือกรายการอย่างน้อย 1 รายการ');
            return;
        }

        showConfirm(
            'ยืนยันการยกเลิกใบแจ้งหนี้ ' + vns.length + ' รายการ ใช่หรือไม่?',
            function () { doCancelSelectedIssued(vns); }
        );
    }

    function updateIssuedPagination(page, pages) {
        currentIssuedPage = page;
        totalIssuedPages = pages;
        issuedPageIndicator.textContent = 'หน้า ' + page + ' / ' + pages;
        btnIssuedPrevPage.disabled = page <= 1;
        btnIssuedNextPage.disabled = page >= pages;
    }

    function searchIssued(page) {
        var pttypes = pttypeMultiselect.getSelected();

        issuedSummary.textContent = 'กำลังค้นหา...';
        issuedTableBody.innerHTML = '';

        var url = issuedSource === 'hosxp' ? '/api/patients_ipd_issued_hosxp' : '/api/patients_ipd_issued';

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pttype: pttypes,
                hn: hnFilter.value.trim(),
                debt_hn: issuedHnFilter.value.trim(),
                date_start: dateStart.value,
                date_end: dateEnd.value,
                page: page || 1,
                page_size: parseInt(issuedPageSizeSelect.value, 10)
            })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    issuedSummary.textContent = 'เกิดข้อผิดพลาด: ' + data.message;
                    updateIssuedPagination(1, 1);
                    return;
                }
                renderIssued(data.data, data.total_count, data.total_amount, data.page, data.page_size);
                updateIssuedPagination(data.page, data.total_pages);
            })
            .catch(function (err) {
                issuedSummary.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
            });
    }

    function issueInvoices() {
        var vns = Object.keys(selectedVns).filter(function (vn) { return selectedVns[vn].checked; });

        if (vns.length === 0) {
            alert('กรุณาเลือกผู้ป่วยอย่างน้อย 1 คน');
            return;
        }

        var total = vns.reduce(function (sum, vn) { return sum + selectedVns[vn].amount; }, 0);

        showConfirm(
            'ยืนยันการออกใบแจ้งหนี้สำหรับผู้ป่วย ' + vns.length + ' ราย ยอดรวม ' + formatMoney(total) + ' บาท ใช่หรือไม่?',
            function () { doIssueInvoices(vns); }
        );
    }

    function doIssueInvoices(vns) {
        btnIssue.disabled = true;
        btnIssue.textContent = 'กำลังดำเนินการ...';

        fetch('/api/issue_invoices_ipd', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ an: vns })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.data) {
                    showResults(data.data);
                }
                if (!data.success) {
                    alert('เกิดข้อผิดพลาด: ' + data.message);
                }
            })
            .catch(function (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
            })
            .finally(function () {
                btnIssue.disabled = false;
                btnIssue.textContent = 'ออกใบแจ้งหนี้ทั้งหมดที่เลือก';
            });
    }

    function showResults(results) {
        resultTableBody.innerHTML = '';
        resultSection.style.display = '';

        var successVns = {};

        results.forEach(function (r, index) {
            if (r.success) {
                successVns[r.an] = true;
                delete selectedVns[r.an];
            }

            var tr = document.createElement('tr');

            tr.appendChild(makeCell(index + 1));

            var tdStatus = document.createElement('td');
            tdStatus.textContent = r.success ? 'สำเร็จ' : 'ไม่สำเร็จ';
            tdStatus.className = r.success ? 'status-success' : 'status-error';
            tr.appendChild(tdStatus);

            tr.appendChild(makeCell(r.finance_number || ''));
            tr.appendChild(makeCell(r.debt_id || ''));
            tr.appendChild(makeCell(r.an));
            tr.appendChild(makeCell(r.hn));
            tr.appendChild(makeCell(r.patient_name));
            tr.appendChild(makeCell(formatVisitDateTime(r.dchdate, r.dchtime)));
            tr.appendChild(makeCell(r.pttype_name || r.pttype));

            var tdAmount = makeCell(formatMoney(r.debt_amount));
            tdAmount.className = 'col-amount';
            tr.appendChild(tdAmount);

            tr.appendChild(makeCell(r.message));

            resultTableBody.appendChild(tr);
        });

        // ลบรายการที่ออกใบแจ้งหนี้สำเร็จออกจากตารางผู้ป่วย
        Array.prototype.slice.call(patientTableBody.querySelectorAll('tr')).forEach(function (tr) {
            var cb = tr.querySelector('.row-check');
            if (cb && successVns[cb.value]) {
                tr.remove();
            }
        });
    }

    function loadHipdataCodes(callback) {
        fetch('/api/hipdata_codes')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    showAlert('โหลดข้อมูลกลุ่มสิทธิไม่สำเร็จ: ' + data.message, 'error');
                    return;
                }

                var items = data.data.map(function (row) {
                    return { value: row.hipdata_code, text: row.hipdata_code };
                });

                var saved = getSavedArray(STORAGE_HIPDATA);
                var availableValues = items.map(function (i) { return i.value; });
                var preferred = saved.filter(function (v) { return availableValues.indexOf(v) !== -1; });

                hipdataMultiselect.setOptions(items, preferred);

                if (typeof callback === 'function') callback();
            })
            .catch(function (err) {
                showAlert('เกิดข้อผิดพลาด: ' + err.message, 'error');
            });
    }

    btnLogout.addEventListener('click', function (e) {
        e.preventDefault();
        fetch('/api/logout', { method: 'POST' })
            .then(function () {
                window.location.href = 'login.html';
            });
    });

    hipdataMultiselect.onChange(function () {
        loadPttypes(hipdataMultiselect.getSelected(), false);
    });

    checkAll.addEventListener('change', function () {
        Array.prototype.slice.call(patientTableBody.querySelectorAll('.row-check')).forEach(function (cb) {
            cb.checked = checkAll.checked;
            selectedVns[cb.value].checked = checkAll.checked;
        });
    });

    btnSearch.addEventListener('click', function () { searchPatients(1, true); });
    btnRemember.addEventListener('click', rememberSelections);
    btnIssue.addEventListener('click', issueInvoices);
    btnSelectAll.addEventListener('click', function () { setAllSelection(true); });
    btnDeselectAll.addEventListener('click', function () { setAllSelection(false); });

    // ย่อ/ขยายส่วน "รายการผู้ป่วย" ด้วยตนเอง หรือถูกย่ออัตโนมัติเมื่อเปิดดูรายชื่อที่ออกใบแจ้งหนี้แล้ว
    // ตอนย่อ ซ่อนทั้งเฟรมไปเลย เหลือแค่ปุ่มลูกศรลงเล็กๆ ไว้กดขยายกลับ
    function setPatientListCollapsed(collapsed) {
        patientListCard.style.display = collapsed ? 'none' : '';
        btnExpandPatientList.style.display = collapsed ? '' : 'none';
    }

    btnTogglePatientList.addEventListener('click', function () {
        setPatientListCollapsed(true);
    });

    btnExpandPatientList.addEventListener('click', function () {
        setPatientListCollapsed(false);
    });

    // กดปุ่มนี้แล้ว refresh รายชื่อทันทีทุกครั้ง (ไม่ toggle ปิด) เพื่อให้เห็นรายการล่าสุดหลังออกใบแจ้งหนี้
    function toggleIssuedSection(source, title) {
        issuedSource = source;
        issuedSectionTitle.textContent = title;
        issuedSection.style.display = '';
        resultSection.style.display = 'none'; // ซ่อนผลการออกใบแจ้งหนี้ของรอบก่อนหน้า ไม่ให้ค้างแสดงปนกับรายชื่อที่ออกแล้ว
        setPatientListCollapsed(true); // ย่อส่วนรายการผู้ป่วยลงก่อน ผู้ใช้กดขยายกลับออกมาดูได้
        selectedIssuedVns = {}; // เริ่มค้นหาใหม่ ล้างรายการที่เคยติ๊กไว้ (การติ๊กจะคงอยู่แค่ในช่วงดูผลค้นหาเดียวกัน ข้ามหน้าได้)
        searchIssued(1);
    }

    btnCheckIssued.addEventListener('click', function () {
        toggleIssuedSection('app', 'รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้แล้ว (ออกด้วยระบบนี้)');
    });

    btnCheckIssuedHosxp.addEventListener('click', function () {
        toggleIssuedSection('hosxp', 'รายชื่อผู้ป่วยที่ออกใบแจ้งหนี้แล้ว (ออกจากโปรแกรม HOSxP)');
    });

    // ค้นหา HN เฉพาะในส่วนรายชื่อที่ออกใบแจ้งหนี้แล้ว (ค้นหาจาก rcpt_debt.hn แยกจากช่อง HN ในตัวกรองค้นหาหลัก)
    btnIssuedHnSearch.addEventListener('click', function () { searchIssued(1); });
    issuedHnFilter.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') searchIssued(1);
    });

    // ติ๊ก "เลือกทั้งหมด" ให้เลือกทุก VN ที่ตรงเงื่อนไขจริง (ทุกหน้า ไม่ใช่แค่หน้าที่กำลังแสดง)
    function setAllIssuedSelection(checked) {
        if (!checked) {
            selectedIssuedVns = {};
            Array.prototype.slice.call(issuedTableBody.querySelectorAll('.issued-row-check')).forEach(function (cb) {
                cb.checked = false;
            });
            return;
        }

        var pttypes = pttypeMultiselect.getSelected();
        checkAllIssued.disabled = true;

        var url = issuedSource === 'hosxp' ? '/api/patients_ipd_issued_hosxp_vns' : '/api/patients_ipd_issued_vns';

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                pttype: pttypes,
                hn: hnFilter.value.trim(),
                debt_hn: issuedHnFilter.value.trim(),
                date_start: dateStart.value,
                date_end: dateEnd.value
            })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    alert('เกิดข้อผิดพลาด: ' + data.message);
                    checkAllIssued.checked = false;
                    return;
                }

                data.data.forEach(function (row) { selectedIssuedVns[row.an] = true; });
                Array.prototype.slice.call(issuedTableBody.querySelectorAll('.issued-row-check')).forEach(function (cb) {
                    cb.checked = true;
                });
            })
            .catch(function (err) {
                alert('เกิดข้อผิดพลาด: ' + err.message);
                checkAllIssued.checked = false;
            })
            .finally(function () {
                checkAllIssued.disabled = false;
            });
    }

    checkAllIssued.addEventListener('change', function () {
        setAllIssuedSelection(checkAllIssued.checked);
    });

    btnCancelSelectedIssued.addEventListener('click', cancelSelectedIssued);

    issuedPageSizeSelect.addEventListener('change', function () { searchIssued(1); });
    btnIssuedPrevPage.addEventListener('click', function () {
        if (currentIssuedPage > 1) searchIssued(currentIssuedPage - 1);
    });
    btnIssuedNextPage.addEventListener('click', function () {
        if (currentIssuedPage < totalIssuedPages) searchIssued(currentIssuedPage + 1);
    });

    pageSizeSelect.addEventListener('change', function () { searchPatients(1); });
    btnPrevPage.addEventListener('click', function () {
        if (currentPage > 1) searchPatients(currentPage - 1);
    });
    btnNextPage.addEventListener('click', function () {
        if (currentPage < totalPages) searchPatients(currentPage + 1);
    });

    // ---------- Init ----------
    fetch('/api/session')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.loggedIn) {
                window.location.href = 'login.html';
                return;
            }

            officerName.textContent = data.officer.officer_name + ' (' + data.officer.officer_login_name + ')';
            departmentBadge.textContent = data.officer.department || '-';

            dateStart.value = todayStr();
            dateEnd.value = todayStr();
            updatePagination(1, 1);
            updateIssuedPagination(1, 1);

            loadHipdataCodes(function () {
                loadPttypes(hipdataMultiselect.getSelected(), true);
            });
        })
        .catch(function () {
            window.location.href = 'login.html';
        });
})();
