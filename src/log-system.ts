import { MessageEmbed } from 'stoatbot.js';
import { config as botConfig } from './config.js';
import { basename } from 'node:path';
import { dataFile, readJson, registerDataFileHooks, writeJson } from './json-store.js';
import { debug } from './logger.js';
import type { StoatClient } from './stoat-types.js';

type LogConfig = {
  enabled: boolean;
  channelId?: string;
};

// Per-server log config. Keyed by serverId so each server has its own log
// channel. Legacy files were a single flat `{ enabled, channelId }`; those are
// migrated on read to belong to the configured default server.
type LogConfigFile = {
  servers: Record<string, LogConfig>;
};

const LOG_CONFIG_FILE = dataFile('log-config.json');

// Every logged event (edits, deletes, joins, role changes…) checks the config,
// so it is parsed once and served from memory. This process is the only
// writer; a backup restore replaces the file, so the copy is dropped then.
let logConfigCache: LogConfigFile | null = null;
registerDataFileHooks(basename(LOG_CONFIG_FILE), { reload: () => { logConfigCache = null; } });

function readLogConfigFile(): LogConfigFile {
  if (!logConfigCache) logConfigCache = parseLogConfigFile();
  return logConfigCache;
}

function parseLogConfigFile(): LogConfigFile {
  const parsed = readJson<any>(LOG_CONFIG_FILE, { servers: {} });
  // New shape: { servers: { [id]: {enabled, channelId} } }.
  if (parsed && typeof parsed.servers === 'object' && parsed.servers) {
    const servers: Record<string, LogConfig> = {};
    for (const [id, value] of Object.entries<any>(parsed.servers)) {
      servers[id] = { enabled: !!value?.enabled, channelId: value?.channelId || undefined };
    }
    return { servers };
  }
  // Legacy flat shape → attribute to the default server.
  if (parsed && (typeof parsed.enabled === 'boolean' || parsed.channelId)) {
    const legacyServer = botConfig.serverId || '';
    return { servers: legacyServer ? { [legacyServer]: { enabled: !!parsed.enabled, channelId: parsed.channelId || undefined } } : {} };
  }
  return { servers: {} };
}

function writeLogConfigFile(data: LogConfigFile) {
  logConfigCache = data;
  writeJson(LOG_CONFIG_FILE, data);
}

// Server IDs that currently have logging enabled with a channel set. Used to
// fan out inherently server-less events (e.g. global user profile updates).
function getLoggingServerIds(): string[] {
  const file = readLogConfigFile();
  return Object.entries(file.servers)
    .filter(([, cfg]) => cfg?.enabled && cfg?.channelId)
    .map(([id]) => id);
}

// Best-effort extraction of the origin server ID from an event payload
// (message / channel / member / role / server object), covering the several
// shapes stoatbot.js and the raw Revolt API use.
function extractServerId(value: any): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return (
    (typeof value.serverId === 'string' && value.serverId) ||
    (typeof value.server_id === 'string' && value.server_id) ||
    (typeof value?.id?.server === 'string' && value.id.server) ||
    (typeof value?._id?.server === 'string' && value._id.server) ||
    (typeof value?.server?._id === 'string' && value.server._id) ||
    (typeof value?.server?.id === 'string' && value.server.id) ||
    (typeof value?.channel?.serverId === 'string' && value.channel.serverId) ||
    (typeof value?.channel?.server_id === 'string' && value.channel.server_id) ||
    undefined
  );
}

// Resolve which server a channel belongs to using the client cache. Fallback
// path when an event payload does not carry the server inline (common for
// message create/update/delete events).
function resolveServerIdFromChannel(client: any, channelId: string | undefined): string | undefined {
  if (!channelId) return undefined;
  const channel = client?.channels?.cache?.get?.(channelId);
  if (!channel) return undefined;
  return (
    (typeof channel.serverId === 'string' && channel.serverId) ||
    (typeof channel.server_id === 'string' && channel.server_id) ||
    (typeof channel?.server?._id === 'string' && channel.server._id) ||
    (typeof channel?.server?.id === 'string' && channel.server.id) ||
    undefined
  );
}

// Whether `userId` is a member of `serverId` per the client cache (best-effort).
function isMemberOfServer(client: any, serverId: string, userId: string): boolean {
  try {
    const server = client?.servers?.cache?.get?.(serverId);
    const members = server?.members?.cache;
    if (!members || typeof members.get !== 'function') return true; // cache cold → don't filter
    return members.get(userId) != null || members.get(`${serverId}:${userId}`) != null;
  } catch {
    return true;
  }
}

function readLogConfig(serverId = botConfig.serverId): LogConfig {
  // A copy: callers get a value, never a handle on the shared cached entry.
  return { ...(readLogConfigFile().servers[serverId] || { enabled: false }) };
}

export function getLogConfig(serverId = botConfig.serverId) {
  return readLogConfig(serverId);
}

export function setLogChannel(channelId: string, serverId = botConfig.serverId) {
  const file = readLogConfigFile();
  const next: LogConfig = { enabled: true, channelId };
  file.servers[serverId] = next;
  writeLogConfigFile(file);
  return next;
}

export function disableLogChannel(serverId = botConfig.serverId) {
  const file = readLogConfigFile();
  const next: LogConfig = { ...(file.servers[serverId] || { enabled: false }), enabled: false };
  file.servers[serverId] = next;
  writeLogConfigFile(file);
  return next;
}

export async function sendServerLog(client: StoatClient, payload: {
  title: string;
  description: string;
  colour?: string;
}, serverId = botConfig.serverId) {
  const config = readLogConfig(serverId);
  if (!config.enabled || !config.channelId) {
    debug('logs', () => `dropped "${payload.title}" — logging not enabled for server ${serverId || '(none)'}`);
    return false;
  }

  try {
    const channel = client.channels.cache.get(config.channelId) || (await client.channels.fetch(config.channelId).catch(() => null));
    if (!channel) {
      debug('logs', () => `log channel ${config.channelId} for server ${serverId} not found`);
      return false;
    }

    const embed = new MessageEmbed()
      .setTitle(`📝 ${payload.title}`)
      .setDescription(normalizeEmbedDescription(payload.description))
      .setColor(payload.colour || '#f59e0b');

    try {
      await channel.send({
        embeds: [embed],
      });
    } catch (embedError) {
      // Fallback to plain text if embed building/sending fails at runtime.
      const body = `# 📝 ${payload.title}\n\n${payload.description || '*[no details]*'}`;
      const chunks = splitContent(body, 1800);

      for (const chunk of chunks) {
        await channel.send({ content: chunk });
      }

      console.warn('Embed send failed, used text fallback:', embedError?.message || embedError);
    }

    return true;
  } catch (error) {
    console.error('Failed to send server log:', error?.message || error);
    return false;
  }
}

export async function logPurgeAction(client, payload: {
  action: string;
  executorId?: string;
  targetUserId?: string | null;
  channelScope?: string;
  matched?: number;
  deleted?: number;
  failed?: number;
  scanned?: number;
  channels?: number;
  scanLimit?: number;
  command?: string;
  serverId?: string | null;
}) {
  const lines = [
    `**Action:** ${payload.action}`,
    `**Executor:** ${formatUser(payload.executorId)}`,
    `**Target User:** ${payload.targetUserId ? formatUser(payload.targetUserId) : 'Anyone'}`,
    `**Channel Scope:** ${payload.channelScope || 'Unknown'}`,
  ];

  if (typeof payload.matched === 'number') lines.push(`**Matched:** ${payload.matched}`);
  if (typeof payload.deleted === 'number') lines.push(`**Deleted:** ${payload.deleted}`);
  if (typeof payload.failed === 'number') lines.push(`**Failed:** ${payload.failed}`);
  if (typeof payload.scanned === 'number') lines.push(`**Scanned:** ${payload.scanned}`);
  if (typeof payload.channels === 'number') lines.push(`**Channels:** ${payload.channels}`);
  if (typeof payload.scanLimit === 'number') lines.push(`**Scan Limit:** ${payload.scanLimit}`);
  if (payload.command) lines.push(`**Command:** ${formatContent(payload.command)}`);

  await sendServerLog(client, {
    title: 'Purge / MassEliminate',
    colour: payload.deleted && payload.deleted > 0 ? '#ef4444' : '#6366f1',
    description: lines.join('\n'),
  }, payload.serverId || undefined);
}

export async function logStatsAction(client, payload: {
  action: string;
  executorId?: string;
  channelId?: string | null;
  roleId?: string | null;
  label?: string | null;
  configured?: number;
  updated?: number;
  skipped?: number;
  command?: string;
  serverId?: string | null;
}) {
  const lines = [
    `**Action:** ${payload.action}`,
    `**Executor:** ${formatUser(payload.executorId)}`,
  ];

  if (payload.channelId) lines.push(`**Stats Channel:** ${formatChannel(payload.channelId)} (\`${payload.channelId}\`)`);
  if (payload.roleId) lines.push(`**Tracked Role:** ${formatRole(payload.roleId)} (\`${payload.roleId}\`)`);
  if (payload.label) lines.push(`**Label:** ${formatContent(payload.label)}`);
  if (typeof payload.configured === 'number') lines.push(`**Configured:** ${payload.configured}`);
  if (typeof payload.updated === 'number') lines.push(`**Updated:** ${payload.updated}`);
  if (typeof payload.skipped === 'number') lines.push(`**Skipped:** ${payload.skipped}`);
  if (payload.command) lines.push(`**Command:** ${formatContent(payload.command)}`);

  await sendServerLog(client, {
    title: 'Stats Command',
    colour: '#0ea5e9',
    description: lines.join('\n'),
  }, payload.serverId || undefined);
}

export async function logTicketAction(client, payload: {
  action: string;
  ticketId?: string | number | null;
  executorId?: string | null;
  creatorId?: string | null;
  channelId?: string | null;
  reason?: string | null;
  details?: string | null;
  serverId?: string | null;
}) {
  const lines = [
    `**Action:** ${payload.action}`,
  ];

  if (payload.ticketId) lines.push(`**Ticket:** #${payload.ticketId}`);
  if (payload.executorId) lines.push(`**Executor:** ${formatUser(payload.executorId)}`);
  if (payload.creatorId) lines.push(`**Creator:** ${formatUser(payload.creatorId)}`);
  if (payload.channelId) lines.push(`**Channel:** ${formatChannel(payload.channelId)} (\`${payload.channelId}\`)`);
  if (payload.reason) lines.push(`**Reason:** ${formatContent(payload.reason)}`);
  if (payload.details) lines.push(`**Details:** ${formatContent(payload.details)}`);

  await sendServerLog(client, {
    title: 'Ticket Command',
    colour: '#22c55e',
    description: lines.join('\n'),
  }, payload.serverId || undefined);
}

export async function logPermissionAction(client, payload: {
  action: string;
  executorId?: string | null;
  sourceChannelId?: string | null;
  targetChannelId?: string | null;
  targetCategoryId?: string | null;
  updated?: number;
  failed?: number;
  roleOverwrites?: number;
  includeDefault?: boolean;
  command?: string;
  serverId?: string | null;
}) {
  const lines = [
    `**Action:** ${payload.action}`,
    `**Executor:** ${formatUser(payload.executorId)}`,
  ];

  if (payload.sourceChannelId) lines.push(`**Source Channel:** ${formatChannel(payload.sourceChannelId)} (\`${payload.sourceChannelId}\`)`);
  if (payload.targetChannelId) lines.push(`**Target Channel:** ${formatChannel(payload.targetChannelId)} (\`${payload.targetChannelId}\`)`);
  if (payload.targetCategoryId) lines.push(`**Target Category:** \`${payload.targetCategoryId}\``);
  if (typeof payload.updated === 'number') lines.push(`**Updated:** ${payload.updated}`);
  if (typeof payload.failed === 'number') lines.push(`**Failed:** ${payload.failed}`);
  if (typeof payload.roleOverwrites === 'number') lines.push(`**Role Overwrites:** ${payload.roleOverwrites}`);
  if (typeof payload.includeDefault === 'boolean') lines.push(`**Default Permissions:** ${payload.includeDefault ? 'Copied' : 'Skipped'}`);
  if (payload.command) lines.push(`**Command:** ${formatContent(payload.command)}`);

  await sendServerLog(client, {
    title: 'Mass Permissions',
    colour: payload.failed && payload.failed > 0 ? '#f59e0b' : '#06b6d4',
    description: lines.join('\n'),
  }, payload.serverId || undefined);
}

function normalizeEmbedDescription(value: string): string {
  const text = String(value || '*[no details]*').trim();
  if (text.length <= 4000) return text;
  return `${text.slice(0, 3997)}...`;
}

function splitContent(content: string, maxLength: number): string[] {
  const safe = String(content || '').trim();
  if (!safe) return ['*[empty]*'];
  if (safe.length <= maxLength) return [safe];

  const chunks: string[] = [];
  let remaining = safe;

  while (remaining.length > maxLength) {
    let cut = remaining.lastIndexOf('\n', maxLength);
    if (cut < Math.floor(maxLength * 0.6)) {
      cut = maxLength;
    }

    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

export async function logMessageDelete(client: StoatClient, message) {
  if (!message) return;
  const serverId = extractServerId(message) || resolveServerIdFromChannel(client, message.channelId);
  await sendServerLog(client, {
    title: 'Message Deleted',
    colour: '#ef4444',
    description:
      `**Channel:** ${formatChannel(message.channelId)}\n` +
      `**Author:** ${formatUser(message.authorId)}\n` +
      `**Message ID:** \`${message.id || 'unknown'}\`\n` +
      `**Content:** ${formatContent(message.content)}`,
  }, serverId);
}

export async function logMessageUpdate(client: StoatClient, oldMessage, newMessage) {
  if (!newMessage && !oldMessage) return;

  const before = oldMessage?.content || '';
  const after = newMessage?.content || '';

  if (before === after) return;

  const channelId = newMessage?.channelId || oldMessage?.channelId;
  const serverId = extractServerId(newMessage) || extractServerId(oldMessage) || resolveServerIdFromChannel(client, channelId);
  await sendServerLog(client, {
    title: 'Message Edited',
    colour: '#f59e0b',
    description:
      `**Channel:** ${formatChannel(channelId)}\n` +
      `**Author:** ${formatUser(newMessage?.authorId || oldMessage?.authorId)}\n` +
      `**Message ID:** \`${newMessage?.id || oldMessage?.id || 'unknown'}\`\n` +
      `**Before:** ${formatContent(before)}\n` +
      `**After:** ${formatContent(after)}`,
  }, serverId);
}

export async function logChannelCreate(client: StoatClient, channel) {
  const serverId = extractServerId(channel) || resolveServerIdFromChannel(client, channel?.id);
  await sendServerLog(client, {
    title: 'Channel Created',
    colour: '#22c55e',
    description:
      `**Name:** ${channel?.name || 'unknown'}\n` +
      `**Type:** ${channel?.type || 'unknown'}\n` +
      `**ID:** \`${channel?.id || 'unknown'}\``,
  }, serverId);
}

export async function logChannelDelete(client: StoatClient, channel) {
  const serverId = extractServerId(channel) || resolveServerIdFromChannel(client, channel?.id);
  await sendServerLog(client, {
    title: 'Channel Deleted',
    colour: '#ef4444',
    description:
      `**Name:** ${channel?.name || 'unknown'}\n` +
      `**Type:** ${channel?.type || 'unknown'}\n` +
      `**ID:** \`${channel?.id || 'unknown'}\``,
  }, serverId);
}

export async function logChannelUpdate(client: StoatClient, oldChannel, newChannel) {
  const serverId =
    extractServerId(newChannel) ||
    extractServerId(oldChannel) ||
    resolveServerIdFromChannel(client, newChannel?.id || oldChannel?.id);
  await sendServerLog(client, {
    title: 'Channel Updated',
    colour: '#f59e0b',
    description:
      `**Channel:** ${formatChannel(newChannel?.id || oldChannel?.id)}\n` +
      `**Old Name:** ${oldChannel?.name || 'unknown'}\n` +
      `**New Name:** ${newChannel?.name || 'unknown'}`,
  }, serverId);
}

export async function logMemberJoin(client: StoatClient, member) {
  await sendServerLog(client, {
    title: 'Member Joined',
    colour: '#22c55e',
    description:
      `**User:** ${formatUser(extractMemberUserId(member) || member?.id || member?._id)}\n` +
      `**Username:** ${member?.user?.username || member?.username || 'unknown'}`,
  }, extractServerId(member));
}

export async function logMemberLeave(client: StoatClient, member) {
  await sendServerLog(client, {
    title: 'Member Left',
    colour: '#ef4444',
    description:
      `**User:** ${formatUser(extractMemberUserId(member) || member?.id || member?._id)}\n` +
      `**Username:** ${member?.user?.username || member?.username || 'unknown'}`,
  }, extractServerId(member));
}

/**
 * Roles added and removed between two member snapshots, without logging
 * anything — stats channels need the change even when the Logs module is off.
 */
export function diffMemberRoles(oldMember, newMember) {
  const oldRoles = normalizeRoles(oldMember);
  const newRoles = normalizeRoles(newMember);
  const added = newRoles.filter((id) => !oldRoles.includes(id));
  const removed = oldRoles.filter((id) => !newRoles.includes(id));
  return { changed: added.length > 0 || removed.length > 0, added, removed };
}

export async function logMemberUpdate(client: StoatClient, oldMember, newMember) {
  const userId = extractMemberUserId(newMember) || extractMemberUserId(oldMember);
  if (!userId) {
    // Diagnostic: log what we received so the structure can be inspected
    console.warn('[log-system] logMemberUpdate: could not extract userId. Member shape:', {
      newKeys: newMember ? Object.keys(newMember) : null,
      newId: newMember?.id,
      new_id: newMember?._id,
      oldKeys: oldMember ? Object.keys(oldMember) : null,
    });
    return { changed: false, skipped: true };
  }

  const { added, removed } = diffMemberRoles(oldMember, newMember);

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, skipped: true };
  }

  await sendServerLog(client, {
    title: 'Member Roles Updated',
    colour: '#3b82f6',
    description:
      `**User:** ${formatUser(userId)}\n` +
      `**Added Roles:** ${added.length ? added.map(formatRole).join(', ') : 'None'}\n` +
      `**Removed Roles:** ${removed.length ? removed.map(formatRole).join(', ') : 'None'}`,
  }, extractServerId(newMember) || extractServerId(oldMember));

  return { changed: true, skipped: false, userId, added, removed };
}

export async function logMemberProfileUpdate(client: StoatClient, oldMember, newMember) {
  const userId = extractMemberUserId(newMember) || extractMemberUserId(oldMember);
  if (!userId) {
    console.warn('[log-system] logMemberProfileUpdate: could not extract userId. Member shape:', {
      newKeys: newMember ? Object.keys(newMember) : null,
      newId: newMember?.id,
      new_id: newMember?._id,
    });
    return { changed: false, skipped: true };
  }

  const oldNick = String(oldMember?.nickname || '').trim();
  const newNick = String(newMember?.nickname || '').trim();

  const oldAvatar = extractMemberAvatarId(oldMember);
  const newAvatar = extractMemberAvatarId(newMember);

  const nicknameChanged = oldNick !== newNick;
  const avatarChanged = oldAvatar !== newAvatar;

  if (!nicknameChanged && !avatarChanged) {
    return { changed: false, skipped: true };
  }

  const sections: string[] = [
    `**User:** ${formatUser(userId)}`,
  ];

  if (nicknameChanged) {
    sections.push(
      `**Nickname:** ${oldNick || '*none*'} → ${newNick || '*none*'}`
    );
  }

  if (avatarChanged) {
    const beforeAvatarLink = formatAvatarIdAsLink(client, oldAvatar);
    const afterAvatarLink = formatAvatarIdAsLink(client, newAvatar);

    sections.push(
      `**Server Avatar:** ${beforeAvatarLink} → ${afterAvatarLink}`
    );
  }

  await sendServerLog(client, {
    title: 'Member Profile Updated',
    colour: '#14b8a6',
    description: sections.join('\n'),
  }, extractServerId(newMember) || extractServerId(oldMember));

  return {
    changed: true,
    skipped: false,
    userId,
    nicknameChanged,
    avatarChanged,
  };
}

export async function logUserUpdate(client: StoatClient, oldUser, newUser) {
  const userId = extractId(newUser) || extractId(oldUser);
  if (!userId) {
    return { changed: false, skipped: true };
  }

  const beforeUsername = String(oldUser?.username || '').trim();
  const afterUsername = String(newUser?.username || '').trim();

  const beforeDisplay = String(oldUser?.displayName || '').trim();
  const afterDisplay = String(newUser?.displayName || '').trim();

  const beforeAvatar = extractAvatarId(oldUser);
  const afterAvatar = extractAvatarId(newUser);

  const changedUsername = beforeUsername !== afterUsername;
  const changedDisplay = beforeDisplay !== afterDisplay;
  const changedAvatar = beforeAvatar !== afterAvatar;

  if (!changedUsername && !changedDisplay && !changedAvatar) {
    return { changed: false, skipped: true };
  }

  const lines: string[] = [
    `**User:** ${formatUser(userId)}`,
  ];

  if (changedUsername) {
    lines.push(`**Username:** ${beforeUsername || '*none*'} → ${afterUsername || '*none*'}`);
  }

  if (changedDisplay) {
    lines.push(`**Display Name:** ${beforeDisplay || '*none*'} → ${afterDisplay || '*none*'}`);
  }

  if (changedAvatar) {
    const beforeAvatarLink = formatAvatarIdAsLink(client, beforeAvatar);
    const afterAvatarLink = formatAvatarIdAsLink(client, afterAvatar);
    lines.push(`**Avatar:** ${beforeAvatarLink} → ${afterAvatarLink}`);
  }

  // A user profile change is server-less: the same user may be in several
  // servers the bot serves. Fan the log out to every server that has logging
  // enabled AND (best-effort) contains this user, so each server's log channel
  // sees the change instead of only the configured default server.
  const payload = {
    title: 'User Updated',
    colour: '#8b5cf6',
    description: lines.join('\n'),
  };
  const targets = getLoggingServerIds().filter((serverId) => isMemberOfServer(client, serverId, userId));
  if (targets.length === 0) {
    // No membership match (or cold cache) → fall back to default-server behavior.
    await sendServerLog(client, payload);
  } else {
    for (const serverId of targets) {
      await sendServerLog(client, payload, serverId);
    }
  }

  return {
    changed: true,
    skipped: false,
    userId,
    changedUsername,
    changedDisplay,
    changedAvatar,
  };
}

export async function logRoleCreate(client: StoatClient, role) {
  const roleId = extractId(role) || 'unknown';

  await sendServerLog(client, {
    title: 'Role Created',
    colour: '#22c55e',
    description:
      `**Role:** ${formatRole(roleId)}\n` +
      `**Name:** ${role?.name || 'unknown'}\n` +
      `**ID:** \`${roleId}\``,
  }, extractServerId(role));
}

export async function logRoleDelete(client: StoatClient, role) {
  const roleId = extractId(role) || 'unknown';

  await sendServerLog(client, {
    title: 'Role Deleted',
    colour: '#ef4444',
    description:
      `**Role:** ${formatRole(roleId)}\n` +
      `**Name:** ${role?.name || 'unknown'}\n` +
      `**ID:** \`${roleId}\``,
  }, extractServerId(role));
}

export async function logRoleUpdate(client: StoatClient, oldRole, newRole) {
  const roleId = extractId(newRole) || extractId(oldRole) || 'unknown';

  await sendServerLog(client, {
    title: 'Role Updated',
    colour: '#f59e0b',
    description:
      `**Role:** ${formatRole(roleId)}\n` +
      `**Old Name:** ${oldRole?.name || 'unknown'}\n` +
      `**New Name:** ${newRole?.name || 'unknown'}`,
  }, extractServerId(newRole) || extractServerId(oldRole));
}

export async function logServerUpdate(client: StoatClient, oldServer, newServer) {
  // For a server object the identity fields ARE the origin server id.
  const serverId =
    (typeof newServer?.id === 'string' && newServer.id) ||
    (typeof newServer?._id === 'string' && newServer._id) ||
    (typeof oldServer?.id === 'string' && oldServer.id) ||
    (typeof oldServer?._id === 'string' && oldServer._id) ||
    undefined;
  await sendServerLog(client, {
    title: 'Server Updated',
    colour: '#a855f7',
    description:
      `**Old Name:** ${oldServer?.name || 'unknown'}\n` +
      `**New Name:** ${newServer?.name || 'unknown'}\n` +
      `**Server ID:** \`${newServer?.id || oldServer?.id || 'unknown'}\``,
  }, serverId);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a member's role list into a plain string-ID array.
 *
 * Handles: plain arrays, Sets, Maps (key = role ID), and revolt.js Collection
 * objects (which have a .values() iterator but are not plain Arrays/Sets).
 */
function normalizeRoles(member): string[] {
  const roles = member?.roles || member?.roleIds || member?.role_ids || [];

  let values: unknown[];

  if (Array.isArray(roles)) {
    values = roles;
  } else if (roles instanceof Set) {
    values = Array.from(roles);
  } else if (roles instanceof Map) {
    // Map<roleId, Role> — the keys are the IDs we want
    values = Array.from(roles.keys());
  } else if (roles && typeof roles === 'object' && typeof (roles as any).values === 'function') {
    // revolt.js / stoat.js Collection or any other iterable with .values()
    values = Array.from((roles as any).values());
  } else {
    values = [];
  }

  return values
    .map((role) => {
      if (typeof role === 'string') return role;
      return extractId(role);
    })
    .filter((id): id is string => !!id);
}

/**
 * Extract the plain user-ID string from a member object.
 *
 * Revolt/Stoat members carry a *composite* ID — either as:
 *   • member.id   = { server: string, user: string }   (revolt.js normalized)
 *   • member._id  = { server: string, user: string }   (raw Revolt API format)
 *
 * For members received through WebSocket events, revolt.js may not have
 * resolved member.user into a full User object yet, so we need to be able
 * to read the user ID directly from the composite key without relying on
 * a resolved reference.
 */
function extractMemberUserId(member): string | null {
  if (!member) return null;

  // --- 1. member.id composite (revolt.js normalized format) ---
  if (member.id && typeof member.id === 'object') {
    const uid = member.id.user ?? member.id.user_id ?? member.id.id;
    if (typeof uid === 'string' && uid) return uid;
    // uid might itself be a User object
    const resolved = extractId(uid);
    if (resolved) return resolved;
  }

  // --- 2. member._id composite (raw Revolt API / partially-parsed format) ---
  if (member._id && typeof member._id === 'object') {
    const uid = member._id.user ?? member._id.user_id ?? member._id.id;
    if (typeof uid === 'string' && uid) return uid;
    const resolved = extractId(uid);
    if (resolved) return resolved;
  }

  // --- 3. member.user (resolved User object OR bare string ID) ---
  if (member.user) {
    if (typeof member.user === 'string') return member.user;
    const fromUser = extractId(member.user);
    if (fromUser) return fromUser;
  }

  // --- 4. explicit userId / user_id fields ---
  const fromFields =
    (typeof member.userId === 'string' && member.userId ? member.userId : null) ||
    (typeof member.user_id === 'string' && member.user_id ? member.user_id : null) ||
    extractId(member.userId) ||
    extractId(member.user_id);
  if (fromFields) return fromFields;

  // --- 5. last resort: try extractId on the member itself (handles member.id as string) ---
  const direct = extractId(member);
  if (direct) return direct;

  return null;
}

/**
 * General-purpose ID extractor. Resolves strings, objects with known ID
 * fields, and nested User/Role objects.
 *
 * FIX: now also handles `value.user` when it is a plain *string* (not just
 * an object), which is the case for gateway-provided member payloads whose
 * user references have not yet been resolved by the client cache.
 * Also recurses into composite `_id` objects to extract the nested user field.
 */
function extractId(value): string | null {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (typeof value === 'object') {
    // Direct string ID fields
    const candidate =
      value.id ||
      value._id ||
      value.roleId ||
      value.role_id ||
      value.userId ||
      value.user_id ||
      value.value ||
      null;

    if (typeof candidate === 'string') {
      return candidate;
    }

    // candidate may itself be a composite object like { server, user }
    if (candidate && typeof candidate === 'object') {
      const nested =
        (typeof candidate.user === 'string' ? candidate.user : null) ||
        extractId(candidate.user) ||
        (typeof candidate.id === 'string' ? candidate.id : null) ||
        null;
      if (nested) return nested;
    }

    // Handle 'user' as a direct string ID (gateway events often skip resolution)
    if (typeof value.user === 'string' && value.user) {
      return value.user;
    }

    // Handle 'user' as a resolved User object
    if (value.user && typeof value.user === 'object') {
      return extractId(value.user);
    }
  }

  return null;
}

function extractAvatarId(entity): string | null {
  if (!entity) return null;

  const avatar = entity.avatar || entity.profile?.avatar || null;
  if (!avatar) return null;

  return (
    extractId(avatar) ||
    extractId(avatar._id) ||
    extractId(avatar.id) ||
    extractId(avatar.fileId) ||
    extractId(avatar.file_id) ||
    extractId(avatar.tag) ||
    null
  );
}

function extractMemberAvatarId(member): string | null {
  if (!member) return null;

  const direct = extractAvatarId(member);
  if (direct) return direct;

  return extractAvatarId(member.user);
}

function formatUser(userId) {
  const id = extractId(userId);
  if (!id || id === 'unknown') return 'Unknown';
  return `<@${id}> (\`${id}\`)`;
}

function formatRole(roleId) {
  const id = extractId(roleId);
  if (!id || id === 'unknown') return 'Unknown';
  return `<%${id}>`;
}

function formatChannel(channelId) {
  const id = extractId(channelId);
  if (!id || id === 'unknown') return 'Unknown';
  return `<#${id}>`;
}

function formatContent(content: string) {
  const value = String(content || '').trim();
  if (!value) return '*[empty]*';
  return value.length > 300 ? `${value.slice(0, 297)}...` : value;
}

function formatAvatarIdAsLink(client, avatarId: string | null) {
  if (!avatarId) return '*none*';

  const cdnBase = client?.options?.rest?.instanceCDNURL || 'https://autumn.stoat.chat';
  const url = `${String(cdnBase).replace(/\/$/, '')}/avatars/${avatarId}`;
  return `[\`${avatarId}\`](${url})`;
}