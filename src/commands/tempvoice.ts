import { config } from '../config.js';
import { isStoatId, normalizeSimpleId } from '../id-utils.js';
import { joinLinesWithin } from '../embed-limits.js';
import { canManageServerById } from '../permissions.js';
import {
  createRoom,
  deleteRoom,
  getRoomByOwner,
  getRoomForOccupant,
  getTempVoiceConfig,
  isOccupant,
  listTempRooms,
  renameRoom,
  setRoomLimit,
  setRoomLocked,
  setTempVoiceConfig,
  transferRoom,
} from '../tempvoice.js';

/**
 * `vc` — temporary voice rooms.
 *
 * Member commands act on the room you own (or, for `claim`, the one you are
 * sitting in):
 *   vc create [name]      vc name <text>     vc limit <n>
 *   vc lock | unlock      vc claim           vc close
 *   vc list
 *
 * Setup commands need Manage Server:
 *   vc hub <channelId|off>      the "join to create" channel
 *   vc notice <channelId|off>   where the "your room is ready" line is posted
 *   vc on | off | status
 */

export async function tempVoiceCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();
  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');

  if (!serverId) {
    await message.channel?.send({ content: '❌ Temporary voice rooms only work inside a server.' });
    return;
  }

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  const userId = String(message?.authorId || '');
  const authorName = String(message?.member?.nickname || message?.author?.username || '');

  switch (sub) {
    case 'create':
    case 'new': {
      const result = await createRoom(client, { serverId, ownerId: userId, ownerName: authorName, name: args.join(' ') });
      await message.channel?.send({
        content: result.ok
          ? `🔊 Room created: <#${result.room.channelId}>. It closes on its own once it has been empty for a while.`
          : `❌ ${result.error}`,
      });
      return;
    }

    case 'name':
    case 'rename': {
      const room = getRoomByOwner(serverId, userId);
      if (!room) {
        await message.channel?.send({ content: `❌ You do not own a room. Make one with \`${config.prefix}vc create\`.` });
        return;
      }
      const result = await renameRoom(client, room.channelId, args.join(' '));
      await message.channel?.send({ content: result.ok ? `✏️ Renamed to **${result.name}**.` : `❌ ${result.error}` });
      return;
    }

    case 'limit': {
      const room = getRoomByOwner(serverId, userId);
      if (!room) {
        await message.channel?.send({ content: '❌ You do not own a room.' });
        return;
      }
      const limit = Number(args.shift());
      if (!Number.isFinite(limit) || limit < 0) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}vc limit <0-99>\` (0 removes the limit).` });
        return;
      }
      const result = await setRoomLimit(client, room.channelId, limit);
      await message.channel?.send({
        content: result.ok ? (limit ? `👥 Limit set to ${limit}.` : '👥 Limit removed.') : `❌ ${result.error}`,
      });
      return;
    }

    case 'lock':
    case 'unlock': {
      const room = getRoomByOwner(serverId, userId);
      if (!room) {
        await message.channel?.send({ content: '❌ You do not own a room.' });
        return;
      }
      const locked = sub === 'lock';
      const result = await setRoomLocked(client, room.channelId, locked);
      await message.channel?.send({
        content: result.ok ? (locked ? '🔒 Room locked — nobody new can join.' : '🔓 Room unlocked.') : `❌ ${result.error}`,
      });
      return;
    }

    case 'claim': {
      const room = getRoomForOccupant(serverId, userId);
      if (!room) {
        await message.channel?.send({ content: '❌ You are not in a temporary room.' });
        return;
      }
      if (room.ownerId !== userId && isOccupant(room.channelId, room.ownerId)) {
        await message.channel?.send({ content: '❌ The owner is still in the room.' });
        return;
      }
      transferRoom(room.channelId, userId, authorName);
      await message.channel?.send({ content: `👑 You now own <#${room.channelId}>.` });
      return;
    }

    case 'close':
    case 'delete': {
      const room = getRoomByOwner(serverId, userId);
      if (!room) {
        await message.channel?.send({ content: '❌ You do not own a room.' });
        return;
      }
      await deleteRoom(client, room.channelId, 'closed by owner');
      await message.channel?.send({ content: '👋 Room closed.' });
      return;
    }

    case 'list': {
      const rooms = listTempRooms(serverId);
      if (!rooms.length) {
        await message.channel?.send({ content: 'No temporary rooms are open.' });
        return;
      }
      const lines = rooms.map(
        (room) => `- <#${room.channelId}> · owner <@${room.ownerId}> · ${room.occupants} in${room.locked ? ' · 🔒' : ''}`,
      );
      await message.channel?.send({ content: joinLinesWithin('## 🔊 Temporary rooms', lines) });
      return;
    }

    // ---- setup ----
    case 'on':
    case 'off':
    case 'hub':
    case 'notice':
    case 'status':
      return handleSetup(message, client, serverId, sub, args);

    default:
      await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
  }
}

async function handleSetup(message: any, client: any, serverId: string, sub: string, args: string[]) {
  if (sub !== 'status' && !(await canManageServerById(client, serverId, message?.authorId))) {
    await message.channel?.send({ content: '❌ You need Manage Server permission to configure temporary voice rooms.' });
    return;
  }

  if (sub === 'status') {
    const cfg = getTempVoiceConfig(serverId);
    await message.channel?.send({
      content: [
        '## 🔊 Temporary voice rooms',
        `**State:** ${cfg.enabled ? 'on' : 'off'}`,
        `**Hub channel:** ${cfg.hubChannelId ? `<#${cfg.hubChannelId}>` : 'not set'}`,
        `**Notice channel:** ${cfg.noticeChannelId ? `<#${cfg.noticeChannelId}>` : 'not set'}`,
        `**Name template:** \`${cfg.nameTemplate}\``,
        `**Default limit:** ${cfg.userLimit || 'none'}`,
        `**Closes after:** ${cfg.emptyGraceSec}s empty (${cfg.claimGraceSec}s if never joined)`,
        `**Open rooms:** ${listTempRooms(serverId).length}`,
      ].join('\n'),
    });
    return;
  }

  if (sub === 'on' || sub === 'off') {
    setTempVoiceConfig({ enabled: sub === 'on' }, serverId);
    await message.channel?.send({ content: `Temporary voice rooms **${sub === 'on' ? 'enabled' : 'disabled'}**.` });
    return;
  }

  const value = String(args.shift() || '');
  const key = sub === 'hub' ? 'hubChannelId' : 'noticeChannelId';
  if (value.toLowerCase() === 'off' || value.toLowerCase() === 'none') {
    setTempVoiceConfig({ [key]: null } as any, serverId);
    await message.channel?.send({ content: `✅ ${sub === 'hub' ? 'Hub' : 'Notice'} channel cleared.` });
    return;
  }

  const channelId = normalizeSimpleId(value);
  if (!channelId || !isStoatId(channelId)) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}vc ${sub} <channelId|off>\`` });
    return;
  }

  setTempVoiceConfig({ [key]: channelId } as any, serverId);
  const note = sub === 'hub'
    ? '\nStoat cannot move members between voice channels, so joining the hub posts a link to the new room rather than dragging you into it.'
    : '';
  await message.channel?.send({ content: `✅ ${sub === 'hub' ? 'Hub' : 'Notice'} channel set to <#${channelId}>.${note}` });
}

async function sendHelp(message: any, prefixLine?: string) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      prefixLine || '## 🔊 Temporary voice rooms',
      `\`${p}vc create [name]\` — open your own room`,
      `\`${p}vc name <text>\` · \`${p}vc limit <0-99>\` · \`${p}vc lock\` · \`${p}vc unlock\``,
      `\`${p}vc claim\` — take over a room whose owner left · \`${p}vc close\``,
      `\`${p}vc list\` — open rooms`,
      '',
      '**Setup (Manage Server)**',
      `\`${p}vc on|off|status\` · \`${p}vc hub <channelId|off>\` · \`${p}vc notice <channelId|off>\``,
      'Rooms close themselves once they have been empty for a while.',
    ].join('\n'),
  });
}
