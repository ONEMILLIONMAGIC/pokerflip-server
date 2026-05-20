import { Pool } from 'pg'

let pool: Pool | null = null

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  }
  return pool
}

export async function logTransaction(tgId: string, type: string, amount: number, desc: string) {
  const db = getPool()
  await db.query(
    'INSERT INTO pf_transactions (tg_id, type, amount, desc) VALUES ($1,$2,$3,$4)',
    [tgId, type, amount, desc]
  ).catch(() => {})
}

export async function initDB() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_users (
      tg_id           TEXT PRIMARY KEY,
      username        TEXT,
      first_name      TEXT,
      photo_url       TEXT,
      chips           INTEGER NOT NULL DEFAULT 3000,
      claimed_at      TIMESTAMPTZ NOT NULL DEFAULT '2000-01-01',
      referred_by     TEXT,
      referrals_count INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS referred_by TEXT`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS referrals_count INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS hands_played INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS hands_won INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS biggest_pot INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS tournaments_won INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_transactions (
      id         SERIAL PRIMARY KEY,
      tg_id      TEXT NOT NULL,
      type       TEXT NOT NULL,
      amount     INTEGER NOT NULL,
      desc       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pf_tx_tg ON pf_transactions(tg_id, created_at DESC)`)
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS streak_days INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS last_login_date DATE`).catch(() => {})
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_achievements (
      tg_id          TEXT NOT NULL,
      achievement_id TEXT NOT NULL,
      unlocked_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tg_id, achievement_id)
    )
  `)

  // Tournament registrations table
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_tournament_regs (
      tg_id         TEXT NOT NULL,
      tournament_id TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (tg_id, tournament_id)
    )
  `)
}
