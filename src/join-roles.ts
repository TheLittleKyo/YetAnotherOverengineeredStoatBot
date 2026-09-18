import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { getClientToken, getApiBaseUrl } from './stoat-api.js';
import { getMemberIds, getRoleIds } from './member-utils.js';
import { dataFile, ensureDataDir } from './json-store.js';

type JoinRolesFile = {
  servers: Array<{
    serverId: string;
    roleIds: string[];
  }>;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const JOIN_ROLES_FILE = dataFile('join-roles.json');
let joinRolesCache: JoinRolesFile | null = null;

function readJoinRolesFile(): JoinRolesFile {
  if (joinRolesCache) return joinRolesCache;

  try {
    if (!existsSync(JOIN_ROLES_FILE)) {
      joinRolesCache = { servers: [] };
      return joinRolesCache;
    }

    const raw = readFileSync(JOIN_ROLES_FILE, 'utf-8').trim();
    if (!raw) {
      joinRolesCache = { servers: [] };
      return joinRolesCache;
    }

    const parsed = JSON.parse(raw);
    joinRolesCache = {
      servers: Array.isArray(parsed?.servers) ? parsed.servers : [],
    };
    return joinRolesCache;
  } catch (error) {
    console.error('Failed to read join roles file:', error?.message || error);
    joinRolesCache = { servers: [] };
    return joinRolesCache;
  }
}

function writeJoinRolesFile(data: JoinRolesFile) {
  joinRolesCache = data;
  ensureDataDir();
  writeFileSync(JOIN_ROLES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

export function getJoinRoleIds(serverId = config.serverId): string[] {
  if (!serverId) return [];
  const entry = readJoinRolesFile().servers.find((item) => item.serverId === serverId);
  return Array.isArray(entry?.roleIds) ? entry.roleIds.filter(Boolean) : [];
}

export function addJoinRole(roleId: string, serverId = config.serverId): string[] {
  if (!serverId || !roleId) return getJoinRoleIds(serverId);

  const data = readJoinRolesFile();
  const existing = data.servers.find((item) => item.serverId === serverId);
  const roleIds = Array.from(new Set([...(existing?.roleIds || []), roleId].filter(Boolean)));
  const servers = data.servers.filter((item) => item.serverId !== serverId).concat({ serverId, roleIds });

  writeJoinRolesFile({ servers });
  return roleIds;
}

export function removeJoinRole(roleId: string, serverId = config.serverId): string[] {
  if (!serverId || !roleId) return getJoinRoleIds(serverId);

  const data = readJoinRolesFile();
  const existing = data.servers.find((item) => item.serverId === serverId);
  const roleIds = (existing?.roleIds || []).filter((id) => id !== roleId);
  const servers = data.servers
    .filter((item) => item.serverId !== serverId)
    .concat(roleIds.length > 0 ? [{ serverId, roleIds }] : []);

  writeJoinRolesFile({ servers });
  return roleIds;
}

export function clearJoinRoles(serverId = config.serverId) {
  if (!serverId) return;
  const data = readJoinRolesFile();
  writeJoinRolesFile({ servers: data.servers.filter((item) => item.serverId !== serverId) });
}

export function scheduleJoinRolesForMember(client, member) {
  setTimeout(() => {
    applyJoinRolesToMember(client, member).catch((error) => {
      console.error('Failed to apply join roles:', error?.message || error);
    });
  }, 1200);
}

async function applyJoinRolesToMember(client, member) {
  const ids = getMemberIds(member, config.serverId);
  if (!ids) return;

  const joinRoleIds = getJoinRoleIds(ids.serverId);
  if (joinRoleIds.length === 0) return;

  const currentRoleIds = await fetchMemberRoleIds(client, ids.serverId, ids.userId, member);
  if (!currentRoleIds) {
    console.warn(`Join roles skipped: could not fetch member ${ids.userId} in server ${ids.serverId}.`);
    return;
  }

  const nextRoleIds = Array.from(new Set([...currentRoleIds, ...joinRoleIds]));
  if (nextRoleIds.length === currentRoleIds.length) return;

  await patchMemberRolesViaFetch(client, ids.serverId, ids.userId, nextRoleIds);
  console.log(`✅ Applied join role(s) ${joinRoleIds.join(', ')} to user ${ids.userId}.`);
}

async function fetchMemberRoleIds(client, serverId: string, userId: string, fallbackMember): Promise<string[] | null> {
  try {
    if (typeof client?.api?.get === 'function') {
      const rawMember = await client.api.get(`/servers/${serverId}/members/${userId}`);
      return getRoleIds(rawMember?.roles);
    }
  } catch {
    // Fall back to the member object from the join event.
  }

  return fallbackMember ? getRoleIds(fallbackMember.roles) : null;
}

async function patchMemberRolesViaFetch(client, serverId: string, userId: string, roleIds: string[]) {
  const token = getClientToken(client);
  if (!token) throw new Error('missing bot token for join-role assignment');

  const baseUrl = getApiBaseUrl(client);
  const response = await fetch(`${baseUrl}/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
      'Content-Type': 'application/json',
      'User-Agent': 'YetAnotherOverengineeredStoatBot join-role assignment',
    },
    body: JSON.stringify({ roles: roleIds }),
  });

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
