import { Card, Rank, RANK_VAL } from './deck'

export type HandRank = 0|1|2|3|4|5|6|7|8 // high→straight flush
const HAND_NAMES = ['High Card','One Pair','Two Pair','Three of a Kind','Straight','Flush','Full House','Four of a Kind','Straight Flush']

export interface HandResult { rank: HandRank; name: string; score: number; best5: Card[] }

function rankVal(r: Rank) { return RANK_VAL[r] }

export function evaluate(cards: Card[]): HandResult {
  // Pick best 5 from up to 7 cards (2 hole + 5 board)
  const combos = choose5(cards)
  let best: HandResult | null = null
  for (const combo of combos) {
    const result = eval5(combo)
    if (!best || result.score > best.score) best = result
  }
  return best!
}

function choose5(cards: Card[]): Card[][] {
  if (cards.length === 5) return [cards]
  const result: Card[][] = []
  for (let i = 0; i < cards.length - 4; i++)
    for (let j = i+1; j < cards.length - 3; j++)
      for (let k = j+1; k < cards.length - 2; k++)
        for (let l = k+1; l < cards.length - 1; l++)
          for (let m = l+1; m < cards.length; m++)
            result.push([cards[i], cards[j], cards[k], cards[l], cards[m]])
  return result
}

function eval5(cards: Card[]): HandResult {
  const vals = cards.map(c => rankVal(c.rank)).sort((a,b) => b-a)
  const suits = cards.map(c => c.suit)
  const isFlush = suits.every(s => s === suits[0])
  const isStraight = checkStraight(vals)
  const groups = groupBy(vals)
  const counts = Object.values(groups).sort((a,b) => b-a)

  let rank: HandRank
  let score: number

  if (isFlush && isStraight) {
    rank = 8
    score = 8_000_000 + (isStraight === 'wheel' ? 5 : vals[0])
  } else if (counts[0] === 4) {
    rank = 7; score = 7_000_000 + quads(groups) * 1000 + kickers(groups, [4])
  } else if (counts[0] === 3 && counts[1] === 2) {
    rank = 6; score = 6_000_000 + trips(groups) * 1000 + pairs(groups)[0]
  } else if (isFlush) {
    rank = 5; score = 5_000_000 + encodeVals(vals)
  } else if (isStraight) {
    rank = 4; score = 4_000_000 + (isStraight === 'wheel' ? 5 : vals[0])
  } else if (counts[0] === 3) {
    rank = 3; score = 3_000_000 + trips(groups) * 10000 + kickers(groups, [3])
  } else if (counts[0] === 2 && counts[1] === 2) {
    rank = 2; const ps = pairs(groups).sort((a,b) => b-a); score = 2_000_000 + ps[0]*1000 + ps[1]*50 + kickers(groups, [2,2])
  } else if (counts[0] === 2) {
    rank = 1; score = 1_000_000 + pairs(groups)[0] * 10000 + kickers(groups, [2])
  } else {
    rank = 0; score = encodeVals(vals)
  }

  return { rank, name: HAND_NAMES[rank], score, best5: cards }
}

function checkStraight(vals: number[]): false | 'normal' | 'wheel' {
  const unique = [...new Set(vals)]
  if (unique.length < 5) return false
  if (unique[0] - unique[4] === 4) return 'normal'
  // Wheel A-2-3-4-5
  if (unique[0] === 14 && unique[1] === 5 && unique[2] === 4 && unique[3] === 3 && unique[4] === 2) return 'wheel'
  return false
}

function groupBy(vals: number[]) {
  const g: Record<number,number> = {}
  for (const v of vals) g[v] = (g[v] || 0) + 1
  return g
}

function encodeVals(vals: number[]) {
  return vals.reduce((acc, v, i) => acc + v * Math.pow(15, 4 - i), 0)
}

function quads(g: Record<number,number>) { return Number(Object.entries(g).find(([,c]) => c===4)![0]) }
function trips(g: Record<number,number>) { return Number(Object.entries(g).find(([,c]) => c===3)![0]) }
function pairs(g: Record<number,number>) { return Object.entries(g).filter(([,c]) => c===2).map(([v]) => Number(v)) }
function kickers(g: Record<number,number>, exclude: number[]) {
  const excl = [...exclude]
  return Object.entries(g)
    .filter(([,c]) => { const i = excl.indexOf(c); if (i>=0){excl.splice(i,1);return false} return true })
    .map(([v]) => Number(v))
    .sort((a,b) => b-a)
    .reduce((acc, v, i) => acc + v * Math.pow(15, 2-i), 0)
}

export function compareHands(a: HandResult, b: HandResult): number {
  return a.score - b.score
}
