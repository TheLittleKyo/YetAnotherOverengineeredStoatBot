/**
 * SQLite storage (`data/bot.db`) for the stores that change on every message
 * or grow without bound: leveling, economy, activity, analytics, the audit
 * log, moderation cases and the channel-sync ledger.
 *
 * Those used to be JSON files rewritten whole on every save. That cost grows
 * with the data, not with the change — a 50,000-member leveling file took
 * ~100 ms to stringify and write, every few seconds while chat was active, on
 * the main thread. Here a message costs a few single-row upserts (tens of
 * microseconds each), every change is on disk as soon as it is made instead
 * of after a debounce, and leaderboards come from an index instead of sorting
 * every member.
 *
 * Small, rarely-changed settings stay in their JSON files, where they remain
 * readable and hand-editable; a module's per-server settings that belong with
 * its SQLite rows live in `module_settings`.
 *
 * - WAL journal with `synchronous = NORMAL`: a commit is a sequential append,
 *   and a crash can lose at most the last few commits, never corrupt the file.
 * - The schema is versioned with `PRAGMA user_version`; `MIGRATIONS` only ever
 *   grows.
 * - A store's old JSON file is imported the first time the store is used, then
 *   renamed to `<file>.migrated.bak` (see `importLegacyJson`).
 * - One connection for the life of the process. Node runs every statement to
 *   completion synchronously, so there are no concurrent writers inside the
 *   process; a second bot instance on the same data directory is still
 *   unsupported.
 *
 * `node:sqlite` needs Node 22.13 or later (the engines field asks for 22.15).
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import type { DatabaseSync as DatabaseSyncType, StatementSync } from 'node:sqlite';
import { dataFile, ensureDataDir } from './json-store.js';
import { warn } from './logger.js';

/**
 * `node:sqlite` prints an ExperimentalWarning when it loads. It is loaded here
 * through `require` (not a static import) so that one warning can be filtered
 * while it loads; every other warning still prints.
 */
const { DatabaseSync } = (() => {
  const originalEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: any[]) => {
    const message = typeof warning === 'string' ? warning : warning?.message;
    if (/SQLite is an experimental feature/i.test(String(message || ''))) return;
    return (originalEmitWarning as any).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
  } finally {
    process.emitWarning = originalEmitWarning;
  }
})();

export const DB_FILE_NAME = 'bot.db';

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a shipped entry: add a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

  -- A module's per-server settings, as JSON (config, shop, role rewards).
  CREATE TABLE module_settings (
    module TEXT NOT NULL,
    server_id TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (module, server_id)
  ) WITHOUT ROWID;

  CREATE TABLE leveling_users (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    xp INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    avatar_id TEXT,
    last_at TEXT NOT NULL DEFAULT '',
    last_xp_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX leveling_users_rank ON leveling_users (server_id, xp DESC, user_id);

  CREATE TABLE economy_users (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL DEFAULT '',
    total_earned INTEGER NOT NULL DEFAULT 0,
    last_message_at INTEGER NOT NULL DEFAULT 0,
    last_daily_at INTEGER NOT NULL DEFAULT 0,
    daily_streak INTEGER NOT NULL DEFAULT 0,
    last_work_at INTEGER NOT NULL DEFAULT 0,
    inventory TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (server_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX economy_users_rich ON economy_users (server_id, balance DESC, user_id);

  CREATE TABLE activity_totals (
    server_id TEXT PRIMARY KEY,
    messages INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    attachments INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE activity_users (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    avatar_id TEXT,
    messages INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    attachments INTEGER NOT NULL DEFAULT 0,
    last_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (server_id, user_id)
  ) WITHOUT ROWID;
  CREATE INDEX activity_users_messages ON activity_users (server_id, messages DESC);
  CREATE INDEX activity_users_images ON activity_users (server_id, images DESC);
  CREATE TABLE activity_daily (
    server_id TEXT NOT NULL,
    day TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    images INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, day)
  ) WITHOUT ROWID;

  CREATE TABLE analytics_servers (
    server_id TEXT PRIMARY KEY,
    since TEXT,
    voice_minutes INTEGER NOT NULL DEFAULT 0,
    voice_sessions INTEGER NOT NULL DEFAULT 0
  ) WITHOUT ROWID;
  CREATE TABLE analytics_daily (
    server_id TEXT NOT NULL,
    day TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    joins INTEGER NOT NULL DEFAULT 0,
    leaves INTEGER NOT NULL DEFAULT 0,
    voice_minutes INTEGER NOT NULL DEFAULT 0,
    commands INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, day)
  ) WITHOUT ROWID;
  -- Messages per hour of day (kind 'h', 0-23) and per weekday (kind 'w', 0-6).
  CREATE TABLE analytics_slots (
    server_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    slot INTEGER NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, kind, slot)
  ) WITHOUT ROWID;
  CREATE TABLE analytics_channels (
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    messages INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, channel_id)
  ) WITHOUT ROWID;
  CREATE TABLE analytics_commands (
    server_id TEXT NOT NULL,
    name TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (server_id, name)
  ) WITHOUT ROWID;

  -- seq keeps insertion order, which is the log's order.
  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    server_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    actor_id TEXT NOT NULL DEFAULT '',
    actor_name TEXT NOT NULL,
    source TEXT NOT NULL,
    area TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_server ON audit (server_id, seq);

  CREATE TABLE moderation_cases (
    server_id TEXT NOT NULL,
    id INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    user_name TEXT NOT NULL,
    moderator_id TEXT NOT NULL DEFAULT '',
    moderator_name TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    duration_ms INTEGER,
    expires_at INTEGER,
    active INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    automated INTEGER NOT NULL DEFAULT 0,
    mute_method TEXT,
    mute_role_id TEXT,
    PRIMARY KEY (server_id, id)
  ) WITHOUT ROWID;
  CREATE INDEX moderation_cases_user ON moderation_cases (server_id, user_id);
  CREATE INDEX moderation_cases_expiry ON moderation_cases (active, expires_at);
  -- Case numbers are never reused, even after the newest case is deleted.
  CREATE TABLE moderation_counters (server_id TEXT PRIMARY KEY, next_case_id INTEGER NOT NULL) WITHOUT ROWID;

  CREATE TABLE sync_mirrors (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT NOT NULL UNIQUE,
    link_id TEXT NOT NULL,
    source_channel_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    target_channel_id TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX sync_mirrors_source ON sync_mirrors (source_id);
  `,
];

let db: DatabaseSyncType | null = null;
let statements = new Map<string, StatementSync>();
let transactionDepth = 0;

/** The open database, created and migrated on first use. */
export function getDb(): DatabaseSyncType {
  if (db) return db;
  ensureDataDir();
  const opened = new DatabaseSync(dataFile(DB_FILE_NAME));
  try {
    opened.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
    migrate(opened);
  } catch (error) {
    opened.close();
    throw error;
  }
  db = opened;
  statements = new Map();
  return db;
}

function migrate(database: DatabaseSyncType): void {
  const row = database.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = Number(row?.user_version || 0);
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(MIGRATIONS[version]);
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw new Error(`Database migration ${version + 1} failed: ${(error as Error)?.message || error}`);
    }
  }
}

/** A prepared statement, compiled once per connection. */
export function sql(text: string): StatementSync {
  const database = getDb();
  let statement = statements.get(text);
  if (!statement) {
    statement = database.prepare(text);
    statements.set(text, statement);
  }
  return statement;
}

/**
 * Run `fn` in one transaction: all of its writes land together, in a single
 * commit. Nested calls join the outer transaction. `fn` must be synchronous.
 */
export function transaction<T>(fn: () => T): T {
  const database = getDb();
  if (transactionDepth > 0) {
    transactionDepth += 1;
    try {
      return fn();
    } finally {
      transactionDepth -= 1;
    }
  }
  database.exec('BEGIN IMMEDIATE');
  transactionDepth = 1;
  try {
    const result = fn();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    transactionDepth = 0;
  }
}

/** SQLite binds numbers, strings and null only. */
export function bool(value: unknown): number {
  return value ? 1 : 0;
}

export function getMeta(key: string): string | null {
  const row = sql('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setMeta(key: string, value: string): void {
  sql('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

// ---- Per-server module settings ------------------------------------------------

export function readModuleSettings(module: string, serverId: string): unknown | null {
  const row = sql('SELECT data FROM module_settings WHERE module = ? AND server_id = ?').get(module, serverId) as { data: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.data);
  } catch {
    return null;
  }
}

export function writeModuleSettings(module: string, serverId: string, data: unknown): void {
  sql(
    'INSERT INTO module_settings (module, server_id, data) VALUES (?, ?, ?) ON CONFLICT(module, server_id) DO UPDATE SET data = excluded.data',
  ).run(module, serverId, JSON.stringify(data));
}

export function listModuleSettings(module: string): { serverId: string; data: unknown }[] {
  const rows = sql('SELECT server_id, data FROM module_settings WHERE module = ?').all(module) as { server_id: string; data: string }[];
  return rows.flatMap((row) => {
    try {
      return [{ serverId: row.server_id, data: JSON.parse(row.data) }];
    } catch {
      return [];
    }
  });
}

export function deleteModuleSettings(module: string, serverId?: string): void {
  if (serverId === undefined) sql('DELETE FROM module_settings WHERE module = ?').run(module);
  else sql('DELETE FROM module_settings WHERE module = ? AND server_id = ?').run(module, serverId);
}

// ---- Importing the old JSON files --------------------------------------------

/**
 * Bring a store's old JSON file into the database, once. The file is imported
 * in one transaction and then renamed to `<file>.migrated.bak`, so the data is
 * never lost and never imported twice.
 *
 * The import time is also recorded: if the rename fails (a locked file on
 * Windows), the next start sees the same file and skips it rather than
 * rolling the database back to it. A file dropped in later (newer than the
 * recorded import) is imported again, so a hand-restored JSON file still works.
 *
 * `importer` receives the parsed file and runs inside the transaction. An
 * unreadable file is left where it is, with a warning.
 */
export function importLegacyJson(fileName: string, importer: (data: any) => void): void {
  const path = dataFile(fileName);
  if (!existsSync(path)) return;

  const metaKey = `imported:${fileName}`;
  let modifiedAt = 0;
  try {
    modifiedAt = Math.floor(statSync(path).mtimeMs);
  } catch {
    return;
  }
  const importedAt = Number(getMeta(metaKey) || 0);
  if (importedAt && modifiedAt <= importedAt) return;

  let data: unknown;
  try {
    const raw = readFileSync(path, 'utf-8').trim();
    data = raw ? JSON.parse(raw) : null;
  } catch (error) {
    warn(`db: could not read ${fileName} for import, leaving it in place: ${(error as Error)?.message || error}`);
    return;
  }

  transaction(() => {
    if (data && typeof data === 'object') importer(data);
    setMeta(metaKey, String(Date.now()));
  });

  try {
    renameSync(path, `${path}.migrated.bak`);
  } catch (error) {
    warn(`db: imported ${fileName}, but could not rename it (${(error as Error)?.message || error}); it will not be imported again.`);
  }
}

// ---- Lifecycle -----------------------------------------------------------------

/** Delete every row (`!reset`). The schema, and the import records, stay. */
export function wipeDatabase(): void {
  const database = getDb();
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'meta'")
    .all() as { name: string }[];
  transaction(() => {
    for (const { name } of tables) database.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
  });
}

/** Close the connection (graceful shutdown). The next use reopens it. */
export function closeDb(): void {
  if (!db) return;
  try {
    db.exec('PRAGMA optimize');
  } catch {
    // Best-effort housekeeping.
  }
  db.close();
  db = null;
  statements = new Map();
}
