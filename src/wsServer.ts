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

  // Save chips before removing player
  const player = state.players.find(p => p.id === playerId)
  if (player && process.env.DATABASE_URL) {
    getPool().query(
      'UPDATE pf_users SET chips = $1 WHERE tg_id = $2',
      [player.chips, playerId]
    ).catch(e => console.error('Failed to save chips on disconnect:', e))
  }

  state = removePlayer(state, playerId)
  tables.set(tableId, state)
  broadcastTable(tableId)
  console.log(`Player ${playerId} disconnected from ${tableId}, chips saved: ${player?.chips}`)
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

function setActionTimer(tableId: string) {
  clearActionTimer(tableId)
  const timer = setTimeout(() => {
    let state = tables.get(tableId)
    if (!state || state.street === 'waiting' || state.street === 'showdown') return
    const p = state.players[state.actionIdx]
    if (!p || p.folded || p.allIn) return
    // Auto-fold on timeout
    state = applyAction(state, p.id, 'fold')
    tables.set(tableId, state)
    broadcastTable(tableId)
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

async function handleJoin(ws: WebSocket, msg: any) {
  const { tableId = 'main', playerId, playerName } = msg
  if (!playerId || !playerName) return send(ws, { type: 'error', message: 'Need playerId and playerName' })

  const config = TABLE_CONFIG[tableId] || TABLE_CONFIG.main

  // Load chips from DB (fallback to minBuyIn if no DB)
  let playerChips = config.minBuyIn
  if (process.env.DATABASE_URL) {
    try {
      const db = getPool()
      const { rows } = await db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [playerId])
      if (rows[0]) playerChips = rows[0].chips
    } catch (e) {
      console.error('Failed to load chips:', e)
    }
  }

  // Check min buy-in
  if (playerChips < config.minBuyIn) {
    return send(ws, { type: 'error', message: `Need at least ${config.minBuyIn} chips for this table`, code: 'insufficient_chips', required: config.minBuyIn, have: playerChips })
  }

  // Get or create table with correct blinds
  if (!tables.has(tableId)) tables.set(tableId, createTable(tableId, config.sb, config.bb))
  let state = tables.get(tableId)!

  // Check max players
  const maxPlayers = config.maxPlayers || 6
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

  broadcastTable(tableId)
  send(ws, { type: 'joined', playerId, tableId, chips: playerChips })
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

    await db.query(
      `UPDATE pf_users SET
        chips        = $1,
        hands_played = hands_played + 1,
        hands_won    = hands_won + $2,
        biggest_pot  = GREATEST(biggest_pot, $3)
       WHERE tg_id = $4`,
      [player.chips, isWinner ? 1 : 0, isWinner ? wonAmount : 0, player.id]
    ).catch(() => {})

    if (isWinner && wonAmount > 0) {
      await logTransaction(player.id, 'win', wonAmount, `Won hand at table ${state.tableId}`)
    }
  }
  console.log(`Hand saved: winners=${[...winnerIds].join(',')}`)
}
