import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import dotenv from 'dotenv'
import { setupWS, getTableStats } from './wsServer'
import { initDB, getPool } from './db'
import { validateTgInitData, parseTgUser } from './utils'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (_req, res) => res.json({ status: 'PokerFlip server running ♠️' }))

app.get('/tables', (_req, res) => {
  res.json(getTableStats())
})

// Tournament registrations (in-memory, resets on redeploy)
const tournamentRegs = new Map<string, Set<string>>()
const MIN_PLAYERS = 6

function getTournamentState() {
  const now = new Date()

  function nextDaily() {
    const d = new Date(now); d.setHours(20, 0, 0, 0)
    if (d <= now) d.setDate(d.getDate() + 1)
    return d
  }
  function nextWeekly() {
    const d = new Date(now)
    const daysUntilSun = d.getDay() === 0 ? 7 : 7 - d.getDay()
    d.setDate(d.getDate() + daysUntilSun); d.setHours(21, 0, 0, 0)
    if (d <= now) d.setDate(d.getDate() + 7)
    return d
  }

  const dailyRegs = tournamentRegs.get('daily')?.size || 0
  const weeklyRegs = tournamentRegs.get('weekly')?.size || 0

  return {
    daily:  { nextAt: nextDaily().toISOString(),  prize: '50,000',  buyIn: '2,000', registered: dailyRegs,  minPlayers: MIN_PLAYERS, canStart: dailyRegs >= MIN_PLAYERS },
    weekly: { nextAt: nextWeekly().toISOString(), prize: '500,000', buyIn: '5,000', registered: weeklyRegs, minPlayers: MIN_PLAYERS, canStart: weeklyRegs >= MIN_PLAYERS },
  }
}

// GET /api/tournaments
app.get('/api/tournaments', (_req, res) => res.json(getTournamentState()))

// POST /api/tournaments/register
app.post('/api/tournaments/register', async (req, res) => {
  try {
    const { initData, tournamentId } = req.body as { initData?: string; tournamentId?: string }
    if (!initData || !tournamentId) return res.status(400).json({ error: 'missing params' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    // Check buy-in
    const buyIns: Record<string, number> = { daily: 2000, weekly: 5000 }
    const cost = buyIns[tournamentId]
    if (!cost) return res.status(400).json({ error: 'unknown tournament' })

    const db = getPool()
    const { rows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [String(tgUser.id)])
    if (!rows[0] || rows[0].chips < cost) return res.status(400).json({ error: 'insufficient_chips', required: cost })

    // Deduct buy-in
    await db.query('UPDATE pf_users SET chips = chips - $1 WHERE tg_id=$2', [cost, String(tgUser.id)])

    if (!tournamentRegs.has(tournamentId)) tournamentRegs.set(tournamentId, new Set())
    tournamentRegs.get(tournamentId)!.add(String(tgUser.id))

    res.json({ ok: true, ...getTournamentState() })
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
         photo_url  = EXCLUDED.photo_url
       RETURNING *`,
      [tgId, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null,
       isNew ? referrerId : undefined]
    )

    // Credit referrer 10K chips once (only for new users)
    if (isNew && referrerId) {
      await db.query(
        `UPDATE pf_users SET chips = chips + 3000, referrals_count = referrals_count + 1
         WHERE tg_id = $1`,
        [referrerId]
      )
    }

    res.json(rows[0])
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
    res.json(updated[0])
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
    res.json(rows[0])
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

const server = createServer(app)
const wss = new WebSocketServer({ server })

setupWS(wss)

const PORT = process.env.PORT || 3002
server.listen(PORT, () => console.log(`\n♠️ PokerFlip server → http://localhost:${PORT}\n   WebSocket → ws://localhost:${PORT}\n`))
initDB().catch(e => console.error('DB init warning:', e))
