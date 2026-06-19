const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();

app.use(express.json());
app.use(session({
    secret: 'rcpt-debt-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true },
}));

app.use('/api', require('./src/routes/config'));
app.use('/api', require('./src/routes/auth'));
app.use('/api', require('./src/routes/data'));
app.use('/api', require('./src/routes/invoices'));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3008;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`ระบบออกใบแจ้งหนี้อัตโนมัติ: http://localhost:${PORT}`);
});
