/**
 * Leveling + leaderboard system with level-based auto-add roles.
 *
 * Every human message grants a random amount of XP (bounded, with a per-user
 * cooldown so spamming doesn't inflate ranks). Crossing an XP threshold levels
 * a member up; configured "role rewards" are auto-assigned when a member reaches
 * their level, and an optional announcement is posted.
 *
 * Storage: SQLite (db.ts). Each member's XP is one row in `leveling_users`,
 * written as it changes, and the leaderboard is read off an index. A server's
 * config and role rewards live in `module_settings`, cached in memory because
 * every message reads them. Content is never stored. The old
 * `data/leveling.json` is imported on first use.
 */

import { config } from './config.js';
import { getClientToken, getApiBaseUrl } from './stoat-api.js';
import { getRoleIds } from './member-utils.js';
import { registerDataFileHooks } from './json-store.js';
import { importLegacyJson, readModuleSettings, sql, writeModuleSettings } from './db.js';

const DEFAULT_CDN_URL = 'https://autumn.stoat.chat';

const SETTINGS_MODULE = 'leveling';

export type LevelingConfig = {
  enabled: boolean;
  xpMin: number;
  xpMax: number;
  cooldownSeconds: number;
  announce: boolean;
  announceChannelId: string | null;
  // When true, members keep every reward role they earn. When false, only the
  // single highest earned reward role is kept (lower ones are removed).
  stackRoles: boolean;
  // Channels where messages earn no XP.
  noXpChannelIds: string[];
};

export type RoleReward = { level: number; roleId: string };

type UserRecord = {
  xp: number;
  name: string;
  avatarId: string | null;
  lastAt: string;
  lastXpAt: number;
};

type ServerSettings = {
  config: LevelingConfig;
  roleRewards: RoleReward[];
};

const settingsCache = new Map<string, ServerSettings>();
let ready = false;

function defaultConfig(): LevelingConfig {
  return {
    enabled: true,
    xpMin: 15,
    xpMax: 25,
    cooldownSeconds: 60,
    announce: true,
    announceChannelId: null,
    stackRoles: true,
    noXpChannelIds: [],
  };
}

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeConfig(value: any): LevelingConfig {
  const base = defaultConfig();
  if (!value || typeof value !== 'object') return base;

  const xpMin = Math.max(0, Math.floor(num(value.xpMin, base.xpMin)));
  const xpMax = Math.max(xpMin, Math.floor(num(value.xpMax, base.xpMax)));

  return {
    enabled: value.enabled !== false,
    xpMin,
    xpMax,
    cooldownSeconds: Math.max(0, Math.floor(num(value.cooldownSeconds, base.cooldownSeconds))),
    announce: value.announce !== false,
    announceChannelId: typeof value.announceChannelId === 'string' && value.announceChannelId ? value.announceChannelId : null,
    stackRoles: value.stackRoles !== false,
    noXpChannelIds: Array.isArray(value.noXpChannelIds)
      ? Array.from(new Set(value.noXpChannelIds.filter((id: any) => typeof id === 'string' && id)))
      : [],
  };
}

function normalizeRoleRewards(value: any): RoleReward[] {
  if (!Array.isArray(value)) return [];
  const byLevel = new Map<number, string>();
  for (const item of value) {
    const level = Math.floor(num(item?.level, 0));
    const roleId = typeof item?.roleId === 'string' ? item.roleId.trim() : '';
    if (level >= 1 && roleId) byLevel.set(level, roleId);
  }
  return Array.from(byLevel.entries())
    .map(([level, roleId]) => ({ level, roleId }))
    .sort((a, b) => a.level - b.level);
}

function normalizeUser(id: string, raw: any): UserRecord {
  return {
    xp: Math.max(0, Math.floor(num(raw?.xp, 0))),
    name: typeof raw?.name === 'string' ? raw.name : id,
    avatarId: typeof raw?.avatarId === 'string' ? raw.avatarId : null,
    lastAt: typeof raw?.lastAt === 'string' ? raw.lastAt : new Date(0).toISOString(),
    lastXpAt: Math.max(0, Math.floor(num(raw?.lastXpAt, 0))),
  };
}

/** Import `data/leveling.json` (the pre-SQLite store) on first use. */
function ensureReady() {
  if (ready) return;
  importLegacyJson('leveling.json', (data) => {
    const servers = data?.servers && typeof data.servers === 'object' ? data.servers : {};
    for (const [serverId, raw] of Object.entries<any>(servers)) {
      if (!serverId) continue;
      writeModuleSettings(SETTINGS_MODULE, serverId, {
        config: normalizeConfig(raw?.config),
        roleRewards: normalizeRoleRewards(raw?.roleRewards),
      });
      const users = raw?.users && typeof raw.users === 'object' ? raw.users : {};
      for (const [userId, user] of Object.entries<any>(users)) {
        if (userId) writeUser(serverId, userId, normalizeUser(userId, user));
      }
    }
  });
  ready = true;
}

// `!reset` wipes the database; the cached settings must go with it.
registerDataFileHooks('leveling.json', { reload: () => settingsCache.clear() });

function settings(serverId: string): ServerSettings {
  ensureReady();
  let cached = settingsCache.get(serverId);
  if (!cached) {
    const stored: any = readModuleSettings(SETTINGS_MODULE, serverId);
    cached = { config: normalizeConfig(stored?.config), roleRewards: normalizeRoleRewards(stored?.roleRewards) };
    settingsCache.set(serverId, cached);
  }
  return cached;
}

function saveSettings(serverId: string, next: ServerSettings) {
  writeModuleSettings(SETTINGS_MODULE, serverId, next);
  settingsCache.set(serverId, next);
}

function readUser(serverId: string, userId: string): UserRecord | null {
  ensureReady();
  const row = sql('SELECT xp, name, avatar_id, last_at, last_xp_at FROM leveling_users WHERE server_id = ? AND user_id = ?')
    .get(serverId, userId) as any;
  if (!row) return null;
  return { xp: row.xp, name: row.name, avatarId: row.avatar_id ?? null, lastAt: row.last_at, lastXpAt: row.last_xp_at };
}

function newUser(userId: string): UserRecord {
  return { xp: 0, name: userId, avatarId: null, lastAt: new Date().toISOString(), lastXpAt: 0 };
}

function writeUser(serverId: string, userId: string, user: UserRecord) {
  sql(
    `INSERT INTO leveling_users (server_id, user_id, xp, name, avatar_id, last_at, last_xp_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, user_id) DO UPDATE SET
       xp = excluded.xp, name = excluded.name, avatar_id = excluded.avatar_id,
       last_at = excluded.last_at, last_xp_at = excluded.last_xp_at`,
  ).run(serverId, userId, user.xp, user.name, user.avatarId, user.lastAt, user.lastXpAt);
}

/* ---------------------------------------------------------------------------
 * XP curve (Mee6-style): XP required to go from level L to L+1 is
 *   5*L^2 + 50*L + 100
 * ------------------------------------------------------------------------- */

export function xpForLevelUp(level: number): number {
  const l = Math.max(0, Math.floor(level));
  return 5 * l * l + 50 * l + 100;
}

/** Total cumulative XP required to reach `level` from 0. */
export function totalXpForLevel(level: number): number {
  let total = 0;
  for (let l = 0; l < Math.max(0, Math.floor(level)); l += 1) {
    total += xpForLevelUp(l);
  }
  return total;
}

/** Level reached with a given total XP. */
export function levelFromXp(xp: number): number {
  let level = 0;
  let remaining = Math.max(0, Math.floor(xp));
  for (let cost = xpForLevelUp(0); remaining >= cost; cost = xpForLevelUp(level)) {
    remaining -= cost;
    level += 1;
  }
  return level;
}

export type LevelProgress = {
  xp: number;
  level: number;
  currentLevelXp: number; // XP earned within the current level
  neededForNext: number; // XP required to finish the current level
};

export function getLevelProgress(xp: number): LevelProgress {
  const level = levelFromXp(xp);
  const base = totalXpForLevel(level);
  return {
    xp,
    level,
    currentLevelXp: xp - base,
    neededForNext: xpForLevelUp(level),
  };
}

/* ---------------------------------------------------------------------------
 * Config + reward management
 * ------------------------------------------------------------------------- */

export function getLevelingConfig(serverId = config.serverId): LevelingConfig {
  if (!serverId) return defaultConfig();
  return { ...settings(serverId).config };
}

export function setLevelingConfig(patch: Partial<LevelingConfig>, serverId = config.serverId): LevelingConfig {
  if (!serverId) return defaultConfig();
  const current = settings(serverId);
  const next = { ...current, config: normalizeConfig({ ...current.config, ...patch }) };
  saveSettings(serverId, next);
  return { ...next.config };
}

export function getRoleRewards(serverId = config.serverId): RoleReward[] {
  if (!serverId) return [];
  return settings(serverId).roleRewards.map((r) => ({ ...r }));
}

export function addRoleReward(level: number, roleId: string, serverId = config.serverId): RoleReward[] {
  if (!serverId || !roleId || !(level >= 1)) return getRoleRewards(serverId);
  const current = settings(serverId);
  const lvl = Math.floor(level);
  saveSettings(serverId, {
    ...current,
    roleRewards: normalizeRoleRewards([...current.roleRewards.filter((r) => r.level !== lvl), { level: lvl, roleId }]),
  });
  return getRoleRewards(serverId);
}

export function removeRoleReward(level: number, serverId = config.serverId): RoleReward[] {
  if (!serverId) return getRoleRewards(serverId);
  const current = settings(serverId);
  const lvl = Math.floor(level);
  saveSettings(serverId, { ...current, roleRewards: current.roleRewards.filter((r) => r.level !== lvl) });
  return getRoleRewards(serverId);
}

export function clearRoleRewards(serverId = config.serverId): void {
  if (!serverId) return;
  saveSettings(serverId, { ...settings(serverId), roleRewards: [] });
}

/* ---------------------------------------------------------------------------
 * Leaderboard + per-user stats
 * ------------------------------------------------------------------------- */

export type RankRow = {
  userId: string;
  name: string;
  avatarId: string | null;
  xp: number;
  level: number;
  rank: number;
};

// Ties rank by user id, so the leaderboard and a member's own rank agree.
export function getLeaderboard(topN = 10, serverId = config.serverId): RankRow[] {
  if (!serverId) return [];
  ensureReady();
  const safeTopN = Math.max(1, Math.min(50, Math.floor(topN) || 10));
  const rows = sql(
    'SELECT user_id, name, avatar_id, xp FROM leveling_users WHERE server_id = ? ORDER BY xp DESC, user_id LIMIT ?',
  ).all(serverId, safeTopN) as any[];
  return rows.map((row, index) => ({
    userId: row.user_id,
    name: row.name,
    avatarId: row.avatar_id ?? null,
    xp: row.xp,
    level: levelFromXp(row.xp),
    rank: index + 1,
  }));
}

export function getUserRank(userId: string, serverId = config.serverId): RankRow | null {
  if (!serverId || !userId) return null;
  const user = readUser(serverId, userId);
  if (!user) return null;
  const { ahead } = sql(
    'SELECT COUNT(*) AS ahead FROM leveling_users WHERE server_id = ? AND (xp > ? OR (xp = ? AND user_id < ?))',
  ).get(serverId, user.xp, user.xp, userId) as { ahead: number };
  return { userId, name: user.name, avatarId: user.avatarId, xp: user.xp, level: levelFromXp(user.xp), rank: ahead + 1 };
}

export function getTrackedUserCount(serverId = config.serverId): number {
  if (!serverId) return 0;
  ensureReady();
  const { count } = sql('SELECT COUNT(*) AS count FROM leveling_users WHERE server_id = ?').get(serverId) as { count: number };
  return count;
}

/* ---------------------------------------------------------------------------
 * Admin XP adjustments
 * ------------------------------------------------------------------------- */

/** Set a user's XP directly. Returns the new progress. */
export function setUserXp(userId: string, xp: number, serverId = config.serverId): LevelProgress {
  const user = readUser(serverId!, userId) || newUser(userId);
  user.xp = Math.max(0, Math.floor(xp));
  writeUser(serverId!, userId, user);
  return getLevelProgress(user.xp);
}

/** Set a user's level directly (XP snaps to the level threshold). */
export function setUserLevel(userId: string, level: number, serverId = config.serverId): LevelProgress {
  return setUserXp(userId, totalXpForLevel(Math.max(0, Math.floor(level))), serverId);
}

/** Add (or subtract) XP. Returns the new progress. */
export function addUserXp(userId: string, delta: number, serverId = config.serverId): LevelProgress {
  const user = readUser(serverId!, userId) || newUser(userId);
  user.xp = Math.max(0, user.xp + Math.floor(delta));
  writeUser(serverId!, userId, user);
  return getLevelProgress(user.xp);
}

export function resetUser(userId: string, serverId = config.serverId): boolean {
  if (!serverId) return false;
  ensureReady();
  return Number(sql('DELETE FROM leveling_users WHERE server_id = ? AND user_id = ?').run(serverId, userId).changes) > 0;
}

export function resetAll(serverId = config.serverId): void {
  if (!serverId) return;
  ensureReady();
  sql('DELETE FROM leveling_users WHERE server_id = ?').run(serverId);
}

/* ---------------------------------------------------------------------------
 * Message handling — award XP + level up + role rewards
 * ------------------------------------------------------------------------- */

function resolveAuthorId(message: any): string | null {
  const id = message?.authorId || message?.author?.id || message?.author?._id
    || (typeof message?.author === 'string' ? message.author : null);
  return id ? String(id) : null;
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

function resolveChannelId(message: any): string | null {
  const id = message?.channelId || message?.channel_id || message?.channel?.id || message?.channel?._id;
  return id ? String(id) : null;
}

/**
 * Award XP for a message the bot observed. Best-effort: never throws, never
 * blocks message handling. When a member levels up, role rewards are applied
 * and an announcement is posted (both fire-and-forget).
 */
export function recordMessageXp(client: any, message: any) {
  try {
    if (!message) return;
    if (message.systemMessage || message.isSystem) return;
    if (message.author?.bot) return;

    const serverId = (typeof message?.serverId === 'string' && message.serverId) || config.serverId;
    if (!serverId) return;

    const authorId = resolveAuthorId(message);
    if (!authorId) return;

    const botId = client?.user?.id || client?.user?._id;
    if (botId && String(authorId) === String(botId)) return;

    // Ignore command invocations.
    const content = typeof message?.content === 'string' ? message.content : '';
    if (content.startsWith(config.prefix)) return;

    const cfg = settings(serverId).config;
    if (!cfg.enabled) return;

    const channelId = resolveChannelId(message);
    if (channelId && cfg.noXpChannelIds.includes(channelId)) return;

    const user = readUser(serverId, authorId) || newUser(authorId);
    const now = Date.now();

    // Keep display info fresh even while on cooldown.
    user.name = resolveAuthorName(message, user.name || authorId);
    user.avatarId = resolveAvatarId(message) ?? user.avatarId ?? null;
    user.lastAt = new Date(now).toISOString();

    if (now - user.lastXpAt < cfg.cooldownSeconds * 1000) {
      writeUser(serverId, authorId, user);
      return;
    }

    const gain = cfg.xpMin + Math.floor(Math.random() * (cfg.xpMax - cfg.xpMin + 1));
    const oldLevel = levelFromXp(user.xp);
    user.xp += gain;
    user.lastXpAt = now;
    const newLevel = levelFromXp(user.xp);

    writeUser(serverId, authorId, user);

    if (newLevel > oldLevel) {
      handleLevelUp(client, message, serverId, authorId, user.name, oldLevel, newLevel).catch((error) => {
        console.warn('[leveling] level-up handling failed:', (error as any)?.message || error);
      });
    }
  } catch (error) {
    console.warn('[leveling] recordMessageXp failed:', (error as any)?.message || error);
  }
}

async function handleLevelUp(
  client: any,
  message: any,
  serverId: string,
  userId: string,
  name: string,
  oldLevel: number,
  newLevel: number,
) {
  const { config: cfg, roleRewards } = settings(serverId);

  const rewardResult = await applyRoleRewards(client, serverId, userId, newLevel, roleRewards, cfg.stackRoles);

  if (cfg.announce) {
    await announceLevelUp(client, message, cfg, userId, name, newLevel, rewardResult.awardedRoleIds);
  }
}

type RewardResult = { awardedRoleIds: string[] };

async function applyRoleRewards(
  client: any,
  serverId: string,
  userId: string,
  level: number,
  rewards: RoleReward[],
  stackRoles: boolean,
): Promise<RewardResult> {
  const empty: RewardResult = { awardedRoleIds: [] };
  if (rewards.length === 0) return empty;

  // Reward roles the member should have earned by now.
  const earned = rewards.filter((r) => r.level <= level);
  if (earned.length === 0) return empty;

  const currentRoleIds = await fetchMemberRoleIds(client, serverId, userId);
  if (!currentRoleIds) {
    console.warn(`[leveling] Role rewards skipped: could not fetch member ${userId} in server ${serverId}.`);
    return empty;
  }

  const allRewardRoleIds = new Set(rewards.map((r) => r.roleId));
  const current = new Set(currentRoleIds);

  let target: string[];
  const awardedRoleIds: string[] = [];

  if (stackRoles) {
    target = [...currentRoleIds];
    for (const reward of earned) {
      if (!current.has(reward.roleId)) {
        target.push(reward.roleId);
        awardedRoleIds.push(reward.roleId);
      }
    }
  } else {
    // Keep only the single highest earned reward role.
    const highest = earned[earned.length - 1];
    target = currentRoleIds.filter((id) => !allRewardRoleIds.has(id) || id === highest.roleId);
    if (!current.has(highest.roleId)) {
      target.push(highest.roleId);
      awardedRoleIds.push(highest.roleId);
    }
  }

  const nextRoleIds = Array.from(new Set(target.filter(Boolean)));
  const changed =
    nextRoleIds.length !== currentRoleIds.length ||
    nextRoleIds.some((id) => !current.has(id));

  if (!changed) return { awardedRoleIds: [] };

  try {
    await patchMemberRoles(client, serverId, userId, nextRoleIds);
    if (awardedRoleIds.length > 0) {
      console.log(`✅ Awarded level ${level} role(s) ${awardedRoleIds.join(', ')} to user ${userId}.`);
    }
  } catch (error) {
    console.warn('[leveling] Failed to apply reward roles:', (error as any)?.message || error);
    return empty;
  }

  return { awardedRoleIds };
}

async function announceLevelUp(
  client: any,
  message: any,
  cfg: LevelingConfig,
  userId: string,
  name: string,
  level: number,
  awardedRoleIds: string[],
) {
  const channel = cfg.announceChannelId
    ? await resolveTextChannel(client, cfg.announceChannelId)
    : message?.channel && typeof message.channel.send === 'function'
      ? message.channel
      : null;

  if (!channel) return;

  let content = `🎉 <@${userId}> leveled up to **Level ${level}**!`;
  if (awardedRoleIds.length > 0) {
    const roleText = awardedRoleIds.map((id) => `<%${id}>`).join(', ');
    content += `\nUnlocked ${awardedRoleIds.length > 1 ? 'roles' : 'role'}: ${roleText}`;
  }

  try {
    await channel.send({ content });
  } catch (error) {
    console.warn('[leveling] Failed to send level-up announcement:', (error as any)?.message || error);
  }
}

async function resolveTextChannel(client: any, channelId: string) {
  const channel = client.channels?.cache?.get?.(channelId) || (await client.channels?.fetch?.(channelId).catch(() => null));
  if (!channel || (typeof channel.isText === 'function' && !channel.isText())) return null;
  return typeof channel.send === 'function' ? channel : null;
}

/* ---------------------------------------------------------------------------
 * Role assignment helpers (mirror the reaction-role / join-role fetch pattern)
 * ------------------------------------------------------------------------- */

async function fetchMemberRoleIds(client: any, serverId: string, userId: string): Promise<string[] | null> {
  try {
    if (typeof client?.api?.get === 'function') {
      const rawMember = await client.api.get(`/servers/${serverId}/members/${userId}`);
      return getRoleIds(rawMember?.roles);
    }
  } catch (error) {
    console.warn('[leveling] raw member fetch failed:', (error as any)?.message || error);
  }

  try {
    const server = client.servers?.cache?.get?.(serverId) || (await client.servers?.fetch?.(serverId).catch(() => null));
    const member = await server?.members?.fetch?.(userId).catch(() => null);
    return member ? getRoleIds(member.roles) : null;
  } catch {
    return null;
  }
}

async function patchMemberRoles(client: any, serverId: string, userId: string, roleIds: string[]) {
  const token = getClientToken(client);
  if (!token) throw new Error('missing bot token for level-role assignment');

  const baseUrl = getApiBaseUrl(client);
  const response = await fetch(
    `${baseUrl}/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
        'Content-Type': 'application/json',
        'User-Agent': 'YetAnotherOverengineeredStoatBot level-role assignment',
      },
      body: JSON.stringify({ roles: roleIds }),
    },
  );

  if (response.ok) return;

  const text = await response.text().catch(() => '');
  let detail = response.statusText;
  try {
    const parsed = JSON.parse(text);
    detail = parsed?.type || detail;
  } catch {
    if (text) detail = text;
  }

  throw new Error(`API call failed with status ${response.status}: ${detail}`);
}

export function getAvatarCdnUrl(client: any, avatarId: string | null): string | null {
  if (!avatarId) return null;
  const base = String(
    client?.options?.rest?.instanceCDNURL ||
      client?.configuration?.features?.autumn?.url ||
      DEFAULT_CDN_URL,
  ).replace(/\/+$/, '');
  return `${base}/avatars/${encodeURIComponent(avatarId)}`;
}
