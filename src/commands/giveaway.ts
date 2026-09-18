import { config } from '../config.js';
import { isStoatId, normalizeSimpleId } from '../id-utils.js';
import { hasPermission } from '../permissions.js';
import { formatDuration, parseDuration } from '../duration.js';
import {
  createGiveaway,
  deleteGiveaway,
  endGiveaway,
  getGiveaway,
  listGiveaways,
  rerollGiveaway,
  type BonusRole,
} from '../hosted-giveaways.js';

/**
 * `giveaway` — run a draw in this server.
 *
 *   giveaway start <duration> [Nw] <prize> [flags]
 *   giveaway end <id> | reroll <id> [count] | list | info <id> | delete <id>
 *
 * Flags:
 *   --winners N        same as the `Nw` shorthand
 *   --level N          entrants must be at least this leveling level
 *   --role <roleId>    entrants must hold this role (repeatable)
 *   --age N            account must be at least N days old
 *   --bonus <roleId>:N that role's members get N entries
 *   --desc <text>      extra text in the giveaway embed
 *
 * Note: `giveaway` used to be an alias of the Free Stuff feed. That feed is now
 * reached only through `freestuff` / `free` / `freegames` / `deals`, because a
 * command called "giveaway" should run *your* giveaway.
 */

export const GIVEAWAY_COMMAND_NAMES = ['giveaway', 'giveaways', 'gw', 'gstart', 'gend', 'greroll', 'glist'];

/** Bare aliases map onto their subcommand so `!gstart 1h Nitro` works. */
export function routeGiveawayArgs(invokedAs: string, args: string[]): string[] {
  switch (invokedAs) {
    case 'gstart':
      return ['start', ...args];
    case 'gend':
      return ['end', ...args];
    case 'greroll':
      return ['reroll', ...args];
    case 'glist':
      return ['list', ...args];
    default:
      return args;
  }
}

export async function giveawayCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();
  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');

  if (!serverId) {
    await message.channel?.send({ content: '❌ Giveaways only work inside a server.' });
    return;
  }

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (sub === 'list') {
    await message.channel?.send({ content: renderList(serverId) });
    return;
  }

  if (sub === 'info' || sub === 'show') {
    const giveaway = ownGiveaway(String(args.shift() || ''), serverId);
    if (!giveaway) {
      await message.channel?.send({ content: '❌ No giveaway with that id.' });
      return;
    }
    await message.channel?.send({
      content: [
        `## 🎉 ${giveaway.prize}`,
        `**Id:** \`${giveaway.id}\` · **Channel:** <#${giveaway.channelId}>`,
        `**Entries:** ${giveaway.entries.length} · **Winners drawn:** ${giveaway.winnerCount}`,
        giveaway.ended
          ? `**Ended:** ${new Date(giveaway.endedAt || 0).toLocaleString()}`
          : `**Ends:** in ${formatDuration(giveaway.endsAt - Date.now())}`,
        giveaway.winners.length ? `**Winners:** ${giveaway.winners.map((id) => `<@${id}>`).join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
    return;
  }

  if (!(await requireManage(message, client))) return;

  // Giveaway ids are global; every id-taking subcommand below is limited to
  // this server's own giveaways.
  if (['end', 'stop', 'reroll', 'delete', 'remove'].includes(sub) && !ownGiveaway(String(args[0] || ''), serverId)) {
    await message.channel?.send({ content: `❌ No giveaway \`${String(args[0] || '')}\` in this server.` });
    return;
  }

  switch (sub) {
    case 'start':
    case 'create':
      return startGiveaway(message, client, serverId, args);

    case 'end':
    case 'stop': {
      const result = await endGiveaway(client, String(args.shift() || ''), String(message?.authorId || ''));
      await message.channel?.send({
        content: result.ok
          ? `✅ Giveaway ended with ${result.winners?.length || 0} winner(s).`
          : `❌ ${result.error}`,
      });
      return;
    }

    case 'reroll': {
      const id = String(args.shift() || '');
      const count = Number(args.shift());
      const result = await rerollGiveaway(client, id, Number.isFinite(count) ? count : undefined);
      await message.channel?.send({
        content: result.ok ? `🎲 Rerolled: ${result.winners?.map((w) => `<@${w}>`).join(', ')}` : `❌ ${result.error}`,
      });
      return;
    }

    case 'delete':
    case 'remove': {
      const id = String(args.shift() || '');
      const removed = deleteGiveaway(id);
      await message.channel?.send({
        content: removed ? `🗑️ Giveaway \`${id}\` deleted. The message is left in place.` : `❌ No giveaway \`${id}\`.`,
      });
      return;
    }

    default:
      await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
  }
}

function ownGiveaway(id: string, serverId: string) {
  const giveaway = getGiveaway(id);
  return giveaway && giveaway.serverId === serverId ? giveaway : null;
}

async function requireManage(message: any, client: any): Promise<boolean> {
  const allowed = await hasPermission(message, client, ['ManageServer', 'ManageMessages']);
  if (!allowed) await message.channel?.send({ content: '❌ You need Manage Server permission to run giveaways.' });
  return allowed;
}

async function startGiveaway(message: any, client: any, serverId: string, args: string[]) {
  const parsed = parseStartArgs(args);
  if ('error' in parsed) {
    await message.channel?.send({ content: `❌ ${parsed.error}` });
    return;
  }

  const result = await createGiveaway(client, {
    serverId,
    channelId: String(message?.channelId || message?.channel?.id || ''),
    prize: parsed.prize,
    description: parsed.description,
    winnerCount: parsed.winners,
    durationMs: parsed.durationMs,
    hostId: String(message?.authorId || ''),
    hostName: String(message?.member?.nickname || message?.author?.username || ''),
    requirements: {
      minLevel: parsed.minLevel,
      requiredRoleIds: parsed.requiredRoleIds,
      minAccountAgeDays: parsed.minAccountAgeDays,
    },
    bonusRoles: parsed.bonusRoles,
  });

  if (!result.ok) {
    await message.channel?.send({ content: `❌ ${result.error}` });
    return;
  }

  await message.channel?.send({
    content: `🎉 Giveaway \`${result.giveaway.id}\` started — **${result.giveaway.prize}**, ${formatDuration(parsed.durationMs)}, ${parsed.winners} winner(s).`,
  });
}

type ParsedStart = {
  durationMs: number;
  winners: number;
  prize: string;
  description: string;
  minLevel: number;
  requiredRoleIds: string[];
  minAccountAgeDays: number;
  bonusRoles: BonusRole[];
};

/** Parse `<duration> [Nw] <prize…>` plus the `--flag value` tail. */
export function parseStartArgs(args: string[]): ParsedStart | { error: string } {
  const tokens = [...args];
  const durationToken = tokens.shift();
  const durationMs = parseDuration(durationToken);
  if (typeof durationMs !== 'number' || durationMs <= 0) {
    return { error: `Start with a duration, e.g. \`${config.prefix}giveaway start 1h 2w Nitro\`.` };
  }

  let winners = 1;
  const winnerShorthand = String(tokens[0] || '').match(/^(\d+)w$/i);
  if (winnerShorthand) {
    winners = Number(winnerShorthand[1]);
    tokens.shift();
  }

  const prizeWords: string[] = [];
  let description = '';
  let minLevel = 0;
  let minAccountAgeDays = 0;
  const requiredRoleIds: string[] = [];
  const bonusRoles: BonusRole[] = [];

  while (tokens.length) {
    const token = tokens.shift() as string;
    const flag = token.toLowerCase();

    if (flag === '--winners' || flag === '-w') {
      winners = Number(tokens.shift()) || winners;
    } else if (flag === '--level') {
      minLevel = Math.max(0, Number(tokens.shift()) || 0);
    } else if (flag === '--age') {
      minAccountAgeDays = Math.max(0, Number(tokens.shift()) || 0);
    } else if (flag === '--role') {
      const raw = tokens.shift();
      const roleId = normalizeSimpleId(raw);
      // A role name instead of an id would make the giveaway impossible to enter.
      if (!roleId || !isStoatId(roleId)) return { error: `\`${raw || ''}\` is not a role id or role mention.` };
      requiredRoleIds.push(roleId);
    } else if (flag === '--bonus') {
      const raw = String(tokens.shift() || '');
      const [rolePart, countPart] = raw.split(':');
      const roleId = normalizeSimpleId(rolePart);
      if (!roleId || !isStoatId(roleId)) return { error: `\`${rolePart || ''}\` is not a role id or role mention.` };
      bonusRoles.push({ roleId, entries: Math.min(10, Math.max(1, Number(countPart) || 2)) });
    } else if (flag === '--desc' || flag === '--description') {
      // The description runs to the end of the line; flags come before it.
      description = tokens.join(' ');
      tokens.length = 0;
    } else {
      prizeWords.push(token);
    }
  }

  const prize = prizeWords.join(' ').trim();
  if (!prize) return { error: 'Say what the prize is.' };
  if (winners < 1 || winners > 20) return { error: 'Winners must be between 1 and 20.' };

  return { durationMs, winners, prize, description, minLevel, requiredRoleIds, minAccountAgeDays, bonusRoles };
}

function renderList(serverId: string): string {
  const all = listGiveaways(serverId).slice(0, 10);
  if (!all.length) return `No giveaways yet. Start one with \`${config.prefix}giveaway start 1h Nitro\`.`;

  const lines = all.map((giveaway) => {
    const state = giveaway.ended ? 'ended' : `ends in ${formatDuration(giveaway.endsAt - Date.now())}`;
    return `- \`${giveaway.id}\` **${giveaway.prize.slice(0, 60)}** · ${giveaway.entries.length} entries · ${state}`;
  });
  return `## 🎉 Giveaways\n${lines.join('\n')}`;
}

async function sendHelp(message: any, prefixLine?: string) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      prefixLine || '## 🎉 Giveaways',
      `\`${p}giveaway start 1h 2w Discord Nitro\` — 1 hour, 2 winners`,
      `\`${p}gstart 30m Steam key\` — shorthand for the same thing`,
      `\`${p}giveaway end <id>\` · \`${p}giveaway reroll <id> [count]\` · \`${p}giveaway list\` · \`${p}giveaway info <id>\``,
      '',
      '**Entry requirements**',
      '`--level 5` minimum leveling level · `--role <roleId>` required role · `--age 7` account age in days',
      '`--bonus <roleId>:3` gives that role 3 entries · `--desc <text>` adds a line to the embed',
      '',
      `Members enter by reacting 🎉. Free game deals are a different feature: \`${p}freestuff\`.`,
    ].join('\n'),
  });
}
