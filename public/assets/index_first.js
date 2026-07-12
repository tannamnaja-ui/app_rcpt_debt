(function () {
    var officerName = document.getElementById('officerName');
    var departmentBadge = document.getElementById('departmentBadge');
    var btnLogout = document.getElementById('btnLogout');
    var cardOpd = document.getElementById('cardOpd');
    var cardIpd = document.getElementById('cardIpd');

    cardOpd.addEventListener('click', function () {
        window.location.href = 'dashboard.html';
    });

    cardIpd.addEventListener('click', function () {
        window.location.href = 'dashboard_ipd.html';
    });

    btnLogout.addEventListener('click', function (e) {
        e.preventDefault();
        fetch('/api/logout', { method: 'POST' })
            .then(function () {
                window.location.href = 'login.html';
            });
    });

    fetch('/api/session')
        .then(function (res) { return res.json(); })
        .then(function (data) {
            if (!data.loggedIn) {
                window.location.href = 'login.html';
                return;
            }

            officerName.textContent = data.officer.officer_name + ' (' + data.officer.officer_login_name + ')';
            departmentBadge.textContent = data.officer.department || '-';
        })
        .catch(function () {
            window.location.href = 'login.html';
        });
})();
