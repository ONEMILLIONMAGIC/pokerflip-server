import { Card, makeDeck, shuffle } from './deck'
import { evaluate, compareHands } from './handEval'

export type PlayerAction = 'fold' | 'check' | 'call' | 'raise' | 'allin'
export type Street = 'waiting' | 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export interface Player {
  id: string
  name: string
  chips: number
  holeCards: Card[]
  bet: number       // current street bet
  totalBet: number  // total invested this hand
  folded: boolean
  allIn: boolean
  connected: boolean
  seatIndex: number
  hasActed: boolean // has voluntarily acted this street
}

export interface GameState {
  tableId: string
  players: Player[]
  deck: Card[]
  board: Card[]
  street: Street
  pot: number
  sidePots: { amount: number; eligible: string[] }[]
  currentBet: number  // highest bet on street
  minRaise: number
  dealerIdx: number
  actionIdx: number   // who acts next
  smallBlind: number
  bigBlind: number
  lastActionTime: number
  winners: { playerId: string; amount: number; hand: string }[]
}

export function createTable(tableId: string, sb = 10, bb = 20): GameState {
  return {
    tableId, players: [], deck: [], board: [],
    street: 'waiting', pot: 0, sidePots: [],
    currentBet: 0, minRaise: bb,
    dealerIdx: 0, actionIdx: 0,
    smallBlind: sb, bigBlind: bb,
    lastActionTime: Date.now(), winners: [],
  }
}

export function canStart(state: GameState): boolean {
  return state.players.filter(p => p.connected && p.chips > 0).length >= 2
}

export function startHand(state: GameState): GameState {
  const s = deepClone(state)
  const activePlayers = s.players.filter(p => p.connected && p.chips > 0)
  if (activePlayers.length < 2) return s

  // Reset hand state
  s.deck = shuffle(makeDeck())
  s.board = []
  s.pot = 0
  s.sidePots = []
  s.currentBet = s.bigBlind
  s.minRaise = s.bigBlind
  s.winners = []
  s.street = 'preflop'
  s.lastActionTime = Date.now()

  for (const p of s.players) {
    p.holeCards = []
    p.bet = 0
    p.totalBet = 0
    p.folded = p.chips === 0
    p.allIn = false
    p.hasActed = false
  }

  // Move dealer button (skip broke/disconnected)
  s.dealerIdx = nextActiveIdx(s, s.dealerIdx)

  // Deal 2 cards to each active player
  for (const p of s.players.filter(p => !p.folded)) {
    p.holeCards = [s.deck.pop()!, s.deck.pop()!]
  }

  // Post blinds
  const sbIdx = nextActiveIdx(s, s.dealerIdx)
  const bbIdx = nextActiveIdx(s, sbIdx)

  postBlind(s, sbIdx, s.smallBlind)
  postBlind(s, bbIdx, s.bigBlind)

  // Action starts left of BB
  s.actionIdx = nextActiveIdx(s, bbIdx)

  return s
}

function postBlind(s: GameState, idx: number, amount: number) {
  const p = s.players[idx]
  if (!p) return
  const actual = Math.min(amount, p.chips)
  p.chips -= actual
  p.bet += actual
  p.totalBet += actual
  s.pot += actual
  if (p.chips === 0) p.allIn = true
}

export function applyAction(state: GameState, playerId: string, action: PlayerAction, amount = 0): GameState {
  const s = deepClone(state)
  const p = s.players[s.actionIdx]
  if (!p || p.id !== playerId || p.folded || p.allIn) return s

  const toCall = s.currentBet - p.bet

  switch (action) {
    case 'fold':
      p.folded = true
      break

    case 'check':
      if (toCall > 0) return s // can't check
      break

    case 'call': {
      const callAmt = Math.min(toCall, p.chips)
      p.chips -= callAmt
      p.bet += callAmt
      p.totalBet += callAmt
      s.pot += callAmt
      if (p.chips === 0) p.allIn = true
      break
    }

    case 'raise':
    case 'allin': {
      const raiseAmt = action === 'allin' ? p.chips : Math.min(amount, p.chips)
      if (raiseAmt < s.minRaise && p.chips > raiseAmt) return s // invalid raise
      const newBet = p.bet + raiseAmt
      s.minRaise = Math.max(s.minRaise, newBet - s.currentBet)
      s.currentBet = Math.max(s.currentBet, newBet)
      p.chips -= raiseAmt
      p.bet += raiseAmt
      p.totalBet += raiseAmt
      s.pot += raiseAmt
      if (p.chips === 0) p.allIn = true
      break
    }
  }

  p.hasActed = true
  s.lastActionTime = Date.now()

  // Check if street is over
  if (isStreetOver(s)) {
    return advanceStreet(s)
  }

  s.actionIdx = nextActiveIdx(s, s.actionIdx)
  return s
}

function isStreetOver(s: GameState): boolean {
  const active = s.players.filter(p => !p.folded && !p.allIn)
  if (active.length === 0) return true
  // All active players have matched the current bet AND had a chance to act
  return active.every(p => p.hasActed && p.bet === s.currentBet)
}

function advanceStreet(s: GameState): GameState {
  // Reset bets and acted flags for new street
  for (const p of s.players) { p.bet = 0; p.hasActed = false }
  s.currentBet = 0
  s.minRaise = s.bigBlind

  const notFolded = s.players.filter(p => !p.folded)

  if (notFolded.length === 1) {
    // Everyone else folded — winner takes pot
    s.winners = [{ playerId: notFolded[0].id, amount: s.pot, hand: 'Last standing' }]
    notFolded[0].chips += s.pot
    s.pot = 0
    s.street = 'showdown'
    return s
  }

  switch (s.street) {
    case 'preflop':
      s.board.push(s.deck.pop()!, s.deck.pop()!, s.deck.pop()!) // flop
      s.street = 'flop'
      break
    case 'flop':
      s.board.push(s.deck.pop()!) // turn
      s.street = 'turn'
      break
    case 'turn':
      s.board.push(s.deck.pop()!) // river
      s.street = 'river'
      break
    case 'river':
      s.street = 'showdown'
      return resolveShowdown(s)
  }

  // Action starts from first active player left of dealer
  s.actionIdx = nextActiveIdx(s, s.dealerIdx)
  return s
}

function resolveShowdown(s: GameState): GameState {
  const contenders = s.players.filter(p => !p.folded)
  const results = contenders.map(p => ({
    player: p,
    result: evaluate([...p.holeCards, ...s.board]),
  }))

  // Log showdown details for debugging
  const boardStr = s.board.map(c => `${c.rank}${c.suit}`).join(' ')
  for (const r of results) {
    const hole = r.player.holeCards.map(c => `${c.rank}${c.suit}`).join(' ')
    console.log(`[Showdown] ${r.player.name}: hole=[${hole}] board=[${boardStr}] → ${r.result.name} (score=${r.result.score})`)
  }
  // Also log folded players so we can see if they had strong hands
  for (const p of s.players.filter(p => p.folded && p.holeCards.length > 0)) {
    const hole = p.holeCards.map(c => `${c.rank}${c.suit}`).join(' ')
    const ev = evaluate([...p.holeCards, ...s.board])
    console.log(`[Showdown] ${p.name} (FOLDED): hole=[${hole}] board=[${boardStr}] → would have had ${ev.name} (score=${ev.score})`)
  }

  results.sort((a, b) => compareHands(b.result, a.result))

  // Handle split pot (ties)
  const topScore = results[0].result.score
  const winners = results.filter(r => r.result.score === topScore)

  if (winners.length > 1) {
    const share = Math.floor(s.pot / winners.length)
    const remainder = s.pot - share * winners.length
    for (let i = 0; i < winners.length; i++) {
      winners[i].player.chips += share + (i === 0 ? remainder : 0)
    }
    s.winners = winners.map((w, i) => ({
      playerId: w.player.id,
      amount: share + (i === 0 ? remainder : 0),
      hand: w.result.name,
    }))
    console.log(`[Showdown] SPLIT POT: ${winners.map(w=>w.player.name).join(' & ')} each get ${share}`)
  } else {
    const winner = results[0]
    winner.player.chips += s.pot
    s.winners = [{ playerId: winner.player.id, amount: s.pot, hand: winner.result.name }]
    console.log(`[Showdown] WINNER: ${winner.player.name} with ${winner.result.name} (score=${winner.result.score})`)
  }

  s.pot = 0
  return s
}

function nextActiveIdx(s: GameState, fromIdx: number): number {
  const n = s.players.length
  let idx = (fromIdx + 1) % n
  let tries = 0
  while (tries < n) {
    const p = s.players[idx]
    if (p && !p.folded && !p.allIn && p.connected && p.chips > 0) return idx
    idx = (idx + 1) % n
    tries++
  }
  return fromIdx
}

function deepClone<T>(obj: T): T { return JSON.parse(JSON.stringify(obj)) }

export function addPlayer(state: GameState, id: string, name: string, chips: number, seat: number): GameState {
  const s = deepClone(state)
  const existing = s.players.find(p => p.id === id)
  if (existing) { existing.connected = true; return s }
  s.players.push({ id, name, chips, holeCards: [], bet: 0, totalBet: 0, folded: false, allIn: false, connected: true, seatIndex: seat, hasActed: false })
  s.players.sort((a, b) => a.seatIndex - b.seatIndex)
  return s
}

export function removePlayer(state: GameState, id: string): GameState {
  const s = deepClone(state)
  const p = s.players.find(p => p.id === id)
  if (p) p.connected = false
  return s
}

// Mask hole cards for a specific viewer (hide opponent cards)
export function maskForPlayer(state: GameState, viewerId: string): GameState {
  const s = deepClone(state)
  for (const p of s.players) {
    if (p.id !== viewerId && s.street !== 'showdown') {
      p.holeCards = p.holeCards.map(() => ({ rank: '?', suit: '?' } as any))
    }
  }
  return s
}
