import type { MessageEmbed } from 'stoatbot.js';
import { createArrayFileStore, dataFile } from './json-store.js';
import { isHexColour, isHttpUrl, safeEmbed } from './embed-limits.js';
import type { CustomEmbedConfig } from './embed-editor.js';

export type IntervalUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month';

export type ReminderSchedule =
  | { type: 'interval'; every: number; unit: IntervalUnit }
  | { type: 'weekly'; days: number[]; time: string } // days: 0=Sun..6=Sat, time 'HH:MM'
  | { type: 'monthly'; day: number; time: string } // day 1..31
  | { type: 'once'; at: number }; // epoch ms

export type Reminder = {
  id: string;
  serverId: string;
  channelId: string;
  message: string;
  /**
   * Optional embed posted alongside `message`. A reminder with an embed and no
   * message posts the embed alone, which is what a scheduled announcement
   * usually wants; the same placeholders are filled in both.
   */
  embed?: CustomEmbedConfig | null;
  schedule: ReminderSchedule;
  enabled: boolean;
  createdAt: number;
  lastRunAt: number | null;
  nextRunAt: number | null;
};

const store = createArrayFileStore<Reminder>(dataFile('reminders.json'), 'reminders', 'reminders');

const UNIT_MS: Record<Exclude<IntervalUnit, 'month'>, number> = {
  second: 1000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// Smallest effective interval, so a runaway "every 1 second" can't hammer the API.
export const MIN_INTERVAL_MS = 5_000;

function generateId(): string {
  return `rm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function listReminders(serverId?: string): Reminder[] {
  const all = store.read();
  return serverId ? all.filter((r) => r.serverId === serverId) : all;
}

export function addReminder(entry: {
  serverId: string;
  channelId: string;
  message: string;
  embed?: CustomEmbedConfig | null;
  schedule: ReminderSchedule;
}): Reminder {
  const reminders = store.read();
  const now = Date.now();
  const reminder: Reminder = {
    id: generateId(),
    serverId: entry.serverId,
    channelId: entry.channelId,
    message: entry.message,
    embed: normalizeReminderEmbed(entry.embed),
    schedule: entry.schedule,
    enabled: true,
    createdAt: now,
    lastRunAt: null,
    nextRunAt: computeFirstRun(entry.schedule, now),
  };
  store.write([...reminders, reminder]);
  return reminder;
}

export function removeReminder(id: string): boolean {
  const reminders = store.read();
  const next = reminders.filter((r) => r.id !== id);
  if (next.length === reminders.length) return false;
  store.write(next);
  return true;
}

export function toggleReminder(id: string): Reminder | null {
  const reminders = store.read();
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder) return null;
  reminder.enabled = !reminder.enabled;
  // Re-arm when re-enabling so it doesn't fire immediately on a stale nextRun.
  if (reminder.enabled) {
    reminder.nextRunAt = computeFirstRun(reminder.schedule, Date.now());
  }
  store.write(reminders);
  return reminder;
}

function updateReminder(id: string, patch: Partial<Reminder>) {
  const reminders = store.read();
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder) return;
  Object.assign(reminder, patch);
  store.write(reminders);
}

/**
 * Keep only the embed fields a reminder can post, so a payload pasted from the
 * embed editor cannot smuggle extra keys into the send call.
 */
function normalizeReminderEmbed(value: any): CustomEmbedConfig | null {
  if (!value || typeof value !== 'object') return null;
  const embed: CustomEmbedConfig = {};
  const title = String(value.title || '').trim().slice(0, 100);
  const description = String(value.description || '').trim().slice(0, 2000);
  const color = String(value.color || '').trim().slice(0, 32);
  const url = String(value.url || '').trim().slice(0, 500);
  if (title) embed.title = title;
  if (description) embed.description = description;
  // Stoat rejects the whole message over a bad colour or link, so those are
  // dropped here rather than failing every scheduled send.
  if (color && isHexColour(color)) embed.color = color;
  if (url && isHttpUrl(url)) embed.url = url;
  return embed.title || embed.description ? embed : null;
}

/**
 * Change a reminder's channel, message, embed or schedule. Editing the
 * schedule re-arms the next run so the change takes effect immediately rather
 * than after the old timer fires once more.
 */
export function editReminder(
  id: string,
  patch: { channelId?: string; message?: string; embed?: CustomEmbedConfig | null; schedule?: ReminderSchedule },
): Reminder | null {
  const reminders = store.read();
  const reminder = reminders.find((r) => r.id === id);
  if (!reminder) return null;

  // Built on a copy and checked before anything is stored: a rejected edit
  // must leave the live reminder exactly as it was.
  const next: Reminder = { ...reminder };
  if (patch.channelId !== undefined) next.channelId = String(patch.channelId || '').trim();
  if (patch.message !== undefined) next.message = String(patch.message || '');
  if (patch.embed !== undefined) next.embed = normalizeReminderEmbed(patch.embed);
  if (patch.schedule !== undefined) {
    next.schedule = patch.schedule;
    next.nextRunAt = next.enabled ? computeFirstRun(patch.schedule, Date.now()) : null;
  }
  if (!next.channelId || (!next.message && !next.embed)) return null;

  Object.assign(reminder, next);
  store.write(reminders);
  return reminder;
}

// ---- Schedule math ----

function parseTime(time: string): { h: number; m: number } {
  const match = String(time || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { h: 12, m: 0 };
  return { h: Math.min(23, Number(match[1])), m: Math.min(59, Number(match[2])) };
}

export function intervalMs(every: number, unit: IntervalUnit): number {
  if (unit === 'month') return 30 * UNIT_MS.day * every; // approximate; only used for display/validation
  return UNIT_MS[unit] * every;
}

/**
 * First fire time for a freshly created (or re-enabled) schedule.
 */
export function computeFirstRun(schedule: ReminderSchedule, now: number): number | null {
  switch (schedule.type) {
    case 'once':
      return schedule.at > now ? schedule.at : null;
    case 'interval':
    case 'weekly':
    case 'monthly':
      return computeNextRun(schedule, now);
    default:
      return null;
  }
}

/**
 * Next fire strictly after `afterMs`, or null if the schedule has no future
 * occurrence (a `once` in the past).
 */
export function computeNextRun(schedule: ReminderSchedule, afterMs: number): number | null {
  switch (schedule.type) {
    case 'once':
      return schedule.at > afterMs ? schedule.at : null;

    case 'interval': {
      const every = Math.max(1, Math.round(schedule.every));
      if (schedule.unit === 'month') {
        const d = new Date(afterMs);
        d.setMonth(d.getMonth() + every);
        return d.getTime();
      }
      const step = Math.max(MIN_INTERVAL_MS, UNIT_MS[schedule.unit] * every);
      return afterMs + step;
    }

    case 'weekly': {
      const { h, m } = parseTime(schedule.time);
      const days = (schedule.days || []).filter((d) => d >= 0 && d <= 6);
      if (days.length === 0) return null;
      const base = new Date(afterMs);
      for (let i = 0; i <= 8; i++) {
        const cand = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i, h, m, 0, 0);
        if (cand.getTime() > afterMs && days.includes(cand.getDay())) return cand.getTime();
      }
      return null;
    }

    case 'monthly': {
      const { h, m } = parseTime(schedule.time);
      const targetDay = Math.min(31, Math.max(1, Math.round(schedule.day)));
      const base = new Date(afterMs);
      for (let i = 0; i <= 13; i++) {
        const monthIndex = base.getMonth() + i;
        const year = base.getFullYear() + Math.floor(monthIndex / 12);
        const month = ((monthIndex % 12) + 12) % 12;
        const lastDay = new Date(year, month + 1, 0).getDate();
        const day = Math.min(targetDay, lastDay);
        const cand = new Date(year, month, day, h, m, 0, 0);
        if (cand.getTime() > afterMs) return cand.getTime();
      }
      return null;
    }

    default:
      return null;
  }
}

const UNIT_ALIASES: Record<string, IntervalUnit> = {
  s: 'second', sec: 'second', secs: 'second', second: 'second', seconds: 'second',
  m: 'minute', min: 'minute', mins: 'minute', minute: 'minute', minutes: 'minute',
  h: 'hour', hr: 'hour', hrs: 'hour', hour: 'hour', hours: 'hour',
  d: 'day', day: 'day', days: 'day',
  w: 'week', wk: 'week', wks: 'week', week: 'week', weeks: 'week',
  mo: 'month', mon: 'month', month: 'month', months: 'month',
};

const DAY_ALIASES: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};

/**
 * Parse a human schedule string into a ReminderSchedule, or return an error.
 * Forms:
 *   every 30s | every 2 hours | every 1 week | every 2 months
 *   weekly mon,wed,fri 09:00   (or a bare day list: "mon,fri 18:30")
 *   monthly 15 09:00
 *   on 2026-12-25 10:00   (once, specific calendar date; time optional)
 */
export function parseScheduleText(input: string): { schedule?: ReminderSchedule; error?: string } {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  if (!text) return { error: 'Empty schedule.' };

  // every <n><unit> | every <n> <unit>
  if (lower.startsWith('every')) {
    const match = lower.slice(5).trim().match(/^(\d+)\s*([a-z]+)$/);
    if (!match) return { error: 'Use `every <n><unit>`, e.g. `every 30m` or `every 2 days`.' };
    const every = Number(match[1]);
    const unit = UNIT_ALIASES[match[2]];
    if (!unit) return { error: `Unknown unit \`${match[2]}\`. Use s, m, h, d, w, or mo.` };
    if (every < 1) return { error: 'Interval must be at least 1.' };
    if (unit === 'second' && every < 5) return { error: 'Minimum interval is 5 seconds.' };
    return { schedule: { type: 'interval', every, unit } };
  }

  // monthly <day> <HH:MM>
  if (lower.startsWith('monthly')) {
    const parts = lower.slice(7).trim().split(/\s+/);
    const day = Number(parts[0]);
    const time = normalizeTimeToken(parts[1]) || '09:00';
    if (!Number.isFinite(day) || day < 1 || day > 31) return { error: 'Usage: `monthly <day 1-31> <HH:MM>`.' };
    return { schedule: { type: 'monthly', day, time } };
  }

  // once / on <date> [time]
  if (lower.startsWith('on ') || lower.startsWith('once ') || lower.startsWith('at ')) {
    const rest = text.replace(/^(on|once|at)\s+/i, '').trim();
    const at = parseDateTime(rest);
    if (at == null) return { error: 'Usage: `on YYYY-MM-DD [HH:MM]`, e.g. `on 2026-12-25 10:00`.' };
    if (at <= Date.now()) return { error: 'That date/time is in the past.' };
    return { schedule: { type: 'once', at } };
  }

  // weekly [days] <HH:MM>  OR  <days> <HH:MM>
  const weeklyBody = lower.startsWith('weekly') ? lower.slice(6).trim() : lower;
  const tokens = weeklyBody.split(/\s+/).filter(Boolean);
  if (tokens.length >= 1) {
    const timeToken = normalizeTimeToken(tokens[tokens.length - 1]);
    const dayTokens = timeToken ? tokens.slice(0, -1) : tokens;
    const days = parseDayList(dayTokens.join(','));
    if (days.length > 0 && timeToken) {
      return { schedule: { type: 'weekly', days, time: timeToken } };
    }
    if (days.length > 0 && !timeToken) {
      return { error: 'Add a time, e.g. `mon,wed 09:00`.' };
    }
  }

  return { error: 'Could not parse schedule. Try `every 1h`, `weekly mon,fri 09:00`, `monthly 1 12:00`, or `on 2026-12-25 10:00`.' };
}

function parseDayList(input: string): number[] {
  const out: number[] = [];
  for (const raw of String(input || '').split(/[,\s]+/).filter(Boolean)) {
    const d = DAY_ALIASES[raw.toLowerCase()];
    if (d != null && !out.includes(d)) out.push(d);
  }
  return out.sort((a, b) => a - b);
}

function normalizeTimeToken(token: string | undefined): string | null {
  if (!token) return null;
  const match = token.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${match[2]}`;
}

function parseDateTime(input: string): number | null {
  const text = String(input || '').trim();
  // YYYY-MM-DD optionally followed by HH:MM (space or T separated).
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : 9, mi ? Number(mi) : 0, 0, 0);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function describeSchedule(schedule: ReminderSchedule): string {
  switch (schedule.type) {
    case 'interval': {
      const every = Math.max(1, Math.round(schedule.every));
      return every === 1 ? `every ${schedule.unit}` : `every ${every} ${schedule.unit}s`;
    }
    case 'weekly': {
      const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = (schedule.days || []).map((d) => names[d] || '?').join(', ');
      return `weekly on ${days} at ${schedule.time}`;
    }
    case 'monthly':
      return `monthly on day ${schedule.day} at ${schedule.time}`;
    case 'once':
      return `once at ${new Date(schedule.at).toLocaleString()}`;
    default:
      return 'unknown';
  }
}

function renderMessage(template: string): string {
  const now = new Date();
  return String(template || '')
    .replace(/\{time\}/g, now.toLocaleTimeString())
    .replace(/\{date\}/g, now.toLocaleDateString());
}

// ---- Scheduler ----

const TICK_MS = 5_000;
let schedulerTimer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let firing = false;

export function startReminderScheduler(client: any) {
  if (schedulerTimer) { clientRef = client; return; }
  clientRef = client;
  console.log(`[reminders] Scheduler started (tick ${TICK_MS / 1000}s).`);
  schedulerTimer = setInterval(() => { void fireDue().catch((e) => console.error('[reminders] tick failed:', e)); }, TICK_MS);
}

/** Whether the tick is armed, for the ops health panel. */
export function isReminderSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

export function stopReminderScheduler() {
  if (schedulerTimer) { clearInterval(schedulerTimer); schedulerTimer = null; }
  clientRef = null;
}

async function fireDue() {
  if (firing || !clientRef) return;
  firing = true;
  try {
    const now = Date.now();
    const due = store.read().filter((r) => r.enabled && r.nextRunAt != null && r.nextRunAt <= now);

    for (const reminder of due) {
      await sendReminder(reminder);

      if (reminder.schedule.type === 'once') {
        updateReminder(reminder.id, { enabled: false, lastRunAt: now, nextRunAt: null });
        continue;
      }

      // Advance to the next future occurrence (skip any missed while offline —
      // no burst catch-up).
      let next = computeNextRun(reminder.schedule, reminder.nextRunAt ?? now);
      let guard = 0;
      while (next != null && next <= now && guard++ < 100000) {
        next = computeNextRun(reminder.schedule, next);
      }
      updateReminder(reminder.id, { lastRunAt: now, nextRunAt: next });
    }
  } finally {
    firing = false;
  }
}

/**
 * Send a reminder's message immediately, regardless of schedule (used by the
 * `test` command and the dashboard preview). Does not affect nextRunAt.
 */
export async function sendReminderNow(client: any, id: string): Promise<boolean> {
  const reminder = store.read().find((r) => r.id === id);
  if (!reminder) return false;
  const prev = clientRef;
  clientRef = client;
  try {
    await sendReminder(reminder);
    return true;
  } finally {
    if (prev) clientRef = prev;
  }
}

/** Build the send payload: rendered text, rendered embed, or both. */
function buildReminderPayload(reminder: Reminder): { content?: string; embeds?: MessageEmbed[] } {
  const payload: { content?: string; embeds?: MessageEmbed[] } = {};
  const content = renderMessage(reminder.message);
  if (content) payload.content = content;

  const source = reminder.embed;
  if (source && (source.title || source.description)) {
    payload.embeds = [
      safeEmbed({
        title: source.title ? renderMessage(source.title) : '',
        description: source.description ? renderMessage(source.description) : '',
        color: source.color,
        url: source.url,
      }),
    ];
  }

  return payload;
}

async function sendReminder(reminder: Reminder) {
  if (!clientRef || !reminder.channelId) return;
  try {
    const channel = clientRef.channels?.cache?.get?.(reminder.channelId)
      || await clientRef.channels?.fetch?.(reminder.channelId).catch(() => null);
    if (channel && typeof channel.send === 'function') {
      const payload = buildReminderPayload(reminder);
      if (payload.content || payload.embeds) await channel.send(payload);
    } else {
      console.warn(`[reminders] Could not resolve channel ${reminder.channelId} for reminder ${reminder.id}.`);
    }
  } catch (error: any) {
    console.warn(`[reminders] Failed to send reminder ${reminder.id}: ${error?.message || error}`);
  }
}
