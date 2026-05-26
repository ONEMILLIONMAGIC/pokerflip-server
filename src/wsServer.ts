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
const afkTimers = new Map<string, NodeJS.Timeout>()
const playerBanks = new Map<string, number>()
const runoutTables = new Set<string>()
const lastTurnNotif = new Map<string, number>() // playerId → timestamp

const sfBlinds = new Map<string, { level: number; sb: number; bb: number; nextAt: number }>()
const sfBlindPendingNotified = new Set<string>()
const sfEndedTables = new Set<string>()
const sfPrizes = new Map<string, number>() // tableId → prize amount
const afkMode = new Set<string>()
const sitOutSet = new Set<string>() // tableId:playerId
const afkRequestTimers = new Map<string, NodeJS.Timeout>() // tableId:playerId → auto-clear timer
const afkKickTimers = new Map<string, NodeJS.Timeout>() // tableId:playerId → 3-min cash-table kick
const tableGifts = new Map<string, Map<string, { giftId: string; tint: string; fromName: string }>>() // tableId → targetId → gift

const BOMB_PRICES: Record<string, number> = {
  tomato: 50, banana: 100, egg: 100, poop: 200, fish: 250,
  pie: 300, brick: 500, cactus: 750, skull: 1000, bomb: 2500,
}
const GIFT_PRICES: Record<string, number> = {
  rose: 100, heart: 200, cake: 300, cocktail: 400, cigar: 500,
  shades: 600, champagne: 1500, money: 2500,
  rocket: 5000, watch: 7500, ring: 10000,
  trophy: 15000, diamond: 25000, ace_pendant: 50000, crown: 100000,
}

const TABLE_CONFIG: Record<string, { sb: number; bb: number; minBuyIn: number; maxPlayers?: number }> = {
  main:     { sb: 10,  bb: 20,  minBuyIn: 400 },
  shadow:   { sb: 25,  bb: 50,  minBuyIn: 1000 },
  crimson:  { sb: 50,  bb: 100, minBuyIn: 2000 },
  obsidian: { sb: 100, bb: 200, minBuyIn: 5000 },
  limit1:   { sb: 10,  bb: 20,  minBuyIn: 400 },
  limit2:   { sb: 25,  bb: 50,  minBuyIn: 1000 },
  limit3:   { sb: 50,  bb: 100, minBuyIn: 2000 },
  limit4:   { sb: 100, bb: 200, minBuyIn: 5000 },
  heads1:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  heads2:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  heads3:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  heads4:   { sb: 25,  bb: 50,  minBuyIn: 1000, maxPlayers: 2 },
  daily:    { sb: 50,  bb: 100, minBuyIn: 2000 },
  weekly:   { sb: 100, bb: 200, minBuyIn: 5000 },
}
const ACTION_TIMEOUT_MS = 30_000
const TOURNAMENT_TABLE_IDS = new Set(['daily', 'weekly'])

// ─── Interval Watchers ────────────────────────────────────────────────────────

setInterval(() => {
  for (const [tableId, bs] of sfBlinds) {
    const state = tables.get(tableId)
    const inHand = state && state.street !== 'waiting' && state.street !== 'showdown'
    const isPending = Date.now() >= bs.nextAt
    broadcastToTable(tableId, {
      type: 'sf_blind_status', level: bs.level, sb: bs.sb, bb: bs.bb,
      nextLevelAt: bs.nextAt, blindsPending: isPending && !!inHand
    })
    if (isPending && inHand && !sfBlindPendingNotified.has(tableId)) {
      sfBlindPendingNotified.add(tableId)
      broadcastToTable(tableId, { type: 'blind_pending_increase', nextSb: bs.sb * 2, nextBb: bs.bb * 2 })
    }
  }
}, 5000)

setInterval(() => {
  for (const [tableId, state] of tables) {
    if (state.street === 'waiting' || state.street === 'showdown') continue
    if (runoutTables.has(tableId)) continue
    if (actionTimers.has(tableId)) continue
    if (canAutoRunBoard(state)) {
      console.log(`[Watchdog] ${tableId}: stuck all-in at ${state.street}, triggering runout`)
      runBoardToShowdown(tableId)
    } else {
      console.log(`[Watchdog] ${tableId}: no action timer at ${state.street}, restarting`)
      setActionTimer(tableId)
    }
  }
}, 5000)

// ─── SF helpers ───────────────────────────────────────────────────────────────

// Bump SF blinds if their 3-minute timer has expired
function applySFBlindsIfDue(tableId: string, state: GameState): void {
  if (!tableId.startsWith('sf_')) return
  const bs = sfBlinds.get(tableId)
  if (!bs || Date.now() < bs.nextAt) return
  bs.level++
  bs.sb *= 2
  bs.bb *= 2
  bs.nextAt = Date.now() + 3 * 60_000
  sfBlindPendingNotified.delete(tableId)
  state.smallBlind = bs.sb
  state.bigBlind = bs.bb
  state.minRaise = bs.bb
  broadcastToTable(tableId, { type: 'blind_increase', level: bs.level, sb: bs.sb, bb: bs.bb })
}

// Start hand in SF mode: temporarily mark all chipped players as connected
// so startHand deals cards to them — they'll be auto-folded by the action timer.
function startSFHand(state: GameState): void {
  const saved = new Map(state.players.map(p => [p.id, p.connected]))
  state.players.forEach(p => { if (p.chips > 0) p.connected = true })
  startHand(state)
  state.players.forEach(p => { p.connected = saved.get(p.id) ?? false })
}

// ─── Core helpers ─────────────────────────────────────────────────────────────

function getTableConfig(tableId: string) {
  return TABLE_CONFIG[tableId] || getSFTableConfig(tableId) || TABLE_CONFIG.main
}

function canStartTable(tableId: string, state: GameState): boolean {
  if (getSFRoomId(tableId)) return state.players.filter(p => p.chips > 0).length >= 2
  if (isCashTable(tableId)) {
    // Cash: need 2+ connected players who are not in AFK mode
    return state.players.filter(p => p.connected && !afkMode.has(`${tableId}:${p.id}`)).length >= 2
  }
  return canStart(state)
}

function canAutoRunBoard(state: GameState): boolean {
  if (state.street === 'showdown' || state.street === 'waiting') return false
  const activePlayers = state.players.filter(p => !p.folded && !p.allIn)
  if (activePlayers.length === 0) return true
  return activePlayers.every(p => {
    const toCall = Math.max(0, state.currentBet - p.bet)
    if (toCall > 0) return false
    return !state.players.some(pp => !pp.folded && !pp.allIn && pp.id !== p.id)
  })
}

// ─── Single post-showdown scheduler (replaces 4+ duplicate blocks) ────────────

function clearTableGifts(tableId: string) {
  if (tableGifts.has(tableId)) {
    tableGifts.delete(tableId)
    broadcastToTable(tableId, { type: 'gift_clear' })
  }
}

const AFK_KICK_MS = 3 * 60 * 1000 // 3 minutes

function isCashTable(tableId: string) {
  return !getSFRoomId(tableId) && !TOURNAMENT_TABLE_IDS.has(tableId)
}

function kickAfkPlayer(tableId: string, playerId: string) {
  afkKickTimers.delete(`${tableId}:${playerId}`)
  afkMode.delete(`${tableId}:${playerId}`)
  const state = tables.get(tableId)
  if (!state) return
  const player = state.players.find(p => p.id === playerId)
  if (!player) return
  const bank = playerBanks.get(`${tableId}:${playerId}`) ?? 0
  const total = bank + player.chips
  if (process.env.DATABASE_URL) {
    getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [total, playerId]).catch(() => {})
    if (player.chips > 0) logTransaction(playerId, 'table_leave', player.chips, `AFK kick from ${tableId}`)
  }
  playerBanks.delete(`${tableId}:${playerId}`)
  for (const [ws2, c2] of clients) {
    if (c2.tableId === tableId && c2.playerId === playerId && ws2.readyState === WebSocket.OPEN)
      send(ws2, { type: 'afk_kicked' })
  }
  removePlayer(state, playerId)
  tables.set(tableId, state)
  broadcastTable(tableId)
  const inHand = state.street !== 'waiting' && state.street !== 'showdown'
  if (inHand) setTimeout(() => resolveHandAfterDisconnect(tableId), 600)
}

function scheduleAfkKick(tableId: string, playerId: string) {
  if (!isCashTable(tableId)) return
  if (sitOutSet.has(`${tableId}:${playerId}`)) return
  cancelAfkKick(tableId, playerId)
  afkKickTimers.set(`${tableId}:${playerId}`, setTimeout(() => kickAfkPlayer(tableId, playerId), AFK_KICK_MS))
}

function cancelAfkKick(tableId: string, playerId: string) {
  const t = afkKickTimers.get(`${tableId}:${playerId}`)
  if (t) { clearTimeout(t); afkKickTimers.delete(`${tableId}:${playerId}`) }
}

function scheduleNextHand(tableId: string, delay = 4500) {
  setTimeout(() => {
    if (sfEndedTables.has(tableId)) return
    const s = tables.get(tableId)
    if (!s) return
    if (canStartTable(tableId, s)) {
      applySFBlindsIfDue(tableId, s)
      if (getSFRoomId(tableId)) startSFHand(s)
      else startHand(s)
      tables.set(tableId, s)
      broadcastTable(tableId)
      setActionTimer(tableId)
    } else {
      s.street = 'waiting'
      tables.set(tableId, s)
      broadcastTable(tableId)
      scheduleStart(tableId)
    }
  }, delay)
}

// ─── Timer management ─────────────────────────────────────────────────────────

function clearActionTimer(tableId: string) {
  const t = actionTimers.get(tableId)
  if (t) { clearTimeout(t); actionTimers.delete(tableId) }
}

async function sendTurnNotification(playerId: string, tableId: string) {
  const botToken = process.env.BOT_TOKEN
  if (!botToken) return
  // Rate limit: once per 30s per player
  const now = Date.now()
  if ((lastTurnNotif.get(playerId) ?? 0) > now - 30_000) return
  lastTurnNotif.set(playerId, now)
  // Only send if player has no open WS connection (TMA is closed/backgrounded)
  const hasWs = [...clients.values()].some(c => c.playerId === playerId && c.tableId === tableId)
  if (hasWs) return
  const tableName = tableId.replace(/_/g, ' ')
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: playerId,
      text: `🃏 *Ваш ход!*\nСтол: ${tableName}\n[Открыть игру](https://t.me/pokerflip_bot/play)`,
      parse_mode: 'Markdown',
    })
  }).catch(() => {})
}

function setActionTimer(tableId: string) {
  clearActionTimer(tableId)
  if (runoutTables.has(tableId)) return

  const state = tables.get(tableId)
  if (!state) return

  if (canAutoRunBoard(state)) {
    runBoardToShowdown(tableId)
    return
  }

  const p = state.players[state.actionIdx]
  if (!p || p.folded || p.allIn) return

  // Disconnected player — fold quickly
  if (!p.connected) {
    actionTimers.set(tableId, setTimeout(() => foldDisconnectedPlayers(tableId), 800))
    return
  }

  // AFK player — instant fold
  if (afkMode.has(`${tableId}:${p.id}`)) {
    actionTimers.set(tableId, setTimeout(() => autoFoldPlayer(tableId, p.id, false), 800))
    return
  }

  // Push notification if player's TMA is not focused (no active WS from them in last 8s)
  sendTurnNotification(p.id, tableId).catch(() => {})

  // Normal timer
  actionTimers.set(tableId, setTimeout(() => {
    const st = tables.get(tableId)
    if (!st || st.street === 'waiting' || st.street === 'showdown') return
    if (canAutoRunBoard(st)) { runBoardToShowdown(tableId); return }
    const pp = st.players[st.actionIdx]
    if (!pp || pp.folded || pp.allIn) { setActionTimer(tableId); return }
    afkMode.add(`${tableId}:${pp.id}`)
    for (const [ws2, c2] of clients) {
      if (c2.tableId === tableId && c2.playerId === pp.id && ws2.readyState === WebSocket.OPEN)
        send(ws2, { type: 'you_are_afk' })
    }
    scheduleAfkKick(tableId, pp.id)
    autoFoldPlayer(tableId, pp.id, true)
  }, ACTION_TIMEOUT_MS))
}

function autoFoldPlayer(tableId: string, playerId: string, isTimed: boolean) {
  let st = tables.get(tableId)
  if (!st || st.street === 'waiting' || st.street === 'showdown') return
  if (canAutoRunBoard(st)) { runBoardToShowdown(tableId); return }
  const pp = st.players[st.actionIdx]
  if (!pp || pp.id !== playerId || pp.folded || pp.allIn) { setActionTimer(tableId); return }

  applyAction(st, playerId, 'fold')
  tables.set(tableId, st)
  broadcastTable(tableId)

  st = tables.get(tableId)!
  if (st.street === 'showdown') {
    saveHandStats(st).catch(console.error)
    scheduleNextHand(tableId, isTimed ? 4500 : 4500)
  } else {
    setActionTimer(tableId)
  }
}

// ─── Disconnect helpers ────────────────────────────────────────────────────────

function foldDisconnectedPlayers(tableId: string) {
  let s = tables.get(tableId)
  if (!s || s.street === 'waiting' || s.street === 'showdown') return
  const p = s.players[s.actionIdx]
  if (!p || p.folded || p.allIn) return
  if (p.connected) return

  clearActionTimer(tableId)
  applyAction(s, p.id, 'fold')
  tables.set(tableId, s)
  broadcastTable(tableId)

  s = tables.get(tableId)!
  if (s.street === 'showdown') {
    saveHandStats(s).catch(console.error)
    scheduleNextHand(tableId, 4500)
  } else {
    setTimeout(() => foldDisconnectedPlayers(tableId), 150)
    setActionTimer(tableId)
  }
}

function resolveHandAfterDisconnect(tableId: string) {
  const s = tables.get(tableId)
  if (!s || s.street === 'waiting' || s.street === 'showdown') return

  if (canAutoRunBoard(s)) {
    if (!runoutTables.has(tableId)) runBoardToShowdown(tableId)
    return
  }

  const canAct = s.players.filter(p => p.connected && !p.folded && !p.allIn)
  if (canAct.length > 0) {
    foldDisconnectedPlayers(tableId)
    return
  }

  clearActionTimer(tableId)

  // Fold all disconnected active players
  for (const p of s.players) {
    if (!p.connected && !p.folded && !p.allIn) { p.folded = true; p.hasActed = true }
  }

  const notFolded = s.players.filter(p => !p.folded)

  if (notFolded.length === 1) {
    const winner = notFolded[0]
    winner.chips += s.pot
    s.winners = [{ playerId: winner.id, amount: s.pot, hand: 'Last standing' }]
    s.pot = 0
    s.street = 'showdown'
    tables.set(tableId, s)
    broadcastTable(tableId)
    saveHandStats(s).catch(console.error)
    scheduleNextHand(tableId, 4500)
  } else if (notFolded.length > 1) {
    tables.set(tableId, s)
    broadcastTable(tableId)
    runBoardToShowdown(tableId)
  } else {
    // Everyone folded — return bets
    for (const p of s.players) { p.chips += p.bet ?? 0; p.bet = 0; p.totalBet = 0 }
    s.pot = 0
    s.street = 'waiting'
    tables.set(tableId, s)
    broadcastTable(tableId)
    scheduleStart(tableId)
  }
}

// ─── Board auto-runout ────────────────────────────────────────────────────────

function runBoardToShowdown(tableId: string): void {
  if (runoutTables.has(tableId)) return

  const s = tables.get(tableId)
  if (!s || !canAutoRunBoard(s)) {
    if (s && !canAutoRunBoard(s)) setActionTimer(tableId)
    return
  }

  runoutTables.add(tableId)
  clearActionTimer(tableId)

  async function loop() {
    try {
      while (true) {
        await new Promise<void>(res => setTimeout(res, 1000))

        const state = tables.get(tableId)
        if (!state || state.street === 'showdown' || state.street === 'waiting') break

        if (!canAutoRunBoard(state)) {
          setActionTimer(tableId)
          return
        }

        advanceStreet(state)
        tables.set(tableId, state)
        broadcastTable(tableId)

        const afterAdvance = tables.get(tableId)!
        if (afterAdvance.street === 'showdown') {
          saveHandStats(state).catch(console.error)
          await new Promise<void>(res => setTimeout(res, 4000))
          const s2 = tables.get(tableId)
          if (!s2) break
          if (!sfEndedTables.has(tableId)) {
            if (canStartTable(tableId, s2)) {
              applySFBlindsIfDue(tableId, s2)
              if (getSFRoomId(tableId)) startSFHand(s2)
              else startHand(s2)
              tables.set(tableId, s2)
              broadcastTable(tableId)
              setActionTimer(tableId)
            } else {
              s2.street = 'waiting'
              tables.set(tableId, s2)
              broadcastTable(tableId)
              scheduleStart(tableId)
            }
          }
          break
        }
      }
    } finally {
      runoutTables.delete(tableId)
    }
  }

  loop().catch(e => {
    runoutTables.delete(tableId)
    console.error(`[RunBoard] ${tableId}: error`, e)
  })
}

// ─── Hand start scheduling ────────────────────────────────────────────────────

function scheduleStart(tableId: string) {
  if (startTimers.has(tableId)) return
  if (sfEndedTables.has(tableId)) return

  const timer = setTimeout(() => {
    startTimers.delete(tableId)
    if (sfEndedTables.has(tableId)) return

    let state = tables.get(tableId)
    if (!state || !canStartTable(tableId, state) || state.street !== 'waiting') return

    if (tableId.startsWith('sf_')) {
      if (!sfBlinds.has(tableId)) {
        const cfg = getTableConfig(tableId)
        sfBlinds.set(tableId, { level: 0, sb: cfg.sb, bb: cfg.bb, nextAt: Date.now() + 3 * 60_000 })
      }
      applySFBlindsIfDue(tableId, state)
      const bs = sfBlinds.get(tableId)!
      broadcastToTable(tableId, { type: 'sf_blind_status', level: bs.level, sb: bs.sb, bb: bs.bb, nextLevelAt: bs.nextAt })
    }

    if (getSFRoomId(tableId)) startSFHand(state)
    else startHand(state)
    tables.set(tableId, state)
    broadcastTable(tableId)
    setActionTimer(tableId)
  }, getSFRoomId(tableId) ? 13500 : 4500)
  startTimers.set(tableId, timer)
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

function broadcastTable(tableId: string) {
  const state = tables.get(tableId)
  if (!state) return
  const sfPrize = sfPrizes.get(tableId)
  for (const [ws, client] of clients) {
    if (client.tableId !== tableId) continue
    if (ws.readyState !== WebSocket.OPEN) continue
    const masked = maskForPlayer(state, client.playerId)
    masked.players = masked.players.map((p: any) => ({ ...p, afk: afkMode.has(`${tableId}:${p.id}`) }))
    const msg: any = { type: 'state', state: masked }
    if (sfPrize !== undefined) msg.sfPrize = sfPrize
    send(ws, msg)
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

// ─── WS Entry ─────────────────────────────────────────────────────────────────

export function setupWS(wss: WebSocketServer) {
  wss.on('connection', (ws) => {
    ws.on('message', (data) => {
      try {
        handleMessage(ws, JSON.parse(data.toString()))
      } catch {
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
    cancelAfkKick(tableId, playerId)
    send(ws, { type: 'here_ok' })
    // Resume hand if table was paused waiting for this player
    const stateHere = tables.get(tableId)
    if (stateHere && stateHere.street === 'waiting' && canStartTable(tableId, stateHere)) {
      scheduleStart(tableId)
    }
    return
  }

  if (type === 'action') {
    afkMode.delete(`${tableId}:${playerId}`)
    cancelAfkKick(tableId, playerId)
    const { action, amount } = msg as { action: PlayerAction; amount?: number }
    const state = tables.get(tableId)
    if (!state) return
    const prevStreet = state.street
    applyAction(state, playerId, action, amount)
    tables.set(tableId, state)
    clearActionTimer(tableId)
    broadcastTable(tableId)

    if (state.street === 'showdown' && prevStreet !== 'showdown') {
      saveHandStats(state).catch(console.error)
      scheduleNextHand(tableId)
    } else if (canAutoRunBoard(state)) {
      runBoardToShowdown(tableId)
    } else {
      setActionTimer(tableId)
    }
    return
  }

  if (type === 'start') {
    const state = tables.get(tableId)
    if (!state || !canStartTable(tableId, state)) return send(ws, { type: 'error', message: 'Need 2+ players' })
    startHand(state)
    tables.set(tableId, state)
    broadcastTable(tableId)
    setActionTimer(tableId)
    return
  }

  if (type === 'chat') {
    broadcastToTable(tableId, { type: 'chat', playerId, playerName: client.playerName, message: String(msg.message).slice(0, 200) })
    return
  }

  if (type === 'reaction') {
    broadcastToTable(tableId, { type: 'reaction', playerId, playerName: client.playerName, emoji: String(msg.emoji || 'gg').slice(0, 20) })
    return
  }

  if (type === 'show_cards') {
    const state = tables.get(tableId)
    if (!state) return
    const player = state.players.find(p => p.id === playerId)
    if (!player?.holeCards?.length) return
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

    const state = tables.get(tableId)
    if (!state) return
    const playerInState = state.players.find(p => p.id === playerId)
    if (!playerInState) return

    const maxBuyIn = cfg.bb * 200
    const maxAllowed = Math.min(bank, maxBuyIn - playerInState.chips)
    if (amount > maxAllowed) return send(ws, { type: 'error', code: 'rebuy_failed', message: `Max rebuy: ${maxAllowed}` })
    if (amount < cfg.minBuyIn && maxAllowed >= cfg.minBuyIn) return send(ws, { type: 'error', code: 'rebuy_failed', message: `Min rebuy: ${cfg.minBuyIn}` })

    playerBanks.set(bankKey, bank - amount)
    playerInState.chips += amount
    playerInState.folded = false
    playerInState.allIn = false
    tables.set(tableId, state)

    if (process.env.DATABASE_URL) {
      getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [bank - amount, playerId]).catch(() => {})
      logTransaction(playerId, 'table_join', -amount, `Re-buy at ${tableId} (+${amount.toLocaleString()} chips)`)
    }

    broadcastTable(tableId)
    send(ws, { type: 'rebuy_ok', chips: playerInState.chips, bank: bank - amount })
    scheduleStart(tableId)
    return
  }

  if (type === 'sit_out') {
    sitOutSet.add(`${tableId}:${playerId}`)
    afkMode.add(`${tableId}:${playerId}`)
    cancelAfkKick(tableId, playerId) // voluntary sit-out — no kick
    return
  }

  if (type === 'sit_in') {
    sitOutSet.delete(`${tableId}:${playerId}`)
    afkMode.delete(`${tableId}:${playerId}`)
    send(ws, { type: 'here_ok' })
    return
  }

  if (type === 'afk_request') {
    const duration = Math.min(Math.max(Number(msg.duration) || 300, 60), 600)
    const key = `${tableId}:${playerId}`
    afkMode.add(key)
    send(ws, { type: 'you_are_afk' })
    const existing = afkRequestTimers.get(key)
    if (existing) clearTimeout(existing)
    afkRequestTimers.set(key, setTimeout(() => {
      afkRequestTimers.delete(key)
      afkMode.delete(key)
      const ws2 = [...clients.entries()].find(([, c]) => c.playerId === playerId && c.tableId === tableId)?.[0]
      if (ws2) send(ws2, { type: 'here_ok' })
    }, duration * 1000))
    return
  }

  if (type === 'send_bomb') {
    const bombId = String(msg.bombId || '').slice(0, 32)
    const tint = String(msg.tint || '#FF4D6D').slice(0, 16)
    const targetId = String(msg.targetId || '').slice(0, 64)
    const price = BOMB_PRICES[bombId] ?? 0
    const bankKey = `${tableId}:${playerId}`
    const bank = playerBanks.get(bankKey) ?? 0
    if (!price || bank < price) {
      send(ws, { type: 'error', code: 'insufficient_chips', message: 'Not enough chips in bank', have: bank, required: price })
      return
    }
    const newBank = bank - price
    playerBanks.set(bankKey, newBank)
    if (process.env.DATABASE_URL) {
      getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [newBank, playerId]).catch(() => {})
      logTransaction(playerId, 'bomb', -price, `💣 Bomb «${bombId}» → ${targetId} at ${tableId}`)
    }
    send(ws, { type: 'bank_update', bank: newBank })
    broadcastToTable(tableId, {
      type: 'bomb_event', fromId: playerId, fromName: client.playerName,
      targetId, bombId, tint,
    })
    return
  }

  if (type === 'send_gift') {
    const giftId = String(msg.giftId || '').slice(0, 32)
    const tint = String(msg.tint || '#00FFB0').slice(0, 16)
    const targetId = String(msg.targetId || '').slice(0, 64)
    const price = GIFT_PRICES[giftId] ?? 0
    const bankKey = `${tableId}:${playerId}`
    const bank = playerBanks.get(bankKey) ?? 0
    if (!price || bank < price) {
      send(ws, { type: 'error', code: 'insufficient_chips', message: 'Not enough chips in bank', have: bank, required: price })
      return
    }
    const newBank = bank - price
    playerBanks.set(bankKey, newBank)
    if (process.env.DATABASE_URL) {
      getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [newBank, playerId]).catch(() => {})
      logTransaction(playerId, 'gift', -price, `🎁 Gift «${giftId}» → ${targetId} at ${tableId}`)
    }
    send(ws, { type: 'bank_update', bank: newBank })
    if (!tableGifts.has(tableId)) tableGifts.set(tableId, new Map())
    tableGifts.get(tableId)!.set(targetId, { giftId, tint, fromName: client.playerName })
    broadcastToTable(tableId, {
      type: 'gift_event', fromId: playerId, fromName: client.playerName,
      targetId, giftId, tint,
    })
    return
  }

  if (type === 'ping') {
    send(ws, { type: 'pong' })
    return
  }
}

// ─── Disconnect handler ────────────────────────────────────────────────────────

function handleDisconnect(ws: WebSocket) {
  const client = clients.get(ws)
  if (!client) return
  clients.delete(ws)

  const { tableId, playerId } = client
  const state = tables.get(tableId)
  if (!state) return

  const player = state.players.find(p => p.id === playerId)
  if (player && process.env.DATABASE_URL) {
    const bank = playerBanks.get(`${tableId}:${playerId}`) ?? 0
    if (!getSFRoomId(tableId)) {
      const totalToSave = bank + player.chips
      getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [totalToSave, playerId]).catch(console.error)
      if (player.chips !== 0) logTransaction(playerId, 'table_leave', player.chips, `Cash out from ${tableId}`)
    }
  }

  afkMode.delete(`${tableId}:${playerId}`)
  sitOutSet.delete(`${tableId}:${playerId}`)
  cancelAfkKick(tableId, playerId)
  const afkReqTimer = afkRequestTimers.get(`${tableId}:${playerId}`)
  if (afkReqTimer) { clearTimeout(afkReqTimer); afkRequestTimers.delete(`${tableId}:${playerId}`) }
  removePlayer(state, playerId)
  tables.set(tableId, state)
  broadcastTable(tableId)

  const inActiveHand = state.street !== 'waiting' && state.street !== 'showdown'
  if (inActiveHand) setTimeout(() => resolveHandAfterDisconnect(tableId), 600)

  if (getSFRoomId(tableId)) return  // SF players stay seated (paid buy-in)

  const afkKey = `${tableId}:${playerId}`
  const existing = afkTimers.get(afkKey)
  if (existing) clearTimeout(existing)

  afkTimers.set(afkKey, setTimeout(() => {
    afkTimers.delete(afkKey)
    playerBanks.delete(`${tableId}:${playerId}`)
    const s = tables.get(tableId)
    if (!s) return
    const p = s.players.find(pp => pp.id === playerId)
    if (p && !p.connected) {
      s.players = s.players.filter(pp => pp.id !== playerId)
      tables.set(tableId, s)
      broadcastTable(tableId)
    }
  }, 30_000))
}

// ─── Join handler ─────────────────────────────────────────────────────────────

async function handleJoin(ws: WebSocket, msg: any) {
  const { tableId = 'main', playerId, playerName, buyIn: requestedBuyIn } = msg
  if (!playerId || !playerName) return send(ws, { type: 'error', message: 'Need playerId and playerName' })

  const config = getTableConfig(tableId)
  const isSFTable = getSFRoomId(tableId) !== null

  if (TOURNAMENT_TABLE_IDS.has(tableId) && process.env.DATABASE_URL) {
    try {
      const db = getPool()
      const [statusRes, regRes] = await Promise.all([
        db.query(`SELECT status FROM pf_tournament_status WHERE tournament_id=$1`, [tableId]),
        db.query(`SELECT 1 FROM pf_tournament_regs WHERE tournament_id=$1 AND tg_id=$2`, [tableId, playerId]),
      ])
      if (statusRes.rows[0]?.status !== 'active')
        return send(ws, { type: 'error', message: 'Tournament has not started yet', code: 'tournament_not_active' })
      if (!regRes.rows.length)
        return send(ws, { type: 'error', message: 'You are not registered for this tournament', code: 'tournament_not_registered' })
    } catch (e) { console.error('Tournament access check error:', e) }
  }

  if (isSFTable && process.env.DATABASE_URL) {
    try {
      const db = getPool()
      const sessionId = tableId.match(/_(\d+)$/)?.[1]
      if (!sessionId) return send(ws, { type: 'error', message: 'Invalid SF table', code: 'sf_invalid' })
      const [sRes, rRes] = await Promise.all([
        db.query(`SELECT status FROM pf_sf_sessions WHERE id=$1`, [sessionId]),
        db.query(`SELECT 1 FROM pf_sf_registrations WHERE session_id=$1 AND tg_id=$2`, [sessionId, playerId]),
      ])
      if (sRes.rows[0]?.status !== 'ready') return send(ws, { type: 'error', message: 'Session not ready', code: 'sf_not_ready' })
      if (!rRes.rows.length) return send(ws, { type: 'error', message: 'Not registered for this session', code: 'sf_not_registered' })
    } catch (e) { console.error('SF access check error:', e) }
  }

  let totalChips = config.minBuyIn
  if (process.env.DATABASE_URL) {
    try {
      const { rows } = await getPool().query('SELECT chips FROM pf_users WHERE tg_id=$1', [playerId])
      if (rows[0]) totalChips = rows[0].chips
    } catch (e) { console.error('Failed to load chips:', e) }
  }

  let playerChips: number
  let bankChips: number
  if (isSFTable) {
    playerChips = config.minBuyIn
    bankChips = totalChips
  } else {
    if (totalChips < config.minBuyIn)
      return send(ws, { type: 'error', message: `Need at least ${config.minBuyIn} chips`, code: 'insufficient_chips', required: config.minBuyIn, have: totalChips })
    const maxBuyIn = Math.min(totalChips, config.bb * 200)
    playerChips = requestedBuyIn ? Math.max(config.minBuyIn, Math.min(requestedBuyIn, totalChips)) : Math.min(totalChips, maxBuyIn)
    bankChips = totalChips - playerChips
  }

  const maxPlayers = config.maxPlayers || 6
  const afkKey = `${tableId}:${playerId}`
  const pendingAfk = afkTimers.get(afkKey)
  if (pendingAfk) { clearTimeout(pendingAfk); afkTimers.delete(afkKey) }

  if (!tables.has(tableId)) tables.set(tableId, createTable(tableId, config.sb, config.bb))
  const state = tables.get(tableId)!

  // Reconnect path
  const reconnecting = state.players.find(p => p.id === playerId && !p.connected)
  if (reconnecting) {
    afkMode.delete(afkKey)
    addPlayer(state, playerId, playerName, reconnecting.chips, reconnecting.seatIndex)
    tables.set(tableId, state)
    clients.set(ws, { ws, playerId, playerName, tableId })

    let bankForMsg = 0
    if (isSFTable && process.env.DATABASE_URL) {
      try {
        const db = getPool()
        const sessionId = tableId.match(/_(\d+)$/)?.[1]
        const [bankRes, prizeRes] = await Promise.all([
          db.query('SELECT chips FROM pf_users WHERE tg_id=$1', [playerId]),
          sessionId ? db.query('SELECT prize FROM pf_sf_sessions WHERE id=$1', [sessionId]) : Promise.resolve(null),
        ])
        if (bankRes.rows[0]) { bankForMsg = bankRes.rows[0].chips; playerBanks.set(`${tableId}:${playerId}`, bankForMsg) }
        if (prizeRes?.rows[0]) {
          sfPrizes.set(tableId, prizeRes.rows[0].prize)
          broadcastToTable(tableId, { type: 'sf_prize', prize: prizeRes.rows[0].prize, sessionId: Number(sessionId) })
        }
      } catch {}
    }

    broadcastTable(tableId)
    send(ws, { type: 'joined', playerId, tableId, chips: reconnecting.chips, maxPlayers, bank: bankForMsg || undefined })

    const midHand = state.street !== 'waiting' && state.street !== 'showdown'
    if (midHand && !actionTimers.has(tableId) && !runoutTables.has(tableId)) {
      setActionTimer(tableId)
    } else {
      scheduleStart(tableId)
    }
    return
  }

  if (state.players.filter(p => p.connected).length >= maxPlayers)
    return send(ws, { type: 'error', message: 'Table is full', code: 'table_full' })

  const allSeats = Array.from({ length: maxPlayers }, (_, i) => i)
  const takenSeats = state.players.map(p => p.seatIndex)
  const seat = allSeats.find(s => !takenSeats.includes(s)) ?? 0

  addPlayer(state, playerId, playerName, playerChips, seat)
  tables.set(tableId, state)
  clients.set(ws, { ws, playerId, playerName, tableId })
  playerBanks.set(`${tableId}:${playerId}`, bankChips)

  if (!isSFTable && process.env.DATABASE_URL) {
    getPool().query('UPDATE pf_users SET chips=$1 WHERE tg_id=$2', [bankChips, playerId]).catch(console.error)
    logTransaction(playerId, 'table_join', -playerChips, `Buy-in at ${tableId} (${playerChips.toLocaleString()} chips)`)
  }

  // SF: pre-seed other registered players as AFK
  if (isSFTable && process.env.DATABASE_URL) {
    const sessionId = tableId.match(/_(\d+)$/)?.[1]
    if (sessionId) {
      const db = getPool()
      const [prizeRes, regRes] = await Promise.all([
        db.query(`SELECT prize FROM pf_sf_sessions WHERE id=$1`, [sessionId]),
        db.query(`SELECT r.tg_id, COALESCE(u.first_name,'Player') AS name
                  FROM pf_sf_registrations r LEFT JOIN pf_users u ON u.tg_id=r.tg_id
                  WHERE r.session_id=$1`, [sessionId]),
      ]).catch(() => [null, null] as any)

      if (prizeRes?.rows[0]) {
        sfPrizes.set(tableId, prizeRes.rows[0].prize)
        broadcastToTable(tableId, { type: 'sf_prize', prize: prizeRes.rows[0].prize, sessionId: Number(sessionId) })
      }

      if (regRes?.rows) {
        for (const reg of regRes.rows) {
          if (reg.tg_id === playerId) continue
          if (state.players.find(p => p.id === reg.tg_id)) continue
          const taken = state.players.map(p => p.seatIndex)
          const free = Array.from({ length: maxPlayers }, (_, i) => i).find(s => !taken.includes(s)) ?? 0
          addPlayer(state, reg.tg_id, reg.name, config.minBuyIn, free)
          const afkP = state.players.find(p => p.id === reg.tg_id)
          if (afkP) afkP.connected = false
        }
        tables.set(tableId, state)
      }
    }
  }

  broadcastTable(tableId)
  send(ws, { type: 'joined', playerId, tableId, chips: playerChips, maxPlayers, bank: bankChips })
  scheduleStart(tableId)
}

// ─── Stats & tournament end ────────────────────────────────────────────────────

async function checkSFEnd(state: GameState) {
  const tableId = state.tableId
  const sessionId = Number(tableId.match(/_(\d+)$/)?.[1])
  if (!sessionId) return
  if (sfEndedTables.has(tableId)) return

  const alive = state.players.filter(p => p.chips > 0)
  if (alive.length > 1) return

  const winner = alive[0] || state.players.reduce((best, p) => p.chips > best.chips ? p : best, state.players[0])
  if (!winner) return

  sfEndedTables.add(tableId)

  const result = await completeSFSession(sessionId, winner.id, winner.name).catch(e => {
    console.error('SF complete error:', e)
    sfEndedTables.delete(tableId)
    return null
  })
  if (!result) return

  const winnerHand = state.winners.find(w => w.playerId === winner.id)?.hand || ''
  broadcastToTable(tableId, { type: 'tournament_end', winnerId: winner.id, winnerName: winner.name, prize: result.prize, tableId, winnerHand })

  setTimeout(() => {
    tables.delete(tableId)
    sfBlinds.delete(tableId)
    sfPrizes.delete(tableId)
    sfEndedTables.delete(tableId)
    clearActionTimer(tableId)
    const st = startTimers.get(tableId)
    if (st) { clearTimeout(st); startTimers.delete(tableId) }
    for (const key of [...playerBanks.keys()]) { if (key.startsWith(`${tableId}:`)) playerBanks.delete(key) }
    for (const key of [...afkMode]) { if (key.startsWith(`${tableId}:`)) afkMode.delete(key) }
    for (const key of [...sitOutSet]) { if (key.startsWith(`${tableId}:`)) sitOutSet.delete(key) }
    for (const key of [...afkRequestTimers.keys()]) { if (key.startsWith(`${tableId}:`)) { clearTimeout(afkRequestTimers.get(key)!); afkRequestTimers.delete(key) } }
    for (const key of [...afkKickTimers.keys()]) { if (key.startsWith(`${tableId}:`)) { clearTimeout(afkKickTimers.get(key)!); afkKickTimers.delete(key) } }
    tableGifts.delete(tableId)
    runoutTables.delete(tableId)
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

    let updated: any[]
    if (isSF) {
      const r = await db.query(
        `UPDATE pf_users SET hands_played=hands_played+1, hands_won=hands_won+$1, biggest_pot=GREATEST(biggest_pot,$2)
         WHERE tg_id=$3 RETURNING hands_played, referred_by, referral_credited, referral_bonus`,
        [isWinner ? 1 : 0, isWinner ? wonAmount : 0, player.id]
      ).catch(() => ({ rows: [] as any[] }))
      updated = r.rows
    } else {
      const bank = playerBanks.get(`${state.tableId}:${player.id}`) ?? 0
      const r = await db.query(
        `UPDATE pf_users SET chips=$1, hands_played=hands_played+1, hands_won=hands_won+$2, biggest_pot=GREATEST(biggest_pot,$3)
         WHERE tg_id=$4 RETURNING hands_played, referred_by, referral_credited, referral_bonus`,
        [bank + player.chips, isWinner ? 1 : 0, isWinner ? wonAmount : 0, player.id]
      ).catch(() => ({ rows: [] as any[] }))
      updated = r.rows
    }

    if (isWinner && wonAmount > 0) await logTransaction(player.id, 'win', wonAmount, `Won hand at ${state.tableId}`)

    const row = updated[0]
    if (row && row.hands_played >= 10 && row.referred_by && !row.referral_credited) {
      const bonus = row.referral_bonus || 1000
      await db.query(`UPDATE pf_users SET chips=chips+$1, referrals_count=referrals_count+1 WHERE tg_id=$2`, [bonus, row.referred_by]).catch(() => {})
      await db.query(`UPDATE pf_users SET referral_credited=TRUE WHERE tg_id=$1`, [player.id]).catch(() => {})
      await logTransaction(row.referred_by, 'referral', bonus, `Referral bonus: ${player.id} completed 10 hands`)
    }
  }

  db.query(
    `INSERT INTO pf_hand_history (table_id, board, players, winners, pot) VALUES ($1,$2,$3,$4,$5)`,
    [state.tableId, JSON.stringify(state.board), JSON.stringify(state.players.filter(p => p.holeCards?.length).map(p => ({
      id: p.id, name: p.name, holeCards: p.holeCards, folded: p.folded,
      won: winnerIds.has(p.id), wonAmount: state.winners.find(w => w.playerId === p.id)?.amount || 0,
      hand: state.winners.find(w => w.playerId === p.id)?.hand || '',
    }))), JSON.stringify(state.winners), state.winners.reduce((s, w) => s + w.amount, 0)]
  ).catch(() => {})

  // Chip dump detection: soft, non-blocking
  if (!isSF && !TOURNAMENT_TABLE_IDS.has(state.tableId)) {
    checkChipDump(state).catch(() => {})
  }

  if (TOURNAMENT_TABLE_IDS.has(state.tableId)) await checkTournamentEnd(state).catch(console.error)
  if (isSF) await checkSFEnd(state).catch(console.error)
}

async function checkChipDump(state: GameState) {
  if (!process.env.DATABASE_URL) return
  const db = getPool()
  const winnerIds = new Set(state.winners.map(w => w.playerId))
  const losers = state.players.filter(p => !winnerIds.has(p.id) && !p.folded && p.holeCards?.some(c => (c.rank as string) !== '?'))
  if (!losers.length || state.winners.length !== 1) return
  const winnerId = state.winners[0].playerId

  for (const loser of losers) {
    if (loser.id === winnerId) continue
    // Get last 12 hands at this table involving both players
    const { rows } = await db.query(
      `SELECT players FROM pf_hand_history
       WHERE table_id=$1 AND players::text LIKE $2 AND players::text LIKE $3
       ORDER BY created_at DESC LIMIT 12`,
      [state.tableId, `%"id":"${loser.id}"%`, `%"id":"${winnerId}"%`]
    ).catch(() => ({ rows: [] as any[] }))

    if (rows.length < 8) continue

    let loserLostCount = 0
    let totalLost = 0
    for (const row of rows) {
      const players: any[] = row.players
      const loserEntry = players.find((p: any) => p.id === loser.id)
      const winnerEntry = players.find((p: any) => p.id === winnerId)
      if (!loserEntry || !winnerEntry) continue
      if (!loserEntry.won && winnerEntry.won) {
        loserLostCount++
        totalLost += winnerEntry.wonAmount || 0
      }
    }

    const lossRate = loserLostCount / rows.length
    // Flag if lost to same player in 75%+ of hands AND transferred significant chips
    if (lossRate >= 0.75 && totalLost >= 5000) {
      await db.query(
        `UPDATE pf_users SET suspicious=TRUE, suspicious_reason=$1 WHERE tg_id=$2 AND suspicious=FALSE`,
        [`Lost ${Math.round(lossRate*100)}% of ${rows.length} hands to same player (${totalLost} chips) at ${state.tableId}`, loser.id]
      ).catch(() => {})
    }
  }
}

async function checkTournamentEnd(state: GameState) {
  const db = getPool()
  const tableId = state.tableId
  const alive = state.players.filter(p => {
    const bank = playerBanks.get(`${tableId}:${p.id}`) ?? 0
    return (bank + p.chips) > 0
  })
  if (alive.length > 1) return

  const { rows: regRows } = await db.query(`SELECT COUNT(*) as cnt FROM pf_tournament_regs WHERE tournament_id=$1`, [tableId]).catch(() => ({ rows: [{ cnt: 0 }] }))
  const registered = Number(regRows[0]?.cnt || 0)

  const CONFIGS: Record<string, { basePrize: number; buyIn: number }> = {
    daily: { basePrize: 50_000, buyIn: 2_000 },
    weekly: { basePrize: 300_000, buyIn: 5_000 },
  }
  const cfg = CONFIGS[tableId]
  if (!cfg) return
  const prizePool = Math.max(cfg.basePrize, registered * cfg.buyIn)
  const tiers =
    registered <= 4  ? [{ place: 1, pct: 60 }, { place: 2, pct: 40 }]
    : registered <= 8  ? [{ place: 1, pct: 50 }, { place: 2, pct: 30 }, { place: 3, pct: 20 }]
    :                    [{ place: 1, pct: 40 }, { place: 2, pct: 25 }, { place: 3, pct: 15 }, { place: 4, pct: 12 }, { place: 5, pct: 8 }]

  const winner = alive[0] || state.players[0]
  if (!winner) return

  const winnerPrize = Math.floor(prizePool * tiers[0].pct / 100)
  await db.query(`UPDATE pf_users SET chips=chips+$1, tournaments_won=tournaments_won+1 WHERE tg_id=$2`, [winnerPrize, winner.id]).catch(() => {})
  await logTransaction(winner.id, 'tournament_win', winnerPrize, `Won ${tableId} tournament! 🏆 +${winnerPrize.toLocaleString()} chips`)
  await db.query(`INSERT INTO pf_tournament_history (tournament_id,winner_tg_id,winner_name,prize,players_count,prize_pool) VALUES ($1,$2,$3,$4,$5,$6)`, [tableId, winner.id, winner.name, winnerPrize, registered, prizePool]).catch(() => {})
  await db.query(`UPDATE pf_tournament_status SET status='finished' WHERE tournament_id=$1`, [tableId]).catch(() => {})
  await db.query(`DELETE FROM pf_tournament_regs WHERE tournament_id=$1`, [tableId]).catch(() => {})

  broadcastToTable(tableId, { type: 'tournament_end', winnerId: winner.id, winnerName: winner.name, prize: winnerPrize, tableId })
}

// ─── HTTP stats ───────────────────────────────────────────────────────────────

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
