/**
 * Human duration parsing and formatting, shared by every feature that takes a
 * "how long" argument in chat or in the dashboard: mutes and temp bans
 * (moderation), automod timeouts, poll and giveaway runtimes, and the economy
 * cooldowns.
 *
 * The accepted forms are the ones people actually type next to a command:
 *
 *   10m        90s       2h30m      1d12h      1w
 *   10 minutes            2 hours    1 day
 *   permanent / perm / forever / 0   → null (no expiry)
 *
 * `parseDuration` returns milliseconds, `null` for an explicit "no expiry", and
 * `undefined` when the text is not a duration at all — three distinct answers,
 * because "ban forever" and "that argument was not a duration" must not be
 * confused by the caller.
 */

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

const UNIT_ALIASES: Record<string, keyof typeof UNIT_MS> = {
  s: 's', sec: 's', secs: 's', second: 's', seconds: 's',
  m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
};

const PERMANENT = new Set(['permanent', 'perm', 'forever', 'never', 'infinite', 'inf', '0']);

/** Longest duration any feature may set, so a typo cannot schedule work in the year 40000. */
export const MAX_DURATION_MS = 365 * UNIT_MS.d;

/**
 * Parse a duration.
 *
 * @returns milliseconds, `null` for "no expiry", or `undefined` when the input
 *          is not a duration.
 */
export function parseDuration(input: unknown): number | null | undefined {
  const text = String(input ?? '').trim().toLowerCase();
  if (!text) return undefined;
  if (PERMANENT.has(text)) return null;

  // "2h30m", "1d 12h", "90 seconds" — sum every <number><unit> pair, and refuse
  // anything with leftover text so "ban spamming" is not read as a duration.
  const pattern = /(\d+(?:\.\d+)?)\s*([a-z]+)/g;
  let total = 0;
  let matched = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const unit = UNIT_ALIASES[match[2]];
    if (!unit) return undefined;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value < 0) return undefined;
    total += value * UNIT_MS[unit];
    matched++;
    // Count only the non-space characters of the pair, so the space inside
    // "10 m" cannot make up for an unparsed "x" elsewhere.
    consumed += match[0].replace(/\s+/g, '').length;
  }
  if (!matched) return undefined;
  // Every non-space character must have been part of a number/unit pair.
  if (consumed < text.replace(/\s+/g, '').length) return undefined;
  if (total <= 0) return null;
  return Math.min(Math.round(total), MAX_DURATION_MS);
}

/**
 * `parseDuration` for places that must have a number: returns `fallback` for
 * both "no expiry" and unparseable input.
 */
export function parseDurationOr(input: unknown, fallback: number): number {
  const parsed = parseDuration(input);
  return typeof parsed === 'number' ? parsed : fallback;
}

/** `2d 3h`, `45m`, `30s` — the two largest non-zero units, never more. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return 'permanent';
  const total = Math.max(0, Math.round(Number(ms) || 0));
  if (total < 1000) return 'a moment';

  const parts: string[] = [];
  let rest = total;
  for (const [unit, size] of [['w', UNIT_MS.w], ['d', UNIT_MS.d], ['h', UNIT_MS.h], ['m', UNIT_MS.m], ['s', UNIT_MS.s]] as const) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count}${unit}`);
      rest -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.join(' ') || 'a moment';
}

/** `in 2d 3h` / `2d 3h ago` / `now`, for "expires"/"created" lines. */
export function formatRelative(timestamp: number | null | undefined, now = Date.now()): string {
  if (timestamp == null) return 'never';
  const delta = timestamp - now;
  if (Math.abs(delta) < 1000) return 'now';
  return delta > 0 ? `in ${formatDuration(delta)}` : `${formatDuration(-delta)} ago`;
}
