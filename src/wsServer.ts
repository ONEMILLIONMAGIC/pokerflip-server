import { WebSocket, WebSocketServer } from 'ws'
import { GameState, createTable, addPlayer, removePlayer, startHand, applyAction, advanceStreet, canStart, maskForPlayer, PlayerAction } from './engine/game'
import { getPool, logTransaction } from './db'
import { getSFRoomId, getSFTableConfig, completeSFSession } from './spinFlip'

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
const runoutTables = new Set<string>()                 // tables currently in all-in board runout

// SF blind level: doubles every 3 minutes
const sfBlinds = new Map<string, { level: number; sb: number; bb: number; nextAt: number }>()

// SF sessions that have already ended — guard against double-completion and stale hand starts
const sfEndedTables = new Set<string>()

// Connected players in AFK mode (timed out) — auto-fold quickly on next turn
const afkMode = new Set<string>()  // key: tableId:playerId

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

// SF blind status broadcast: every 5s push current level + time-to-next to all SF tables
setInterval(() => {
  for (const [tableId, bs] of sfBlinds) {
    broadcastToTable(tableId, { type: 'sf_blind_status', level: bs.level, sb: bs.sb, bb: bs.bb, nextLevelAt: bs.nextAt })
  }
}, 5000)

// Safety watchdog: every 5s scan all tables for stuck states (all-in OR no timer)
setInterval(() => {
  for (const [tableId, state] of tables) {
    if (state.street === 'waiting' || state.street === 'showdown') continue
    if (runoutTables.has(tableId)) continue
    if (actionTimers.has(tableId)) continue
    if (canAutoRunBoard(state)) {
      console.log(`[Watchdog] ${tableId}: stuck all-in at ${state.street}, triggering runout`)
      runBoardToShowdown(tableId)
    } else {
      // Hand in progress but no action timer — restart (e.g. after reconnect or missed setActionTimer)
      console.log(`[Watchdog] ${tableId}: no action timer at ${state.street}, restarting`)
      setActionTimer(tableId)
    }
  }
}, 5000)

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

  if (type === 'here') {
    afkMode.delete(`${tableId}:${playerId}`)
    send(ws, { type: 'here_ok' })
    return
  }

  if (type === 'action') {
    // Any explicit action clears AFK mode
    afkMode.delete(`${tableId}:${playerId}`)
    const { action, amount } = msg as { action: PlayerAction; amount?: number }
    let state = tables.get(tableId)
    if (!state) return
    const prevStreet = state.street
    state = applyAction(state, playerId, action, amount)
    tables.set(tableId, state)
    clearActionTimer(tableId)
    broadcastTable(tableId)

    if (state.street === 'showdown' && prevStreet !== 'showdown') {
      // Reached showdown via normal action (e.g. everyone folded on river)
      saveHandStats(state).catch(e => console.error('stats error:', e))
      setTimeout(() => {
        let s = tables.get(tableId)
        if (!s) return
        if (canStartTable(tableId, s)) { s = startHand(s); tables.set(tableId, s) }
        else s.street = 'waiting' as any
        broadcastTable(tableId)
        setActionTimer(tableId)
      }, 4000)
    } else {
      // Борд идёт автоматически: все в олл-ин, или оставшиеся игроки могут только чекнуть
      if (canAutoRunBoard(state)) {
        console.log(`[AutoRun] ${tableId}: starting at ${state.street}`)
        runBoardToShowdown(tableId)
      } else {
        setActionTimer(tableId)
      }
    }
    return
  }

  if (type === 'start') {
    let state = tables.get(tableId)
    if (!state || !canStartTable(tableId, state)) return send(ws, { type: 'error', message: 'Need 2+ players' })
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

  // Show own cards voluntarily — supports specific card indices
  if (type === 'show_cards') {
    const { tableId, playerId } = client
    const state = tables.get(tableId)
    if (!state) return
    const player = state.players.find(p => p.id === playerId)
    if (!player || !player.holeCards?.length) return
    const indices: number[] = Array.isArray(msg.indices)
      ? msg.indices.filter((i: any) => i === 0 || i === 1)
      : (Number(msg.count) === 1 ? [0] : [0, 1])
    const cards = player.holeCards.filter((c, i) => indices.includes(i) && (c.rank as string) !== '?')
    if (!cards.length) return
    broadcastToTable(tableId, { type: 'cards_shown', playerId, playerName: client.playerName, cards })
    return
  }

  if (type === 'rebuy') {
    const amount = Math.floor(Number(msg.amount))
    const bankKey = `${tableId}:${playerId}`
    const bank = playerBanks.get(bankKey) ?? 0
    const cfg = TABLE_CONFIG[tableId] || TABLE_CONFIG.main

    if (!amount || amount <= 0) return send(ws, { type: 'error', code: 'rebuy_failed', message: 'Invalid amount' })

    let state = tables.get(tableId)
    if (!state) return
    const playerInState = state.players.find(p => p.id === playerId)
    if (!playerInState) return

    const maxBuyIn = cfg.bb * 200
    const maxAllowed = Math.min(bank, maxBuyIn - playerInState.chips)
    if (amount > maxAllowed) return send(ws, { type: 'error', code: 'rebuy_failed', message: `Max rebuy: ${maxAllowed}` })
    if (amount < cfg.minBuyIn && maxAllowed >= cfg.minBuyIn) return send(ws, { type: 'error', code: 'rebuy_failed', message: `Min rebuy: ${cfg.minBuyIn}` })

    // Move amount from bank → table chips
    const newBank = bank - amount
    playerBanks.set(bankKey, newBank)
    const newPlayers = state.players.map(p =>
      p.id === playerId ? { ...p, chips: p.chips + amount, folded: false, allIn: false } : p
    )
    state = { ...state, players: newPlayers }
    tables.set(tableId, state)

    // Sync DB: bank decreased by amount
    if (process.env.DATABASE_URL) {
      getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [newBank, playerId]).catch(() => {})
      logTransaction(playerId, 'table_join', -amount, `Re-buy at ${tableId} (+${amount.toLocaleString()} chips)`)
    }

    broadcastTable(tableId)
    send(ws, { type: 'rebuy_ok', chips: playerInState.chips + amount, bank: newBank })
    scheduleStart(tableId)
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
    if (getSFRoomId(tableId)) {
      // SF: buy-in already deducted at registration; play chips don't cash out
      // DB balance stays at bank (no additional changes)
    } else {
      const totalToSave = bank + player.chips
      getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [totalToSave, playerId])
        .catch(e => console.error('Failed to save chips on disconnect:', e))
      if (player.chips !== 0) {
        logTransaction(playerId, 'table_leave', player.chips, `Cash out from ${tableId} (${player.chips.toLocaleString()} chips)`)
      }
    }
  }

  // Clear AFK mode flag
  afkMode.delete(`${tableId}:${playerId}`)

  // Mark as disconnected (stays in player list)
  state = removePlayer(state, playerId)
  tables.set(tableId, state)
  broadcastTable(tableId)

  const inActiveHand = state.street !== 'waiting' && state.street !== 'showdown'
  if (inActiveHand) {
    setTimeout(() => resolveHandAfterDisconnect(tableId), 600)
  }

  // SF: player stays seated as AFK — never auto-removed (they paid buy-in, must play out)
  if (getSFRoomId(tableId)) {
    console.log(`SF player ${playerId} disconnected — staying seated AFK at ${tableId}`)
    return
  }

  // Cash/tournament: remove player slot after 30s without reconnect
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
  if (sfEndedTables.has(tableId)) return  // SF game already finished
  const timer = setTimeout(() => {
    startTimers.delete(tableId)
    if (sfEndedTables.has(tableId)) return  // check again inside timer
    let state = tables.get(tableId)
    if (!state || !canStartTable(tableId, state) || state.street !== 'waiting') return

    // SF: init blind tracker on first hand, then double blinds every 3 min
    if (tableId.startsWith('sf_')) {
      if (!sfBlinds.has(tableId)) {
        const cfg = getTableConfig(tableId)
        sfBlinds.set(tableId, { level: 0, sb: cfg.sb, bb: cfg.bb, nextAt: Date.now() + 3 * 60_000 })
      }
      const bs = sfBlinds.get(tableId)!
      if (Date.now() >= bs.nextAt) {
        bs.level++
        bs.sb *= 2
        bs.bb *= 2
        bs.nextAt = Date.now() + 3 * 60_000
        state = { ...state, smallBlind: bs.sb, bigBlind: bs.bb, minRaise: bs.bb }
        tables.set(tableId, state)
        broadcastToTable(tableId, { type: 'blind_increase', level: bs.level, sb: bs.sb, bb: bs.bb })
      }
      // Broadcast current blind status to all players at table
      broadcastToTable(tableId, { type: 'sf_blind_status', level: bs.level, sb: bs.sb, bb: bs.bb, nextLevelAt: bs.nextAt })
    }

    state = startHand(state)
    tables.set(tableId, state)
    broadcastTable(tableId)
    setActionTimer(tableId)
  }, 3000)
  startTimers.set(tableId, timer)
}

// If only 1 connected non-folded player remains, end the hand immediately and give them the pot.
// Otherwise fall back to foldDisconnectedPlayers.
function resolveHandAfterDisconnect(tableId: string) {
  let s = tables.get(tableId)
  if (!s || s.street === 'waiting' || s.street === 'showdown') return

  const connectedActive = s.players.filter(p => p.connected && !p.folded)

  if (connectedActive.length <= 1) {
    clearActionTimer(tableId)
    // Fold all disconnected non-folded players
    const players = s.players.map(p =>
      (!p.connected && !p.folded) ? { ...p, folded: true, hasActed: true } : { ...p }
    )
    const notFolded = players.filter(p => !p.folded)
    let newState: typeof s = { ...s, players }

    if (notFolded.length === 1) {
      const winner = notFolded[0]
      players.find(p => p.id === winner.id)!.chips += newState.pot
      newState = { ...newState, players, winners: [{ playerId: winner.id, amount: newState.pot, hand: 'Last standing' }], pot: 0, street: 'showdown' }
    } else {
      newState = { ...newState, street: 'waiting' }
    }

    tables.set(tableId, newState)
    broadcastTable(tableId)

    if (newState.street === 'showdown') {
      saveHandStats(newState).catch(console.error)
      setTimeout(() => {
        if (sfEndedTables.has(tableId)) return
        let s2 = tables.get(tableId)
        if (!s2) return
        s2 = canStartTable(tableId, s2) ? startHand(s2) : { ...s2, street: 'waiting' }
        tables.set(tableId, s2)
        broadcastTable(tableId)
        setActionTimer(tableId)  // critical: keeps hand loop alive after reconnect-triggered showdown
      }, 2000)
    }
    return
  }

  // Multiple connected players remain — use normal per-turn fold logic
  foldDisconnectedPlayers(tableId)
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
      s2 = canStartTable(tableId, s2) ? startHand(s2) : { ...s2, street: 'waiting' as any }
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

  // Don't set a timer if a board runout is already in progress
  if (runoutTables.has(tableId)) return

  let state = tables.get(tableId)
  if (state) {
    // Автоматический ранаут: все в олл-ин или оставшиеся могут только чекнуть
    if (canAutoRunBoard(state)) {
      console.log(`[AutoRun] ${tableId}: setActionTimer triggered runout at ${state.street}`)
      runBoardToShowdown(tableId)
      return
    }
    // Disconnected player at the wheel — fold them immediately (no 30s wait)
    const p = state.players[state.actionIdx]
    if (p && !p.folded && !p.allIn && !p.connected) {
      const timer = setTimeout(() => foldDisconnectedPlayers(tableId), 800)
      actionTimers.set(tableId, timer)
      return
    }
    // AFK mode: connected player already timed out once — quick-fold without waiting 30s
    if (p && !p.folded && !p.allIn && p.connected && afkMode.has(`${tableId}:${p.id}`)) {
      const timer = setTimeout(() => {
        let st = tables.get(tableId)
        if (!st || st.street === 'waiting' || st.street === 'showdown') return
        if (canAutoRunBoard(st)) { runBoardToShowdown(tableId); return }
        const pp = st.players[st.actionIdx]
        if (!pp || pp.folded || pp.allIn) { setActionTimer(tableId); return }
        st = applyAction(st, pp.id, 'fold')
        tables.set(tableId, st)
        broadcastTable(tableId)
        if (st.street === 'showdown') {
          saveHandStats(st).catch(console.error)
          setTimeout(() => {
            let s = tables.get(tableId)
            if (!s) return
            s = canStartTable(tableId, s) ? startHand(s) : { ...s, street: 'waiting' as any }
            tables.set(tableId, s); broadcastTable(tableId); setActionTimer(tableId)
          }, 4000)
        } else { setActionTimer(tableId) }
      }, 800)
      actionTimers.set(tableId, timer)
      return
    }
  }

  const timer = setTimeout(() => {
    let state = tables.get(tableId)
    if (!state || state.street === 'waiting' || state.street === 'showdown') return

    if (canAutoRunBoard(state)) {
      console.log(`[AutoRun] ${tableId}: timer fired, triggering runout at ${state.street}`)
      runBoardToShowdown(tableId)
      return
    }

    const p = state.players[state.actionIdx]
    if (!p || p.folded || p.allIn) { setActionTimer(tableId); return }

    // Auto-fold timed-out player + enter AFK mode
    state = applyAction(state, p.id, 'fold')
    tables.set(tableId, state)
    broadcastTable(tableId)

    // Mark as AFK — next turn will be instant-fold
    const afkKey = `${tableId}:${p.id}`
    afkMode.add(afkKey)
    // Notify the player
    for (const [ws2, c2] of clients) {
      if (c2.tableId === tableId && c2.playerId === p.id && ws2.readyState === WebSocket.OPEN) {
        send(ws2, { type: 'you_are_afk' })
      }
    }

    if (state.street === 'showdown') {
      saveHandStats(state).catch(console.error)
      setTimeout(() => {
        let s = tables.get(tableId)
        if (!s) return
        s = canStartTable(tableId, s) ? startHand(s) : { ...s, street: 'waiting' as any }
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

// Returns true if the board should run automatically:
// 1. All non-folded players are all-in, OR
// 2. Remaining non-all-in players can ONLY check (toCall=0, all opponents are all-in)
//    — i.e. no real betting decision is possible
function canAutoRunBoard(state: GameState): boolean {
  if (state.street === 'showdown' || state.street === 'waiting') return false
  const activePlayers = state.players.filter(p => !p.folded && !p.allIn)
  if (activePlayers.length === 0) return true  // everyone all-in
  // Each active player can only check if: nothing to call AND no opponent that can bet back
  return activePlayers.every(p => {
    const toCall = Math.max(0, state.currentBet - p.bet)
    if (toCall > 0) return false
    const opponentCanBet = state.players.some(pp => !pp.folded && !pp.allIn && pp.id !== p.id)
    return !opponentCanBet
  })
}

// Run remaining board streets automatically (all-in runout OR check-only situation).
// Uses async/await + mutex to prevent double execution and stale state bugs.
function runBoardToShowdown(tableId: string): void {
  if (runoutTables.has(tableId)) {
    console.log(`[RunBoard] ${tableId}: already running, skip`)
    return
  }

  const s = tables.get(tableId)
  if (!s || !canAutoRunBoard(s)) {
    if (s && !canAutoRunBoard(s)) setActionTimer(tableId)
    return
  }

  runoutTables.add(tableId)
  clearActionTimer(tableId)
  console.log(`[RunBoard] ${tableId}: starting from ${s.street}`)

  const CARD_DELAY = 1000  // 1s между улицами — как в реальных покер-румах

  async function loop() {
    try {
      while (true) {
        await new Promise<void>(res => setTimeout(res, CARD_DELAY))

        let state = tables.get(tableId)
        if (!state || state.street === 'showdown' || state.street === 'waiting') break

        if (!canAutoRunBoard(state)) {
          // Ситуация изменилась (например, ребай) — передаём управление таймеру
          console.log(`[RunBoard] ${tableId}: player can now bet, stopping runout`)
          setActionTimer(tableId)
          return
        }

        // advanceStreet разбирает оба случая:
        // • все в олл-ин → просто раскладывает карты
        // • остался игрок с фишками, но все оппоненты в олл-ин → улица тоже завершена
        state = advanceStreet(state)
        tables.set(tableId, state)
        broadcastTable(tableId)
        console.log(`[RunBoard] ${tableId}: dealt ${state.street}`)

        if (state.street === 'showdown') {
          saveHandStats(state).catch(e => console.error('[RunBoard] stats error:', e))
          await new Promise<void>(res => setTimeout(res, 4000))
          let s2 = tables.get(tableId)
          if (!s2) break
          s2 = canStartTable(tableId, s2) ? startHand(s2) : { ...s2, street: 'waiting' as any }
          tables.set(tableId, s2)
          broadcastTable(tableId)
          setActionTimer(tableId)
          break
        }
      }
    } finally {
      runoutTables.delete(tableId)
      console.log(`[RunBoard] ${tableId}: runout complete`)
    }
  }

  loop().catch(e => {
    runoutTables.delete(tableId)
    console.error(`[RunBoard] ${tableId}: error`, e)
  })
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
    const config = getTableConfig(tableId)
    stats[tableId] = {
      players: state.players.filter(p => p.connected).length,
      maxPlayers: config.maxPlayers || 6,
      street: state.street,
    }
  }
  return stats
}

const TOURNAMENT_TABLE_IDS = new Set(['daily', 'weekly'])

function getTableConfig(tableId: string) {
  return TABLE_CONFIG[tableId] || getSFTableConfig(tableId) || TABLE_CONFIG.main
}

// SF tables: count all players with chips (AFK included). Cash tables: require connected.
function canStartTable(tableId: string, state: GameState): boolean {
  if (getSFRoomId(tableId)) return state.players.filter(p => p.chips > 0).length >= 2
  return canStart(state)
}

async function handleJoin(ws: WebSocket, msg: any) {
  const { tableId = 'main', playerId, playerName, buyIn: requestedBuyIn } = msg
  if (!playerId || !playerName) return send(ws, { type: 'error', message: 'Need playerId and playerName' })

  const config = getTableConfig(tableId)

  const isSFTable = getSFRoomId(tableId) !== null

  // Tournament access control
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

  // Spin & Flip access control
  if (isSFTable && process.env.DATABASE_URL) {
    try {
      const db = getPool()
      const sessionId = tableId.match(/_(\d+)$/)?.[1]
      if (!sessionId) return send(ws, { type: 'error', message: 'Invalid SF table', code: 'sf_invalid' })
      const [sRes, rRes] = await Promise.all([
        db.query(`SELECT status, prize FROM pf_sf_sessions WHERE id=$1`, [sessionId]),
        db.query(`SELECT 1 FROM pf_sf_registrations WHERE session_id=$1 AND tg_id=$2`, [sessionId, playerId]),
      ])
      if (sRes.rows[0]?.status !== 'ready') return send(ws, { type: 'error', message: 'Session not ready', code: 'sf_not_ready' })
      if (!rRes.rows.length) return send(ws, { type: 'error', message: 'Not registered for this session', code: 'sf_not_registered' })
    } catch (e) {
      console.error('SF access check error:', e)
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

  // SF: buy-in already deducted at HTTP registration → give play stack without DB deduction
  let playerChips: number
  let bankChips: number
  if (isSFTable) {
    playerChips = config.minBuyIn
    bankChips = totalChips  // keep DB balance as bank (unchanged)
  } else {
    // Check min buy-in against total chips
    if (totalChips < config.minBuyIn) {
      return send(ws, { type: 'error', message: `Need at least ${config.minBuyIn} chips for this table`, code: 'insufficient_chips', required: config.minBuyIn, have: totalChips })
    }
    const maxBuyIn = Math.min(totalChips, config.bb * 200)
    playerChips = requestedBuyIn
      ? Math.max(config.minBuyIn, Math.min(requestedBuyIn, totalChips))
      : Math.min(totalChips, maxBuyIn)
    bankChips = totalChips - playerChips
  }

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
    afkMode.delete(afkKey)
    state = addPlayer(state, playerId, playerName, reconnectingPlayer.chips, reconnectingPlayer.seatIndex)
    tables.set(tableId, state)
    clients.set(ws, { ws, playerId, playerName, tableId })
    broadcastTable(tableId)
    send(ws, { type: 'joined', playerId, tableId, chips: reconnectingPlayer.chips, maxPlayers })
    console.log(`Player ${playerId} reconnected to ${tableId} with ${reconnectingPlayer.chips} chips`)
    // If a hand is already in progress and no action timer is running, restart it.
    // This fixes the case where resolveHandAfterDisconnect started a hand without a timer.
    const midHand = state.street !== 'waiting' && state.street !== 'showdown'
    if (midHand && !actionTimers.has(tableId) && !runoutTables.has(tableId)) {
      setActionTimer(tableId)
    } else {
      scheduleStart(tableId)
    }
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

  playerBanks.set(`${tableId}:${playerId}`, bankChips)

  if (!isSFTable && process.env.DATABASE_URL) {
    // Normal table: deduct buy-in from DB now
    getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [bankChips, playerId])
      .catch(e => console.error('Failed to deduct buy-in:', e))
    logTransaction(playerId, 'table_join', -playerChips, `Buy-in at ${tableId} (${playerChips.toLocaleString()} chips)`)
  }

  // SF: pre-seed other registered players as AFK so game starts even if they haven't opened WS
  if (isSFTable && process.env.DATABASE_URL) {
    const sessionId = tableId.match(/_(\d+)$/)?.[1]
    if (sessionId) {
      const db = getPool()
      // Fetch prize + seed AFK players in parallel
      const [prizeRes, regRes] = await Promise.all([
        db.query(`SELECT prize FROM pf_sf_sessions WHERE id=$1`, [sessionId]),
        db.query(
          `SELECT r.tg_id, COALESCE(u.first_name, 'Player') AS name
           FROM pf_sf_registrations r LEFT JOIN pf_users u ON u.tg_id = r.tg_id
           WHERE r.session_id = $1`, [sessionId]
        ),
      ]).catch(() => [null, null] as any)

      if (prizeRes?.rows[0]) {
        send(ws, { type: 'sf_prize', prize: prizeRes.rows[0].prize, sessionId: Number(sessionId) })
      }

      if (regRes?.rows) {
        let st = tables.get(tableId)!
        for (const reg of regRes.rows) {
          if (reg.tg_id === playerId) continue  // already seated above
          if (st.players.find((p: any) => p.id === reg.tg_id)) continue  // already in table
          const takenS = st.players.map((p: any) => p.seatIndex)
          const freeSeat = Array.from({ length: maxPlayers }, (_, i) => i).find(s => !takenS.includes(s)) ?? 0
          st = addPlayer(st, reg.tg_id, reg.name, config.minBuyIn, freeSeat)
          // Mark as AFK (not connected via WS yet)
          const afkP = st.players.find((p: any) => p.id === reg.tg_id)
          if (afkP) afkP.connected = false
        }
        tables.set(tableId, st)
      }
    }
  }

  broadcastTable(tableId)
  send(ws, { type: 'joined', playerId, tableId, chips: playerChips, maxPlayers, bank: bankChips })
  scheduleStart(tableId)
}

async function checkSFEnd(state: GameState) {
  const tableId = state.tableId
  const sessionId = Number(tableId.match(/_(\d+)$/)?.[1])
  if (!sessionId) return
  if (sfEndedTables.has(tableId)) return  // already ended — prevent double-call

  // FIX: SF buy-in is deducted at registration; playerBanks = real user balance (unrelated to game).
  // Only check play chips — a player is eliminated when their in-game stack hits 0.
  const alive = state.players.filter(p => p.chips > 0)
  if (alive.length > 1) return

  const winner = alive[0] || state.players.reduce((best, p) => p.chips > best.chips ? p : best, state.players[0])
  if (!winner) return

  sfEndedTables.add(tableId)  // mark before async call to prevent race condition

  const result = await completeSFSession(sessionId, winner.id, winner.name).catch(e => {
    console.error('SF complete error:', e)
    sfEndedTables.delete(tableId)  // allow retry on error
    return null
  })
  if (!result) return

  broadcastToTable(tableId, {
    type: 'tournament_end',
    winnerId: winner.id, winnerName: winner.name,
    prize: result.prize, tableId,
  })
  console.log(`SF ${tableId} finished — winner: ${winner.id}, prize: ${result.prize}`)

  // Clean up in-memory resources after clients receive the event
  setTimeout(() => {
    tables.delete(tableId)
    sfBlinds.delete(tableId)
    sfEndedTables.delete(tableId)
    clearActionTimer(tableId)
    const st = startTimers.get(tableId)
    if (st) { clearTimeout(st); startTimers.delete(tableId) }
    for (const key of [...playerBanks.keys()]) {
      if (key.startsWith(`${tableId}:`)) playerBanks.delete(key)
    }
    for (const key of [...afkMode]) {
      if (key.startsWith(`${tableId}:`)) afkMode.delete(key)
    }
    runoutTables.delete(tableId)
    console.log(`SF table ${tableId} resources cleaned up`)
  }, 9000)
}

async function saveHandStats(state: GameState) {
  if (!process.env.DATABASE_URL) return
  const db = getPool()
  const winnerIds = new Set(state.winners.map(w => w.playerId))

  const isSF = getSFRoomId(state.tableId) !== null

  for (const player of state.players) {
    if (!player.connected) continue
    const isWinner = winnerIds.has(player.id)
    const wonAmount = state.winners.find(w => w.playerId === player.id)?.amount || 0

    // Total chips = bank (outside table) + current table chips
    const bankKey = `${state.tableId}:${player.id}`
    const bank = playerBanks.get(bankKey) ?? 0
    // SF: play chips are separate from real balance; don't update chips during game
    const totalChips = isSF ? bank : bank + player.chips

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

  // Save full hand history for replay/debugging
  const historyPlayers = state.players.filter(p => p.holeCards?.length > 0).map(p => ({
    id: p.id, name: p.name,
    holeCards: p.holeCards,
    folded: p.folded,
    won: winnerIds.has(p.id),
    wonAmount: state.winners.find(w => w.playerId === p.id)?.amount || 0,
    hand: winnerIds.has(p.id) ? (state.winners.find(w => w.playerId === p.id)?.hand || '') : '',
  }))
  db.query(
    `INSERT INTO pf_hand_history (table_id, board, players, winners, pot) VALUES ($1,$2,$3,$4,$5)`,
    [state.tableId, JSON.stringify(state.board), JSON.stringify(historyPlayers), JSON.stringify(state.winners), state.pot + (state.winners.reduce((s,w) => s+w.amount, 0))]
  ).catch(() => {})

  // Tournament end: if only 1 player has chips left → distribute prizes
  if (TOURNAMENT_TABLE_IDS.has(state.tableId)) {
    await checkTournamentEnd(state).catch(e => console.error('Tournament end check error:', e))
  }
  // Spin & Flip end
  if (isSF) {
    await checkSFEnd(state).catch(e => console.error('SF end check error:', e))
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
