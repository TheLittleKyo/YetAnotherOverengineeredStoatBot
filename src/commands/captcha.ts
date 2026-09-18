import { config } from '../config.js';
import { getCaptchaConfig, setCaptchaConfig, getCaptchaRuntimeStatus } from '../captcha.js';
import { normalizeSimpleId } from '../id-utils.js';
import { canManageServerById } from '../permissions.js';

/**
 * `captcha` command — configure the anti-bot captcha. Most tuning lives in the
 * dashboard Captcha tab; this covers the common switches from chat.
 *
 *   captcha on | off
 *   captcha status
 *   captcha set role <roleId>
 *   captcha set join <on|off>
 *   captcha set reaction <on|off>
 *   captcha set reactmsg <messageId>
 *   captcha set emoji <emoji|off>
 *   captcha set length <min> <max>
 *   captcha set attempts <n>
 *   captcha set cooldown <minutes>
 */
export async function captchaCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') { await sendHelp(message); return; }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({ content: 'You need Manage Server permission to configure the captcha.' });
    return;
  }

  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  if (!serverId) { await message.channel?.send({ content: 'Captcha only works inside a server.' }); return; }

  if (sub === 'on' || sub === 'enable') {
    const cfg = setCaptchaConfig(serverId, { enabled: true });
    await message.channel?.send({
      content: cfg.roleId
        ? '🔐 Captcha **enabled**.'
        : '🔐 Captcha **enabled**, but no verified role is set yet. Run `' + config.prefix + 'captcha set role <roleId>` or use the dashboard.',
    });
    return;
  }

  if (sub === 'off' || sub === 'disable') {
    setCaptchaConfig(serverId, { enabled: false });
    await message.channel?.send({ content: 'Captcha **disabled**.' });
    return;
  }

  if (sub === 'status') { await message.channel?.send({ content: renderStatus(serverId) }); return; }

  if (sub === 'set') {
    const key = (args.shift() || '').toLowerCase();
    await handleSet(message, serverId, key, args);
    return;
  }

  await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
}

async function handleSet(message: any, serverId: string, key: string, args: string[]) {
  const value = args.shift();

  switch (key) {
    case 'role': {
      const id = normalizeSimpleId(value);
      if (!id) return void await sendHelp(message, 'Usage: `captcha set role <roleId>`');
      const cfg = setCaptchaConfig(serverId, { roleId: id });
      return void await message.channel?.send({ content: `Verified role set to \`${cfg.roleId}\`.` });
    }
    case 'join': {
      const on = parseBool(value);
      if (on == null) return void await sendHelp(message, 'Usage: `captcha set join <on|off>`');
      setCaptchaConfig(serverId, { triggerOnJoin: on });
      return void await message.channel?.send({ content: `Join trigger **${on ? 'on' : 'off'}**.` });
    }
    case 'reaction': {
      const on = parseBool(value);
      if (on == null) return void await sendHelp(message, 'Usage: `captcha set reaction <on|off>`');
      setCaptchaConfig(serverId, { triggerOnReaction: on });
      return void await message.channel?.send({ content: `Reaction trigger **${on ? 'on' : 'off'}**.` });
    }
    case 'reactmsg': {
      const id = normalizeSimpleId(value);
      if (!id) return void await sendHelp(message, 'Usage: `captcha set reactmsg <messageId>`');
      const cfg = setCaptchaConfig(serverId, { reactionMessageId: id });
      return void await message.channel?.send({ content: `Reaction message set to \`${cfg.reactionMessageId}\`.` });
    }
    case 'emoji': {
      const v = String(value || '').trim();
      if (!v) return void await sendHelp(message, 'Usage: `captcha set emoji <emoji|off>`');
      const emoji = v.toLowerCase() === 'off' || v.toLowerCase() === 'none' ? null : v;
      setCaptchaConfig(serverId, { reactionEmoji: emoji });
      return void await message.channel?.send({ content: emoji ? `Reaction emoji set to ${emoji}.` : 'Reaction emoji cleared (any reaction triggers it).' });
    }
    case 'length': {
      const min = Number(value);
      const max = Number(args.shift());
      if (!Number.isFinite(min) || !Number.isFinite(max)) return void await sendHelp(message, 'Usage: `captcha set length <min> <max>` (4–9)');
      const cfg = setCaptchaConfig(serverId, { minLength: min, maxLength: max });
      return void await message.channel?.send({ content: `Code length set to **${cfg.minLength}–${cfg.maxLength}**.` });
    }
    case 'attempts': {
      const n = Number(value);
      if (!Number.isFinite(n)) return void await sendHelp(message, 'Usage: `captcha set attempts <n>`');
      const cfg = setCaptchaConfig(serverId, { maxAttempts: n });
      return void await message.channel?.send({ content: `Attempts per captcha set to **${cfg.maxAttempts}**.` });
    }
    case 'cooldown': {
      const n = Number(value);
      if (!Number.isFinite(n)) return void await sendHelp(message, 'Usage: `captcha set cooldown <minutes>`');
      const cfg = setCaptchaConfig(serverId, { cooldownMinutes: n });
      return void await message.channel?.send({ content: `Cooldown after failure set to **${cfg.cooldownMinutes} min**.` });
    }
    default:
      return void await sendHelp(message, `Unknown setting: \`${key}\`.`);
  }
}

function renderStatus(serverId: string): string {
  const cfg = getCaptchaConfig(serverId);
  const rt = getCaptchaRuntimeStatus();
  const triggers = [cfg.triggerOnJoin ? 'join' : null, cfg.triggerOnReaction ? 'reaction' : null].filter(Boolean).join(', ') || 'none';
  return (
    `# 🔐 Captcha Status\n\n` +
    `State: ${cfg.enabled ? '**enabled** 🟢' : '**disabled** 🔴'}\n` +
    `Verified role: ${cfg.roleId ? `\`${cfg.roleId}\`` : '**not set** ⚠️'}\n` +
    `Triggers: **${triggers}**\n` +
    (cfg.triggerOnReaction ? `Reaction message: ${cfg.reactionMessageId ? `\`${cfg.reactionMessageId}\`` : 'not set'} ${cfg.reactionEmoji ? `(${cfg.reactionEmoji})` : '(any emoji)'}\n` : '') +
    `Code length: **${cfg.minLength}–${cfg.maxLength}**\n` +
    `Attempts: **${cfg.maxAttempts}**, cooldown **${cfg.cooldownMinutes} min**, expiry **${cfg.expiryMinutes} min**\n` +
    `Live: ${rt.pending} pending, ${rt.activeCooldowns} on cooldown`
  );
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# 🔐 Captcha Commands\n\n` +
      `- \`${config.prefix}captcha on\` / \`${config.prefix}captcha off\` - Enable or disable\n` +
      `- \`${config.prefix}captcha status\` - Show current settings\n` +
      `- \`${config.prefix}captcha set role <roleId>\` - Role granted on success\n` +
      `- \`${config.prefix}captcha set join <on|off>\` - DM captcha on join\n` +
      `- \`${config.prefix}captcha set reaction <on|off>\` - DM captcha on reaction\n` +
      `- \`${config.prefix}captcha set reactmsg <messageId>\` - Message to watch\n` +
      `- \`${config.prefix}captcha set emoji <emoji|off>\` - Emoji that triggers it\n` +
      `- \`${config.prefix}captcha set length <min> <max>\` - Code length (4–9)\n` +
      `- \`${config.prefix}captcha set attempts <n>\` - Wrong tries before cooldown\n` +
      `- \`${config.prefix}captcha set cooldown <minutes>\` - Wait after failing\n\n` +
      `Requires Manage Server. The bot role must sit above the verified role. Full config is in the dashboard Captcha tab.`,
  });
}

function parseBool(value: any): boolean | null {
  const v = String(value || '').toLowerCase();
  if (v === 'on' || v === 'true' || v === 'yes' || v === 'enable') return true;
  if (v === 'off' || v === 'false' || v === 'no' || v === 'disable') return false;
  return null;
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}
