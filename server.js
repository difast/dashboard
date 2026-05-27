'use strict';
const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.DASHBOARD_PASSWORD || 'Assassins2552';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'dashboard.json');
// Set SESSION_SECRET env var in Railway for persistence across restarts
const SESSION_SECRET = process.env.SESSION_SECRET || 'dashboard-session-secret-please-override-in-railway';

// PostgreSQL support — used when DATABASE_URL is set (e.g. Railway Postgres addon)
let pgPool = null;
if (process.env.DATABASE_URL) {
    const { Pool } = require('pg');
    pgPool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
    });
    pgPool.query(
        `CREATE TABLE IF NOT EXISTS dashboard_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)`
    ).catch(e => console.error('PG table init error:', e.message));
}

if (!pgPool && !fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

app.use(express.json({ limit: '10mb' }));
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        sameSite: 'strict'
    }
}));

app.use(express.static(path.join(__dirname)));

async function loadData() {
    if (pgPool) {
        try {
            const res = await pgPool.query(`SELECT value FROM dashboard_kv WHERE key = 'data'`);
            if (res.rows.length > 0) return JSON.parse(res.rows[0].value);
        } catch (e) {
            console.error('PG load error:', e.message);
        }
        return {};
    }
    try {
        if (fs.existsSync(DATA_FILE)) {
            return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('Error loading data:', e.message);
    }
    return {};
}

async function saveData(data) {
    if (pgPool) {
        const json = JSON.stringify(data);
        await pgPool.query(
            `INSERT INTO dashboard_kv (key, value) VALUES ('data', $1)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [json]
        );
        return;
    }
    // Atomic write via temp file
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE);
}

function requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) return next();
    res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/auth/check', (req, res) => {
    res.json({ authenticated: !!(req.session && req.session.authenticated) });
});

app.post('/api/auth/login', (req, res) => {
    const { password = '' } = req.body;
    // Timing-safe comparison to prevent timing attacks
    const a = Buffer.alloc(128, 0);
    const b = Buffer.alloc(128, 0);
    a.write(password.slice(0, 128));
    b.write(PASSWORD.slice(0, 128));
    if (crypto.timingSafeEqual(a, b)) {
        req.session.authenticated = true;
        req.session.save(err => {
            if (err) return res.status(500).json({ error: 'Session error' });
            res.json({ success: true });
        });
    } else {
        res.status(401).json({ error: 'Неверный пароль' });
    }
});

app.post('/api/auth/logout', (req, res) => {
    req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/data', requireAuth, async (req, res) => {
    try {
        res.json(await loadData());
    } catch (e) {
        console.error('Error loading data:', e.message);
        res.status(500).json({ error: 'Failed to load' });
    }
});

app.post('/api/data', requireAuth, async (req, res) => {
    try {
        await saveData(req.body);
        res.json({ success: true });
    } catch (e) {
        console.error('Error saving data:', e.message);
        res.status(500).json({ error: 'Failed to save' });
    }
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// Proxy: 1on1 admin stats — set ONE_ON_ONE_API_URL in Railway env vars
app.get('/api/1on1/stats', requireAuth, async (req, res) => {
    const baseUrl = (process.env.ONE_ON_ONE_API_URL || '').replace(/\/$/, '');
    if (!baseUrl) return res.json({ _not_configured: true });
    try {
        const r = await fetch(`${baseUrl}/api/users/admin/stats`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) return res.status(502).json({ error: `1on1 API returned ${r.status}` });
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ error: 'Cannot reach 1on1 API: ' + e.message });
    }
});

// Proxy: Trading bot — set TRADING_BOT_URL in Railway env vars
const BOT_URL = () => (process.env.TRADING_BOT_URL || '').replace(/\/$/, '');

async function botProxy(req, res, method, path, body) {
    const base = BOT_URL();
    if (!base) return res.json({ _not_configured: true });
    try {
        const opts = { method, signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const r = await fetch(`${base}${path}`, opts);
        const data = await r.json();
        res.status(r.ok ? 200 : r.status).json(data);
    } catch (e) {
        res.status(502).json({ error: 'Cannot reach trading bot: ' + e.message });
    }
}

app.get('/api/bot/status',              requireAuth, (req, res) => botProxy(req, res, 'GET', '/api/bot/status'));
app.get('/api/bot/config',              requireAuth, (req, res) => botProxy(req, res, 'GET', '/api/bot/config'));
app.post('/api/bot/config',             requireAuth, (req, res) => botProxy(req, res, 'POST', '/api/bot/config', req.body));
app.post('/api/bot/start',              requireAuth, (req, res) => botProxy(req, res, 'POST', '/api/bot/start'));
app.post('/api/bot/stop',               requireAuth, (req, res) => botProxy(req, res, 'POST', '/api/bot/stop'));
app.get('/api/bot/strategies',          requireAuth, (req, res) => botProxy(req, res, 'GET', '/api/bot/strategies'));
app.get('/api/bot/analytics/trades',    requireAuth, (req, res) => botProxy(req, res, 'GET', `/api/analytics/trades?${new URLSearchParams(req.query)}`));
app.get('/api/bot/analytics/pnl',       requireAuth, (req, res) => botProxy(req, res, 'GET', `/api/analytics/pnl?${new URLSearchParams(req.query)}`));
app.get('/api/bot/analytics/summary',   requireAuth, (req, res) => botProxy(req, res, 'GET', '/api/analytics/summary'));
app.get('/api/bot/portfolio',           requireAuth, (req, res) => botProxy(req, res, 'GET', '/api/portfolio/'));
app.get('/api/bot/accounts',            requireAuth, (req, res) => botProxy(req, res, 'GET', '/api/portfolio/accounts'));
app.get('/api/bot/candles',             requireAuth, (req, res) => botProxy(req, res, 'GET', `/api/portfolio/candles?${new URLSearchParams(req.query)}`));
app.get('/api/bot/instruments/search',  requireAuth, (req, res) => botProxy(req, res, 'GET', `/api/portfolio/instruments/search?${new URLSearchParams(req.query)}`))

app.listen(PORT, () => console.log(`Dashboard running on port ${PORT}${pgPool ? ' [PostgreSQL]' : ' [file storage]'}`));
