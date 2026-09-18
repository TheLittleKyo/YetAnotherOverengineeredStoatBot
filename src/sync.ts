import { config } from './config.js';
import {
  collectChannelMessages,
  replayMessage,
  resolveChannelForBackup,
  snapshotChannelMessage,
  type BackupChannelMessage,
} from './backup.js';
import { sleep } from './async-utils.js';
import { cleanId } from './id-utils.js';
import { basename } from 'node:path';
import { dataFile, readJson, registerDataFileHooks, writeJson } from './json-store.js';
import { DB_FILE_NAME, importLegacyJson, sql, transaction } from './db.js';
import { getRoleIds } from './member-utils.js';

/**
 * Channel content copy + live channel-to-channel sync.
 *
 * Two features:
 *   1. copyChannelContent() — one-shot: read every message in a source channel
 *      and replay it (with per-message Masquerade) into a target channel. Works
 *      within one server or across two servers (bot must be a member of both).
 *   2. Live sync links — persisted in data/channel-syncs.json. When a new message
 *      lands in a linked source channel, it is mirrored into the target channel
 *      in real time. Links can be one-way or two-way.
 *
 * Live links also follow edits and deletes. Every mirrored send is recorded in
 * data/channel-sync-messages.json, so when the source message is later edited
 * or deleted the mirrored copy is edited or deleted with it. That ledger is on
 * disk rather than in memory because an edit usually arrives long after the
 * original send — often after a restart.
 *
 * Each link can carry allow and deny lists (users, roles, words) that decide
 * which messages it carries — see "Allow / deny filters" below.
 *
 * Reuses the message capture + Masquerade replay pipeline from backup.ts so
 * mirrored messages keep the original author's name and avatar.
 */

type SyncMode = 'oneway' | 'twoway';

export type SyncLink = {
  id: string;
  label?: string;
  sourceChannelId: string;
  targetChannelId: string;
  mode: SyncMode;
  createdAt: string;
  // Last message id mirrored in each direction. Used to catch up on messages
  // posted while the bot was offline. `lastSourceId` tracks source→target;
  // `lastTargetId` tracks target→source (twoway only).
  lastSourceId?: string;
  lastTargetId?: string;
  // Allow / deny lists. Absent when the link mirrors everything.
  filters?: SyncFilters;
};

type SyncStore = {
  version: 1;
  links: SyncLink[];
};

export type CopySummary = {
  sourceChannelId: string;
  targetChannelId: string;
  captured: number;
  recreated: number;
  warnings: string[];
};

const SYNC_FILE = dataFile('channel-syncs.json');

// Gentle pacing between mirrored sends during a bulk copy.
const COPY_SEND_DELAY_MS = 350;

// Offline catch-up: how many messages to fetch per request, and a safety cap on
// how many missed messages to replay per direction on reconnect.
const CATCHUP_BATCH = 100;
const CATCHUP_MAX_PER_DIRECTION = 500;

// Stoat's bulk-delete endpoint accepts at most 100 message ids per request.
const BULK_DELETE_CHUNK = 100;

// How many messages a reconciliation scan walks back through by default, and
// the hard ceiling a caller can ask for.
const SCAN_DEFAULT_LIMIT = 200;
const SCAN_MAX_LIMIT = 2000;
const SCAN_FETCH_BATCH = 100;

/**
 * Counters since boot. Nothing depends on them — they exist so `sync debug`
 * can answer "is the mirror seeing events at all?" without reading the logs.
 */
const stats = {
  startedAt: new Date().toISOString(),
  mirrored: 0,
  mirrorFailed: 0,
  mirrorSkipped: 0,
  // Messages a link's allow/deny filters kept from being mirrored, plus copies
  // removed because an edit made their message fail a word filter.
  filtered: 0,
  edits: 0,
  editsIgnored: 0,
  editsFailed: 0,
  deletes: 0,
  deletesFailed: 0,
  bulkDeletes: 0,
  catchUpRuns: 0,
  catchUpReplayed: 0,
  lastMirrorAt: null as string | null,
  lastEditAt: null as string | null,
  lastDeleteAt: null as string | null,
  lastError: null as string | null,
};

export type SyncStats = typeof stats;

/** Snapshot of the since-boot counters. */
export function getSyncStats(): SyncStats {
  return { ...stats };
}

function noteError(message: string): void {
  stats.lastError = `${new Date().toISOString()} ${message}`;
  console.warn(message);
}

// ============================================================
// One-shot copy
// ============================================================

export async function copyChannelContent(
  client: any,
  sourceChannelId: string,
  targetChannelId: string,
): Promise<CopySummary> {
  const summary: CopySummary = {
    sourceChannelId,
    targetChannelId,
    captured: 0,
    recreated: 0,
    warnings: [],
  };

  if (!sourceChannelId || !targetChannelId) {
    throw new Error('Both a source and a target channel ID are required.');
  }
  if (sourceChannelId === targetChannelId) {
    throw new Error('Source and target channels must be different.');
  }

  const targetChannel = await resolveChannelForBackup(client, targetChannelId);
  if (!targetChannel) {
    throw new Error(`Target channel ${targetChannelId} was not found (is the bot a member of that server?).`);
  }

  const messages = await collectChannelMessages(client, sourceChannelId);
  summary.captured = messages.length;
  if (messages.length === 0) {
    summary.warnings.push('Source channel returned no messages to copy.');
    return summary;
  }

  const localMap = new Map<string, string>();
  for (const msg of messages) {
    try {
      const newId = await replayMessage(targetChannel, msg, localMap, client);
      if (newId) {
        localMap.set(msg.id, newId);
        summary.recreated += 1;
      }
    } catch (error) {
      summary.warnings.push(`Message ${msg.id}: ${readableError(error)}`);
    }
    await sleep(COPY_SEND_DELAY_MS);
  }

  return summary;
}

// ============================================================
// Mirror ledger (source message -> mirrored copy)
// ============================================================

/**
 * One row per mirrored message. Written on every mirrored send; read when the
 * source message is edited or deleted so the copy can be changed to match, and
 * when a mirrored reply needs to point at the copy of the message it answers.
 */
type MirrorEntry = {
  linkId: string;
  sourceChannelId: string;
  sourceId: string;
  targetChannelId: string;
  targetId: string;
  at: string;
};

// The pre-SQLite ledger file, imported on first use.
const LEGACY_MIRROR_FILE = 'channel-sync-messages.json';

// Oldest rows are dropped past this cap. Well beyond any realistic edit window,
// and small enough that the whole ledger is cheap to hold in memory.
const MIRROR_MAX_ENTRIES = 5000;

/**
 * The ledger lives in SQLite (`sync_mirrors`, see db.ts): each copy is one row,
 * inserted or deleted as it happens, so nothing is lost between saves and no
 * save rewrites the whole ledger. It is also held in memory (at most
 * MIRROR_MAX_ENTRIES rows), in write order, with two indexes: source message
 * id -> its copies, and copy id -> its row. Every edit and delete in a linked
 * channel consults those.
 */
let mirrorEntries: MirrorEntry[] | null = null;
const mirrorsBySourceId = new Map<string, MirrorEntry[]>();
const mirrorsByTargetId = new Map<string, MirrorEntry>();

function loadMirrors(): MirrorEntry[] {
  if (mirrorEntries) return mirrorEntries;
  importLegacyJson(LEGACY_MIRROR_FILE, (data) => {
    const entries = Array.isArray(data?.entries) ? data.entries.filter(isValidMirrorEntry) : [];
    for (const entry of entries.slice(-MIRROR_MAX_ENTRIES)) insertMirrorRow(entry);
  });
  mirrorEntries = (sql('SELECT * FROM sync_mirrors ORDER BY seq').all() as any[]).map((row) => ({
    linkId: row.link_id,
    sourceChannelId: row.source_channel_id,
    sourceId: row.source_id,
    targetChannelId: row.target_channel_id,
    targetId: row.target_id,
    at: row.at,
  }));
  reindexMirrors();
  return mirrorEntries;
}

function isValidMirrorEntry(entry: any): entry is MirrorEntry {
  return (
    entry &&
    typeof entry.linkId === 'string' &&
    typeof entry.sourceId === 'string' &&
    typeof entry.targetId === 'string' &&
    typeof entry.targetChannelId === 'string'
  );
}

function insertMirrorRow(entry: MirrorEntry): void {
  sql(
    `INSERT OR REPLACE INTO sync_mirrors (target_id, link_id, source_channel_id, source_id, target_channel_id, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entry.targetId, entry.linkId, String(entry.sourceChannelId || ''), entry.sourceId, entry.targetChannelId, String(entry.at || ''));
}

function indexMirror(entry: MirrorEntry): void {
  const list = mirrorsBySourceId.get(entry.sourceId);
  if (list) list.push(entry);
  else mirrorsBySourceId.set(entry.sourceId, [entry]);
  mirrorsByTargetId.set(entry.targetId, entry);
}

function reindexMirrors(): void {
  mirrorsBySourceId.clear();
  mirrorsByTargetId.clear();
  for (const entry of mirrorEntries || []) indexMirror(entry);
}

function recordMirror(link: SyncLink, sourceChannelId: string, sourceId: string, targetChannelId: string, targetId: string): void {
  if (!sourceId || !targetId) return;
  // A copy id is unique; a re-recorded one replaces its old row.
  if (isMirroredCopy(targetId)) forgetMirrors((row) => row.targetId === targetId);
  const entries = loadMirrors();
  const entry: MirrorEntry = {
    linkId: link.id,
    sourceChannelId,
    sourceId,
    targetChannelId,
    targetId,
    at: new Date().toISOString(),
  };

  insertMirrorRow(entry);
  entries.push(entry);

  if (entries.length > MIRROR_MAX_ENTRIES) {
    entries.splice(0, entries.length - MIRROR_MAX_ENTRIES);
    sql(
      `DELETE FROM sync_mirrors WHERE seq <= (SELECT seq FROM sync_mirrors ORDER BY seq DESC LIMIT 1 OFFSET ${MIRROR_MAX_ENTRIES})`,
    ).run();
    reindexMirrors();
  } else {
    indexMirror(entry);
  }
}

/** Every copy made of a source message, across all links it travels. */
function mirrorsForSource(sourceId: string): MirrorEntry[] {
  loadMirrors();
  return mirrorsBySourceId.get(sourceId) || [];
}

/** The copy of `sourceId` made by one specific link, if there is one. */
function mirrorTargetFor(linkId: string, sourceId: string): string | null {
  const hit = mirrorsForSource(sourceId).find((entry) => entry.linkId === linkId);
  return hit ? hit.targetId : null;
}

/**
 * True when this message id is itself a mirrored copy. Copies are sent by the
 * bot, so editing or deleting one emits another event — ignoring known copies
 * is what stops twoway links from echoing edits and deletes back and forth.
 */
function isMirroredCopy(messageId: string): boolean {
  loadMirrors();
  return mirrorsByTargetId.has(messageId);
}

function forgetMirrors(predicate: (entry: MirrorEntry) => boolean): number {
  const entries = loadMirrors();
  const removed = entries.filter((entry) => predicate(entry));
  if (removed.length === 0) return 0;
  transaction(() => {
    const drop = sql('DELETE FROM sync_mirrors WHERE target_id = ?');
    for (const entry of removed) drop.run(entry.targetId);
  });
  const gone = new Set(removed);
  mirrorEntries = entries.filter((entry) => !gone.has(entry));
  reindexMirrors();
  return removed.length;
}

/**
 * Reply-target map for replayMessage: maps the ids this message replies to onto
 * the copies of those messages in the destination channel. Built from the
 * ledger, so reply chains survive a restart.
 */
function replyMapForLink(link: SyncLink, snapshot: BackupChannelMessage): Map<string, string> {
  const map = new Map<string, string>();
  for (const reply of snapshot.replies || []) {
    const targetId = mirrorTargetFor(link.id, reply.id);
    if (targetId) {
      map.set(reply.id, targetId);
      continue;
    }

    // On a twoway link the message being replied to may itself be a copy; the
    // reply then belongs on the message that copy was made from.
    const origin = mirrorsByTargetId.get(reply.id);
    if (origin && origin.linkId === link.id) map.set(reply.id, origin.sourceId);
  }
  return map;
}

// ============================================================
// Allow / deny filters (per link)
// ============================================================

/**
 * Per-link allow and deny lists decide which messages a link carries:
 *
 *   - Deny wins. A message from a denied user, from a member holding a denied
 *     role, or containing a denied word is never mirrored.
 *   - Allowed users and allowed roles form one sender allowlist: when either is
 *     set, only those users — or members holding one of those roles — are
 *     mirrored.
 *   - Allowed words are a content allowlist: when set, a message must contain
 *     at least one of them.
 *
 * Empty lists do nothing, so a link without filters mirrors everything. The
 * same filters apply in both directions of a twoway link. Role ids belong to
 * one server, so a role entry only ever matches members of that server.
 *
 * Words match case-insensitively on whole words (a phrase is fine), and `*`
 * matches any run of letters or digits: `spam*` catches "spammer".
 */
export type SyncFilterKind = 'users' | 'roles' | 'words';
export type SyncFilterList = Record<SyncFilterKind, string[]>;
export type SyncFilters = { allow: SyncFilterList; deny: SyncFilterList };
/** `reason` is set whenever `allowed` is false. */
export type SyncFilterVerdict = { allowed: boolean; reason?: string };

export const SYNC_FILTER_KINDS: SyncFilterKind[] = ['users', 'roles', 'words'];
export const SYNC_FILTER_MAX_ENTRIES = 100;
const FILTER_WORD_MAX_LENGTH = 100;

export function emptySyncFilters(): SyncFilters {
  return { allow: { users: [], roles: [], words: [] }, deny: { users: [], roles: [], words: [] } };
}

/**
 * Clean filters from any source (dashboard body, chat input, hand-edited JSON):
 * ids are reduced to bare ids, words are trimmed, duplicates dropped, and each
 * list capped. A list may be an array or a comma/newline separated string.
 */
export function normalizeSyncFilters(input: any): SyncFilters {
  const filters = emptySyncFilters();
  for (const side of ['allow', 'deny'] as const) {
    for (const kind of SYNC_FILTER_KINDS) {
      filters[side][kind] = normalizeFilterEntries(kind, input?.[side]?.[kind]);
    }
  }
  return filters;
}

export function normalizeFilterEntries(kind: SyncFilterKind, value: any): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(kind === 'words' ? /[\n,]/ : /[\s,]+/)
      : [];

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const item of raw) {
    if (entries.length >= SYNC_FILTER_MAX_ENTRIES) break;
    const entry = kind === 'words' ? cleanFilterWord(item) : cleanId(item);
    if (!entry) continue;
    const key = kind === 'words' ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return entries;
}

function cleanFilterWord(value: any): string {
  const word = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, FILTER_WORD_MAX_LENGTH);
  // A bare wildcard would match every message.
  return word.replace(/\*/g, '').trim() ? word : '';
}

export function hasSyncFilters(filters: SyncFilters | undefined | null): boolean {
  if (!filters) return false;
  return (['allow', 'deny'] as const).some((side) =>
    SYNC_FILTER_KINDS.some((kind) => (filters[side]?.[kind]?.length || 0) > 0),
  );
}

/**
 * Decide whether one message passes a link's filters. `roleIds` only needs to
 * be filled in when the filters list roles.
 */
export function evaluateSyncFilters(
  filters: SyncFilters | undefined | null,
  subject: { authorId?: string; roleIds?: string[]; content?: string },
): SyncFilterVerdict {
  if (!hasSyncFilters(filters)) return { allowed: true };
  const sender = senderVerdict(filters!, subject.authorId, subject.roleIds || []);
  if (!sender.allowed) return sender;
  return contentVerdict(filters!, subject.content || '');
}

function senderVerdict(filters: SyncFilters, authorId: string | undefined, roleIds: string[]): SyncFilterVerdict {
  const id = authorId ? String(authorId) : '';
  if (id && filters.deny.users.includes(id)) return { allowed: false, reason: 'author is on the deny list' };

  const deniedRole = roleIds.find((role) => filters.deny.roles.includes(role));
  if (deniedRole) return { allowed: false, reason: `author has denied role ${deniedRole}` };

  const allowUsers = filters.allow.users;
  const allowRoles = filters.allow.roles;
  if (allowUsers.length === 0 && allowRoles.length === 0) return { allowed: true };
  if (id && allowUsers.includes(id)) return { allowed: true };
  if (roleIds.some((role) => allowRoles.includes(role))) return { allowed: true };
  return { allowed: false, reason: 'author is not on the allow list' };
}

/** Word checks only — used for edits, where the author is already known to pass. */
function contentVerdict(filters: SyncFilters, content: string): SyncFilterVerdict {
  const deniedWord = filters.deny.words.find((word) => wordPattern(word).test(content));
  if (deniedWord) return { allowed: false, reason: `contains denied word "${deniedWord}"` };

  if (filters.allow.words.length === 0) return { allowed: true };
  if (filters.allow.words.some((word) => wordPattern(word).test(content))) return { allowed: true };
  return { allowed: false, reason: 'contains none of the allowed words' };
}

const WORD_CHAR = '[\\p{L}\\p{N}_]';
const WORD_CHAR_TEST = /[\p{L}\p{N}_*]/u;
const wordPatterns = new Map<string, RegExp>();

/**
 * Whole-word, case-insensitive pattern for a filter entry. The word boundary is
 * only enforced on a side that starts or ends with a letter or digit, so an
 * entry like `:)` or `c++` still matches where it appears.
 */
function wordPattern(word: string): RegExp {
  const key = word.toLowerCase();
  const cached = wordPatterns.get(key);
  if (cached) return cached;

  const body = key.split('*').map(escapeRegExp).join(`${WORD_CHAR}*`);
  const head = WORD_CHAR_TEST.test(key[0]) ? `(?<!${WORD_CHAR})` : '';
  const tail = WORD_CHAR_TEST.test(key[key.length - 1]) ? `(?!${WORD_CHAR})` : '';
  const pattern = new RegExp(`${head}${body}${tail}`, 'iu');

  // Entries are capped per link, but links come and go; keep the cache bounded.
  if (wordPatterns.size > 2000) wordPatterns.clear();
  wordPatterns.set(key, pattern);
  return pattern;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Filter check for a real message. Member roles cost a lookup, so they are only
 * resolved when the filters list roles; `roleCache` lets a scan or catch-up
 * over many messages look each author up once.
 */
async function checkLinkFilters(
  client: any,
  link: SyncLink,
  msg: any,
  channelId: string,
  roleCache?: Map<string, string[]>,
): Promise<SyncFilterVerdict> {
  const filters = link.filters;
  if (!hasSyncFilters(filters)) return { allowed: true };

  const authorId = authorIdOf(msg);
  let roleIds: string[] = [];
  if (authorId && (filters!.allow.roles.length > 0 || filters!.deny.roles.length > 0)) {
    const key = `${channelId}:${authorId}`;
    const cached = roleCache?.get(key);
    roleIds = cached || await resolveAuthorRoleIds(client, msg, authorId, channelId);
    roleCache?.set(key, roleIds);
  }

  return evaluateSyncFilters(filters, {
    authorId,
    roleIds,
    content: typeof msg?.content === 'string' ? msg.content : '',
  });
}

async function resolveAuthorRoleIds(client: any, msg: any, authorId: string, channelId: string): Promise<string[]> {
  try {
    const member = msg?.member;
    if (member?.roles) return getRoleIds(member.roles);
  } catch {
    // stoatbot's member getter can throw for a message whose server is not cached.
  }

  try {
    const channel = await resolveChannelForBackup(client, channelId);
    const serverId = channel?.serverId || channel?.server?.id;
    if (!serverId) return [];
    const server = client?.servers?.cache?.get?.(serverId) || await client?.servers?.fetch?.(serverId);
    const member = server?.members?.cache?.get?.(authorId) || await server?.members?.fetch?.(authorId);
    return getRoleIds(member?.roles);
  } catch {
    // Author left the server, or the member could not be fetched: no roles.
    return [];
  }
}

function authorIdOf(msg: any): string | undefined {
  const id = msg?.authorId || msg?.author?.id || msg?.author;
  return typeof id === 'string' && id ? id : undefined;
}

/** Replace a link's filters. Empty filters are removed from the link entirely. */
export function setSyncLinkFilters(id: string, filters: any): SyncLink | null {
  const store = readStore();
  const link = store.links.find((item) => item.id === id);
  if (!link) return null;
  applyFilters(link, filters);
  writeStore(store);
  return link;
}

function applyFilters(link: SyncLink, filters: any): void {
  const clean = normalizeSyncFilters(filters);
  if (hasSyncFilters(clean)) link.filters = clean;
  else delete link.filters;
}

// ============================================================
// Live sync links (persisted)
// ============================================================

export function listSyncLinks(): SyncLink[] {
  return readStore().links;
}

export function findLinksForSource(channelId: string): SyncLink[] {
  return readStore().links.filter(
    (link) =>
      link.sourceChannelId === channelId ||
      (link.mode === 'twoway' && link.targetChannelId === channelId),
  );
}

export function addSyncLink(sourceChannelId: string, targetChannelId: string, mode: SyncMode = 'oneway', label?: string): SyncLink {
  if (!sourceChannelId || !targetChannelId) {
    throw new Error('Both a source and a target channel ID are required.');
  }
  if (sourceChannelId === targetChannelId) {
    throw new Error('Source and target channels must be different.');
  }

  const cleanLabel = normalizeLinkLabel(label);
  const store = readStore();
  const exists = store.links.find(
    (link) => link.sourceChannelId === sourceChannelId && link.targetChannelId === targetChannelId,
  );
  if (exists) {
    // Update mode (and label, if given) instead of duplicating.
    exists.mode = mode;
    if (cleanLabel !== undefined) exists.label = cleanLabel || undefined;
    writeStore(store);
    return exists;
  }

  const link: SyncLink = {
    id: randomId(),
    label: cleanLabel || undefined,
    sourceChannelId,
    targetChannelId,
    mode,
    createdAt: new Date().toISOString(),
  };
  store.links.push(link);
  writeStore(store);
  return link;
}

/** Rename a live link so it is recognizable in the dashboard. */
export function setSyncLinkLabel(id: string, label: string): SyncLink | null {
  const store = readStore();
  const link = store.links.find((item) => item.id === id);
  if (!link) return null;
  link.label = normalizeLinkLabel(label) || undefined;
  writeStore(store);
  return link;
}

/** Edit a live link's name, channels, direction, and filters from the dashboard. */
export function updateSyncLink(
  id: string,
  updates: { label?: string; sourceChannelId?: string; targetChannelId?: string; mode?: SyncMode; filters?: any },
): SyncLink | null {
  const store = readStore();
  const link = store.links.find((item) => item.id === id);
  if (!link) return null;

  const source = updates.sourceChannelId !== undefined ? String(updates.sourceChannelId).trim() : link.sourceChannelId;
  const target = updates.targetChannelId !== undefined ? String(updates.targetChannelId).trim() : link.targetChannelId;
  if (!source || !target) throw new Error('Both a source and a target channel ID are required.');
  if (source === target) throw new Error('Source and target channels must be different.');

  if (store.links.some((item) => item.id !== id && item.sourceChannelId === source && item.targetChannelId === target)) {
    throw new Error('Another link already connects those channels.');
  }

  link.sourceChannelId = source;
  link.targetChannelId = target;
  if (updates.mode === 'oneway' || updates.mode === 'twoway') link.mode = updates.mode;
  if (updates.label !== undefined) link.label = normalizeLinkLabel(updates.label) || undefined;
  if (updates.filters !== undefined) applyFilters(link, updates.filters);
  writeStore(store);
  return link;
}

function normalizeLinkLabel(label: any): string | undefined {
  if (label === undefined || label === null) return undefined;
  return String(label).trim().replace(/\s+/g, ' ').slice(0, 60);
}

export function removeSyncLink(idOrChannelId: string): number {
  const store = readStore();
  const before = store.links.length;
  store.links = store.links.filter(
    (link) =>
      link.id !== idOrChannelId &&
      link.sourceChannelId !== idOrChannelId &&
      link.targetChannelId !== idOrChannelId,
  );
  const removed = before - store.links.length;
  if (removed > 0) {
    writeStore(store);
    // Drop the ledger rows for links that no longer exist, so the file does not
    // keep growing with copies nothing will ever edit or delete again.
    const liveIds = new Set(store.links.map((link) => link.id));
    forgetMirrors((entry) => !liveIds.has(entry.linkId));
  }
  return removed;
}

/** True when either side of any link touches this channel. */
function channelIsLinked(channelId: string): boolean {
  return !!channelId && linkedChannels().has(channelId);
}

/**
 * Mirror a freshly-received message into every channel linked to its channel.
 * Call this from the client 'message' event handler.
 *
 * Loop-safety: mirrored messages are sent by the bot (via Masquerade), so
 * skipping the bot's own messages prevents twoway links from echoing forever.
 */
export async function mirrorMessageToLinks(client: any, message: any): Promise<void> {
  const botId = client?.user?.id;
  const authorId = message?.authorId || message?.author?.id || message?.author;

  // Never mirror the bot's own (already-mirrored) messages — stops echo loops.
  if (botId && authorId && String(authorId) === String(botId)) return;

  // Don't mirror bot commands.
  if (typeof message?.content === 'string' && message.content.startsWith(config.prefix)) return;

  const sourceChannelId = message?.channelId || message?.channel?.id;
  if (!sourceChannelId || !channelIsLinked(sourceChannelId)) return;

  // Work against the persisted store so we can advance the per-link cursor and
  // save it — that cursor is what offline catch-up resumes from.
  const store = readStore();
  const links = store.links.filter(
    (link) =>
      link.sourceChannelId === sourceChannelId ||
      (link.mode === 'twoway' && link.targetChannelId === sourceChannelId),
  );
  if (links.length === 0) return;

  // Snapshotting resolves the author's avatar, so skip it when every link's
  // filters turn the message away.
  let snapshot: BackupChannelMessage | null | undefined;

  const messageId = String(message?.id || '');
  for (const link of links) {
    const fromSource = link.sourceChannelId === sourceChannelId;
    const destChannelId = fromSource ? link.targetChannelId : link.sourceChannelId;
    const verdict = await checkLinkFilters(client, link, message, sourceChannelId);
    if (!verdict.allowed) {
      stats.filtered += 1;
    } else {
      if (snapshot === undefined) snapshot = await snapshotChannelMessage(client, message);
      if (!snapshot) return;

      try {
        const destChannel = await resolveChannelForBackup(client, destChannelId);
        if (!destChannel) continue;

        const map = replyMapForLink(link, snapshot);
        const newId = await replayMessage(destChannel, snapshot, map, client);
        if (newId) {
          recordMirror(link, sourceChannelId, snapshot.id, destChannelId, newId);
          stats.mirrored += 1;
          stats.lastMirrorAt = new Date().toISOString();
        } else {
          // replayMessage returns null for messages Stoat will not accept (empty
          // content, bare system events).
          stats.mirrorSkipped += 1;
        }
      } catch (error) {
        stats.mirrorFailed += 1;
        noteError(`[sync] Failed to mirror message ${snapshot.id} to ${destChannelId}: ${readableError(error)}`);
      }
    }

    // Advance the cursor for the direction this message travelled — filtered or
    // not — so a later restart doesn't replay or re-check it.
    if (messageId) {
      if (fromSource) link.lastSourceId = maxId(link.lastSourceId, messageId);
      else link.lastTargetId = maxId(link.lastTargetId, messageId);
    }
  }

  writeStore(store, true);
}

/**
 * Apply an edit of a source message to every mirrored copy of it.
 *
 * `data` is the partial message payload from the MessageUpdate packet, so it
 * carries only what changed. An update with no `content` (an embed appearing
 * once a link preview resolves, for example) is ignored rather than blanking
 * the copy out.
 *
 * Stoat's edit endpoint takes content only — an edited message keeps whatever
 * attachments the copy was originally sent with.
 */
export async function mirrorMessageEdit(client: any, channelId: string, messageId: string, data: any): Promise<void> {
  const id = String(messageId || '');
  if (!id || !channelIsLinked(String(channelId || ''))) return;

  // Editing a copy is the bot's own doing — never bounce it back to the source.
  if (isMirroredCopy(id)) return;

  const entries = mirrorsForSource(id);
  if (entries.length === 0) return;

  const content = typeof data?.content === 'string' ? data.content : null;
  if (content === null || !content.trim()) {
    stats.editsIgnored += 1;
    return;
  }

  const links = new Map(readStore().links.map((link) => [link.id, link]));
  const withdrawn: string[] = [];

  for (const entry of [...entries]) {
    try {
      const channel = await resolveChannelForBackup(client, entry.targetChannelId);
      if (!channel) continue;

      // The author already passed when the copy was made, but the new text may
      // now hit a word filter. Take the copy down rather than carry that text.
      const filters = links.get(entry.linkId)?.filters;
      if (hasSyncFilters(filters) && !contentVerdict(filters!, content).allowed) {
        if (typeof channel.messages?.delete !== 'function') continue;
        await channel.messages.delete(entry.targetId);
        withdrawn.push(entry.targetId);
        stats.filtered += 1;
        stats.deletes += 1;
        stats.lastDeleteAt = new Date().toISOString();
        continue;
      }

      if (typeof channel.messages?.edit !== 'function') continue;
      await channel.messages.edit(entry.targetId, { content });
      stats.edits += 1;
      stats.lastEditAt = new Date().toISOString();
    } catch (error) {
      stats.editsFailed += 1;
      noteError(`[sync] Failed to mirror edit of ${id} to ${entry.targetId}: ${readableError(error)}`);
    }
  }

  if (withdrawn.length > 0) {
    const gone = new Set(withdrawn);
    forgetMirrors((entry) => gone.has(entry.targetId));
  }
}

/** Delete every mirrored copy of a source message that was just deleted. */
export async function mirrorMessageDelete(client: any, channelId: string, messageId: string): Promise<void> {
  const id = String(messageId || '');
  if (!id || !channelIsLinked(String(channelId || ''))) return;

  // A copy deleted directly in the target channel is not a source delete. Drop
  // its ledger row so a later edit doesn't chase a message that is already gone.
  if (isMirroredCopy(id)) {
    forgetMirrors((entry) => entry.targetId === id);
    return;
  }

  const entries = mirrorsForSource(id);
  if (entries.length === 0) return;

  for (const entry of entries) {
    try {
      const channel = await resolveChannelForBackup(client, entry.targetChannelId);
      if (!channel || typeof channel.messages?.delete !== 'function') continue;
      await channel.messages.delete(entry.targetId);
      stats.deletes += 1;
      stats.lastDeleteAt = new Date().toISOString();
    } catch (error) {
      stats.deletesFailed += 1;
      noteError(`[sync] Failed to mirror delete of ${id} to ${entry.targetId}: ${readableError(error)}`);
    }
  }

  forgetMirrors((entry) => entry.sourceId === id);
}

/**
 * Mirror a bulk delete (a purge, or a moderator clearing a range). Copies are
 * grouped per destination channel and removed with one bulk request each,
 * rather than one API call per message.
 */
export async function mirrorBulkMessageDelete(client: any, channelId: string, ids: string[]): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0) return;
  if (!channelIsLinked(String(channelId || ''))) return;

  const byChannel = new Map<string, string[]>();
  const deletedSourceIds: string[] = [];

  for (const raw of ids) {
    const id = String(raw || '');
    if (!id) continue;

    if (isMirroredCopy(id)) {
      forgetMirrors((entry) => entry.targetId === id);
      continue;
    }

    const entries = mirrorsForSource(id);
    if (entries.length === 0) continue;
    deletedSourceIds.push(id);

    for (const entry of entries) {
      const list = byChannel.get(entry.targetChannelId);
      if (list) list.push(entry.targetId);
      else byChannel.set(entry.targetChannelId, [entry.targetId]);
    }
  }

  for (const [targetChannelId, targetIds] of byChannel) {
    try {
      const channel = await resolveChannelForBackup(client, targetChannelId);
      if (!channel) continue;

      for (let i = 0; i < targetIds.length; i += BULK_DELETE_CHUNK) {
        const chunk = targetIds.slice(i, i + BULK_DELETE_CHUNK);
        if (chunk.length === 1 && typeof channel.messages?.delete === 'function') {
          await channel.messages.delete(chunk[0]);
        } else if (typeof channel.messages?.bulkDelete === 'function') {
          await channel.messages.bulkDelete(chunk);
        }
        stats.deletes += chunk.length;
        stats.bulkDeletes += 1;
        stats.lastDeleteAt = new Date().toISOString();
      }
    } catch (error) {
      stats.deletesFailed += 1;
      noteError(`[sync] Failed to mirror bulk delete into ${targetChannelId}: ${readableError(error)}`);
    }
  }

  if (deletedSourceIds.length > 0) {
    const gone = new Set(deletedSourceIds);
    forgetMirrors((entry) => gone.has(entry.sourceId));
  }
}

/**
 * Replay messages that were posted in linked channels while the bot was offline.
 * Called on 'ready' (fires on connect and every reconnect). For each link it
 * fetches messages after the last-mirrored id and mirrors them, in order.
 * The first time a link is seen it just records the current tip — it never
 * dumps a channel's whole history.
 *
 * Only new messages are caught up. Edits and deletes that happened while the
 * bot was offline leave no trace to fetch, so mirrored copies of messages
 * changed during downtime stay as they were.
 */
export async function catchUpSyncLinks(client: any): Promise<{ links: number; replayed: number }> {
  const store = readStore();
  stats.catchUpRuns += 1;
  if (store.links.length === 0) return { links: 0, replayed: 0 };

  let replayed = 0;
  let changed = false;
  for (const link of store.links) {
    try {
      const s = await catchUpDirection(client, link, 'source');
      replayed += s.replayed;
      changed = changed || s.changed;
      if (link.mode === 'twoway') {
        const t = await catchUpDirection(client, link, 'target');
        replayed += t.replayed;
        changed = changed || t.changed;
      }
    } catch (error) {
      console.warn(`[sync] Catch-up failed for link ${link.id}: ${readableError(error)}`);
    }
  }

  if (changed) writeStore(store);
  stats.catchUpReplayed += replayed;
  return { links: store.links.length, replayed };
}

async function catchUpDirection(client: any, link: SyncLink, dir: 'source' | 'target'): Promise<{ replayed: number; changed: boolean }> {
  const srcId = dir === 'source' ? link.sourceChannelId : link.targetChannelId;
  const dstId = dir === 'source' ? link.targetChannelId : link.sourceChannelId;
  const key = dir === 'source' ? 'lastSourceId' : 'lastTargetId';

  const srcChannel = await resolveChannelForBackup(client, srcId);
  if (!srcChannel || typeof srcChannel.messages?.fetch !== 'function') return { replayed: 0, changed: false };

  // First sight of this link/direction: record the tip, replay nothing.
  if (!link[key]) {
    const tip = await fetchLatestMessageId(srcChannel);
    if (tip) { link[key] = tip; return { replayed: 0, changed: true }; }
    return { replayed: 0, changed: false };
  }

  const destChannel = await resolveChannelForBackup(client, dstId);
  if (!destChannel) return { replayed: 0, changed: false };

  const botId = client?.user?.id;
  const roleCache = new Map<string, string[]>();
  let cursor = String(link[key]);
  let processed = 0;
  let replayed = 0;
  let changed = false;

  while (processed < CATCHUP_MAX_PER_DIRECTION) {
    let batch: any;
    try {
      batch = await srcChannel.messages.fetch({ after: cursor, sort: 'Oldest', limit: CATCHUP_BATCH });
    } catch (error) {
      console.warn(`[sync] Catch-up fetch failed on ${srcId}: ${readableError(error)}`);
      break;
    }
    const messages = batch instanceof Map ? Array.from(batch.values()) : (Array.isArray(batch) ? batch : []);
    if (messages.length === 0) break;
    messages.sort((a: any, b: any) => String(a?.id || '').localeCompare(String(b?.id || '')));

    for (const msg of messages) {
      const authorId = msg?.authorId || msg?.author?.id || msg?.author;
      const isBot = botId && authorId && String(authorId) === String(botId);
      const isCommand = typeof msg?.content === 'string' && msg.content.startsWith(config.prefix);
      const passes = !isBot && !isCommand && (await checkLinkFilters(client, link, msg, srcId, roleCache)).allowed;
      if (!isBot && !isCommand && !passes) stats.filtered += 1;
      if (passes) {
        const snapshot = await snapshotChannelMessage(client, msg);
        if (snapshot) {
          try {
            const map = replyMapForLink(link, snapshot);
            const newId = await replayMessage(destChannel, snapshot, map, client);
            if (newId) { recordMirror(link, srcId, snapshot.id, dstId, newId); replayed += 1; }
          } catch (error) {
            console.warn(`[sync] Catch-up replay failed for ${msg?.id}: ${readableError(error)}`);
          }
          await sleep(COPY_SEND_DELAY_MS);
        }
      }
      cursor = String(msg.id);
      processed += 1;
    }

    link[key] = cursor;
    changed = true;
    if (messages.length < CATCHUP_BATCH) break;
  }

  return { replayed, changed };
}

async function fetchLatestMessageId(channel: any): Promise<string | null> {
  try {
    const result = await channel.messages.fetch({ limit: 1, sort: 'Latest' });
    const arr = result instanceof Map ? Array.from(result.values()) : (Array.isArray(result) ? result : []);
    return arr.length ? String((arr[0] as any).id) : null;
  } catch {
    return null;
  }
}

// ============================================================
// Diagnostics + reconciliation
// ============================================================

/** What a reconciliation scan can find wrong with one message. */
export type SyncScanIssue =
  /** In the source channel, but never mirrored (or its ledger row aged out). */
  | 'missing'
  /** Copy exists, but its content no longer matches the source message. */
  | 'stale'
  /** Ledger points at a copy that is no longer in the destination channel. */
  | 'copy-missing'
  /** Copy is still there, but the message it was copied from is gone. */
  | 'orphan'
  /** Copy is still there, but the link's filters now block its message. */
  | 'filtered'
  /**
   * A matching copy is already in the destination, but the ledger has no row
   * for it (history brought over by `sync copy`, or a row that aged out).
   * Repairing only records the row — nothing is posted.
   */
  | 'untracked';

export type SyncScanFinding = {
  issue: SyncScanIssue;
  direction: 'source' | 'target';
  sourceChannelId: string;
  targetChannelId: string;
  sourceId?: string;
  targetId?: string;
  authorName?: string;
  preview?: string;
  /** Why the filters block the message (`filtered` findings only). */
  reason?: string;
  repaired?: boolean;
  error?: string;
};

export type SyncScanReport = {
  linkId: string;
  label?: string;
  mode: SyncMode;
  apply: boolean;
  limit: number;
  scanned: number;
  /** Messages the filters block that were never mirrored — correct, not drift. */
  skippedByFilters: number;
  /** Messages posted before the link existed and never copied — not drift. */
  skippedBeforeLink: number;
  ledgerRows: number;
  findings: SyncScanFinding[];
  repaired: number;
  warnings: string[];
};

export type SyncMirrorRow = MirrorEntry;

/** One link by id, or null. */
export function getSyncLink(id: string): SyncLink | null {
  return readStore().links.find((link) => link.id === id) || null;
}

/** Links matching a link id, or every link touching a channel id. */
export function resolveSyncLinks(idOrChannelId: string): SyncLink[] {
  const needle = String(idOrChannelId || '').trim();
  if (!needle) return [];
  return readStore().links.filter(
    (link) =>
      link.id === needle || link.sourceChannelId === needle || link.targetChannelId === needle,
  );
}

/** Ledger rows, newest first — optionally only those belonging to one link. */
export function listMirrorRows(options: { linkId?: string; limit?: number } = {}): SyncMirrorRow[] {
  const rows = loadMirrors().filter((row) => !options.linkId || row.linkId === options.linkId);
  const limit = Math.max(1, Math.min(options.limit || 20, 200));
  return rows.slice(-limit).reverse();
}

/** Store-level counts, for `sync debug status`. */
export function getSyncDiagnostics(): {
  stats: SyncStats;
  links: Array<SyncLink & { ledgerRows: number }>;
  ledger: {
    file: string;
    rows: number;
    cap: number;
    distinctSources: number;
    oldestAt?: string;
    newestAt?: string;
    orphanedRows: number;
  };
  linkFile: string;
} {
  const links = readStore().links;
  const rows = loadMirrors();
  const liveIds = new Set(links.map((link) => link.id));

  return {
    stats: getSyncStats(),
    links: links.map((link) => ({
      ...link,
      ledgerRows: rows.filter((row) => row.linkId === link.id).length,
    })),
    ledger: {
      file: `${DB_FILE_NAME} (sync_mirrors)`,
      rows: rows.length,
      cap: MIRROR_MAX_ENTRIES,
      distinctSources: mirrorsBySourceId.size,
      oldestAt: rows.length ? rows[0].at : undefined,
      newestAt: rows.length ? rows[rows.length - 1].at : undefined,
      // Rows whose link was deleted without the ledger being cleaned up.
      orphanedRows: rows.filter((row) => !liveIds.has(row.linkId)).length,
    },
    linkFile: SYNC_FILE,
  };
}

/**
 * Per link: how many copies the ledger still tracks, and when the newest one
 * was made. Feeds the "last copy" line on the dashboard's sync page.
 */
export function getSyncLinkActivity(): Record<string, { copies: number; lastAt?: string }> {
  const out: Record<string, { copies: number; lastAt?: string }> = {};
  for (const row of loadMirrors()) {
    const entry = (out[row.linkId] ||= { copies: 0 });
    entry.copies += 1;
    if (!entry.lastAt || row.at > entry.lastAt) entry.lastAt = row.at;
  }
  return out;
}

/**
 * Follow one message id through the ledger: the copies made of it, and — when
 * a client is given — whether each of those messages still exists.
 */
export async function traceSyncMessage(client: any, messageId: string): Promise<{
  messageId: string;
  asSource: Array<SyncMirrorRow & { targetExists?: boolean; targetContent?: string }>;
  asCopy: Array<SyncMirrorRow & { sourceExists?: boolean; sourceContent?: string }>;
}> {
  const id = String(messageId || '').trim();
  loadMirrors();

  const asSource = [...(mirrorsBySourceId.get(id) || [])];
  const copyRow = mirrorsByTargetId.get(id);
  const asCopy = copyRow ? [copyRow] : [];

  const traced = {
    messageId: id,
    asSource: [] as Array<SyncMirrorRow & { targetExists?: boolean; targetContent?: string }>,
    asCopy: [] as Array<SyncMirrorRow & { sourceExists?: boolean; sourceContent?: string }>,
  };

  for (const row of asSource) {
    const copy = client ? await fetchMessageById(client, row.targetChannelId, row.targetId) : null;
    traced.asSource.push({
      ...row,
      targetExists: client ? !!copy : undefined,
      targetContent: copy?.content ? String(copy.content) : undefined,
    });
  }

  for (const row of asCopy) {
    const source = client ? await fetchMessageById(client, row.sourceChannelId, row.sourceId) : null;
    traced.asCopy.push({
      ...row,
      sourceExists: client ? !!source : undefined,
      sourceContent: source?.content ? String(source.content) : undefined,
    });
  }

  return traced;
}

/**
 * Walk back through a linked channel and compare every message against its
 * mirrored copy, reporting what drifted: never-mirrored messages, copies whose
 * content is stale, copies that were deleted in the destination, and copies
 * whose source message no longer exists.
 *
 * This is the only thing that catches edits and deletes made while the bot was
 * offline — those leave no event to replay, so they can only be found by
 * comparing the two channels after the fact.
 *
 * Messages are judged against the link's current filters: one the filters block
 * is not "missing", and a copy of one is reported as `filtered`.
 *
 * With `apply`, each finding is repaired: mirror the missing message, edit the
 * stale copy, delete the orphaned or filtered copy, drop the dead ledger row.
 */
export async function scanSyncLink(
  client: any,
  linkId: string,
  options: { limit?: number; apply?: boolean; direction?: 'source' | 'target' | 'both' } = {},
): Promise<SyncScanReport> {
  const link = getSyncLink(linkId);
  if (!link) throw new Error(`No sync link with id \`${linkId}\`.`);

  const limit = Math.max(1, Math.min(options.limit || SCAN_DEFAULT_LIMIT, SCAN_MAX_LIMIT));
  const apply = !!options.apply;
  const report: SyncScanReport = {
    linkId: link.id,
    label: link.label,
    mode: link.mode,
    apply,
    limit,
    scanned: 0,
    skippedByFilters: 0,
    skippedBeforeLink: 0,
    ledgerRows: 0,
    findings: [],
    repaired: 0,
    warnings: [],
  };

  const wanted = options.direction || 'both';
  const directions: Array<'source' | 'target'> = [];
  if (wanted === 'source' || wanted === 'both') directions.push('source');
  if (link.mode === 'twoway' && (wanted === 'target' || wanted === 'both')) directions.push('target');
  if (wanted === 'target' && link.mode !== 'twoway') {
    report.warnings.push('Link is one-way, so the target channel is never a source. Nothing to scan in that direction.');
  }

  for (const direction of directions) {
    await scanDirection(client, link, direction, limit, apply, report);
  }

  return report;
}

async function scanDirection(
  client: any,
  link: SyncLink,
  direction: 'source' | 'target',
  limit: number,
  apply: boolean,
  report: SyncScanReport,
): Promise<void> {
  const srcChannelId = direction === 'source' ? link.sourceChannelId : link.targetChannelId;
  const dstChannelId = direction === 'source' ? link.targetChannelId : link.sourceChannelId;

  const srcChannel = await resolveChannelForBackup(client, srcChannelId);
  if (!srcChannel || typeof srcChannel.messages?.fetch !== 'function') {
    report.warnings.push(`Source channel ${srcChannelId} could not be read.`);
    return;
  }
  const dstChannel = await resolveChannelForBackup(client, dstChannelId);
  if (!dstChannel) {
    report.warnings.push(`Destination channel ${dstChannelId} could not be read.`);
    return;
  }

  const botId = client?.user?.id;
  const roleCache = new Map<string, string[]>();
  const recent = await fetchRecentMessages(srcChannel, limit);
  if (recent.length === 0) {
    report.warnings.push(`Channel ${srcChannelId} returned no messages to compare.`);
    return;
  }

  // ULIDs sort by time, so the fetched window is exactly [oldest, newest] and a
  // ledger row inside that range should have a matching source message.
  const ids = recent.map((msg: any) => String(msg?.id || '')).filter(Boolean).sort();
  const oldestId = ids[0];
  const newestId = ids[ids.length - 1];
  const seen = new Set(ids);

  // Copies already sitting in the destination that the ledger knows nothing
  // about. Without these, history brought over by `sync copy` reads as "never
  // mirrored", and a repair would post all of it a second time.
  const untracked = await fetchUntrackedCopies(dstChannel, botId, limit);
  const linkCreatedMs = Date.parse(link.createdAt || '');

  for (const msg of recent) {
    const messageId = String(msg?.id || '');
    if (!messageId) continue;

    // Same filter the live mirror applies: the bot's own sends (copies) and
    // command invocations are never mirrored, so they are never drift.
    const authorId = msg?.authorId || msg?.author?.id || msg?.author;
    if (botId && authorId && String(authorId) === String(botId)) continue;
    if (typeof msg?.content === 'string' && msg.content.startsWith(config.prefix)) continue;
    if (msg?.systemMessage) continue;

    report.scanned += 1;

    const row = mirrorsForSource(messageId).find((entry) => entry.linkId === link.id);

    // Judged against the filters as they are now, so tightening a filter shows
    // the copies it would no longer allow, and loosening one shows what to post.
    const verdict = await checkLinkFilters(client, link, msg, srcChannelId, roleCache);
    if (!verdict.allowed) {
      if (!row) {
        report.skippedByFilters += 1;
        continue;
      }
      report.ledgerRows += 1;
      const finding: SyncScanFinding = {
        issue: 'filtered',
        direction,
        sourceChannelId: srcChannelId,
        targetChannelId: row.targetChannelId,
        sourceId: messageId,
        targetId: row.targetId,
        preview: previewOf(msg?.content),
        reason: verdict.reason,
      };
      if (apply) await repairFiltered(client, row, finding, report);
      report.findings.push(finding);
      continue;
    }

    if (!row) {
      const match = takeUntrackedCopy(untracked, msg);
      if (match) {
        const finding: SyncScanFinding = {
          issue: 'untracked',
          direction,
          sourceChannelId: srcChannelId,
          targetChannelId: dstChannelId,
          sourceId: messageId,
          targetId: match,
          preview: previewOf(msg?.content),
        };
        if (apply) {
          recordMirror(link, srcChannelId, messageId, dstChannelId, match);
          finding.repaired = true;
          report.repaired += 1;
        }
        report.findings.push(finding);
        continue;
      }

      // The link only mirrors what is posted after it was created. Older
      // messages without a copy were never meant to travel.
      const postedMs = messageTimeMs(msg);
      if (postedMs !== null && Number.isFinite(linkCreatedMs) && postedMs < linkCreatedMs) {
        report.skippedBeforeLink += 1;
        continue;
      }

      const finding: SyncScanFinding = {
        issue: 'missing',
        direction,
        sourceChannelId: srcChannelId,
        targetChannelId: dstChannelId,
        sourceId: messageId,
        preview: previewOf(msg?.content),
      };
      if (apply) await repairMissing(client, link, srcChannelId, dstChannelId, dstChannel, msg, finding, report);
      report.findings.push(finding);
      continue;
    }

    report.ledgerRows += 1;

    const copy = await fetchMessageById(client, row.targetChannelId, row.targetId);
    if (!copy) {
      const finding: SyncScanFinding = {
        issue: 'copy-missing',
        direction,
        sourceChannelId: srcChannelId,
        targetChannelId: row.targetChannelId,
        sourceId: messageId,
        targetId: row.targetId,
        preview: previewOf(msg?.content),
      };
      if (apply) {
        forgetMirrors((entry) => entry.targetId === row.targetId);
        finding.repaired = true;
        report.repaired += 1;
      }
      report.findings.push(finding);
      continue;
    }

    if (contentDrifted(String(msg?.content || ''), String(copy?.content || ''))) {
      const finding: SyncScanFinding = {
        issue: 'stale',
        direction,
        sourceChannelId: srcChannelId,
        targetChannelId: row.targetChannelId,
        sourceId: messageId,
        targetId: row.targetId,
        preview: previewOf(msg?.content),
      };
      if (apply) {
        try {
          await dstChannel.messages.edit(row.targetId, { content: String(msg?.content || '') });
          finding.repaired = true;
          report.repaired += 1;
          stats.edits += 1;
        } catch (error) {
          finding.error = readableError(error);
        }
      }
      report.findings.push(finding);
    }
  }

  // Anything the ledger claims inside the scanned window, but that is no longer
  // in the channel, was deleted at the source while nobody was listening.
  const orphans = loadMirrors().filter(
    (entry) =>
      entry.linkId === link.id &&
      entry.sourceChannelId === srcChannelId &&
      entry.sourceId >= oldestId &&
      entry.sourceId <= newestId &&
      !seen.has(entry.sourceId),
  );

  for (const entry of orphans) {
    const finding: SyncScanFinding = {
      issue: 'orphan',
      direction,
      sourceChannelId: srcChannelId,
      targetChannelId: entry.targetChannelId,
      sourceId: entry.sourceId,
      targetId: entry.targetId,
    };
    if (apply) {
      try {
        const channel = await resolveChannelForBackup(client, entry.targetChannelId);
        if (channel && typeof channel.messages?.delete === 'function') {
          await channel.messages.delete(entry.targetId);
          stats.deletes += 1;
        }
        forgetMirrors((row) => row.targetId === entry.targetId);
        finding.repaired = true;
        report.repaired += 1;
      } catch (error) {
        finding.error = readableError(error);
      }
    }
    report.findings.push(finding);
  }
}

async function repairMissing(
  client: any,
  link: SyncLink,
  srcChannelId: string,
  dstChannelId: string,
  dstChannel: any,
  msg: any,
  finding: SyncScanFinding,
  report: SyncScanReport,
): Promise<void> {
  try {
    const snapshot = await snapshotChannelMessage(client, msg);
    if (!snapshot) {
      finding.error = 'Message could not be snapshotted.';
      return;
    }
    finding.authorName = snapshot.authorName;
    const newId = await replayMessage(dstChannel, snapshot, replyMapForLink(link, snapshot), client);
    if (!newId) {
      finding.error = 'Stoat rejected the replayed message (empty or unsupported).';
      return;
    }
    recordMirror(link, srcChannelId, snapshot.id, dstChannelId, newId);
    finding.targetId = newId;
    finding.repaired = true;
    report.repaired += 1;
    stats.mirrored += 1;
    await sleep(COPY_SEND_DELAY_MS);
  } catch (error) {
    finding.error = readableError(error);
  }
}

/** Take down a copy the link's filters no longer allow, and drop its row. */
async function repairFiltered(
  client: any,
  row: MirrorEntry,
  finding: SyncScanFinding,
  report: SyncScanReport,
): Promise<void> {
  try {
    const copy = await fetchMessageById(client, row.targetChannelId, row.targetId);
    if (copy) {
      const channel = await resolveChannelForBackup(client, row.targetChannelId);
      if (!channel || typeof channel.messages?.delete !== 'function') {
        finding.error = `Channel ${row.targetChannelId} could not be read.`;
        return;
      }
      await channel.messages.delete(row.targetId);
      stats.deletes += 1;
    }
    forgetMirrors((entry) => entry.targetId === row.targetId);
    finding.repaired = true;
    report.repaired += 1;
  } catch (error) {
    finding.error = readableError(error);
  }
}

/**
 * Drop ledger rows that can never be used again: rows for deleted links, and
 * rows whose copy is gone from the destination channel.
 */
export async function pruneSyncLedger(
  client: any,
  options: { apply?: boolean; limit?: number } = {},
): Promise<{ checked: number; deadLinks: number; missingCopies: number; removed: number; apply: boolean }> {
  const apply = !!options.apply;
  const limit = Math.max(1, Math.min(options.limit || 200, SCAN_MAX_LIMIT));
  const rows = loadMirrors();
  const liveIds = new Set(readStore().links.map((link) => link.id));

  const deadLinkRows = rows.filter((row) => !liveIds.has(row.linkId));

  // Checking a copy still exists costs one request each, so only the newest
  // `limit` rows of live links are verified per run.
  const candidates = rows.filter((row) => liveIds.has(row.linkId)).slice(-limit);
  const missing: SyncMirrorRow[] = [];
  for (const row of candidates) {
    const copy = await fetchMessageById(client, row.targetChannelId, row.targetId);
    if (!copy) missing.push(row);
  }

  let removed = 0;
  if (apply && (deadLinkRows.length > 0 || missing.length > 0)) {
    const drop = new Set([...deadLinkRows, ...missing].map((row) => row.targetId));
    removed = forgetMirrors((row) => drop.has(row.targetId));
  }

  return {
    checked: candidates.length,
    deadLinks: deadLinkRows.length,
    missingCopies: missing.length,
    removed,
    apply,
  };
}

/**
 * Read or move a link's offline catch-up cursor. `value` of 'reset' clears it,
 * which makes the next catch-up re-record the channel tip and replay nothing.
 */
export function setSyncCursor(
  linkId: string,
  direction: 'source' | 'target',
  value: string | null,
): SyncLink | null {
  const store = readStore();
  const link = store.links.find((item) => item.id === linkId);
  if (!link) return null;

  const key = direction === 'source' ? 'lastSourceId' : 'lastTargetId';
  if (value === null) delete link[key];
  else link[key] = String(value).trim();

  writeStore(store);
  return link;
}

/** Force one source message through the mirror again, ledger row and all. */
export async function remirrorMessage(
  client: any,
  linkId: string,
  messageId: string,
): Promise<{ targetId: string | null; replacedCopy: string | null }> {
  const link = getSyncLink(linkId);
  if (!link) throw new Error(`No sync link with id \`${linkId}\`.`);

  const id = String(messageId || '').trim();
  if (!id) throw new Error('A message ID is required.');

  // The message can sit on either end of a twoway link; find which.
  let srcChannelId = link.sourceChannelId;
  let dstChannelId = link.targetChannelId;
  let msg = await fetchMessageById(client, srcChannelId, id);
  if (!msg && link.mode === 'twoway') {
    srcChannelId = link.targetChannelId;
    dstChannelId = link.sourceChannelId;
    msg = await fetchMessageById(client, srcChannelId, id);
  }
  if (!msg) throw new Error(`Message \`${id}\` was not found in either channel of that link.`);

  // Remove the previous copy first so the channel does not end up with two.
  const existing = mirrorsForSource(id).find((row) => row.linkId === link.id);
  let replacedCopy: string | null = null;
  if (existing) {
    try {
      const channel = await resolveChannelForBackup(client, existing.targetChannelId);
      if (channel && typeof channel.messages?.delete === 'function') {
        await channel.messages.delete(existing.targetId);
        replacedCopy = existing.targetId;
      }
    } catch {
      // Copy may already be gone; the ledger row goes either way.
    }
    forgetMirrors((row) => row.targetId === existing.targetId);
  }

  const dstChannel = await resolveChannelForBackup(client, dstChannelId);
  if (!dstChannel) throw new Error(`Destination channel \`${dstChannelId}\` could not be read.`);

  const snapshot = await snapshotChannelMessage(client, msg);
  if (!snapshot) throw new Error('Message could not be snapshotted.');

  const newId = await replayMessage(dstChannel, snapshot, replyMapForLink(link, snapshot), client);
  if (newId) {
    recordMirror(link, srcChannelId, snapshot.id, dstChannelId, newId);
    stats.mirrored += 1;
  }
  return { targetId: newId, replacedCopy };
}

/**
 * End-to-end check of what the mirror needs on the destination side: send a
 * masqueraded probe message, edit it, then delete it again. Failures here are
 * why edits or deletes silently do nothing — usually a missing permission.
 */
export async function probeSyncLink(
  client: any,
  linkId: string,
  direction: 'source' | 'target' = 'source',
): Promise<{ channelId: string; send: boolean; edit: boolean; remove: boolean; errors: string[] }> {
  const link = getSyncLink(linkId);
  if (!link) throw new Error(`No sync link with id \`${linkId}\`.`);

  const channelId = direction === 'source' ? link.targetChannelId : link.sourceChannelId;
  const result = { channelId, send: false, edit: false, remove: false, errors: [] as string[] };

  const channel = await resolveChannelForBackup(client, channelId);
  if (!channel) {
    result.errors.push(`Channel ${channelId} could not be read (is the bot a member of that server?).`);
    return result;
  }

  let probeId: string | null = null;
  try {
    const sent = await channel.send({
      content: 'Sync self-test — this message deletes itself.',
      masquerade: { name: 'Sync self-test' },
    });
    probeId = sent?.id ? String(sent.id) : null;
    result.send = !!probeId;
  } catch (error) {
    result.errors.push(`send: ${readableError(error)}`);
    return result;
  }

  if (!probeId) {
    result.errors.push('send: Stoat accepted the message but returned no id.');
    return result;
  }

  try {
    await channel.messages.edit(probeId, { content: 'Sync self-test — edit OK.' });
    result.edit = true;
  } catch (error) {
    result.errors.push(`edit: ${readableError(error)}`);
  }

  try {
    await channel.messages.delete(probeId);
    result.remove = true;
  } catch (error) {
    result.errors.push(`delete: ${readableError(error)}`);
  }

  return result;
}

// ------------------------------------------------------------
// Scan helpers
// ------------------------------------------------------------

/** Newest `limit` messages in a channel, oldest-first, paged backwards. */
async function fetchRecentMessages(channel: any, limit: number): Promise<any[]> {
  const collected: any[] = [];
  let before: string | undefined;

  while (collected.length < limit) {
    const want = Math.min(SCAN_FETCH_BATCH, limit - collected.length);
    let batch: any;
    try {
      batch = await channel.messages.fetch({ limit: want, before, sort: 'Latest' });
    } catch {
      break;
    }
    const messages = batch instanceof Map ? Array.from(batch.values()) : (Array.isArray(batch) ? batch : []);
    if (messages.length === 0) break;

    collected.push(...messages);
    const ids = messages.map((msg: any) => String(msg?.id || '')).filter(Boolean).sort();
    before = ids[0];
    if (messages.length < want) break;
  }

  return collected.sort((a: any, b: any) => String(a?.id || '').localeCompare(String(b?.id || '')));
}

type UntrackedCopy = { id: string; name: string; content: string; hasFiles: boolean; used: boolean };

/**
 * The bot's messages in the destination that are not a known copy, oldest
 * first. The window is wider than the source one because copies are posted
 * later than their originals and the destination may carry its own traffic.
 */
async function fetchUntrackedCopies(dstChannel: any, botId: string | undefined, limit: number): Promise<UntrackedCopy[]> {
  if (!botId || typeof dstChannel?.messages?.fetch !== 'function') return [];
  loadMirrors();
  const recent = await fetchRecentMessages(dstChannel, Math.min(limit * 2, SCAN_MAX_LIMIT));
  const copies: UntrackedCopy[] = [];
  for (const msg of recent) {
    const id = String(msg?.id || '');
    const authorId = msg?.authorId || msg?.author?.id || msg?.author;
    if (!id || String(authorId) !== String(botId) || mirrorsByTargetId.has(id)) continue;
    copies.push({
      id,
      name: String(msg?.masquerade?.name || ''),
      content: String(msg?.content || '').trim(),
      hasFiles: (msg?.attachments?.length || msg?.embeds?.length || 0) > 0,
      used: false,
    });
  }
  return copies;
}

/**
 * Claim the destination message that is a copy of `msg`, if there is one.
 * A copy has the author's name as its masquerade and the same text, possibly
 * followed by links to attachments that could not be re-uploaded. Content-less
 * originals only match a copy that also carries files, so a random bot message
 * is never taken for one.
 */
function takeUntrackedCopy(copies: UntrackedCopy[], msg: any): string | null {
  const content = String(msg?.content || '').trim();
  const authorName = String(
    msg?.masquerade?.name || msg?.member?.nickname || msg?.author?.displayName || msg?.author?.username || '',
  );
  const hasFiles = (msg?.attachments?.length || msg?.embeds?.length || 0) > 0;
  if (!content && !hasFiles) return null;

  for (const copy of copies) {
    if (copy.used) continue;
    // Only rule a copy out on name when both names are known.
    if (copy.name && authorName && copy.name !== authorName) continue;
    const matches = content
      ? copy.content === content || copy.content.startsWith(`${content}\n`)
      : copy.hasFiles || /^https?:\/\//.test(copy.content);
    if (!matches) continue;
    copy.used = true;
    return copy.id;
  }
  return null;
}

/** When a message was posted, from its timestamp or its ULID. */
function messageTimeMs(msg: any): number | null {
  const raw = msg?.createdAt;
  const parsed = raw instanceof Date ? raw.getTime() : typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (Number.isFinite(parsed)) return parsed;
  return ulidTimestamp(String(msg?.id || ''));
}

// Crockford base32 time prefix of a ULID; null when the id is not one.
function ulidTimestamp(id: string): number | null {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const s = id.toUpperCase();
  if (s.length !== 26) return null;
  let ms = 0;
  for (let i = 0; i < 10; i += 1) {
    const index = alphabet.indexOf(s[i]);
    if (index === -1) return null;
    ms = ms * 32 + index;
  }
  return ms > 0 ? ms : null;
}

async function fetchMessageById(client: any, channelId: string, messageId: string): Promise<any | null> {
  try {
    const channel = await resolveChannelForBackup(client, channelId);
    if (!channel || typeof channel.messages?.fetch !== 'function') return null;
    const msg = await channel.messages.fetch(messageId);
    return msg || null;
  } catch {
    // A 404 here is the answer, not an error: the message is gone.
    return null;
  }
}

/**
 * True when a copy no longer matches its source. `replayMessage` appends the
 * URLs of attachments it could not re-upload, so a copy that merely *starts*
 * with the source content has not drifted.
 */
function contentDrifted(sourceContent: string, copyContent: string): boolean {
  const source = sourceContent.trim();
  const copy = copyContent.trim();
  if (source === copy) return false;
  if (!source) return false;
  return !copy.startsWith(source);
}

function previewOf(content: any): string | undefined {
  if (typeof content !== 'string') return undefined;
  const flat = content.replace(/\s+/g, ' ').trim();
  if (!flat) return undefined;
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

// ULIDs sort lexicographically by time, so string comparison gives newest.
function maxId(a: string | undefined, b: string): string {
  if (!a) return b;
  return b > a ? b : a;
}

// ============================================================
// Store helpers
// ============================================================

// The links are consulted for every message in every channel, and for every
// edit and delete packet, so the file is parsed once and then served from
// memory (this process is the only writer — see json-store.ts). Every caller
// shares the one store object, which also means an async mirror that saves
// after a link was removed can no longer write the removed link back.
let storeCache: SyncStore | null = null;
let linkedChannelIds: Set<string> | null = null;
let storeFlushTimer: NodeJS.Timeout | null = null;

// Cursor moves are written on every mirrored message; batching them turns a
// burst of chat into one write. A hard crash inside the window loses at most
// this much: catch-up replays those few messages again.
const STORE_FLUSH_DEBOUNCE_MS = 1000;

function readStore(): SyncStore {
  if (storeCache) return storeCache;
  const parsed = readJson<SyncStore>(SYNC_FILE, { version: 1, links: [] });
  const links = Array.isArray(parsed?.links) ? parsed.links.filter(isValidLink) : [];
  // Filters are matched on every message, so a hand-edited file must not be
  // able to hand the matcher a non-array or a bare wildcard.
  for (const link of links) {
    if (link.filters !== undefined) applyFilters(link, link.filters);
  }
  storeCache = { version: 1, links };
  return storeCache;
}

/**
 * Save the store. Link edits are written straight away; `deferred` batches the
 * writes that happen per message (catch-up cursors), see above.
 */
function writeStore(store: SyncStore, deferred = false): void {
  storeCache = store;
  linkedChannelIds = null;
  if (!deferred) {
    flushStore(store);
    return;
  }
  if (storeFlushTimer) return;
  storeFlushTimer = setTimeout(() => flushStore(storeCache), STORE_FLUSH_DEBOUNCE_MS);
  storeFlushTimer.unref?.();
}

function flushStore(store: SyncStore | null): void {
  if (storeFlushTimer) {
    clearTimeout(storeFlushTimer);
    storeFlushTimer = null;
  }
  if (store) writeJson(SYNC_FILE, store);
}

/** Every channel on either side of a link — the cheap first test for each message. */
function linkedChannels(): Set<string> {
  if (!linkedChannelIds) {
    linkedChannelIds = new Set();
    for (const link of readStore().links) {
      linkedChannelIds.add(link.sourceChannelId);
      linkedChannelIds.add(link.targetChannelId);
    }
  }
  return linkedChannelIds;
}

/** Write any batched cursor changes now (shutdown, backups). The ledger is never batched. */
export function flushSyncNow(): void {
  if (storeFlushTimer) flushStore(storeCache);
}

// A backup reads the files after flushing them, and a restore replaces them on
// disk; either way the memory copies must follow.
registerDataFileHooks(basename(SYNC_FILE), {
  flush: flushSyncNow,
  reload: () => {
    if (storeFlushTimer) clearTimeout(storeFlushTimer);
    storeFlushTimer = null;
    storeCache = null;
    linkedChannelIds = null;
  },
});
// `!reset` wipes the ledger table; the memory copy goes with it.
registerDataFileHooks(LEGACY_MIRROR_FILE, {
  reload: () => {
    mirrorEntries = null;
    mirrorsBySourceId.clear();
    mirrorsByTargetId.clear();
  },
});

function isValidLink(link: any): link is SyncLink {
  return (
    link &&
    typeof link.id === 'string' &&
    typeof link.sourceChannelId === 'string' &&
    typeof link.targetChannelId === 'string' &&
    (link.mode === 'oneway' || link.mode === 'twoway')
  );
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

function readableError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
