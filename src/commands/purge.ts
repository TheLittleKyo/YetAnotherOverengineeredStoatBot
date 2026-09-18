import { config } from '../config.js';
import { isSupportStaff } from '../permissions.js';
import { currentBotPermission } from '../bot-permissions.js';
import { logPurgeAction } from '../log-system.js';

const PAGE_SIZE = 100;
const BULK_DELETE_SIZE = 100;
const MAX_LAST_COUNT = 5000;
const DEFAULT_USER_SCAN_LIMIT = 5000;

type PurgeMode = 'last' | 'all' | 'count';

type ChannelScope =
  | { type: 'current' }
  | { type: 'single'; channelId: string }
  | { type: 'all' };

type PurgeOptions = {
  mode: PurgeMode;
  count: number | null;
  userId: string | null;
  channelScope: ChannelScope;
  confirmed: boolean;
  scanLimit: number;
};

type MessageTarget = {
  id: string;
  channel: any;
  message: any;
};

type DeleteSummary = {
  deleted: number;
  failed: number;
  channelsTouched: Set<string>;
};

/**
 * Purge / MassEliminate command.
 *
 * Examples:
 * !purge 25
 * !purge last 25 @user
 * !purge count @user all-channels
 * !purge all #channel --confirm
 * !purge all @user all-channels --confirm
 */
export async function purgeCommand(message, args, client) {
  const parsed = parsePurgeArgs(args);

  if (parsed.ok === false) {
    await sendHelp(message, parsed.error);
    return;
  }

  const options = parsed.options;

  if (!(await canUsePurge(message, client))) {
    await message.channel?.send({
      content: '❌ You need the support role or Manage Messages permission to use purge commands.',
    });
    return;
  }

  if (options.mode === 'all' && !options.confirmed) {
    await message.channel?.send({
      content:
        `⚠️ This is a destructive mass-eliminate operation. Re-run the command with \`--confirm\` to continue.\n\n` +
        renderSummary(options, true),
    });
    return;
  }

  const channels = await resolveTargetChannels(message, client, options.channelScope);
  if (channels.ok === false) {
    await message.channel?.send({ content: `❌ ${channels.error}` });
    return;
  }

  if (channels.channels.length === 0) {
    await message.channel?.send({ content: '❌ No text channels were found for that target.' });
    return;
  }

  try {
    if (options.mode === 'count') {
      const summary = await countMatchingMessages(channels.channels, options, message.id);
      await message.channel?.send({
        content: renderCountResult(options, summary),
      });
      await logPurgeAction(client, {
        action: 'Count user messages',
        executorId: message.authorId,
        targetUserId: options.userId,
        channelScope: renderChannelScope(options.channelScope),
        matched: summary.matched,
        scanned: summary.scanned,
        channels: summary.channelsScanned,
        scanLimit: options.scanLimit,
        command: message.content,
      });
      return;
    }

    if (options.mode === 'last') {
      const targets = await collectLastTargets(channels.channels, options, message.id);

      if (targets.length === 0) {
        await message.channel?.send({
          content: `ℹ️ No matching messages found.\n\n${renderSummary(options)}`,
        });
        return;
      }

      const summary = await deleteTargets(targets);
      await message.channel?.send({
        content: renderResult('Purge complete', options, summary, targets.length),
      });
      await logPurgeAction(client, {
        action: 'Delete last matching messages',
        executorId: message.authorId,
        targetUserId: options.userId,
        channelScope: renderChannelScope(options.channelScope),
        matched: targets.length,
        deleted: summary.deleted,
        failed: summary.failed,
        channels: summary.channelsTouched.size,
        scanLimit: options.scanLimit,
        command: message.content,
      });
      return;
    }

    const summary = await eliminateAllMatching(channels.channels, options, message.id);
    await message.channel?.send({
      content: renderResult('Mass eliminate complete', options, summary),
    });
    await logPurgeAction(client, {
      action: 'Mass eliminate all matching messages',
      executorId: message.authorId,
      targetUserId: options.userId,
      channelScope: renderChannelScope(options.channelScope),
      deleted: summary.deleted,
      failed: summary.failed,
      channels: summary.channelsTouched.size,
      command: message.content,
    });
  } catch (error) {
    console.error('Error executing purge command:', error);
    await message.channel?.send({
      content: `❌ Purge failed: ${error?.message || error}`,
    });
  }
}

function parsePurgeArgs(args: string[]): { ok: true; options: PurgeOptions } | { ok: false; error?: string } {
  const tokens = [...(args || [])].filter(Boolean);

  if (tokens.length === 0 || ['help', '-h', '--help'].includes(tokens[0]?.toLowerCase())) {
    return { ok: false };
  }

  let confirmed = false;
  let scanLimit = DEFAULT_USER_SCAN_LIMIT;
  const positional: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();

    if (['--confirm', '--yes', '-y'].includes(lower)) {
      confirmed = true;
      continue;
    }

    if (['--scan', '--max-scan', '--scan-limit'].includes(lower)) {
      const rawLimit = tokens[++i];
      const parsedLimit = parsePositiveInt(rawLimit);
      if (!parsedLimit) {
        return { ok: false, error: `Invalid scan limit: \`${rawLimit || ''}\`.` };
      }
      scanLimit = Math.min(parsedLimit, 50000);
      continue;
    }

    positional.push(token);
  }

  const first = positional.shift()?.toLowerCase();
  let mode: PurgeMode;
  let count: number | null = null;

  if (first === 'last') {
    mode = 'last';
    count = parsePositiveInt(positional.shift());
    if (!count) {
      return { ok: false, error: 'Usage for last mode: `purge last <count> [user] [channel|all-channels]`.' };
    }
  } else if (first === 'count' || first === 'amount' || first === 'total') {
    mode = 'count';
  } else if (first === 'all' || first === 'everything') {
    mode = 'all';
  } else {
    count = parsePositiveInt(first);
    if (!count) {
      return { ok: false, error: `Unknown purge mode: \`${first || ''}\`.` };
    }
    mode = 'last';
  }

  if (count && count > MAX_LAST_COUNT) {
    return { ok: false, error: `For safety, last-mode count is capped at ${MAX_LAST_COUNT}. Use \`purge all ... --confirm\` for larger wipes.` };
  }

  let userId: string | null = null;
  let channelScope: ChannelScope = { type: 'current' };

  for (let i = 0; i < positional.length; i++) {
    const token = positional[i];
    const lower = token.toLowerCase();

    if (['--user', 'user', 'from', 'by', 'author'].includes(lower)) {
      const value = positional[++i];
      userId = normalizeUserId(value);
      if (!userId) return { ok: false, error: `Invalid user: \`${value || ''}\`.` };
      continue;
    }

    if (['--channel', 'channel', 'in'].includes(lower)) {
      const value = positional[++i];
      const parsedScope = parseChannelScope(value);
      if (!parsedScope) return { ok: false, error: `Invalid channel: \`${value || ''}\`.` };
      channelScope = parsedScope;
      continue;
    }

    const parsedScope = parseChannelScope(token);
    if (parsedScope) {
      channelScope = parsedScope;
      continue;
    }

    const prefixedUser = token.match(/^(?:user|from|by|author):(.+)$/i)?.[1];
    if (prefixedUser) {
      userId = normalizeUserId(prefixedUser);
      if (!userId) return { ok: false, error: `Invalid user: \`${token}\`.` };
      continue;
    }

    const prefixedChannel = token.match(/^(?:channel|chan|in):(.+)$/i)?.[1];
    if (prefixedChannel) {
      const parsed = parseChannelScope(prefixedChannel) || normalizeChannelId(prefixedChannel);
      if (!parsed) return { ok: false, error: `Invalid channel: \`${token}\`.` };
      channelScope = typeof parsed === 'string' ? { type: 'single', channelId: parsed } : parsed;
      continue;
    }

    const parsedUser = normalizeUserId(token);
    if (parsedUser && !userId) {
      userId = parsedUser;
      continue;
    }

    return { ok: false, error: `Could not understand argument: \`${token}\`.` };
  }

  if (mode === 'count' && !userId) {
    return { ok: false, error: 'Usage for count mode: `purge count <user> [channel|all-channels]`.' };
  }

  return {
    ok: true,
    options: {
      mode,
      count,
      userId,
      channelScope,
      confirmed,
      scanLimit,
    },
  };
}

async function canUsePurge(message, client): Promise<boolean> {
  const decision = await currentBotPermission(client, config.serverId, message.authorId);
  if (decision) return decision === 'allow';

  const member = await fetchCommandMember(message, client);
  if (!member) return false;

  if (isSupportStaff(member, config.supportRoleId)) return true;

  if (typeof member.hasPermission === 'function') {
    const permissionNames = ['ManageMessages', 'MANAGE_MESSAGES', 'Manage Messages'];
    for (const name of permissionNames) {
      try {
        if (member.hasPermission(name)) return true;
      } catch {
        // try the next spelling
      }
    }
  }

  return false;
}

async function fetchCommandMember(message, client) {
  let server = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }

  return server?.members?.fetch(message.authorId).catch(() => server?.members?.cache?.get?.(message.authorId) || null);
}

async function resolveTargetChannels(message, client, scope: ChannelScope): Promise<{ ok: true; channels: any[] } | { ok: false; error: string }> {
  if (scope.type === 'current') {
    const channel = await resolveChannel(client, message.channelId);
    if (!isServerTextChannel(channel)) {
      return { ok: false, error: 'This command must target a server text channel.' };
    }
    return { ok: true, channels: [channel] };
  }

  if (scope.type === 'single') {
    const channel = await resolveChannel(client, scope.channelId);
    if (!isServerTextChannel(channel)) {
      return { ok: false, error: `Channel \`${scope.channelId}\` is not a server text channel or could not be fetched.` };
    }
    return { ok: true, channels: [channel] };
  }

  const channels = await fetchServerTextChannels(client);
  return { ok: true, channels };
}

async function resolveChannel(client, channelId: string) {
  return client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
}

async function fetchServerTextChannels(client): Promise<any[]> {
  const channelsById = new Map<string, any>();

  try {
    await client.servers.fetch(config.serverId);
  } catch {
    // cache fallback below
  }

  const server = client.servers.cache.get(config.serverId);
  addChannelsFromSource(channelsById, server?.channels?.cache);
  addChannelsFromSource(channelsById, server?.channels);
  addChannelsFromSource(channelsById, client.channels?.cache);

  // Best-effort fallback: if raw server data has channel IDs not cached, fetch them.
  try {
    const data = await client.api.get(`/servers/${config.serverId}`, { include_channels: true });
    const rawChannels = Array.isArray(data?.channels) ? data.channels : [];
    for (const raw of rawChannels) {
      const id = raw?._id || raw?.id;
      if (!id || channelsById.has(id)) continue;
      const channel = await client.channels.fetch(id).catch(() => null);
      if (isServerTextChannel(channel)) {
        channelsById.set(channel.id, channel);
      }
    }
  } catch {
    // cache-only is acceptable
  }

  return [...channelsById.values()].filter(isServerTextChannel);
}

function addChannelsFromSource(channelsById: Map<string, any>, source: any) {
  const values = source instanceof Map
    ? [...source.values()]
    : Array.isArray(source)
      ? source
      : source?.cache instanceof Map
        ? [...source.cache.values()]
        : [];

  for (const channel of values) {
    if (isServerTextChannel(channel)) {
      channelsById.set(channel.id, channel);
    }
  }
}

function isServerTextChannel(channel: any): boolean {
  if (!channel || typeof channel.isText !== 'function' || !channel.isText()) return false;
  if (typeof channel.inServer === 'function' && !channel.inServer()) return false;
  if (channel.serverId && channel.serverId !== config.serverId) return false;
  return !!channel.messages;
}

async function collectLastTargets(channels: any[], options: PurgeOptions, commandMessageId: string): Promise<MessageTarget[]> {
  const allTargets: MessageTarget[] = [];
  const perChannelLimit = options.userId ? options.scanLimit : options.count;

  for (const channel of channels) {
    const targets = await collectChannelTargets(channel, {
      userId: options.userId,
      maxMatches: channels.length === 1 ? options.count : null,
      maxScanned: perChannelLimit || options.scanLimit,
      commandMessageId,
    });

    allTargets.push(...targets);
  }

  allTargets.sort((a, b) => compareMessagesNewest(a.message, b.message));
  return allTargets.slice(0, options.count || 0);
}

async function collectChannelTargets(
  channel,
  options: { userId: string | null; maxMatches: number | null; maxScanned: number; commandMessageId: string }
): Promise<MessageTarget[]> {
  const targets: MessageTarget[] = [];
  let before: string | undefined;
  let scanned = 0;

  while (true) {
    if (options.maxScanned && scanned >= options.maxScanned) break;

    const limit = options.maxScanned
      ? Math.min(PAGE_SIZE, Math.max(1, options.maxScanned - scanned))
      : PAGE_SIZE;

    const messages = await fetchMessagePage(channel, limit, before);
    if (messages.length === 0) break;

    scanned += messages.length;
    before = messages[messages.length - 1]?.id;

    for (const msg of messages) {
      if (isMatchingMessage(msg, options.userId, options.commandMessageId)) {
        targets.push({ id: msg.id, channel, message: msg });
      }
    }

    if (options.maxMatches && targets.length >= options.maxMatches) break;
    if (messages.length < limit) break;
  }

  return options.maxMatches ? targets.slice(0, options.maxMatches) : targets;
}

async function eliminateAllMatching(channels: any[], options: PurgeOptions, commandMessageId: string): Promise<DeleteSummary> {
  const total: DeleteSummary = {
    deleted: 0,
    failed: 0,
    channelsTouched: new Set<string>(),
  };

  for (const channel of channels) {
    let before: string | undefined;

    while (true) {
      const messages = await fetchMessagePage(channel, PAGE_SIZE, before);
      if (messages.length === 0) break;

      before = messages[messages.length - 1]?.id;

      const targets = messages
        .filter((msg) => isMatchingMessage(msg, options.userId, commandMessageId))
        .map((msg) => ({ id: msg.id, channel, message: msg }));

      if (targets.length > 0) {
        const summary = await deleteTargets(targets);
        mergeSummary(total, summary);
      }

      if (messages.length < PAGE_SIZE) break;
    }
  }

  return total;
}

async function countMatchingMessages(channels: any[], options: PurgeOptions, commandMessageId: string): Promise<{ matched: number; scanned: number; channelsMatched: Set<string>; channelsScanned: number }> {
  const summary = {
    matched: 0,
    scanned: 0,
    channelsMatched: new Set<string>(),
    channelsScanned: 0,
  };

  for (const channel of channels) {
    let before: string | undefined;
    let scannedInChannel = 0;

    while (true) {
      if (options.scanLimit && scannedInChannel >= options.scanLimit) break;

      const limit = Math.min(PAGE_SIZE, Math.max(1, options.scanLimit - scannedInChannel));
      const messages = await fetchMessagePage(channel, limit, before);
      if (messages.length === 0) break;

      scannedInChannel += messages.length;
      summary.scanned += messages.length;
      before = messages[messages.length - 1]?.id;

      const matched = messages.filter((msg) => isMatchingMessage(msg, options.userId, commandMessageId)).length;
      if (matched > 0) {
        summary.matched += matched;
        summary.channelsMatched.add(channel.id);
      }

      if (messages.length < limit) break;
    }

    if (scannedInChannel > 0) {
      summary.channelsScanned += 1;
    }
  }

  return summary;
}

async function fetchMessagePage(channel, limit: number, before?: string): Promise<any[]> {
  const query: any = { limit };
  if (before) query.before = before;

  const result = await channel.messages.fetch(query);
  return result instanceof Map ? [...result.values()] : [];
}

function isMatchingMessage(message, userId: string | null, commandMessageId: string): boolean {
  if (!message?.id || message.id === commandMessageId) return false;
  if (!userId) return true;

  return getMessageAuthorId(message) === userId;
}

function getMessageAuthorId(message): string | null {
  return (
    (typeof message?.authorId === 'string' && message.authorId) ||
    (typeof message?.author === 'string' && message.author) ||
    (typeof message?.author?.id === 'string' && message.author.id) ||
    (typeof message?.author?._id === 'string' && message.author._id) ||
    (typeof message?.member?.id === 'string' && message.member.id) ||
    (typeof message?.member?._id?.user === 'string' && message.member._id.user) ||
    null
  );
}

async function deleteTargets(targets: MessageTarget[]): Promise<DeleteSummary> {
  const summary: DeleteSummary = {
    deleted: 0,
    failed: 0,
    channelsTouched: new Set<string>(),
  };

  const byChannel = new Map<string, { channel: any; ids: string[] }>();

  for (const target of targets) {
    const id = target.id || target.message?.id;
    const channelId = target.channel?.id;
    if (!id || !channelId) continue;

    if (!byChannel.has(channelId)) {
      byChannel.set(channelId, { channel: target.channel, ids: [] });
    }

    const entry = byChannel.get(channelId)!;
    if (!entry.ids.includes(id)) {
      entry.ids.push(id);
    }
  }

  for (const [channelId, entry] of byChannel) {
    for (const chunk of chunkArray(entry.ids, BULK_DELETE_SIZE)) {
      try {
        await entry.channel.messages.bulkDelete(chunk);
        summary.deleted += chunk.length;
        summary.channelsTouched.add(channelId);
      } catch (bulkError) {
        console.warn(`Bulk delete failed in channel ${channelId}; falling back to single deletes:`, bulkError?.message || bulkError);

        for (const id of chunk) {
          try {
            await entry.channel.messages.delete(id);
            summary.deleted += 1;
            summary.channelsTouched.add(channelId);
          } catch (singleError) {
            summary.failed += 1;
            console.warn(`Failed to delete message ${id} in channel ${channelId}:`, singleError?.message || singleError);
          }
        }
      }
    }
  }

  return summary;
}

function mergeSummary(total: DeleteSummary, add: DeleteSummary) {
  total.deleted += add.deleted;
  total.failed += add.failed;
  for (const channelId of add.channelsTouched) {
    total.channelsTouched.add(channelId);
  }
}

function compareMessagesNewest(a, b): number {
  const aTime = Date.parse(a?.createdAt || '');
  const bTime = Date.parse(b?.createdAt || '');

  if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }

  return String(b?.id || '').localeCompare(String(a?.id || ''));
}

async function sendHelp(message, error?: string) {
  await message.channel?.send({
    content:
      (error ? `❌ ${error}\n\n` : '') +
      `# 🧹 Purge / MassEliminate Help\n\n` +
      `Aliases: \`${config.prefix}purge\`, \`${config.prefix}masseliminate\`, \`${config.prefix}mass-eliminate\`\n\n` +
      `**Count user messages (no delete)**\n` +
      `• \`${config.prefix}purge count @user\` - Count matching messages from a user in this channel\n` +
      `• \`${config.prefix}purge count @user #channel\` - Count messages from a user in a specified channel\n` +
      `• \`${config.prefix}purge count @user all-channels\` - Count messages from a user across all text channels\n` +
      `• Add \`--scan <amount>\` to change the per-channel scan limit (default ${DEFAULT_USER_SCAN_LIMIT})\n\n` +
      `**Delete last messages**\n` +
      `• \`${config.prefix}purge <count>\` - Delete last messages in this channel\n` +
      `• \`${config.prefix}purge last <count> @user\` - Delete last messages from one user in this channel\n` +
      `• \`${config.prefix}purge last <count> @user #channel\` - Target a specified channel\n` +
      `• \`${config.prefix}purge last <count> @user all-channels\` - Target all server channels\n\n` +
      `**Mass eliminate all matches**\n` +
      `• \`${config.prefix}purge all #channel --confirm\` - Delete all messages in a channel\n` +
      `• \`${config.prefix}purge all @user #channel --confirm\` - Delete all messages from a user in a channel\n` +
      `• \`${config.prefix}purge all @user all-channels --confirm\` - Delete all messages from a user in all channels\n` +
      `• \`${config.prefix}purge all all-channels --confirm\` - Delete every message the bot can delete in every text channel\n\n` +
      `Options: \`--user <id>\`, \`--channel <id>\`, \`--scan <amount>\`, \`--confirm\`.`,
  });
}

function renderSummary(options: PurgeOptions, warning = false): string {
  const action = options.mode === 'last'
    ? `delete the last ${options.count} matching message(s)`
    : 'delete every matching message';
  const user = options.userId ? `<@${options.userId}> (${options.userId})` : 'anyone';
  const channel = renderChannelScope(options.channelScope);

  return `${warning ? '**Pending action:** ' : '**Action:** '}${action}\n**Author filter:** ${user}\n**Channel target:** ${channel}`;
}

function renderResult(title: string, options: PurgeOptions, summary: DeleteSummary, planned?: number): string {
  const plannedLine = typeof planned === 'number' ? `**Matched:** ${planned}\n` : '';
  return (
    `# ✅ ${title}\n\n` +
    renderSummary(options) +
    `\n\n${plannedLine}` +
    `**Deleted:** ${summary.deleted}\n` +
    `**Failed:** ${summary.failed}\n` +
    `**Channels touched:** ${summary.channelsTouched.size}`
  );
}

function renderCountResult(options: PurgeOptions, summary: { matched: number; scanned: number; channelsMatched: Set<string>; channelsScanned: number }): string {
  const user = options.userId ? `<@${options.userId}> (${options.userId})` : 'anyone';
  return (
    `# 🔎 Purge Count\n\n` +
    `**Author filter:** ${user}\n` +
    `**Channel target:** ${renderChannelScope(options.channelScope)}\n` +
    `**Matching messages:** ${summary.matched}\n` +
    `**Messages scanned:** ${summary.scanned}\n` +
    `**Channels scanned:** ${summary.channelsScanned}\n` +
    `**Channels with matches:** ${summary.channelsMatched.size}\n` +
    `**Per-channel scan limit:** ${options.scanLimit}`
  );
}

function renderChannelScope(scope: ChannelScope): string {
  if (scope.type === 'all') return 'all text channels';
  if (scope.type === 'single') return `<#${scope.channelId}> (${scope.channelId})`;
  return 'current channel';
}

function parseChannelScope(value?: string | null): ChannelScope | null {
  const input = String(value || '').trim();
  const lower = input.toLowerCase();

  if (!input) return null;
  if (['all-channels', 'allchannels', 'all_channels', 'everywhere', 'server', 'guild'].includes(lower)) {
    return { type: 'all' };
  }
  if (['here', 'current', 'this-channel', 'this'].includes(lower)) {
    return { type: 'current' };
  }

  const channelId = normalizeChannelId(input);
  return channelId ? { type: 'single', channelId } : null;
}

function normalizeUserId(value?: string | null): string | null {
  const input = String(value || '').trim();
  if (!input) return null;

  const mentionMatch = input.match(/^<@!?([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];

  const tagMatch = input.match(/^@<([A-Za-z0-9_-]+)>$/);
  if (tagMatch?.[1]) return tagMatch[1];

  const prefixedMatch = input.match(/^@([A-Za-z0-9_-]+)$/);
  if (prefixedMatch?.[1]) return prefixedMatch[1];

  return /^[A-Za-z0-9_-]{8,}$/.test(input) ? input : null;
}

function normalizeChannelId(value?: string | null): string | null {
  const input = String(value || '').trim();
  if (!input) return null;

  const mentionMatch = input.match(/^<#([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];

  const tagMatch = input.match(/^#<([A-Za-z0-9_-]+)>$/);
  if (tagMatch?.[1]) return tagMatch[1];

  const prefixedMatch = input.match(/^#([A-Za-z0-9_-]+)$/);
  if (prefixedMatch?.[1]) return prefixedMatch[1];

  return /^[A-Za-z0-9_-]{8,}$/.test(input) ? input : null;
}

function parsePositiveInt(value?: string | null): number | null {
  const input = String(value || '').trim();
  if (!/^\d+$/.test(input)) return null;

  const number = Number.parseInt(input, 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}