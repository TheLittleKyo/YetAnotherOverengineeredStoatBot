/**
 * Runtime health — what the bot has been doing since it started.
 *
 * Everything here is in-memory and deliberately not persisted: this answers
 * "is it healthy *right now*", and a counter that survived the restart would
 * blur the one question it exists to answer. Long-term trends are the
 * analytics module's job.
 *
 * Tracked: gateway events by type, commands run, client errors (with the last
 * few messages), rate limits, websocket reconnects, and the registered
 * schedulers with whether each is currently running. The ops dashboard reads
 * `getHealthSnapshot()`; `!ping` shows the same numbers in chat.
 */

const MAX_RECENT_ERRORS = 15;

type ErrorSample = { at: number; message: string; count: number };

type SchedulerEntry = { name: string; isRunning: () => boolean; isEnabled?: () => boolean };

const startedAt = Date.now();

const eventCounts = new Map<string, number>();
const commandCounts = new Map<string, number>();
const recentErrors: ErrorSample[] = [];
const schedulers: SchedulerEntry[] = [];

/**
 * Rolling one-minute counter: sixty one-second buckets. Recording is O(1) no
 * matter how busy the gateway is, which matters because every raw packet
 * lands here.
 */
class MinuteRate {
  private counts = new Array<number>(60).fill(0);
  private seconds = new Array<number>(60).fill(-1);

  hit(now: number) {
    const second = Math.floor(now / 1000);
    const slot = second % 60;
    if (this.seconds[slot] !== second) {
      this.seconds[slot] = second;
      this.counts[slot] = 0;
    }
    this.counts[slot]++;
  }

  total(now: number): number {
    const current = Math.floor(now / 1000);
    let sum = 0;
    for (let slot = 0; slot < 60; slot++) {
      if (current - this.seconds[slot] < 60) sum += this.counts[slot];
    }
    return sum;
  }

  reset() {
    this.counts.fill(0);
    this.seconds.fill(-1);
  }
}

const eventRate = new MinuteRate();
const commandRate = new MinuteRate();

let rateLimitHits = 0;
let lastRateLimitAt = 0;
let reconnects = 0;
let lastReconnectAt = 0;
let totalEvents = 0;
let totalCommands = 0;
let totalErrors = 0;

/** Count one gateway packet. Called for every raw event, so it stays cheap. */
export function recordEvent(type: string): void {
  const key = String(type || 'unknown').slice(0, 40);
  eventCounts.set(key, (eventCounts.get(key) || 0) + 1);
  totalEvents++;
  eventRate.hit(Date.now());
}

export function recordCommand(name: string): void {
  const key = String(name || 'unknown').slice(0, 40);
  commandCounts.set(key, (commandCounts.get(key) || 0) + 1);
  totalCommands++;
  commandRate.hit(Date.now());
}

/**
 * Record a client error. Repeats of the same message bump a counter on the
 * existing sample instead of pushing a new one, so one flapping error cannot
 * push everything else out of the list.
 */
export function recordError(message: unknown): void {
  totalErrors++;
  const text = String((message as any)?.message || message || 'Unknown error').slice(0, 300);
  // Counted before the de-duplication below: every 429 is its own rate limit,
  // even when the message text repeats.
  if (/\b429\b|rate.?limit/i.test(text)) recordRateLimit();

  const existing = recentErrors.find((entry) => entry.message === text);
  if (existing) {
    existing.count++;
    existing.at = Date.now();
    return;
  }
  recentErrors.push({ at: Date.now(), message: text, count: 1 });
  if (recentErrors.length > MAX_RECENT_ERRORS) recentErrors.shift();
}

export function recordRateLimit(): void {
  rateLimitHits++;
  lastRateLimitAt = Date.now();
}

export function recordReconnect(): void {
  reconnects++;
  lastReconnectAt = Date.now();
}

/**
 * Register a background scheduler so the dashboard can show whether it is
 * actually running, rather than assuming it started. `isEnabled` reports
 * whether its module is switched on: a switched-off scheduler is meant to be
 * stopped, so it shows as off rather than as a failure.
 */
export function registerScheduler(name: string, isRunning: () => boolean, isEnabled?: () => boolean): void {
  const key = String(name || '').trim();
  if (!key) return;
  const existing = schedulers.find((entry) => entry.name === key);
  if (existing) {
    existing.isRunning = isRunning;
    existing.isEnabled = isEnabled;
  } else {
    schedulers.push({ name: key, isRunning, isEnabled });
  }
}

export type HealthSnapshot = {
  startedAt: number;
  uptimeMs: number;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  nodeVersion: string;
  events: { total: number; perMinute: number; top: { type: string; count: number }[] };
  commands: { total: number; perMinute: number; top: { name: string; count: number }[] };
  errors: { total: number; recent: ErrorSample[] };
  rateLimits: { hits: number; lastAt: number | null };
  reconnects: { count: number; lastAt: number | null };
  schedulers: { name: string; running: boolean; enabled: boolean }[];
};

export function getHealthSnapshot(): HealthSnapshot {
  const now = Date.now();
  const memory = process.memoryUsage();
  const mb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

  const top = (map: Map<string, number>) =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);

  return {
    startedAt,
    uptimeMs: now - startedAt,
    memory: { rssMb: mb(memory.rss), heapUsedMb: mb(memory.heapUsed), heapTotalMb: mb(memory.heapTotal) },
    nodeVersion: process.version,
    events: {
      total: totalEvents,
      perMinute: eventRate.total(now),
      top: top(eventCounts).map(([type, count]) => ({ type, count })),
    },
    commands: {
      total: totalCommands,
      perMinute: commandRate.total(now),
      top: top(commandCounts).map(([name, count]) => ({ name, count })),
    },
    errors: { total: totalErrors, recent: [...recentErrors].sort((a, b) => b.at - a.at) },
    rateLimits: { hits: rateLimitHits, lastAt: lastRateLimitAt || null },
    reconnects: { count: reconnects, lastAt: lastReconnectAt || null },
    schedulers: schedulers.map((entry) => {
      let running = false;
      let enabled = true;
      try {
        running = entry.isRunning() === true;
        enabled = entry.isEnabled ? entry.isEnabled() === true : true;
      } catch {
        running = false;
      }
      return { name: entry.name, running, enabled };
    }),
  };
}

/** Test hook: clear every counter. */
export function resetHealth(): void {
  eventCounts.clear();
  commandCounts.clear();
  recentErrors.length = 0;
  schedulers.length = 0;
  eventRate.reset();
  commandRate.reset();
  rateLimitHits = 0;
  lastRateLimitAt = 0;
  reconnects = 0;
  lastReconnectAt = 0;
  totalEvents = 0;
  totalCommands = 0;
  totalErrors = 0;
}
