/**
 * Moderation case system: warn, mute, kick, ban, unban, and free-form notes,
 * each recorded as a numbered case so a member's history survives the moderator
 * who typed the command.
 *
 * Design notes:
 *
 * - **Cases are the record, actions are the side effect.** Every action writes a
 *   case first and only then touches Stoat, so a kick that fails on the API
 *   still leaves a trail explaining what was attempted. A failed action marks
 *   the case `failed` rather than deleting it.
 * - **Mutes prefer Stoat's own timeout** (`member.timeout(date)`), which the
 *   platform enforces even while the bot is offline. A configured mute role is
 *   the fallback for servers where the bot cannot time members out, and is also
 *   used for mutes longer than Stoat's timeout ceiling.
 * - **Temporary punishments expire through a scheduler tick**, not a per-case
 *   timer, so restarting the bot does not forget them. The tick is idempotent:
 *   an already-lifted mute simply has no active case left to close.
 * - **Escalation counts warnings, not cases.** Warns older than
 *   `warnExpiryDays` stop counting, so a member is not banned in March for a
 *   warning from last year.
 *
 * Storage: SQLite (db.ts). Each case is a row in `moderation_cases`, written
 * whenever it changes; the expiry tick reads only the active, timed ones off an
 * index. Case numbers come from `moderation_counters`, so a deleted case's
 * number is never reused. A server's config lives in `module_settings`. Backups
 * still see all of it as `moderation.json` (see `registerVirtualDataFile`), and
 * the old file is imported on first use.
 */

import { MessageEmbed } from 'stoatbot.js';
import { config } from './config.js';
import { registerDataFileHooks, registerVirtualDataFile } from './json-store.js';
import { sendServerLog } from './log-system.js';
import { formatDuration } from './duration.js';
import { shouldFallbackToRawRequest, stoatRequest } from './stoat-api.js';
import { debug } from './logger.js';
import { sendDirectMessage } from './dm.js';
import { recordAudit, type AuditSource } from './audit.js';
import { getRoleIds } from './member-utils.js';
import { clampText, EMBED_DESCRIPTION_MAX } from './embed-limits.js';
import {
  bool,
  deleteModuleSettings,
  importLegacyJson,
  listModuleSettings,
  readModuleSettings,
  sql,
  transaction,
  writeModuleSettings,
} from './db.js';

export type ModActionType = 'warn' | 'mute' | 'unmute' | 'kick' | 'ban' | 'unban' | 'note';

/** What a member accumulating warnings gets, once they reach `warns`. */
export type EscalationRule = {
  warns: number;
  action: 'mute' | 'kick' | 'ban';
  /** Milliseconds for a temporary mute/ban, or null for permanent. */
  durationMs: number | null;
};

export type ModerationConfig = {
  enabled: boolean;
  /** DM the member what happened and why. */
  dmOnAction: boolean;
  /** Role applied when a native timeout is unavailable or too long. */
  muteRoleId: string | null;
  /** Prefer Stoat's own member timeout over the mute role. */
  preferTimeout: boolean;
  /** Mute length used when a command gives none. */
  defaultMuteMs: number;
  /** Warns older than this stop counting toward escalation. 0 = never expire. */
  warnExpiryDays: number;
  /** Ladder, applied at the highest matching rule. */
  escalation: EscalationRule[];
  /** Where case notices go; null falls back to the server log channel. */
  caseChannelId: string | null;
};

export type ModCase = {
  id: number;
  serverId: string;
  userId: string;
  userName: string;
  moderatorId: string;
  moderatorName: string;
  action: ModActionType;
  reason: string;
  createdAt: number;
  /** Length of a temporary mute/ban; null for permanent or non-temporal actions. */
  durationMs: number | null;
  expiresAt: number | null;
  /** A mute/ban still in force. Cleared when it expires or is lifted. */
  active: boolean;
  /** Set when the Stoat side of the action did not go through. */
  failed: boolean;
  /** Raised by automod or the escalation ladder rather than typed by a person. */
  automated: boolean;
  /** How the mute was applied, so the right undo is used later. */
  muteMethod?: 'timeout' | 'role' | null;
  /** The role a role-mute used, so it is still removed after the setting changes. */
  muteRoleId?: string | null;
};

const SETTINGS_MODULE = 'moderation';
const LEGACY_FILE = 'moderation.json';

// Stoat's own member timeout tops out well below a long ban; anything longer
// falls back to the mute role.
export const MAX_TIMEOUT_MS = 28 * 24 * 60 * 60 * 1000;

// Keep the case list bounded per server so the table cannot grow forever. The
// oldest closed cases are dropped first; active punishments are never dropped.
const MAX_CASES_PER_SERVER = 5000;

const EXPIRY_TICK_MS = 30_000;

const configCache = new Map<string, ModerationConfig>();
let ready = false;

export function defaultModerationConfig(): ModerationConfig {
  return {
    enabled: true,
    dmOnAction: true,
    muteRoleId: null,
    preferTimeout: true,
    defaultMuteMs: 60 * 60 * 1000,
    warnExpiryDays: 30,
    escalation: [
      { warns: 3, action: 'mute', durationMs: 60 * 60 * 1000 },
      { warns: 5, action: 'ban', durationMs: null },
    ],
    caseChannelId: null,
  };
}

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeEscalation(value: any): EscalationRule[] {
  if (!Array.isArray(value)) return [];
  const byWarns = new Map<number, EscalationRule>();
  for (const item of value) {
    const warns = Math.floor(num(item?.warns, 0));
    const action = item?.action === 'kick' || item?.action === 'ban' ? item.action : 'mute';
    if (warns < 1) continue;
    const rawDuration = item?.durationMs;
    const durationMs = rawDuration == null ? null : Math.max(0, Math.floor(num(rawDuration, 0))) || null;
    byWarns.set(warns, { warns, action, durationMs: action === 'kick' ? null : durationMs });
  }
  return Array.from(byWarns.values()).sort((a, b) => a.warns - b.warns);
}

function normalizeConfig(value: any): ModerationConfig {
  const base = defaultModerationConfig();
  if (!value || typeof value !== 'object') return base;
  return {
    enabled: value.enabled !== false,
    dmOnAction: value.dmOnAction !== false,
    muteRoleId: text(value.muteRoleId, 64) || null,
    preferTimeout: value.preferTimeout !== false,
    defaultMuteMs: Math.max(60_000, Math.floor(num(value.defaultMuteMs, base.defaultMuteMs))),
    warnExpiryDays: Math.max(0, Math.floor(num(value.warnExpiryDays, base.warnExpiryDays))),
    escalation: Array.isArray(value.escalation) ? normalizeEscalation(value.escalation) : base.escalation,
    caseChannelId: text(value.caseChannelId, 64) || null,
  };
}

const ACTION_TYPES: ModActionType[] = ['warn', 'mute', 'unmute', 'kick', 'ban', 'unban', 'note'];

function normalizeCase(value: any, serverId: string): ModCase | null {
  const id = Math.floor(num(value?.id, 0));
  const userId = text(value?.userId, 64);
  if (id < 1 || !userId) return null;
  return {
    id,
    serverId,
    userId,
    userName: text(value?.userName, 80) || userId,
    moderatorId: text(value?.moderatorId, 64),
    moderatorName: text(value?.moderatorName, 80) || 'Unknown',
    action: ACTION_TYPES.includes(value?.action) ? value.action : 'note',
    reason: text(value?.reason, 1000) || 'No reason given',
    createdAt: num(value?.createdAt, Date.now()),
    durationMs: value?.durationMs == null ? null : Math.max(0, Math.floor(num(value.durationMs, 0))) || null,
    expiresAt: value?.expiresAt == null ? null : Math.floor(num(value.expiresAt, 0)) || null,
    active: value?.active === true,
    failed: value?.failed === true,
    automated: value?.automated === true,
    muteMethod: value?.muteMethod === 'timeout' || value?.muteMethod === 'role' ? value.muteMethod : null,
    muteRoleId: text(value?.muteRoleId, 64) || null,
  };
}

// ---- Storage ---------------------------------------------------------------

function rowToCase(row: any): ModCase {
  return {
    id: row.id,
    serverId: row.server_id,
    userId: row.user_id,
    userName: row.user_name,
    moderatorId: row.moderator_id,
    moderatorName: row.moderator_name,
    action: row.action,
    reason: row.reason,
    createdAt: row.created_at,
    durationMs: row.duration_ms ?? null,
    expiresAt: row.expires_at ?? null,
    active: row.active === 1,
    failed: row.failed === 1,
    automated: row.automated === 1,
    muteMethod: row.mute_method ?? null,
    muteRoleId: row.mute_role_id ?? null,
  };
}

/**
 * Change a few fields of a stored case. Used once an action's outcome is known,
 * instead of rewriting the whole row: the case may have been edited or deleted
 * from the dashboard while the action was in flight.
 */
function updateCase(record: ModCase, fields: Partial<Pick<ModCase, 'active' | 'failed' | 'muteMethod' | 'muteRoleId'>>) {
  Object.assign(record, fields);
  sql(
    `UPDATE moderation_cases SET active = ?, failed = ?, mute_method = ?, mute_role_id = ? WHERE server_id = ? AND id = ?`,
  ).run(bool(record.active), bool(record.failed), record.muteMethod ?? null, record.muteRoleId ?? null, record.serverId, record.id);
}

/** Write a case as it now stands (insert or overwrite). */
function saveCase(record: ModCase) {
  sql(
    `INSERT OR REPLACE INTO moderation_cases
       (server_id, id, user_id, user_name, moderator_id, moderator_name, action, reason, created_at,
        duration_ms, expires_at, active, failed, automated, mute_method, mute_role_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.serverId,
    record.id,
    record.userId,
    record.userName,
    record.moderatorId,
    record.moderatorName,
    record.action,
    record.reason,
    record.createdAt,
    record.durationMs ?? null,
    record.expiresAt ?? null,
    bool(record.active),
    bool(record.failed),
    bool(record.automated),
    record.muteMethod ?? null,
    record.muteRoleId ?? null,
  );
}

function setNextCaseId(serverId: string, next: number) {
  sql(
    `INSERT INTO moderation_counters (server_id, next_case_id) VALUES (?, ?)
     ON CONFLICT(server_id) DO UPDATE SET next_case_id = MAX(next_case_id, excluded.next_case_id)`,
  ).run(serverId, next);
}

/**
 * Write a whole store in the old `moderation.json` shape: the legacy import,
 * and a backup restore. Servers not in `data` are left alone.
 */
function importStore(data: any) {
  const servers = data?.servers && typeof data.servers === 'object' ? data.servers : {};
  for (const [serverId, state] of Object.entries<any>(servers)) {
    if (!serverId) continue;
    writeModuleSettings(SETTINGS_MODULE, serverId, normalizeConfig(state?.config));
    const cases = Array.isArray(state?.cases)
      ? (state.cases.map((entry: any) => normalizeCase(entry, serverId)).filter(Boolean) as ModCase[])
      : [];
    for (const entry of cases) saveCase(entry);
    const highest = cases.reduce((max, entry) => Math.max(max, entry.id), 0);
    setNextCaseId(serverId, Math.max(highest + 1, Math.floor(num(state?.nextCaseId, 1)) || 1));
  }
}

/** Every server's moderation data in the old `moderation.json` shape, for backups. */
function exportStore(): unknown | null {
  ensureReady();
  const servers: Record<string, { config: ModerationConfig; nextCaseId: number; cases: ModCase[] }> = {};
  const serverFor = (serverId: string) =>
    (servers[serverId] ||= { config: getModerationConfig(serverId), nextCaseId: 1, cases: [] });
  for (const { serverId } of listModuleSettings(SETTINGS_MODULE)) serverFor(serverId);
  for (const row of sql('SELECT server_id, next_case_id FROM moderation_counters').all() as any[]) {
    serverFor(row.server_id).nextCaseId = row.next_case_id;
  }
  for (const row of sql('SELECT * FROM moderation_cases ORDER BY server_id, id').all() as any[]) {
    serverFor(row.server_id).cases.push(rowToCase(row));
  }
  return Object.keys(servers).length ? { version: 1, servers } : null;
}

function ensureReady() {
  if (ready) return;
  importLegacyJson(LEGACY_FILE, importStore);
  ready = true;
}

registerVirtualDataFile(LEGACY_FILE, {
  read: exportStore,
  // A restore hands over the whole file (the other servers merged back in), so
  // the store is replaced as a whole.
  write: (data) => {
    ensureReady();
    transaction(() => {
      sql('DELETE FROM moderation_cases').run();
      sql('DELETE FROM moderation_counters').run();
      deleteModuleSettings(SETTINGS_MODULE);
      importStore(data);
    });
    configCache.clear();
  },
});

// A restore or `!reset` replaced what is stored: drop the cached config.
registerDataFileHooks(LEGACY_FILE, { reload: () => resetModerationCache() });

/** Test hook: drop the cached config so the next read comes from the database. */
export function resetModerationCache() {
  configCache.clear();
}

// ---- Config ----------------------------------------------------------------

export function getModerationConfig(serverId = config.serverId || ''): ModerationConfig {
  ensureReady();
  let cached = configCache.get(serverId);
  if (!cached) {
    cached = normalizeConfig(readModuleSettings(SETTINGS_MODULE, serverId));
    configCache.set(serverId, cached);
  }
  return { ...cached };
}

export function setModerationConfig(patch: Partial<ModerationConfig>, serverId = config.serverId || ''): ModerationConfig {
  const next = normalizeConfig({ ...getModerationConfig(serverId), ...patch });
  writeModuleSettings(SETTINGS_MODULE, serverId, next);
  configCache.set(serverId, next);
  return { ...next };
}

// ---- Cases -----------------------------------------------------------------

export type CaseQuery = {
  userId?: string;
  action?: ModActionType;
  moderatorId?: string;
  activeOnly?: boolean;
  limit?: number;
};

export function listCases(serverId = config.serverId || '', query: CaseQuery = {}): ModCase[] {
  ensureReady();
  const clauses = ['server_id = ?'];
  const params: (string | number)[] = [serverId];
  if (query.userId) {
    clauses.push('user_id = ?');
    params.push(query.userId);
  }
  if (query.action) {
    clauses.push('action = ?');
    params.push(query.action);
  }
  if (query.moderatorId) {
    clauses.push('moderator_id = ?');
    params.push(query.moderatorId);
  }
  if (query.activeOnly) clauses.push('active = 1');
  const limit = query.limit ? ' LIMIT ?' : '';
  if (query.limit) params.push(Math.max(0, Math.floor(query.limit)));
  const rows = sql(`SELECT * FROM moderation_cases WHERE ${clauses.join(' AND ')} ORDER BY id DESC${limit}`).all(...params);
  return (rows as any[]).map(rowToCase);
}

export function getCase(id: number, serverId = config.serverId || ''): ModCase | null {
  ensureReady();
  const row = sql('SELECT * FROM moderation_cases WHERE server_id = ? AND id = ?').get(serverId, Math.floor(num(id, 0)));
  return row ? rowToCase(row) : null;
}

export function deleteCase(id: number, serverId = config.serverId || ''): boolean {
  ensureReady();
  return Number(sql('DELETE FROM moderation_cases WHERE server_id = ? AND id = ?').run(serverId, Math.floor(num(id, 0))).changes) > 0;
}

export function updateCaseReason(id: number, reason: string, serverId = config.serverId || ''): ModCase | null {
  ensureReady();
  const changed = sql('UPDATE moderation_cases SET reason = ? WHERE server_id = ? AND id = ?')
    .run(text(reason, 1000) || 'No reason given', serverId, Math.floor(num(id, 0))).changes;
  return Number(changed) > 0 ? getCase(id, serverId) : null;
}

/** Warnings that still count toward escalation for this member. */
export function countActiveWarns(userId: string, serverId = config.serverId || ''): number {
  const days = getModerationConfig(serverId).warnExpiryDays;
  const cutoff = days > 0 ? Date.now() - days * 86_400_000 : 0;
  const { count } = sql(
    `SELECT COUNT(*) AS count FROM moderation_cases
     WHERE server_id = ? AND user_id = ? AND action = 'warn' AND failed = 0 AND created_at >= ?`,
  ).get(serverId, userId, cutoff) as { count: number };
  return count;
}

function appendCase(serverId: string, entry: Omit<ModCase, 'id' | 'serverId'>): ModCase {
  ensureReady();
  return transaction(() => {
    const counter = sql('SELECT next_case_id FROM moderation_counters WHERE server_id = ?').get(serverId) as { next_case_id: number } | undefined;
    const highest = sql('SELECT MAX(id) AS id FROM moderation_cases WHERE server_id = ?').get(serverId) as { id: number | null };
    const id = Math.max(counter?.next_case_id || 1, (highest?.id || 0) + 1);
    const record: ModCase = { ...entry, id, serverId };
    saveCase(record);
    setNextCaseId(serverId, id + 1);

    const { count } = sql('SELECT COUNT(*) AS count FROM moderation_cases WHERE server_id = ?').get(serverId) as { count: number };
    if (count > MAX_CASES_PER_SERVER) {
      // Keep the newest cases plus every active punishment.
      sql(
        `DELETE FROM moderation_cases WHERE server_id = ? AND active = 0 AND id NOT IN (
           SELECT id FROM moderation_cases WHERE server_id = ? ORDER BY id DESC LIMIT ${MAX_CASES_PER_SERVER}
         )`,
      ).run(serverId, serverId);
    }
    return record;
  });
}

// ---- Stoat plumbing --------------------------------------------------------

async function fetchMember(client: any, serverId: string, userId: string): Promise<any | null> {
  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  if (!server) return null;
  try {
    return await server.members.fetch(userId);
  } catch {
    return server.members?.cache?.get?.(userId) || null;
  }
}

/** Display name for a user id, best-effort — the case list must stay readable. */
export async function resolveDisplayName(client: any, serverId: string, userId: string): Promise<string> {
  if (!userId) return 'Unknown';
  const member = await fetchMember(client, serverId, userId).catch(() => null);
  const memberName = member?.nickname || member?.username || member?.user?.username;
  if (memberName) return String(memberName).slice(0, 80);
  const user = client?.users?.cache?.get?.(userId) || (await client?.users?.fetch?.(userId).catch(() => null));
  return String(user?.displayName || user?.username || userId).slice(0, 80);
}

async function kickMember(client: any, serverId: string, userId: string, member: any): Promise<void> {
  if (member && typeof member.kick === 'function') {
    try {
      await member.kick();
      return;
    } catch (error) {
      if (!shouldFallbackToRawRequest(error)) throw error;
    }
  }
  await stoatRequest(client, 'DELETE', `/servers/${serverId}/members/${userId}`);
}

async function banMember(client: any, serverId: string, userId: string, reason: string): Promise<void> {
  const body = { reason: reason.slice(0, 1024) };
  if (typeof client?.api?.put === 'function') {
    try {
      await client.api.put(`/servers/${serverId}/bans/${userId}`, { body });
      return;
    } catch (error) {
      if (!shouldFallbackToRawRequest(error)) throw error;
    }
  }
  await stoatRequest(client, 'PUT', `/servers/${serverId}/bans/${userId}`, body);
}

async function unbanMember(client: any, serverId: string, userId: string): Promise<void> {
  if (typeof client?.api?.delete === 'function') {
    try {
      await client.api.delete(`/servers/${serverId}/bans/${userId}`);
      return;
    } catch (error) {
      if (!shouldFallbackToRawRequest(error)) throw error;
    }
  }
  await stoatRequest(client, 'DELETE', `/servers/${serverId}/bans/${userId}`);
}

async function timeoutMember(client: any, serverId: string, userId: string, until: Date | null, member: any): Promise<void> {
  if (until && member && typeof member.timeout === 'function') {
    try {
      await member.timeout(until);
      return;
    } catch (error) {
      if (!shouldFallbackToRawRequest(error)) throw error;
    }
  }
  // Clearing a timeout (and the fallback path) goes through the member edit
  // endpoint: `timeout` as an ISO date, or listed in `remove` to lift it. The
  // client's own REST helper is preferred so its rate-limit queue applies.
  const path = `/servers/${serverId}/members/${userId}`;
  const body = until ? { timeout: until.toISOString() } : { remove: ['Timeout'] };
  if (typeof client?.api?.patch === 'function') {
    try {
      await client.api.patch(path, { body });
      return;
    } catch (error) {
      if (!shouldFallbackToRawRequest(error)) throw error;
    }
  }
  await stoatRequest(client, 'PATCH', path, body);
}

/** A member's position: the lowest `rank` among their roles (lower is higher). */
function memberRank(server: any, member: any): number {
  let best = Number.POSITIVE_INFINITY;
  const roles = member?.roles;
  const list = Array.isArray(roles) ? roles : roles instanceof Map ? Array.from(roles.values()) : [];
  for (const role of list) {
    const resolved = typeof role === 'string' ? server?.roles?.cache?.get?.(role) : role;
    const rank = Number(resolved?.rank);
    if (Number.isFinite(rank)) best = Math.min(best, rank);
  }
  // Ids the member object carries without role objects behind them.
  if (best === Number.POSITIVE_INFINITY) {
    for (const roleId of getRoleIds(member?.roleIds)) {
      const rank = Number(server?.roles?.cache?.get?.(roleId)?.rank);
      if (Number.isFinite(rank)) best = Math.min(best, rank);
    }
  }
  return best;
}

/**
 * Whether `actorId` sits above `targetId` in the server's role order, the way
 * Stoat itself decides who may kick, ban or time out whom. Without this, a
 * moderator could use the bot (whose role is usually near the top) to act on
 * someone above them. Returns true when the target is not a member (a ban by
 * id), and when either side cannot be looked up — the API still enforces the
 * bot's own position.
 */
export async function outranks(client: any, serverId: string, actorId: string, targetId: string): Promise<boolean> {
  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  if (!server) return true;
  const ownerId = String(server.ownerId || server.owner?.id || server.owner || '');
  if (ownerId && ownerId === actorId) return true;
  if (ownerId && ownerId === targetId) return false;

  const target = await fetchMember(client, serverId, targetId).catch(() => null);
  if (!target) return true;
  const actor = await fetchMember(client, serverId, actorId).catch(() => null);
  if (!actor) return true;
  return memberRank(server, actor) < memberRank(server, target);
}

async function setMuteRole(client: any, serverId: string, userId: string, roleId: string, add: boolean, member: any): Promise<void> {
  const target = member || (await fetchMember(client, serverId, userId));
  if (target && typeof target.addRole === 'function' && typeof target.removeRole === 'function') {
    await (add ? target.addRole(roleId) : target.removeRole(roleId));
    return;
  }
  throw new Error(`Could not ${add ? 'add' : 'remove'} the mute role: member ${userId} is not reachable.`);
}

// ---- Actions ---------------------------------------------------------------

export type ModActionRequest = {
  serverId: string;
  action: ModActionType;
  userId: string;
  moderatorId: string;
  reason?: string;
  /** Mute / ban length. `undefined` uses the configured default for a mute. */
  durationMs?: number | null;
  /** Set for automod and escalation so the case says who really raised it. */
  automated?: boolean;
  /** Skip the escalation ladder (used when escalation itself is acting). */
  skipEscalation?: boolean;
  /** Shown as the moderator when no member is behind the action (the dashboard). */
  moderatorName?: string;
  /** Where the action came from, for the audit log. */
  source?: AuditSource;
};

export type ModActionResult = {
  ok: boolean;
  case?: ModCase;
  /** Case raised by the escalation ladder on top of this action. */
  escalation?: ModCase | null;
  error?: string;
  /** The action landed, but the member could not be told. */
  dmFailed?: boolean;
};

const ACTION_VERB: Record<ModActionType, string> = {
  warn: 'warned in',
  mute: 'muted in',
  unmute: 'unmuted in',
  kick: 'kicked from',
  ban: 'banned from',
  unban: 'unbanned from',
  note: 'noted in',
};

const ACTION_COLOUR: Record<ModActionType, string> = {
  warn: '#f59e0b',
  mute: '#6366f1',
  unmute: '#22c55e',
  kick: '#f97316',
  ban: '#ef4444',
  unban: '#22c55e',
  note: '#64748b',
};

/**
 * Run a moderation action: record the case, apply it on Stoat, tell the member,
 * log it, and run the escalation ladder when a warning pushed them over a rule.
 */
export async function runModAction(client: any, request: ModActionRequest): Promise<ModActionResult> {
  const serverId = String(request.serverId || '');
  const userId = String(request.userId || '');
  if (!serverId || !userId) return { ok: false, error: 'A server and a member are required.' };
  if (userId === client?.user?.id) return { ok: false, error: 'I will not action myself.' };

  const cfg = getModerationConfig(serverId);
  const action = request.action;
  const reason = text(request.reason, 1000) || 'No reason given';
  const member = await fetchMember(client, serverId, userId).catch(() => null);
  const userName = await resolveDisplayName(client, serverId, userId);
  const moderatorName =
    text(request.moderatorName, 80) ||
    (request.automated ? 'Automatic' : await resolveDisplayName(client, serverId, request.moderatorId));

  let durationMs: number | null = null;
  if (action === 'mute') {
    durationMs = request.durationMs === undefined ? cfg.defaultMuteMs : request.durationMs;
  } else if (action === 'ban') {
    durationMs = request.durationMs ?? null;
  }
  const expiresAt = durationMs ? Date.now() + durationMs : null;

  // The case is written before Stoat is touched, so an action that fails — or a
  // crash halfway through the call — still leaves a record of what was tried.
  const record = appendCase(serverId, {
    userId,
    userName,
    moderatorId: String(request.moderatorId || ''),
    moderatorName,
    action,
    reason,
    createdAt: Date.now(),
    durationMs,
    expiresAt,
    active: false,
    failed: false,
    automated: request.automated === true,
    muteMethod: null,
    muteRoleId: null,
  });

  // A kicked or banned member no longer shares a server with the bot, so a DM
  // sent afterwards would bounce: those two are told first.
  const notifyFirst = action === 'kick' || action === 'ban';
  let dmFailed = false;
  if (notifyFirst && cfg.dmOnAction) {
    dmFailed = !(await notifyMember(client, serverId, userId, record));
  }

  let muteMethod: 'timeout' | 'role' | null = null;
  let error: string | undefined;

  try {
    switch (action) {
      case 'warn':
      case 'note':
        break;
      case 'mute': {
        const canTimeout = cfg.preferTimeout && durationMs != null && durationMs <= MAX_TIMEOUT_MS;
        if (canTimeout) {
          await timeoutMember(client, serverId, userId, new Date(Date.now() + (durationMs as number)), member);
          muteMethod = 'timeout';
        } else if (cfg.muteRoleId) {
          await setMuteRole(client, serverId, userId, cfg.muteRoleId, true, member);
          muteMethod = 'role';
        } else if (durationMs == null) {
          throw new Error('A permanent mute needs a mute role. Set one in the dashboard, or give the mute a duration.');
        } else if (durationMs > MAX_TIMEOUT_MS) {
          throw new Error(`A timeout can last at most ${formatDuration(MAX_TIMEOUT_MS)}. Set a mute role in the dashboard for longer mutes.`);
        } else {
          await timeoutMember(client, serverId, userId, new Date(Date.now() + durationMs), member);
          muteMethod = 'timeout';
        }
        break;
      }
      case 'unmute':
        await liftMute(client, serverId, userId, cfg, member);
        break;
      case 'kick':
        await kickMember(client, serverId, userId, member);
        break;
      case 'ban':
        await banMember(client, serverId, userId, reason);
        break;
      case 'unban':
        await unbanMember(client, serverId, userId);
        break;
    }
  } catch (err: any) {
    error = err?.message || String(err);
  }

  if (error !== undefined) {
    updateCase(record, { failed: true });
    return { ok: false, case: record, error };
  }

  // Earlier punishments are closed only now that the new one is in place: a
  // re-mute that failed must leave the previous mute, and its expiry, alone.
  if (action === 'mute') {
    await replacePreviousMutes(client, serverId, userId, record.id, muteMethod, member);
  }
  if (action === 'ban') closeActiveCases(serverId, userId, 'ban', record.id);
  if (action === 'unmute') closeActiveCases(serverId, userId, 'mute');
  if (action === 'unban') closeActiveCases(serverId, userId, 'ban');

  // A permanent ban stays "active" too, so the dashboard can offer to lift it.
  updateCase(record, {
    active: action === 'mute' || action === 'ban',
    muteMethod,
    muteRoleId: muteMethod === 'role' ? cfg.muteRoleId : null,
  });

  if (!notifyFirst && cfg.dmOnAction && action !== 'note') {
    dmFailed = !(await notifyMember(client, serverId, userId, record));
  }

  await announceCase(client, cfg, record);
  recordAudit({
    serverId,
    actorId: request.automated ? 'automatic' : String(request.moderatorId || ''),
    actorName: moderatorName,
    source: request.source || (request.automated ? 'automation' : 'command'),
    area: 'moderation',
    action,
    detail: `case #${record.id} · ${userName}${durationMs ? ` · ${formatDuration(durationMs)}` : ''}`,
  });

  let escalation: ModCase | null = null;
  if (action === 'warn' && !request.skipEscalation) {
    escalation = await applyEscalation(client, serverId, userId, cfg);
  }

  return { ok: true, case: record, escalation, dmFailed };
}

/** DM the member about a case. Returns false when the DM could not be delivered. */
async function notifyMember(client: any, serverId: string, userId: string, record: ModCase): Promise<boolean> {
  const serverName = client?.servers?.cache?.get?.(serverId)?.name || 'the server';
  const lines = [`You were **${ACTION_VERB[record.action]}** ${serverName}.`, `**Reason:** ${record.reason}`];
  if (record.durationMs) lines.push(`**Duration:** ${formatDuration(record.durationMs)}`);
  lines.push(`**Case:** #${record.id}`);
  const delivery = await sendDirectMessage(client, userId, { content: clampText(lines.join('\n'), 1900) });
  if (!delivery.ok) debug('moderation', () => `DM to ${userId} failed (${delivery.reason}): ${delivery.detail}`);
  return delivery.ok;
}

/**
 * Close the mutes a new mute replaces. A previous role-mute is also undone
 * when the new mute is a timeout, or the member would keep the role forever
 * once its case is no longer active.
 */
async function replacePreviousMutes(
  client: any,
  serverId: string,
  userId: string,
  keepId: number,
  newMethod: 'timeout' | 'role' | null,
  member: any,
): Promise<void> {
  const previous = listCases(serverId, { userId, action: 'mute', activeOnly: true }).filter((entry) => entry.id !== keepId);
  const configuredRoleId = getModerationConfig(serverId).muteRoleId;
  for (const entry of previous) {
    if (entry.muteMethod === 'role' && newMethod !== 'role') {
      const roleId = entry.muteRoleId || configuredRoleId;
      if (roleId) {
        await setMuteRole(client, serverId, userId, roleId, false, member).catch((err) =>
          debug('moderation', () => `old mute role removal failed: ${(err as Error)?.message || err}`),
        );
      }
    }
    updateCase(entry, { active: false });
  }
}

function closeActiveCases(serverId: string, userId: string, action: ModActionType, keepId?: number) {
  sql(
    'UPDATE moderation_cases SET active = 0 WHERE server_id = ? AND user_id = ? AND action = ? AND active = 1 AND id <> ?',
  ).run(serverId, userId, action, keepId ?? -1);
}

async function liftMute(client: any, serverId: string, userId: string, cfg: ModerationConfig, member?: any): Promise<void> {
  const heldRow = sql(
    "SELECT * FROM moderation_cases WHERE server_id = ? AND user_id = ? AND action = 'mute' AND active = 1 ORDER BY id LIMIT 1",
  ).get(serverId, userId);
  const held = heldRow ? rowToCase(heldRow) : null;
  const method = held?.muteMethod;
  const roleId = held?.muteRoleId || cfg.muteRoleId;
  const errors: string[] = [];
  let attempts = 0;

  if (method === 'role' && !roleId) {
    throw new Error('This mute used a role that is no longer configured; remove it from the member by hand.');
  }

  // Undo both mechanisms when the record does not say which was used: a mute
  // applied before an upgrade, or applied by hand, must still lift cleanly.
  if (!method || method === 'timeout') {
    attempts++;
    try {
      await timeoutMember(client, serverId, userId, null, member);
    } catch (err: any) {
      errors.push(err?.message || String(err));
    }
  }
  if ((!method || method === 'role') && roleId) {
    attempts++;
    try {
      await setMuteRole(client, serverId, userId, roleId, false, member);
    } catch (err: any) {
      errors.push(err?.message || String(err));
    }
  }
  // Fail only when every attempted path failed: one working means they are unmuted.
  if (attempts > 0 && errors.length === attempts) {
    throw new Error(errors[0]);
  }
}

/**
 * Apply the escalation rule the member's warning count has just reached. Only
 * the rule matching the exact count fires, so crossing 3 warnings mutes once
 * rather than on every warning after it.
 */
async function applyEscalation(client: any, serverId: string, userId: string, cfg: ModerationConfig): Promise<ModCase | null> {
  const warns = countActiveWarns(userId, serverId);
  const rule = cfg.escalation.filter((entry) => entry.warns === warns).pop();
  if (!rule) return null;

  const result = await runModAction(client, {
    serverId,
    action: rule.action,
    userId,
    moderatorId: '',
    reason: `Automatic escalation: ${warns} warning${warns === 1 ? '' : 's'}`,
    durationMs: rule.durationMs,
    automated: true,
    skipEscalation: true,
  });
  return result.case || null;
}

async function announceCase(client: any, cfg: ModerationConfig, record: ModCase): Promise<void> {
  const lines = [
    `**Member:** <@${record.userId}> (${record.userName})`,
    `**Moderator:** ${record.automated ? 'Automatic' : `<@${record.moderatorId}>`}`,
    `**Reason:** ${record.reason}`,
  ];
  if (record.durationMs) lines.push(`**Duration:** ${formatDuration(record.durationMs)}`);
  const title = `Case #${record.id} · ${record.action}`;
  const description = clampText(lines.join('\n'), EMBED_DESCRIPTION_MAX);

  if (cfg.caseChannelId) {
    try {
      const channel =
        client?.channels?.cache?.get?.(cfg.caseChannelId) ||
        (await client?.channels?.fetch?.(cfg.caseChannelId).catch(() => null));
      if (channel && typeof channel.send === 'function') {
        const embed = new MessageEmbed().setTitle(`🔨 ${title}`).setDescription(description).setColor(ACTION_COLOUR[record.action]);
        await channel.send({ embeds: [embed] });
        return;
      }
    } catch (error) {
      debug('moderation', () => `case channel send failed: ${(error as Error)?.message || error}`);
    }
  }

  await sendServerLog(client, { title, description, colour: ACTION_COLOUR[record.action] }, record.serverId).catch(() => {});
}

// ---- Expiry scheduler ------------------------------------------------------

let expiryTimer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let ticking = false;

export function startModerationScheduler(client: any) {
  clientRef = client;
  if (expiryTimer) return;
  console.log(`[moderation] Expiry scheduler started (tick ${EXPIRY_TICK_MS / 1000}s).`);
  expiryTimer = setInterval(() => {
    void expireDue().catch((error) => console.error('[moderation] expiry tick failed:', error));
  }, EXPIRY_TICK_MS);
  if (typeof expiryTimer.unref === 'function') expiryTimer.unref();
}

/** Whether the expiry tick is armed, for the ops health panel. */
export function isModerationSchedulerRunning(): boolean {
  return expiryTimer !== null;
}

export function stopModerationScheduler() {
  if (expiryTimer) {
    clearInterval(expiryTimer);
    expiryTimer = null;
  }
  clientRef = null;
}

/** Lift every temporary mute/ban whose time is up. Safe to call repeatedly. */
export async function expireDue(now = Date.now()): Promise<number> {
  if (ticking || !clientRef) return 0;
  ticking = true;
  let lifted = 0;
  try {
    ensureReady();
    // Read off the (active, expires_at) index: only what is due, never every case.
    const due = (sql(
      'SELECT * FROM moderation_cases WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ? ORDER BY server_id, id',
    ).all(now) as any[]).map(rowToCase);
    for (const entry of due) {
      const serverId = entry.serverId;
      try {
        if (entry.action === 'mute') {
          await liftMute(clientRef, serverId, entry.userId, getModerationConfig(serverId));
        } else if (entry.action === 'ban') {
          await unbanMember(clientRef, serverId, entry.userId);
        }
        lifted++;
      } catch (error) {
        debug('moderation', () => `expiry for case #${entry.id} failed: ${(error as Error)?.message || error}`);
      }
      // Closed either way: a failed lift must not be retried every 30 seconds
      // forever, since the punishment has already expired on paper.
      updateCase(entry, { active: false });
      await sendServerLog(
        clientRef,
        {
          title: `Case #${entry.id} expired`,
          description: `<@${entry.userId}> is no longer ${entry.action === 'mute' ? 'muted' : 'banned'} (${formatDuration(entry.durationMs)} elapsed).`,
          colour: '#22c55e',
        },
        serverId,
      ).catch(() => {});
    }
  } finally {
    ticking = false;
  }
  return lifted;
}

// ---- Summaries -------------------------------------------------------------

export type ModerationSummary = {
  total: number;
  last30Days: number;
  activePunishments: number;
  byAction: Record<ModActionType, number>;
  topModerators: { moderatorId: string; name: string; count: number }[];
};

export function getModerationSummary(serverId = config.serverId || ''): ModerationSummary {
  ensureReady();
  const cases = (sql('SELECT * FROM moderation_cases WHERE server_id = ? ORDER BY id').all(serverId) as any[]).map(rowToCase);
  const cutoff = Date.now() - 30 * 86_400_000;
  const byAction = { warn: 0, mute: 0, unmute: 0, kick: 0, ban: 0, unban: 0, note: 0 } as Record<ModActionType, number>;
  const moderators = new Map<string, { name: string; count: number }>();

  for (const entry of cases) {
    byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    if (entry.moderatorId && !entry.automated) {
      const row = moderators.get(entry.moderatorId) || { name: entry.moderatorName, count: 0 };
      row.count++;
      row.name = entry.moderatorName || row.name;
      moderators.set(entry.moderatorId, row);
    }
  }

  return {
    total: cases.length,
    last30Days: cases.filter((entry) => entry.createdAt >= cutoff).length,
    activePunishments: cases.filter((entry) => entry.active).length,
    byAction,
    topModerators: Array.from(moderators.entries())
      .map(([moderatorId, row]) => ({ moderatorId, name: row.name, count: row.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5),
  };
}
