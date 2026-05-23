import { getPool, logTransaction } from './db'

export const SF_CONFIGS = {
  sf_rush: {
    name: 'Flip Rush',
    buyIn: 10_000,
    prizes:  [20_000, 30_000,  40_000,  50_000,  75_000, 100_000, 120_000, 150_000, 200_000,  250_000],
    weights: [55,     25,      10,      5,       2.5,    1.2,     0.7,     0.4,     0.15,     0.05],
    initBankroll: 100_000,
    sb: 50,  bb: 100,
  },
  sf_clash: {
    name: 'Flip Clash',
    buyIn: 30_000,
    prizes:  [60_000,  90_000, 120_000, 150_000, 200_000, 300_000, 400_000, 500_000, 600_000,  800_000, 1_000_000],
    weights: [40,      22,     13,      8,       5,       4,       3,       2,       1.5,      1,       0.5],
    initBankroll: 300_000,
    sb: 200, bb: 400,
  },
  sf_royale: {
    name: 'Flip Royale',
    buyIn: 50_000,
    prizes:  [100_000, 150_000, 250_000, 500_000, 750_000, 1_000_000, 1_250_000, 1_500_000, 2_000_000, 2_500_000],
    weights: [40,      25,      15,      8,       4,       3,         2,         1.5,       1,         0.5],
    initBankroll: 500_000,
    sb: 400, bb: 800,
  },
} as const

export type SFRoomId = keyof typeof SF_CONFIGS

export function getSFRoomId(tableId: string): SFRoomId | null {
  const m = tableId.match(/^(sf_(?:rush|clash|royale))_\d+$/)
  return (m?.[1] as SFRoomId) ?? null
}

export function getSFConfig(tableId: string) {
  const roomId = getSFRoomId(tableId)
  return roomId ? SF_CONFIGS[roomId] : null
}

export function getSFTableConfig(tableId: string) {
  const cfg = getSFConfig(tableId)
  if (!cfg) return null
  return { sb: cfg.sb, bb: cfg.bb, minBuyIn: cfg.buyIn, maxPlayers: 3 }
}

function pickPrize(roomId: SFRoomId, bankroll: number): number {
  const cfg = SF_CONFIGS[roomId]
  const eligible = cfg.prizes
    .map((p, i) => ({ prize: p as number, weight: cfg.weights[i] as number }))
    .filter(e => e.prize <= bankroll)
  if (eligible.length === 0) return cfg.prizes[0]
  const total = eligible.reduce((s, e) => s + e.weight, 0)
  let r = Math.random() * total
  for (const { prize, weight } of eligible) {
    r -= weight
    if (r <= 0) return prize
  }
  return eligible[eligible.length - 1].prize
}

export async function registerForSF(
  tgId: string, roomId: SFRoomId
): Promise<{ sessionId: number; playerCount: number; prize?: number; tableId?: string; status: 'registered' | 'session_started' | 'already_registered' }> {
  const db = getPool()
  const cfg = SF_CONFIGS[roomId]

  // Already in an open session?
  const { rows: ex } = await db.query(
    `SELECT sr.session_id FROM pf_sf_registrations sr
     JOIN pf_sf_sessions ss ON ss.id = sr.session_id
     WHERE sr.tg_id=$1 AND ss.room_id=$2 AND ss.status IN ('waiting','ready')`,
    [tgId, roomId]
  )
  if (ex.length) {
    const { rows: sRows } = await db.query(
      `SELECT id, status, prize, table_id,
       (SELECT COUNT(*) FROM pf_sf_registrations WHERE session_id=pf_sf_sessions.id) AS cnt
       FROM pf_sf_sessions WHERE id=$1`, [ex[0].session_id]
    )
    const s = sRows[0]
    return {
      sessionId: s.id, playerCount: Number(s.cnt),
      prize: s.prize, tableId: s.table_id,
      status: s.status === 'ready' ? 'session_started' : 'already_registered',
    }
  }

  // Check balance
  const { rows: ur } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [tgId])
  if (!ur[0] || ur[0].chips < cfg.buyIn) throw new Error(`Need ${cfg.buyIn.toLocaleString()} chips`)

  // Get or create waiting session
  const { rows: ws } = await db.query(
    `SELECT id FROM pf_sf_sessions WHERE room_id=$1 AND status='waiting' ORDER BY id ASC LIMIT 1`, [roomId]
  )
  let sessionId: number
  if (ws.length) {
    sessionId = ws[0].id
  } else {
    const { rows: ns } = await db.query(
      `INSERT INTO pf_sf_sessions (room_id, status) VALUES ($1,'waiting') RETURNING id`, [roomId]
    )
    sessionId = ns[0].id
  }

  // Register + deduct buy-in atomically
  await db.query(`INSERT INTO pf_sf_registrations (session_id, tg_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [sessionId, tgId])
  await db.query('UPDATE pf_users SET chips = chips - $1 WHERE tg_id=$2', [cfg.buyIn, tgId])
  await logTransaction(tgId, 'sf_entry', -cfg.buyIn, `Spin & Flip entry: ${cfg.name}`)

  const { rows: cr } = await db.query(
    `SELECT COUNT(*) as cnt FROM pf_sf_registrations WHERE session_id=$1`, [sessionId]
  )
  const playerCount = Number(cr[0].cnt)
  if (playerCount < 3) return { sessionId, playerCount, status: 'registered' }

  // 3rd player — pick prize, mark ready
  const { rows: br } = await db.query(`SELECT chips FROM pf_sf_bankroll WHERE room_id=$1`, [roomId])
  const bankroll = Number(br[0]?.chips ?? cfg.initBankroll)
  const prize = pickPrize(roomId, Math.max(bankroll, cfg.prizes[0]))
  const tableId = `${roomId}_${sessionId}`
  const netBankChange = cfg.buyIn * 3 - prize  // positive = house profit, negative = jackpot paid out

  await db.query(
    `UPDATE pf_sf_sessions SET status='ready', prize=$1, table_id=$2, started_at=NOW() WHERE id=$3`,
    [prize, tableId, sessionId]
  )
  await db.query(
    `INSERT INTO pf_sf_bankroll (room_id, chips, total_in, total_out, rounds)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (room_id) DO UPDATE SET
       chips     = GREATEST(0, pf_sf_bankroll.chips + $5),
       total_in  = pf_sf_bankroll.total_in  + $3,
       total_out = pf_sf_bankroll.total_out + $4,
       rounds    = pf_sf_bankroll.rounds    + 1`,
    [roomId, Math.max(0, bankroll + netBankChange), cfg.buyIn * 3, prize, netBankChange]
  )

  return { sessionId, playerCount: 3, prize, tableId, status: 'session_started' }
}

export async function cancelSFRegistration(tgId: string, roomId: SFRoomId) {
  const db = getPool()
  const cfg = SF_CONFIGS[roomId]

  // Only cancel if session is still 'waiting' (not started)
  const { rows } = await db.query(
    `SELECT sr.session_id FROM pf_sf_registrations sr
     JOIN pf_sf_sessions ss ON ss.id = sr.session_id
     WHERE sr.tg_id = $1 AND ss.room_id = $2 AND ss.status = 'waiting'`,
    [tgId, roomId]
  )
  if (!rows[0]) throw new Error('No cancellable registration (game may have already started)')

  const sessionId = rows[0].session_id

  await db.query('DELETE FROM pf_sf_registrations WHERE session_id = $1 AND tg_id = $2', [sessionId, tgId])
  await db.query('UPDATE pf_users SET chips = chips + $1 WHERE tg_id = $2', [cfg.buyIn, tgId])
  await logTransaction(tgId, 'sf_cancel', cfg.buyIn, `Cancelled Spin & Flip entry: ${cfg.name}`)

  // Remove empty session
  const { rows: cnt } = await db.query(
    'SELECT COUNT(*)::int AS cnt FROM pf_sf_registrations WHERE session_id = $1', [sessionId]
  )
  if (Number(cnt[0].cnt) === 0) {
    await db.query('DELETE FROM pf_sf_sessions WHERE id = $1 AND status = $2', [sessionId, 'waiting'])
  }

  return { refunded: cfg.buyIn }
}

export async function getSFStatus(tgId?: string) {
  const db = getPool()
  const result: Record<string, any> = {}

  for (const [roomId, cfg] of Object.entries(SF_CONFIGS) as [SFRoomId, typeof SF_CONFIGS[SFRoomId]][]) {
    const { rows: sessions } = await db.query(
      `SELECT s.id, s.status, s.prize, s.table_id,
              COUNT(r.tg_id)::int AS player_count,
              ${tgId ? `MAX(CASE WHEN r.tg_id=$2 THEN 1 ELSE 0 END)::int AS is_reg` : `0 AS is_reg`}
       FROM pf_sf_sessions s
       LEFT JOIN pf_sf_registrations r ON r.session_id = s.id
       WHERE s.room_id=$1 AND s.status IN ('waiting','ready')
       GROUP BY s.id ORDER BY s.id ASC LIMIT 1`,
      tgId ? [roomId, tgId] : [roomId]
    )
    const { rows: br } = await db.query(`SELECT chips FROM pf_sf_bankroll WHERE room_id=$1`, [roomId])
    const s = sessions[0]
    result[roomId] = {
      name: cfg.name, buyIn: cfg.buyIn, prizes: cfg.prizes,
      bankroll: Number(br[0]?.chips ?? cfg.initBankroll),
      session: s ? {
        id: s.id, status: s.status, prize: s.prize,
        tableId: s.table_id, playerCount: Number(s.player_count),
        isRegistered: Number(s.is_reg) > 0,
      } : null,
    }
  }
  return result
}

export async function completeSFSession(sessionId: number, winnerId: string, winnerName: string) {
  const db = getPool()
  const { rows } = await db.query(
    `SELECT room_id, prize FROM pf_sf_sessions WHERE id=$1 AND status='ready'`, [sessionId]
  )
  if (!rows[0]) return null
  const { room_id: roomId, prize } = rows[0]
  const cfg = SF_CONFIGS[roomId as SFRoomId]
  if (!cfg) return null

  await db.query('UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2', [prize, winnerId])
  await logTransaction(winnerId, 'sf_win', prize, `Won Spin & Flip: ${cfg.name} 🎰`)
  await db.query(
    `UPDATE pf_sf_sessions SET status='done', winner_tg_id=$1, finished_at=NOW() WHERE id=$2`,
    [winnerId, sessionId]
  )
  console.log(`SF Session ${sessionId} done. Winner: ${winnerId}, Prize: ${prize}`)
  return { prize, roomId, winnerName }
}

export async function getSFAdminStats() {
  const db = getPool()
  const { rows } = await db.query(`
    SELECT b.room_id, b.chips AS bankroll, b.total_in, b.total_out,
           b.total_in - b.total_out AS net_burned, b.rounds
    FROM pf_sf_bankroll b ORDER BY b.room_id
  `)
  return rows
}
