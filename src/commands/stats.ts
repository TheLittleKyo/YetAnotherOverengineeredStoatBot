import { config } from '../config.js';
import { getStatsChannels, refreshStatsChannels, removeStatsChannel, upsertStatsChannel } from '../stats.js';
import { logStatsAction } from '../log-system.js';
import { requirePermission } from '../permissions.js';
import { normalizeId } from '../id-utils.js';

/**
 * Stats channels command group
 *
 * Examples:
 * !stats add all <channelId> [label]
 * !stats add role <roleId> <channelId> [label]
 * !stats remove <channelId>
 * !stats list
 * !stats refresh
 */
// The server this command is acting on. Stats channels are per-server; a chat
// command scopes to the server the message came from, falling back to the
// configured default.
function messageServerId(message: any): string {
  return message?.channel?.serverId || message?.serverId || message?.server?._id || message?.server?.id || config.serverId;
}

export async function statsCommand(message, args, client) {
  const subcommand = (args.shift() || '').toLowerCase();

  if (!subcommand || subcommand === 'help') {
    await sendStatsHelp(message);
    return;
  }

  // `list` and `refresh` are safe for everyone; mutating subcommands need ManageChannels.
  if (subcommand === 'add' || subcommand === 'remove') {
    if (!(await requirePermission(message, client, ['ManageChannels', 'ManageChannel'], 'Manage Channels'))) return;
  }

  if (subcommand === 'add') {
    await handleAdd(message, args, client);
    return;
  }

  if (subcommand === 'remove') {
    await handleRemove(message, args, client);
    return;
  }

  if (subcommand === 'list') {
    await handleList(message, client);
    return;
  }

  if (subcommand === 'refresh') {
    await handleRefresh(message, client);
    return;
  }

  await sendStatsHelp(message);
}

async function handleAdd(message, args, client) {
  const serverId = messageServerId(message);
  const mode = (args.shift() || '').toLowerCase();

  if (mode === 'all') {
    const channelId = normalizeId(args.shift());
    const label = args.join(' ').trim() || 'Members';

    if (!channelId) {
      await message.channel?.send({
        content: `❌ Usage: \`${config.prefix}stats add all <channelId> [label]\``,
      });
      return;
    }

    upsertStatsChannel({
      channelId,
      mode: 'all',
      label,
      serverId,
    });

    const summary = await refreshStatsChannels(client, serverId);
    await message.channel?.send({
      content:
        `✅ Added stats channel for all members.\n` +
        `• Channel: <#${channelId}> (\`${channelId}\`)\n` +
        `• Label: \`${label}\`\n` +
        `• Refreshed: updated ${summary.updated}, skipped ${summary.skipped}`,
    });
    await logStatsAction(client, {
      action: 'Add all-members stats channel',
      serverId: messageServerId(message),
      executorId: message.authorId,
      channelId,
      label,
      configured: summary.configured,
      updated: summary.updated,
      skipped: summary.skipped,
      command: message.content,
    });
    return;
  }

  if (mode === 'role') {
    const roleId = normalizeId(args.shift());
    const channelId = normalizeId(args.shift());
    const label = args.join(' ').trim() || 'Role Members';

    if (!roleId || !channelId) {
      await message.channel?.send({
        content: `❌ Usage: \`${config.prefix}stats add role <roleId> <channelId> [label]\``,
      });
      return;
    }

    upsertStatsChannel({
      channelId,
      mode: 'role',
      roleId,
      label,
      serverId,
    });

    const summary = await refreshStatsChannels(client, serverId);
    await message.channel?.send({
      content:
        `✅ Added role stats channel.\n` +
        `• Role: <%${roleId}> (\`${roleId}\`)\n` +
        `• Channel: <#${channelId}> (\`${channelId}\`)\n` +
        `• Label: \`${label}\`\n` +
        `• Refreshed: updated ${summary.updated}, skipped ${summary.skipped}`,
    });
    await logStatsAction(client, {
      action: 'Add role stats channel',
      serverId: messageServerId(message),
      executorId: message.authorId,
      channelId,
      roleId,
      label,
      configured: summary.configured,
      updated: summary.updated,
      skipped: summary.skipped,
      command: message.content,
    });
    return;
  }

  await message.channel?.send({
    content:
      `❌ Invalid mode. Use \`${config.prefix}stats add all ...\` or \`${config.prefix}stats add role ...\`.`,
  });
}

async function handleRemove(message, args, client) {
  const channelId = normalizeId(args.shift());
  if (!channelId) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}stats remove <channelId>\``,
    });
    return;
  }

  const removed = removeStatsChannel(channelId);
  if (!removed) {
    await message.channel?.send({
      content: `⚠️ No stats channel config found for <#${channelId}> (\`${channelId}\`).`,
    });
    return;
  }

  await message.channel?.send({
    content: `✅ Removed stats channel config for <#${channelId}> (\`${channelId}\`).`,
  });
  await logStatsAction(client, {
    action: 'Remove stats channel',
    serverId: messageServerId(message),
    executorId: message.authorId,
    channelId,
    command: message.content,
  });
}

async function handleList(message, client) {
  const channels = getStatsChannels(messageServerId(message));

  if (channels.length === 0) {
    await message.channel?.send({
      content: `ℹ️ No stats channels configured yet.`,
    });
    return;
  }

  const rows = channels.map((entry, index) => {
    if (entry.mode === 'all') {
      return `${index + 1}. [all] channel=<#${entry.channelId}> label=\`${entry.label || 'Members'}\``;
    }

    return `${index + 1}. [role] role=<%${entry.roleId}> channel=<#${entry.channelId}> label=\`${entry.label || 'Role Members'}\``;
  });

  await message.channel?.send({
    content: `# 📊 Stats Channels\n\n${rows.join('\n')}`,
  });
  await logStatsAction(client, {
    action: 'List stats channels',
    serverId: messageServerId(message),
    executorId: message.authorId,
    configured: channels.length,
    command: message.content,
  });
}

async function handleRefresh(message, client) {
  const summary = await refreshStatsChannels(client, messageServerId(message));
  await message.channel?.send({
    content:
      `✅ Stats refresh complete.\n` +
      `• Configured: ${summary.configured}\n` +
      `• Updated: ${summary.updated}\n` +
      `• Skipped: ${summary.skipped}`,
  });
  await logStatsAction(client, {
    action: 'Refresh stats channels',
    serverId: messageServerId(message),
    executorId: message.authorId,
    configured: summary.configured,
    updated: summary.updated,
    skipped: summary.skipped,
    command: message.content,
  });
}

async function sendStatsHelp(message) {
  await message.channel?.send({
    content:
      `# 📊 Stats Channels Help\n\n` +
      `\`${config.prefix}stats add all <channelId> [label]\` - Track all members in a channel\n` +
      `\`${config.prefix}stats add role <roleId> <channelId> [label]\` - Track members for a specific role\n` +
      `\`${config.prefix}stats remove <channelId>\` - Remove a configured stats channel\n` +
      `\`${config.prefix}stats list\` - List configured stats channels\n` +
      `\`${config.prefix}stats refresh\` - Force refresh all configured stats channels`,
  });
}
