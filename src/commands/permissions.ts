import { config } from '../config.js';
import { getReadableError } from '../category-utils.js';
import { logPermissionAction } from '../log-system.js';
import { normalizeId } from '../id-utils.js';
import { currentBotPermission } from '../bot-permissions.js';

type Override = { allow: number; deny: number };
type PermissionClone = {
  defaultPermissions: Override | null;
  roleOverwrites: Map<string, Override>;
};

/**
 * Mass channel permission command.
 *
 * Examples:
 * !perms clone <sourceChannel> <targetChannel> --confirm
 * !perms clone <sourceChannel> category <categoryId> --confirm
 */
export async function permissionsCommand(message, args, client) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (['nsfw', 'mature', 'age', 'age-restrict', 'agerestrict'].includes(sub)) {
    await handleMassNsfw(message, args, client);
    return;
  }

  if (!['clone', 'copy', 'sync'].includes(sub)) {
    await sendHelp(message, `Unknown permissions subcommand: \`${sub}\`.`);
    return;
  }

  if (!(await canManagePermissions(message, client))) {
    await message.channel?.send({
      content: '❌ You need Manage Permissions or Manage Channels permission to clone channel permissions.',
    });
    return;
  }

  const parsed = parseCloneArgs(args);
  if (parsed.ok === false) {
    await sendHelp(message, parsed.error);
    return;
  }

  const { sourceChannelId, target, confirmed, includeDefault } = parsed;

  if (!confirmed) {
    await message.channel?.send({
      content:
        `⚠️ This will overwrite channel permission overwrites. Re-run with \`--confirm\` to continue.\n\n` +
        `**Source:** <#${sourceChannelId}> (\`${sourceChannelId}\`)\n` +
        `**Target:** ${renderTarget(target)}\n` +
        `**Default permissions:** ${includeDefault ? 'copy' : 'skip'}`,
    });
    return;
  }

  const sourceChannel = await resolveChannel(client, sourceChannelId);
  if (!isServerChannel(sourceChannel)) {
    await message.channel?.send({ content: `❌ Source channel \`${sourceChannelId}\` was not found or is not a server channel.` });
    return;
  }

  const targetChannelsResult = await resolveTargetChannels(client, target, sourceChannelId);
  if (targetChannelsResult.ok === false) {
    await message.channel?.send({ content: `❌ ${targetChannelsResult.error}` });
    return;
  }

  if (targetChannelsResult.channels.length === 0) {
    await message.channel?.send({ content: '❌ No target channels found.' });
    return;
  }

  const clone = await extractPermissionClone(client, sourceChannel, sourceChannelId);
  if ((includeDefault ? !clone.defaultPermissions : true) && clone.roleOverwrites.size === 0) {
    await message.channel?.send({
      content: includeDefault
        ? '⚠️ Source channel has no explicit channel permission overwrites to clone.'
        : '⚠️ Source channel has no role permission overwrites to clone, and `--no-default` skipped default permissions.',
    });
    return;
  }

  const result = await applyCloneToChannels(targetChannelsResult.channels, clone, includeDefault);

  await message.channel?.send({
    content:
      `# ✅ Permission Clone Complete\n\n` +
      `**Source:** <#${sourceChannelId}>\n` +
      `**Target:** ${renderTarget(target)}\n` +
      `**Updated:** ${result.updated}\n` +
      `**Failed:** ${result.failed}\n` +
      `**Role overwrites copied:** ${clone.roleOverwrites.size}\n` +
      `**Default permissions:** ${includeDefault && clone.defaultPermissions ? 'Copied' : 'Skipped'}`,
  });

  await logPermissionAction(client, {
    action: 'Clone channel permissions',
    executorId: message.authorId,
    sourceChannelId,
    targetChannelId: target.type === 'channel' ? target.channelId : null,
    targetCategoryId: target.type === 'category' ? target.categoryId : null,
    updated: result.updated,
    failed: result.failed,
    roleOverwrites: clone.roleOverwrites.size,
    includeDefault,
    command: message.content,
  });
}

type NsfwTarget =
  | { type: 'channel'; channelId: string }
  | { type: 'category'; categoryId: string }
  | { type: 'all' };

async function handleMassNsfw(message, args, client) {
  if (!(await canManagePermissions(message, client))) {
    await message.channel?.send({
      content: '❌ You need Manage Permissions or Manage Channels permission to change channel NSFW settings.',
    });
    return;
  }

  const parsed = parseNsfwArgs(args);
  if (parsed.ok === false) {
    await sendHelp(message, parsed.error);
    return;
  }

  const { enable, target, confirmed } = parsed;

  const resolved = await resolveNsfwTargets(client, target);
  if (resolved.ok === false) {
    await message.channel?.send({ content: `❌ ${resolved.error}` });
    return;
  }

  if (resolved.channels.length === 0) {
    await message.channel?.send({ content: '❌ No target channels found.' });
    return;
  }

  if (!confirmed) {
    await message.channel?.send({
      content:
        `⚠️ This will mark **${resolved.channels.length}** channel(s) as ${enable ? 'NSFW' : 'safe (not NSFW)'}. Re-run with \`--confirm\` to continue.\n\n` +
        `**State:** ${enable ? 'NSFW on' : 'NSFW off'}\n` +
        `**Target:** ${renderNsfwTarget(target)}`,
    });
    return;
  }

  const result = await applyNsfw(resolved.channels, enable);

  await message.channel?.send({
    content:
      `# ✅ Mass NSFW ${enable ? 'Enable' : 'Disable'} Complete\n\n` +
      `**Target:** ${renderNsfwTarget(target)}\n` +
      `**Updated:** ${result.updated}\n` +
      `**Failed:** ${result.failed}\n` +
      `**Marked:** ${enable ? 'NSFW' : 'Safe'}`,
  });

  await logPermissionAction(client, {
    action: `Mass ${enable ? 'enable' : 'disable'} channel NSFW`,
    executorId: message.authorId,
    targetChannelId: target.type === 'channel' ? target.channelId : null,
    targetCategoryId: target.type === 'category' ? target.categoryId : null,
    updated: result.updated,
    failed: result.failed,
    command: message.content,
  });
}

function parseNsfwArgs(args: string[]):
  | { ok: true; enable: boolean; target: NsfwTarget; confirmed: boolean }
  | { ok: false; error: string } {
  const tokens = [...(args || [])].filter(Boolean);
  let confirmed = false;
  const positional: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (['--confirm', '--yes', '-y'].includes(lower)) {
      confirmed = true;
    } else {
      positional.push(token);
    }
  }

  const stateToken = (positional.shift() || '').toLowerCase();
  if (!stateToken) {
    return { ok: false, error: 'Usage: `perms nsfw <on|off> <targetChannel|category <categoryId>|all> --confirm`.' };
  }

  let enable: boolean;
  if (['on', 'enable', 'true', 'yes', '1'].includes(stateToken)) {
    enable = true;
  } else if (['off', 'disable', 'false', 'no', '0'].includes(stateToken)) {
    enable = false;
  } else {
    return { ok: false, error: `Invalid NSFW state: \`${stateToken}\`. Use \`on\` or \`off\`.` };
  }

  const targetKindOrId = positional.shift();
  if (!targetKindOrId) {
    return { ok: false, error: 'Missing target. Use a channel ID, `category <categoryId>`, or `all`.' };
  }

  const lowerTarget = targetKindOrId.toLowerCase();
  if (['all', 'server', 'all-channels', '*'].includes(lowerTarget)) {
    return { ok: true, enable, target: { type: 'all' }, confirmed };
  }

  if (['category', 'cat', 'category-channels'].includes(lowerTarget)) {
    const categoryId = normalizeId(positional.shift());
    if (!categoryId) {
      return { ok: false, error: 'Missing category ID. Usage: `perms nsfw <on|off> category <categoryId> --confirm`.' };
    }
    return { ok: true, enable, target: { type: 'category', categoryId }, confirmed };
  }

  const channelId = normalizeId(targetKindOrId);
  if (!channelId) {
    return { ok: false, error: `Invalid target channel: \`${targetKindOrId}\`.` };
  }

  return { ok: true, enable, target: { type: 'channel', channelId }, confirmed };
}

async function resolveNsfwTargets(
  client,
  target: NsfwTarget
): Promise<{ ok: true; channels: any[] } | { ok: false; error: string }> {
  if (target.type === 'channel') {
    const channel = await resolveChannel(client, target.channelId);
    if (!isServerChannel(channel)) {
      return { ok: false, error: `Target channel \`${target.channelId}\` was not found or is not a server channel.` };
    }
    return { ok: true, channels: [channel] };
  }

  const channelIds = target.type === 'category'
    ? await getCategoryChannelIds(client, target.categoryId)
    : await getAllServerChannelIds(client);

  const channels: any[] = [];
  for (const channelId of channelIds) {
    const channel = await resolveChannel(client, channelId);
    if (isServerChannel(channel)) {
      channels.push(channel);
    }
  }

  return { ok: true, channels };
}

async function getAllServerChannelIds(client): Promise<string[]> {
  const ids = new Set<string>();

  try {
    const rawServer = await client.api.get(`/servers/${config.serverId}`, { include_channels: true });
    const rawChannels = Array.isArray(rawServer?.channels) ? rawServer.channels : [];
    for (const channel of rawChannels) {
      const id = typeof channel === 'string' ? channel : (channel?.id || channel?._id);
      if (id) ids.add(id);
    }
  } catch {
    // cache fallback below
  }

  const server = client.servers.cache.get(config.serverId);
  const managerChannels = Array.from(server?.channels?.cache?.values?.() || []);
  const serverChannels = Array.isArray(server?.channels) ? server.channels : [];
  const cacheChannels = Array.from(client?.channels?.cache?.values?.() || []).filter(
    (channel: any) => channel?.serverId === config.serverId
  );
  for (const channel of [...managerChannels, ...serverChannels, ...cacheChannels]) {
    const id = (channel as any)?.id || (channel as any)?._id;
    if (id) ids.add(id);
  }

  return Array.from(ids);
}

async function applyNsfw(channels: any[], enable: boolean): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;

  for (const channel of channels) {
    try {
      await setChannelNsfw(channel, enable);
      updated += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Failed to set NSFW on channel ${channel?.id}:`, getReadableError(error));
    }
  }

  return { updated, failed };
}

async function setChannelNsfw(channel: any, enable: boolean): Promise<void> {
  if (typeof channel?.edit === 'function') {
    await channel.edit({ nsfw: enable });
    return;
  }

  const client = channel?.client;
  const id = channel?.id || channel?._id;
  if (!client?.api || typeof client.api.patch !== 'function' || !id) {
    throw new Error('No channel edit method available.');
  }

  try {
    await client.api.patch(`/channels/${id}`, { body: { nsfw: enable } });
  } catch {
    await client.api.patch(`/channels/${id}`, { nsfw: enable });
  }
}

function renderNsfwTarget(target: NsfwTarget): string {
  if (target.type === 'channel') return `<#${target.channelId}> (\`${target.channelId}\`)`;
  if (target.type === 'category') return `all channels in category \`${target.categoryId}\``;
  return 'all channels in the server';
}

function parseCloneArgs(args: string[]):
  | { ok: true; sourceChannelId: string; target: { type: 'channel'; channelId: string } | { type: 'category'; categoryId: string }; confirmed: boolean; includeDefault: boolean }
  | { ok: false; error: string } {
  const tokens = [...(args || [])].filter(Boolean);
  let confirmed = false;
  let includeDefault = true;
  const positional: string[] = [];

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (['--confirm', '--yes', '-y'].includes(lower)) {
      confirmed = true;
    } else if (['--no-default', '--skip-default'].includes(lower)) {
      includeDefault = false;
    } else {
      positional.push(token);
    }
  }

  const sourceChannelId = normalizeId(positional.shift());
  if (!sourceChannelId) {
    return { ok: false, error: 'Usage: `perms clone <sourceChannel> <targetChannel|category categoryId> --confirm`.' };
  }

  const targetKindOrId = positional.shift();
  if (!targetKindOrId) {
    return { ok: false, error: 'Missing target channel or category.' };
  }

  const lowerTarget = targetKindOrId.toLowerCase();
  if (['category', 'cat', 'category-channels'].includes(lowerTarget)) {
    const categoryId = normalizeId(positional.shift());
    if (!categoryId) {
      return { ok: false, error: 'Missing category ID. Usage: `perms clone <sourceChannel> category <categoryId> --confirm`.' };
    }
    return { ok: true, sourceChannelId, target: { type: 'category', categoryId }, confirmed, includeDefault };
  }

  const channelId = normalizeId(targetKindOrId);
  if (!channelId) {
    return { ok: false, error: `Invalid target channel: \`${targetKindOrId}\`.` };
  }

  return { ok: true, sourceChannelId, target: { type: 'channel', channelId }, confirmed, includeDefault };
}

async function canManagePermissions(message, client): Promise<boolean> {
  const decision = await currentBotPermission(client, config.serverId, message.authorId);
  if (decision) return decision === 'allow';

  let server = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }

  const member = await server?.members?.fetch(message.authorId).catch(() => server?.members?.cache?.get?.(message.authorId) || null);
  if (!member || typeof member.hasPermission !== 'function') return false;

  for (const permission of ['ManagePermissions', 'MANAGE_PERMISSIONS', 'ManageChannel', 'MANAGE_CHANNEL']) {
    try {
      if (member.hasPermission(permission)) return true;
    } catch {
      // try next spelling
    }
  }

  return false;
}

async function resolveChannel(client, channelId: string) {
  return client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
}

async function resolveTargetChannels(
  client,
  target: { type: 'channel'; channelId: string } | { type: 'category'; categoryId: string },
  sourceChannelId: string
): Promise<{ ok: true; channels: any[] } | { ok: false; error: string }> {
  if (target.type === 'channel') {
    const channel = await resolveChannel(client, target.channelId);
    if (!isServerChannel(channel)) {
      return { ok: false, error: `Target channel \`${target.channelId}\` was not found or is not a server channel.` };
    }
    if (channel.id === sourceChannelId) {
      return { ok: false, error: 'Target channel cannot be the same as the source channel.' };
    }
    return { ok: true, channels: [channel] };
  }

  const channelIds = await getCategoryChannelIds(client, target.categoryId);
  const channels: any[] = [];
  for (const channelId of channelIds) {
    if (channelId === sourceChannelId) continue;
    const channel = await resolveChannel(client, channelId);
    if (isServerChannel(channel)) {
      channels.push(channel);
    }
  }

  return { ok: true, channels };
}

async function getCategoryChannelIds(client, categoryId: string): Promise<string[]> {
  try {
    const rawServer = await client.api.get(`/servers/${config.serverId}`, { include_channels: true });
    const categories = Array.isArray(rawServer?.categories) ? rawServer.categories : [];
    const category = categories.find((entry) => (entry?.id || entry?._id) === categoryId);
    if (category) return extractCategoryChannelIds(category);
  } catch {
    // cache fallback below
  }

  const server = client.servers.cache.get(config.serverId);
  const categories = Array.from(server?.categories?.values?.() || []);
  const category = categories.find((entry: any) => (entry?.id || entry?._id) === categoryId);
  return category ? extractCategoryChannelIds(category) : [];
}

async function extractPermissionClone(client, sourceChannel, sourceChannelId: string): Promise<PermissionClone> {
  const roleOverwrites = new Map<string, Override>();

  const sourceOverwrites = sourceChannel?.overwrites instanceof Map
    ? sourceChannel.overwrites
    : new Map();

  for (const [roleId, overwrite] of sourceOverwrites.entries()) {
    roleOverwrites.set(roleId, {
      allow: toBitfield(overwrite?.allow),
      deny: toBitfield(overwrite?.deny),
    });
  }

  let defaultPermissions = sourceChannel?.permissions
    ? { allow: toBitfield(sourceChannel.permissions), deny: 0 }
    : null;

  try {
    const raw = await client.api.get(`/channels/${sourceChannelId}`);

    if (raw?.default_permissions !== undefined && raw.default_permissions !== null) {
      defaultPermissions = normalizeRawOverride(raw.default_permissions);
    }

    if (raw?.role_permissions && typeof raw.role_permissions === 'object') {
      for (const [roleId, overwrite] of Object.entries(raw.role_permissions)) {
        roleOverwrites.set(roleId, normalizeRawOverride(overwrite));
      }
    }
  } catch (error) {
    console.warn(`Could not fetch raw permissions for source channel ${sourceChannelId}; using cache only:`, getReadableError(error));
  }

  return { defaultPermissions, roleOverwrites };
}

function normalizeRawOverride(value: any): Override {
  if (typeof value === 'number') {
    return { allow: value, deny: 0 };
  }

  return {
    allow: toBitfield(value?.allow ?? value?.a),
    deny: toBitfield(value?.deny ?? value?.d),
  };
}

async function applyCloneToChannels(channels: any[], clone: PermissionClone, includeDefault: boolean): Promise<{ updated: number; failed: number }> {
  let updated = 0;
  let failed = 0;

  for (const channel of channels) {
    try {
      if (includeDefault && clone.defaultPermissions) {
        await channel.setDefaultPermissions({
          allow: clone.defaultPermissions.allow,
          deny: clone.defaultPermissions.deny,
        });
      }

      for (const [roleId, overwrite] of clone.roleOverwrites.entries()) {
        await channel.setRolePermissions(roleId, {
          allow: overwrite.allow,
          deny: overwrite.deny,
        });
      }

      updated += 1;
    } catch (error) {
      failed += 1;
      console.warn(`Failed to clone permissions to channel ${channel?.id}:`, getReadableError(error));
    }
  }

  return { updated, failed };
}

function isServerChannel(channel: any): boolean {
  if (!channel) return false;
  // Confine every source/target to the configured server. Authorization for this
  // command is evaluated against `config.serverId`, so accepting a channel from
  // another server the bot joined would let a local moderator rewrite that
  // server's permission overwrites.
  if (channel.serverId && config.serverId && channel.serverId !== config.serverId) return false;
  if (typeof channel.inServer === 'function') return channel.inServer();
  return !!channel.serverId;
}

function extractCategoryChannelIds(category: any): string[] {
  if (Array.isArray(category?.channels)) {
    return category.channels
      .map((entry: any) => (typeof entry === 'string' ? entry : entry?.id || entry?._id))
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
  }

  const fromChildren = Array.from(category?.children?.values?.() || [])
    .map((channel: any) => channel?.id || channel?._id)
    .filter((id: any): id is string => typeof id === 'string' && id.length > 0);

  if (fromChildren.length > 0) return fromChildren;

  if (Array.isArray(category?._children)) {
    return category._children.filter((id: any): id is string => typeof id === 'string' && id.length > 0);
  }

  return [];
}

function toBitfield(value: any): number {
  if (typeof value === 'number') return value;
  if (typeof value?.bitfield === 'number') return value.bitfield;
  if (typeof value?.valueOf === 'function') {
    const resolved = value.valueOf();
    if (typeof resolved === 'number') return resolved;
  }
  return 0;
}

function renderTarget(target: { type: 'channel'; channelId: string } | { type: 'category'; categoryId: string }): string {
  return target.type === 'channel'
    ? `<#${target.channelId}> (\`${target.channelId}\`)`
    : `all channels in category \`${target.categoryId}\``;
}

async function sendHelp(message, error?: string) {
  await message.channel?.send({
    content:
      (error ? `❌ ${error}\n\n` : '') +
      `# 🧬 Mass Permissions Help\n\n` +
      `\`${config.prefix}perms clone <sourceChannel> <targetChannel> --confirm\`\n` +
      `Copy channel permission overwrites from one channel to another.\n\n` +
      `\`${config.prefix}perms clone <sourceChannel> category <categoryId> --confirm\`\n` +
      `Copy permission overwrites to every channel in a category.\n\n` +
      `\`${config.prefix}perms nsfw <on|off> <targetChannel|category <categoryId>|all> --confirm\`\n` +
      `Mass mark channels as NSFW (age-restricted) or safe. \`all\` targets every channel in the server.\n\n` +
      `Aliases: \`${config.prefix}permissions\`, \`${config.prefix}massperms\`, \`${config.prefix}mass-perms\`\n` +
      `Options: \`--confirm\` required, \`--no-default\` skips default permissions and copies only role overwrites.`,
  });
}
