import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { dataFile, ensureDataDir, registerDataFileHooks } from './json-store.js';

export type StatsMode = 'all' | 'role';

export type StatsChannelEntry = {
  channelId: string;
  mode: StatsMode;
  roleId?: string;
  label?: string;
  // Which server this stats channel belongs to. Legacy entries saved before the
  // dashboard became multi-server have none; those are treated as the configured
  // default server (config.serverId) on read.
  serverId?: string;
};

type StatsConfigFile = {
  channels: StatsChannelEntry[];
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATS_FILE = dataFile('stats-channels.json');

// Consulted on member role changes to decide whether a counter needs a
// refresh, so it is parsed once and served from memory (this process is the
// only writer). A backup restore drops the copy.
let statsCache: StatsConfigFile | null = null;
registerDataFileHooks('stats-channels.json', { reload: () => { statsCache = null; } });

function readStatsFile(): StatsConfigFile {
  if (!statsCache) statsCache = parseStatsFile();
  return statsCache;
}

function parseStatsFile(): StatsConfigFile {
  try {
    if (!existsSync(STATS_FILE)) {
      return { channels: [] };
    }

    const raw = readFileSync(STATS_FILE, 'utf-8').trim();
    if (!raw) {
      return { channels: [] };
    }

    const parsed = JSON.parse(raw);
    const channels = Array.isArray(parsed?.channels) ? parsed.channels : [];

    return {
      channels: channels.filter((entry) => entry?.channelId && (entry?.mode === 'all' || entry?.mode === 'role')),
    };
  } catch (error) {
    console.error('Failed to read stats channels file:', error?.message || error);
    return { channels: [] };
  }
}

function writeStatsFile(data: StatsConfigFile) {
  statsCache = data;
  ensureDataDir();
  writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

// All configured stats channels, or only those for `serverId` when given.
// Entries with no serverId are attributed to the configured default server.
export function getStatsChannels(serverId?: string) {
  const channels = readStatsFile().channels;
  if (!serverId) return [...channels];
  return channels.filter((entry) => (entry.serverId || config.serverId) === serverId);
}

export function upsertStatsChannel(entry: StatsChannelEntry) {
  const data = readStatsFile();
  const nextChannels = [...data.channels];
  const index = nextChannels.findIndex((item) => item.channelId === entry.channelId);

  if (index >= 0) {
    nextChannels[index] = entry;
  } else {
    nextChannels.push(entry);
  }

  writeStatsFile({ channels: nextChannels });
  return entry;
}

export function removeStatsChannel(channelId: string) {
  const data = readStatsFile();
  const nextChannels = data.channels.filter((entry) => entry.channelId !== channelId);
  writeStatsFile({ channels: nextChannels });
  return nextChannels.length !== data.channels.length;
}

export async function refreshStatsChannels(client, serverId: string) {
  if (!serverId) {
    return { configured: 0, updated: 0, skipped: 0 };
  }

  const entries = getStatsChannels(serverId);
  if (entries.length === 0) {
    return { configured: 0, updated: 0, skipped: 0 };
  }

  let updated = 0;
  let skipped = 0;

  let allMembersCountCache: number | null = null;
  let membersCache: any[] | null = null;

  for (const entry of entries) {
    try {
      const channel = client.channels.cache.get(entry.channelId) || (await client.channels.fetch(entry.channelId).catch(() => null));
      if (!channel) {
        skipped += 1;
        continue;
      }

      let count: number | null = null;

      if (entry.mode === 'all') {
        if (allMembersCountCache === null) {
          allMembersCountCache = await getAllMembersCount(client, serverId);
        }
        count = allMembersCountCache;
      } else if (entry.mode === 'role' && entry.roleId) {
        if (!membersCache) {
          membersCache = await getServerMembers(client, serverId);
        }
        count = membersCache.filter((member) => memberHasRole(member, entry.roleId)).length;
      }

      if (typeof count !== 'number') {
        skipped += 1;
        continue;
      }

      const label = (entry.label || getDefaultLabel(entry)).trim();
      const nextName = `${label}: ${count}`;

      if (channel.name !== nextName) {
        await channel.edit({ name: nextName });
        updated += 1;
      }
    } catch (error) {
      skipped += 1;
      console.error(`Failed to refresh stats channel ${entry.channelId}:`, error?.message || error);
    }
  }

  return { configured: entries.length, updated, skipped };
}

// Refresh stats channels across every server that has any configured, so the
// periodic/startup refresh isn't limited to the default server.
export async function refreshAllStatsChannels(client) {
  const serverIds = new Set(readStatsFile().channels.map((entry) => entry.serverId || config.serverId).filter(Boolean));
  const totals = { configured: 0, updated: 0, skipped: 0 };
  for (const serverId of serverIds) {
    const summary = await refreshStatsChannels(client, serverId);
    totals.configured += summary.configured;
    totals.updated += summary.updated;
    totals.skipped += summary.skipped;
  }
  return totals;
}

async function getAllMembersCount(client, serverId: string): Promise<number | null> {
  try {
    let server = null;
    try {
      server = await client.servers.fetch(serverId);
    } catch {
      server = client.servers.cache.get(serverId);
    }

    if (typeof server?.memberCount === 'number') {
      return server.memberCount;
    }

    if (typeof server?.members?.size === 'number') {
      return server.members.size;
    }
  } catch {
    // continue to API fallback
  }

  const members = await getServerMembers(client, serverId);
  return Array.isArray(members) ? members.length : null;
}

async function getServerMembers(client, serverId: string): Promise<any[]> {
  try {
    const response = await client.api.get(`/servers/${serverId}/members`);

    if (Array.isArray(response)) {
      return response;
    }

    if (Array.isArray(response?.members)) {
      return response.members;
    }

    if (Array.isArray(response?.users)) {
      return response.users;
    }
  } catch (error) {
    console.error('Failed to fetch members via API for stats channels:', error?.message || error);
  }

  try {
    const server = client.servers.cache.get(serverId);
    if (!server?.members) {
      return [];
    }

    if (Array.isArray(server.members)) {
      return server.members;
    }

    if (server.members?.cache && typeof server.members.cache.values === 'function') {
      return Array.from(server.members.cache.values());
    }

    if (typeof server.members.values === 'function') {
      return Array.from(server.members.values());
    }

    return Array.from(server.members);
  } catch {
    return [];
  }
}

function memberHasRole(member, roleId: string) {
  if (!member || !roleId) return false;

  const roles = member.roles || member.roleIds || member.role_ids;
  if (!roles) return false;

  if (roles instanceof Set) {
    return roles.has(roleId);
  }

  if (Array.isArray(roles)) {
    return roles.includes(roleId);
  }

  return false;
}

function getDefaultLabel(entry: StatsChannelEntry) {
  if (entry.mode === 'all') {
    return 'Members';
  }
  return 'Role Members';
}
