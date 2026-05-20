"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = require("http");
const ws_1 = require("ws");
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const wsServer_1 = require("./wsServer");
const db_1 = require("./db");
const achievements_1 = require("./achievements");
const utils_1 = require("./utils");
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.get('/', (_req, res) => res.json({ status: 'PokerFlip server running ♠️' }));
// Telegram bot webhook
app.post('/api/webhook', async (req, res) => {
    res.sendStatus(200);
    try {
        const update = req.body;
        const msg = update?.message;
        if (!msg)
            return;
        const chatId = msg.chat.id;
        const text = msg.text || '';
        const firstName = msg.from?.first_name || 'Player';
        if (text.startsWith('/start')) {
            const botToken = process.env.BOT_TOKEN;
            if (!botToken)
                return;
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `♠️ Welcome to *PokerFlip*, ${firstName}!\n\nPlay Texas Hold'em poker with free chips.\n\n🎁 *3,000 chips* to start\n⏰ Claim *+500 chips* every 6 hours\n🔥 Daily login bonus (up to 1,000/day)\n👥 Invite friends → *+3,000 chips* each\n\nJoin tables, climb the leaderboard, win tournaments!`,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [[
                                { text: '♠️ Play Now', web_app: { url: 'https://pokerflip-client.onrender.com' } }
                            ]]
                    }
                })
            });
        }
    }
    catch (e) {
        console.error('Webhook error:', e);
    }
});
app.get('/tables', (_req, res) => {
    res.json((0, wsServer_1.getTableStats)());
});
const MIN_PLAYERS = 6;
function nextOccurrence(hour, minute = 0, weekday) {
    const now = new Date();
    const d = new Date(now);
    if (weekday !== undefined) {
        const diff = (weekday - d.getDay() + 7) % 7 || 7;
        d.setDate(d.getDate() + diff);
    }
    d.setHours(hour, minute, 0, 0);
    if (d <= now)
        d.setDate(d.getDate() + (weekday !== undefined ? 7 : 1));
    return d;
}
async function getTournamentState() {
    const db = (0, db_1.getPool)();
    const { rows } = await db.query(`SELECT tournament_id, COUNT(*) as cnt FROM pf_tournament_regs GROUP BY tournament_id`).catch(() => ({ rows: [] }));
    const counts = {};
    rows.forEach((r) => { counts[r.tournament_id] = Number(r.cnt); });
    return {
        daily: { nextAt: nextOccurrence(20).toISOString(), prize: '50,000', buyIn: '2,000', registered: counts['daily'] || 0, minPlayers: MIN_PLAYERS, canStart: (counts['daily'] || 0) >= MIN_PLAYERS },
        weekly: { nextAt: nextOccurrence(21, 0, 0).toISOString(), prize: '300,000', buyIn: '5,000', registered: counts['weekly'] || 0, minPlayers: MIN_PLAYERS, canStart: (counts['weekly'] || 0) >= MIN_PLAYERS },
    };
}
// GET /api/tournaments
app.get('/api/tournaments', async (_req, res) => {
    try {
        res.json(await getTournamentState());
    }
    catch (e) {
        res.status(500).json({ error: 'server error' });
    }
});
// POST /api/tournaments/register
app.post('/api/tournaments/register', async (req, res) => {
    try {
        const { initData, tournamentId } = req.body;
        if (!initData || !tournamentId)
            return res.status(400).json({ error: 'missing params' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid initData' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const buyIns = { daily: 2000, weekly: 5000 };
        const cost = buyIns[tournamentId];
        if (!cost)
            return res.status(400).json({ error: 'unknown tournament' });
        const db = (0, db_1.getPool)();
        const { rows: userRows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [String(tgUser.id)]);
        if (!userRows[0] || userRows[0].chips < cost)
            return res.status(400).json({ error: 'insufficient_chips', required: cost });
        // Idempotent insert
        const { rowCount } = await db.query(`INSERT INTO pf_tournament_regs (tg_id, tournament_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [String(tgUser.id), tournamentId]);
        if (rowCount && rowCount > 0) {
            await db.query('UPDATE pf_users SET chips = chips - $1 WHERE tg_id=$2', [cost, String(tgUser.id)]);
            await (0, db_1.logTransaction)(String(tgUser.id), 'tournament', -cost, `Registered: ${tournamentId} tournament`);
        }
        res.json({ ok: true, ...(await getTournamentState()) });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// POST /api/auth — upsert user, handle referral, return user
app.post('/api/auth', async (req, res) => {
    try {
        const { initData, startParam } = req.body;
        if (!initData)
            return res.status(400).json({ error: 'no initData' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid initData' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const tgId = String(tgUser.id);
        const db = (0, db_1.getPool)();
        // Check if new user
        const existing = await db.query('SELECT tg_id FROM pf_users WHERE tg_id=$1', [tgId]);
        const isNew = existing.rows.length === 0;
        // Referrer: startParam is referrer's tg_id (don't self-refer)
        const referrerId = startParam && startParam !== tgId ? startParam : null;
        const { rows } = await db.query(`INSERT INTO pf_users (tg_id, username, first_name, photo_url, referred_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tg_id) DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         photo_url  = COALESCE(EXCLUDED.photo_url, pf_users.photo_url)
       RETURNING *`, [tgId, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null,
            isNew ? referrerId : undefined]);
        // Credit referrer once for new users
        if (isNew && referrerId) {
            await db.query(`UPDATE pf_users SET chips = chips + 3000, referrals_count = referrals_count + 1 WHERE tg_id=$1`, [referrerId]);
        }
        // Fetch real photo via Bot API (background, don't await)
        if (process.env.BOT_TOKEN) {
            fetchAndSavePhoto(tgId, process.env.BOT_TOKEN).catch(() => { });
        }
        const user = rows[0];
        // Update login streak (no chip bonus, just counter for achievements)
        const today = new Date().toISOString().slice(0, 10);
        const lastLogin = user.last_login_date ? String(user.last_login_date).slice(0, 10) : null;
        if (lastLogin !== today) {
            const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
            const newStreak = lastLogin === yesterday ? (user.streak_days || 0) + 1 : 1;
            await db.query(`UPDATE pf_users SET streak_days=$1, last_login_date=$2 WHERE tg_id=$3`, [newStreak, today, tgId]);
            user.streak_days = newStreak;
            user.last_login_date = today;
        }
        // Check if spin is available
        const canSpin = !user.last_spin_at ||
            (Date.now() - new Date(user.last_spin_at).getTime()) >= 86400000;
        res.json({ ...user, can_spin: canSpin });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// POST /api/spin — daily fortune wheel
app.post('/api/spin', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!initData)
            return res.status(400).json({ error: 'no initData' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const db = (0, db_1.getPool)();
        // Ensure column exists
        await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMPTZ`).catch(() => { });
        const { rows } = await db.query('SELECT last_spin_at, chips FROM pf_users WHERE tg_id=$1', [String(tgUser.id)]);
        if (!rows[0])
            return res.status(404).json({ error: 'user not found — open app first' });
        const lastSpin = rows[0].last_spin_at;
        if (lastSpin) {
            const elapsed = Date.now() - new Date(lastSpin).getTime();
            if (elapsed < 86400000) {
                const nextIn = Math.ceil((86400000 - elapsed) / 60000);
                return res.status(429).json({ error: 'too_soon', nextInMinutes: nextIn });
            }
        }
        // 0.1% → 50000, 1% → 10000, rest → 200-1000
        const rand = Math.random();
        const prizes = [200, 300, 400, 500, 800, 1000];
        const prize = rand < 0.001 ? 50000
            : rand < 0.011 ? 10000
                : prizes[Math.floor(Math.random() * prizes.length)];
        const { rows: updated } = await db.query(`UPDATE pf_users SET chips = chips + $1, last_spin_at = NOW() WHERE tg_id=$2 RETURNING *`, [prize, String(tgUser.id)]);
        await (0, db_1.logTransaction)(String(tgUser.id), 'spin', prize, `Daily spin: won ${prize.toLocaleString()} chips`);
        res.json({ prize, chips: updated[0].chips, jackpot: prize >= 10000 });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// POST /api/payments/ton-confirm — verify TON payment and credit chips
app.post('/api/payments/ton-confirm', async (req, res) => {
    try {
        const { initData, packageId, bocHash } = req.body;
        if (!initData || !packageId || !bocHash)
            return res.status(400).json({ error: 'missing params' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid initData' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const TON_PACKAGES = {
            pack10: { chips: 10000, ton: 0.5 },
            pack30: { chips: 30000, ton: 1.0 },
            pack100: { chips: 100000, ton: 3.0 },
            pack250: { chips: 250000, ton: 6.0 },
            pack500: { chips: 500000, ton: 10.0 },
        };
        const pkg = TON_PACKAGES[packageId];
        if (!pkg)
            return res.status(400).json({ error: 'unknown package' });
        const db = (0, db_1.getPool)();
        // Prevent double-spending
        const { rows: existing } = await db.query('SELECT 1 FROM pf_ton_payments WHERE boc_hash=$1', [bocHash]);
        if (existing.length > 0)
            return res.status(409).json({ error: 'already_used' });
        // Credit chips and record payment
        await db.query('INSERT INTO pf_ton_payments (boc_hash, tg_id, package_id, chips) VALUES ($1,$2,$3,$4)', [bocHash, String(tgUser.id), packageId, pkg.chips]);
        const { rows } = await db.query('UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING *', [pkg.chips, String(tgUser.id)]);
        await (0, db_1.logTransaction)(String(tgUser.id), 'purchase', pkg.chips, `Bought ${pkg.chips.toLocaleString()} chips (TON)`);
        res.json(rows[0]);
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// GET /api/achievements
app.get('/api/achievements', async (req, res) => {
    try {
        const initData = req.headers['x-init-data'];
        if (!initData)
            return res.status(400).json({ error: 'no initData' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const achievements = await (0, achievements_1.getAchievements)(String(tgUser.id));
        res.json(achievements);
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// GET /api/leaderboard?period=all|weekly
app.get('/api/leaderboard', async (req, res) => {
    try {
        const db = (0, db_1.getPool)();
        const weekly = req.query.period === 'weekly';
        const { rows } = await db.query(`
      SELECT tg_id, first_name, username, photo_url, chips, hands_played, hands_won, biggest_pot,
        (hands_played * 10 + hands_won * 30 + biggest_pot / 500) AS xp
      FROM pf_users
      ${weekly ? "WHERE created_at >= NOW() - INTERVAL '7 days'" : ''}
      ORDER BY (hands_played * 10 + hands_won * 30 + biggest_pot / 500) DESC, chips DESC
      LIMIT 50
    `);
        res.json(rows);
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// GET /api/referral — return referral stats
app.get('/api/referral', async (req, res) => {
    try {
        const initData = req.headers['x-init-data'];
        if (!initData)
            return res.status(400).json({ error: 'no initData' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const db = (0, db_1.getPool)();
        const { rows } = await db.query('SELECT referrals_count FROM pf_users WHERE tg_id=$1', [String(tgUser.id)]);
        res.json({ referrals_count: rows[0]?.referrals_count || 0, tg_id: String(tgUser.id) });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// POST /api/claim — free 1000 chips every 6h
app.post('/api/claim', async (req, res) => {
    try {
        const { initData } = req.body;
        if (!initData)
            return res.status(400).json({ error: 'no initData' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid initData' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const db = (0, db_1.getPool)();
        const { rows } = await db.query('SELECT * FROM pf_users WHERE tg_id=$1', [String(tgUser.id)]);
        if (!rows[0])
            return res.status(404).json({ error: 'user not found' });
        const user = rows[0];
        const now = new Date();
        const lastClaim = new Date(user.claimed_at);
        const hoursSince = (now.getTime() - lastClaim.getTime()) / 3600000;
        if (hoursSince < 6) {
            const nextIn = Math.ceil((6 - hoursSince) * 60);
            return res.status(429).json({ error: 'too_soon', nextInMinutes: nextIn });
        }
        const { rows: updated } = await db.query(`UPDATE pf_users SET chips = chips + 500, claimed_at = NOW()
       WHERE tg_id=$1 RETURNING *`, [String(tgUser.id)]);
        await (0, db_1.logTransaction)(String(tgUser.id), 'claim', 500, 'Free chips claimed');
        res.json(updated[0]);
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// GET /api/transactions
app.get('/api/transactions', async (req, res) => {
    try {
        const initData = req.headers['x-init-data'];
        if (!initData)
            return res.status(400).json({ error: 'no initData' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const db = (0, db_1.getPool)();
        const { rows } = await db.query(`SELECT type, amount, desc, created_at FROM pf_transactions WHERE tg_id=$1 ORDER BY created_at DESC LIMIT 30`, [String(tgUser.id)]);
        res.json(rows);
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
const PACKAGES = {
    pack10: { chips: 10000, stars: 99, label: '10,000 Chips' },
    pack30: { chips: 30000, stars: 199, label: '30,000 Chips' },
    pack100: { chips: 100000, stars: 499, label: '100,000 Chips' },
    pack250: { chips: 250000, stars: 999, label: '250,000 Chips' },
    pack500: { chips: 500000, stars: 1599, label: '500,000 Chips' },
};
// POST /api/payments/stars-invoice
app.post('/api/payments/stars-invoice', async (req, res) => {
    try {
        const { initData, packageId } = req.body;
        if (!initData || !packageId)
            return res.status(400).json({ error: 'missing params' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid initData' });
        const pkg = PACKAGES[packageId];
        if (!pkg)
            return res.status(400).json({ error: 'unknown package' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const payload = JSON.stringify({ tg_id: String(tgUser.id), packageId });
        const resp = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                title: pkg.label,
                description: `${pkg.chips.toLocaleString()} play chips for PokerFlip`,
                payload,
                currency: 'XTR',
                prices: [{ label: pkg.label, amount: pkg.stars }],
            }),
        });
        const data = await resp.json();
        if (!data.ok)
            return res.status(500).json({ error: data.description });
        res.json({ invoiceUrl: data.result });
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
// POST /api/payments/stars-confirm
app.post('/api/payments/stars-confirm', async (req, res) => {
    try {
        const { initData, packageId } = req.body;
        if (!initData || !packageId)
            return res.status(400).json({ error: 'missing params' });
        const params = (0, utils_1.validateTgInitData)(initData);
        if (!params)
            return res.status(403).json({ error: 'invalid initData' });
        const pkg = PACKAGES[packageId];
        if (!pkg)
            return res.status(400).json({ error: 'unknown package' });
        const tgUser = (0, utils_1.parseTgUser)(params);
        if (!tgUser?.id)
            return res.status(400).json({ error: 'no user' });
        const db = (0, db_1.getPool)();
        const { rows } = await db.query(`UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING *`, [pkg.chips, String(tgUser.id)]);
        if (!rows[0])
            return res.status(404).json({ error: 'user not found' });
        await (0, db_1.logTransaction)(String(tgUser.id), 'purchase', pkg.chips, `Bought ${pkg.label} (Stars)`);
        res.json(rows[0]);
    }
    catch (e) {
        console.error(e);
        res.status(500).json({ error: 'server error' });
    }
});
async function fetchAndSavePhoto(tgId, botToken) {
    try {
        const r1 = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${tgId}&limit=1`);
        const d1 = await r1.json();
        if (!d1.ok || !d1.result?.photos?.length)
            return;
        const fileId = d1.result.photos[0][2]?.file_id || d1.result.photos[0][0]?.file_id;
        const r2 = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`);
        const d2 = await r2.json();
        if (!d2.ok || !d2.result?.file_path)
            return;
        const photoUrl = `https://api.telegram.org/file/bot${botToken}/${d2.result.file_path}`;
        const db = (0, db_1.getPool)();
        await db.query('UPDATE pf_users SET photo_url=$1 WHERE tg_id=$2', [photoUrl, tgId]);
    }
    catch { }
}
const server = (0, http_1.createServer)(app);
const wss = new ws_1.WebSocketServer({ server });
(0, wsServer_1.setupWS)(wss);
const PORT = process.env.PORT || 3002;
server.listen(PORT, () => console.log(`\n♠️ PokerFlip server → http://localhost:${PORT}\n   WebSocket → ws://localhost:${PORT}\n`));
(0, db_1.initDB)().catch(e => console.error('DB init warning:', e));
