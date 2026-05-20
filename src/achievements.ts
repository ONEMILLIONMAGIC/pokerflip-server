import { getPool, logTransaction } from './db'

export interface Achievement {
  id: string
  icon: string
  name: string
  desc: string
  bonus: number
  unlocked: boolean
  unlockedAt?: string
}

const DEFS: { id: string; icon: string; name: string; desc: string; bonus: number;
  check: (u: any, extra: any) => boolean }[] = [
  { id: 'first_hand',    icon: '🃏', name: 'First Hand',       desc: 'Play your first hand',             bonus: 100,    check: (u) => u.hands_played >= 1 },
  { id: 'first_win',     icon: '🏆', name: 'First Win',        desc: 'Win your first hand',              bonus: 500,    check: (u) => u.hands_won >= 1 },
  { id: 'high_roller',   icon: '💰', name: 'High Roller',      desc: 'Win a pot of 10,000+ chips',       bonus: 2000,   check: (u) => u.biggest_pot >= 10000 },
  { id: 'sharpshooter',  icon: '🎯', name: 'Sharpshooter',     desc: '60%+ win rate (min 20 hands)',     bonus: 1500,   check: (u) => u.hands_played >= 20 && (u.hands_won / u.hands_played) >= 0.6 },
  { id: 'century',       icon: '💯', name: 'Century',          desc: 'Play 100 hands',                   bonus: 3000,   check: (u) => u.hands_played >= 100 },
  { id: 'grinder',       icon: '⚡', name: 'Grinder',          desc: 'Play 500 hands',                   bonus: 10000,  check: (u) => u.hands_played >= 500 },
  { id: 'on_fire',       icon: '🔥', name: 'On Fire',          desc: '7-day login streak',               bonus: 2000,   check: (u) => u.streak_days >= 7 },
  { id: 'legend_rank',   icon: '👑', name: 'Legend',           desc: 'Reach Legend rank (250K XP)',      bonus: 20000,  check: (u) => calcXP(u) >= 250000 },
  { id: 'social',        icon: '👥', name: 'Social Butterfly', desc: 'Refer 3 friends',                  bonus: 5000,   check: (u) => u.referrals_count >= 3 },
  { id: 'supporter',     icon: '⭐', name: 'Supporter',        desc: 'Buy chips with Stars',             bonus: 1000,   check: (_, e) => e.hasPurchase },
  { id: 'tournament',    icon: '🏅', name: 'Tournament Player',desc: 'Register for a tournament',        bonus: 500,    check: (_, e) => e.hasTournament },
]

function calcXP(u: any) {
  return (u.hands_played * 10) + (u.hands_won * 30) + Math.floor(u.biggest_pot / 500)
}

export async function getAchievements(tgId: string): Promise<Achievement[]> {
  const db = getPool()

  const userRes = await db.query('SELECT * FROM pf_users WHERE tg_id=$1', [tgId])
  const user = userRes.rows[0]
  if (!user) return DEFS.map(d => ({ id: d.id, icon: d.icon, name: d.name, desc: d.desc, bonus: d.bonus, unlocked: false }))

  const [earnedRes, purchaseRes, tournamentRes] = await Promise.all([
    db.query('SELECT achievement_id, unlocked_at FROM pf_achievements WHERE tg_id=$1', [tgId]).catch(() => ({ rows: [] })),
    db.query("SELECT 1 FROM pf_transactions WHERE tg_id=$1 AND type='purchase' LIMIT 1", [tgId]).catch(() => ({ rows: [] })),
    db.query('SELECT 1 FROM pf_tournament_regs WHERE tg_id=$1 LIMIT 1', [tgId]).catch(() => ({ rows: [] })),
  ])

  const earned = new Map(earnedRes.rows.map((r: any) => [r.achievement_id, r.unlocked_at]))
  const extra = { hasPurchase: purchaseRes.rows.length > 0, hasTournament: tournamentRes.rows.length > 0 }

  const result: Achievement[] = []
  const newlyUnlocked: string[] = []

  for (const def of DEFS) {
    const alreadyEarned = earned.has(def.id)
    const qualifies = def.check(user, extra)

    if (qualifies && !alreadyEarned) newlyUnlocked.push(def.id)

    result.push({
      id: def.id, icon: def.icon, name: def.name, desc: def.desc, bonus: def.bonus,
      unlocked: alreadyEarned || qualifies,
      unlockedAt: earned.get(def.id) || (qualifies ? new Date().toISOString() : undefined),
    })
  }

  // Award newly unlocked achievements
  if (newlyUnlocked.length > 0) {
    const totalBonus = newlyUnlocked.reduce((sum, id) => {
      const def = DEFS.find(d => d.id === id)!
      return sum + def.bonus
    }, 0)

    await Promise.all([
      ...newlyUnlocked.map(id =>
        db.query('INSERT INTO pf_achievements (tg_id, achievement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [tgId, id])
      ),
      db.query('UPDATE pf_users SET chips = chips + $1 WHERE tg_id=$2', [totalBonus, tgId]),
      ...newlyUnlocked.map(id => {
        const def = DEFS.find(d => d.id === id)!
        return logTransaction(tgId, 'achievement', def.bonus, `Achievement: ${def.name}`)
      }),
    ])
  }

  return result
}
