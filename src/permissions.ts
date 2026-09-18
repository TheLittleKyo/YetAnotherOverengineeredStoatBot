import { currentBotPermission, resolveBotPermission } from './bot-permissions.js';

/**
 * Stoat Permission Bitfield Values
 * Based on: https://developers.stoat.chat/developers/api/permissions.html
 */
export const Permission = {
  ManageChannel: 1n << 0n,
  ManageServer: 1n << 1n,
  ManagePermissions: 1n << 2n,
  ManageRole: 1n << 3n,
  ManageCustomisation: 1n << 4n,
  KickMembers: 1n << 6n,
  BanMembers: 1n << 7n,
  TimeoutMembers: 1n << 8n,
  AssignRoles: 1n << 9n,
  ChangeNickname: 1n << 10n,
  ManageNicknames: 1n << 11n,
  ChangeAvatar: 1n << 12n,
  RemoveAvatars: 1n << 13n,
  ViewChannel: 1n << 20n,
  ReadMessageHistory: 1n << 21n,
  SendMessage: 1n << 22n,
  ManageMessages: 1n << 23n,
  ManageWebhooks: 1n << 24n,
  InviteOthers: 1n << 25n,
  SendEmbeds: 1n << 26n,
  UploadFiles: 1n << 27n,
  Masquerade: 1n << 28n,
  React: 1n << 29n,
  Connect: 1n << 30n,
  Speak: 1n << 31n,
  Video: 1n << 32n,
  MuteMembers: 1n << 33n,
  DeafenMembers: 1n << 34n,
  MoveMembers: 1n << 35n,
};

/**
 * Permission presets for ticket channels
 */
export const TicketPermissions = {
  // Full access for ticket creator and support
  fullAccess: Number(
    Permission.ViewChannel |
    Permission.ReadMessageHistory |
    Permission.SendMessage |
    Permission.SendEmbeds |
    Permission.UploadFiles |
    Permission.React
  ),
  
  // Deny all permissions (for @everyone)
  denyAll: Number(
    Permission.ViewChannel |
    Permission.ReadMessageHistory |
    Permission.SendMessage
  ),
};

/**
 * Check if a user has a specific role
 * @param {Object} member - Server member object
 * @param {string} roleId - Role ID to check
 * @returns {boolean}
 */
export function hasRole(member, roleId) {
  if (!member || !member.roleIds) {
    return false;
  }
  // roleIds can be a Set or array
  if (member.roleIds instanceof Set) {
    return member.roleIds.has(roleId);
  }
  return Array.from(member.roleIds || []).includes(roleId);
}

/**
 * Check if a user is support staff
 * @param {Object} member - Server member object
 * @param {string} supportRoleId - Support role ID
 * @returns {boolean}
 */
export function isSupportStaff(member, supportRoleId) {
  return hasRole(member, supportRoleId);
}

/**
 * Support-staff check for ticket commands that also honors the dashboard's
 * "Ticket staff" bot permission: an allowed role counts as staff, a denied role
 * does not, even when it holds the support role.
 */
export async function isTicketStaff(client, serverId: string, userId: string, member, supportRoleId): Promise<boolean> {
  const decision = await resolveBotPermission(client, serverId, userId, 'tickets.staff');
  if (decision) return decision === 'allow';
  return !!member && isSupportStaff(member, supportRoleId);
}

/**
 * Fetch the ServerMember for the message author, with cache fallback.
 */
async function fetchMember(message, client) {
  const serverId = message?.serverId;
  if (!serverId) return null;

  let server = null;
  try {
    server = await client.servers.fetch(serverId);
  } catch {
    server = client.servers.cache.get(serverId);
  }
  if (!server) return null;

  const authorId = message.authorId;
  try {
    return await server.members.fetch(authorId);
  } catch {
    return server.members?.cache?.get?.(authorId) || null;
  }
}

/**
 * Check if the message author holds any of the named permissions.
 * Tries every known spelling a Stoat client lib might expose
 * (camelCase + SCREAMING_SNAKE).
 *
 * @param message  Stoat message that triggered the command
 * @param client   Stoat client
 * @param wanted   Array of permission names to accept (any match passes)
 * @returns true if the author holds at least one of the wanted permissions
 */
export async function hasPermission(message, client, wanted: string[]): Promise<boolean> {
  if (!message || !client) return false;
  const names = Array.isArray(wanted) ? wanted : [wanted];
  if (names.length === 0) return false;

  try {
    // Dashboard bot permission for the running command's feature, if any.
    const decision = await currentBotPermission(client, message.serverId, message.authorId);
    if (decision) return decision === 'allow';

    const member = await fetchMember(message, client);
    if (!member) return false;

    // Owner override — Stoat server owners always pass.
    if (member.serverOwner === true || member.owner === true) return true;

    // Try every spelling the lib might expose (camelCase + SCREAMING_SNAKE).
    const variants = new Set<string>();
    for (const name of names) {
      variants.add(name);
      variants.add(name.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase());
    }

    if (typeof member.hasPermission === 'function') {
      for (const perm of variants) {
        try {
          if (member.hasPermission(perm)) return true;
        } catch {
          // try next spelling
        }
      }
    }
  } catch (error) {
    console.warn('hasPermission check failed:', error?.message || error);
  }

  return false;
}

/**
 * Guard a command: if the author lacks the required permission, reply with
 * a friendly error and return false. Caller should early-return on false.
 *
 * Example:
 *   if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
 */
export async function requirePermission(
  message,
  client,
  wanted: string[],
  label: string,
): Promise<boolean> {
  const allowed = await hasPermission(message, client, wanted);
  if (allowed) return true;

  await message.channel?.send({
    content: `❌ You need **${label}** permission to use this command.`,
  });
  return false;
}

/**
 * `ManageServer` check for a specific server, used by the per-server config
 * commands (antiraid, autoreact, autoresponder, backup, captcha, reminder,
 * sync). Kept separate from `hasPermissionInServer`: this one prefers the
 * cached server over a fetch and grants no server-owner override, matching
 * what those commands have always enforced.
 */
export async function canManageServerById(client: any, serverId: string, userId: string): Promise<boolean> {
  if (!serverId) return false;

  const decision = await currentBotPermission(client, serverId, userId);
  if (decision) return decision === 'allow';

  let server = client?.servers?.cache?.get?.(serverId) || null;
  if (!server) {
    server = await client?.servers?.fetch?.(serverId).catch(() => null);
  }

  const member = await server?.members
    ?.fetch?.(userId)
    .catch(() => server?.members?.cache?.get?.(userId) || null);
  if (!member || typeof member.hasPermission !== 'function') return false;

  for (const permission of ['ManageServer', 'MANAGE_SERVER']) {
    try {
      if (member.hasPermission(permission)) return true;
    } catch {
      // try next spelling
    }
  }

  return false;
}

/**
 * Resolve a member in an explicit server (not the one the message came from).
 */
async function fetchMemberInServer(client, serverId: string, userId: string) {
  if (!serverId || !userId) return null;

  let server = null;
  try {
    server = await client?.servers?.fetch?.(serverId);
  } catch {
    server = client?.servers?.cache?.get?.(serverId) || null;
  }
  if (!server) return null;

  try {
    return await server.members.fetch(userId);
  } catch {
    return server.members?.cache?.get?.(userId) || null;
  }
}

/**
 * Check whether a user holds one of `wanted` in a SPECIFIC server.
 *
 * Commands that accept a server or channel argument must authorize against the
 * server they are about to act on — checking the caller's own server would let
 * an admin of any server the bot joined operate on every other server.
 */
export async function hasPermissionInServer(
  client,
  serverId: string,
  userId: string,
  wanted: string[],
): Promise<boolean> {
  const names = Array.isArray(wanted) ? wanted : [wanted];
  if (!client || !serverId || !userId || names.length === 0) return false;

  try {
    // Rules come from the server being checked, never the one the command was typed in.
    const decision = await currentBotPermission(client, serverId, userId);
    if (decision) return decision === 'allow';

    const member = await fetchMemberInServer(client, serverId, userId);
    if (!member) return false;

    if (member.serverOwner === true || member.owner === true) return true;

    const variants = new Set<string>();
    for (const name of names) {
      variants.add(name);
      variants.add(name.replace(/([A-Z])/g, '_$1').replace(/^_/, '').toUpperCase());
    }

    if (typeof member.hasPermission === 'function') {
      for (const perm of variants) {
        try {
          if (member.hasPermission(perm)) return true;
        } catch {
          // try next spelling
        }
      }
    }
  } catch (error) {
    console.warn('hasPermissionInServer check failed:', error?.message || error);
  }

  return false;
}

/**
 * Guard a command against the server it is about to act on. Replies and returns
 * false when the author lacks the permission in THAT server.
 */
export async function requirePermissionInServer(
  message,
  client,
  serverId: string,
  wanted: string[],
  label: string,
): Promise<boolean> {
  if (!serverId) {
    await message.channel?.send({ content: '❌ Could not determine the target server for this command.' });
    return false;
  }

  if (await hasPermissionInServer(client, serverId, message?.authorId, wanted)) return true;

  await message.channel?.send({
    content: `❌ You need **${label}** permission in the target server (\`${serverId}\`) to use this command.`,
  });
  return false;
}

/**
 * Resolve the server a channel belongs to, or null for DM/group channels.
 */
export async function resolveChannelServerId(client, channelId: string): Promise<string | null> {
  if (!channelId) return null;
  const channel =
    client?.channels?.cache?.get?.(channelId) ||
    (await client?.channels?.fetch?.(channelId).catch(() => null));
  if (!channel) return null;
  const serverId = channel.serverId || channel.server_id || channel.server?.id || channel.server?._id || null;
  return serverId ? String(serverId) : null;
}

/**
 * Guard a command against the server that owns `channelId`.
 */
export async function requirePermissionForChannel(
  message,
  client,
  channelId: string,
  wanted: string[],
  label: string,
): Promise<boolean> {
  const serverId = await resolveChannelServerId(client, channelId);
  if (!serverId) {
    await message.channel?.send({
      content: `❌ Channel \`${channelId}\` is not a server channel, or the bot cannot see it.`,
    });
    return false;
  }
  return requirePermissionInServer(message, client, serverId, wanted, label);
}
