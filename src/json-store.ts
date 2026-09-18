/**
 * Shared JSON file-store helpers. Every feature module used to carry its own
 * copy of `ensureDataDir` / `readJsonFile` / `writeJsonFile` (~19 duplicates
 * with subtly different error handling). This centralizes that logic so the
 * behavior — atomic writes, empty-file auto-heal, corrupt-file quarantine — is
 * identical everywhere and fixed in one place.
 *
 * Note on concurrency: all reads/writes here are synchronous (`readFileSync` /
 * `writeFileSync`). Node runs each read-modify-write to completion without
 * interleaving, so a single process has no lost-update race between store ops.
 * The atomic temp-file rename guards against *partial* writes (crash / power
 * loss mid-write), not against concurrent writers — there are none within the
 * process. Cross-process access (a second bot instance on the same data dir)
 * is unsupported. The stores that change on every message live in SQLite
 * instead (db.ts); these files hold settings.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, unlinkSync } from 'fs';
import { basename, dirname, join, parse as parsePath, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import { debug, warn, error as logError } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute path to the shared data directory. Defaults to `data/` (sibling of
 * `src/`), but honors `YAOSB_DATA_DIR` so tests can point every store at a
 * throwaway temp dir — and so a second instance can run against its own data.
 */
export const DATA_DIR = process.env.YAOSB_DATA_DIR
  ? resolve(process.env.YAOSB_DATA_DIR)
  : join(__dirname, '..', 'data');

/** Resolve a data-file path by name, e.g. `dataFile('tickets.json')`. */
export function dataFile(name: string): string {
  return join(DATA_DIR, name);
}

/**
 * Guard for the destructive paths (`!reset`, `npm run clear:data`), which
 * delete the whole data directory. `YAOSB_DATA_DIR` is operator-supplied, so
 * a typo like `YAOSB_DATA_DIR=/` would otherwise hand `rm -rf` a filesystem
 * root. Refuse anything that is a root, a home directory, or shallower than
 * two path segments; the default `<repo>/data` is always far deeper.
 */
export function assertSafeDataDir(): void {
  const target = resolve(DATA_DIR);
  const { root } = parsePath(target);
  const segments = target.slice(root.length).split(sep).filter(Boolean);
  if (segments.length < 2 || target === resolve(homedir())) {
    throw new Error(`Refusing to clear unexpected data path: ${target}`);
  }
}

/** Create the data directory if it does not exist yet. */
export function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Read and parse a JSON file. Returns `defaultValue` when the file is missing,
 * empty, or corrupt. An empty file is healed by rewriting the default; a
 * corrupt file is quarantined to `<file>.corrupt.<ts>.bak` before healing so no
 * data is silently destroyed.
 */
export function readJson<T>(filePath: string, defaultValue: T): T {
  try {
    if (existsSync(filePath)) {
      const data = readFileSync(filePath, 'utf-8');
      if (!data.trim()) {
        writeJson(filePath, defaultValue);
        return defaultValue;
      }
      return JSON.parse(data) as T;
    }
  } catch (err) {
    logError(`json-store: failed to read ${filePath}: ${(err as Error)?.message || err}`);
    try {
      if (existsSync(filePath)) {
        const backupPath = `${filePath}.corrupt.${Date.now()}.bak`;
        renameSync(filePath, backupPath);
        warn(`json-store: quarantined corrupt file to ${backupPath}`);
      }
      writeJson(filePath, defaultValue);
    } catch (repairErr) {
      logError(`json-store: failed to repair ${filePath}: ${(repairErr as Error)?.message || repairErr}`);
    }
  }
  return defaultValue;
}

/**
 * Write a value as pretty JSON atomically: write to `<file>.tmp`, then rename
 * over the target. Falls back to a direct write if the rename fails (e.g.
 * cross-volume, or Windows locking the target).
 */
export function writeJson(filePath: string, data: unknown): void {
  ensureDataDir();
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    debug('json-store', `atomic rename failed, fell back to direct write: ${(err as Error)?.message || err}`);
  }
}

/**
 * Read-modify-write helper: reads the file (or default), passes it to
 * `mutator`, and writes back the returned value. Because it is synchronous end
 * to end, it cannot interleave with another store op. Returns the written value.
 */
export function updateJson<T>(filePath: string, defaultValue: T, mutator: (current: T) => T): T {
  const current = readJson(filePath, defaultValue);
  const next = mutator(current);
  writeJson(filePath, next);
  return next;
}

// ---- In-memory caches and backups -----------------------------------------

type DataFileHooks = {
  /** Write anything held back by a debounce, so a backup reads current data. */
  flush?: () => void;
  /** Forget the in-memory copy after the file was replaced on disk. */
  reload?: () => void;
};

const dataFileHooks = new Map<string, DataFileHooks[]>();

/**
 * Let a module that keeps a data file in memory take part in backups. Without
 * this, a backup reads a file that is missing the last few seconds of
 * debounced writes, and a restore is silently undone by the next save of the
 * stale cache.
 */
export function registerDataFileHooks(fileName: string, hooks: DataFileHooks): void {
  const key = basename(fileName);
  const list = dataFileHooks.get(key) || [];
  list.push(hooks);
  dataFileHooks.set(key, list);
}

/** Flush every registered debounced store (before a backup reads the files). */
export function flushDataFiles(): void {
  for (const [fileName, list] of dataFileHooks) {
    for (const hooks of list) {
      try {
        hooks.flush?.();
      } catch (err) {
        logError(`Failed to flush ${fileName}:`, (err as Error)?.message || err);
      }
    }
  }
}

/** Drop the in-memory copy of one data file (after a restore rewrote it). */
export function reloadDataFile(fileName: string): void {
  for (const hooks of dataFileHooks.get(basename(fileName)) || []) {
    try {
      hooks.reload?.();
    } catch (err) {
      logError(`Failed to reload ${fileName}:`, (err as Error)?.message || err);
    }
  }
}

// ---- Stores kept in SQLite that backups still see as JSON files -------------

type VirtualDataFile = {
  /** The store in its old JSON file's shape, or null when it holds nothing. */
  read(): unknown | null;
  /** Replace the whole store with data in that shape. */
  write(data: unknown): void;
};

const virtualDataFiles = new Map<string, VirtualDataFile>();

/**
 * Let a store that moved into SQLite (db.ts) keep its place in backups under
 * its old file name. Backups carry, remap and merge the old JSON shape, so the
 * backup format — and every backup already taken — stays valid.
 */
export function registerVirtualDataFile(fileName: string, handlers: VirtualDataFile): void {
  virtualDataFiles.set(basename(fileName), handlers);
}

/**
 * A data file's contents by name: a SQLite-backed store in its old shape, or
 * the parsed JSON file. `undefined` when there is nothing. Throws on a file
 * that does not parse, so the caller can say which one.
 */
export function readDataFileContent(fileName: string): unknown | undefined {
  const virtual = virtualDataFiles.get(basename(fileName));
  if (virtual) return virtual.read() ?? undefined;
  const path = dataFile(fileName);
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, 'utf-8').trim();
  return raw ? JSON.parse(raw) : {};
}

/** A data file's size in bytes (its JSON form, for a SQLite-backed store), or null when there is none. */
export function dataFileSize(fileName: string): number | null {
  const virtual = virtualDataFiles.get(basename(fileName));
  if (virtual) {
    const content = virtual.read();
    return content == null ? null : Buffer.byteLength(JSON.stringify(content));
  }
  const path = dataFile(fileName);
  return existsSync(path) ? statSync(path).size : null;
}

/** Replace a data file's contents by name, wherever the store keeps them. */
export function writeDataFileContent(fileName: string, data: unknown): void {
  const virtual = virtualDataFiles.get(basename(fileName));
  if (virtual) virtual.write(data);
  else writeJson(dataFile(fileName), data);
}

/** Drop every in-memory copy (after `!reset` wiped the data directory). */
export function reloadAllDataFiles(): void {
  for (const fileName of dataFileHooks.keys()) reloadDataFile(fileName);
}

/** A cached, single-array JSON file: `{ "<key>": [...] }`. */
export type ArrayFileStore<T> = {
  /** The stored array, read from disk once and then served from memory. */
  read(): T[];
  /** Replace the array and persist it atomically. */
  write(items: T[]): void;
};

/**
 * Build a store for the `{ "<key>": [...] }` files the per-server feature
 * modules keep (antiraid, autoreact, autoresponder, captcha, reminders). Each
 * of those carried the same read-with-memory-cache / atomic-write pair; the
 * shape validation is the only thing that ever differed, and that is just the
 * key name.
 *
 * The cache matters: `read()` sits on the message hot path (the autoresponder
 * consults it for every message), so it must not hit the disk each time. The
 * process is the only writer, so the cache cannot go stale behind our back.
 *
 * A missing, empty or unreadable file yields an empty array — the feature
 * starts from defaults rather than crashing the bot.
 */
export function createArrayFileStore<T>(filePath: string, key: string, label: string): ArrayFileStore<T> {
  let cache: T[] | null = null;
  // A backup restore replaces the file on disk; the cache must follow it, or
  // the next write would put the pre-restore array straight back.
  registerDataFileHooks(basename(filePath), { reload: () => { cache = null; } });

  function read(): T[] {
    if (cache) return cache;
    try {
      if (existsSync(filePath)) {
        const raw = readFileSync(filePath, 'utf-8').trim();
        if (raw) {
          const parsed = JSON.parse(raw);
          cache = Array.isArray(parsed?.[key]) ? (parsed[key] as T[]) : [];
          return cache;
        }
      }
    } catch (err) {
      logError(`Failed to read ${label} file:`, (err as Error)?.message || err);
    }
    cache = [];
    return cache;
  }

  function write(items: T[]): void {
    cache = items;
    writeJson(filePath, { [key]: items });
  }

  return { read, write };
}
