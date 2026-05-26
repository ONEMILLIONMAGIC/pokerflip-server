import { Pool } from 'pg'

let pool: Pool | null = null

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  }
  return pool
}

export async function logTransaction(tgId: string, type: string, amount: number, description: string) {
  const db = getPool()
  await db.query(
    'INSERT INTO pf_transactions (tg_id, type, amount, description) VALUES ($1,$2,$3,$4)',
    [tgId, type, amount, description]
  ).catch(e => console.error('logTransaction error:', e.message))
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
      id          SERIAL PRIMARY KEY,
      tg_id       TEXT NOT NULL,
      type        TEXT NOT NULL,
      amount      INTEGER NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_pf_tx_tg ON pf_transactions(tg_id, created_at DESC)`)
  await db.query(`ALTER TABLE pf_transactions ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS streak_days INTEGER NOT NULL DEFAULT 0`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS last_login_date DATE`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS last_spin_at TIMESTAMPTZ`).catch(() => {})
  // Referral anti-bot: bonus credited only after referred player plays 10 hands
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS referral_credited BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {})
  // referral_bonus: how much the referrer earns (3000 for premium-referred, 1000 for regular)
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS referral_bonus INTEGER NOT NULL DEFAULT 1000`).catch(() => {})
  // last_notified_at: track when push notification was last sent to avoid spam
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS last_notified_at TIMESTAMPTZ`).catch(() => {})
  // lang: user's preferred language (ru/en/it), set on /start from Telegram language_code
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS lang VARCHAR(2) NOT NULL DEFAULT 'en'`).catch(() => {})
  // Hand history
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_hand_history (
      id         SERIAL PRIMARY KEY,
      table_id   TEXT NOT NULL,
      board      JSONB NOT NULL,
      players    JSONB NOT NULL,
      winners    JSONB NOT NULL,
      pot        INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `).catch(() => {})
  await db.query(`CREATE INDEX IF NOT EXISTS idx_hand_history_table ON pf_hand_history(table_id, created_at DESC)`).catch(() => {})
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_ton_payments (
      boc_hash   TEXT PRIMARY KEY,
      tg_id      TEXT NOT NULL,
      package_id TEXT NOT NULL,
      chips      INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
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
      cycle_key     TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tg_id, tournament_id)
    )
  `)
  // Migration: add cycle_key to existing tables
  await db.query(`ALTER TABLE pf_tournament_regs ADD COLUMN IF NOT EXISTS cycle_key TEXT NOT NULL DEFAULT ''`).catch(() => {})

  // Tournament lifecycle status
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_tournament_status (
      tournament_id TEXT PRIMARY KEY,
      status        TEXT NOT NULL DEFAULT 'pending',
      cycle_key     TEXT NOT NULL DEFAULT '',
      started_at    TIMESTAMPTZ
    )
  `)
  await db.query(`INSERT INTO pf_tournament_status (tournament_id) VALUES ('daily'),('weekly') ON CONFLICT DO NOTHING`)

  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_tournament_history (
      id            SERIAL PRIMARY KEY,
      tournament_id TEXT NOT NULL,
      winner_tg_id  TEXT NOT NULL,
      winner_name   TEXT NOT NULL,
      prize         INTEGER NOT NULL,
      players_count INTEGER NOT NULL DEFAULT 0,
      prize_pool    INTEGER NOT NULL DEFAULT 0,
      finished_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // Spin & Flip
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_sf_sessions (
      id           SERIAL PRIMARY KEY,
      room_id      TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'waiting',
      prize        INTEGER NOT NULL DEFAULT 0,
      table_id     TEXT,
      winner_tg_id TEXT,
      started_at   TIMESTAMPTZ,
      finished_at  TIMESTAMPTZ
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_sf_registrations (
      session_id   INTEGER NOT NULL,
      tg_id        TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (session_id, tg_id)
    )
  `)
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_sf_bankroll (
      room_id   TEXT PRIMARY KEY,
      chips     BIGINT NOT NULL DEFAULT 0,
      total_in  BIGINT NOT NULL DEFAULT 0,
      total_out BIGINT NOT NULL DEFAULT 0,
      rounds    INTEGER NOT NULL DEFAULT 0
    )
  `)
  // Seed initial bankrolls (only if not already present)
  await db.query(`
    INSERT INTO pf_sf_bankroll (room_id, chips) VALUES
      ('sf_rush',   100000),
      ('sf_clash',  300000),
      ('sf_royale', 500000)
    ON CONFLICT DO NOTHING
  `)
  // Daily mission claims — prevents double-claiming server-side
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_mission_claims (
      tg_id      TEXT NOT NULL,
      mission_id TEXT NOT NULL,
      claim_date DATE NOT NULL DEFAULT CURRENT_DATE,
      PRIMARY KEY (tg_id, mission_id, claim_date)
    )
  `)
  // Anti-cheat: suspicious flag for chip dumping detection
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS suspicious BOOLEAN NOT NULL DEFAULT FALSE`).catch(() => {})
  await db.query(`ALTER TABLE pf_users ADD COLUMN IF NOT EXISTS suspicious_reason TEXT`).catch(() => {})
  // Index for hand history per-player lookup
  await db.query(`CREATE INDEX IF NOT EXISTS idx_hand_history_created ON pf_hand_history(created_at DESC)`).catch(() => {})
}
