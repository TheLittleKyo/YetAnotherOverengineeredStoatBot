import { config } from '../config.js';
import { requirePermission } from '../permissions.js';
import {
  clearWelcomeConfig,
  getEffectiveWelcomeConfig,
  getSelectedWelcomeImageCount,
  getWelcomeConfig,
  sendWelcomeForMember,
  updateWelcomeConfig,
  type WelcomeConfig,
} from '../welcome.js';

export async function welcomeCommand(message, args, client) {
  const sub = String(args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  // Read-only subcommands are public; everything else mutates server welcome
  // config (or spawns the editor / triggers image generation) and needs Manage Server.
  const publicSubcommands = new Set(['status', 'list']);
  if (!publicSubcommands.has(sub)) {
    if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
  }

  if (sub === 'editor' || sub === 'edit' || sub === 'web' || sub === 'dashboard') {
    await message.channel?.send({
      content:
        `ℹ️ The welcome editor now lives in the dashboard. Run \`${config.prefix}dashboard\` and open the **Welcomer** tab.`,
    });
    return;
  }

  if (sub === 'set' || sub === 'channel') {
    const channelId = normalizeId(args[0]);
    if (!channelId) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}welcome set <channelId>\`` });
      return;
    }

    const next = updateWelcomeConfig({ channelId, enabled: true }, config.serverId);
    await message.channel?.send({
      content: next
        ? `✅ Welcome channel set to <#${channelId}> and welcomes are enabled.`
        : '❌ Could not save welcome config. Is SERVER_ID configured?',
    });
    return;
  }

  if (sub === 'enable' || sub === 'on') {
    const next = updateWelcomeConfig({ enabled: true }, config.serverId);
    await message.channel?.send({
      content: next?.channelId
        ? `✅ Welcomes enabled in <#${next.channelId}>.`
        : `⚠️ Welcomes enabled, but no channel is configured. Use \`${config.prefix}welcome set <channelId>\`.`,
    });
    return;
  }

  if (sub === 'disable' || sub === 'off') {
    updateWelcomeConfig({ enabled: false }, config.serverId);
    await message.channel?.send({ content: '✅ Welcomes disabled.' });
    return;
  }

  if (sub === 'message') {
    const template = args.join(' ').trim();
    if (!template) {
      await message.channel?.send({
        content: `❌ Usage: \`${config.prefix}welcome message Welcome {mention} to {server}!\``,
      });
      return;
    }

    updateWelcomeConfig({ message: template }, config.serverId);
    await message.channel?.send({ content: `✅ Welcome message updated. Preview:\n${template}` });
    return;
  }

  if (sub === 'image') {
    const value = String(args[0] || '').toLowerCase();
    if (value !== 'on' && value !== 'off') {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}welcome image <on|off>\`` });
      return;
    }

    updateWelcomeConfig({ imageEnabled: value === 'on' }, config.serverId);
    await message.channel?.send({ content: `✅ Welcome image ${value === 'on' ? 'enabled' : 'disabled'}.` });
    return;
  }

  if (sub === 'background' || sub === 'bg') {
    const background = args.join(' ').trim();
    if (!background) {
      await message.channel?.send({
        content: `❌ Usage: \`${config.prefix}welcome background <hex|color|imageUrl>\``,
      });
      return;
    }

    updateWelcomeConfig({ background }, config.serverId);
    await message.channel?.send({ content: `✅ Welcome background updated to \`${background}\`.` });
    return;
  }

  if (sub === 'textcolor' || sub === 'text') {
    const textColor = args[0];
    if (!isColor(textColor)) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}welcome textcolor <#ffffff|color>\`` });
      return;
    }

    updateWelcomeConfig({ textColor }, config.serverId);
    await message.channel?.send({ content: `✅ Welcome text color updated to \`${textColor}\`.` });
    return;
  }

  if (sub === 'accent' || sub === 'accentcolor') {
    const accentColor = args[0];
    if (!isColor(accentColor)) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}welcome accent <#38bdf8|color>\`` });
      return;
    }

    updateWelcomeConfig({ accentColor }, config.serverId);
    await message.channel?.send({ content: `✅ Welcome accent color updated to \`${accentColor}\`.` });
    return;
  }

  if (sub === 'layout') {
    const layout = String(args[0] || '').toLowerCase();
    if (layout !== 'classic' && layout !== 'compact' && layout !== 'banner') {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}welcome layout <classic|compact|banner>\`` });
      return;
    }

    updateWelcomeConfig({ layout: layout as WelcomeConfig['layout'] }, config.serverId);
    await message.channel?.send({ content: `✅ Welcome layout updated to \`${layout}\`.` });
    return;
  }

  if (sub === 'status' || sub === 'list') {
    const stored = getWelcomeConfig(config.serverId);
    const effective = getEffectiveWelcomeConfig(config.serverId);
    await message.channel?.send({ content: renderStatus(stored, effective) });
    return;
  }

  if (sub === 'clear' || sub === 'reset') {
    clearWelcomeConfig(config.serverId);
    await message.channel?.send({ content: '✅ Welcome configuration reset to defaults (disabled).' });
    return;
  }

  if (sub === 'test') {
    const effective = getEffectiveWelcomeConfig(config.serverId);
    const channelId = normalizeId(args[0]) || effective?.channelId || message.channelId;
    const result = await sendWelcomeForMember(client, {
      id: { server: config.serverId, user: message.authorId },
      userId: message.authorId,
      user: message.author,
      nickname: message.member?.nickname,
    }, {
      enabled: true,
      channelId,
    });

    await message.channel?.send({
      content: result.ok
        ? `✅ Test welcome sent${channelId ? ` to <#${channelId}>` : ''}.`
        : `❌ Test welcome failed: ${result.reason || 'unknown error'}`,
    });
    return;
  }

  await sendHelp(message);
}

function renderStatus(stored: WelcomeConfig | null, effective: WelcomeConfig | null) {
  if (!effective) return '❌ Welcome system is unavailable because SERVER_ID is not configured.';

  return (
    `# 👋 Welcome System\n\n` +
    `**Saved config:** ${stored ? 'yes' : 'no (defaults shown)'}\n` +
    `**Enabled:** ${effective.enabled ? 'yes' : 'no'}\n` +
    `**Channel:** ${effective.channelId ? `<#${effective.channelId}> (\`${effective.channelId}\`)` : '*not set*'}\n` +
    `**Image:** ${effective.imageEnabled ? 'yes' : 'no'}\n` +
    `**Selected image playlist:** ${getSelectedWelcomeImageCount(config.serverId)} saved image(s)\n` +
    `**Layout:** \`${effective.layout}\`\n` +
    `**Background:** \`${effective.background}\`\n` +
    `**Uploaded background:** ${effective.backgroundImageDataUri ? 'yes' : 'no'}\n` +
    `**Text layers:** ${effective.textLayers?.length || 0}\n` +
    `**Image layers:** ${effective.imageLayers?.length || 0}\n` +
    `**Text color:** \`${effective.textColor}\`\n` +
    `**Accent color:** \`${effective.accentColor}\`\n` +
    `**Message:** ${effective.message}\n\n` +
    `Placeholders: \`{user}\`, \`{username}\`, \`{display}\`, \`{mention}\`, \`{server}\`, \`{count}\``
  );
}

async function sendHelp(message) {
  await message.channel?.send({
    content:
      `# 👋 Welcome Help\n\n` +
      `\`${config.prefix}dashboard\` - Open the dashboard and use the **Welcomer** tab (Canva-like editor: draggable text, images, and the member avatar).\n` +
      `\`${config.prefix}welcome set <channelId>\` - Set welcome channel and enable welcomes.\n` +
      `\`${config.prefix}welcome message <text>\` - Set message. Placeholders: \`{user}\`, \`{mention}\`, \`{server}\`, \`{count}\`.\n` +
      `\`${config.prefix}welcome image <on|off>\` - Toggle generated welcome image.\n` +
      `\`${config.prefix}welcome background <hex|color|imageUrl>\` - Set image background.\n` +
      `\`${config.prefix}welcome textcolor <hex|color>\` - Set image text color.\n` +
      `\`${config.prefix}welcome accent <hex|color>\` - Set image accent color.\n` +
      `\`${config.prefix}welcome layout <classic|compact|banner>\` - Set image layout.\n` +
      `\`${config.prefix}welcome status\` - Show current config.\n` +
      `\`${config.prefix}welcome test [channelId]\` - Send a test welcome for yourself.\n` +
      `\`${config.prefix}welcome enable\` / \`${config.prefix}welcome disable\` - Toggle welcomes.\n` +
      `\`${config.prefix}welcome clear\` - Reset welcome config.`,
  });
}

function normalizeId(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  const mentionMatch = input.match(/^<[@#&]?(?:!|&)?([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const prefixedMatch = input.match(/^[%@#]([A-Za-z0-9_-]+)$/);
  if (prefixedMatch?.[1]) return prefixedMatch[1];
  if (/^[A-Za-z0-9_-]+$/.test(input)) return input;
  return null;
}

function isColor(value) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color) || /^[a-z]+$/i.test(color);
}
