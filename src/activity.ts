/**
 * Activity tracking — lightweight, privacy-conscious message counters that
 * feed the dashboard Overview page (KPI cards, activity graph, and the
 * "most sent images" / "most active" leaderboards).
 *
 * We store *counts only* — never message content. For each human message the
 * bot sees we bump:
 *   - a global total (messages / images / attachments),
 *   - a per-user tally (with the author's current display name so the
 *     leaderboard is readable),
 *   - a per-day bucket (messages / images) for the time-series chart.
 *
 * Storage: SQLite (db.ts) — `activity_totals`, `activity_users` and
 * `activity_daily`, one row each, bumped in a single transaction per message.
 * The old `data/activity.json` is imported on first use.
 */

import { config } from './config.js';
import { registerDataFileHooks } from './json-store.js';
import { getMeta, importLegacyJson, setMeta, sql, transaction } from './db.js';

// Keep the daily series bounded so the table never grows without limit.
const MAX_DAILY_DAYS = 120;
const STARTED_AT_KEY = 'activity.startedAt';

type UserTally = {
  name: string;
  avatarId: string | null;
  messages: number;
  images: number;
  attachments: number;
  lastAt: string;
};

type DailyBucket = {
  messages: number;
  images: number;
};

// Per-server activity, in the shape the old JSON file used (legacy import).
type ServerActivity = {
  totals: { messages: number; images: number; attachments: number };
  users: Record<string, UserTally>;
  daily: Record<string, DailyBucket>;
};

let ready = false;
// The day each server's daily series was last pruned; pruning runs once a day.
const prunedOn = new Map<string, string>();

// Which server a message belongs to; falls back to the configured default.
function resolveServerId(message: any): string {
  const id = message?.channel?.serverId || message?.server?._id || message?.server?.id || message?.serverId;
  return String(id || config.serverId || 'unknown');
}

/** Import `data/activity.json` on first use, and note when counting began. */
function ensureReady() {
  if (ready) return;
  importLegacyJson('activity.json', (parsed) => {
    const startedAt = typeof parsed?.startedAt === 'string' ? parsed.startedAt : new Date().toISOString();
    setMeta(STARTED_AT_KEY, startedAt);
    for (const [serverId, value] of Object.entries(legacyServers(parsed))) importServer(serverId, value);
  });
  if (!getMeta(STARTED_AT_KEY)) setMeta(STARTED_AT_KEY, new Date().toISOString());
  ready = true;
}

// `!reset` wipes the tables; the prune bookkeeping goes with them.
registerDataFileHooks('activity.json', { reload: () => prunedOn.clear() });

function legacyServers(parsed: any): Record<string, ServerActivity> {
  if (!parsed || typeof parsed !== 'object') return {};

  // Shape v2: { version: 2, servers: { [id]: {...} } }.
  if (parsed.servers && typeof parsed.servers === 'object') {
    const servers: Record<string, ServerActivity> = {};
    for (const [id, value] of Object.entries<any>(parsed.servers)) {
      if (id) servers[id] = normalizeServerActivity(value);
    }
    return servers;
  }

  // Legacy v1 flat shape (global totals/users/daily) → attribute to the
  // configured default server so existing history isn't lost.
  return { [config.serverId || 'unknown']: normalizeServerActivity(parsed) };
}

function importServer(serverId: string, value: ServerActivity) {
  sql('INSERT OR REPLACE INTO activity_totals (server_id, messages, images, attachments) VALUES (?, ?, ?, ?)')
    .run(serverId, value.totals.messages, value.totals.images, value.totals.attachments);
  const user = sql(
    `INSERT OR REPLACE INTO activity_users (server_id, user_id, name, avatar_id, messages, images, attachments, last_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const [userId, tally] of Object.entries(value.users)) {
    user.run(serverId, userId, tally.name, tally.avatarId, tally.messages, tally.images, tally.attachments, tally.lastAt);
  }
  const day = sql('INSERT OR REPLACE INTO activity_daily (server_id, day, messages, images) VALUES (?, ?, ?, ?)');
  for (const [key, bucket] of Object.entries(value.daily)) day.run(serverId, key, bucket.messages, bucket.images);
  pruneDaily(serverId);
}

function normalizeServerActivity(value: any): ServerActivity {
  return {
    totals: {
      messages: num(value?.totals?.messages),
      images: num(value?.totals?.images),
      attachments: num(value?.totals?.attachments),
    },
    users: normalizeUsers(value?.users),
    daily: normalizeDaily(value?.daily),
  };
}

function normalizeUsers(users: any): Record<string, UserTally> {
  const out: Record<string, UserTally> = {};
  if (!users || typeof users !== 'object') return out;
  for (const [id, value] of Object.entries<any>(users)) {
    if (!id) continue;
    out[id] = {
      name: typeof value?.name === 'string' ? value.name : id,
      avatarId: typeof value?.avatarId === 'string' ? value.avatarId : null,
      messages: num(value?.messages),
      images: num(value?.images),
      attachments: num(value?.attachments),
      lastAt: typeof value?.lastAt === 'string' ? value.lastAt : new Date(0).toISOString(),
    };
  }
  return out;
}

function normalizeDaily(daily: any): Record<string, DailyBucket> {
  const out: Record<string, DailyBucket> = {};
  if (!daily || typeof daily !== 'object') return out;
  for (const [day, value] of Object.entries<any>(daily)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    out[day] = { messages: num(value?.messages), images: num(value?.images) };
  }
  return out;
}

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function localDayKey(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Keep the newest MAX_DAILY_DAYS days of a server's series. */
function pruneDaily(serverId: string) {
  sql(
    `DELETE FROM activity_daily WHERE server_id = ? AND day NOT IN (
       SELECT day FROM activity_daily WHERE server_id = ? ORDER BY day DESC LIMIT ${MAX_DAILY_DAYS}
     )`,
  ).run(serverId, serverId);
}

// Count image attachments on a live stoat message. Mirrors the detection used
// by the transcript/backup layers: MIME on contentType/type, or a metadata
// type of "Image" (stoat CDN images sometimes omit a usable content type).
function countImageAttachments(message: any): { images: number; attachments: number } {
  const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
  let images = 0;
  for (const att of attachments) {
    if (isImageAttachment(att)) images += 1;
  }
  return { images, attachments: attachments.length };
}

function isImageAttachment(att: any): boolean {
  const type = String(att?.contentType || att?.content_type || att?.type || att?.metadata?.type || '').toLowerCase();
  if (type.startsWith('image/') || type === 'image') return true;
  const filename = String(att?.filename || att?.name || '').toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|avif|heic|svg)$/.test(filename);
}

function resolveAuthorId(message: any): string | null {
  const id = message?.authorId || message?.author?.id || message?.author?._id
    || (typeof message?.author === 'string' ? message.author : null);
  return id ? String(id) : null;
}

// Prefer the server-specific member avatar, then the account avatar. We only
// keep the file id; the dashboard turns it into a CDN URL at serve time so a
// changed avatar is picked up on the user's next message.
function resolveAvatarId(message: any): string | null {
  const sources = [message?.member?.avatar, message?.author?.avatar, message?.author?.profile?.avatar];
  for (const src of sources) {
    if (!src) continue;
    if (typeof src === 'string') return src;
    const id = src._id || src.id || src.fileId || src.file_id || null;
    if (id) return String(id);
  }
  return null;
}

function resolveAuthorName(message: any, fallback: string): string {
  const candidates = [
    message?.member?.nickname,
    message?.author?.displayName,
    message?.author?.display_name,
    message?.author?.username,
    message?.username,
  ];
  for (const candidate of candidates) {
    const name = String(candidate || '').trim();
    if (name) return name.slice(0, 64);
  }
  return fallback;
}

/**
 * Record a single message the bot observed. Skips the bot's own messages,
 * system messages, and command invocations. Safe to call on every message —
 * failures are swallowed so tracking never breaks message handling.
 */
export function recordMessage(client: any, message: any) {
  try {
    if (!message) return;
    if (message.systemMessage || message.isSystem) return;

    const authorId = resolveAuthorId(message);
    if (!authorId) return;

    // Ignore the bot's own output.
    const botId = client?.user?.id || client?.user?._id;
    if (botId && String(authorId) === String(botId)) return;

    // Ignore command invocations — they aren't "real" chat activity.
    const content = typeof message?.content === 'string' ? message.content : '';
    if (content.startsWith(config.prefix)) return;

    ensureReady();
    const serverId = resolveServerId(message);
    const { images, attachments } = countImageAttachments(message);
    // Empty when the message carries no name or avatar: the stored one is kept.
    const name = resolveAuthorName(message, '');
    const avatarId = resolveAvatarId(message);
    const dayKey = localDayKey();

    transaction(() => {
      sql(
        `INSERT INTO activity_totals (server_id, messages, images, attachments) VALUES (?, 1, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           messages = messages + 1, images = images + excluded.images, attachments = attachments + excluded.attachments`,
      ).run(serverId, images, attachments);

      sql(
        `INSERT INTO activity_users (server_id, user_id, name, avatar_id, messages, images, attachments, last_at)
         VALUES ($server, $user, CASE WHEN $name = '' THEN $user ELSE $name END, $avatar, 1, $images, $attachments, $at)
         ON CONFLICT(server_id, user_id) DO UPDATE SET
           name = CASE WHEN $name = '' THEN name ELSE $name END,
           avatar_id = COALESCE($avatar, avatar_id),
           messages = messages + 1,
           images = images + $images,
           attachments = attachments + $attachments,
           last_at = $at`,
      ).run({ server: serverId, user: authorId, name, avatar: avatarId, images, attachments, at: new Date().toISOString() });

      sql(
        `INSERT INTO activity_daily (server_id, day, messages, images) VALUES (?, ?, 1, ?)
         ON CONFLICT(server_id, day) DO UPDATE SET messages = messages + 1, images = images + excluded.images`,
      ).run(serverId, dayKey, images);

      // A new day is the only time the series can outgrow its cap.
      if (prunedOn.get(serverId) !== dayKey) {
        pruneDaily(serverId);
        prunedOn.set(serverId, dayKey);
      }
    });
  } catch (error) {
    console.warn('[activity] recordMessage failed:', (error as any)?.message || error);
  }
}

// Exported for tests.
export function previousWindowTotals(
  daily: Record<string, DailyBucket>,
  windowStart: Date,
  days: number,
  startedAt: string,
): { messages: number; images: number } | null {
  const cursor = new Date(windowStart);
  cursor.setDate(cursor.getDate() - days);
  const firstKey = localDayKey(cursor);

  // Tracking must predate the window's first day: a start on that day means a
  // partial day. An unparseable start date yields "NaN-…", which sorts after
  // any real key.
  const trackedSince = localDayKey(new Date(startedAt));
  if (trackedSince >= firstKey) return null;
  // Pruning only ever trims the series down to exactly MAX_DAILY_DAYS keys, so
  // a shorter series is complete; a full one must still reach firstKey.
  const keys = Object.keys(daily);
  if (keys.length >= MAX_DAILY_DAYS && !keys.some((key) => key <= firstKey)) return null;

  const totals = { messages: 0, images: 0 };
  for (let i = 0; i < days; i += 1) {
    const bucket = daily[localDayKey(cursor)];
    totals.messages += bucket?.messages || 0;
    totals.images += bucket?.images || 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  return totals;
}

export type LeaderRow = { userId: string; name: string; avatarId: string | null; messages: number; images: number; attachments: number };
export type DailyPoint = { day: string; messages: number; images: number };

export type ActivitySummary = {
  totals: { messages: number; images: number; attachments: number };
  trackedUsers: number;
  startedAt: string;
  daily: DailyPoint[];
  /**
   * Totals for the same-length window right before `daily`, for "vs previous
   * period" deltas. Null when tracking (or the pruned daily series) does not
   * reach back to that window's first day: a partial window would read as a
   * false drop.
   */
  previous: { messages: number; images: number } | null;
  topMessages: LeaderRow[];
  topImages: LeaderRow[];
  activeToday: number;
};

/**
 * Aggregate the store for the dashboard. `days` controls the length of the
 * time-series (zero-filled so gaps in activity still draw a continuous line);
 * `topN` caps each leaderboard.
 */
export function getActivitySummary({ days = 14, topN = 8, serverId = config.serverId }: { days?: number; topN?: number; serverId?: string } = {}): ActivitySummary {
  ensureReady();
  const startedAt = getMeta(STARTED_AT_KEY) || new Date().toISOString();
  const safeDays = Math.max(1, Math.min(MAX_DAILY_DAYS, Math.floor(days) || 14));
  const safeTopN = Math.max(1, Math.min(50, Math.floor(topN) || 8));

  const totalsRow = sql('SELECT messages, images, attachments FROM activity_totals WHERE server_id = ?').get(serverId) as any;
  const dailyMap: Record<string, DailyBucket> = {};
  for (const row of sql('SELECT day, messages, images FROM activity_daily WHERE server_id = ?').all(serverId) as any[]) {
    dailyMap[row.day] = { messages: row.messages, images: row.images };
  }

  const daily: DailyPoint[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  cursor.setDate(cursor.getDate() - (safeDays - 1));
  const previous = previousWindowTotals(dailyMap, cursor, safeDays, startedAt);
  const todayKey = localDayKey();

  for (let i = 0; i < safeDays; i += 1) {
    const key = localDayKey(cursor);
    const bucket = dailyMap[key];
    daily.push({ day: key, messages: bucket?.messages || 0, images: bucket?.images || 0 });
    cursor.setDate(cursor.getDate() + 1);
  }

  const counts = sql(
    'SELECT COUNT(*) AS tracked, COALESCE(SUM(substr(last_at, 1, 10) = ?), 0) AS activeToday FROM activity_users WHERE server_id = ?',
  ).get(todayKey, serverId) as { tracked: number; activeToday: number };

  const toLeaderRow = (row: any): LeaderRow => ({
    userId: row.user_id,
    name: row.name,
    avatarId: row.avatar_id ?? null,
    messages: row.messages,
    images: row.images,
    attachments: row.attachments,
  });
  const columns = 'user_id, name, avatar_id, messages, images, attachments';
  const topMessages = (sql(
    `SELECT ${columns} FROM activity_users WHERE server_id = ? ORDER BY messages DESC, user_id LIMIT ?`,
  ).all(serverId, safeTopN) as any[]).map(toLeaderRow);
  const topImages = (sql(
    `SELECT ${columns} FROM activity_users WHERE server_id = ? AND images > 0 ORDER BY images DESC, user_id LIMIT ?`,
  ).all(serverId, safeTopN) as any[]).map(toLeaderRow);

  return {
    totals: {
      messages: totalsRow?.messages || 0,
      images: totalsRow?.images || 0,
      attachments: totalsRow?.attachments || 0,
    },
    trackedUsers: counts.tracked,
    startedAt,
    daily,
    previous,
    topMessages,
    topImages,
    activeToday: counts.activeToday,
  };
}
