/**
 * Bot audit log — who changed the bot's own configuration, and how.
 *
 * Stoat's audit surface covers what happens *in* a server; this covers what
 * happens *to the bot*: a dashboard tab saving settings, a command flipping a
 * feature on, automod acting on its own. When two people share a dashboard (or
 * a share link is handed to a moderator), "who turned the captcha off?" has to
 * have an answer.
 *
 * Every write is one line. The dashboard records them generically — the
 * request namespace and path are enough to say which area changed — while
 * feature modules add the detail only they know (a case number, a rule name).
 *
 * Storage: SQLite (db.ts), the `audit` table, one row per entry in the order
 * written, capped per server. The old `data/audit.json` is imported on first use.
 */

import { config } from './config.js';
import { importLegacyJson, sql } from './db.js';

export type AuditSource = 'dashboard' | 'command' | 'automation' | 'system';

/**
 * A unique id for an audit entry. `seq` is the real key and ordering; `id` only
 * needs to be unique for legacy-import dedupe. The random suffix is wide enough
 * that even a burst of entries within one millisecond does not collide (a
 * collision would make the INSERT throw and, though `recordAudit` swallows it,
 * silently drop the entry).
 */
function auditId(at: number): string {
  return `au_${at.toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

export type AuditEntry = {
  id: string;
  at: number;
  serverId: string;
  /** User id where known; '' for anonymous share-link guests and the system. */
  actorId: string;
  actorName: string;
  source: AuditSource;
  /** Feature area, e.g. `moderation`, `automod`, `economy`, `leveling`. */
  area: string;
  /** What happened, e.g. `settings`, `rule.add`, `ban`. */
  action: string;
  detail: string;
};

const MAX_ENTRIES_PER_SERVER = 2000;

let ready = false;

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeEntry(value: any, serverId: string): AuditEntry | null {
  const at = Number(value?.at);
  if (!Number.isFinite(at)) return null;
  return {
    id: text(value?.id, 40) || `au_${at.toString(36)}`,
    at,
    serverId: text(value?.serverId, 64) || serverId,
    actorId: text(value?.actorId, 64),
    actorName: text(value?.actorName, 80) || 'Unknown',
    source: (['dashboard', 'command', 'automation', 'system'] as const).includes(value?.source) ? value.source : 'system',
    area: text(value?.area, 40) || 'unknown',
    action: text(value?.action, 60) || 'change',
    detail: text(value?.detail, 300),
  };
}

function insert(entry: AuditEntry, orIgnore = false) {
  sql(
    `INSERT ${orIgnore ? 'OR IGNORE ' : ''}INTO audit (id, server_id, at, actor_id, actor_name, source, area, action, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(entry.id, entry.serverId, entry.at, entry.actorId, entry.actorName, entry.source, entry.area, entry.action, entry.detail);
}

/** Import `data/audit.json` on first use, oldest entries first. */
function ensureReady() {
  if (ready) return;
  importLegacyJson('audit.json', (raw) => {
    const servers = raw?.servers && typeof raw.servers === 'object' ? raw.servers : {};
    for (const [serverId, entries] of Object.entries<any>(servers)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const normalized = normalizeEntry(entry, serverId);
        if (normalized) insert(normalized, true);
      }
    }
  });
  ready = true;
}

export type AuditInput = {
  serverId: string;
  actorId?: string;
  actorName?: string;
  source: AuditSource;
  area: string;
  action: string;
  detail?: string;
};

/**
 * Record one configuration change. Never throws: an audit failure must not take
 * down the action it was describing.
 */
export function recordAudit(input: AuditInput): void {
  try {
    const serverId = text(input.serverId, 64) || text(config.serverId, 64);
    if (!serverId) return;
    ensureReady();
    const at = Date.now();
    insert({
      id: auditId(at),
      at,
      serverId,
      actorId: text(input.actorId, 64),
      actorName: text(input.actorName, 80) || 'Unknown',
      source: input.source,
      area: text(input.area, 40) || 'unknown',
      action: text(input.action, 60) || 'change',
      detail: text(input.detail, 300),
    });
    // Everything older than the newest MAX_ENTRIES_PER_SERVER goes.
    sql(
      `DELETE FROM audit WHERE server_id = ? AND seq <= (
         SELECT seq FROM audit WHERE server_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ${MAX_ENTRIES_PER_SERVER}
       )`,
    ).run(serverId, serverId);
  } catch {
    // Auditing is best-effort by design.
  }
}

export type AuditQuery = {
  area?: string;
  actorId?: string;
  source?: AuditSource;
  limit?: number;
};

function rowToEntry(row: any): AuditEntry {
  return {
    id: row.id,
    at: row.at,
    serverId: row.server_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    source: row.source,
    area: row.area,
    action: row.action,
    detail: row.detail,
  };
}

/** Newest first. */
export function listAudit(serverId = config.serverId || '', query: AuditQuery = {}): AuditEntry[] {
  ensureReady();
  const clauses = ['server_id = ?'];
  const params: (string | number)[] = [serverId];
  if (query.area) {
    clauses.push('area = ?');
    params.push(query.area);
  }
  if (query.actorId) {
    clauses.push('actor_id = ?');
    params.push(query.actorId);
  }
  if (query.source) {
    clauses.push('source = ?');
    params.push(query.source);
  }
  const limit = query.limit ? ' LIMIT ?' : '';
  if (query.limit) params.push(Math.max(0, Math.floor(query.limit)));
  const rows = sql(`SELECT * FROM audit WHERE ${clauses.join(' AND ')} ORDER BY seq DESC${limit}`).all(...params) as any[];
  return rows.map(rowToEntry);
}

/** Distinct areas present in a server's log, for the dashboard filter. */
export function listAuditAreas(serverId = config.serverId || ''): string[] {
  ensureReady();
  return (sql('SELECT DISTINCT area FROM audit WHERE server_id = ? ORDER BY area').all(serverId) as any[]).map((row) => row.area);
}

export function clearAudit(serverId = config.serverId || ''): number {
  ensureReady();
  return Number(sql('DELETE FROM audit WHERE server_id = ?').run(serverId).changes);
}
