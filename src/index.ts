import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import cors from 'cors'
import dotenv from 'dotenv'
import { setupWS } from './wsServer'
import { initDB, getPool } from './db'
import { validateTgInitData, parseTgUser } from './utils'

dotenv.config()

const app = express()
app.use(cors())
app.use(express.json())

app.get('/', (_req, res) => res.json({ status: 'PokerFlip server running ♠️' }))

app.get('/tables', (_req, res) => {
  res.json({ tables: [{ id: 'main', name: 'Main Table', blinds: '10/20', players: 0, maxPlayers: 6 }] })
})

// POST /api/auth — upsert user, return chips
app.post('/api/auth', async (req, res) => {
  try {
    const { initData } = req.body as { initData?: string }
    if (!initData) return res.status(400).json({ error: 'no initData' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })

    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const db = getPool()
    const { rows } = await db.query(
      `INSERT INTO pf_users (tg_id, username, first_name, photo_url)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tg_id) DO UPDATE SET
         username   = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         photo_url  = EXCLUDED.photo_url
       RETURNING *`,
      [String(tgUser.id), tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null]
    )
    res.json(rows[0])
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
      `UPDATE pf_users SET chips = chips + 1000, claimed_at = NOW()
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
  starter:  { chips:   50_000, stars:   50, label: 'Chips Starter' },
  standard: { chips:  150_000, stars:  149, label: 'Chips Standard' },
  popular:  { chips:  500_000, stars:  499, label: 'Chips Popular' },
  whale:    { chips: 1_000_000, stars: 899, label: 'Chips Whale' },
  legend:   { chips: 5_000_000, stars: 3999, label: 'Chips Legend' },
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
