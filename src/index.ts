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

async function tgSendPhoto(chatId: number | string, photoUrl: string, caption: string, extra: object = {}) {
  const botToken = process.env.BOT_TOKEN
  if (!botToken) return
  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption, parse_mode: 'Markdown', ...extra })
  }).catch(() => {})
}

const CLIENT_URL = 'https://pokerflip-client.onrender.com'

const WELCOME: Record<string, (name: string) => string> = {
  ru: (name) => `♠️ Добро пожаловать в *PokerFlip*, ${name}!\n\nИграй в Texas Hold'em прямо в Telegram.\n\n🎁 *3,000 фишек* на старт\n⏰ *+500 фишек* каждые 6 часов\n🎰 Ежедневный барабан — до *50,000 фишек*!\n👥 Приглашай друзей → *+3,000 фишек* каждый\n\nПрисоединяйся к столам, поднимайся в рейтинге, выигрывай турниры!`,
  it: (name) => `♠️ Benvenuto in *PokerFlip*, ${name}!\n\nGioca a Texas Hold'em direttamente su Telegram.\n\n🎁 *3,000 gettoni* per iniziare\n⏰ *+500 gettoni* ogni 6 ore\n🎰 Ruota giornaliera — fino a *50,000 gettoni*!\n👥 Invita amici → *+3,000 gettoni* ciascuno\n\nUnisciti ai tavoli, scala la classifica, vinci tornei!`,
  en: (name) => `♠️ Welcome to *PokerFlip*, ${name}!\n\nPlay Texas Hold'em poker with free chips.\n\n🎁 *3,000 chips* to start\n⏰ Claim *+500 chips* every 6 hours\n🎰 Daily spin wheel — up to *50,000 chips*!\n👥 Invite friends → *+3,000 chips* each\n\nJoin tables, climb the leaderboard, win tournaments!`,
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
      const refId = text.slice(6).trim()
      const btnUrl = refId ? `${TMA_URL}?startapp=${refId}` : TMA_URL
      const startBtn = { inline_keyboard: [[{ text: '♠️ Play Now', web_app: { url: btnUrl } }]] }

      // Detect language from Telegram user object
      const rawLang = (msg.from?.language_code || 'en').slice(0, 2).toLowerCase()
      const lang = rawLang === 'ru' ? 'ru' : rawLang === 'it' ? 'it' : 'en'

      // Save language preference to DB (best-effort)
      try {
        const db = getPool()
        await db.query(
          `UPDATE pf_users SET lang=$1 WHERE tg_id=$2`,
          [lang, tgId]
        )
      } catch {}

      const bannerUrl = `${CLIENT_URL}/banner_${lang}_v2.png`
      await tgSendPhoto(chatId, bannerUrl, WELCOME[lang](firstName), { reply_markup: startBtn })
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

    // Admin commands (only for admin tgId)
    else if (String(chatId) === (process.env.ADMIN_TG_ID || '501197162')) {
      const db = getPool()
      if (text?.startsWith('/admin credit ')) {
        // /admin credit <tgId> <amount> [reason]
        const parts = text.split(' ')
        const targetId = parts[2]?.trim()
        const amount = parseInt(parts[3] || '0')
        const reason = parts.slice(4).join(' ') || 'Admin credit'
        if (!targetId || !amount || amount <= 0) {
          await tgSend(chatId, '❌ Usage: /admin credit <tgId> <amount> [reason]')
        } else {
          const { rows } = await db.query(
            'UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING first_name, chips',
            [amount, targetId]
          )
          if (!rows[0]) {
            await tgSend(chatId, `❌ User ${targetId} not found`)
          } else {
            await logTransaction(targetId, 'admin', amount, reason)
            await tgSend(chatId, `✅ Credited *+${amount.toLocaleString()} chips* to ${rows[0].first_name}\nNew balance: *${rows[0].chips.toLocaleString()} chips*`)
            await tgSend(targetId, `🎁 *+${amount.toLocaleString()} chips* от администратора!\n_${reason}_`, { reply_markup: PLAY_BTN })
          }
        }
      } else if (text?.startsWith('/admin start ')) {
        const id = text.split(' ')[2]?.trim()
        if (!['daily', 'weekly'].includes(id)) {
          await tgSend(chatId, '❌ Unknown tournament. Use: daily or weekly')
        } else {
          const { rows: regRows } = await db.query(`SELECT COUNT(*) as cnt FROM pf_tournament_regs WHERE tournament_id=$1`, [id])
          const registered = Number(regRows[0]?.cnt || 0)
          await db.query(`UPDATE pf_tournament_status SET status='active', cycle_key=$1, started_at=NOW() WHERE tournament_id=$2`,
            [`admin-${Date.now()}`, id])
          // Notify registered players
          const { rows: players } = await db.query(
            `SELECT u.tg_id FROM pf_tournament_regs r JOIN pf_users u ON u.tg_id=r.tg_id WHERE r.tournament_id=$1`, [id])
          for (const p of players) {
            tgSend(p.tg_id, `🏆 *Tournament Starting Now!*\nThe *${id === 'daily' ? 'Daily Grind' : 'Weekly Chill'}* has started! Join now!`, { reply_markup: PLAY_BTN }).catch(() => {})
          }
          await tgSend(chatId, `✅ Tournament *${id}* started. ${registered} players notified.`)
        }
      } else if (text?.startsWith('/admin end ')) {
        const id = text.split(' ')[2]?.trim()
        await db.query(`UPDATE pf_tournament_status SET status='pending', cycle_key='', started_at=NULL WHERE tournament_id=$1`, [id])
        await tgSend(chatId, `✅ Tournament *${id}* reset to pending.`)
      } else if (text === '/admin stats') {
        const { rows } = await db.query(`SELECT tournament_id, status, started_at FROM pf_tournament_status`)
        const { rows: reg } = await db.query(`SELECT tournament_id, COUNT(*) as cnt FROM pf_tournament_regs GROUP BY tournament_id`)
        const regMap: Record<string, number> = {}
        reg.forEach((r: any) => { regMap[r.tournament_id] = Number(r.cnt) })
        const lines = rows.map((r: any) => `*${r.tournament_id}*: ${r.status} | ${regMap[r.tournament_id] || 0} registered`)
        await tgSend(chatId, `📊 *Tournament Status*\n\n${lines.join('\n')}`)
      } else if (text === '/admin spin') {
        await db.query(`UPDATE pf_users SET last_spin_at = NULL WHERE tg_id=$1`, [String(chatId)])
        await tgSend(chatId, `✅ Daily spin reset. Open the app to spin!`, { reply_markup: PLAY_BTN })

      } else if (text?.startsWith('/admin lookup ')) {
        // /admin lookup <name_or_username>
        const q = text.split(' ').slice(2).join(' ').trim()
        const { rows } = await db.query(
          `SELECT tg_id, first_name, username, chips, hands_played, referred_by, referral_credited, referral_bonus
           FROM pf_users WHERE first_name ILIKE $1 OR username ILIKE $1 LIMIT 5`,
          [`%${q}%`]
        )
        if (!rows.length) {
          await tgSend(chatId, `❌ No users found for "${q}"`)
        } else {
          const lines = rows.map((r: any) =>
            `*${r.first_name}* (@${r.username || '—'}) id: \`${r.tg_id}\`\n` +
            `chips: ${r.chips?.toLocaleString()} | hands: ${r.hands_played}\n` +
            `referred_by: ${r.referred_by || '—'} | bonus: ${r.referral_bonus || 0} | credited: ${r.referral_credited}`
          )
          await tgSend(chatId, `🔍 *Found ${rows.length} user(s):*\n\n${lines.join('\n\n')}`)
        }

      } else if (text?.startsWith('/admin referral ')) {
        // /admin referral <tg_id> <referrer_id> — manually set referral for existing user
        const parts = text.split(' ')
        const targetId = parts[2]?.trim()
        const referrerId2 = parts[3]?.trim()
        if (!targetId || !referrerId2) {
          await tgSend(chatId, '❌ Usage: /admin referral <user_tg_id> <referrer_tg_id>')
        } else {
          // Check target exists
          const { rows: targetRows } = await db.query(
            'SELECT tg_id, first_name, referred_by, referral_bonus, referral_credited FROM pf_users WHERE tg_id=$1', [targetId]
          )
          if (!targetRows[0]) {
            await tgSend(chatId, `❌ User ${targetId} not found`)
          } else {
            const u = targetRows[0]
            // Set referred_by and bonus (only if not already credited)
            const { rows: updated } = await db.query(
              `UPDATE pf_users SET
                 referred_by = $1,
                 referral_bonus = CASE WHEN referral_bonus IS NULL OR referral_bonus = 0 THEN $2 ELSE referral_bonus END
               WHERE tg_id=$3 AND NOT referral_credited
               RETURNING first_name, referred_by, referral_bonus`,
              [referrerId2, 3000, targetId]  // default premium bonus for Kseniya
            )
            if (!updated[0]) {
              await tgSend(chatId, `⚠️ ${u.first_name} already has referral credited or not found`)
            } else {
              await tgSend(chatId,
                `✅ Referral set for *${updated[0].first_name}*\n` +
                `referred_by: ${updated[0].referred_by}\n` +
                `bonus queued: ${updated[0].referral_bonus} chips (will credit on next hand)`)
            }
          }
        }

      } else if (text === '/admin') {
        await tgSend(chatId,
          `🔧 *Admin Commands*\n\n` +
          `/admin start daily — force start Daily tournament\n` +
          `/admin start weekly — force start Weekly tournament\n` +
          `/admin end daily — reset tournament to pending\n` +
          `/admin stats — tournament & registration status\n` +
          `/admin spin — reset daily spin for yourself\n` +
          `/admin lookup <name> — find user by name/username\n` +
          `/admin referral <user_id> <referrer_id> — manually set referral\n` +
          `/admin credit <tgId> <amount> [reason] — credit chips`)
      }
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
      SELECT tg_id, first_name, chips, claimed_at, last_spin_at, lang
      FROM pf_users
      WHERE last_login_date < CURRENT_DATE - INTERVAL '1 day'
        AND last_login_date >= CURRENT_DATE - INTERVAL '3 days'
      LIMIT 200
    `)

    const NOTIFY_TEXT: Record<string, (name: string, chips: string, parts: string[]) => string> = {
      ru: (name, chips, parts) => `👋 Привет, ${name}!\n\n${parts.join('\n')}\n\nТебя ждут *${chips} фишек*.`,
      it: (name, chips, parts) => `👋 Ciao, ${name}!\n\n${parts.join('\n')}\n\nHai *${chips} gettoni* che ti aspettano.`,
      en: (name, chips, parts) => `👋 Hey ${name}!\n\n${parts.join('\n')}\n\nYou have *${chips} chips* waiting.`,
    }
    const NOTIFY_PARTS: Record<string, { claim: string; spin: string }> = {
      ru: { claim: '⏰ Бесплатные фишки готовы к получению!', spin: '🎰 Доступен ежедневный барабан!' },
      it: { claim: '⏰ Gettoni gratuiti pronti da riscuotere!', spin: '🎰 Ruota giornaliera disponibile!' },
      en: { claim: '⏰ Free chips ready to claim!', spin: '🎰 Daily spin wheel available!' },
    }

    let sent = 0
    for (const u of rows) {
      const canClaim = !u.claimed_at || Date.now() - new Date(u.claimed_at).getTime() >= 6 * 3600000
      const canSpin = !u.last_spin_at || Date.now() - new Date(u.last_spin_at).getTime() >= 86400000
      if (!canClaim && !canSpin) continue

      const lang = u.lang && ['ru', 'it', 'en'].includes(u.lang) ? u.lang : 'en'
      const p = NOTIFY_PARTS[lang]
      const parts = []
      if (canClaim) parts.push(p.claim)
      if (canSpin) parts.push(p.spin)

      await tgSend(u.tg_id,
        NOTIFY_TEXT[lang](u.first_name || (lang === 'ru' ? 'Игрок' : lang === 'it' ? 'Giocatore' : 'Player'), u.chips.toLocaleString(), parts),
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

const TOURNAMENT_CONFIGS: Record<string, { basePrize: number; buyIn: number; nextAt: () => Date; hour: number; weekday?: number }> = {
  daily:  { basePrize: 50_000,  buyIn: 2_000, nextAt: () => nextOccurrence(20), hour: 20 },
  weekly: { basePrize: 300_000, buyIn: 5_000, nextAt: () => nextOccurrence(21, 0, 0), hour: 21, weekday: 0 },
}

// Cycle key = "daily-2026-05-21" or "weekly-2026-W21"
function cycleKey(id: string): string {
  const now = new Date()
  if (id === 'weekly') {
    const week = Math.ceil((now.getDate() - now.getDay() + 1) / 7)
    return `${id}-${now.getFullYear()}-W${String(now.getMonth() + 1).padStart(2,'0')}${week}`
  }
  return `${id}-${now.toISOString().slice(0,10)}`
}

// Check if it's time to start this tournament (within 5-min window after scheduled hour)
function isTournamentWindow(id: string): boolean {
  const cfg = TOURNAMENT_CONFIGS[id]
  if (!cfg) return false
  const now = new Date()
  const h = now.getHours(), m = now.getMinutes()
  const dayMatch = cfg.weekday !== undefined ? now.getDay() === cfg.weekday : true
  return dayMatch && h === cfg.hour && m < 5
}

// Auto-start: runs every 60s, fires bot notifications + marks active
async function checkTournamentAutoStart() {
  const db = getPool()
  for (const id of Object.keys(TOURNAMENT_CONFIGS)) {
    if (!isTournamentWindow(id)) continue
    const key = cycleKey(id)
    // Already started this cycle?
    const { rows: st } = await db.query(
      `SELECT status, cycle_key FROM pf_tournament_status WHERE tournament_id=$1`, [id]
    ).catch(() => ({ rows: [] as any[] }))
    if (st[0]?.cycle_key === key && st[0]?.status !== 'pending') continue

    // Check registered count
    const { rows: cr } = await db.query(
      `SELECT COUNT(*) as cnt FROM pf_tournament_regs WHERE tournament_id=$1`, [id]
    ).catch(() => ({ rows: [{ cnt: 0 }] }))
    const registered = Number(cr[0]?.cnt || 0)
    if (registered < MIN_PLAYERS) continue

    // Mark active
    await db.query(
      `UPDATE pf_tournament_status SET status='active', cycle_key=$1, started_at=NOW() WHERE tournament_id=$2`,
      [key, id]
    ).catch(() => {})

    // Notify registered players via bot
    const cfg = TOURNAMENT_CONFIGS[id]
    const { rows: players } = await db.query(
      `SELECT u.tg_id FROM pf_tournament_regs r JOIN pf_users u ON u.tg_id=r.tg_id WHERE r.tournament_id=$1`, [id]
    ).catch(() => ({ rows: [] as any[] }))
    const tableUrl = `https://t.me/${process.env.BOT_USERNAME || 'pokerflip_bot'}?startapp=${id}`
    for (const p of players) {
      tgSend(p.tg_id, `🏆 *Tournament Starting Now!*\n\nThe *${id === 'daily' ? 'Daily Grind' : 'Weekly Chill'}* tournament has started!\n\nJoin your table now — seats are limited.`, {
        reply_markup: { inline_keyboard: [[{ text: '♠️ Join Tournament', url: tableUrl }]] }
      }).catch(() => {})
    }
    console.log(`Tournament ${id} started for cycle ${key} with ${registered} players`)
  }
}

// Reset finished tournaments after 3 hours
async function checkTournamentReset() {
  const db = getPool()
  await db.query(`
    UPDATE pf_tournament_status SET status='pending', cycle_key='', started_at=NULL
    WHERE status='active' AND started_at < NOW() - INTERVAL '3 hours'
  `).catch(() => {})
}

// Refund and clean up registrations that belong to a past cycle (tournament never started)
async function checkStaleRegistrations() {
  const db = getPool()
  for (const id of Object.keys(TOURNAMENT_CONFIGS)) {
    const cfg = TOURNAMENT_CONFIGS[id]
    const current = cycleKey(id)

    // Don't touch registrations while tournament is active
    const { rows: st } = await db.query(
      `SELECT status FROM pf_tournament_status WHERE tournament_id=$1`, [id]
    ).catch(() => ({ rows: [] as any[] }))
    if (st[0]?.status === 'active') continue

    // Find stale registrations: wrong cycle_key OR old regs without cycle_key (>25h old)
    const { rows: stale } = await db.query(
      `SELECT tg_id FROM pf_tournament_regs
       WHERE tournament_id=$1 AND (
         (cycle_key != '' AND cycle_key != $2) OR
         (cycle_key = '' AND registered_at < NOW() - INTERVAL '25 hours')
       )`,
      [id, current]
    ).catch(() => ({ rows: [] as any[] }))

    if (stale.length === 0) continue

    for (const r of stale) {
      await db.query('UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2', [cfg.buyIn, r.tg_id]).catch(() => {})
      await logTransaction(r.tg_id, 'tournament_refund', cfg.buyIn,
        `Refund: ${id} tournament cancelled (+${cfg.buyIn.toLocaleString()} chips)`).catch(() => {})
      tgSend(r.tg_id,
        `♠️ *Tournament Refund*\n\nThe *${id === 'daily' ? 'Daily Grind' : 'Weekly Chill'}* tournament didn't start (not enough players).\n\nYour buy-in of *${cfg.buyIn.toLocaleString()} chips* has been refunded. ✅`
      ).catch(() => {})
    }

    await db.query(
      `DELETE FROM pf_tournament_regs WHERE tournament_id=$1 AND (
        (cycle_key != '' AND cycle_key != $2) OR
        (cycle_key = '' AND registered_at < NOW() - INTERVAL '25 hours')
      )`,
      [id, current]
    ).catch(() => {})

    console.log(`Refunded ${stale.length} stale registrations for ${id}`)
  }
}

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

function calcPrizeDistribution(prizePool: number, registered: number) {
  const tiers =
    registered <= 1  ? [{ place: 1, pct: 100 }]
    : registered <= 4  ? [{ place: 1, pct: 60 }, { place: 2, pct: 40 }]
    : registered <= 8  ? [{ place: 1, pct: 50 }, { place: 2, pct: 30 }, { place: 3, pct: 20 }]
    : registered <= 16 ? [{ place: 1, pct: 40 }, { place: 2, pct: 25 }, { place: 3, pct: 15 }, { place: 4, pct: 12 }, { place: 5, pct: 8 }]
    :                    [{ place: 1, pct: 35 }, { place: 2, pct: 22 }, { place: 3, pct: 14 }, { place: 4, pct: 10 }, { place: 5, pct: 8 }, { place: 6, pct: 6 }, { place: 7, pct: 5 }]
  return tiers.map(t => ({ place: t.place, pct: t.pct, amount: Math.floor(prizePool * t.pct / 100) }))
}

async function getTournamentState(tgId?: string) {
  const db = getPool()
  const [regRows, statusRows] = await Promise.all([
    db.query(`SELECT tournament_id, COUNT(*) as cnt FROM pf_tournament_regs GROUP BY tournament_id`).catch(() => ({ rows: [] as any[] })),
    db.query(`SELECT tournament_id, status FROM pf_tournament_status`).catch(() => ({ rows: [] as any[] })),
  ])
  const counts: Record<string, number> = {}
  regRows.rows.forEach((r: any) => { counts[r.tournament_id] = Number(r.cnt) })
  const statuses: Record<string, string> = {}
  statusRows.rows.forEach((r: any) => { statuses[r.tournament_id] = r.status })

  let userRegs: Record<string, boolean> = {}
  if (tgId) {
    const { rows: rr } = await db.query(
      `SELECT tournament_id FROM pf_tournament_regs WHERE tg_id=$1`, [tgId]
    ).catch(() => ({ rows: [] as any[] }))
    rr.forEach((r: any) => { userRegs[r.tournament_id] = true })
  }

  const result: Record<string, any> = {}
  for (const [id, cfg] of Object.entries(TOURNAMENT_CONFIGS)) {
    const registered = counts[id] || 0
    const prizePool = Math.max(cfg.basePrize, registered * cfg.buyIn)
    const status = statuses[id] || 'pending'
    result[id] = {
      nextAt: cfg.nextAt().toISOString(),
      buyIn: cfg.buyIn.toLocaleString(),
      buyInRaw: cfg.buyIn,
      prize: prizePool.toLocaleString(),
      prizeRaw: prizePool,
      registered,
      minPlayers: MIN_PLAYERS,
      canStart: registered >= MIN_PLAYERS,
      status,
      isRegistered: userRegs[id] || false,
      prizes: calcPrizeDistribution(prizePool, registered),
    }
  }
  return result
}

// GET /api/tournaments — pass x-init-data to get isRegistered flag
app.get('/api/tournaments', async (req, res) => {
  try {
    let tgId: string | undefined
    const initDataHeader = req.headers['x-init-data'] as string | undefined
    if (initDataHeader) {
      const p = validateTgInitData(initDataHeader)
      const u = p ? parseTgUser(p) : null
      if (u?.id) tgId = String(u.id)
    }
    res.json(await getTournamentState(tgId))
  } catch (e) { res.status(500).json({ error: 'server error' }) }
})

// POST /api/tournaments/register — deduct buy-in, insert, return updated state
app.post('/api/tournaments/register', async (req, res) => {
  try {
    const { initData, tournamentId } = req.body as { initData?: string; tournamentId?: string }
    if (!initData || !tournamentId) return res.status(400).json({ error: 'missing params' })
    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const cfg = TOURNAMENT_CONFIGS[tournamentId]
    if (!cfg) return res.status(400).json({ error: 'unknown tournament' })
    const tgId = String(tgUser.id)
    const db = getPool()

    const { rows: userRows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [tgId])
    if (!userRows[0]) return res.status(404).json({ error: 'user not found' })
    if (userRows[0].chips < cfg.buyIn) {
      return res.status(400).json({ error: 'insufficient_chips', required: cfg.buyIn, have: userRows[0].chips })
    }

    const currentCycle = cycleKey(tournamentId)
    const { rowCount } = await db.query(
      `INSERT INTO pf_tournament_regs (tg_id, tournament_id, cycle_key) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tgId, tournamentId, currentCycle]
    )
    if (rowCount && rowCount > 0) {
      await db.query('UPDATE pf_users SET chips = chips - $1 WHERE tg_id=$2', [cfg.buyIn, tgId])
      await logTransaction(tgId, 'tournament', -cfg.buyIn, `Registered: ${tournamentId} (${cfg.buyIn.toLocaleString()} chips)`)
    }
    // rowCount=0 means already registered — not an error, just idempotent
    res.json({ ok: true, ...(await getTournamentState(tgId)) })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// GET /api/tournaments/:id/players — list of registered players
app.get('/api/tournaments/:id/players', async (req, res) => {
  try {
    const db = getPool()
    const { id } = req.params
    const { rows } = await db.query(
      `SELECT u.tg_id, u.first_name, u.username, u.photo_url
       FROM pf_tournament_regs r
       JOIN pf_users u ON u.tg_id = r.tg_id
       WHERE r.tournament_id = $1
       ORDER BY r.registered_at ASC`,
      [id]
    )
    res.json(rows)
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// GET /api/tournaments/history — past tournament results
app.get('/api/tournaments/history', async (req, res) => {
  try {
    const db = getPool()
    const { rows } = await db.query(
      `SELECT tournament_id, winner_name, prize, players_count, prize_pool, finished_at
       FROM pf_tournament_history ORDER BY finished_at DESC LIMIT 20`
    )
    res.json(rows)
  } catch (e) {
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

    // Referrer: startParam is referrer's tg_id (don't self-refer)
    const referrerId = startParam && startParam !== tgId ? startParam : null

    // Check if user exists and whether they already have a referral set
    const existing = await db.query(
      'SELECT tg_id, referred_by, referral_bonus, referral_credited FROM pf_users WHERE tg_id=$1', [tgId]
    )
    const isNew = existing.rows.length === 0
    const hadReferral = existing.rows[0]?.referred_by != null

    const { rows } = await db.query(
      `INSERT INTO pf_users (tg_id, username, first_name, photo_url, referred_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tg_id) DO UPDATE SET
         username    = EXCLUDED.username,
         first_name  = EXCLUDED.first_name,
         photo_url   = COALESCE(EXCLUDED.photo_url, pf_users.photo_url),
         referred_by = COALESCE(pf_users.referred_by, EXCLUDED.referred_by)
       RETURNING *`,
      [tgId, tgUser.username || null, tgUser.first_name || null, tgUser.photo_url || null,
       referrerId]
    )

    // Referral bonus (anti-bot, both tiers require 10 hands):
    // • Premium user  → referrer gets +3000 after referred plays 10 hands
    // • Regular user  → referrer gets +1000 after referred plays 10 hands
    // Also handles existing users who join via referral link for the first time
    const referralJustSet = referrerId && (isNew || !hadReferral)
    if (referralJustSet) {
      const isPremium = tgUser.is_premium === true
      const bonus = isPremium ? 3000 : 1000
      await db.query(
        `UPDATE pf_users SET referral_bonus = $1 WHERE tg_id=$2 AND (referral_bonus IS NULL OR referral_bonus = 0)`,
        [bonus, tgId]
      ).catch(() => {})
      // Credit handled in wsServer.ts saveHandStats() after 10 hands
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

    // CS:GO-style case rarities
    const rand = Math.random()
    let rarity: string, pool: number[]
    if (rand < 0.02)       { rarity = 'red';    pool = [4000, 6000, 10000] }
    else if (rand < 0.05)  { rarity = 'purple'; pool = [1500, 2000, 2500] }
    else if (rand < 0.10)  { rarity = 'blue';   pool = [800, 900, 1000] }
    else if (rand < 0.20)  { rarity = 'green';  pool = [400, 500, 600] }
    else                   { rarity = 'grey';   pool = [100, 200, 300] }
    const prize = pool[Math.floor(Math.random() * pool.length)]

    const { rows: updated } = await db.query(
      `UPDATE pf_users SET chips = chips + $1, last_spin_at = NOW() WHERE tg_id=$2 RETURNING *`,
      [prize, String(tgUser.id)]
    )
    await logTransaction(String(tgUser.id), 'spin', prize, `Daily case: ${rarity} chest · +${prize.toLocaleString()} chips`)

    res.json({ prize, chips: updated[0].chips, rarity })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: 'server error' })
  }
})

// POST /api/payments/ton-verify — check blockchain for payment by ref comment
app.post('/api/payments/ton-verify', async (req, res) => {
  try {
    const { initData, packageId, ref } = req.body as { initData?: string; packageId?: string; ref?: string }
    if (!initData || !packageId || !ref) return res.status(400).json({ error: 'missing params' })

    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid initData' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })

    const WALLET = 'UQDDVM1Q9ZgEhz0XKpSelJ3tRTmU8VuU29Ls7ihMKH0ABAwT'
    const TON_PACKAGES: Record<string, { chips: number; nanotons: number }> = {
      pack10:  { chips:  10_000, nanotons: 500_000_000 },
      pack30:  { chips:  30_000, nanotons: 1_000_000_000 },
      pack100: { chips: 100_000, nanotons: 3_000_000_000 },
      pack250: { chips: 250_000, nanotons: 6_000_000_000 },
      pack500: { chips: 500_000, nanotons: 10_000_000_000 },
    }
    const pkg = TON_PACKAGES[packageId]
    if (!pkg) return res.status(400).json({ error: 'unknown package' })

    const db = getPool()
    const tgId = String(tgUser.id)

    // Query tonapi.io for recent incoming transactions
    const tonRes = await fetch(
      `https://tonapi.io/v2/blockchain/accounts/${WALLET}/transactions?limit=50`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!tonRes.ok) return res.status(502).json({ error: 'blockchain unavailable' })
    const tonData = await tonRes.json() as any

    const txList = (tonData.transactions as any[]) || []
    const twoHoursAgo = Math.floor(Date.now() / 1000) - 7200

    // 1st: exact ref match (ref contains tgId + packageId + timestamp)
    let tx = txList.find((t: any) => {
      const msg = t.in_msg
      if (!msg) return false
      const comment = msg.decoded_body?.text || ''
      const value = Number(msg.value || 0)
      return comment === ref && value >= pkg.nanotons * 0.95
    })

    // 2nd fallback: comment must start with THIS user's prefix (pf_{tgId}_{packageId}_)
    // so we never accidentally match another user's transaction
    if (!tx) {
      const userRefPrefix = `pf_${tgId}_${packageId}_`
      tx = txList.find((t: any) => {
        const msg = t.in_msg
        if (!msg) return false
        const value = Number(msg.value || 0)
        const utime = Number(t.utime || 0)
        const comment = msg.decoded_body?.text || ''
        const rightAmount = value >= pkg.nanotons * 0.95 && value <= pkg.nanotons * 1.05
        const recent = utime >= twoHoursAgo
        const isOwnRef = comment.startsWith(userRefPrefix)
        return rightAmount && recent && isOwnRef
      })
    }

    if (!tx) return res.json({ found: false })

    // Deduplicate by tx hash — use RETURNING to detect if INSERT actually happened.
    // ON CONFLICT DO NOTHING silently skips; without checking the result we would
    // still credit chips for an already-credited transaction.
    const txId = `tonapi_${tx.hash || tx.utime}`
    const { rows: inserted } = await db.query(
      'INSERT INTO pf_ton_payments (boc_hash, tg_id, package_id, chips) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING boc_hash',
      [txId, tgId, packageId, pkg.chips]
    )
    // If no row returned the tx was already credited — stop here
    if (inserted.length === 0) return res.status(409).json({ error: 'already_used' })

    const { rows } = await db.query(
      'UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING chips',
      [pkg.chips, tgId]
    )
    if (!rows[0]) return res.status(404).json({ error: 'user not found' })
    await logTransaction(tgId, 'purchase', pkg.chips, `Bought ${pkg.chips.toLocaleString()} chips (TON verified)`)

    res.json({ found: true, chips: rows[0].chips })
  } catch (e: any) {
    console.error('ton-verify error:', e?.message || e)
    res.status(500).json({ error: e?.message || 'server error' })
  }
})

// POST /api/payments/ton-confirm — verify TON payment and credit chips
app.post('/api/payments/ton-confirm', async (req, res) => {
  try {
    const { initData, packageId, bocHash } = req.body as { initData?: string; packageId?: string; bocHash?: string }
    if (!initData || !packageId || !bocHash) return res.status(400).json({ error: 'missing params' })

    const params = validateTgInitData(initData)
    if (!params) {
      console.error('ton-confirm: invalid initData, token set:', !!process.env.BOT_TOKEN)
      return res.status(403).json({ error: 'invalid initData' })
    }

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

    // Check for double-spend
    const { rows: existing } = await db.query(
      'SELECT 1 FROM pf_ton_payments WHERE boc_hash=$1', [bocHash]
    )
    if (existing.length > 0) return res.status(409).json({ error: 'already_used' })

    // Record payment atomically then credit
    await db.query(
      'INSERT INTO pf_ton_payments (boc_hash, tg_id, package_id, chips) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [bocHash, String(tgUser.id), packageId, pkg.chips]
    )
    const { rows } = await db.query(
      'UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2 RETURNING *',
      [pkg.chips, String(tgUser.id)]
    )
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

// GET /api/hand-history/:tableId — last 20 hands at this table
app.get('/api/hand-history/:tableId', async (req, res) => {
  try {
    const db = getPool()
    const { rows } = await db.query(
      `SELECT id, board, players, winners, pot, created_at FROM pf_hand_history WHERE table_id=$1 ORDER BY created_at DESC LIMIT 20`,
      [req.params.tableId]
    )
    res.json(rows)
  } catch (e) { res.status(500).json({ error: 'server error' }) }
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
    // Exclude per-hand 'win' events — too noisy. Show only meaningful activity:
    // table_join, table_leave, claim, purchase, tournament, spin, admin
    const { rows } = await db.query(
      `SELECT type, amount, description AS desc, created_at FROM pf_transactions
       WHERE tg_id=$1 AND type != 'win'
       ORDER BY created_at DESC LIMIT 50`,
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

// GET /api/balance — lightweight chips check (no DB writes)
app.get('/api/balance', async (req, res) => {
  try {
    const initData = req.headers['x-init-data'] as string
    if (!initData) return res.status(400).json({ error: 'no initData' })
    const params = validateTgInitData(initData)
    if (!params) return res.status(403).json({ error: 'invalid' })
    const tgUser = parseTgUser(params)
    if (!tgUser?.id) return res.status(400).json({ error: 'no user' })
    const db = getPool()
    const { rows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [String(tgUser.id)])
    if (!rows[0]) return res.status(404).json({ error: 'user not found' })
    res.json({ chips: rows[0].chips, tg_id: String(tgUser.id) })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || 'server error' })
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

// Fetch photo file_id from Bot API and store it (file_id doesn't expire)
async function fetchAndSavePhoto(tgId: string, botToken: string) {
  try {
    const r1 = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${tgId}&limit=1`)
    const d1 = await r1.json() as any
    if (!d1.ok || !d1.result?.photos?.length) return

    // Store the file_id (permanent) instead of the expiring file URL
    const fileId = d1.result.photos[0][2]?.file_id || d1.result.photos[0][0]?.file_id
    if (!fileId) return
    const db = getPool()
    await db.query('UPDATE pf_users SET photo_url=$1 WHERE tg_id=$2', [`tgfile:${fileId}`, tgId])
  } catch {}
}

// GET /api/avatar/:tgId — proxy Telegram profile photo (keeps bot token server-side)
app.get('/api/avatar/:tgId', async (req, res) => {
  try {
    const { tgId } = req.params
    const botToken = process.env.BOT_TOKEN
    if (!botToken) return res.status(404).end()

    const db = getPool()
    const { rows } = await db.query('SELECT photo_url FROM pf_users WHERE tg_id=$1', [tgId])
    let fileId: string | null = null

    if (rows[0]?.photo_url?.startsWith('tgfile:')) {
      fileId = rows[0].photo_url.slice(7) // strip 'tgfile:' prefix
    } else {
      // Fall back to fetching fresh
      const r1 = await fetch(`https://api.telegram.org/bot${botToken}/getUserProfilePhotos?user_id=${tgId}&limit=1`)
      const d1 = await r1.json() as any
      if (!d1.ok || !d1.result?.photos?.length) return res.status(404).end()
      fileId = d1.result.photos[0][2]?.file_id || d1.result.photos[0][0]?.file_id
      if (fileId) {
        await db.query('UPDATE pf_users SET photo_url=$1 WHERE tg_id=$2', [`tgfile:${fileId}`, tgId]).catch(() => {})
      }
    }

    if (!fileId) return res.status(404).end()

    const r2 = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`)
    const d2 = await r2.json() as any
    if (!d2.ok || !d2.result?.file_path) return res.status(404).end()

    const imgResp = await fetch(`https://api.telegram.org/file/bot${botToken}/${d2.result.file_path}`)
    if (!imgResp.ok) return res.status(404).end()

    res.setHeader('Content-Type', imgResp.headers.get('content-type') || 'image/jpeg')
    res.setHeader('Cache-Control', 'public, max-age=3600')
    const buf = Buffer.from(await imgResp.arrayBuffer())
    res.send(buf)
  } catch {
    res.status(404).end()
  }
})

const server = createServer(app)
const wss = new WebSocketServer({ server })

setupWS(wss)

const PORT = process.env.PORT || 3002
server.listen(PORT, () => console.log(`\n♠️ PokerFlip server → http://localhost:${PORT}\n   WebSocket → ws://localhost:${PORT}\n`))
initDB().catch(e => console.error('DB init warning:', e))
setInterval(checkTournamentAutoStart, 60_000)
setInterval(checkTournamentReset, 5 * 60_000)
setInterval(checkStaleRegistrations, 5 * 60_000)
checkStaleRegistrations() // run once on startup to clean old regs
