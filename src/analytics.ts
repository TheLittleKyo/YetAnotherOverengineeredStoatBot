/**
 * Server analytics — the counters the Overview page cannot answer from message
 * totals alone: membership churn, when the server is actually awake, which
 * channels carry the traffic, voice time, and command usage.
 *
 * This sits beside `activity.ts` rather than inside it. That module is the
 * message tally the Overview tab is built on; growing it a third dimension
 * (per channel, per hour, per event type) would change its tables for every
 * install. A separate store can be added, pruned, and reset on its own.
 *
 * Like the activity tracker, only counts are stored — never message content.
 *
 * Storage: SQLite (db.ts) — `analytics_servers` (when counting began, voice
 * totals), `analytics_daily`, `analytics_slots` (per hour and per weekday),
 * `analytics_channels` and `analytics_commands`. Each event bumps its rows in
 * one transaction. The old `data/analytics.json` is imported on first use.
 */

import { config } from './config.js';
import { registerDataFileHooks } from './json-store.js';
import { debug } from './logger.js';
import { getMeta, importLegacyJson, setMeta, sql, transaction } from './db.js';
import type { RawPacket } from './stoat-types.js';

const MAX_DAILY_DAYS = 120;
/** A voice session longer than this is treated as a stale join and dropped. */
const MAX_VOICE_SESSION_MS = 12 * 60 * 60 * 1000;
const STARTED_AT_KEY = 'analytics.startedAt';

type DailyBucket = {
  messages: number;
  joins: number;
  leaves: number;
  voiceMinutes: number;
  commands: number;
};

type DailyColumn = 'messages' | 'joins' | 'leaves' | 'voice_minutes' | 'commands';

let ready = false;
// The day each server's daily series was last pruned; pruning runs once a day.
const prunedOn = new Map<string, string>();

// userId → { channelId, serverId, since } while someone sits in a voice channel.
const voiceSessions = new Map<string, { channelId: string; serverId: string; since: number }>();

function num(value: any): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Import `data/analytics.json` on first use, and note when counting began. */
function ensureReady() {
  if (ready) return;
  importLegacyJson('analytics.json', (raw) => {
    setMeta(STARTED_AT_KEY, typeof raw?.startedAt === 'string' ? raw.startedAt : new Date().toISOString());
    for (const [serverId, value] of Object.entries<any>(raw?.servers || {})) {
      if (serverId && value && typeof value === 'object') importServer(serverId, value);
    }
  });
  if (!getMeta(STARTED_AT_KEY)) setMeta(STARTED_AT_KEY, new Date().toISOString());
  ready = true;
}

function importServer(serverId: string, value: any) {
  sql('INSERT OR REPLACE INTO analytics_servers (server_id, since, voice_minutes, voice_sessions) VALUES (?, ?, ?, ?)').run(
    serverId,
    typeof value.since === 'string' ? value.since : null,
    num(value?.voice?.totalMinutes),
    num(value?.voice?.sessions),
  );
  const day = sql(
    'INSERT OR REPLACE INTO analytics_daily (server_id, day, messages, joins, leaves, voice_minutes, commands) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (const [key, bucket] of Object.entries<any>(value.daily || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue;
    day.run(serverId, key, num(bucket?.messages), num(bucket?.joins), num(bucket?.leaves), num(bucket?.voiceMinutes), num(bucket?.commands));
  }
  const slot = sql('INSERT OR REPLACE INTO analytics_slots (server_id, kind, slot, messages) VALUES (?, ?, ?, ?)');
  for (const [kind, length, list] of [['h', 24, value.hours], ['w', 7, value.weekdays]] as const) {
    for (let i = 0; i < length; i++) {
      const count = Array.isArray(list) ? num(list[i]) : 0;
      if (count) slot.run(serverId, kind, i, count);
    }
  }
  const channel = sql('INSERT OR REPLACE INTO analytics_channels (server_id, channel_id, messages, last_at) VALUES (?, ?, ?, ?)');
  for (const [channelId, bucket] of Object.entries<any>(value.channels || {})) {
    if (channelId) channel.run(serverId, channelId, num(bucket?.messages), num(bucket?.lastAt));
  }
  const command = sql('INSERT OR REPLACE INTO analytics_commands (server_id, name, count) VALUES (?, ?, ?)');
  for (const [name, count] of Object.entries<any>(value.commands || {})) {
    const key = String(name || '').trim().slice(0, 40);
    if (key) command.run(serverId, key, num(count));
  }
  pruneDaily(serverId);
}

// `!reset` wipes the tables; the prune bookkeeping goes with them.
registerDataFileHooks('analytics.json', { reload: () => prunedOn.clear() });

/** Test hook: forget live voice sessions and the prune bookkeeping. */
export function resetAnalyticsCache() {
  voiceSessions.clear();
  prunedOn.clear();
}

export function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Counting for a server begins the first time anything is recorded for it. */
function ensureServer(serverId: string) {
  sql('INSERT INTO analytics_servers (server_id, since) VALUES (?, ?) ON CONFLICT(server_id) DO NOTHING').run(
    serverId,
    new Date().toISOString(),
  );
}

/** Keep the newest MAX_DAILY_DAYS days of a server's series. */
function pruneDaily(serverId: string) {
  sql(
    `DELETE FROM analytics_daily WHERE server_id = ? AND day NOT IN (
       SELECT day FROM analytics_daily WHERE server_id = ? ORDER BY day DESC LIMIT ${MAX_DAILY_DAYS}
     )`,
  ).run(serverId, serverId);
}

/** Add to one of today's daily counters (inside the caller's transaction). */
function bumpDaily(serverId: string, column: DailyColumn, amount: number) {
  const key = dayKey();
  sql(
    `INSERT INTO analytics_daily (server_id, day, ${column}) VALUES (?, ?, ?)
     ON CONFLICT(server_id, day) DO UPDATE SET ${column} = ${column} + excluded.${column}`,
  ).run(serverId, key, amount);
  if (prunedOn.get(serverId) !== key) {
    pruneDaily(serverId);
    prunedOn.set(serverId, key);
  }
}

/** Record one event: its rows change together, in one commit. */
function record(serverId: string, write: () => void) {
  ensureReady();
  transaction(() => {
    ensureServer(serverId);
    write();
  });
}

// ---- Recording -------------------------------------------------------------

/** Per-channel, per-hour and per-weekday message counters. */
export function recordAnalyticsMessage(client: any, message: any): void {
  try {
    if (!message || message.systemMessage || message.isSystem) return;
    const authorId = String(message.authorId || message.author?.id || '');
    if (!authorId || authorId === (client?.user?.id || '')) return;
    if (message.author?.bot) return;

    const serverId = String(message?.channel?.serverId || message?.serverId || '');
    if (!serverId) return;

    // Commands are counted on their own, and the Overview's message totals skip
    // them too — both tabs must report the same "messages" number.
    if (String(message.content || '').startsWith(config.prefix)) return;

    const now = new Date();
    const channelId = String(message.channelId || message.channel?.id || '');
    record(serverId, () => {
      bumpDaily(serverId, 'messages', 1);
      const slot = sql(
        `INSERT INTO analytics_slots (server_id, kind, slot, messages) VALUES (?, ?, ?, 1)
         ON CONFLICT(server_id, kind, slot) DO UPDATE SET messages = messages + 1`,
      );
      slot.run(serverId, 'h', now.getHours());
      slot.run(serverId, 'w', now.getDay());
      if (channelId) {
        sql(
          `INSERT INTO analytics_channels (server_id, channel_id, messages, last_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(server_id, channel_id) DO UPDATE SET messages = messages + 1, last_at = excluded.last_at`,
        ).run(serverId, channelId, now.getTime());
      }
    });
  } catch (error) {
    debug('analytics', () => `message record failed: ${(error as Error)?.message || error}`);
  }
}

export function recordMemberJoin(serverId: string): void {
  if (!serverId) return;
  record(serverId, () => bumpDaily(serverId, 'joins', 1));
}

export function recordMemberLeave(serverId: string): void {
  if (!serverId) return;
  record(serverId, () => bumpDaily(serverId, 'leaves', 1));
}

export function recordCommandUse(serverId: string, commandName: string): void {
  if (!serverId || !commandName) return;
  const key = String(commandName).slice(0, 40);
  record(serverId, () => {
    sql(
      `INSERT INTO analytics_commands (server_id, name, count) VALUES (?, ?, 1)
       ON CONFLICT(server_id, name) DO UPDATE SET count = count + 1`,
    ).run(serverId, key);
    bumpDaily(serverId, 'commands', 1);
  });
}

/**
 * Voice time, measured from the gateway's join/leave packets. A session with no
 * matching leave (a crash, a missed packet) is discarded rather than counted as
 * an absurd number of hours.
 */
export function recordAnalyticsVoicePacket(client: any, packet: RawPacket): void {
  const raw: any = packet;
  try {
    switch (raw?.type) {
      case 'Ready': {
        // Whoever is already in a channel when the bot connects is timed from
        // now; sessions that ended while the bot was away are closed.
        const present = new Map<string, string>();
        for (const state of raw.voice_states || []) {
          for (const participant of state?.participants || []) {
            if (participant?.id && state?.id) present.set(String(participant.id), String(state.id));
          }
        }
        for (const userId of Array.from(voiceSessions.keys())) {
          if (!present.has(userId)) endVoiceSession(userId);
        }
        for (const [userId, channelId] of present) {
          if (!voiceSessions.has(userId)) startVoiceSession(client, userId, channelId);
        }
        break;
      }
      case 'VoiceChannelJoin':
        startVoiceSession(client, String(raw.state?.id || raw.user || ''), String(raw.id || ''));
        break;
      case 'VoiceChannelLeave':
        endVoiceSession(String(raw.user || ''));
        break;
      case 'VoiceChannelMove':
        endVoiceSession(String(raw.user || ''));
        startVoiceSession(client, String(raw.user || ''), String(raw.to || ''));
        break;
    }
  } catch (error) {
    debug('analytics', () => `voice record failed: ${(error as Error)?.message || error}`);
  }
}

function startVoiceSession(client: any, userId: string, channelId: string) {
  if (!userId || !channelId) return;
  // The bot's own music sessions are not member activity.
  if (userId === String(client?.user?.id || '')) return;
  const serverId = String(client?.channels?.cache?.get?.(channelId)?.serverId || '');
  if (!serverId) return;
  voiceSessions.set(userId, { channelId, serverId, since: Date.now() });
}

function endVoiceSession(userId: string) {
  const session = voiceSessions.get(userId);
  if (!session) return;
  voiceSessions.delete(userId);

  const elapsed = Date.now() - session.since;
  if (elapsed <= 0 || elapsed > MAX_VOICE_SESSION_MS) return;

  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return;

  record(session.serverId, () => {
    sql('UPDATE analytics_servers SET voice_minutes = voice_minutes + ?, voice_sessions = voice_sessions + 1 WHERE server_id = ?')
      .run(minutes, session.serverId);
    bumpDaily(session.serverId, 'voice_minutes', minutes);
  });
}

// ---- Reporting -------------------------------------------------------------

export type AnalyticsPoint = {
  day: string;
  messages: number;
  joins: number;
  leaves: number;
  net: number;
  voiceMinutes: number;
  commands: number;
};

export type ChannelRow = { channelId: string; name: string; messages: number; share: number; lastAt: number };

export type AnalyticsSummary = {
  startedAt: string;
  days: AnalyticsPoint[];
  totals: { messages: number; joins: number; leaves: number; net: number; voiceMinutes: number; commands: number };
  /** Same-length window immediately before `days`, for period-over-period deltas. */
  previous: { messages: number; joins: number; leaves: number; voiceMinutes: number } | null;
  hours: number[];
  weekdays: number[];
  busiestHour: number | null;
  busiestWeekday: number | null;
  channels: ChannelRow[];
  commands: { name: string; count: number }[];
  voice: { totalMinutes: number; sessions: number; liveSessions: number };
};

function sumRange(daily: Record<string, DailyBucket>, from: Date, days: number) {
  const totals = { messages: 0, joins: 0, leaves: 0, voiceMinutes: 0, commands: 0 };
  const cursor = new Date(from);
  for (let i = 0; i < days; i++) {
    const entry = daily[dayKey(cursor)];
    totals.messages += entry?.messages || 0;
    totals.joins += entry?.joins || 0;
    totals.leaves += entry?.leaves || 0;
    totals.voiceMinutes += entry?.voiceMinutes || 0;
    totals.commands += entry?.commands || 0;
    cursor.setDate(cursor.getDate() + 1);
  }
  return totals;
}

export function getAnalyticsSummary(
  { days = 30, serverId = config.serverId || '', channelNames = {} }:
  { days?: number; serverId?: string; channelNames?: Record<string, string> } = {},
): AnalyticsSummary {
  ensureReady();
  const startedAt = getMeta(STARTED_AT_KEY) || new Date().toISOString();
  const server = sql('SELECT since, voice_minutes, voice_sessions FROM analytics_servers WHERE server_id = ?').get(serverId) as any;
  // A server with nothing recorded yet starts counting now.
  const since: string = server ? server.since || startedAt : new Date().toISOString();
  const safeDays = Math.max(1, Math.min(MAX_DAILY_DAYS, Math.floor(days) || 30));

  const daily: Record<string, DailyBucket> = {};
  for (const row of sql('SELECT * FROM analytics_daily WHERE server_id = ?').all(serverId) as any[]) {
    daily[row.day] = {
      messages: row.messages,
      joins: row.joins,
      leaves: row.leaves,
      voiceMinutes: row.voice_minutes,
      commands: row.commands,
    };
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (safeDays - 1));

  const points: AnalyticsPoint[] = [];
  const cursor = new Date(start);
  for (let i = 0; i < safeDays; i++) {
    const key = dayKey(cursor);
    const entry = daily[key];
    points.push({
      day: key,
      messages: entry?.messages || 0,
      joins: entry?.joins || 0,
      leaves: entry?.leaves || 0,
      net: (entry?.joins || 0) - (entry?.leaves || 0),
      voiceMinutes: entry?.voiceMinutes || 0,
      commands: entry?.commands || 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  const totals = points.reduce(
    (acc, point) => ({
      messages: acc.messages + point.messages,
      joins: acc.joins + point.joins,
      leaves: acc.leaves + point.leaves,
      net: acc.net + point.net,
      voiceMinutes: acc.voiceMinutes + point.voiceMinutes,
      commands: acc.commands + point.commands,
    }),
    { messages: 0, joins: 0, leaves: 0, net: 0, voiceMinutes: 0, commands: 0 },
  );

  // The previous window only makes sense once tracking reaches back that far;
  // a partial window would read as a collapse in traffic.
  const previousStart = new Date(start);
  previousStart.setDate(previousStart.getDate() - safeDays);
  const trackedSince = dayKey(new Date(since));
  const previous = trackedSince <= dayKey(previousStart) ? sumRange(daily, previousStart, safeDays) : null;

  const hours = new Array(24).fill(0);
  const weekdays = new Array(7).fill(0);
  for (const row of sql('SELECT kind, slot, messages FROM analytics_slots WHERE server_id = ?').all(serverId) as any[]) {
    const list = row.kind === 'h' ? hours : row.kind === 'w' ? weekdays : null;
    if (list && row.slot >= 0 && row.slot < list.length) list[row.slot] = row.messages;
  }

  const { channelTotal } = sql(
    'SELECT COALESCE(SUM(messages), 0) AS channelTotal FROM analytics_channels WHERE server_id = ?',
  ).get(serverId) as { channelTotal: number };
  const channels: ChannelRow[] = (sql(
    'SELECT channel_id, messages, last_at FROM analytics_channels WHERE server_id = ? ORDER BY messages DESC, channel_id LIMIT 15',
  ).all(serverId) as any[]).map((row) => ({
    channelId: row.channel_id,
    name: channelNames[row.channel_id] || row.channel_id,
    messages: row.messages,
    share: Math.round((row.messages / (channelTotal || 1)) * 1000) / 10,
    lastAt: row.last_at,
  }));

  const commands = (sql(
    'SELECT name, count FROM analytics_commands WHERE server_id = ? ORDER BY count DESC, name LIMIT 15',
  ).all(serverId) as any[]).map((row) => ({ name: row.name as string, count: row.count as number }));

  const maxHour = Math.max(...hours);
  const maxWeekday = Math.max(...weekdays);

  return {
    startedAt: since,
    days: points,
    totals,
    previous: previous ? { messages: previous.messages, joins: previous.joins, leaves: previous.leaves, voiceMinutes: previous.voiceMinutes } : null,
    hours,
    weekdays,
    busiestHour: maxHour > 0 ? hours.indexOf(maxHour) : null,
    busiestWeekday: maxWeekday > 0 ? weekdays.indexOf(maxWeekday) : null,
    channels,
    commands,
    voice: {
      totalMinutes: server?.voice_minutes || 0,
      sessions: server?.voice_sessions || 0,
      liveSessions: Array.from(voiceSessions.values()).filter((session) => session.serverId === serverId).length,
    },
  };
}

/** Wipe one server's analytics (dashboard "reset" button). Counting restarts now. */
export function resetAnalytics(serverId = config.serverId || ''): void {
  ensureReady();
  transaction(() => {
    for (const table of ['analytics_daily', 'analytics_slots', 'analytics_channels', 'analytics_commands', 'analytics_servers']) {
      sql(`DELETE FROM ${table} WHERE server_id = ?`).run(serverId);
    }
    ensureServer(serverId);
  });
}
