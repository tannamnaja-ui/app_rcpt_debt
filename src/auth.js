const crypto = require('crypto');

/**
 * ตรวจสอบรหัสผ่านกับ officer.officer_login_password_md5 ของ HOSxP
 * (เก็บค่าเป็น md5(plain_password))
 */
function verifyPassword(plainPassword, storedHash) {
    if (!storedHash) {
        return false;
    }
    const hash = crypto.createHash('md5').update(plainPassword, 'utf8').digest('hex');
    return hash.toLowerCase() === String(storedHash).toLowerCase();
}

function requireLogin(req, res, next) {
    if (!req.session || !req.session.officer) {
        res.status(401).json({ success: false, message: 'กรุณาเข้าสู่ระบบ' });
        return;
    }
    next();
}

module.exports = { verifyPassword, requireLogin };
