import { WebSocket, WebSocketServer } from 'ws'
import { GameState, createTable, addPlayer, removePlayer, startHand, applyAction, canStart, maskForPlayer, PlayerAction } from './engine/game'
import { getPool, logTransaction } from './db'

interface Client {
  ws: WebSocket
  playerId: string
  playerName: string
  tableId: string
}

const tables = new Map<string, GameState>()
const clients = new Map<WebSocket, Client>()

const startTimers = new Map<string, NodeJS.Timeout>()
const actionTimers = new Map<string, NodeJS.Timeout>()
const afkTimers = new Map<string, NodeJS.Timeout>()   // key: tableId:playerId
const playerBanks = new Map<string, number>()          // key: tableId:playerId → chips left in bank (DB - buyIn)

const TABLE_CONFIG: Record<string, { sb: number; bb: number; minBuyIn: number; maxPlayers?: number }> = {
  // NL Hold'em
  main:     { sb: 10,  bb: 20,  minBuyIn: 400 },
  shadow:   { sb: 25,  bb: 50,  minBuyIn: 1000 },
  crimson:  { sb: 50,  bb: 100, minBuyIn: 2000 },
  obsidian: { sb: 100, bb: 200, minBuyIn: 5000 },
  // Limit Hold'em
  limit1:   { sb: 10,  bb: 20,  minBuyIn: 400 },
  limit2:   { sb: 25,  bb: 50,  minBuyIn: 1000 },
  limit3:   { sb: 50,  bb: 100, minBuyIn: 2000 },
  limit4:   { sb: 100, bb: 200, minBuyIn: 5000 },
  // 1v1 Heads Up
  heads1:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  heads2:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  heads3:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  heads4:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  // Tournaments
  daily:    { sb: 50,  bb: 100, minBuyIn: 2000 },
  weekly:   { sb: 100, bb: 200, minBuyIn: 5000 },
}
const ACTION_TIMEOUT_MS = 30_000

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws) => {
    console.log('WS connected')

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        handleMessage(ws, msg)
      } catch (e) {
        send(ws, { type: 'error', message: 'Invalid message' })
      }
    })

    ws.on('close', () => handleDisconnect(ws))
    ws.on('error', () => handleDisconnect(ws))
  })
}

function handleMessage(ws: WebSocket, msg: any) {
  const { type } = msg

  if (type === 'join') {
    handleJoin(ws, msg).catch(e => {
      console.error('Join error:', e)
      send(ws, { type: 'error', message: 'Server error joining table' })
    })
    return
  }

  const client = clients.get(ws)
  if (!client) return send(ws, { type: 'error', message: 'Not joined' })
  const { playerId, tableId } = client

  if (type === 'action') {
    const { action, amount } = msg as { action: PlayerAction; amount?: number }
    let state = tables.get(tableId)
    if (!state) return
    const prevStreet = state.street
    state = applyAction(state, playerId, action, amount)
    tables.set(tableId, state)
    clearActionTimer(tableId)
    broadcastTable(tableId)

    if (state.street === 'showdown' && prevStreet !== 'showdown') {
      saveHandStats(state).catch(e => console.error('stats error:', e))
      setTimeout(() => {
        let s = tables.get(tableId)
        if (!s) return
        if (canStart(s)) { s = startHand(s); tables.set(tableId, s) }
        else s.street = 'waiting'
        broadcastTable(tableId)
        setActionTimer(tableId)
      }, 4000)
    } else {
      setActionTimer(tableId)
    }
    return
  }

  if (type === 'start') {
    let state = tables.get(tableId)
    if (!state || !canStart(state)) return send(ws, { type: 'error', message: 'Need 2+ players' })
    state = startHand(state)
    tables.set(tableId, state)
    broadcastTable(tableId)
    setActionTimer(tableId)
    return
  }

  if (type === 'chat') {
    broadcastToTable(tableId, { type: 'chat', playerId, playerName: client.playerName, message: String(msg.message).slice(0, 200) })
    return
  }

  // Emoji reaction — broadcast to all at table
  if (type === 'reaction') {
    const emoji = String(msg.emoji || '👏').slice(0, 2)
    broadcastToTable(tableId, { type: 'reaction', playerId, playerName: client.playerName, emoji })
    return
  }

  // Show own cards voluntarily (after fold or at showdown)
  if (type === 'show_cards') {
    const { tableId, playerId } = client
    const state = tables.get(tableId)
    if (!state) return
    const player = state.players.find(p => p.id === playerId)
    if (!player || !player.holeCards?.length) return
    const count = Number(msg.count) === 1 ? 1 : 2
    const cards = player.holeCards.filter(c => (c.rank as string) !== '?').slice(0, count)
    if (!cards.length) return
    broadcastToTable(tableId, { type: 'cards_shown', playerId, playerName: client.playerName, cards })
    return
  }

  if (type === 'ping') {
    send(ws, { type: 'pong' })
    return
  }
}

function handleDisconnect(ws: WebSocket) {
  const client = clients.get(ws)
  if (!client) return
  clients.delete(ws)

  const { tableId, playerId } = client
  let state = tables.get(tableId)
  if (!state) return

  // Save chips: bankChips (what's in DB) + table chips
  const player = state.players.find(p => p.id === playerId)
  if (player && process.env.DATABASE_URL) {
    const bankKey = `${tableId}:${playerId}`
    const bank = playerBanks.get(bankKey) ?? 0
    const totalToSave = bank + player.chips
    getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [totalToSave, playerId])
      .catch(e => console.error('Failed to save chips on disconnect:', e))
    if (player.chips !== 0) {
      logTransaction(playerId, 'table_leave', player.chips, `Cash out from ${tableId} (${player.chips.toLocaleString()} chips)`)
    }
  }

  // Mark as AFK/disconnected (not removed yet — give 30s to reconnect)
  state = removePlayer(state, playerId)
  tables.set(tableId, state)
  broadcastTable(tableId)

  // Fold disconnected player quickly — either they're already due to act,
  // or foldDisconnectedPlayers will handle it when their turn comes.
  const inActiveHand = state.street !== 'waiting' && state.street !== 'showdown'
  if (inActiveHand) {
    // Small delay so state is stable, then resolve stuck hand
    setTimeout(() => foldDisconnectedPlayers(tableId), 600)
  }

  // After 30s without reconnect — actually remove the player slot
  const afkKey = `${tableId}:${playerId}`
  const existingAfk = afkTimers.get(afkKey)
  if (existingAfk) clearTimeout(existingAfk)

  const afkTimer = setTimeout(() => {
    afkTimers.delete(afkKey)
    playerBanks.delete(`${tableId}:${playerId}`)
    let s = tables.get(tableId)
    if (!s) return
    const p = s.players.find(pp => pp.id === playerId)
    if (p && !p.connected) {
      s.players = s.players.filter(pp => pp.id !== playerId)
      tables.set(tableId, s)
      broadcastTable(tableId)
      console.log(`Player ${playerId} AFK timeout — removed from ${tableId}`)
    }
  }, 30_000)
  afkTimers.set(afkKey, afkTimer)

  console.log(`Player ${playerId} disconnected (AFK timer started), chips: ${player?.chips}`)
}

function scheduleStart(tableId: string) {
  if (startTimers.has(tableId)) return
  const timer = setTimeout(() => {
    startTimers.delete(tableId)
    let state = tables.get(tableId)
    if (!state || !canStart(state) || state.street !== 'waiting') return
    state = startHand(state)
    tables.set(tableId, state)
    broadcastTable(tableId)
    setActionTimer(tableId)
  }, 3000)
  startTimers.set(tableId, timer)
}

// Fold all disconnected players who need to act, until a connected player's turn.
// Called after any disconnect to quickly resolve stuck hands.
function foldDisconnectedPlayers(tableId: string) {
  let s = tables.get(tableId)
  if (!s || s.street === 'waiting' || s.street === 'showdown') return
  const p = s.players[s.actionIdx]
  if (!p || p.folded || p.allIn) return
  if (p.connected) return // connected player — let them act normally

  clearActionTimer(tableId)
  s = applyAction(s, p.id, 'fold')
  tables.set(tableId, s)
  broadcastTable(tableId)

  if (s.street === 'showdown') {
    saveHandStats(s).catch(console.error)
    setTimeout(() => {
      let s2 = tables.get(tableId)
      if (!s2) return
      s2 = canStart(s2) ? startHand(s2) : { ...s2, street: 'waiting' as any }
      tables.set(tableId, s2)
      broadcastTable(tableId)
      setActionTimer(tableId)
    }, 2000) // shorter delay when auto-resolved
  } else {
    // Recurse — next player might also be disconnected
    setTimeout(() => foldDisconnectedPlayers(tableId), 150)
    setActionTimer(tableId)
  }
}

function setActionTimer(tableId: string) {
  clearActionTimer(tableId)
  let state = tables.get(tableId)
  if (state) {
    const p = state.players[state.actionIdx]
    // Disconnected player at the wheel — fold them immediately (no 30s wait)
    if (p && !p.folded && !p.allIn && !p.connected) {
      const timer = setTimeout(() => foldDisconnectedPlayers(tableId), 800)
      actionTimers.set(tableId, timer)
      return
    }
  }
  const timer = setTimeout(() => {
    let state = tables.get(tableId)
    if (!state || state.street === 'waiting' || state.street === 'showdown') return
    const p = state.players[state.actionIdx]
    if (!p || p.folded || p.allIn) { setActionTimer(tableId); return }
    state = applyAction(state, p.id, 'fold')
    tables.set(tableId, state)
    broadcastTable(tableId)
    if (state.street === 'showdown') {
      saveHandStats(state).catch(console.error)
      setTimeout(() => {
        let s = tables.get(tableId)
        if (!s) return
        s = canStart(s) ? startHand(s) : { ...s, street: 'waiting' as any }
        tables.set(tableId, s)
        broadcastTable(tableId)
        setActionTimer(tableId)
      }, 4000)
    } else {
      setActionTimer(tableId)
    }
  }, ACTION_TIMEOUT_MS)
  actionTimers.set(tableId, timer)
}

function clearActionTimer(tableId: string) {
  const t = actionTimers.get(tableId)
  if (t) { clearTimeout(t); actionTimers.delete(tableId) }
}

function broadcastTable(tableId: string) {
  const state = tables.get(tableId)
  if (!state) return

  // Send each player their own masked view
  for (const [ws, client] of clients) {
    if (client.tableId !== tableId) continue
    if (ws.readyState !== WebSocket.OPEN) continue
    const masked = maskForPlayer(state, client.playerId)
    send(ws, { type: 'state', state: masked })
  }
}

function broadcastToTable(tableId: string, msg: object) {
  for (const [ws, client] of clients) {
    if (client.tableId === tableId && ws.readyState === WebSocket.OPEN) send(ws, msg)
  }
}

function send(ws: WebSocket, msg: object) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

export function getTableStats(): Record<string, { players: number; maxPlayers: number; street: string }> {
  const stats: Record<string, { players: number; maxPlayers: number; street: string }> = {}
  for (const [tableId, state] of tables) {
    const config = TABLE_CONFIG[tableId] || TABLE_CONFIG.main
    stats[tableId] = {
      players: state.players.filter(p => p.connected).length,
      maxPlayers: config.maxPlayers || 6,
      street: state.street,
    }
  }
  return stats
}

const TOURNAMENT_TABLE_IDS = new Set(['daily', 'weekly'])

async function handleJoin(ws: WebSocket, msg: any) {
  const { tableId = 'main', playerId, playerName, buyIn: requestedBuyIn } = msg
  if (!playerId || !playerName) return send(ws, { type: 'error', message: 'Need playerId and playerName' })

  const config = TABLE_CONFIG[tableId] || TABLE_CONFIG.main

  // Tournament access control: only registered players during active status
  if (TOURNAMENT_TABLE_IDS.has(tableId) && process.env.DATABASE_URL) {
    try {
      const db = getPool()
      const [statusRes, regRes] = await Promise.all([
        db.query(`SELECT status FROM pf_tournament_status WHERE tournament_id=$1`, [tableId]),
        db.query(`SELECT 1 FROM pf_tournament_regs WHERE tournament_id=$1 AND tg_id=$2`, [tableId, playerId]),
      ])
      const status = statusRes.rows[0]?.status || 'pending'
      const isRegistered = regRes.rows.length > 0
      if (status !== 'active') {
        return send(ws, { type: 'error', message: 'Tournament has not started yet', code: 'tournament_not_active' })
      }
      if (!isRegistered) {
        return send(ws, { type: 'error', message: 'You are not registered for this tournament', code: 'tournament_not_registered' })
      }
    } catch (e) {
      console.error('Tournament access check error:', e)
    }
  }

  // Load total chips from DB
  let totalChips = config.minBuyIn
  if (process.env.DATABASE_URL) {
    try {
      const db = getPool()
      const { rows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [playerId])
      if (rows[0]) totalChips = rows[0].chips
    } catch (e) {
      console.error('Failed to load chips:', e)
    }
  }

  // Check min buy-in against total chips
  if (totalChips < config.minBuyIn) {
    return send(ws, { type: 'error', message: `Need at least ${config.minBuyIn} chips for this table`, code: 'insufficient_chips', required: config.minBuyIn, have: totalChips })
  }

  // Use requested buy-in if valid, otherwise use total chips
  const maxBuyIn = Math.min(totalChips, config.bb * 200)
  const playerChips = requestedBuyIn
    ? Math.max(config.minBuyIn, Math.min(requestedBuyIn, totalChips))
    : Math.min(totalChips, maxBuyIn)

  // Declare maxPlayers early (needed for reconnect path too)
  const maxPlayers = config.maxPlayers || 6

  // Cancel any pending AFK removal timer for this player
  const afkKey = `${tableId}:${playerId}`
  const pendingAfk = afkTimers.get(afkKey)
  if (pendingAfk) { clearTimeout(pendingAfk); afkTimers.delete(afkKey) }

  // Get or create table with correct blinds
  if (!tables.has(tableId)) tables.set(tableId, createTable(tableId, config.sb, config.bb))
  let state = tables.get(tableId)!

  // Handle reconnection — player already at this table but disconnected
  const reconnectingPlayer = state.players.find(p => p.id === playerId && !p.connected)
  if (reconnectingPlayer) {
    state = addPlayer(state, playerId, playerName, reconnectingPlayer.chips, reconnectingPlayer.seatIndex)
    tables.set(tableId, state)
    clients.set(ws, { ws, playerId, playerName, tableId })
    broadcastTable(tableId)
    send(ws, { type: 'joined', playerId, tableId, chips: reconnectingPlayer.chips, maxPlayers })
    console.log(`Player ${playerId} reconnected to ${tableId} with ${reconnectingPlayer.chips} chips`)
    return
  }

  // Check max players
  if (state.players.filter(p => p.connected).length >= maxPlayers) {
    return send(ws, { type: 'error', message: 'Table is full', code: 'table_full' })
  }

  // Find free seat
  const allSeats = Array.from({ length: maxPlayers }, (_, i) => i)
  const takenSeats = state.players.map(p => p.seatIndex)
  const seat = allSeats.find(s => !takenSeats.includes(s)) ?? 0

  state = addPlayer(state, playerId, playerName, playerChips, seat)
  tables.set(tableId, state)
  clients.set(ws, { ws, playerId, playerName, tableId })

  // Store bank chips (what remains in DB = totalChips - buyIn)
  const bankChips = totalChips - playerChips
  playerBanks.set(`${tableId}:${playerId}`, bankChips)

  // Deduct buy-in from DB now; will add back table chips on leave
  if (process.env.DATABASE_URL) {
    getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [bankChips, playerId])
      .catch(e => console.error('Failed to deduct buy-in:', e))
    logTransaction(playerId, 'table_join', -playerChips, `Buy-in at ${tableId} (${playerChips.toLocaleString()} chips)`)
  }

  broadcastTable(tableId)
  send(ws, { type: 'joined', playerId, tableId, chips: playerChips, maxPlayers })
  scheduleStart(tableId)
}

async function saveHandStats(state: GameState) {
  if (!process.env.DATABASE_URL) return
  const db = getPool()
  const winnerIds = new Set(state.winners.map(w => w.playerId))

  for (const player of state.players) {
    if (!player.connected) continue
    const isWinner = winnerIds.has(player.id)
    const wonAmount = state.winners.find(w => w.playerId === player.id)?.amount || 0

    // Total chips = bank (outside table) + current table chips
    const bankKey = `${state.tableId}:${player.id}`
    const bank = playerBanks.get(bankKey) ?? 0
    const totalChips = bank + player.chips

    const { rows: updated } = await db.query(
      `UPDATE pf_users SET
        chips        = $1,
        hands_played = hands_played + 1,
        hands_won    = hands_won + $2,
        biggest_pot  = GREATEST(biggest_pot, $3)
       WHERE tg_id = $4
       RETURNING hands_played, referred_by, referral_credited, referral_bonus`,
      [totalChips, isWinner ? 1 : 0, isWinner ? wonAmount : 0, player.id]
    ).catch(() => ({ rows: [] as any[] }))

    if (isWinner && wonAmount > 0) {
      await logTransaction(player.id, 'win', wonAmount, `Won hand at table ${state.tableId}`)
    }

    // Anti-bot referral: +bonus to referrer after 10 hands (premium=3000, regular=1000)
    const row = updated[0]
    if (row && row.hands_played >= 10 && row.referred_by && !row.referral_credited) {
      const bonus = row.referral_bonus || 1000
      await db.query(
        `UPDATE pf_users SET chips = chips + $1, referrals_count = referrals_count + 1 WHERE tg_id = $2`,
        [bonus, row.referred_by]
      ).catch(() => {})
      await db.query(
        `UPDATE pf_users SET referral_credited = TRUE WHERE tg_id = $1`,
        [player.id]
      ).catch(() => {})
      await logTransaction(row.referred_by, 'referral', bonus, `Referral bonus: ${player.id} completed 10 hands`)
      console.log(`Referral credited: ${player.id} → referrer ${row.referred_by} +${bonus}`)
    }
  }
  console.log(`Hand saved: winners=${[...winnerIds].join(',')}`)

  // Tournament end: if only 1 player has chips left → distribute prizes
  if (TOURNAMENT_TABLE_IDS.has(state.tableId)) {
    await checkTournamentEnd(state).catch(e => console.error('Tournament end check error:', e))
  }
}

async function checkTournamentEnd(state: GameState) {
  const db = getPool()
  const tableId = state.tableId
  // Players with 0 chips are eliminated
  const alive = state.players.filter(p => {
    const bank = playerBanks.get(`${tableId}:${p.id}`) ?? 0
    return (bank + p.chips) > 0
  })
  if (alive.length > 1) return // still playing

  // Get tournament prize pool
  const { rows: regRows } = await db.query(
    `SELECT COUNT(*) as cnt FROM pf_tournament_regs WHERE tournament_id=$1`, [tableId]
  ).catch(() => ({ rows: [{ cnt: 0 }] }))
  const registered = Number(regRows[0]?.cnt || 0)

  const CONFIGS: Record<string, { basePrize: number; buyIn: number }> = {
    daily:  { basePrize: 50_000, buyIn: 2_000 },
    weekly: { basePrize: 300_000, buyIn: 5_000 },
  }
  const cfg = CONFIGS[tableId]
  if (!cfg) return
  const prizePool = Math.max(cfg.basePrize, registered * cfg.buyIn)

  // Calculate prize tiers (same logic as index.ts)
  const tiers =
    registered <= 4  ? [{ place: 1, pct: 60 }, { place: 2, pct: 40 }]
    : registered <= 8  ? [{ place: 1, pct: 50 }, { place: 2, pct: 30 }, { place: 3, pct: 20 }]
    :                    [{ place: 1, pct: 40 }, { place: 2, pct: 25 }, { place: 3, pct: 15 }, { place: 4, pct: 12 }, { place: 5, pct: 8 }]

  // Winner is the last alive player
  const winner = alive[0] || state.players[0]
  if (!winner) return

  // Award winner
  const winnerPrize = Math.floor(prizePool * tiers[0].pct / 100)
  await db.query(
    `UPDATE pf_users SET chips = chips + $1, tournaments_won = tournaments_won + 1 WHERE tg_id=$2`,
    [winnerPrize, winner.id]
  ).catch(() => {})
  await logTransaction(winner.id, 'tournament_win', winnerPrize, `Won ${tableId} tournament! 🏆 +${winnerPrize.toLocaleString()} chips`)

  // Save to history
  await db.query(
    `INSERT INTO pf_tournament_history (tournament_id, winner_tg_id, winner_name, prize, players_count, prize_pool)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tableId, winner.id, winner.name, winnerPrize, registered, prizePool]
  ).catch(() => {})

  // Mark tournament as finished, reset registrations for next cycle
  await db.query(
    `UPDATE pf_tournament_status SET status='finished' WHERE tournament_id=$1`, [tableId]
  ).catch(() => {})
  await db.query(
    `DELETE FROM pf_tournament_regs WHERE tournament_id=$1`, [tableId]
  ).catch(() => {})

  console.log(`Tournament ${tableId} ended! Winner: ${winner.id}, prize: ${winnerPrize}`)

  // Broadcast tournament end to all players at the table
  broadcastToTable(tableId, {
    type: 'tournament_end',
    winnerId: winner.id,
    winnerName: winner.name,
    prize: winnerPrize,
    tableId,
  })
}
