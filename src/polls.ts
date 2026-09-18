/**
 * Polls — reaction-counted votes with an optional closing time.
 *
 * Votes are tracked by the bot rather than read back off the message's reaction
 * counts. Stoat reports reaction totals, not who reacted, so counting them
 * would make "one vote per member" and "change your vote" impossible, and would
 * silently include the bot's own seed reactions. Keeping a `optionIndex →
 * userIds` map costs one small JSON file and makes single-choice polls behave:
 * reacting to a second option in a single-choice poll moves the vote instead of
 * adding one.
 *
 * A poll ends when its timer elapses (scheduler tick) or when someone closes it
 * by hand. Closing posts the results, and the poll stays in the file so the
 * dashboard can show past results until it is deleted.
 *
 * Storage: `data/polls.json`.
 */

import { config } from './config.js';
import { createArrayFileStore, dataFile } from './json-store.js';
import { formatDuration, MAX_DURATION_MS } from './duration.js';
import { recordAudit, type AuditSource } from './audit.js';
import { clampText, EMBED_DESCRIPTION_MAX, safeEmbed } from './embed-limits.js';
import { debug } from './logger.js';

/** Vote emoji, in option order. Ten options is the practical ceiling. */
export const POLL_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];

/** Shorthand poll with no options given. */
export const YES_NO_EMOJI = ['👍', '👎'];

export const MAX_OPTIONS = POLL_EMOJI.length;

export type Poll = {
  id: string;
  serverId: string;
  channelId: string;
  messageId: string;
  question: string;
  options: string[];
  /** Emoji actually used, so a yes/no poll and a numbered poll both work. */
  emoji: string[];
  /** Allow voting for several options at once. */
  multi: boolean;
  /** Hide who voted for what in the results. */
  anonymous: boolean;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  endsAt: number | null;
  closed: boolean;
  closedAt: number | null;
  /** optionIndex → voter ids. */
  votes: Record<string, string[]>;
};

const store = createArrayFileStore<Poll>(dataFile('polls.json'), 'polls', 'polls');

const TICK_MS = 15_000;
let timer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let ticking = false;

function generateId(): string {
  return `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export function listPolls(serverId?: string, options: { openOnly?: boolean } = {}): Poll[] {
  return store
    .read()
    .filter((poll) => (!serverId || poll.serverId === serverId) && (!options.openOnly || !poll.closed))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getPoll(id: string): Poll | null {
  return store.read().find((poll) => poll.id === id) || null;
}

export function getPollByMessage(messageId: string): Poll | null {
  return store.read().find((poll) => poll.messageId === messageId) || null;
}

export function deletePoll(id: string): boolean {
  const polls = store.read();
  const next = polls.filter((poll) => poll.id !== id);
  if (next.length === polls.length) return false;
  store.write(next);
  return true;
}

function persist(poll: Poll) {
  const polls = store.read();
  const index = polls.findIndex((entry) => entry.id === poll.id);
  if (index < 0) polls.push(poll);
  else polls[index] = poll;
  store.write(polls);
}

export type CreatePollInput = {
  serverId: string;
  channelId: string;
  question: string;
  options?: string[];
  multi?: boolean;
  anonymous?: boolean;
  durationMs?: number | null;
  createdBy: string;
  createdByName?: string;
  /** Where the poll was started, for the audit log. */
  source?: AuditSource;
};

export type CreatePollResult = { ok: boolean; poll?: Poll; error?: string };

/**
 * Post a poll message, seed its vote reactions, and start tracking it.
 */
export async function createPoll(client: any, input: CreatePollInput): Promise<CreatePollResult> {
  const question = text(input.question, 400);
  if (!question) return { ok: false, error: 'A question is required.' };

  const rawOptions = (input.options || []).map((option) => text(option, 120)).filter(Boolean);
  if (rawOptions.length === 1) return { ok: false, error: 'Give at least two options, or none for a yes/no poll.' };
  if (rawOptions.length > MAX_OPTIONS) return { ok: false, error: `A poll can have at most ${MAX_OPTIONS} options.` };

  const options = rawOptions.length ? rawOptions : ['Yes', 'No'];
  const emoji = rawOptions.length ? POLL_EMOJI.slice(0, options.length) : YES_NO_EMOJI;

  const channel =
    client?.channels?.cache?.get?.(input.channelId) || (await client?.channels?.fetch?.(input.channelId).catch(() => null));
  if (!channel || typeof channel.send !== 'function') return { ok: false, error: `Could not find channel ${input.channelId}.` };

  const durationMs = Number(input.durationMs);
  const endsAt = Number.isFinite(durationMs) && durationMs > 0 ? Date.now() + Math.min(durationMs, MAX_DURATION_MS) : null;
  const poll: Poll = {
    id: generateId(),
    serverId: String(input.serverId || ''),
    channelId: String(input.channelId || ''),
    messageId: '',
    question,
    options,
    emoji,
    multi: input.multi === true,
    anonymous: input.anonymous === true,
    createdBy: String(input.createdBy || ''),
    createdByName: text(input.createdByName, 80) || 'Unknown',
    createdAt: Date.now(),
    endsAt,
    closed: false,
    closedAt: null,
    votes: {},
  };

  let sent: any;
  try {
    sent = await channel.send({ embeds: [buildPollEmbed(poll)] });
  } catch (error: any) {
    return { ok: false, error: `Could not post the poll: ${error?.message || error}` };
  }

  poll.messageId = String(sent?.id || sent?._id || '');
  persist(poll);

  for (const icon of poll.emoji) {
    try {
      await sent.addReaction?.(icon);
    } catch (error) {
      debug('polls', () => `seed reaction ${icon} failed: ${(error as Error)?.message || error}`);
    }
  }

  recordAudit({
    serverId: poll.serverId,
    actorId: poll.createdBy,
    actorName: poll.createdByName,
    source: input.source || 'command',
    area: 'polls',
    action: 'create',
    detail: question.slice(0, 120),
  });

  return { ok: true, poll };
}

function buildPollEmbed(poll: Poll) {
  const total = countVotes(poll).total;
  const lines = poll.options.map((option, index) => {
    const votes = poll.votes[String(index)]?.length || 0;
    const share = total ? Math.round((votes / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(share / 10)).padEnd(10, '░');
    return `${poll.emoji[index]} **${option}**\n\`${bar}\` ${votes} vote${votes === 1 ? '' : 's'} · ${share}%`;
  });

  const footer: string[] = [];
  footer.push(poll.multi ? 'Multiple choice' : 'Single choice');
  if (poll.endsAt && !poll.closed) footer.push(`ends in ${formatDuration(poll.endsAt - Date.now())}`);
  if (poll.closed) footer.push('closed');
  footer.push(`${total} vote${total === 1 ? '' : 's'}`);

  // The question goes in the description as a heading: embed titles stop at 100
  // characters, and a question may be up to 400. The option lines are clamped
  // so the footer (tally and closing time) always survives.
  const footerLine = `*${footer.join(' · ')}*`;
  const heading = `### ${poll.question}`;
  const room = EMBED_DESCRIPTION_MAX - heading.length - footerLine.length - 4;
  const body = clampText(lines.join('\n\n'), Math.max(200, room));

  return safeEmbed({
    title: poll.closed ? '📊 Poll closed' : '📊 Poll',
    description: `${heading}\n${body}\n\n${footerLine}`,
    color: poll.closed ? '#64748b' : '#6366f1',
  });
}

async function editPollMessage(client: any, poll: Poll): Promise<void> {
  try {
    const channel =
      client?.channels?.cache?.get?.(poll.channelId) || (await client?.channels?.fetch?.(poll.channelId).catch(() => null));
    const message = await channel?.messages?.fetch?.(poll.messageId).catch(() => null);
    if (message?.edit) await message.edit({ embeds: [buildPollEmbed(poll)] });
  } catch (error) {
    debug('polls', () => `poll message refresh failed: ${(error as Error)?.message || error}`);
  }
}

// A busy poll gets many votes a second; editing the message for each one would
// run straight into the rate limit. Edits are coalesced per poll instead.
const REFRESH_DEBOUNCE_MS = 1500;
const pendingRefresh = new Map<string, NodeJS.Timeout>();

function scheduleRefresh(client: any, poll: Poll): void {
  if (pendingRefresh.has(poll.id)) return;
  const timer = setTimeout(() => {
    pendingRefresh.delete(poll.id);
    const current = getPoll(poll.id);
    if (current) void editPollMessage(client, current);
  }, REFRESH_DEBOUNCE_MS);
  timer.unref?.();
  pendingRefresh.set(poll.id, timer);
}

/** Edit the message now, dropping any queued edit (used when a poll closes). */
async function refreshPollMessageNow(client: any, poll: Poll): Promise<void> {
  const queued = pendingRefresh.get(poll.id);
  if (queued) {
    clearTimeout(queued);
    pendingRefresh.delete(poll.id);
  }
  await editPollMessage(client, poll);
}

export function countVotes(poll: Poll): { total: number; perOption: number[] } {
  const perOption = poll.options.map((_, index) => poll.votes[String(index)]?.length || 0);
  // A multi-choice poll counts ballots, not voters, so the percentages add up.
  const total = perOption.reduce((sum, count) => sum + count, 0);
  return { total, perOption };
}

// ---- Reaction handling -----------------------------------------------------

type ReactionContext = { client: any; messageId: any; userId: any; emoji: any };

/**
 * Emoji compare without their variation selectors: a client may send `1⃣`
 * for the `1️⃣` the bot seeded, and the two must count as the same vote.
 */
function sameEmoji(a: string, b: string): boolean {
  const strip = (value: string) => String(value || '').replace(/\uFE0F/g, '');
  return strip(a) === strip(b);
}

function optionIndex(poll: Poll, emoji: string): number {
  return poll.emoji.findIndex((entry) => sameEmoji(entry, emoji));
}

/** A vote arriving as a reaction. Returns true when the message was a poll. */
export async function handlePollReaction(ctx: ReactionContext): Promise<boolean> {
  const messageId = String(ctx.messageId || '');
  const userId = String(ctx.userId || '');
  const emoji = String(ctx.emoji || '');
  if (!messageId || !userId) return false;

  const poll = getPollByMessage(messageId);
  if (!poll) return false;
  if (userId === ctx.client?.user?.id) return true;
  if (poll.closed) return true;

  const index = optionIndex(poll, emoji);
  if (index < 0) return true;

  // Every change to the tally happens before the first await, so two votes
  // arriving together cannot interleave and lose one of them.
  const key = String(index);
  const current = poll.votes[key] || [];
  if (!current.includes(userId)) current.push(userId);
  poll.votes[key] = current;

  // Single choice: the newest reaction wins, and the old one is dropped (and
  // its reaction removed so the message still reflects the real tally).
  const replaced: string[] = [];
  if (!poll.multi) {
    for (const [otherKey, voters] of Object.entries(poll.votes)) {
      if (otherKey === key || !voters.includes(userId)) continue;
      poll.votes[otherKey] = voters.filter((id) => id !== userId);
      replaced.push(poll.emoji[Number(otherKey)]);
    }
  }
  persist(poll);

  for (const icon of replaced) await removeReaction(ctx.client, poll, userId, icon);
  scheduleRefresh(ctx.client, poll);
  return true;
}

/** Un-reacting withdraws the vote. */
export async function handlePollUnreaction(ctx: ReactionContext): Promise<boolean> {
  const messageId = String(ctx.messageId || '');
  const userId = String(ctx.userId || '');
  const emoji = String(ctx.emoji || '');
  if (!messageId || !userId) return false;

  const poll = getPollByMessage(messageId);
  if (!poll) return false;
  if (poll.closed) return true;

  const index = optionIndex(poll, emoji);
  if (index < 0) return true;

  const key = String(index);
  const voters = poll.votes[key] || [];
  if (!voters.includes(userId)) return true;
  poll.votes[key] = voters.filter((id) => id !== userId);

  persist(poll);
  scheduleRefresh(ctx.client, poll);
  return true;
}

async function removeReaction(client: any, poll: Poll, userId: string, emoji: string): Promise<void> {
  if (!emoji) return;
  try {
    const channel =
      client?.channels?.cache?.get?.(poll.channelId) || (await client?.channels?.fetch?.(poll.channelId).catch(() => null));
    const message = await channel?.messages?.fetch?.(poll.messageId).catch(() => null);
    // `removeReaction` takes the target user in an options object; without it
    // the bot would clear its own seed reaction instead of the member's vote.
    if (typeof message?.removeReaction === 'function') {
      await message.removeReaction(emoji, { user_id: userId });
    }
  } catch (error) {
    debug('polls', () => `reaction removal failed: ${(error as Error)?.message || error}`);
  }
}

// ---- Closing ---------------------------------------------------------------

export type ClosePollResult = { ok: boolean; poll?: Poll; error?: string };

export async function closePoll(
  client: any,
  id: string,
  closedBy = '',
  options: { source?: AuditSource; actorName?: string } = {},
): Promise<ClosePollResult> {
  const poll = getPoll(id);
  if (!poll) return { ok: false, error: 'No poll with that id.' };
  if (poll.closed) return { ok: false, error: 'That poll is already closed.' };

  poll.closed = true;
  poll.closedAt = Date.now();
  poll.endsAt = poll.endsAt ?? Date.now();
  persist(poll);

  await refreshPollMessageNow(client, poll);
  await postResults(client, poll);

  recordAudit({
    serverId: poll.serverId,
    actorId: closedBy,
    actorName: options.actorName,
    source: options.source || (closedBy ? 'command' : 'automation'),
    area: 'polls',
    action: 'close',
    detail: poll.question.slice(0, 120),
  });

  return { ok: true, poll };
}

async function postResults(client: any, poll: Poll): Promise<void> {
  const { total, perOption } = countVotes(poll);
  const ranked = poll.options
    .map((option, index) => ({ option, index, votes: perOption[index] }))
    .sort((a, b) => b.votes - a.votes);
  const topVotes = ranked[0]?.votes || 0;
  const winners = ranked.filter((row) => row.votes === topVotes && topVotes > 0);

  const lines = ranked.map((row) => {
    const share = total ? Math.round((row.votes / total) * 100) : 0;
    const marker = topVotes > 0 && row.votes === topVotes ? '🏆 ' : '';
    const voters = poll.anonymous || !poll.votes[String(row.index)]?.length
      ? ''
      : `\n  ${poll.votes[String(row.index)].slice(0, 15).map((id) => `<@${id}>`).join(' ')}`;
    return `${marker}${poll.emoji[row.index]} **${row.option}** — ${row.votes} (${share}%)${voters}`;
  });

  const outcome = total === 0
    ? 'Nobody voted.'
    : winners.length > 1
      ? `Tied: ${winners.map((row) => row.option).join(', ')}`
      : `Winner: **${winners[0].option}**`;

  try {
    const channel =
      client?.channels?.cache?.get?.(poll.channelId) || (await client?.channels?.fetch?.(poll.channelId).catch(() => null));
    if (!channel?.send) return;
    const summary = `${outcome}\n*${total} vote${total === 1 ? '' : 's'} · ran for ${formatDuration(Date.now() - poll.createdAt)}*`;
    const heading = `### ${poll.question}`;
    // Voter lists can be long; they are what gets cut, never the outcome.
    const room = EMBED_DESCRIPTION_MAX - heading.length - summary.length - 4;
    const embed = safeEmbed({
      title: '📊 Poll results',
      description: `${heading}\n${clampText(lines.join('\n'), Math.max(200, room))}\n\n${summary}`,
      color: '#22c55e',
    });
    await channel.send({ embeds: [embed] });
  } catch (error) {
    debug('polls', () => `results post failed: ${(error as Error)?.message || error}`);
  }
}

// ---- Scheduler -------------------------------------------------------------

export function startPollScheduler(client: any) {
  clientRef = client;
  if (timer) return;
  console.log(`[polls] Scheduler started (tick ${TICK_MS / 1000}s).`);
  timer = setInterval(() => {
    void closeDuePolls().catch((error) => console.error('[polls] tick failed:', error));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Whether the tick is armed, for the ops health panel. */
export function isPollSchedulerRunning(): boolean {
  return timer !== null;
}

export function stopPollScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  clientRef = null;
}

/** Close every poll whose timer has elapsed. Safe to call repeatedly. */
export async function closeDuePolls(now = Date.now()): Promise<number> {
  if (ticking || !clientRef) return 0;
  ticking = true;
  let closed = 0;
  try {
    const due = store.read().filter((poll) => !poll.closed && poll.endsAt != null && poll.endsAt <= now);
    for (const poll of due) {
      const result = await closePoll(clientRef, poll.id);
      if (result.ok) closed++;
    }
  } finally {
    ticking = false;
  }
  return closed;
}

export function getPollSummary(serverId = config.serverId || '') {
  const polls = listPolls(serverId);
  return {
    total: polls.length,
    open: polls.filter((poll) => !poll.closed).length,
    votes: polls.reduce((sum, poll) => sum + countVotes(poll).total, 0),
  };
}
