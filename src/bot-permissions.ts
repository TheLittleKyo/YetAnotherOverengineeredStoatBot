/**
 * Bot permissions: per-role access to the bot's own commands and features,
 * edited from the dashboard Roles tab.
 *
 * Stoat permissions decide what a member may do in Stoat; these decide what a
 * member may do with the bot. Every feature below has a three-way setting per
 * role (plus an "Everyone" rule that applies to all members):
 *
 *   allow   — full access to the feature, including the management actions
 *             that normally need a Stoat permission or the support role.
 *   deny    — no access to the feature's commands.
 *   inherit — the built-in rule, described by `defaultAccess`.
 *
 * Rules resolve the way Stoat folds role overwrites: the Everyone rule first,
 * then the member's roles from the lowest to the highest rank, with the last
 * explicit setting winning (deny beats allow between roles of equal rank). The
 * server owner is never affected. Rules are per server, and a rule only ever
 * applies to checks made against the server it was set in.
 *
 * Enforcement lives in two places:
 * - the command dispatcher refuses a denied feature up front, and runs every
 *   command inside a context naming its feature (`runWithBotPermission`);
 * - the shared permission helpers in permissions.ts read that context, so an
 *   allowed role passes the command's own checks without the Stoat permission.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createArrayFileStore, dataFile } from './json-store.js';
import { getRoleIds } from './member-utils.js';
import { debug } from './logger.js';

export type BotPermissionDecision = 'allow' | 'deny' | null;

export type BotPermissionDef = {
  key: string;
  label: string;
  group: string;
  /** Commands the feature covers, without the prefix. */
  commands: string[];
  /** Who can use it when no rule applies. */
  defaultAccess: string;
  /** Allowing this hands out moderation or server-wide power; the UI flags it. */
  sensitive?: boolean;
};

export type BotPermissionRule = { allow: string[]; deny: string[] };

export type ServerBotPermissions = {
  serverId: string;
  everyone: BotPermissionRule;
  roles: Record<string, BotPermissionRule>;
};

/** Target id the dashboard uses for the rule that applies to every member. */
export const EVERYONE_TARGET = 'everyone';

export const BOT_PERMISSIONS: BotPermissionDef[] = [
  {
    key: 'tickets',
    label: 'Tickets',
    group: 'Tickets',
    commands: ['ticket open', 'ticket close', 'ticket transcript', 'ticket delete'],
    defaultAccess: 'Everyone. Members close, transcribe, and delete their own tickets.',
  },
  {
    key: 'tickets.staff',
    label: 'Ticket staff',
    group: 'Tickets',
    commands: ['ticket claim', 'ticket priority', 'ticket close', 'ticket delete'],
    defaultAccess: 'Support role. Staff can act on any ticket.',
  },
  {
    key: 'tickets.setup',
    label: 'Ticket setup',
    group: 'Tickets',
    commands: ['ticket setup', 'ticket panel'],
    defaultAccess: 'Manage Server.',
    sensitive: true,
  },
  {
    key: 'purge',
    label: 'Purge messages',
    group: 'Moderation',
    commands: ['purge'],
    defaultAccess: 'Support role or Manage Messages.',
    sensitive: true,
  },
  {
    key: 'perms',
    label: 'Mass channel permissions',
    group: 'Moderation',
    commands: ['perms'],
    defaultAccess: 'Manage Permissions or Manage Channel.',
    sensitive: true,
  },
  {
    key: 'antiraid',
    label: 'Raid protection',
    group: 'Moderation',
    commands: ['antiraid'],
    defaultAccess: 'Manage Server.',
    sensitive: true,
  },
  {
    key: 'captcha',
    label: 'Captcha verification',
    group: 'Moderation',
    commands: ['captcha'],
    defaultAccess: 'Manage Server.',
  },
  {
    key: 'moderation',
    label: 'Moderation cases',
    group: 'Moderation',
    commands: ['warn', 'mute', 'kick', 'ban', 'unban', 'note', 'cases', 'case', 'modstats'],
    defaultAccess: 'Per action: Manage Messages to warn, Kick Members to kick, Ban Members to ban.',
    sensitive: true,
  },
  {
    key: 'automod',
    label: 'Automod',
    group: 'Moderation',
    commands: ['automod'],
    defaultAccess: 'Manage Server.',
    sensitive: true,
  },
  {
    key: 'reactionroles',
    label: 'Reaction roles',
    group: 'Roles',
    commands: ['roles'],
    defaultAccess: 'Everyone can list. Changes need Manage Role.',
    sensitive: true,
  },
  {
    key: 'joinroles',
    label: 'Join roles',
    group: 'Roles',
    commands: ['joinrole'],
    defaultAccess: 'Everyone can list. Changes need Manage Role.',
    sensitive: true,
  },
  {
    key: 'level',
    label: 'Leveling',
    group: 'Community',
    commands: ['level', 'rank', 'leaderboard'],
    defaultAccess: 'Everyone sees ranks. Settings and XP changes need Manage Server.',
  },
  {
    key: 'welcome',
    label: 'Welcome images',
    group: 'Community',
    commands: ['welcome'],
    defaultAccess: 'Everyone sees status. Changes need Manage Server.',
  },
  {
    key: 'stats',
    label: 'Stats channels',
    group: 'Community',
    commands: ['stats'],
    defaultAccess: 'Everyone can list. Changes need Manage Channel.',
  },
  {
    key: 'embed',
    label: 'Embeds',
    group: 'Community',
    commands: ['embed'],
    defaultAccess: 'Manage Server.',
  },
  {
    key: 'notify',
    label: 'Notifications',
    group: 'Community',
    commands: ['notify'],
    defaultAccess: 'Everyone can list. Changes need Manage Server.',
  },
  {
    key: 'freestuff',
    label: 'Free stuff feed',
    group: 'Community',
    commands: ['freestuff'],
    defaultAccess: 'Manage Server.',
  },
  {
    key: 'reminder',
    label: 'Scheduled messages',
    group: 'Community',
    commands: ['reminder'],
    defaultAccess: 'Manage Server.',
  },
  {
    key: 'polls',
    label: 'Polls',
    group: 'Community',
    commands: ['poll'],
    defaultAccess: 'Everyone votes. Creating and closing polls needs Manage Messages.',
  },
  {
    key: 'giveaways',
    label: 'Giveaways',
    group: 'Community',
    commands: ['giveaway', 'gstart', 'gend', 'greroll'],
    defaultAccess: 'Everyone enters. Hosting needs Manage Server.',
  },
  {
    key: 'tags',
    label: 'Tags',
    group: 'Community',
    commands: ['tag', 'and every tag by name'],
    defaultAccess: 'Everyone calls tags. Creating and editing needs Manage Messages.',
  },
  {
    key: 'economy',
    label: 'Economy',
    group: 'Community',
    commands: ['balance', 'daily', 'work', 'pay', 'shop', 'buy', 'rich', 'gamble', 'eco'],
    defaultAccess: 'Everyone. Admin commands need Manage Server.',
  },
  {
    key: 'birthdays',
    label: 'Birthdays',
    group: 'Community',
    commands: ['birthday'],
    defaultAccess: 'Everyone sets their own. Settings need Manage Server.',
  },
  {
    key: 'tempvoice',
    label: 'Temporary voice rooms',
    group: 'Community',
    commands: ['vc'],
    defaultAccess: 'Everyone opens a room. Hub setup needs Manage Server.',
  },
  {
    key: 'booru',
    label: 'Booru image search',
    group: 'Community',
    commands: ['booru', 'danbooru', 'safebooru', 'e621', 'atfbooru'],
    defaultAccess: 'Everyone searches. Blacklist and site settings need Manage Server.',
  },
  {
    key: 'autoresponder',
    label: 'Auto-responder',
    group: 'Automation',
    commands: ['autoresponder'],
    defaultAccess: 'Manage Server.',
  },
  {
    key: 'autoreact',
    label: 'Auto-react',
    group: 'Automation',
    commands: ['autoreact'],
    defaultAccess: 'Manage Server.',
  },
  {
    key: 'music',
    label: 'Music',
    group: 'Music',
    commands: ['play', 'radio', 'queue', 'nowplaying', 'lyrics', 'join'],
    defaultAccess: 'Everyone.',
  },
  {
    key: 'music.dj',
    label: 'DJ controls',
    group: 'Music',
    commands: ['skip', 'stop', 'pause', 'volume', 'loop', 'move', 'music announce'],
    defaultAccess: 'Listeners in the bot’s voice channel, or Manage Server / Move Members from anywhere.',
  },
  {
    key: 'logs',
    label: 'Server logs',
    group: 'Server',
    commands: ['logs'],
    defaultAccess: 'Everyone sees status. Changes need Manage Server.',
  },
  {
    key: 'sync',
    label: 'Channel sync',
    group: 'Server',
    commands: ['sync', 'syncdebug'],
    defaultAccess: 'Manage Server in both servers.',
    sensitive: true,
  },
  {
    key: 'backup',
    label: 'Backups',
    group: 'Server',
    commands: ['backup'],
    defaultAccess: 'Manage Server.',
    sensitive: true,
  },
  {
    key: 'reset',
    label: 'Server reset',
    group: 'Server',
    commands: ['reset'],
    defaultAccess: 'Manage Server, plus terminal confirmation.',
    sensitive: true,
  },
  {
    key: 'dashboard',
    label: 'Dashboard link',
    group: 'Server',
    commands: ['dashboard'],
    defaultAccess: 'Manage Server.',
  },
];

const KNOWN_KEYS = new Set(BOT_PERMISSIONS.map((def) => def.key));
const MEMBER_LOOKUP_TIMEOUT_MS = 8_000;
/**
 * How long a member's roles are reused between lookups. Long enough that the
 * dispatcher's deny check and the permission helpers inside one command share a
 * single fetch, short enough that removing a role takes effect right away.
 */
const MEMBER_ROLES_TTL_MS = 5_000;
const MEMBER_CACHE_SWEEP_AT = 500;

const store = createArrayFileStore<ServerBotPermissions>(dataFile('bot-permissions.json'), 'servers', 'bot permissions');

export function isBotPermissionKey(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_KEYS.has(value);
}

/** Clean a rule from untrusted input: known keys only, no duplicates, deny wins a key listed twice. */
export function normalizeBotPermissionRule(value: any): BotPermissionRule {
  const deny = uniqueKeys(value?.deny);
  const denied = new Set(deny);
  const allow = uniqueKeys(value?.allow).filter((key) => !denied.has(key));
  return { allow, deny };
}

function uniqueKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.filter(isBotPermissionKey)));
}

function isEmptyRule(rule: BotPermissionRule): boolean {
  return rule.allow.length === 0 && rule.deny.length === 0;
}

/** The stored rules for a server, normalized. Never null. */
export function getBotPermissions(serverId: string): ServerBotPermissions {
  const found = store.read().find((entry) => entry.serverId === serverId);
  const roles: Record<string, BotPermissionRule> = {};
  for (const [roleId, rule] of Object.entries(found?.roles || {})) {
    const normalized = normalizeBotPermissionRule(rule);
    if (roleId && !isEmptyRule(normalized)) roles[roleId] = normalized;
  }
  return { serverId, everyone: normalizeBotPermissionRule(found?.everyone), roles };
}

/**
 * Replace the rule for one target — a role id or `EVERYONE_TARGET` — and
 * persist. An empty rule removes the role entry. Returns the server's rules.
 */
export function setBotPermissionRule(serverId: string, target: string, rule: BotPermissionRule): ServerBotPermissions {
  const current = getBotPermissions(serverId);
  const normalized = normalizeBotPermissionRule(rule);

  if (target === EVERYONE_TARGET) {
    current.everyone = normalized;
  } else if (isEmptyRule(normalized)) {
    delete current.roles[target];
  } else {
    current.roles[target] = normalized;
  }

  saveServer(current);
  return current;
}

/** Drop a deleted role's rule so a future role can never inherit it. */
export function removeBotPermissionRole(serverId: string, roleId: string): void {
  const current = getBotPermissions(serverId);
  if (!current.roles[roleId]) return;
  delete current.roles[roleId];
  saveServer(current);
}

function saveServer(entry: ServerBotPermissions) {
  const others = store.read().filter((item) => item.serverId !== entry.serverId);
  const empty = isEmptyRule(entry.everyone) && Object.keys(entry.roles).length === 0;
  store.write(empty ? others : others.concat(entry));
}

function ruleDecision(rule: BotPermissionRule | undefined, key: string): BotPermissionDecision {
  if (!rule) return null;
  if (rule.deny.includes(key)) return 'deny';
  if (rule.allow.includes(key)) return 'allow';
  return null;
}

/**
 * Fold a server's rules for one member. `memberRoles` carries each role's rank
 * (lower rank = higher in the list, as in Stoat); an unknown rank sorts lowest.
 * Pure, so it is unit-testable without a client.
 */
export function foldBotPermission(
  rules: ServerBotPermissions,
  key: string,
  memberRoles: Array<{ id: string; rank: number | null }>,
): BotPermissionDecision {
  let decision = ruleDecision(rules.everyone, key);

  const byPriority = memberRoles
    .map((role) => ({ rank: Number.isFinite(role.rank) ? Number(role.rank) : Number.MAX_SAFE_INTEGER, decision: ruleDecision(rules.roles[role.id], key) }))
    .filter((role) => role.decision !== null)
    // Lowest priority first so higher roles override; within a rank, deny last.
    .sort((a, b) => b.rank - a.rank || (a.decision === 'deny' ? 1 : 0) - (b.decision === 'deny' ? 1 : 0));

  for (const role of byPriority) decision = role.decision;
  return decision;
}

/**
 * Decide a feature for a user in a server. Returns null — "use the built-in
 * check" — when no rule could apply, for the server owner, and when the member
 * cannot be resolved.
 */
export async function resolveBotPermission(
  client: any,
  serverId: string,
  userId: string,
  key: string,
): Promise<BotPermissionDecision> {
  if (!serverId || !userId || !isBotPermissionKey(key)) return null;

  const rules = getBotPermissions(serverId);
  const mentioned = [rules.everyone, ...Object.values(rules.roles)].some(
    (rule) => rule.allow.includes(key) || rule.deny.includes(key),
  );
  if (!mentioned) return null;

  try {
    const server = client?.servers?.cache?.get?.(serverId) || (await withTimeout(client?.servers?.fetch?.(serverId)));
    if (!server || server.ownerId === userId) return null;

    const roles = await memberRoleRanks(server, serverId, userId);
    // A member we cannot resolve (API down, left the server) falls back to the
    // built-in check rather than guessing — including for a deny.
    if (!roles) return null;

    return foldBotPermission(rules, key, roles);
  } catch (error) {
    debug('botperms', () => `resolve ${key} for ${userId} in ${serverId} failed: ${(error as Error)?.message || error}`);
    return null;
  }
}

type MemberRoles = Array<{ id: string; rank: number | null }> | null;

const memberRolesCache = new Map<string, { at: number; roles: MemberRoles }>();

/**
 * The member's roles with their ranks, or null when the member cannot be
 * resolved or owns the server.
 *
 * The REST fetch comes first and the client cache is only a fallback:
 * stoatbot.js patches a cached member on `ServerMemberUpdate` but ignores the
 * packet's `clear` list and never caches a member it has not seen, so a cached
 * member's roles can lag behind a role that was just removed — which would keep
 * a grant alive after it was taken away. Results are memoized briefly so the
 * dispatcher check and the command's own checks cost one fetch, not three.
 */
async function memberRoleRanks(server: any, serverId: string, userId: string): Promise<MemberRoles> {
  const cacheKey = `${serverId}:${userId}`;
  const cached = memberRolesCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.at < MEMBER_ROLES_TTL_MS) return cached.roles;

  const member =
    (await withTimeout(server?.members?.fetch?.(userId))) || server?.members?.cache?.get?.(userId) || null;

  const roles = !member || member.serverOwner === true || member.owner === true
    ? null
    : toRoleRanks(server, member);

  if (memberRolesCache.size >= MEMBER_CACHE_SWEEP_AT) {
    for (const [key, entry] of memberRolesCache) {
      if (now - entry.at >= MEMBER_ROLES_TTL_MS) memberRolesCache.delete(key);
    }
  }
  memberRolesCache.set(cacheKey, { at: now, roles });
  return roles;
}

function toRoleRanks(server: any, member: any): Array<{ id: string; rank: number | null }> {
  const objects = Array.isArray(member?.roles) ? member.roles : [];
  return getRoleIds(member?.roles).map((id) => {
    const role = objects.find((entry: any) => entry && typeof entry === 'object' && (entry.id || entry._id) === id)
      || server?.roles?.cache?.get?.(id)
      || server?.roles?.get?.(id);
    const rank = Number(role?.rank);
    return { id, rank: Number.isFinite(rank) ? rank : null };
  });
}

/** Drop a memoized member so the next check refetches (used after role edits). */
export function forgetMemberRoles(serverId: string, userId?: string): void {
  if (userId) {
    memberRolesCache.delete(`${serverId}:${userId}`);
    return;
  }
  for (const key of memberRolesCache.keys()) {
    if (key.startsWith(`${serverId}:`)) memberRolesCache.delete(key);
  }
}

function withTimeout<T>(task: Promise<T> | null | undefined): Promise<T | null> {
  if (!task || typeof (task as any).then !== 'function') return Promise.resolve(null);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), MEMBER_LOOKUP_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([task.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

// ── Command context ────────────────────────────────────────────────────────

type BotPermissionContext = { key: string; userId: string };

const context = new AsyncLocalStorage<BotPermissionContext>();

/** Run `fn` as `userId` using feature `key`; permission helpers inside it consult that feature. */
export function runWithBotPermission<T>(key: string, userId: string, fn: () => T): T {
  return context.run({ key, userId }, fn);
}

/**
 * Run `fn` with no feature context.
 *
 * Long-lived resources created inside a command — the dashboard HTTP server
 * started by `!dashboard`, a scheduler, a timer — inherit that command's
 * context through async_hooks. Work that is no longer part of the command must
 * not keep resolving permissions as if it were, so entry points that outlive
 * the command clear it.
 */
export function runWithoutBotPermission<T>(fn: () => T): T {
  return context.exit(fn);
}

/**
 * The decision the current command's feature gives `userId` in `serverId`, or
 * null outside a command context. Only the command's own author is covered: a
 * check on another member (or background work the command started) for a
 * different user falls through to the built-in check.
 */
export async function currentBotPermission(client: any, serverId: string, userId: string): Promise<BotPermissionDecision> {
  const active = context.getStore();
  if (!active || !userId || active.userId !== String(userId)) return null;
  return resolveBotPermission(client, serverId, String(userId), active.key);
}
