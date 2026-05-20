import { Pool } from 'pg'

let pool: Pool | null = null

export function getPool() {
  if (!pool) {
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  }
  return pool
}

export async function initDB() {
  const db = getPool()
  await db.query(`
    CREATE TABLE IF NOT EXISTS pf_users (
      tg_id      TEXT PRIMARY KEY,
      username   TEXT,
      first_name TEXT,
      photo_url  TEXT,
      chips      INTEGER NOT NULL DEFAULT 3000,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT '2000-01-01',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
}
