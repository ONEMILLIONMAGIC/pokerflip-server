export const RANKS = [
  { name: 'Rookie',  icon: '🃏', xp: 0 },
  { name: 'Amateur', icon: '🎯', xp: 1_000 },
  { name: 'Grinder', icon: '⚡', xp: 5_000 },
  { name: 'Pro',     icon: '💎', xp: 20_000 },
  { name: 'Shark',   icon: '🦈', xp: 75_000 },
  { name: 'Legend',  icon: '👑', xp: 250_000 },
]

export function calcXP(handsPlayed: number, handsWon: number, biggestPot: number): number {
  return (handsPlayed * 10) + (handsWon * 30) + Math.floor(biggestPot / 500)
}

export function getRank(xp: number) {
  let rank = RANKS[0]
  for (const r of RANKS) {
    if (xp >= r.xp) rank = r
    else break
  }
  const idx = RANKS.indexOf(rank)
  const next = RANKS[idx + 1] || null
  const progress = next
    ? Math.min(100, Math.floor(((xp - rank.xp) / (next.xp - rank.xp)) * 100))
    : 100
  return { ...rank, xp, next, progress }
}
