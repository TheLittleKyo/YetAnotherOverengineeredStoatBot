import { MessageEmbed } from 'stoatbot.js';
import { config } from './config.js';
import { sendServerLog } from './log-system.js';
import { getClientToken, getApiBaseUrl } from './stoat-api.js';
import { getMemberIds } from './member-utils.js';
import { createArrayFileStore, dataFile } from './json-store.js';

export type RaidAction = 'kick' | 'ban' | 'alert';
export type AgeAction = 'kick' | 'ban' | 'alert' | 'off';

export type AntiraidConfig = {
  serverId: string;
  enabled: boolean;
  joinThreshold: number; // joins that trip a raid
  joinWindowSec: number; // ...within this many seconds
  action: RaidAction; // what to do to joiners during a raid
  minAccountAgeMin: number; // 0 = disabled
  accountAgeAction: AgeAction;
  alertChannelId: string | null; // where raid alerts go (falls back to log channel)
  lockdownMinutes: number; // how long raid mode stays active after a trip
  honeypotChannelId: string | null; // trap channel: anyone who posts here gets actioned
  honeypotAction: RaidAction;
};

export const HONEYPOT_DEFAULT_NAME = 'honeypot';

const store = createArrayFileStore<AntiraidConfig>(dataFile('antiraid.json'), 'servers', 'antiraid');

// In-memory runtime state (not persisted): sliding join window + raid status.
const joinTimes = new Map<string, number[]>(); // serverId -> join timestamps (ms)
const raidUntil = new Map<string, number>(); // serverId -> raid-mode expiry (ms), 0/absent = off
const recentJoiners = new Map<string, { userId: string; at: number }[]>(); // for retroactive action

// Honeypot runtime state, keyed `${serverId}:${userId}`. While an action is
// pending, or until `until`, further messages from that user are only deleted.
type HoneypotHit = { pending: boolean; until: number; deleted: number };
const honeypotHits = new Map<string, HoneypotHit>();
const honeypotAlerts = new Map<string, { entries: { userId: string; action: RaidAction; ok: boolean }[]; timer: NodeJS.Timeout }>();
const honeypotDeletedIds = new Map<string, number>(); // message id -> deleted at (ms)
// After a kick/ban lands, absorb messages that were already in flight. Short so
// a kicked raider who rejoins and posts again is kicked again.
const HONEYPOT_GRACE_MS = 3_000;
// After a failed action, or in alert-only mode, wait this long before retrying.
const HONEYPOT_RETRY_MS = 60_000;
const HONEYPOT_ALERT_BATCH_MS = 5_000;
const HONEYPOT_LOOKUP_TIMEOUT_MS = 8_000;
const HONEYPOT_ACTION_TIMEOUT_MS = 15_000;
const HONEYPOT_SCAN_LIMIT = 50;
// Holding any of these marks a member as staff, exempt from the trap.
const STAFF_PERMISSIONS = ['ManageServer', 'ManageChannel', 'ManageMessages', 'KickMembers', 'BanMembers'];
const SYSTEM_USER_ID = '00000000000000000000000000';

const DEFAULTS: Omit<AntiraidConfig, 'serverId'> = {
  enabled: false,
  joinThreshold: 5,
  joinWindowSec: 10,
  action: 'kick',
  minAccountAgeMin: 0,
  accountAgeAction: 'off',
  alertChannelId: null,
  lockdownMinutes: 5,
  honeypotChannelId: null,
  honeypotAction: 'ban',
};

export function getAntiraidConfig(serverId = config.serverId): AntiraidConfig {
  const found = store.read().find((s) => s.serverId === serverId);
  return { serverId: serverId || '', ...DEFAULTS, ...(found || {}) };
}

export function setAntiraidConfig(serverId: string, updates: Partial<AntiraidConfig>): AntiraidConfig {
  const servers = store.read();
  const current = servers.find((s) => s.serverId === serverId) || { serverId, ...DEFAULTS };
  const next: AntiraidConfig = { ...DEFAULTS, ...current, ...updates, serverId };

  // Clamp to sane bounds.
  next.joinThreshold = clampInt(next.joinThreshold, 2, 100, DEFAULTS.joinThreshold);
  next.joinWindowSec = clampInt(next.joinWindowSec, 2, 600, DEFAULTS.joinWindowSec);
  next.minAccountAgeMin = clampInt(next.minAccountAgeMin, 0, 525600, DEFAULTS.minAccountAgeMin);
  next.lockdownMinutes = clampInt(next.lockdownMinutes, 0, 1440, DEFAULTS.lockdownMinutes);

  store.write(servers.filter((s) => s.serverId !== serverId).concat(next));
  return next;
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function isRaidActive(serverId: string): boolean {
  const until = raidUntil.get(serverId) || 0;
  return until > Date.now();
}

export function getRaidStatus(serverId: string): { active: boolean; until: number | null } {
  const until = raidUntil.get(serverId) || 0;
  return { active: until > Date.now(), until: until > Date.now() ? until : null };
}

/**
 * Manually turn raid mode on (for `lockdownMinutes`, or 60m if that's 0) or off.
 */
export function setRaidActive(serverId: string, active: boolean): void {
  if (!active) { raidUntil.delete(serverId); return; }
  const cfg = getAntiraidConfig(serverId);
  const minutes = cfg.lockdownMinutes > 0 ? cfg.lockdownMinutes : 60;
  raidUntil.set(serverId, Date.now() + minutes * 60_000);
}

/**
 * Decode the creation time embedded in a ULID (Stoat/Revolt IDs). Returns ms
 * since epoch, or null when the id isn't a decodable 26-char ULID.
 */
export function ulidTimestamp(id: string): number | null {
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const s = String(id || '').toUpperCase();
  if (s.length !== 26) return null;
  let ms = 0;
  for (let i = 0; i < 10; i++) {
    const idx = CROCKFORD.indexOf(s[i]);
    if (idx === -1) return null;
    ms = ms * 32 + idx;
  }
  return ms > 0 ? ms : null;
}

function pushJoin(serverId: string, windowSec: number): number {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  const times = (joinTimes.get(serverId) || []).filter((t) => t >= cutoff);
  times.push(now);
  joinTimes.set(serverId, times);

  const joiners = (recentJoiners.get(serverId) || []).filter((j) => j.at >= cutoff);
  recentJoiners.set(serverId, joiners);
  return times.length;
}

/**
 * Entry point wired into `serverMemberJoin`. Enforces account-age gating and
 * join-rate raid detection. Best-effort: never throws into the event pipeline.
 */
export async function handleAntiraidJoin(client: any, member: any): Promise<void> {
  try {
    const ids = getMemberIds(member, config.serverId);
    if (!ids) return;

    const cfg = getAntiraidConfig(ids.serverId);
    if (!cfg.enabled) return;

    // --- Account age gate ---
    if (cfg.minAccountAgeMin > 0 && cfg.accountAgeAction !== 'off') {
      const created = ulidTimestamp(ids.userId);
      if (created != null) {
        const ageMin = (Date.now() - created) / 60_000;
        if (ageMin < cfg.minAccountAgeMin) {
          await applyAction(client, ids.serverId, ids.userId, cfg.accountAgeAction as RaidAction,
            `account age ${Math.floor(ageMin)}m < ${cfg.minAccountAgeMin}m`);
          await alert(client, cfg,
            `New account blocked`,
            `User \`${ids.userId}\` joined with account age ${Math.floor(ageMin)} min (min ${cfg.minAccountAgeMin}). Action: **${cfg.accountAgeAction}**.`,
            '#f59e0b');
          // Age-gated members are handled; still count them toward the window below.
        }
      }
    }

    // --- Join-rate raid detection ---
    const joiners = recentJoiners.get(ids.serverId) || [];
    joiners.push({ userId: ids.userId, at: Date.now() });
    recentJoiners.set(ids.serverId, joiners);
    const count = pushJoin(ids.serverId, cfg.joinWindowSec);

    const alreadyActive = isRaidActive(ids.serverId);

    if (!alreadyActive && count >= cfg.joinThreshold) {
      // Trip a raid: lock down and retroactively action the whole burst.
      const minutes = cfg.lockdownMinutes > 0 ? cfg.lockdownMinutes : 60;
      raidUntil.set(ids.serverId, Date.now() + minutes * 60_000);

      const burst = (recentJoiners.get(ids.serverId) || []).map((j) => j.userId);
      await alert(client, cfg,
        `🚨 Raid detected`,
        `${count} joins within ${cfg.joinWindowSec}s (threshold ${cfg.joinThreshold}). Raid mode ON for ${minutes}m. Action on joiners: **${cfg.action}**.`,
        '#f2596b');

      for (const userId of burst) {
        await applyAction(client, ids.serverId, userId, cfg.action, 'raid burst');
      }
      return;
    }

    if (alreadyActive) {
      // Raid mode: action every new joiner until lockdown expires.
      await applyAction(client, ids.serverId, ids.userId, cfg.action, 'raid mode active');
    }
  } catch (error) {
    console.error('Antiraid join handler error:', error?.message || error);
  }
}

/**
 * Entry point wired into the `message` event. No real member has a reason to
 * post in the honeypot channel, so raid bots that spam every channel trip it:
 * the message is deleted and the author actioned. Returns true when the message
 * was trapped so the caller can skip commands, XP and mirroring for it.
 */
export async function handleHoneypotMessage(client: any, message: any): Promise<boolean> {
  try {
    if (!message?.channelId || !message.authorId) return false;
    if (message.authorId === client?.user?.id || message.authorId === SYSTEM_USER_ID) return false;
    // Bots, system messages and webhooks (integrations set up by staff) are never raiders.
    if (message.author?.bot || message.system || message.webhook) return false;

    const serverId = message.serverId || message.channel?.serverId;
    if (!serverId) return false;

    const cfg = getAntiraidConfig(serverId);
    if (!cfg.enabled || !cfg.honeypotChannelId || cfg.honeypotChannelId !== message.channelId) return false;

    // Already caught: skip the staff lookup so a spam burst costs one API call
    // per message (the delete) instead of a member fetch each.
    const key = `${serverId}:${message.authorId}`;
    if (isHoneypotHitActive(key)) {
      await deleteHoneypotMessage(client, message, honeypotHits.get(key));
      return true;
    }

    // Staff can post (to test it or leave a notice) without tripping the trap.
    const exempt = await isHoneypotExempt(client, serverId, message.authorId);
    if (exempt === true) return false;

    if (exempt === null) {
      // The author could not be verified (API failure or timeout). Remove the
      // message but never kick or ban someone who may be staff; the next
      // message retries the lookup.
      console.warn(`Antiraid honeypot could not verify ${message.authorId} in ${serverId}; message deleted, no action taken.`);
      await deleteHoneypotMessage(client, message);
      return true;
    }

    // Another message from this author may have started the action while this
    // one awaited the lookup.
    if (isHoneypotHitActive(key)) {
      await deleteHoneypotMessage(client, message, honeypotHits.get(key));
      return true;
    }

    const hit: HoneypotHit = { pending: true, until: 0, deleted: 0 };
    honeypotHits.set(key, hit);
    pruneHoneypotState();

    await deleteHoneypotMessage(client, message, hit);
    const ok = (await withTimeout(
      applyAction(client, serverId, message.authorId, cfg.honeypotAction, 'posted in honeypot channel'),
      HONEYPOT_ACTION_TIMEOUT_MS,
    )) === true;

    hit.pending = false;
    hit.until = Date.now() + (ok && cfg.honeypotAction !== 'alert' ? HONEYPOT_GRACE_MS : HONEYPOT_RETRY_MS);
    queueHoneypotAlert(client, serverId, { userId: message.authorId, action: cfg.honeypotAction, ok });
    return true;
  } catch (error) {
    console.error('Antiraid honeypot handler error:', error?.message || error);
    return false;
  }
}

/**
 * True when the message was deleted by the honeypot. The `messageDelete` log
 * listener uses it to skip a log entry per spam message; the batched honeypot
 * alert already reports the deletions.
 */
export function wasDeletedByHoneypot(messageId: string): boolean {
  if (!messageId || !honeypotDeletedIds.has(messageId)) return false;
  honeypotDeletedIds.delete(messageId);
  return true;
}

/**
 * Send a server's batched honeypot alert now instead of waiting for the batch
 * timer. Exported for tests.
 */
export async function flushHoneypotAlerts(client: any, serverId: string): Promise<void> {
  const batch = honeypotAlerts.get(serverId);
  if (!batch) return;
  honeypotAlerts.delete(serverId);
  clearTimeout(batch.timer);

  // One line per user; a user caught twice in the window (kicked, rejoined,
  // kicked again) reports the latest outcome.
  const byUser = new Map<string, { action: RaidAction; ok: boolean }>();
  for (const entry of batch.entries) byUser.set(entry.userId, entry);

  const cfg = getAntiraidConfig(serverId);
  const lines: string[] = [];
  let failed = false;
  for (const [userId, entry] of byUser) {
    const hit = honeypotHits.get(`${serverId}:${userId}`);
    const deleted = hit?.deleted || 0;
    if (hit) hit.deleted = 0;
    const outcome = entry.action === 'alert'
      ? 'alert only'
      : entry.ok ? (entry.action === 'ban' ? 'banned' : 'kicked') : `**${entry.action} failed**`;
    if (!entry.ok) failed = true;
    lines.push(`- \`${userId}\` — ${outcome}, ${deleted} message${deleted === 1 ? '' : 's'} deleted`);
  }

  const shown = lines.slice(0, 20);
  if (lines.length > shown.length) shown.push(`- …and ${lines.length - shown.length} more`);
  const title = byUser.size === 1 ? 'Honeypot triggered' : `Honeypot caught ${byUser.size} users`;
  const description =
    `Posted in the honeypot channel${cfg.honeypotChannelId ? ` <#${cfg.honeypotChannelId}>` : ''}.\n` +
    shown.join('\n') +
    (failed ? `\n\nSome actions failed. The bot's role must be above these members, with Kick/Ban permission.` : '');
  await alert(client, cfg, title, description, '#f2596b');
}

function isHoneypotHitActive(key: string): boolean {
  const hit = honeypotHits.get(key);
  return !!hit && (hit.pending || Date.now() < hit.until);
}

function pruneHoneypotState(): void {
  const now = Date.now();
  for (const [key, hit] of honeypotHits) {
    if (!hit.pending && now - hit.until > HONEYPOT_RETRY_MS) honeypotHits.delete(key);
  }
  for (const [id, at] of honeypotDeletedIds) {
    if (now - at > HONEYPOT_RETRY_MS) honeypotDeletedIds.delete(id);
  }
}

function queueHoneypotAlert(client: any, serverId: string, entry: { userId: string; action: RaidAction; ok: boolean }): void {
  const batch = honeypotAlerts.get(serverId);
  if (batch) { batch.entries.push(entry); return; }
  // A raid lands many hits at once; batch them into one alert per window.
  const timer = setTimeout(() => {
    flushHoneypotAlerts(client, serverId).catch((error) => console.warn('Antiraid honeypot alert failed:', error?.message || error));
  }, HONEYPOT_ALERT_BATCH_MS);
  timer.unref?.();
  honeypotAlerts.set(serverId, { entries: [entry], timer });
}

/**
 * Whether the author is exempt from the honeypot: true for the owner and staff,
 * false for everyone else, null when that could not be determined. A fresh
 * fetch is preferred because cached roles can lag behind a promotion; the cache
 * is only trusted to confirm staff, never to condemn.
 */
async function isHoneypotExempt(client: any, serverId: string, userId: string): Promise<boolean | null> {
  const server = client?.servers?.cache?.get?.(serverId)
    || (await withTimeout(client?.servers?.fetch?.(serverId), HONEYPOT_LOOKUP_TIMEOUT_MS));
  if (!server) return null;
  if (server.ownerId === userId) return true;

  const fresh = await withTimeout(server.members?.fetch?.(userId), HONEYPOT_LOOKUP_TIMEOUT_MS);
  if (fresh) return isStaffMember(fresh);

  const cached = server.members?.cache?.get?.(userId);
  return cached && isStaffMember(cached) ? true : null;
}

function isStaffMember(member: any): boolean {
  if (member?.serverOwner === true || member?.owner === true) return true;
  if (typeof member?.hasPermission !== 'function') return false;
  return STAFF_PERMISSIONS.some((permission) => {
    try { return member.hasPermission(permission) === true; } catch { return false; }
  });
}

/** Resolve `task`, or null when it rejects or outlives `ms`. */
function withTimeout<T>(task: Promise<T> | null | undefined, ms: number): Promise<T | null> {
  if (!task || typeof (task as any).then !== 'function') return Promise.resolve(null);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(task).catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

export type HoneypotChannelCheck = { ok: true; name: string; recentPosters: number | null } | { ok: false; error: string };

/**
 * Check a channel before making it the honeypot. Rejects channels outside this
 * server, non-text channels and the alert channel, and counts distinct human
 * authors in its recent history. Turning a live channel into the honeypot would
 * action everyone who talks there, so callers must ask for confirmation when
 * `recentPosters` is non-zero or unknown (null).
 */
export async function inspectHoneypotChannel(client: any, serverId: string, channelId: string): Promise<HoneypotChannelCheck> {
  const channel = client?.channels?.cache?.get?.(channelId)
    || (await withTimeout(client?.channels?.fetch?.(channelId), HONEYPOT_LOOKUP_TIMEOUT_MS));
  if (!channel) return { ok: false, error: 'Channel not found, or the bot cannot see it.' };

  const channelServerId = channel.serverId || channel.server_id || channel.server?.id;
  if (String(channelServerId || '') !== serverId) return { ok: false, error: 'That channel is not in this server.' };

  const type = String(channel.channelType || channel.channel_type || channel.type || '');
  if (type && !/text/i.test(type)) return { ok: false, error: 'The honeypot must be a text channel.' };

  if (getAntiraidConfig(serverId).alertChannelId === channelId) {
    return { ok: false, error: 'That is the antiraid alert channel. Pick a different channel.' };
  }

  return {
    ok: true,
    name: String(channel.name || channelId),
    recentPosters: await countRecentPosters(client, channel, channelId),
  };
}

async function countRecentPosters(client: any, channel: any, channelId: string): Promise<number | null> {
  let messages: any[] | null = null;
  if (typeof channel?.messages?.fetch === 'function') {
    const result: any = await withTimeout(channel.messages.fetch({ limit: HONEYPOT_SCAN_LIMIT }), HONEYPOT_LOOKUP_TIMEOUT_MS);
    if (result && typeof result.values === 'function') messages = Array.from(result.values());
    else if (Array.isArray(result)) messages = result;
  }
  if (!messages && typeof client?.api?.get === 'function') {
    const raw: any = await withTimeout(client.api.get(`/channels/${channelId}/messages`, { limit: HONEYPOT_SCAN_LIMIT }), HONEYPOT_LOOKUP_TIMEOUT_MS);
    messages = Array.isArray(raw) ? raw : Array.isArray(raw?.messages) ? raw.messages : null;
  }
  if (!messages) return null;

  const authors = new Set<string>();
  for (const m of messages) {
    const authorId = String(m?.authorId || (typeof m?.author === 'string' ? m.author : ''));
    if (!authorId || authorId === client?.user?.id || authorId === SYSTEM_USER_ID) continue;
    if (m?.webhook || m?.author?.bot) continue;
    authors.add(authorId);
  }
  return authors.size;
}

/**
 * Create a text channel, post the warning notice in it, and make it this
 * server's honeypot. The notice is what keeps real members out; bots don't read.
 */
export async function createHoneypotChannel(client: any, serverId: string, name?: string): Promise<{ channelId: string; settings: AntiraidConfig }> {
  const channelName = String(name || '').trim().slice(0, 32) || HONEYPOT_DEFAULT_NAME;
  const cfg = getAntiraidConfig(serverId);
  const description = 'Do not post here. Messages in this channel are treated as raid activity.';

  // A second channel would orphan the first: it keeps its warning notice but
  // stops trapping. A configured channel that no longer exists doesn't block.
  if (cfg.honeypotChannelId) {
    const existing = client?.channels?.cache?.get?.(cfg.honeypotChannelId)
      || (await withTimeout(client?.channels?.fetch?.(cfg.honeypotChannelId), HONEYPOT_LOOKUP_TIMEOUT_MS));
    if (existing) {
      throw Object.assign(
        new Error('This server already has a honeypot channel. Turn it off first to create a new one.'),
        { code: 'HONEYPOT_EXISTS', channelId: cfg.honeypotChannelId },
      );
    }
  }

  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  const created = typeof server?.channels?.create === 'function'
    ? await server.channels.create({ name: channelName, type: 'Text', description })
    : await rawRequest(client, 'POST', `/servers/${serverId}/channels`, { name: channelName, type: 'Text', description });

  const channelId = created?.id || created?._id;
  if (!channelId) throw new Error('Stoat created the channel but returned no id.');

  const settings = setAntiraidConfig(serverId, { honeypotChannelId: String(channelId) });

  try {
    const channel = typeof created?.send === 'function'
      ? created
      : client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
    // Worded to stay true whichever action is configured later.
    const embed = new MessageEmbed()
      .setTitle('Do not post in this channel')
      .setDescription('This channel is a trap for raid bots. Any message sent here is deleted, and its author can be **kicked or banned** automatically.')
      .setColor('#f2596b');
    await channel?.send({ embeds: [embed] });
  } catch (error) {
    console.warn('Antiraid honeypot notice failed:', error?.message || error);
  }

  return { channelId: String(channelId), settings };
}

async function deleteHoneypotMessage(client: any, message: any, hit?: HoneypotHit): Promise<void> {
  if (hit) hit.deleted++;
  if (message?.id) honeypotDeletedIds.set(String(message.id), Date.now());
  const task = Promise.resolve()
    .then(() => (typeof message.delete === 'function'
      ? message.delete()
      : rawRequest(client, 'DELETE', `/channels/${message.channelId}/messages/${message.id}`)))
    .catch((error) => console.warn(`Antiraid honeypot delete failed for ${message?.id}:`, error?.message || error));
  await withTimeout(task, HONEYPOT_ACTION_TIMEOUT_MS);
}

/**
 * Kick / ban / alert a single member. `alert` does nothing punitive here (the
 * caller already sends the alert); kick and ban hit the API with a raw-fetch
 * fallback. Resolves true when the action went through (always for `alert`).
 */
async function applyAction(client: any, serverId: string, userId: string, action: RaidAction, reason: string): Promise<boolean> {
  if (!userId || userId === client?.user?.id) return false;
  if (action === 'alert') return true;

  try {
    if (action === 'ban') {
      await banMember(client, serverId, userId, `Antiraid: ${reason}`);
      console.log(`🔨 Antiraid banned ${userId} in ${serverId} (${reason}).`);
    } else {
      await kickMember(client, serverId, userId);
      console.log(`👢 Antiraid kicked ${userId} in ${serverId} (${reason}).`);
    }
    return true;
  } catch (error) {
    console.warn(`Antiraid ${action} failed for ${userId}:`, error?.message || error);
    return false;
  }
}

async function kickMember(client: any, serverId: string, userId: string): Promise<void> {
  if (typeof client?.api?.delete === 'function') {
    try { await client.api.delete(`/servers/${serverId}/members/${userId}`); return; }
    catch (error) { if (!shouldFallback(error)) throw error; }
  }
  await rawRequest(client, 'DELETE', `/servers/${serverId}/members/${userId}`);
}

async function banMember(client: any, serverId: string, userId: string, reason: string): Promise<void> {
  const body = { reason: String(reason || '').slice(0, 1024) };
  if (typeof client?.api?.put === 'function') {
    // stoatbot's REST client sends only the `body` key; the ban endpoint
    // rejects a request without a JSON body.
    try { await client.api.put(`/servers/${serverId}/bans/${userId}`, { body }); return; }
    catch (error) { if (!shouldFallback(error)) throw error; }
  }
  await rawRequest(client, 'PUT', `/servers/${serverId}/bans/${userId}`, body);
}

function shouldFallback(error: any): boolean {
  // The wrapped client may lack a verb helper; fall back to raw fetch then.
  const msg = String(error?.message || error || '');
  return /is not a function|undefined|no method/i.test(msg);
}

async function rawRequest(client: any, method: string, path: string, body?: any): Promise<any> {
  const token = getClientToken(client);
  if (!token) throw new Error('missing bot token for antiraid API call');
  const baseUrl = getApiBaseUrl(client);

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
      'Content-Type': 'application/json',
      'User-Agent': 'YetAnotherOverengineeredStoatBot antiraid',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text().catch(() => '');
  if (response.ok) {
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }
  let detail = response.statusText;
  try { detail = JSON.parse(text)?.type || detail; } catch { if (text) detail = text; }
  throw new Error(`API ${method} ${path} failed with status ${response.status}: ${detail}`);
}

async function alert(client: any, cfg: AntiraidConfig, title: string, description: string, colour: string): Promise<void> {
  // Prefer the configured antiraid alert channel; fall back to the log system.
  if (cfg.alertChannelId) {
    try {
      const channel = client.channels.cache.get(cfg.alertChannelId) || (await client.channels.fetch(cfg.alertChannelId).catch(() => null));
      if (channel) {
        const embed = new MessageEmbed().setTitle(title).setDescription(description).setColor(colour);
        await channel.send({ embeds: [embed] });
        return;
      }
    } catch (error) {
      console.warn('Antiraid alert channel send failed:', error?.message || error);
    }
  }
  // Route the fallback to THIS server's log channel, not the configured
  // default — a raid in server B must alert server B's log channel.
  await sendServerLog(client, { title, description, colour }, cfg.serverId).catch(() => {});
}
