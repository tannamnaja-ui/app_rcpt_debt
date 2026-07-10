const express = require('express');
const router = express.Router();
const db = require('../db');

function buildConfigFromBody(body) {
    return {
        db_type: body.db_type === 'pgsql' ? 'pgsql' : 'mysql',
        host: String(body.host || '').trim(),
        port: String(body.port || '').trim(),
        database: String(body.database || '').trim(),
        username: String(body.username || '').trim(),
        password: String(body.password || ''),
    };
}

router.get('/config', (req, res) => {
    const config = db.getConfig() || {
        db_type: 'mysql',
        host: '',
        port: '3306',
        database: '',
        username: '',
        password: '',
    };

    res.json({ success: true, data: config });
});

router.get('/config/status', (req, res) => {
    res.json({ success: true, hasConfig: db.hasConfig() });
});

router.post('/config', (req, res) => {
    const config = buildConfigFromBody(req.body || {});

    if (!config.host || !config.port || !config.database || !config.username) {
        res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
        return;
    }

    try {
        db.saveConfig(config);
        res.json({ success: true });
    } catch (e) {
        res.json({ success: false, message: 'บันทึกการตั้งค่าไม่สำเร็จ: ' + e.message });
    }
});

router.post('/test_connection', async (req, res) => {
    const config = buildConfigFromBody(req.body || {});

    if (!config.host || !config.port || !config.database || !config.username) {
        res.json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
        return;
    }

    try {
        await db.testConnection(config);
        res.json({ success: true, message: 'เชื่อมต่อฐานข้อมูลสำเร็จ' });
    } catch (e) {
        res.json({ success: false, message: 'เชื่อมต่อไม่สำเร็จ: ' + e.message });
    }
});

module.exports = router;
