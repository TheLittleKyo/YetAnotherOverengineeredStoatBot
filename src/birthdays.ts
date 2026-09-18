/**
 * Birthdays — members register a date, the bot announces it on the day and can
 * hand out a birthday role for 24 hours.
 *
 * Time handling is the whole problem here, so it is explicit:
 *
 * - A birthday is a calendar date (month + day), never a timestamp. Storing an
 *   epoch would drag a timezone into a fact that does not have one.
 * - Announcements fire at `announceHour` in the server's configured UTC offset,
 *   not the bot host's local time, so a server in Tokyo is not congratulated at
 *   its members' 3 a.m.
 * - The last announced date is recorded per server, so a restart inside the
 *   announcement hour cannot double-post, and a bot that was offline all day
 *   does not fire yesterday's birthdays on tomorrow's tick.
 * - 29 February rolls to 1 March in non-leap years rather than being skipped.
 *
 * Storage: `data/birthdays.json`, keyed by server.
 */

import { config } from './config.js';
import { dataFile, readJson, registerDataFileHooks, writeJson } from './json-store.js';
import { clampText, EMBED_DESCRIPTION_MAX, MESSAGE_CONTENT_MAX, neutraliseMentions, safeEmbed } from './embed-limits.js';
import { recordAudit } from './audit.js';
import { debug } from './logger.js';

export type BirthdayConfig = {
  enabled: boolean;
  channelId: string | null;
  /** `{mention}` `{user}` `{age}` `{server}` are replaced. */
  message: string;
  /** Given for the day, then taken back. */
  roleId: string | null;
  /** Hour (0–23) in the server's offset when announcements go out. */
  announceHour: number;
  /** Minutes ahead of UTC, e.g. 60 for CET, -300 for EST. */
  utcOffsetMinutes: number;
  /** Let members store a birth year so ages can be shown. */
  allowYear: boolean;
};

export type BirthdayEntry = {
  userId: string;
  name: string;
  month: number; // 1–12
  day: number; // 1–31
  year: number | null;
  setAt: number;
};

type ServerState = {
  config: BirthdayConfig;
  entries: BirthdayEntry[];
  /** `YYYY-MM-DD` of the last announcement run, in the server's own offset. */
  lastAnnouncedDate: string | null;
  /**
   * Members currently holding the birthday role, when to take it back, and
   * which role it was — so changing or clearing the setting still lets the
   * old role be removed.
   */
  activeRoles: { userId: string; until: number; roleId: string }[];
};

type BirthdayStore = {
  version: 1;
  servers: Record<string, ServerState>;
};

const BIRTHDAY_FILE = dataFile('birthdays.json');
const TICK_MS = 10 * 60 * 1000;

const DEFAULT_MESSAGE = '🎂 Happy birthday {mention}! 🎉';

let store: BirthdayStore | null = null;
let timer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let ticking = false;

export function defaultBirthdayConfig(): BirthdayConfig {
  return {
    enabled: false,
    channelId: null,
    message: DEFAULT_MESSAGE,
    roleId: null,
    announceHour: 9,
    utcOffsetMinutes: 0,
    allowYear: true,
  };
}

function emptyStore(): BirthdayStore {
  return { version: 1, servers: {} };
}

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeConfig(value: any): BirthdayConfig {
  const base = defaultBirthdayConfig();
  if (!value || typeof value !== 'object') return base;
  return {
    enabled: value.enabled === true,
    channelId: text(value.channelId, 64) || null,
    message: text(value.message, 500) || base.message,
    roleId: text(value.roleId, 64) || null,
    announceHour: Math.min(23, Math.max(0, Math.floor(num(value.announceHour, base.announceHour)))),
    utcOffsetMinutes: Math.min(840, Math.max(-720, Math.floor(num(value.utcOffsetMinutes, 0)))),
    allowYear: value.allowYear !== false,
  };
}

function normalizeEntry(value: any): BirthdayEntry | null {
  const userId = text(value?.userId, 64);
  const month = Math.floor(num(value?.month, 0));
  const day = Math.floor(num(value?.day, 0));
  if (!userId || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = value?.year == null ? null : Math.floor(num(value.year, 0)) || null;
  return {
    userId,
    name: text(value?.name, 80) || userId,
    month,
    day,
    year: year && year >= 1900 && year <= new Date().getFullYear() ? year : null,
    setAt: num(value?.setAt, Date.now()),
  };
}

function load(): BirthdayStore {
  if (store) return store;
  const raw = readJson<any>(BIRTHDAY_FILE, emptyStore());
  const next = emptyStore();
  const servers = raw?.servers && typeof raw.servers === 'object' ? raw.servers : {};
  for (const [serverId, state] of Object.entries<any>(servers)) {
    next.servers[serverId] = {
      config: normalizeConfig(state?.config),
      entries: Array.isArray(state?.entries) ? (state.entries.map(normalizeEntry).filter(Boolean) as BirthdayEntry[]) : [],
      lastAnnouncedDate: text(state?.lastAnnouncedDate, 10) || null,
      activeRoles: Array.isArray(state?.activeRoles)
        ? state.activeRoles
            .map((row: any) => ({
              userId: text(row?.userId, 64),
              until: num(row?.until, 0),
              roleId: text(row?.roleId, 64) || text(state?.config?.roleId, 64),
            }))
            .filter((row: any) => row.userId && row.until && row.roleId)
        : [],
    };
  }
  store = next;
  return store;
}

function save() {
  if (store) writeJson(BIRTHDAY_FILE, store);
}

registerDataFileHooks('birthdays.json', { reload: () => { store = null; } });

function serverState(serverId: string): ServerState {
  const loaded = load();
  return (loaded.servers[serverId] ||= {
    config: defaultBirthdayConfig(),
    entries: [],
    lastAnnouncedDate: null,
    activeRoles: [],
  });
}

/** Test hook. */
export function resetBirthdayCache() {
  store = null;
}

// ---- Date helpers ----------------------------------------------------------

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Parse a birthday. Accepts `DD/MM`, `DD-MM-YYYY`, `15 March`, `March 15`, and
 * the ISO `YYYY-MM-DD`. Day-first is the default for the ambiguous numeric
 * forms; ISO is detected by its four-digit leading year.
 */
export function parseBirthday(input: string): { month: number; day: number; year: number | null } | { error: string } {
  const raw = String(input || '').trim();
  if (!raw) return { error: 'Give a date, e.g. `15/03` or `15 March 1998`.' };

  const iso = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) return validate(Number(iso[2]), Number(iso[3]), Number(iso[1]));

  const numeric = raw.match(/^(\d{1,2})[-/. ](\d{1,2})(?:[-/. ](\d{2,4}))?$/);
  if (numeric) {
    const year = numeric[3] ? expandYear(numeric[3]) : null;
    return validate(Number(numeric[2]), Number(numeric[1]), year);
  }

  const named = raw.match(/^(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?$/i) || raw.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i);
  if (named) {
    const isDayFirst = /^\d/.test(named[1]);
    const dayToken = isDayFirst ? named[1] : named[2];
    const monthToken = isDayFirst ? named[2] : named[1];
    // At least three letters: "Ma" could be March or May.
    const token = String(monthToken).toLowerCase();
    const monthIndex = token.length >= 3 ? MONTH_NAMES.findIndex((name) => name.toLowerCase().startsWith(token.slice(0, 3))) : -1;
    if (monthIndex < 0) return { error: `\`${monthToken}\` is not a month.` };
    return validate(monthIndex + 1, Number(dayToken), named[3] ? Number(named[3]) : null);
  }

  return { error: 'Could not read that date. Try `15/03`, `15 March`, or `1998-03-15`.' };
}

/**
 * A two-digit year belongs to this century when it is not in the future
 * (`05` → 2005), and to the last one otherwise (`98` → 1998). Three digits
 * are not a year anyone means, and fail validation as written.
 */
function expandYear(token: string): number {
  if (token.length !== 2) return Number(token);
  const short = Number(token);
  const thisYear = new Date().getFullYear();
  const century = Math.floor(thisYear / 100) * 100;
  return century + short <= thisYear ? century + short : century - 100 + short;
}

function validate(month: number, day: number, year: number | null): { month: number; day: number; year: number | null } | { error: string } {
  if (!(month >= 1 && month <= 12)) return { error: 'The month must be between 1 and 12.' };
  if (!(day >= 1 && day <= DAYS_IN_MONTH[month - 1])) return { error: `${MONTH_NAMES[month - 1]} does not have ${day} days.` };
  const thisYear = new Date().getFullYear();
  if (year != null && (year < 1900 || year > thisYear)) return { error: 'That birth year is not plausible.' };
  return { month, day, year };
}

export function formatBirthday(entry: { month: number; day: number; year: number | null }): string {
  return `${entry.day} ${MONTH_NAMES[entry.month - 1]}${entry.year ? ` ${entry.year}` : ''}`;
}

/** Current date in a server's configured offset, as `{ y, m, d, hour, key }`. */
function serverNow(offsetMinutes: number, now = Date.now()) {
  const shifted = new Date(now + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return { y, m, d, hour: shifted.getUTCHours(), key: `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
}

/** True when this entry falls on the given date, folding 29 Feb onto 1 March. */
export function fallsOn(entry: { month: number; day: number }, month: number, day: number, year: number): boolean {
  if (entry.month === month && entry.day === day) return true;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  return !isLeap && entry.month === 2 && entry.day === 29 && month === 3 && day === 1;
}

function ageOn(entry: BirthdayEntry, year: number): number | null {
  return entry.year ? year - entry.year : null;
}

/**
 * Days until the next occurrence of this birthday, counted in the given UTC
 * offset so "today" matches the day the announcement fires.
 */
export function daysUntil(entry: { month: number; day: number }, now = Date.now(), offsetMinutes = 0): number {
  const today = new Date(now + offsetMinutes * 60_000);
  const year = today.getUTCFullYear();
  const target = Date.UTC(year, entry.month - 1, entry.day);
  const todayUtc = Date.UTC(year, today.getUTCMonth(), today.getUTCDate());
  const next = target >= todayUtc ? target : Date.UTC(year + 1, entry.month - 1, entry.day);
  return Math.round((next - todayUtc) / 86_400_000);
}

// ---- Config / entries ------------------------------------------------------

export function getBirthdayConfig(serverId = config.serverId || ''): BirthdayConfig {
  return { ...serverState(serverId).config };
}

export function setBirthdayConfig(patch: Partial<BirthdayConfig>, serverId = config.serverId || ''): BirthdayConfig {
  const state = serverState(serverId);
  state.config = normalizeConfig({ ...state.config, ...patch });
  save();
  return { ...state.config };
}

export function listBirthdays(serverId = config.serverId || ''): BirthdayEntry[] {
  return serverState(serverId).entries.map((entry) => ({ ...entry }));
}

/** Upcoming birthdays, soonest first. */
export function upcomingBirthdays(limit = 10, serverId = config.serverId || '', now = Date.now()) {
  const offset = serverState(serverId).config.utcOffsetMinutes;
  return listBirthdays(serverId)
    .map((entry) => ({ ...entry, inDays: daysUntil(entry, now, offset) }))
    .sort((a, b) => a.inDays - b.inDays)
    .slice(0, limit);
}

export function getBirthday(userId: string, serverId = config.serverId || ''): BirthdayEntry | null {
  return serverState(serverId).entries.find((entry) => entry.userId === userId) || null;
}

export function setBirthday(
  userId: string,
  date: { month: number; day: number; year: number | null },
  serverId = config.serverId || '',
  name?: string,
): BirthdayEntry {
  const state = serverState(serverId);
  const year = state.config.allowYear ? date.year : null;
  const existing = state.entries.find((entry) => entry.userId === userId);
  if (existing) {
    existing.month = date.month;
    existing.day = date.day;
    existing.year = year;
    existing.setAt = Date.now();
    if (name) existing.name = text(name, 80);
    save();
    return { ...existing };
  }

  const entry: BirthdayEntry = {
    userId,
    name: text(name, 80) || userId,
    month: date.month,
    day: date.day,
    year,
    setAt: Date.now(),
  };
  state.entries.push(entry);
  save();
  return { ...entry };
}

export function removeBirthday(userId: string, serverId = config.serverId || ''): boolean {
  const state = serverState(serverId);
  const next = state.entries.filter((entry) => entry.userId !== userId);
  if (next.length === state.entries.length) return false;
  state.entries = next;
  save();
  return true;
}

// ---- Announcing ------------------------------------------------------------

function renderMessage(template: string, ctx: { userId: string; name: string; age: number | null; serverName: string }): string {
  return String(template || DEFAULT_MESSAGE)
    .replace(/\{mention\}/g, `<@${ctx.userId}>`)
    .replace(/\{user\}/g, neutraliseMentions(ctx.name))
    .replace(/\{age\}/g, ctx.age == null ? '' : String(ctx.age))
    .replace(/\{server\}/g, ctx.serverName)
    .trim();
}

/**
 * Announce today's birthdays for one server, if it is the right hour and they
 * have not been announced yet today. Returns how many were announced.
 */
export async function runBirthdaysForServer(
  client: any,
  serverId: string,
  now = Date.now(),
  options: { force?: boolean } = {},
): Promise<number> {
  const state = serverState(serverId);
  const cfg = state.config;
  if (!cfg.channelId) return 0;
  // `force` is the `birthday test` path: it ignores the hour and the
  // already-announced marker, but still sets the marker, because it really did
  // announce today's birthdays.
  if (!options.force) {
    if (!cfg.enabled) return 0;
    const clock = serverNow(cfg.utcOffsetMinutes, now);
    if (clock.hour < cfg.announceHour) return 0;
    if (state.lastAnnouncedDate === clock.key) return 0;
  }

  const today = serverNow(cfg.utcOffsetMinutes, now);

  // Mark the day first: a send that fails must not queue a retry storm on the
  // next tick ten minutes later.
  state.lastAnnouncedDate = today.key;
  save();

  const dueToday = state.entries.filter((entry) => fallsOn(entry, today.m, today.d, today.y));
  if (!dueToday.length) return 0;

  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  const serverName = String(server?.name || 'the server');

  // Members who have left keep their saved date (they may come back) but are
  // not congratulated. When nobody can be looked up at all, the API is the
  // likelier problem, so everyone due is announced rather than no one.
  const members = new Map<string, any>();
  for (const entry of dueToday) {
    const member =
      server?.members?.cache?.get?.(entry.userId) || (await server?.members?.fetch?.(entry.userId).catch(() => null));
    if (member) members.set(entry.userId, member);
  }
  const celebrating = server && members.size ? dueToday.filter((entry) => members.has(entry.userId)) : dueToday;
  if (!celebrating.length) return 0;

  const lines = celebrating.map((entry) => {
    const age = ageOn(entry, today.y);
    return renderMessage(cfg.message, { userId: entry.userId, name: entry.name, age, serverName });
  });

  try {
    const channel =
      client?.channels?.cache?.get?.(cfg.channelId) || (await client?.channels?.fetch?.(cfg.channelId).catch(() => null));
    if (channel?.send) {
      const embed = safeEmbed({
        title: celebrating.length === 1 ? '🎂 Birthday today' : `🎂 ${celebrating.length} birthdays today`,
        description: clampText(lines.join('\n'), EMBED_DESCRIPTION_MAX),
        color: '#f472b6',
      });
      const pings = clampText(celebrating.map((entry) => `<@${entry.userId}>`).join(' '), MESSAGE_CONTENT_MAX - 100);
      await channel.send({ content: pings, embeds: [embed] });
    }
  } catch (error) {
    debug('birthdays', () => `announcement failed: ${(error as Error)?.message || error}`);
  }

  if (cfg.roleId) {
    for (const entry of celebrating) {
      try {
        const member = members.get(entry.userId);
        if (member?.addRole) {
          await member.addRole(cfg.roleId);
          // One row per member: a repeated `birthday test` extends the day
          // rather than queueing a second removal.
          state.activeRoles = state.activeRoles.filter((row) => row.userId !== entry.userId);
          state.activeRoles.push({ userId: entry.userId, until: now + 86_400_000, roleId: cfg.roleId });
        }
      } catch (error) {
        debug('birthdays', () => `role grant failed for ${entry.userId}: ${(error as Error)?.message || error}`);
      }
    }
    save();
  }

  recordAudit({
    serverId,
    actorId: '',
    actorName: 'Birthdays',
    source: 'automation',
    area: 'birthdays',
    action: 'announce',
    detail: `${celebrating.length} birthday(s)`,
  });

  return celebrating.length;
}

/** Take back birthday roles whose day is over. */
async function expireBirthdayRoles(client: any, serverId: string, now: number): Promise<void> {
  const state = serverState(serverId);
  // Runs even when the role setting has since been cleared: each row carries
  // the role it granted.
  if (!state.activeRoles.length) return;

  const due = state.activeRoles.filter((row) => row.until <= now);
  if (!due.length) return;

  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  for (const row of due) {
    try {
      const member = await server?.members?.fetch?.(row.userId).catch(() => server?.members?.cache?.get?.(row.userId) || null);
      if (member?.removeRole) await member.removeRole(row.roleId);
    } catch (error) {
      debug('birthdays', () => `role removal failed for ${row.userId}: ${(error as Error)?.message || error}`);
    }
  }
  state.activeRoles = state.activeRoles.filter((row) => row.until > now);
  save();
}

// ---- Scheduler -------------------------------------------------------------

export function startBirthdayScheduler(client: any) {
  clientRef = client;
  if (timer) return;
  console.log(`[birthdays] Scheduler started (tick ${TICK_MS / 60000}m).`);
  timer = setInterval(() => {
    void runBirthdayTick().catch((error) => console.error('[birthdays] tick failed:', error));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
  // Run once shortly after start so a restart during the announcement hour
  // still posts today's birthdays.
  setTimeout(() => void runBirthdayTick().catch(() => {}), 10_000).unref?.();
}

/** Whether the tick is armed, for the ops health panel. */
export function isBirthdaySchedulerRunning(): boolean {
  return timer !== null;
}

export function stopBirthdayScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  clientRef = null;
}

export async function runBirthdayTick(now = Date.now()): Promise<number> {
  if (ticking || !clientRef) return 0;
  ticking = true;
  let announced = 0;
  try {
    const loaded = load();
    for (const serverId of Object.keys(loaded.servers)) {
      await expireBirthdayRoles(clientRef, serverId, now);
      announced += await runBirthdaysForServer(clientRef, serverId, now);
    }
  } finally {
    ticking = false;
  }
  return announced;
}

export function getBirthdaySummary(serverId = config.serverId || '') {
  const state = serverState(serverId);
  const next = upcomingBirthdays(1, serverId)[0] || null;
  return {
    enabled: state.config.enabled,
    registered: state.entries.length,
    next: next ? { name: next.name, date: formatBirthday(next), inDays: next.inDays } : null,
  };
}
