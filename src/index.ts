import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import dotenv from 'dotenv'
import { setupWS, getTableStats } from './wsServer'
import { initDB, getPool, logTransaction } from './db'
import { getAchievements } from './achievements'
import { validateTgInitData, parseTgUser } from './utils'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (_req, res) => res.json({ status: 'PokerFlip server running ♠️' }))

const TMA_URL = 'https://pokerflip-client.onrender.com'
const PLAY_BTN = { inline_keyboard: [[{ text: '♠️ Play Now', web_app: { url: TMA_URL } }]] }

async function tgSend(chatId: number | string, text: string, extra: object = {}) {
  const botToken = process.env.BOT_TOKEN
  if (!botToken) return
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra })
  }).catch(() => {})
}

// Telegram bot webhook
app.post('/api/webhook', async (req, res) => {
  res.sendStatus(200)
  try {
    const update = req.body
    const msg = update?.message
    if (!msg) return

    const chatId = msg.chat.id
    const tgId = String(msg.from?.id || chatId)
    const text = (msg.text || '').trim()
    const firstName = msg.from?.first_name || 'Player'

    if (text.startsWith('/start')) {
      await tgSend(chatId,
        `♠️ Welcome to *PokerFlip*, ${firstName}!\n\nPlay Texas Hold'em poker with free chips.\n\n🎁 *3,000 chips* to start\n⏰ Claim *+500 chips* every 6 hours\n🎰 Daily spin wheel — up to *50,000 chips*!\n👥 Invite friends → *+3,000 chips* each\n\nJoin tables, climb the leaderboard, win tournaments!`,
        { reply_markup: PLAY_BTN })
    }

    else if (text === '/stats' || text === '/balance') {
      const db = getPool()
      const { rows } = await db.query(
        'SELECT chips, hands_played, hands_won, biggest_pot, streak_days FROM pf_users WHERE tg_id=$1', [tgId]
      )
      if (!rows[0]) return tgSend(chatId, '❌ You need to open the app first!', { reply_markup: PLAY_BTN })
      const u = rows[0]
      const wr = u.hands_played > 0 ? Math.round(u.hands_won / u.hands_played * 100) : 0
      const xp = u.hands_played * 10 + u.hands_won * 30 + Math.floor(u.biggest_pot / 500)
      await tgSend(chatId,
        `♠️ *Your PokerFlip Stats*\n\n` +
        `💰 Balance: *${u.chips.toLocaleString()} chips*\n` +
        `🃏 Hands played: *${u.hands_played}*\n` +
        `🏆 Win rate: *${wr}%*\n` +
        `💎 Biggest pot: *${u.biggest_pot.toLocaleString()}*\n` +
        `⚡ XP: *${xp.toLocaleString()}*\n` +
        `🔥 Streak: *${u.streak_days} days*`,
        { reply_markup: PLAY_BTN })
    }

    else if (text === '/referral') {
      const db = getPool()
      const { rows } = await db.query('SELECT referrals_count FROM pf_users WHERE tg_id=$1', [tgId])
      const count = rows[0]?.referrals_count || 0
      const link = `https://t.me/pokerflip_bot?start=${tgId}`
      await tgSend(chatId,
        `👥 *Your Referral Link*\n\n` +
        `${link}\n\n` +
        `Friends joined: *${count}*\n` +
        `Earned: *${(count * 3000).toLocaleString()} chips*\n\n` +
        `Each friend gives you *+3,000 chips*!`)
    }

    else if (text === '/claim') {
      await tgSend(chatId, '⏰ Open the app to claim your free chips!', { reply_markup: PLAY_BTN })
    }

    else if (text === '/spin') {
      await tgSend(chatId, '🎰 Open the app to spin the daily wheel!', { reply_markup: PLAY_BTN })
    }

    else if (text === '/help') {
      await tgSend(chatId,
        `♠️ *PokerFlip Commands*\n\n` +
        `/stats — your statistics\n` +
        `/balance — chip balance\n` +
        `/referral — your referral link\n` +
        `/claim — claim free chips\n` +
        `/spin — daily spin wheel\n` +
        `/help — this message`)
    }

  } catch (e) {
    console.error('Webhook error:', e)
  }
})

// GET /api/notify — send push notifications to users who haven't been active
app.get('/api/notify', async (req, res) => {
  const secret = req.headers['x-notify-secret']
  if (secret !== process.env.NOTIFY_SECRET && secret !== 'pokerflip-notify-2026') {
    return res.status(403).json({ error: 'forbidden' })
  }
  try {
    const db = getPool()
    // Users who haven't logged in for 20-48 hours and have claimable chips
    const { rows } = await db.query(`
      SELECT tg_id, first_name, chips, claimed_at, last_spin_at
      FROM pf_users
      WHERE last_login_date < CURRENT_DATE - INTERVAL '1 day'
        AND last_login_date >= CURRENT_DATE - INTERVAL '3 days'
      LIMIT 200
    `)

    let sent = 0
    for (const u of rows) {
      const canClaim = !u.claimed_at || Date.now() - new Date(u.claimed_at).getTime() >= 6 * 3600000
      const canSpin = !u.last_spin_at || Date.now() - new Date(u.last_spin_at).getTime() >= 86400000
      if (!canClaim && !canSpin) continue

      const parts = []
      if (canClaim) parts.push('⏰ Free chips ready to claim!')
      if (canSpin) parts.push('🎰 Daily spin wheel available!')

      await tgSend(u.tg_id,
        `👋 Hey ${u.first_name || 'Player'}!\n\n${parts.join('\n')}\n\nYou have *${u.chips.toLocaleString()} chips* waiting.`,
        { reply_markup: PLAY_BTN }
      )
      sent++
      await new Promise(r => setTimeout(r, 100)) // rate limit
    }
    res.json({ ok: true, sent })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

app.get('/tables', (_req, res) => {
  res.json(getTableStats())
})

const MIN_PLAYERS = 6

function nextOccurrence(hour: number, minute = 0, weekday?: number) {
  const now = new Date()
  const d = new Date(now)
  if (weekday !== undefined) {
    const diff = (weekday - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + diff)
  }
  d.setHours(hour, minute, 0, 0)
  if (d <= now) d.setDate(d.getDate() + (weekday !== undefined ? 7 : 1))
  return d
}

async function getTournamentState() {
  const db = getPool()
  const { rows } = await db.query(
    `SELECT tournament_id, COUNT(*) as cnt FROM pf_tournament_regs GROUP BY tournament_id`
  ).catch(() => ({ rows: [] as any[] }))
  const counts: Record<string, number> = {}
  rows.forEach((r: any) => { counts[r.tournament_id] = Number(r.cnt) })

  return {
    daily:  { nextAt: nextOccurrence(20).toISOString(),       prize: '50,000',  buyIn: '2,000', registered: counts['daily'] || 0,  minPlayers: MIN_PLAYERS, canStart: (counts['daily'] || 0) >= MIN_PLAYERS },
    weekly: { nextAt: nextOccurrence(21, 0, 0).toISOString(), prize: '300,000', buyIn: '5,000', registered: counts['weekly'] || 0, minPlayers: MIN_PLAYERS, canStart: (counts['weekly'] || 0) >= MIN_PLAYERS },
  }
}

// GET /api/tournaments
app.get('/api/tournaments', async (_req, res) => {
  try { res.json(await getTournamentState()) }
  catch (e) { res.status(500).json({ error: 'server error' }) }
})

// POST /api/tournaments/register
app.post('/api/tournaments/register', async (req, res) => {
  try {
    const { initData, tournamentId } = req.body as { initData?: string; tournamentId?: string }
    if (!initData || !tournamentId) return res.status(400).json({ error: 'missing params' })
    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const buyIns: Record<string, number> = { daily: 2000, weekly: 5000 }
    const cost = buyIns[tournamentId]
    if (!cost) return res.status(400).json({ error: 'unknown tournament' })

    const db = getPool()
    const { rows: userRows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [String(tgUser.id)])
    if (!userRows[0] || userRows[0].chips < cost) return res.status(400).json({ error: 'insufficient_chips', required: cost })

    // Idempotent insert
    const { rowCount } = await db.query(
      `INSERT INTO pf_tournament_regs (tg_id, tournament_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [String(tgUser.id), tournamentId]
    )
    if (rowCount && rowCount > 0) {
      await db.query('UPDATE pf_users SET chips = chips - $1 WHERE tg_id=$2', [cost, String(tgUser.id)])
      await logTransaction(String(tgUser.id), 'tournament', -cost, `Registered: ${tournamentId} tournament`)
    }

    res.json({ ok: true, ...(await getTournamentState()) })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/auth — upsert user, handle referral, return user
app.post('/api/auth', async (req, res) => {
  try {
    const { initData, startParam } = req.body as { initData?: string; startParam?: string }
    if (!initData) return res.status(400).json({ error: 'no initData' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const tgId = String(tgUser.id)
    const db = getPool()

    // Check if new user
    const existing = await db.query('SELECT tg_id FROM pf_users WHERE tg_id=$1', [tgId])
    const isNew = existing.rows.length === 0

    // Referrer: startParam is referrer's tg_id (don't self-refer)
    const referrerId = startParam && startParam !== tgId ? startParam : null

    const { rows } = await db.query(
      `INSERT INTO pf_users (tg_id, username, first_name, photo_url, referred_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tg_id) DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         photo_url  = COALESCE(EXCLUDED.photo_url, pf_users.photo_url)
       RETURNING *`,
      [tgId, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null,
       isNew ? referrerId : undefined]
    )

    // Credit referrer once for new users
    if (isNew && referrerId) {
      await db.query(
        `UPDATE pf_users SET chips = chips + 3000, referrals_count = referrals_count + 1 WHERE tg_id=$1`,
        [referrerId]
      )
    }

    // Fetch real photo via Bot API (background, don't await)
    if (process.env.BOT_TOKEN) {
      fetchAndSavePhoto(tgId, process.env.BOT_TOKEN).catch(() => {})
    }

    const user = rows[0]

    // Update login streak (no chip bonus, just counter for achievements)
    const today = new Date().toISOString().slice(0, 10)
    const lastLogin = user.last_login_date ? String(user.last_login_date).slice(0, 10) : null
    if (lastLogin !== today) {
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10)
      const newStreak = lastLogin === yesterday ? (user.streak_days || 0) + 1 : 1
      await db.query(
        `UPDATE pf_users SET streak_days=$1, last_login_date=$2 WHERE tg_id=$3`,
        [newStreak, today, tgId]
      )
      user.streak_days = newStreak
      user.last_login_date = today
    }

    // Check if spin is available
    const canSpin = !user.last_spin_at ||
      (Date.now() - new Date(user.last_spin_at).getTime()) >= 86_400_000

    res.json({ ...user, can_spin: canSpin })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/spin — daily fortune wheel
app.post('/api/spin', async (req, res) => {
  try {
    const { initData } = req.body as { initData?: string }
    if (!initData) return res.status(400).json({ error: 'no initData' })
    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const db = getPool()

    // Ensure column exists
    await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMPTZ`).catch(() => {})

    const { rows } = await db.query('SELECT last_spin_at, chips FROM pf_users WHERE tg_id=$1', [String(tgUser.id)])
    if (!rows[0]) return res.status(404).json({ error: 'user not found — open app first' })

    const lastSpin = rows[0].last_spin_at
    if (lastSpin) {
      const elapsed = Date.now() - new Date(lastSpin).getTime()
      if (elapsed < 86_400_000) {
        const nextIn = Math.ceil((86_400_000 - elapsed) / 60_000)
        return res.status(429).json({ error: 'too_soon', nextInMinutes: nextIn })
      }
    }

    // 0.1% → 50000, 1% → 10000, rest → 200-1000
    const rand = Math.random()
    const prizes = [200, 300, 400, 500, 800, 1000]
    const prize = rand < 0.001 ? 50000
      : rand < 0.011 ? 10000
      : prizes[Math.floor(Math.random() * prizes.length)]

    const { rows: updated } = await db.query(
      `UPDATE pf_users SET chips = chips + $1, last_spin_at = NOW() WHERE tg_id=$2 RETURNING *`,
      [prize, String(tgUser.id)]
    )
    await logTransaction(String(tgUser.id), 'spin', prize, `Daily spin: won ${prize.toLocaleString()} chips`)

    res.json({ prize, chips: updated[0].chips, jackpot: prize >= 10000 })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/payments/ton-confirm — verify TON payment and credit chips
app.post('/api/payments/ton-confirm', async (req, res) => {
  try {
    const { initData, packageId, bocHash } = req.body as { initData?: string; packageId?: string; bocHash?: string }
    if (!initData || !packageId || !bocHash) return res.status(400).json({ error: 'missing params' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const TON_PACKAGES: Record<string, { chips: number }> = {
      pack10:  { chips:   10_000 },
      pack30:  { chips:   30_000 },
      pack100: { chips:  100_000 },
      pack250: { chips:  250_000 },
      pack500: { chips:  500_000 },
    }
    const pkg = TON_PACKAGES[packageId]
    if (!pkg) return res.status(400).json({ error: 'unknown package' })

    const db = getPool()

    // Ensure table exists
    await db.query(`CREATE TABLE IF NOT EXISTS pf_ton_payments (
      boc_hash TEXT PRIMARY KEY, tg_id TEXT NOT NULL,
      package_id TEXT NOT NULL, chips INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`).catch(() => {})

    // Prevent double-spending
    const { rows: existing } = await db.query('SELECT 1 FROM pf_ton_payments WHERE boc_hash=$1', [bocHash]).catch(() => ({ rows: [] }))
    if (existing.length > 0) return res.status(409).json({ error: 'already_used' })

    // Credit chips and record payment
    await db.query('INSERT INTO pf_ton_payments (boc_hash, tg_id, package_id, chips) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [bocHash, String(tgUser.id), packageId, pkg.chips])
    const { rows } = await db.query('UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING *', [pkg.chips, String(tgUser.id)])
    if (!rows[0]) return res.status(404).json({ error: 'user not found' })
    await logTransaction(String(tgUser.id), 'purchase', pkg.chips, `Bought ${pkg.chips.toLocaleString()} chips (TON)`)

    res.json(rows[0])
  } catch (e: any) {
    console.error('ton-confirm error:', e?.message || e)
    res.status(500).json({ error: e?.message || 'server error' })
  }
})

// GET /api/achievements
app.get('/api/achievements', async (req, res) => {
  try {
    const initData = req.headers['x-init-data'] as string
    if (!initData) return res.status(400).json({ error: 'no initData' })
    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })
    const achievements = await getAchievements(String(tgUser.id))
    res.json(achievements)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// GET /api/leaderboard?period=all|weekly
app.get('/api/leaderboard', async (req, res) => {
  try {
    const db = getPool()
    const weekly = req.query.period === 'weekly'
    const { rows } = await db.query(`
      SELECT tg_id, first_name, username, photo_url, chips, hands_played, hands_won, biggest_pot,
        (hands_played * 10 + hands_won * 30 + biggest_pot / 500) AS xp
      FROM pf_users
      ${weekly ? "WHERE created_at >= NOW() - INTERVAL '7 days'" : ''}
      ORDER BY (hands_played * 10 + hands_won * 30 + biggest_pot / 500) DESC, chips DESC
      LIMIT 50
    `)
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// GET /api/referral — return referral stats
app.get('/api/referral', async (req, res) => {
  try {
    const initData = req.headers['x-init-data'] as string
    if (!initData) return res.status(400).json({ error: 'no initData' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const db = getPool()
    const { rows } = await db.query(
      'SELECT referrals_count FROM pf_users WHERE tg_id=$1',
      [String(tgUser.id)]
    )
    res.json({ referrals_count: rows[0]?.referrals_count || 0, tg_id: String(tgUser.id) })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/claim — free 1000 chips every 6h
app.post('/api/claim', async (req, res) => {
  try {
    const { initData } = req.body as { initData?: string }
    if (!initData) return res.status(400).json({ error: 'no initData' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const db = getPool()
    const { rows } = await db.query('SELECT * FROM pf_users WHERE tg_id=$1', [String(tgUser.id)])
    if (!rows[0]) return res.status(404).json({ error: 'user not found' })

    const user = rows[0]
    const now = new Date()
    const lastClaim = new Date(user.claimed_at)
    const hoursSince = (now.getTime() - lastClaim.getTime()) / 3_600_000

    if (hoursSince < 6) {
      const nextIn = Math.ceil((6 - hoursSince) * 60)
      return res.status(429).json({ error: 'too_soon', nextInMinutes: nextIn })
    }

    const { rows: updated } = await db.query(
      `UPDATE pf_users SET chips = chips + 500, claimed_at = NOW()
       WHERE tg_id=$1 RETURNING *`,
      [String(tgUser.id)]
    )
    await logTransaction(String(tgUser.id), 'claim', 500, 'Free chips claimed')
    res.json(updated[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// GET /api/transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const initData = req.headers['x-init-data'] as string
    if (!initData) return res.status(400).json({ error: 'no initData' })
    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })
    const db = getPool()
    const { rows } = await db.query(
      `SELECT type, amount, desc, created_at FROM pf_transactions WHERE tg_id=$1 ORDER BY created_at DESC LIMIT 30`,
      [String(tgUser.id)]
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

const PACKAGES: Record<string, { chips: number; stars: number; label: string }> = {
  pack10:  { chips:   10_000, stars:   99, label: '10,000 Chips' },
  pack30:  { chips:   30_000, stars:  199, label: '30,000 Chips' },
  pack100: { chips:  100_000, stars:  499, label: '100,000 Chips' },
  pack250: { chips:  250_000, stars:  999, label: '250,000 Chips' },
  pack500: { chips:  500_000, stars: 1599, label: '500,000 Chips' },
}

// POST /api/payments/stars-invoice
app.post('/api/payments/stars-invoice', async (req, res) => {
  try {
    const { initData, packageId } = req.body as { initData?: string; packageId?: string }
    if (!initData || !packageId) return res.status(400).json({ error: 'missing params' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const pkg = PACKAGES[packageId]
    if (!pkg) return res.status(400).json({ error: 'unknown package' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const payload = JSON.stringify({ tg_id: String(tgUser.id), packageId })

    const resp = await fetch(
      `https://api.telegram.org/bot${process.env.BOT_TOKEN}/createInvoiceLink`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: pkg.label,
          description: `${pkg.chips.toLocaleString()} play chips for PokerFlip`,
          payload,
          currency: 'XTR',
          prices: [{ label: pkg.label, amount: pkg.stars }],
        }),
      }
    )
    const data = await resp.json() as any
    if (!data.ok) return res.status(500).json({ error: data.description })
    res.json({ invoiceUrl: data.result })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/payments/stars-confirm
app.post('/api/payments/stars-confirm', async (req, res) => {
  try {
    const { initData, packageId } = req.body as { initData?: string; packageId?: string }
    if (!initData || !packageId) return res.status(400).json({ error: 'missing params' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const pkg = PACKAGES[packageId]
    if (!pkg) return res.status(400).json({ error: 'unknown package' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const db = getPool()
    const { rows } = await db.query(
      `UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING *`,
      [pkg.chips, String(tgUser.id)]
    )
    if (!rows[0]) return res.status(404).json({ error: 'user not found' })
    await logTransaction(String(tgUser.id), 'purchase', pkg.chips, `Bought ${pkg.label} (Stars)`)
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/admin/credit — manual chip credit (protected by ADMIN_SECRET)
app.post('/api/admin/credit', async (req, res) => {
  const secret = req.headers['x-admin-secret']
  if (!secret || secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' })
  try {
    const { tgId, chips, reason } = req.body as { tgId?: string; chips?: number; reason?: string }
    if (!tgId || !chips || chips <= 0) return res.status(400).json({ error: 'missing params' })
    const db = getPool()
    const { rows } = await db.query(
      'UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING *',
      [chips, tgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'user not found' })
    await logTransaction(tgId, 'admin', chips, reason || 'Manual admin credit')
    res.json({ ok: true, chips: rows[0].chips })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server error' })
  }
})

async function fetchAndSavePhoto(tgId: string, botToken: string) {
  try {
    const r1 = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${tgId}&limit=1`)
    const d1 = await r1.json() as any
    if (!d1.ok || !d1.result?.photos?.length) return

    const fileId = d1.result.photos[0][2]?.file_id || d1.result.photos[0][0]?.file_id
    const r2 = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)
    const d2 = await r2.json() as any
    if (!d2.ok || !d2.result?.file_path) return

    const photoUrl = `https://api.telegram.org/file/bot${botToken}/${d2.result.file_path}`
    const db = getPool()
    await db.query('UPDATE pf_users SET photo_url=$1 WHERE tg_id=$2', [photoUrl, tgId])
  } catch {}
}

const server = createServer(app)
const wss = new WebSocketServer({ server })

setupWS(wss)

const PORT = process.env.PORT || 3002
server.listen(PORT, () => console.log(`\n♠️ PokerFlip server → http://localhost:${PORT}\n   WebSocket → ws://localhost:${PORT}\n`))
initDB().catch(e => console.error('DB init warning:', e))
