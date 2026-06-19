(function () {
    var form = document.getElementById('settingsForm');
    var portInput = document.getElementById('port');
    var resultBox = document.getElementById('testResult');
    var btnTest = document.getElementById('btnTest');
    var dbTypeRadios = document.querySelectorAll('input[name="db_type"]');

    var DEFAULT_PORTS = { mysql: '3306', pgsql: '5432' };

    function getDbType() {
        var checked = document.querySelector('input[name="db_type"]:checked');
        return checked ? checked.value : 'mysql';
    }

    function getPayload() {
        return {
            db_type: getDbType(),
            host: document.getElementById('host').value.trim(),
            port: portInput.value.trim(),
            database: document.getElementById('database').value.trim(),
            username: document.getElementById('username').value.trim(),
            password: document.getElementById('password').value
        };
    }

    dbTypeRadios.forEach(function (radio) {
        radio.addEventListener('change', function () {
            if (!radio.checked) return;
            var current = portInput.value.trim();
            if (current === '' || current === DEFAULT_PORTS.mysql || current === DEFAULT_PORTS.pgsql) {
                portInput.value = DEFAULT_PORTS[radio.value] || '';
            }
        });
    });

    // โหลดค่าการเชื่อมต่อที่บันทึกไว้
    fetch('/api/config')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            var config = data.data || {};
            document.getElementById('host').value = config.host || '';
            document.getElementById('port').value = config.port || '3306';
            document.getElementById('database').value = config.database || '';
            document.getElementById('username').value = config.username || '';
            document.getElementById('password').value = config.password || '';

            var dbType = config.db_type || 'mysql';
            var radio = document.querySelector('input[name="db_type"][value="' + dbType + '"]');
            if (radio) radio.checked = true;
        });

    btnTest.addEventListener('click', function () {
        resultBox.textContent = 'กำลังทดสอบการเชื่อมต่อ...';
        resultBox.className = 'test-result hint';
        btnTest.disabled = true;

        fetch('/api/test_connection', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getPayload())
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                resultBox.textContent = data.message;
                resultBox.className = 'test-result ' + (data.success ? 'alert alert-success' : 'alert alert-error');
            })
            .catch(function (err) {
                resultBox.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
                resultBox.className = 'test-result alert alert-error';
            })
            .finally(function () {
                btnTest.disabled = false;
            });
    });

    form.addEventListener('submit', function (e) {
        e.preventDefault();

        fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(getPayload())
        })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.success) {
                    window.location.href = 'login.html?saved=1';
                    return;
                }
                resultBox.textContent = data.message;
                resultBox.className = 'test-result alert alert-error';
            })
            .catch(function (err) {
                resultBox.textContent = 'เกิดข้อผิดพลาด: ' + err.message;
                resultBox.className = 'test-result alert alert-error';
            });
    });
})();
