import { config } from '../config.js';
import { isStoatId, normalizeId, normalizeSimpleId } from '../id-utils.js';
import { joinLinesWithin } from '../embed-limits.js';
import { canManageServerById } from '../permissions.js';
import {
  formatBirthday,
  getBirthday,
  getBirthdayConfig,
  listBirthdays,
  parseBirthday,
  removeBirthday,
  runBirthdaysForServer,
  setBirthday,
  setBirthdayConfig,
  upcomingBirthdays,
} from '../birthdays.js';

/**
 * `birthday` — members register a date, the bot announces it on the day.
 *
 *   birthday set <date>        15/03 · 15 March · 1998-03-15
 *   birthday remove
 *   birthday show [@user]
 *   birthday next | birthday list
 *
 * Setup (Manage Server):
 *   birthday channel <id|off> · birthday role <id|off> · birthday hour <0-23>
 *   birthday offset <minutes> · birthday message <text> · birthday on|off
 *   birthday test               announce today's birthdays right now
 */

export async function birthdayCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();
  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');

  if (!serverId) {
    await message.channel?.send({ content: '❌ Birthdays only work inside a server.' });
    return;
  }

  const userId = String(message?.authorId || '');
  const authorName = String(message?.member?.nickname || message?.author?.username || '');

  switch (sub) {
    case '':
    case 'help':
      return sendHelp(message);

    case 'set':
    case 'add': {
      const parsed = parseBirthday(args.join(' '));
      if ('error' in parsed) {
        await message.channel?.send({ content: `❌ ${parsed.error}` });
        return;
      }
      const cfg = getBirthdayConfig(serverId);
      const entry = setBirthday(userId, parsed, serverId, authorName);
      const yearNote = parsed.year && !cfg.allowYear ? ' (birth years are not stored in this server)' : '';
      await message.channel?.send({ content: `🎂 Saved: **${formatBirthday(entry)}**${yearNote}.` });
      return;
    }

    case 'remove':
    case 'delete':
    case 'clear': {
      const removed = removeBirthday(userId, serverId);
      await message.channel?.send({ content: removed ? '🗑️ Your birthday was removed.' : 'You had no birthday saved.' });
      return;
    }

    case 'show':
    case 'get': {
      const mentioned = normalizeId(args.shift());
      const target = mentioned && isStoatId(mentioned) ? mentioned : userId;
      const entry = getBirthday(target, serverId);
      await message.channel?.send({
        content: entry
          ? `🎂 <@${target}>: **${formatBirthday(entry)}**`
          : `<@${target}> has not saved a birthday.`,
      });
      return;
    }

    case 'next':
    case 'upcoming': {
      const rows = upcomingBirthdays(5, serverId);
      if (!rows.length) {
        await message.channel?.send({ content: `No birthdays saved yet. Add yours with \`${config.prefix}birthday set 15/03\`.` });
        return;
      }
      const lines = rows.map(
        (row) => `- <@${row.userId}> — ${formatBirthday(row)} · ${row.inDays === 0 ? '**today**' : `in ${row.inDays} day${row.inDays === 1 ? '' : 's'}`}`,
      );
      await message.channel?.send({ content: `## 🎂 Upcoming birthdays\n${lines.join('\n')}` });
      return;
    }

    case 'list': {
      const all = listBirthdays(serverId).sort((a, b) => a.month - b.month || a.day - b.day);
      if (!all.length) {
        await message.channel?.send({ content: 'No birthdays saved yet.' });
        return;
      }
      const lines = all.map((entry) => `- <@${entry.userId}> — ${formatBirthday(entry)}`);
      await message.channel?.send({ content: joinLinesWithin(`## 🎂 Birthdays (${all.length})`, lines) });
      return;
    }

    case 'status':
      return showStatus(message, serverId);

    default:
      return handleSetup(message, client, serverId, sub, args);
  }
}

async function showStatus(message: any, serverId: string) {
  const cfg = getBirthdayConfig(serverId);
  const offsetHours = cfg.utcOffsetMinutes / 60;
  await message.channel?.send({
    content: [
      '## 🎂 Birthdays',
      `**State:** ${cfg.enabled ? 'on' : 'off'}`,
      `**Channel:** ${cfg.channelId ? `<#${cfg.channelId}>` : 'not set'}`,
      `**Role for the day:** ${cfg.roleId ? `<%${cfg.roleId}>` : 'none'}`,
      `**Announce at:** ${String(cfg.announceHour).padStart(2, '0')}:00 (UTC${offsetHours >= 0 ? '+' : ''}${offsetHours})`,
      `**Message:** ${cfg.message}`,
      `**Saved birthdays:** ${listBirthdays(serverId).length}`,
    ].join('\n'),
  });
}

async function handleSetup(message: any, client: any, serverId: string, sub: string, args: string[]) {
  const setupCommands = ['on', 'off', 'channel', 'role', 'hour', 'offset', 'message', 'test', 'year'];
  if (!setupCommands.includes(sub)) {
    await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
    return;
  }

  if (!(await canManageServerById(client, serverId, message?.authorId))) {
    await message.channel?.send({ content: '❌ You need Manage Server permission to configure birthdays.' });
    return;
  }

  switch (sub) {
    case 'on':
    case 'off':
      setBirthdayConfig({ enabled: sub === 'on' }, serverId);
      await message.channel?.send({ content: `Birthdays **${sub === 'on' ? 'enabled' : 'disabled'}**.` });
      return;

    case 'channel': {
      const value = String(args.shift() || '');
      if (/^(off|none)$/i.test(value)) {
        setBirthdayConfig({ channelId: null }, serverId);
        await message.channel?.send({ content: '✅ Birthday channel cleared.' });
        return;
      }
      const channelId = normalizeSimpleId(value);
      if (!channelId || !isStoatId(channelId)) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}birthday channel <channelId|off>\`` });
        return;
      }
      setBirthdayConfig({ channelId, enabled: true }, serverId);
      await message.channel?.send({ content: `✅ Birthdays will be announced in <#${channelId}>.` });
      return;
    }

    case 'role': {
      const value = String(args.shift() || '');
      if (/^(off|none)$/i.test(value)) {
        setBirthdayConfig({ roleId: null }, serverId);
        await message.channel?.send({ content: '✅ Birthday role cleared.' });
        return;
      }
      const roleId = normalizeSimpleId(value);
      if (!roleId || !isStoatId(roleId)) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}birthday role <roleId|off>\`` });
        return;
      }
      setBirthdayConfig({ roleId }, serverId);
      await message.channel?.send({ content: `✅ <%${roleId}> is given for the day and taken back after 24 hours.` });
      return;
    }

    case 'hour': {
      const hour = Number(args.shift());
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}birthday hour <0-23>\`` });
        return;
      }
      setBirthdayConfig({ announceHour: Math.floor(hour) }, serverId);
      await message.channel?.send({ content: `✅ Announcements go out at ${String(Math.floor(hour)).padStart(2, '0')}:00 server time.` });
      return;
    }

    case 'offset': {
      const raw = String(args.shift() || '');
      // Accept both "+2" (hours, how people think) and "120" (minutes).
      const asNumber = Number(raw);
      if (!Number.isFinite(asNumber)) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}birthday offset <hours>\` — e.g. \`2\` for CEST, \`-5\` for EST.` });
        return;
      }
      const minutes = Math.abs(asNumber) <= 14 ? Math.round(asNumber * 60) : Math.round(asNumber);
      // Echo what was stored: offsets outside UTC−12…UTC+14 are clamped.
      const stored = setBirthdayConfig({ utcOffsetMinutes: minutes }, serverId).utcOffsetMinutes;
      await message.channel?.send({ content: `✅ Server time is UTC${stored >= 0 ? '+' : ''}${stored / 60}.` });
      return;
    }

    case 'message': {
      const template = args.join(' ').trim();
      if (!template) {
        await message.channel?.send({
          content: `❌ Usage: \`${config.prefix}birthday message <text>\` — placeholders: \`{mention}\` \`{user}\` \`{age}\` \`{server}\``,
        });
        return;
      }
      const stored = setBirthdayConfig({ message: template }, serverId).message;
      await message.channel?.send({ content: `✅ Message set to: ${stored}` });
      return;
    }

    case 'year': {
      const value = String(args.shift() || '').toLowerCase();
      if (value !== 'on' && value !== 'off') {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}birthday year <on|off>\`` });
        return;
      }
      setBirthdayConfig({ allowYear: value === 'on' }, serverId);
      await message.channel?.send({
        content: value === 'on' ? '✅ Members may store a birth year, and ages are shown.' : '✅ Birth years are no longer stored.',
      });
      return;
    }

    case 'test': {
      const cfg = getBirthdayConfig(serverId);
      if (!cfg.channelId) {
        await message.channel?.send({ content: '❌ Set a birthday channel first.' });
        return;
      }
      const count = await runBirthdaysForServer(client, serverId, Date.now(), { force: true });
      await message.channel?.send({
        content: count > 0 ? `✅ Announced ${count} birthday(s).` : 'Nobody has a birthday today.',
      });
      return;
    }
  }
}

async function sendHelp(message: any, prefixLine?: string) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      prefixLine || '## 🎂 Birthdays',
      `\`${p}birthday set <date>\` — \`15/03\`, \`15 March\`, \`1998-03-15\``,
      `\`${p}birthday remove\` · \`${p}birthday show [@user]\` · \`${p}birthday next\` · \`${p}birthday list\``,
      '',
      '**Setup (Manage Server)**',
      `\`${p}birthday on|off|status\` · \`${p}birthday channel <id|off>\` · \`${p}birthday role <id|off>\``,
      `\`${p}birthday hour <0-23>\` · \`${p}birthday offset <hours>\` · \`${p}birthday message <text>\` · \`${p}birthday year <on|off>\``,
      `\`${p}birthday test\` — announce today's birthdays now`,
    ].join('\n'),
  });
}
