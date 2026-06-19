const express = require('express');
const router = express.Router();
const db = require('../db');
const { verifyPassword } = require('../auth');

router.get('/session', (req, res) => {
    const officer = (req.session && req.session.officer) || null;
    res.json({ success: true, loggedIn: !!officer, officer });
});

router.get('/departments', async (req, res) => {
    if (!db.hasConfig()) {
        res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' });
        return;
    }

    try {
        const sql = db.getType() === 'pgsql'
            ? "SELECT depcode AS department, department AS name FROM kskdepartment WHERE depcode_active = 'Y' ORDER BY department"
            : "SELECT department, name FROM kskdepartment.department WHERE depcode_active = 'Y' ORDER BY name";

        const rows = await db.query(sql);
        res.json({ success: true, data: rows });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/login', async (req, res) => {
    if (!db.hasConfig()) {
        res.json({ success: false, message: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล' });
        return;
    }

    const body = req.body || {};
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const department = String(body.department || '');

    if (!username || !password) {
        res.json({ success: false, message: 'กรุณากรอกชื่อผู้ใช้และรหัสผ่าน' });
        return;
    }

    try {
        const rows = await db.query(
            'SELECT officer_id, officer_login_name, officer_name, officer_login_password_md5 FROM officer WHERE officer_login_name = :username',
            { username }
        );

        const officer = rows[0];

        if (!officer || !verifyPassword(password, officer.officer_login_password_md5)) {
            res.json({ success: false, message: 'ชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง' });
            return;
        }

        req.session.officer = {
            officer_id: officer.officer_id,
            officer_login_name: officer.officer_login_name,
            officer_name: officer.officer_name,
            department: department,
        };

        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: e.message });
    }
});

router.post('/logout', (req, res) => {
    if (!req.session) {
        res.json({ success: true });
        return;
    }
    req.session.destroy(() => {
        res.json({ success: true });
    });
});

module.exports = router;
