import { WebSocket, WebSocketServer } from 'ws'
import { GameState, createTable, addPlayer, removePlayer, startHand, applyAction, canStart, maskForPlayer, PlayerAction } from './engine/game'
import { getPool } from './db'

interface Client {
  ws: WebSocket
  playerId: string
  playerName: string
  tableId: string
}

const tables = new Map<string, GameState>()
const clients = new Map<WebSocket, Client>()

// Auto-start timer per table
const startTimers = new Map<string, NodeJS.Timeout>()
// Action timeout timers
const actionTimers = new Map<string, NodeJS.Timeout>()

const STARTING_CHIPS = 1000
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
    const { tableId = 'main', playerId, playerName } = msg
    if (!playerId || !playerName) return send(ws, { type: 'error', message: 'Need playerId and playerName' })

    // Get or create table
    if (!tables.has(tableId)) tables.set(tableId, createTable(tableId))
    let state = tables.get(tableId)!

    // Find free seat (0-5)
    const takenSeats = state.players.map(p => p.seatIndex)
    const seat = [0,1,2,3,4,5].find(s => !takenSeats.includes(s)) ?? 0

    state = addPlayer(state, playerId, playerName, STARTING_CHIPS, seat)
    tables.set(tableId, state)
    clients.set(ws, { ws, playerId, playerName, tableId })

    broadcastTable(tableId)
    send(ws, { type: 'joined', playerId, tableId, chips: STARTING_CHIPS })

    // Auto-start if enough players
    scheduleStart(tableId)
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
  state = removePlayer(state, playerId)
  tables.set(tableId, state)
  broadcastTable(tableId)
  console.log(`Player ${playerId} disconnected from ${tableId}`)
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

async function saveHandStats(state: GameState) {
  if (!process.env.DATABASE_URL) return
  const db = getPool()
  const winnerIds = new Set(state.winners.map(w => w.playerId))
  const pot = state.pot

  for (const player of state.players) {
    if (!player.connected) continue
    const isWinner = winnerIds.has(player.id)
    const wonAmount = state.winners.find(w => w.playerId === player.id)?.amount || 0

    await db.query(
      `UPDATE pf_users SET
        hands_played = hands_played + 1,
        hands_won    = hands_won + $1,
        biggest_pot  = GREATEST(biggest_pot, $2)
       WHERE tg_id = $3`,
      [isWinner ? 1 : 0, isWinner ? wonAmount : 0, player.id]
    ).catch(() => {})
  }
  console.log(`Hand stats saved: pot=${pot}, winners=${[...winnerIds].join(',')}`)
}
