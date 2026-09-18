import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getClientToken, getApiBaseUrl } from './stoat-api.js';
import { getRoleIds } from './member-utils.js';
import { getReadableError as readableError } from './error-utils.js';
import { dataFile, ensureDataDir } from './json-store.js';

type ReactionRoleMapping = {
  emoji: string;
  roleId: string;
};

export type ReactionRoleMessage = {
  messageId: string;
  channelId: string;
  serverId: string;
  mappings: ReactionRoleMapping[];
};

type ReactionRolesFile = {
  messages: ReactionRoleMessage[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const REACTION_ROLES_FILE = dataFile('reaction-roles.json');
let reactionRolesCache: ReactionRolesFile | null = null;

function readReactionRolesFile(): ReactionRolesFile {
  if (reactionRolesCache) {
    return reactionRolesCache;
  }

  try {
    if (!existsSync(REACTION_ROLES_FILE)) {
      reactionRolesCache = { messages: [] };
      return reactionRolesCache;
    }

    const raw = readFileSync(REACTION_ROLES_FILE, 'utf-8').trim();
    if (!raw) {
      reactionRolesCache = { messages: [] };
      return reactionRolesCache;
    }

    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.messages)
      ? parsed.messages
      : Array.isArray(parsed?.panels)
        ? parsed.panels
        : [];

    reactionRolesCache = {
      messages,
    };
    return reactionRolesCache;
  } catch (error) {
    console.error('Failed to read reaction roles file:', error?.message || error);
    reactionRolesCache = { messages: [] };
    return reactionRolesCache;
  }
}

function writeReactionRolesFile(data: ReactionRolesFile) {
  reactionRolesCache = data;
  ensureDataDir();
  writeFileSync(REACTION_ROLES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function saveReactionRoleMessage(entry: ReactionRoleMessage) {
  const data = readReactionRolesFile();
  const existing = data.messages.find((item) => item.messageId === entry.messageId);
  const mappings = mergeMappings(existing?.mappings || [], entry.mappings);
  const nextEntry = { ...entry, mappings };
  const nextMessages = [...data.messages.filter((item) => item.messageId !== entry.messageId), nextEntry];
  writeReactionRolesFile({ messages: nextMessages });
}

export function deleteReactionRoleMessage(messageId: string, emojis: string[] = []): boolean {
  const data = readReactionRolesFile();
  const existing = data.messages.find((item) => item.messageId === messageId);
  if (!existing) return false;

  if (emojis.length === 0) {
    writeReactionRolesFile({ messages: data.messages.filter((item) => item.messageId !== messageId) });
    return true;
  }

  const removeSet = new Set(emojis);
  const nextMappings = existing.mappings.filter((item) => !removeSet.has(item.emoji));
  const nextMessages = data.messages
    .filter((item) => item.messageId !== messageId)
    .concat(nextMappings.length > 0 ? [{ ...existing, mappings: nextMappings }] : []);

  writeReactionRolesFile({ messages: nextMessages });
  return true;
}

export function getReactionRoleMessage(messageId: string): ReactionRoleMessage | null {
  const data = readReactionRolesFile();
  return data.messages.find((entry) => entry.messageId === messageId) || null;
}

export function getReactionRoleMessages(): ReactionRoleMessage[] {
  return readReactionRolesFile().messages;
}

export async function handleReactionRoleAdd({ client, messageId, userId, emoji }) {
  if (!messageId || !emoji) return false;

  const entry = getReactionRoleMessage(messageId);
  if (!entry) return false;

  const mapping = findMappingForEmoji(entry.mappings, emoji);
  if (!mapping) return false;

  if (!userId || userId === client.user?.id) return true;

  try {
    const serverId = entry.serverId || config.serverId;
    const server = await fetchServer(client, serverId);

    const roleIds = await fetchMemberRoleIds(client, server, serverId, userId);
    if (!roleIds) {
      console.warn(`Reaction role add skipped: could not fetch member ${userId} in server ${serverId}.`);
      return true;
    }

    if (!roleIds.includes(mapping.roleId)) {
      await setMemberRoles(client, server, serverId, userId, [...roleIds, mapping.roleId]);
      console.log(`✅ Applied reaction role ${mapping.roleId} to user ${userId}.`);
    }
  } catch (error) {
    console.error('Failed to apply reaction role:', error?.message || error);
  }

  return true;
}

export async function handleReactionRoleRemove({ client, messageId, userId, emoji }) {
  if (!messageId || !emoji) return false;

  const entry = getReactionRoleMessage(messageId);
  if (!entry) return false;

  const mapping = findMappingForEmoji(entry.mappings, emoji);
  if (!mapping) return false;

  if (!userId || userId === client.user?.id) return true;

  try {
    const serverId = entry.serverId || config.serverId;
    const server = await fetchServer(client, serverId);

    const roleIds = await fetchMemberRoleIds(client, server, serverId, userId);
    if (!roleIds) {
      console.warn(`Reaction role remove skipped: could not fetch member ${userId} in server ${serverId}.`);
      return true;
    }

    if (roleIds.includes(mapping.roleId)) {
      const nextRoleIds = roleIds.filter((roleId) => roleId !== mapping.roleId);
      await setMemberRoles(client, server, serverId, userId, nextRoleIds, mapping.roleId);
      console.log(`✅ Removed reaction role ${mapping.roleId} from user ${userId}.`);
    } else {
      console.log(`ℹ️ User ${userId} does not have reaction role ${mapping.roleId}; no removal needed.`);
    }
  } catch (error) {
    console.error('Failed to remove reaction role:', error?.message || error);
  }

  return true;
}

function mergeMappings(existing: ReactionRoleMapping[], incoming: ReactionRoleMapping[]): ReactionRoleMapping[] {
  const byEmoji = new Map<string, ReactionRoleMapping>();

  for (const mapping of existing) {
    if (mapping?.emoji && mapping?.roleId) {
      byEmoji.set(mapping.emoji, mapping);
    }
  }

  for (const mapping of incoming) {
    if (mapping?.emoji && mapping?.roleId) {
      byEmoji.set(mapping.emoji, mapping);
    }
  }

  return Array.from(byEmoji.values());
}

function findMappingForEmoji(mappings: ReactionRoleMapping[], emoji: string): ReactionRoleMapping | undefined {
  const normalizedEmoji = normalizeReactionEmoji(emoji);
  return mappings.find((item) => normalizeReactionEmoji(item.emoji) === normalizedEmoji);
}

function normalizeReactionEmoji(emoji: string): string {
  const input = String(emoji || '').trim();
  const customEmojiMatch = input.match(/^<a?:[^:>]+:([A-Za-z0-9_-]+)>$/);
  return customEmojiMatch?.[1] || input;
}

async function fetchServer(client, serverId: string) {
  if (!serverId) return null;

  try {
    return await client.servers.fetch(serverId);
  } catch {
    return client.servers.cache.get(serverId);
  }
}

async function fetchMember(client, server, serverId: string, userId: string) {
  try {
    if (typeof server?.getMember === 'function') {
      const cachedMember = server.getMember(userId);
      if (cachedMember) return cachedMember;
    }

    if (typeof client?.serverMembers?.fetch === 'function') {
      return await client.serverMembers.fetch(serverId, userId);
    }

    if (typeof server?.members?.fetch === 'function') {
      return await server.members.fetch(userId);
    }
  } catch {
    return null;
  }

  return null;
}

async function fetchMemberRoleIds(client, server, serverId: string, userId: string): Promise<string[] | null> {
  if (!serverId || !userId) return null;

  try {
    if (typeof client?.api?.get === 'function') {
      const rawMember = await client.api.get(`/servers/${serverId}/members/${userId}`);
      return getRoleIds(rawMember?.roles);
    }
  } catch (error) {
    console.warn('Reaction role raw member fetch failed:', error?.message || error);
  }

  const member = await fetchMember(client, server, serverId, userId);
  return member ? getRoleIds(member.roles) : null;
}

async function setMemberRoles(client, server, serverId: string, userId: string, roleIds: string[], changedRoleId?: string) {
  const uniqueRoleIds = Array.from(new Set(roleIds.filter(Boolean)));

  const errors: string[] = [];

  try {
    await patchMemberRolesViaFetch(client, serverId, userId, uniqueRoleIds);
    return;
  } catch (error) {
    const detail = getReadableError(error);
    if (isNotElevatedError(error)) {
      throw new Error(getNotElevatedHelp(server, userId, roleIds, detail, changedRoleId));
    }
    errors.push(`direct fetch patch: ${detail}`);
  }

  if (typeof client?.api?.patch === 'function') {
    try {
      await client.api.patch(`/servers/${serverId}/members/${userId}`, { body: { roles: uniqueRoleIds } });
      return;
    } catch (error) {
      const detail = getReadableError(error);
      if (isNotElevatedError(error)) {
        throw new Error(getNotElevatedHelp(server, userId, roleIds, detail, changedRoleId));
      }
      errors.push(`wrapped API patch: ${detail}`);
    }

    try {
      await client.api.patch(`/servers/${serverId}/members/${userId}`, { roles: uniqueRoleIds });
      return;
    } catch (error) {
      const detail = getReadableError(error);
      if (isNotElevatedError(error)) {
        throw new Error(getNotElevatedHelp(server, userId, roleIds, detail, changedRoleId));
      }
      errors.push(`direct API patch: ${detail}`);
    }
  }

  const member = await fetchMember(client, server, serverId, userId);

  if (typeof server?.members?.edit === 'function') {
    try {
      await server.members.edit(userId, { roles: uniqueRoleIds });
      return;
    } catch (error) {
      errors.push(`server member edit: ${getReadableError(error)}`);
    }
  }

  if (typeof member?.server?.members?.edit === 'function') {
    try {
      await member.server.members.edit(member, { roles: uniqueRoleIds });
      return;
    } catch (error) {
      errors.push(`member server edit: ${getReadableError(error)}`);
    }
  }

  if (typeof member?.edit === 'function') {
    try {
      await member.edit({ roles: uniqueRoleIds });
      return;
    } catch (error) {
      errors.push(`member edit: ${getReadableError(error)}`);
    }
  }

  if (typeof member?.addRole === 'function' && uniqueRoleIds.length > getRoleIds(member.roles).length) {
    const currentRoleIds = new Set(getRoleIds(member.roles));
    for (const roleId of uniqueRoleIds) {
      if (!currentRoleIds.has(roleId)) {
        try {
          await member.addRole(roleId);
        } catch (error) {
          errors.push(`member addRole ${roleId}: ${getReadableError(error)}`);
        }
      }
    }
    if (errors.length === 0) return;
  }

  if (typeof member?.removeRole === 'function') {
    const nextRoleIds = new Set(uniqueRoleIds);
    for (const roleId of getRoleIds(member.roles)) {
      if (!nextRoleIds.has(roleId)) {
        try {
          await member.removeRole(roleId);
        } catch (error) {
          errors.push(`member removeRole ${roleId}: ${getReadableError(error)}`);
        }
      }
    }
    if (errors.length === 0) return;
  }

  throw new Error(errors.join(' | ') || 'no supported member role update method found');
}

async function patchMemberRolesViaFetch(client, serverId: string, userId: string, roleIds: string[]) {
  const token = getClientToken(client);
  if (!token) {
    throw new Error('missing bot token for direct member role API call');
  }

  const baseUrl = getApiBaseUrl(client);
  const response = await fetch(
    `${baseUrl}/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: {
        [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
        'Content-Type': 'application/json',
        'User-Agent': 'YetAnotherOverengineeredStoatBot reaction-role assignment',
      },
      body: JSON.stringify({ roles: roleIds }),
    }
  );

  if (response.ok) {
    return;
  }

  const body = await readResponseBody(response);
  const apiType = body && typeof body === 'object' ? (body as any).type : null;
  const apiLocation = body && typeof body === 'object' ? (body as any).location : null;
  const detail = apiType ? `${apiType}${apiLocation ? ` (${apiLocation})` : ''}` : response.statusText;

  const error = new Error(`API call failed with status ${response.status}: ${detail}`);
  (error as any).response = {
    status: response.status,
    statusText: response.statusText,
    data: body,
  };
  throw error;
}

async function readResponseBody(response: Response) {
  const text = await response.text().catch(() => '');
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isNotElevatedError(error): boolean {
  return (error as any)?.response?.data?.type === 'NotElevated' || getReadableError(error).includes('NotElevated');
}

function getNotElevatedHelp(server, userId: string, roleIds: string[], detail: string, changedRoleId?: string): string {
  const roleId = changedRoleId || roleIds[roleIds.length - 1] || 'unknown-role';
  const role = server?.roles?.cache?.get?.(roleId);
  const roleName = role?.name ? `${role.name} (${roleId})` : roleId;

  return (
    `${detail}. Stoat refused the role edit because the bot is not elevated enough. ` +
    `Move the bot's highest role above ${roleName}, and make sure the bot has AssignRoles/ManageRole. ` +
    `The bot must also be above the target member ${userId}.`
  );
}

// Stoat REST errors carry a structured `{ type, location }` payload; prefer it
// over the generic message, then fall back to the shared reader.
function getReadableError(error: unknown): string {
  const responseData = (error as any)?.response?.data;
  if (responseData?.type) {
    return responseData.location ? `${responseData.type} (${responseData.location})` : String(responseData.type);
  }
  return readableError(error);
}
