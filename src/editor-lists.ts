/**
 * Shared list helpers for the dashboard editors. Every editor that needs a
 * channel / role / category dropdown pulls its options from here so the
 * merging logic (live API first, client cache as a cold-start fallback) lives
 * in one place instead of being copy-pasted per editor.
 *
 * All three return `{ id, name }[]` sorted by name, ready to feed a <select>.
 */

export type NamedOption = { id: string; name: string };

// Best-effort list of text channels, merged from the API and the client cache
// so the dropdown is populated even when the cache is cold.
export async function listTextChannels(client: any, serverId: string): Promise<NamedOption[]> {
  const byId = new Map<string, string>();

  try {
    const data: any = await client?.api?.get?.(`/servers/${serverId}`, { include_channels: true });
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    for (const channel of channels) {
      if (channel?.channel_type && channel.channel_type !== 'TextChannel') continue;
      const id = channel?._id || channel?.id;
      if (id) byId.set(String(id), String(channel?.name || channel?.title || id));
    }
  } catch {
    // fall back to cache below
  }

  const cache = client?.channels?.cache;
  if (cache && typeof cache.values === 'function') {
    for (const channel of cache.values()) {
      const id = channel?.id || channel?._id;
      const channelServerId = channel?.serverId || channel?.server_id || channel?.server;
      if (!id || (channelServerId && channelServerId !== serverId)) continue;
      const type = channel?.channelType || channel?.channel_type || channel?.type;
      if (type && !/text/i.test(String(type))) continue;
      if (!byId.has(String(id))) byId.set(String(id), String(channel?.name || channel?.title || id));
    }
  }

  return toSortedOptions(byId);
}

// Like listTextChannels but keeps every channel type (text + voice). Used
// where non-text channels are valid targets, e.g. voice channels for stats.
export async function listChannels(client: any, serverId: string): Promise<NamedOption[]> {
  const byId = new Map<string, string>();

  try {
    const data: any = await client?.api?.get?.(`/servers/${serverId}`, { include_channels: true });
    const channels = Array.isArray(data?.channels) ? data.channels : [];
    for (const channel of channels) {
      const type = channel?.channel_type;
      if (type && type !== 'TextChannel' && type !== 'VoiceChannel') continue;
      const id = channel?._id || channel?.id;
      if (id) byId.set(String(id), String(channel?.name || channel?.title || id));
    }
  } catch {
    // fall back to cache below
  }

  const cache = client?.channels?.cache;
  if (cache && typeof cache.values === 'function') {
    for (const channel of cache.values()) {
      const id = channel?.id || channel?._id;
      const channelServerId = channel?.serverId || channel?.server_id || channel?.server;
      if (!id || (channelServerId && channelServerId !== serverId)) continue;
      const type = String(channel?.channelType || channel?.channel_type || channel?.type || '');
      if (type && !/text|voice/i.test(type)) continue;
      if (!byId.has(String(id))) byId.set(String(id), String(channel?.name || channel?.title || id));
    }
  }

  return toSortedOptions(byId);
}

// Server roles, merged from the API and the client cache.
export async function listRoles(client: any, serverId: string): Promise<NamedOption[]> {
  const byId = new Map<string, string>();
  try {
    const data: any = await client?.api?.get?.(`/servers/${serverId}`);
    const roles = data?.roles && typeof data.roles === 'object' ? data.roles : {};
    for (const [id, role] of Object.entries<any>(roles)) {
      if (id) byId.set(String(id), String(role?.name || id));
    }
  } catch {
    // fall back to cache below
  }

  const server = client?.servers?.cache?.get?.(serverId);
  const rolesCache = server?.roles?.cache;
  if (rolesCache && typeof rolesCache.values === 'function') {
    for (const role of rolesCache.values()) {
      const id = role?.id || role?._id;
      if (id && !byId.has(String(id))) byId.set(String(id), String(role?.name || id));
    }
  }

  return toSortedOptions(byId);
}

// Server channel categories, merged from the API and the client cache. The
// synthetic "default" category is skipped so it never shows up as a target.
export async function listCategories(client: any, serverId: string): Promise<NamedOption[]> {
  const byId = new Map<string, string>();

  try {
    const data: any = await client?.api?.get?.(`/servers/${serverId}`, { include_channels: true });
    const categories = Array.isArray(data?.categories) ? data.categories : [];
    for (const category of categories) {
      const id = category?.id || category?._id;
      if (id && id !== 'default') byId.set(String(id), String(category?.title || category?.name || id));
    }
  } catch {
    // fall back to cache below
  }

  const server = client?.servers?.cache?.get?.(serverId);
  const cache = server?.categories;
  const values = typeof cache?.values === 'function' ? cache.values() : Array.isArray(cache) ? cache : null;
  if (values) {
    for (const category of values) {
      const id = category?.id || category?._id;
      if (id && id !== 'default' && !byId.has(String(id))) byId.set(String(id), String(category?.title || category?.name || id));
    }
  }

  return toSortedOptions(byId);
}

export type ServerChannels = { id: string; name: string; channels: NamedOption[] };

// Every server the bot is in, each with its own text-channel list. Powers
// cross-server pickers (e.g. channel sync between two different servers).
export async function listServersWithChannels(client: any): Promise<ServerChannels[]> {
  const cache = client?.servers?.cache;
  const servers = cache && typeof cache.values === 'function' ? Array.from<any>(cache.values()) : [];
  const out: ServerChannels[] = [];
  for (const server of servers) {
    const id = String(server?.id || server?._id || '').trim();
    if (!id) continue;
    const name = String(server?.name || server?.title || id).trim() || id;
    out.push({ id, name, channels: await listTextChannels(client, id) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function toSortedOptions(byId: Map<string, string>): NamedOption[] {
  return Array.from(byId.entries())
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Whether a channel belongs to the server a dashboard request is editing. The
 * dashboard switches servers per request, so an id taken from the request body
 * must be checked before the bot posts there — or a tab opened for one server
 * could post into another server's channel.
 */
export async function channelInServer(client: any, serverId: string, channelId: string): Promise<boolean> {
  if (!serverId || !channelId) return false;
  const channel = client?.channels?.cache?.get?.(channelId) || (await client?.channels?.fetch?.(channelId).catch(() => null));
  const owner = String(channel?.serverId || channel?.server_id || channel?.server?.id || '');
  if (owner) return owner === serverId;
  // No channel object: fall back to the server's own channel list.
  const listed = await listChannels(client, serverId).catch(() => [] as NamedOption[]);
  return listed.some((entry) => entry.id === channelId);
}

// Voice channels only, for the temporary-room hub picker. Stoat reports them as
// `VoiceChannel`, or as a text channel carrying `voice` settings.
export async function listVoiceChannels(client: any, serverId: string): Promise<NamedOption[]> {
  const byId = new Map<string, string>();
  try {
    const data: any = await client?.api?.get?.(`/servers/${serverId}`, { include_channels: true });
    for (const channel of Array.isArray(data?.channels) ? data.channels : []) {
      if (channel?.channel_type !== 'VoiceChannel' && !channel?.voice) continue;
      const id = channel?._id || channel?.id;
      if (id) byId.set(String(id), String(channel?.name || id));
    }
  } catch {
    // fall back to cache below
  }
  const cache = client?.channels?.cache;
  if (cache && typeof cache.values === 'function') {
    for (const channel of cache.values()) {
      const id = channel?.id || channel?._id;
      const channelServerId = channel?.serverId || channel?.server_id || channel?.server;
      if (!id || (channelServerId && channelServerId !== serverId)) continue;
      const type = String(channel?.channelType || channel?.channel_type || channel?.type || '');
      const isVoice = /voice/i.test(type) || (typeof channel?.isVoice === 'function' && channel.isVoice()) || !!channel?.voice;
      if (!isVoice) continue;
      if (!byId.has(String(id))) byId.set(String(id), String(channel?.name || id));
    }
  }
  return toSortedOptions(byId);
}
