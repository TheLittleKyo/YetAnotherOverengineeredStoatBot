import { config } from '../config.js';
import {
  getAntiraidConfig,
  setAntiraidConfig,
  getRaidStatus,
  setRaidActive,
  createHoneypotChannel,
  inspectHoneypotChannel,
  type RaidAction,
  type AgeAction,
} from '../antiraid.js';
import { normalizeSimpleId } from '../id-utils.js';
import { canManageServerById } from '../permissions.js';

/**
 * `antiraid` command — configure and control raid protection.
 *
 *   antiraid on | off
 *   antiraid status
 *   antiraid lockdown on | off        Manually force raid mode
 *   antiraid set joins <n>
 *   antiraid set window <sec>
 *   antiraid set action <kick|ban|alert>
 *   antiraid set minage <minutes>     Account-age gate (0 = off)
 *   antiraid set ageaction <kick|ban|alert|off>
 *   antiraid set alert <channelId>    Alert channel (or "off")
 *   antiraid set lockdown <minutes>
 *   antiraid honeypot create [name]   Create a trap channel and use it
 *   antiraid honeypot off
 *   antiraid set honeypot <channelId|off> [confirm]
 *   antiraid set honeypotaction <kick|ban|alert>
 */
export async function antiraidCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({ content: 'You need Manage Server permission to configure antiraid.' });
    return;
  }

  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  if (!serverId) {
    await message.channel?.send({ content: 'Antiraid only works inside a server.' });
    return;
  }

  if (sub === 'on' || sub === 'enable') {
    setAntiraidConfig(serverId, { enabled: true });
    await message.channel?.send({ content: '🛡️ Antiraid **enabled**.' });
    return;
  }

  if (sub === 'off' || sub === 'disable') {
    setAntiraidConfig(serverId, { enabled: false });
    await message.channel?.send({ content: 'Antiraid **disabled**.' });
    return;
  }

  if (sub === 'status') {
    await message.channel?.send({ content: renderStatus(serverId) });
    return;
  }

  if (sub === 'lockdown' || sub === 'raid') {
    const state = (args.shift() || '').toLowerCase();
    if (state !== 'on' && state !== 'off') {
      await sendHelp(message, 'Usage: `antiraid lockdown <on|off>`');
      return;
    }
    setRaidActive(serverId, state === 'on');
    const cfg = getAntiraidConfig(serverId);
    await message.channel?.send({
      content: state === 'on'
        ? `🚨 Raid mode **forced ON**. New joiners get **${cfg.action}** for ${cfg.lockdownMinutes > 0 ? cfg.lockdownMinutes : 60}m or until \`${config.prefix}antiraid lockdown off\`.`
        : '✅ Raid mode **forced OFF**.',
    });
    return;
  }

  if (sub === 'honeypot' || sub === 'trap') {
    const action = (args.shift() || '').toLowerCase();
    if (action === 'create' || action === 'new') {
      try {
        const { channelId, settings } = await createHoneypotChannel(client, serverId, args.join(' '));
        await message.channel?.send({
          content: `🍯 Honeypot channel <#${channelId}> created. Anyone without staff permissions who posts there gets **${settings.honeypotAction}**.` +
            (settings.enabled ? '' : `\nAntiraid is **disabled** — the trap is inactive until \`${config.prefix}antiraid on\`.`) +
            '\nMove it near the top of the channel list so raid bots hit it first.',
        });
      } catch (error) {
        await message.channel?.send({
          content: error?.code === 'HONEYPOT_EXISTS'
            ? `This server already has a honeypot channel: <#${error.channelId}>. Run \`${config.prefix}antiraid honeypot off\` first to create a new one.`
            : `Could not create the honeypot channel: ${error?.message || error}. The bot needs Manage Channel permission.`,
        });
      }
      return;
    }
    if (action === 'off' || action === 'disable') {
      setAntiraidConfig(serverId, { honeypotChannelId: null });
      await message.channel?.send({ content: 'Honeypot **disabled**. The channel was not deleted.' });
      return;
    }
    await sendHelp(message, 'Usage: `antiraid honeypot create [name]` or `antiraid honeypot off`');
    return;
  }

  if (sub === 'set') {
    const key = (args.shift() || '').toLowerCase();
    const value = args.shift();
    await handleSet(message, client, serverId, key, value, args);
    return;
  }

  await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
}

async function handleSet(message: any, client: any, serverId: string, key: string, value: any, rest: string[]) {
  const raidActions: RaidAction[] = ['kick', 'ban', 'alert'];
  const ageActions: AgeAction[] = ['kick', 'ban', 'alert', 'off'];

  switch (key) {
    case 'joins':
    case 'threshold': {
      const n = Number(value);
      if (!Number.isFinite(n)) return void await sendHelp(message, 'Usage: `antiraid set joins <number>`');
      const cfg = setAntiraidConfig(serverId, { joinThreshold: n });
      return void await message.channel?.send({ content: `Join threshold set to **${cfg.joinThreshold}**.` });
    }
    case 'window': {
      const n = Number(value);
      if (!Number.isFinite(n)) return void await sendHelp(message, 'Usage: `antiraid set window <seconds>`');
      const cfg = setAntiraidConfig(serverId, { joinWindowSec: n });
      return void await message.channel?.send({ content: `Detection window set to **${cfg.joinWindowSec}s**.` });
    }
    case 'action': {
      const v = String(value || '').toLowerCase() as RaidAction;
      if (!raidActions.includes(v)) return void await sendHelp(message, 'Usage: `antiraid set action <kick|ban|alert>`');
      setAntiraidConfig(serverId, { action: v });
      return void await message.channel?.send({ content: `Raid action set to **${v}**.` });
    }
    case 'minage':
    case 'age': {
      const n = Number(value);
      if (!Number.isFinite(n)) return void await sendHelp(message, 'Usage: `antiraid set minage <minutes>` (0 = off)');
      const cfg = setAntiraidConfig(serverId, { minAccountAgeMin: n });
      return void await message.channel?.send({
        content: cfg.minAccountAgeMin > 0
          ? `Minimum account age set to **${cfg.minAccountAgeMin} min**.`
          : 'Account-age gate **disabled**.',
      });
    }
    case 'ageaction': {
      const v = String(value || '').toLowerCase() as AgeAction;
      if (!ageActions.includes(v)) return void await sendHelp(message, 'Usage: `antiraid set ageaction <kick|ban|alert|off>`');
      setAntiraidConfig(serverId, { accountAgeAction: v });
      return void await message.channel?.send({ content: `Account-age action set to **${v}**.` });
    }
    case 'alert':
    case 'channel': {
      const v = String(value || '').trim();
      if (!v) return void await sendHelp(message, 'Usage: `antiraid set alert <channelId|off>`');
      if (v.toLowerCase() === 'off' || v.toLowerCase() === 'none') {
        setAntiraidConfig(serverId, { alertChannelId: null });
        return void await message.channel?.send({ content: 'Alert channel cleared. Falls back to the log channel.' });
      }
      const id = normalizeSimpleId(v) || v;
      if (id === getAntiraidConfig(serverId).honeypotChannelId) {
        return void await message.channel?.send({ content: 'The alert channel cannot be the honeypot channel.' });
      }
      const cfg = setAntiraidConfig(serverId, { alertChannelId: id });
      return void await message.channel?.send({ content: `Alert channel set to <#${cfg.alertChannelId}>.` });
    }
    case 'honeypot': {
      const v = String(value || '').trim();
      if (!v) return void await sendHelp(message, 'Usage: `antiraid set honeypot <channelId|off> [confirm]`');
      if (v.toLowerCase() === 'off' || v.toLowerCase() === 'none') {
        setAntiraidConfig(serverId, { honeypotChannelId: null });
        return void await message.channel?.send({ content: 'Honeypot **disabled**.' });
      }
      const id = normalizeSimpleId(v);
      if (!id) return void await sendHelp(message, 'Usage: `antiraid set honeypot <channelId|off> [confirm]`');

      const check = await inspectHoneypotChannel(client, serverId, id);
      if ('error' in check) return void await message.channel?.send({ content: `Cannot use <#${id}> as the honeypot: ${check.error}` });

      // A channel people already talk in would get every one of them actioned.
      const confirmed = String(rest[0] || '').toLowerCase() === 'confirm';
      if (check.recentPosters !== 0 && !confirmed) {
        const cfg = getAntiraidConfig(serverId);
        const who = check.recentPosters === null
          ? 'The bot could not read the recent history of'
          : `${check.recentPosters} member${check.recentPosters === 1 ? ' has' : 's have'} posted recently in`;
        return void await message.channel?.send({
          content: `⚠️ ${who} <#${id}>. As the honeypot, anyone without staff permissions who posts there gets **${cfg.honeypotAction}**.\n` +
            `Re-run \`${config.prefix}antiraid set honeypot ${id} confirm\` to use it anyway, or \`${config.prefix}antiraid honeypot create\` for a fresh channel.`,
        });
      }

      const cfg = setAntiraidConfig(serverId, { honeypotChannelId: id });
      return void await message.channel?.send({ content: `Honeypot channel set to <#${cfg.honeypotChannelId}>.` });
    }
    case 'honeypotaction': {
      const v = String(value || '').toLowerCase() as RaidAction;
      if (!raidActions.includes(v)) return void await sendHelp(message, 'Usage: `antiraid set honeypotaction <kick|ban|alert>`');
      setAntiraidConfig(serverId, { honeypotAction: v });
      return void await message.channel?.send({ content: `Honeypot action set to **${v}**.` });
    }
    case 'lockdown': {
      const n = Number(value);
      if (!Number.isFinite(n)) return void await sendHelp(message, 'Usage: `antiraid set lockdown <minutes>`');
      const cfg = setAntiraidConfig(serverId, { lockdownMinutes: n });
      return void await message.channel?.send({ content: `Lockdown duration set to **${cfg.lockdownMinutes} min**.` });
    }
    default:
      return void await sendHelp(message, `Unknown setting: \`${key}\`.`);
  }
}

function renderStatus(serverId: string): string {
  const cfg = getAntiraidConfig(serverId);
  const raid = getRaidStatus(serverId);
  const ageLine = cfg.minAccountAgeMin > 0
    ? `${cfg.minAccountAgeMin} min → **${cfg.accountAgeAction}**`
    : 'off';
  const raidLine = raid.active && raid.until
    ? `🚨 ACTIVE (until <t:${Math.floor(raid.until / 1000)}:T>)`
    : 'idle';

  return (
    `# 🛡️ Antiraid Status\n\n` +
    `State: ${cfg.enabled ? '**enabled** 🟢' : '**disabled** 🔴'}\n` +
    `Raid mode: ${raidLine}\n` +
    `Trigger: **${cfg.joinThreshold}** joins / **${cfg.joinWindowSec}s**\n` +
    `Raid action: **${cfg.action}**\n` +
    `Account-age gate: ${ageLine}\n` +
    `Lockdown: **${cfg.lockdownMinutes} min**\n` +
    `Honeypot: ${cfg.honeypotChannelId ? `<#${cfg.honeypotChannelId}> → **${cfg.honeypotAction}**` : 'off'}\n` +
    `Alert channel: ${cfg.alertChannelId ? `<#${cfg.alertChannelId}>` : 'log channel (fallback)'}`
  );
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# 🛡️ Antiraid Commands\n\n` +
      `- \`${config.prefix}antiraid on\` / \`${config.prefix}antiraid off\` - Enable or disable protection\n` +
      `- \`${config.prefix}antiraid status\` - Show current settings and raid state\n` +
      `- \`${config.prefix}antiraid lockdown <on|off>\` - Manually force raid mode\n` +
      `- \`${config.prefix}antiraid set joins <n>\` - Joins that trip a raid\n` +
      `- \`${config.prefix}antiraid set window <sec>\` - Detection window\n` +
      `- \`${config.prefix}antiraid set action <kick|ban|alert>\` - What to do to raiders\n` +
      `- \`${config.prefix}antiraid set minage <minutes>\` - Min account age (0 = off)\n` +
      `- \`${config.prefix}antiraid set ageaction <kick|ban|alert|off>\` - Action for young accounts\n` +
      `- \`${config.prefix}antiraid set alert <channelId|off>\` - Where alerts post\n` +
      `- \`${config.prefix}antiraid set lockdown <minutes>\` - How long raid mode lasts\n` +
      `- \`${config.prefix}antiraid honeypot create [name]\` - Create a trap channel; posters get actioned\n` +
      `- \`${config.prefix}antiraid honeypot off\` - Stop trapping (keeps the channel)\n` +
      `- \`${config.prefix}antiraid set honeypot <channelId|off> [confirm]\` - Use an existing channel as the honeypot\n` +
      `- \`${config.prefix}antiraid set honeypotaction <kick|ban|alert>\` - What to do to honeypot posters (staff are exempt)\n\n` +
      `Requires Manage Server. The bot must be elevated above members it kicks/bans, with the Kick/Ban permission. Or configure it in the dashboard Antiraid tab.`,
  });
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}
