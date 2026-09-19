/**
 * Hosted giveaways — the server runs its own draw, as opposed to the Free Stuff
 * feed in `src/giveaways/`, which reposts other people's promotions. The two
 * are kept apart on purpose: one is a scheduled scraper, this one owns entries,
 * eligibility and winners.
 *
 * Entry is a 🎉 reaction. Eligibility is checked at entry time so a member is
 * told immediately rather than silently losing at the draw; their reaction is
 * removed so the message keeps showing the real entrant count. Requirements can
 * combine a leveling level, required roles, and a minimum account age.
 *
 * Bonus roles add extra weight: a role worth 3 entries means that member's id
 * appears three times in the draw pool. Weighting never lets one person win
 * twice in a multi-winner draw — winners are drawn without replacement.
 *
 * Storage: `data/hosted-giveaways.json`.
 */

import { config } from './config.js';
import { createArrayFileStore, dataFile } from './json-store.js';
import { formatDuration, MAX_DURATION_MS } from './duration.js';
import { getUserRank } from './leveling.js';
import { getRoleIds } from './member-utils.js';
import { recordAudit, type AuditSource } from './audit.js';
import { clampText, EMBED_DESCRIPTION_MAX, safeEmbed } from './embed-limits.js';
import { debug } from './logger.js';
import { sendDirectMessage } from './dm.js';

export const GIVEAWAY_EMOJI = '🎉';

export type GiveawayRequirements = {
  /** Minimum leveling level, 0 for none. */
  minLevel: number;
  /** Member must hold every one of these roles. */
  requiredRoleIds: string[];
  /** Account must be at least this old, 0 for none. */
  minAccountAgeDays: number;
};

export type BonusRole = { roleId: string; entries: number };

export type Giveaway = {
  id: string;
  serverId: string;
  channelId: string;
  messageId: string;
  prize: string;
  description: string;
  winnerCount: number;
  hostId: string;
  hostName: string;
  createdAt: number;
  endsAt: number;
  ended: boolean;
  endedAt: number | null;
  entries: string[];
  winners: string[];
  requirements: GiveawayRequirements;
  bonusRoles: BonusRole[];
};

const store = createArrayFileStore<Giveaway>(dataFile('hosted-giveaways.json'), 'giveaways', 'hosted giveaways');

const TICK_MS = 15_000;
let timer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let ticking = false;

function generateId(): string {
  return `gw_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

export function defaultRequirements(): GiveawayRequirements {
  return { minLevel: 0, requiredRoleIds: [], minAccountAgeDays: 0 };
}

function normalizeRequirements(value: Partial<GiveawayRequirements> | undefined): GiveawayRequirements {
  const base = defaultRequirements();
  if (!value) return base;
  return {
    minLevel: Math.min(1000, Math.max(0, Math.floor(Number(value.minLevel) || 0))),
    requiredRoleIds: Array.from(new Set((value.requiredRoleIds || []).map((id) => text(id, 64)).filter(Boolean))).slice(0, 10),
    minAccountAgeDays: Math.min(3650, Math.max(0, Math.floor(Number(value.minAccountAgeDays) || 0))),
  };
}

export function listGiveaways(serverId?: string, options: { activeOnly?: boolean } = {}): Giveaway[] {
  return store
    .read()
    .filter((entry) => (!serverId || entry.serverId === serverId) && (!options.activeOnly || !entry.ended))
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function getGiveaway(id: string): Giveaway | null {
  return store.read().find((entry) => entry.id === id) || null;
}

export function getGiveawayByMessage(messageId: string): Giveaway | null {
  return store.read().find((entry) => entry.messageId === messageId) || null;
}

export function deleteGiveaway(id: string): boolean {
  const all = store.read();
  const next = all.filter((entry) => entry.id !== id);
  if (next.length === all.length) return false;
  store.write(next);
  return true;
}

function persist(giveaway: Giveaway) {
  const all = store.read();
  const index = all.findIndex((entry) => entry.id === giveaway.id);
  if (index < 0) all.push(giveaway);
  else all[index] = giveaway;
  store.write(all);
}

// ---- Creation --------------------------------------------------------------

export type CreateGiveawayInput = {
  serverId: string;
  channelId: string;
  prize: string;
  description?: string;
  winnerCount?: number;
  durationMs: number;
  hostId: string;
  hostName?: string;
  requirements?: Partial<GiveawayRequirements>;
  bonusRoles?: BonusRole[];
  /** Where the giveaway was started, for the audit log. */
  source?: AuditSource;
};

export type CreateGiveawayResult = { ok: boolean; giveaway?: Giveaway; error?: string };

export async function createGiveaway(client: any, input: CreateGiveawayInput): Promise<CreateGiveawayResult> {
  const prize = text(input.prize, 200);
  if (!prize) return { ok: false, error: 'A prize is required.' };
  const durationMs = Math.min(Number(input.durationMs), MAX_DURATION_MS);
  if (!(durationMs > 0)) return { ok: false, error: 'Give the giveaway a duration, e.g. `1h`.' };

  const channel =
    client?.channels?.cache?.get?.(input.channelId) || (await client?.channels?.fetch?.(input.channelId).catch(() => null));
  if (!channel || typeof channel.send !== 'function') return { ok: false, error: `Could not find channel ${input.channelId}.` };

  const giveaway: Giveaway = {
    id: generateId(),
    serverId: String(input.serverId || ''),
    channelId: String(input.channelId || ''),
    messageId: '',
    prize,
    description: text(input.description, 800),
    winnerCount: Math.min(20, Math.max(1, Math.floor(Number(input.winnerCount) || 1))),
    hostId: String(input.hostId || ''),
    hostName: text(input.hostName, 80) || 'Unknown',
    createdAt: Date.now(),
    endsAt: Date.now() + durationMs,
    ended: false,
    endedAt: null,
    entries: [],
    winners: [],
    requirements: normalizeRequirements(input.requirements),
    bonusRoles: (input.bonusRoles || [])
      .map((bonus) => ({ roleId: text(bonus.roleId, 64), entries: Math.min(10, Math.max(1, Math.floor(Number(bonus.entries) || 1))) }))
      .filter((bonus) => bonus.roleId),
  };

  let sent: any;
  try {
    sent = await channel.send({ embeds: [buildGiveawayEmbed(giveaway)] });
  } catch (error: any) {
    return { ok: false, error: `Could not post the giveaway: ${error?.message || error}` };
  }

  giveaway.messageId = String(sent?.id || sent?._id || '');
  persist(giveaway);

  try {
    await sent.addReaction?.(GIVEAWAY_EMOJI);
  } catch (error) {
    debug('giveaways', () => `seed reaction failed: ${(error as Error)?.message || error}`);
  }

  recordAudit({
    serverId: giveaway.serverId,
    actorId: giveaway.hostId,
    actorName: giveaway.hostName,
    source: input.source || 'command',
    area: 'giveaways',
    action: 'create',
    detail: `${prize} · ${giveaway.winnerCount} winner(s) · ${formatDuration(durationMs)}`,
  });

  return { ok: true, giveaway };
}

function describeRequirements(giveaway: Giveaway): string[] {
  const lines: string[] = [];
  const { minLevel, requiredRoleIds, minAccountAgeDays } = giveaway.requirements;
  if (minLevel > 0) lines.push(`level ${minLevel}+`);
  if (requiredRoleIds.length) lines.push(requiredRoleIds.map((roleId) => `<%${roleId}>`).join(' + '));
  if (minAccountAgeDays > 0) lines.push(`account ${minAccountAgeDays}+ days old`);
  return lines;
}

function buildGiveawayEmbed(giveaway: Giveaway) {
  const lines: string[] = [];
  if (giveaway.description) lines.push(giveaway.description, '');
  lines.push(`React with ${GIVEAWAY_EMOJI} to enter.`);
  lines.push(`**Winners:** ${giveaway.winnerCount}`);
  lines.push(`**Entries:** ${giveaway.entries.length}`);
  lines.push(giveaway.ended ? '**Ended**' : `**Ends:** in ${formatDuration(giveaway.endsAt - Date.now())}`);
  lines.push(`**Host:** <@${giveaway.hostId}>`);

  const requirements = describeRequirements(giveaway);
  if (requirements.length) lines.push(`**Requirements:** ${requirements.join(' · ')}`);
  if (giveaway.bonusRoles.length) {
    lines.push(`**Bonus entries:** ${giveaway.bonusRoles.map((bonus) => `<%${bonus.roleId}> ×${bonus.entries}`).join(' · ')}`);
  }
  if (giveaway.ended && giveaway.winners.length) {
    lines.push('', `🏆 **Winner${giveaway.winners.length === 1 ? '' : 's'}:** ${giveaway.winners.map((id) => `<@${id}>`).join(', ')}`);
  }

  // The prize heads the description: titles stop at 100 characters and a
  // prize may be 200.
  return safeEmbed({
    title: giveaway.ended ? '🎉 Giveaway ended' : '🎉 Giveaway',
    description: clampText(`### ${giveaway.prize}\n${lines.join('\n')}`, EMBED_DESCRIPTION_MAX),
    color: giveaway.ended ? '#64748b' : '#f59e0b',
  });
}

// Entries arrive in bursts right after a giveaway is posted; the message edit
// that shows the entrant count is coalesced so it cannot hit the rate limit.
const REFRESH_DEBOUNCE_MS = 1500;
const pendingRefresh = new Map<string, NodeJS.Timeout>();

function scheduleRefresh(client: any, giveaway: Giveaway): void {
  if (pendingRefresh.has(giveaway.id)) return;
  const timer = setTimeout(() => {
    pendingRefresh.delete(giveaway.id);
    const current = getGiveaway(giveaway.id);
    if (current) void refreshMessage(client, current);
  }, REFRESH_DEBOUNCE_MS);
  timer.unref?.();
  pendingRefresh.set(giveaway.id, timer);
}

async function refreshMessage(client: any, giveaway: Giveaway): Promise<void> {
  const queued = pendingRefresh.get(giveaway.id);
  if (queued) {
    clearTimeout(queued);
    pendingRefresh.delete(giveaway.id);
  }
  try {
    const channel =
      client?.channels?.cache?.get?.(giveaway.channelId) ||
      (await client?.channels?.fetch?.(giveaway.channelId).catch(() => null));
    const message = await channel?.messages?.fetch?.(giveaway.messageId).catch(() => null);
    if (message?.edit) await message.edit({ embeds: [buildGiveawayEmbed(giveaway)] });
  } catch (error) {
    debug('giveaways', () => `message refresh failed: ${(error as Error)?.message || error}`);
  }
}

// ---- Eligibility -----------------------------------------------------------

/** Why a member may not enter, or null when they may. */
export async function checkEligibility(client: any, giveaway: Giveaway, userId: string): Promise<string | null> {
  const { minLevel, requiredRoleIds, minAccountAgeDays } = giveaway.requirements;

  if (minLevel > 0) {
    const rank = getUserRank(userId, giveaway.serverId);
    if (!rank || rank.level < minLevel) return `you need to be level ${minLevel} or higher in this server`;
  }

  if (requiredRoleIds.length) {
    const server = client?.servers?.cache?.get?.(giveaway.serverId);
    const member = server?.members?.cache?.get?.(userId) || (await server?.members?.fetch?.(userId).catch(() => null));
    const roleIds = new Set(getRoleIds(member?.roles ?? member?.roleIds));
    const missing = requiredRoleIds.filter((roleId) => !roleIds.has(roleId));
    if (missing.length) return 'you do not have the role this giveaway requires';
  }

  if (minAccountAgeDays > 0) {
    const createdAt = accountCreatedAt(userId);
    if (createdAt == null) return null; // unknown age is not held against anyone
    const ageDays = (Date.now() - createdAt) / 86_400_000;
    if (ageDays < minAccountAgeDays) return `your account must be at least ${minAccountAgeDays} days old`;
  }

  return null;
}

/**
 * Creation time encoded in a ULID user id (first 48 bits, base32, ms since
 * epoch). Returns null for ids that are not ULIDs.
 */
function accountCreatedAt(userId: string): number | null {
  const id = String(userId || '').trim().toUpperCase();
  if (id.length < 10) return null;
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = 0;
  for (const char of id.slice(0, 10)) {
    const value = alphabet.indexOf(char);
    if (value < 0) return null;
    time = time * 32 + value;
  }
  return time > 0 && time < Date.now() + 86_400_000 ? time : null;
}

// ---- Entry -----------------------------------------------------------------

type ReactionContext = { client: any; messageId: any; userId: any; emoji: any };

/** A 🎉 reaction enters the giveaway. Returns true when it was a giveaway message. */
export async function handleGiveawayReaction(ctx: ReactionContext): Promise<boolean> {
  const messageId = String(ctx.messageId || '');
  const userId = String(ctx.userId || '');
  if (!messageId || !userId) return false;

  const giveaway = getGiveawayByMessage(messageId);
  if (!giveaway) return false;
  if (userId === ctx.client?.user?.id) return true;
  if (String(ctx.emoji || '') !== GIVEAWAY_EMOJI) return true;
  if (giveaway.ended) return true;
  if (giveaway.entries.includes(userId)) return true;

  const problem = await checkEligibility(ctx.client, giveaway, userId);
  if (problem) {
    await tellMember(ctx.client, giveaway, userId, `You could not enter the **${giveaway.prize}** giveaway: ${problem}.`);
    await removeEntryReaction(ctx.client, giveaway, userId);
    return true;
  }

  // The eligibility check awaited the API: the draw may have happened, or a
  // second reaction event for the same member may have landed, meanwhile.
  if (giveaway.ended || drawing.has(giveaway.id) || giveaway.entries.includes(userId)) return true;
  giveaway.entries.push(userId);
  persist(giveaway);
  scheduleRefresh(ctx.client, giveaway);
  return true;
}

/** Removing the reaction withdraws the entry. */
export async function handleGiveawayUnreaction(ctx: ReactionContext): Promise<boolean> {
  const messageId = String(ctx.messageId || '');
  const userId = String(ctx.userId || '');
  if (!messageId || !userId) return false;

  const giveaway = getGiveawayByMessage(messageId);
  if (!giveaway) return false;
  if (String(ctx.emoji || '') !== GIVEAWAY_EMOJI) return true;
  if (giveaway.ended || !giveaway.entries.includes(userId)) return true;

  giveaway.entries = giveaway.entries.filter((id) => id !== userId);
  persist(giveaway);
  scheduleRefresh(ctx.client, giveaway);
  return true;
}

async function removeEntryReaction(client: any, giveaway: Giveaway, userId: string): Promise<void> {
  try {
    const channel =
      client?.channels?.cache?.get?.(giveaway.channelId) ||
      (await client?.channels?.fetch?.(giveaway.channelId).catch(() => null));
    const message = await channel?.messages?.fetch?.(giveaway.messageId).catch(() => null);
    if (typeof message?.removeReaction === 'function') await message.removeReaction(GIVEAWAY_EMOJI, { user_id: userId });
  } catch (error) {
    debug('giveaways', () => `entry reaction removal failed: ${(error as Error)?.message || error}`);
  }
}

async function tellMember(client: any, giveaway: Giveaway, userId: string, content: string): Promise<void> {
  try {
    await sendDirectMessage(client, userId, { content });
  } catch (error) {
    debug('giveaways', () => `DM failed: ${(error as Error)?.message || error}`);
  }
}

// ---- Drawing ---------------------------------------------------------------

/**
 * Build the weighted draw pool: one slot per entry, plus extra slots for every
 * bonus role the entrant holds.
 *
 * Entrants are looked up again at draw time. Someone who left the server, or
 * lost a required role since entering, drops out of the pool. When no entrant
 * can be looked up at all the API is the likelier problem than every entrant
 * having left, so the raw entry list is used rather than drawing nobody.
 */
async function buildPool(client: any, giveaway: Giveaway): Promise<string[]> {
  const server = client?.servers?.cache?.get?.(giveaway.serverId) || (await client?.servers?.fetch?.(giveaway.serverId).catch(() => null));
  if (!server?.members) return [...giveaway.entries];

  const members = new Map<string, any>();
  const entries = [...giveaway.entries];
  for (let index = 0; index < entries.length; index += 10) {
    const batch = entries.slice(index, index + 10);
    const found = await Promise.all(
      batch.map(async (userId) => server.members.cache?.get?.(userId) || (await server.members.fetch?.(userId).catch(() => null))),
    );
    batch.forEach((userId, position) => {
      if (found[position]) members.set(userId, found[position]);
    });
  }
  if (members.size === 0) return [...giveaway.entries];

  const required = giveaway.requirements.requiredRoleIds;
  const pool: string[] = [];
  for (const userId of entries) {
    const member = members.get(userId);
    if (!member) continue;
    const roleIds = new Set(getRoleIds(member.roles ?? member.roleIds));
    if (required.some((roleId) => !roleIds.has(roleId))) continue;
    let weight = 1;
    for (const bonus of giveaway.bonusRoles) {
      if (roleIds.has(bonus.roleId)) weight = Math.max(weight, bonus.entries);
    }
    for (let i = 0; i < weight; i++) pool.push(userId);
  }
  return pool;
}

/** Draw `count` distinct winners from a weighted pool. */
export function drawWinners(pool: string[], count: number, exclude: string[] = []): string[] {
  const banned = new Set(exclude);
  const winners: string[] = [];
  let remaining = pool.filter((id) => !banned.has(id));

  while (winners.length < count && remaining.length) {
    const pick = remaining[Math.floor(Math.random() * remaining.length)];
    winners.push(pick);
    // Without replacement: strip every slot belonging to that member.
    remaining = remaining.filter((id) => id !== pick);
  }
  return winners;
}

export type EndGiveawayResult = { ok: boolean; giveaway?: Giveaway; winners?: string[]; error?: string };

/** Giveaways whose draw is in progress, so a command and the scheduler cannot both draw. */
const drawing = new Set<string>();

export type GiveawayActor = { id?: string; name?: string; source?: AuditSource };

export async function endGiveaway(client: any, id: string, endedBy: string | GiveawayActor = ''): Promise<EndGiveawayResult> {
  const actor: GiveawayActor = typeof endedBy === 'string' ? { id: endedBy } : endedBy;
  const giveaway = getGiveaway(id);
  if (!giveaway) return { ok: false, error: 'No giveaway with that id.' };
  if (giveaway.ended) return { ok: false, error: 'That giveaway has already ended.' };
  if (drawing.has(giveaway.id)) return { ok: false, error: 'That giveaway is being drawn right now.' };

  drawing.add(giveaway.id);
  let winners: string[];
  try {
    const pool = await buildPool(client, giveaway);
    winners = drawWinners(pool, giveaway.winnerCount);
    giveaway.ended = true;
    giveaway.endedAt = Date.now();
    giveaway.winners = winners;
    persist(giveaway);
  } finally {
    drawing.delete(giveaway.id);
  }

  await refreshMessage(client, giveaway);
  await announceWinners(client, giveaway, winners, false);

  recordAudit({
    serverId: giveaway.serverId,
    actorId: actor.id || '',
    actorName: actor.name,
    source: actor.source || (actor.id ? 'command' : 'automation'),
    area: 'giveaways',
    action: 'end',
    detail: `${giveaway.prize} · ${winners.length} winner(s) from ${giveaway.entries.length} entries`,
  });

  return { ok: true, giveaway, winners };
}

/** Draw replacement winners, never re-picking someone who already won. */
export async function rerollGiveaway(client: any, id: string, count?: number, actor: GiveawayActor = {}): Promise<EndGiveawayResult> {
  const giveaway = getGiveaway(id);
  if (!giveaway) return { ok: false, error: 'No giveaway with that id.' };
  if (!giveaway.ended) return { ok: false, error: 'End the giveaway before rerolling it.' };
  if (drawing.has(giveaway.id)) return { ok: false, error: 'That giveaway is being drawn right now.' };

  drawing.add(giveaway.id);
  let winners: string[];
  try {
    const pool = await buildPool(client, giveaway);
    const wanted = Math.min(20, Math.max(1, Math.floor(Number(count) || giveaway.winnerCount)));
    winners = drawWinners(pool, wanted, giveaway.winners);
    if (!winners.length) return { ok: false, error: 'No eligible entrants left to reroll.' };
    giveaway.winners = [...giveaway.winners, ...winners];
    persist(giveaway);
  } finally {
    drawing.delete(giveaway.id);
  }

  await refreshMessage(client, giveaway);
  await announceWinners(client, giveaway, winners, true);

  recordAudit({
    serverId: giveaway.serverId,
    actorId: actor.id || '',
    actorName: actor.name,
    source: actor.source || 'command',
    area: 'giveaways',
    action: 'reroll',
    detail: `${giveaway.prize} · ${winners.length} new winner(s)`,
  });

  return { ok: true, giveaway, winners };
}

async function announceWinners(client: any, giveaway: Giveaway, winners: string[], reroll: boolean): Promise<void> {
  try {
    const channel =
      client?.channels?.cache?.get?.(giveaway.channelId) ||
      (await client?.channels?.fetch?.(giveaway.channelId).catch(() => null));
    if (!channel?.send) return;

    const content = winners.length
      ? `🎉 ${reroll ? 'Reroll' : 'Giveaway ended'} — **${giveaway.prize}**\nWinner${winners.length === 1 ? '' : 's'}: ${winners.map((id) => `<@${id}>`).join(', ')}\nEntries: ${giveaway.entries.length}`
      : `🎉 **${giveaway.prize}** ended with no eligible entries.`;
    await channel.send({ content });
  } catch (error) {
    debug('giveaways', () => `winner announcement failed: ${(error as Error)?.message || error}`);
  }

  for (const userId of winners) {
    await tellMember(client, giveaway, userId, `🎉 You won **${giveaway.prize}**! Check <#${giveaway.channelId}> to claim it.`);
  }
}

// ---- Scheduler -------------------------------------------------------------

export function startGiveawayScheduler(client: any) {
  clientRef = client;
  if (timer) return;
  console.log(`[giveaways] Hosted giveaway scheduler started (tick ${TICK_MS / 1000}s).`);
  timer = setInterval(() => {
    void endDueGiveaways().catch((error) => console.error('[giveaways] tick failed:', error));
  }, TICK_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Whether the tick is armed, for the ops health panel. */
export function isGiveawaySchedulerRunning(): boolean {
  return timer !== null;
}

export function stopGiveawayScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  clientRef = null;
}

export async function endDueGiveaways(now = Date.now()): Promise<number> {
  if (ticking || !clientRef) return 0;
  ticking = true;
  let ended = 0;
  try {
    const due = store.read().filter((entry) => !entry.ended && entry.endsAt <= now);
    for (const giveaway of due) {
      const result = await endGiveaway(clientRef, giveaway.id);
      if (result.ok) ended++;
    }
  } finally {
    ticking = false;
  }
  return ended;
}

export function getGiveawaySummary(serverId = config.serverId || '') {
  const all = listGiveaways(serverId);
  return {
    total: all.length,
    active: all.filter((entry) => !entry.ended).length,
    entries: all.reduce((sum, entry) => sum + entry.entries.length, 0),
  };
}
