import Database, { type Database as DatabaseType } from 'better-sqlite3'
import path from 'path'
import { existsSync, mkdirSync } from 'fs'

const DB_PATH = process.env['DB_PATH'] ?? './quorum.db'

// Ensure parent directory exists
const dbDir = path.dirname(path.resolve(DB_PATH))
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true })

export const db: DatabaseType = new Database(DB_PATH)

// Enable WAL mode for better concurrency
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

/** Create all tables if they don't exist */
export function initDb(): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS users (' +
    '  id            TEXT PRIMARY KEY,' +
    '  email         TEXT UNIQUE NOT NULL,' +
    '  password_hash TEXT NOT NULL,' +
    '  created_at    TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');' +

    'CREATE TABLE IF NOT EXISTS sessions (' +
    '  id          TEXT PRIMARY KEY,' +
    '  user_id     TEXT NOT NULL REFERENCES users(id),' +
    '  command     TEXT NOT NULL,' +
    '  description TEXT,' +
    '  status      TEXT NOT NULL DEFAULT \'pending\',' +
    '  project_dir TEXT,' +
    '  pid         INTEGER,' +
    '  created_at  TEXT NOT NULL DEFAULT (datetime(\'now\')),' +
    '  updated_at  TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');' +

    'CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, created_at DESC);' +

    'CREATE TABLE IF NOT EXISTS session_events (' +
    '  id          INTEGER PRIMARY KEY AUTOINCREMENT,' +
    '  session_id  TEXT NOT NULL REFERENCES sessions(id),' +
    '  event_type  TEXT NOT NULL,' +
    '  payload     TEXT NOT NULL,' +
    '  created_at  TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');' +

    'CREATE INDEX IF NOT EXISTS idx_events_session ON session_events(session_id, id);' +

    'CREATE TABLE IF NOT EXISTS api_keys (' +
    '  id            TEXT PRIMARY KEY,' +
    '  user_id       TEXT NOT NULL REFERENCES users(id),' +
    '  provider      TEXT NOT NULL,' +
    '  encrypted_key TEXT NOT NULL,' +
    '  created_at    TEXT NOT NULL DEFAULT (datetime(\'now\')),' +
    '  UNIQUE(user_id, provider)' +
    ');' +

    'CREATE TABLE IF NOT EXISTS telegram_links (' +
    '  chat_id   TEXT PRIMARY KEY,' +
    '  user_id   TEXT NOT NULL REFERENCES users(id),' +
    '  linked_at TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');' +

    // Teams: maps teams_user_id → atlas user_id
    'CREATE TABLE IF NOT EXISTS teams_links (' +
    '  teams_user_id TEXT PRIMARY KEY,' +
    '  user_id       TEXT NOT NULL REFERENCES users(id),' +
    '  linked_at     TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');' +

    // Slack: maps slack_user_id → atlas user_id
    'CREATE TABLE IF NOT EXISTS slack_links (' +
    '  slack_user_id TEXT PRIMARY KEY,' +
    '  user_id       TEXT NOT NULL REFERENCES users(id),' +
    '  linked_at     TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');' +

    // Discord: maps discord_user_id → atlas user_id
    'CREATE TABLE IF NOT EXISTS discord_links (' +
    '  discord_user_id TEXT PRIMARY KEY,' +
    '  user_id         TEXT NOT NULL REFERENCES users(id),' +
    '  linked_at       TEXT NOT NULL DEFAULT (datetime(\'now\'))' +
    ');'
  )

  // telegram_link_tokens is recreated on every start so schema is always fresh.
  // It's safe to drop — tokens expire in 10 min and are ephemeral.
  db.exec('DROP TABLE IF EXISTS telegram_link_tokens')
  db.exec(
    'CREATE TABLE telegram_link_tokens (' +
    '  token      TEXT PRIMARY KEY,' +
    '  user_id    TEXT,' +
    '  chat_id    TEXT NOT NULL,' +
    '  expires_at TEXT NOT NULL' +
    ')'
  )

  // teams_link_tokens: same pattern, ephemeral
  db.exec('DROP TABLE IF EXISTS teams_link_tokens')
  db.exec(
    'CREATE TABLE teams_link_tokens (' +
    '  token         TEXT PRIMARY KEY,' +
    '  teams_user_id TEXT NOT NULL,' +
    '  expires_at    TEXT NOT NULL' +
    ')'
  )
}
