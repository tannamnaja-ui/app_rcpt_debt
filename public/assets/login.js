(function () {
    var STORAGE_KEY = 'rcpt_debt_department';
    var alertBox = document.getElementById('alertBox');
    var form = document.getElementById('loginForm');
    var departmentSelect = document.getElementById('department');
    var btnLogin = document.getElementById('btnLogin');

    function showAlert(message, type) {
        alertBox.innerHTML = '<div class="alert alert-' + type + '">' + message + '</div>';
    }

    function disableForm() {
        Array.prototype.slice.call(form.querySelectorAll('input, select, button[type="submit"]')).forEach(function (el) {
            el.disabled = true;
        });
    }

    function loadDepartments() {
        fetch('/api/departments')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    showAlert('โหลดรายการห้องทำงานไม่สำเร็จ: ' + data.message, 'error');
                    return;
                }

                data.data.forEach(function (row) {
                    var option = document.createElement('option');
                    option.value = row.department;
                    option.textContent = row.name;
                    departmentSelect.appendChild(option);
                });

                var saved = localStorage.getItem(STORAGE_KEY);
                if (saved && departmentSelect.querySelector('option[value="' + saved + '"]')) {
                    departmentSelect.value = saved;
                }
            })
            .catch(function (err) {
                showAlert('เกิดข้อผิดพลาด: ' + err.message, 'error');
            });
    }

    function init() {
        var params = new URLSearchParams(window.location.search);
        if (params.get('saved') === '1') {
            showAlert('บันทึกข้อมูลการเชื่อมต่อเรียบร้อยแล้ว', 'success');
        }

        fetch('/api/config/status')
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.hasConfig) {
                    showAlert('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล กรุณากดปุ่ม "ตั้งค่าการเชื่อมต่อ"', 'warning');
                    disableForm();
                    return;
                }
                loadDepartments();
            });
    }

    form.addEventListener('submit', function (e) {
        e.preventDefault();

        btnLogin.disabled = true;
        btnLogin.textContent = 'กำลังเข้าสู่ระบบ...';

        fetch('/api/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username: document.getElementById('username').value,
                password: document.getElementById('password').value,
                department: departmentSelect.value
            })
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (!data.success) {
                    showAlert(data.message, 'error');
                    return;
                }
                localStorage.setItem(STORAGE_KEY, departmentSelect.value);
                window.location.href = 'index_first.html';
            })
            .catch(function (err) {
                showAlert('เกิดข้อผิดพลาด: ' + err.message, 'error');
            })
            .finally(function () {
                btnLogin.disabled = false;
                btnLogin.textContent = 'เข้าสู่ระบบ';
            });
    });

    // ตรวจสอบว่า login ค้างอยู่แล้วหรือไม่ ก่อนแสดงฟอร์ม
    fetch('/api/session')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (data.loggedIn) {
                window.location.href = 'index_first.html';
                return;
            }
            init();
        })
        .catch(init);
})();
