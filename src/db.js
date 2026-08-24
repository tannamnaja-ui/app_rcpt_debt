const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { Pool: PgPool, Client: PgClient } = require('pg');

const CONFIG_FILE = path.join(__dirname, '..', 'config', 'db_config.json');

let mysqlPool = null;
let pgPool = null;

function getConfig() {
    if (!fs.existsSync(CONFIG_FILE)) {
        return null;
    }
    try {
        const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return (config && typeof config === 'object') ? config : null;
    } catch (e) {
        return null;
    }
}

function saveConfig(config) {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');

    // เคลียร์ pool เดิม เพื่อให้เชื่อมต่อใหม่ตามค่าที่บันทึก
    if (mysqlPool) {
        mysqlPool.end().catch(function () {});
        mysqlPool = null;
    }
    if (pgPool) {
        pgPool.end().catch(function () {});
        pgPool = null;
    }
}

function hasConfig() {
    return getConfig() !== null;
}

function getType() {
    const config = getConfig();
    return (config && config.db_type) || 'mysql';
}

// แปลง :name placeholder ในรูปแบบ PDO ให้เป็น placeholder ของแต่ละไดรเวอร์
// (?<!:) กันไม่ให้จับ :: ของ PostgreSQL type cast เช่น col::text ผิดเป็น named parameter
const PARAM_REGEX = /(?<!:):(\w+)/g;

function toMysqlParams(sql, params) {
    const values = [];
    const text = sql.replace(PARAM_REGEX, function (match, name) {
        values.push(params[name]);
        return '?';
    });
    return { text, values };
}

function toPgParams(sql, params) {
    const values = [];
    const indexMap = {};
    const text = sql.replace(PARAM_REGEX, function (match, name) {
        if (!(name in indexMap)) {
            values.push(params[name]);
            indexMap[name] = values.length;
        }
        return '$' + indexMap[name];
    });
    return { text, values };
}

async function testConnection(config) {
    if (config.db_type === 'pgsql') {
        const client = new PgClient({
            host: config.host,
            port: Number(config.port),
            database: config.database,
            user: config.username,
            password: config.password,
        });
        await client.connect();
        try {
            await client.query('SELECT 1');
        } finally {
            await client.end();
        }
    } else {
        const conn = await mysql.createConnection({
            host: config.host,
            port: Number(config.port),
            database: config.database,
            user: config.username,
            password: config.password,
        });
        try {
            await conn.query('SELECT 1');
        } finally {
            await conn.end();
        }
    }
}

function getMysqlPool() {
    if (!mysqlPool) {
        const config = getConfig();
        mysqlPool = mysql.createPool({
            host: config.host,
            port: Number(config.port),
            database: config.database,
            user: config.username,
            password: config.password,
            charset: 'utf8mb4_general_ci',
            waitForConnections: true,
            connectionLimit: 10,
        });
    }
    return mysqlPool;
}

function getPgPool() {
    if (!pgPool) {
        const config = getConfig();
        pgPool = new PgPool({
            host: config.host,
            port: Number(config.port),
            database: config.database,
            user: config.username,
            password: config.password,
        });
    }
    return pgPool;
}

// รัน query แบบเดี่ยว (ไม่ต้องการ transaction) คืนค่าเป็น array ของแถว
async function query(sql, params) {
    params = params || {};
    const config = getConfig();
    if (!config) {
        throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
    }

    if (config.db_type === 'pgsql') {
        const { text, values } = toPgParams(sql, params);
        const result = await getPgPool().query(text, values);
        return result.rows;
    }

    const { text, values } = toMysqlParams(sql, params);
    const [rows] = await getMysqlPool().query(text, values);
    return rows;
}

// ขอ connection แยกสำหรับงานที่ต้องใช้ transaction (ออกใบแจ้งหนี้ทีละ VN)
async function getConnection() {
    const config = getConfig();
    if (!config) {
        throw new Error('ยังไม่ได้ตั้งค่าการเชื่อมต่อฐานข้อมูล');
    }

    if (config.db_type === 'pgsql') {
        const client = await getPgPool().connect();
        return {
            type: 'pgsql',
            async query(sql, p) {
                const { text, values } = toPgParams(sql, p || {});
                const result = await client.query(text, values);
                return result.rows;
            },
            async beginTransaction() {
                await client.query('BEGIN');
            },
            async commit() {
                await client.query('COMMIT');
            },
            async rollback() {
                await client.query('ROLLBACK');
            },
            release() {
                client.release();
            },
        };
    }

    const conn = await getMysqlPool().getConnection();

    // กันหน้าจอค้างไม่รู้จบเมื่อแถวถูกล็อกค้างโดยผู้ใช้ HOSxP เครื่องอื่น
    // ให้รอไม่เกิน 30 วินาทีแล้วโยน error ออกมาให้ผู้ใช้เห็นแทน (ค่า default ของบางเซิร์ฟเวอร์ตั้งไว้สูงมาก)
    try {
        await conn.query('SET SESSION innodb_lock_wait_timeout = 30');
    } catch (e) {
        // ไม่รองรับตัวแปรนี้ก็ข้ามไป
    }

    return {
        type: 'mysql',
        async query(sql, p) {
            const { text, values } = toMysqlParams(sql, p || {});
            const [rows] = await conn.query(text, values);
            return rows;
        },
        async beginTransaction() {
            await conn.beginTransaction();
        },
        async commit() {
            await conn.commit();
        },
        async rollback() {
            await conn.rollback();
        },
        release() {
            conn.release();
        },
    };
}

module.exports = {
    getConfig,
    saveConfig,
    hasConfig,
    getType,
    testConnection,
    query,
    getConnection,
};
