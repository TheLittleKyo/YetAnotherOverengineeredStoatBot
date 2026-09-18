import { config } from '../config.js';
import { requirePermission } from '../permissions.js';
import {
  getSubscriptions,
  addSubscription,
  removeSubscription,
  generateSubscriptionId,
  getProviderInfos,
  getProvider,
  startNotificationScheduler,
} from '../notifications/index.js';
import type { PlatformId, Subscription } from '../notifications/index.js';

/**
 * !notify add <platform> <target> [extra=value ...] — add a subscription in the current channel
 * !notify remove <id> — remove a subscription
 * !notify list — list subscriptions in the current server
 * !notify test <platform> <target> — poll once and show the result
 * !notify platforms — list supported platforms
 * !notify help — show help
 */
export async function notifyCommand(message, args, client) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (sub === 'platforms') {
    await sendPlatforms(message);
    return;
  }

  if (sub === 'list') {
    await sendList(message);
    return;
  }

  if (sub === 'add' || sub === 'new' || sub === 'create') {
    if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
    await handleAdd(message, args, client);
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
    await handleRemove(message, args);
    return;
  }

  if (sub === 'test') {
    // `test` fetches an arbitrary target URL server-side (SSRF surface); gate it.
    if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
    await handleTest(message, args);
    return;
  }

  if (sub === 'editor' || sub === 'edit' || sub === 'web' || sub === 'dashboard') {
    if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
    await message.channel?.send({
      content:
        `ℹ️ The notify editor now lives in the dashboard. Run \`${config.prefix}dashboard\` and open the **Notify** tab.`,
    });
    return;
  }

  await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
}

async function handleAdd(message, args, client) {
  const platform = String(args.shift() || '').toLowerCase() as PlatformId;
  const target = args.shift();

  if (!platform || !target) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}notify add <platform> <target> [extra=value ...]\`\nExample: \`${config.prefix}notify add twitch shroud\``,
    });
    return;
  }

  const infos = getProviderInfos();
  const info = infos.find((p) => p.id === platform);
  if (!info) {
    await message.channel?.send({
      content: `❌ Unknown platform \`${platform}\`. Use \`${config.prefix}notify platforms\` to see supported platforms.`,
    });
    return;
  }

  // Parse extra=value args.
  const extra: Record<string, string> = {};
  for (const arg of args) {
    const match = String(arg).match(/^([a-zA-Z_]+)=(.+)$/);
    if (match) {
      extra[match[1].toLowerCase()] = match[2];
    }
  }

  // Validate required extra fields.
  if (info.extraFields) {
    for (const field of info.extraFields) {
      if (field.required && !extra[field.key]) {
        await message.channel?.send({
          content: `❌ Missing required field \`${field.key}\` for ${info.label}.\nExample: \`${config.prefix}notify add ${platform} ${target} ${field.key}=${field.placeholder || 'value'}\``,
        });
        return;
      }
    }
  }

  const subscription: Subscription = {
    id: generateSubscriptionId(),
    platform,
    target,
    channelId: message.channelId,
    serverId: message.serverId || config.serverId,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    createdAt: new Date().toISOString(),
    enabled: true,
  };

  addSubscription(subscription);

  // Ensure scheduler is running (idempotent).
  startNotificationScheduler(client);

  await message.channel?.send({
    content:
      `✅ Subscription added.\n` +
      `• ID: \`${subscription.id}\`\n` +
      `• Platform: ${info.label}\n` +
      `• Target: \`${target}\`\n` +
      `• Channel: <#${subscription.channelId}>\n` +
      (Object.keys(extra).length > 0 ? `• Extra: ${Object.entries(extra).map(([k, v]) => `${k}=\`${v}\``).join(', ')}\n` : '') +
      `\nNotifications will start within 1-3 minutes. Use \`${config.prefix}notify test ${platform} ${target}\` to poll once now.`,
  });
}

async function handleRemove(message, args) {
  const id = String(args.shift() || '').trim();
  if (!id) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}notify remove <id>\`` });
    return;
  }

  const removed = removeSubscription(id);
  await message.channel?.send({
    content: removed ? `✅ Removed subscription \`${id}\`.` : `❌ No subscription with ID \`${id}\`.`,
  });
}

async function handleTest(message, args) {
  const platform = String(args.shift() || '').toLowerCase() as PlatformId;
  const target = args.shift();

  if (!platform || !target) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}notify test <platform> <target>\`\nExample: \`${config.prefix}notify test twitch shroud\``,
    });
    return;
  }

  const provider = getProvider(platform);
  if (!provider) {
    await message.channel?.send({ content: `❌ Unknown platform \`${platform}\`.` });
    return;
  }

  await message.channel?.send({ content: `⏳ Testing ${provider.info.label} \`${target}\`…` });

  try {
    const result = await provider.poll(
      { id: 'test', platform, target, channelId: '', serverId: '', createdAt: '', enabled: true },
      undefined,
    );

    if (result.error) {
      await message.channel?.send({ content: `❌ ${provider.info.label} \`${target}\`: ${result.error}` });
      return;
    }

    if (provider.info.kind === 'live') {
      const status = result.isLive ? `🔴 LIVE${result.title ? ` — **${result.title}**` : ''}${typeof result.viewers === 'number' ? ` · ${result.viewers} viewers` : ''}` : '⚫ Offline';
      await message.channel?.send({ content: `✅ ${provider.info.label} \`${target}\`: ${status}\n${result.url || ''}` });
    } else {
      const count = result.newPosts?.length || 0;
      const lines = (result.newPosts || []).slice(0, 5).map((p) => `• ${p.title || p.url}`);
      await message.channel?.send({
        content: `✅ ${provider.info.label} \`${target}\`: ${count} new post(s)${lines.length > 0 ? '\n' + lines.join('\n') : ''}`,
      });
    }
  } catch (error: any) {
    await message.channel?.send({ content: `❌ Test failed: ${error?.message || error}` });
  }
}

async function sendList(message) {
  const serverId = message.serverId || config.serverId;
  const subs = getSubscriptions().filter((s) => !serverId || s.serverId === serverId);

  if (subs.length === 0) {
    await message.channel?.send({ content: 'ℹ️ No notification subscriptions in this server.' });
    return;
  }

  const lines = subs.map((s) => {
    const status = s.enabled ? '✅' : '⏸️';
    return `${status} \`${s.id}\` — ${s.platform} / \`${s.target}\` → <#${s.channelId}>`;
  });

  await message.channel?.send({
    content: `# 🔔 Notification Subscriptions (${subs.length})\n\n${lines.join('\n')}`,
  });
}

async function sendPlatforms(message) {
  const infos = getProviderInfos();
  const lines = infos.map((p) => {
    const extra = p.extraFields?.length ? ` (extra: ${p.extraFields.map((f) => f.key).join(', ')})` : '';
    return `• \`${p.id}\` — ${p.label} (${p.kind})${extra}`;
  });
  await message.channel?.send({
    content: `# 📺 Supported Platforms\n\n${lines.join('\n')}\n\nUse \`${config.prefix}notify add <platform> <target>\` to subscribe.`,
  });
}

async function sendHelp(message, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# 🔔 Notify Commands\n\n` +
      `\`${config.prefix}notify add <platform> <target> [extra=value ...]\` — Subscribe this channel to a platform account\n` +
      `\`${config.prefix}notify remove <id>\` — Remove a subscription\n` +
      `\`${config.prefix}notify list\` — List subscriptions in this server\n` +
      `\`${config.prefix}notify test <platform> <target>\` — Poll once and show the result\n` +
      `\`${config.prefix}notify platforms\` — List supported platforms\n` +
      `\`${config.prefix}notify help\` — Show this help\n\n` +
      `**Examples:**\n` +
      `\`${config.prefix}notify add twitch shroud\`\n` +
      `\`${config.prefix}notify add youtube @MrBeast\`\n` +
      `\`${config.prefix}notify add mastodon Gargron instance=mastodon.social\`\n` +
      `\`${config.prefix}notify add rsshub rsshubBase=https://my-rsshub.example.com\`\n` +
      `\`${config.prefix}notify add rss https://example.com/feed.xml\`\n\n` +
      `Live platforms notify on OFFLINE → LIVE. Post platforms notify on each new post. State is persisted across restarts.`,
  });
}
