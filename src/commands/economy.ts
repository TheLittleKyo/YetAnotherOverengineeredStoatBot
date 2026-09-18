import { config } from '../config.js';
import { isStoatId, normalizeId } from '../id-utils.js';
import { joinLinesWithin } from '../embed-limits.js';
import { canManageServerById } from '../permissions.js';
import { formatDuration } from '../duration.js';
import {
  addBalance,
  buyItem,
  claimDaily,
  doWork,
  gamble,
  getBalance,
  getEconomyConfig,
  getRichList,
  inventoryOf,
  listShop,
  resetEconomyAll,
  resetEconomyUser,
  setBalance,
  setEconomyConfig,
  transfer,
} from '../economy.js';

/**
 * Economy commands. One handler serves every name, dispatching on the alias it
 * was called by, the way the music commands do — `!balance`, `!daily` and
 * `!shop` all read better than `!eco balance`.
 *
 *   balance [@user] · daily · work · pay @user <amount>
 *   shop · buy <item> · inventory [@user] · rich
 *   gamble <amount>                     (off unless enabled)
 *   eco add|remove|set @user <amount> · eco reset @user|all · eco on|off|status
 */

export const ECONOMY_COMMAND_NAMES = [
  'balance', 'bal', 'coins', 'wallet',
  'daily',
  'work',
  'pay', 'give',
  'shop',
  'buy',
  'inventory', 'inv',
  'rich', 'baltop', 'richest',
  'gamble', 'bet',
  'eco', 'economy',
];

const ALIASES: Record<string, string> = {
  bal: 'balance', coins: 'balance', wallet: 'balance',
  give: 'pay',
  inv: 'inventory',
  baltop: 'rich', richest: 'rich',
  bet: 'gamble',
  economy: 'eco',
};

/** A member id from a mention or pasted id; anything else is not a member. */
function memberId(value: unknown): string | null {
  const id = normalizeId(value);
  return id && isStoatId(id) ? id : null;
}

export async function economyCommand(message: any, args: string[], client: any) {
  const invokedAs = (args.shift() || '').toLowerCase();
  const command = ALIASES[invokedAs] || invokedAs;

  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');
  if (!serverId) {
    await message.channel?.send({ content: '❌ The economy only works inside a server.' });
    return;
  }

  const cfg = getEconomyConfig(serverId);
  const userId = String(message?.authorId || '');
  const authorName = String(message?.member?.nickname || message?.author?.username || '');
  const money = (amount: number) => `${cfg.currencySymbol}${amount.toLocaleString()} ${cfg.currencyName}`;

  // `eco` is the admin surface and must work even while the economy is off, so
  // it is handled before the enabled check.
  if (command === 'eco') return adminCommand(message, client, serverId, args, money);

  if (!cfg.enabled) {
    await message.channel?.send({
      content: `❌ The economy is switched off in this server. An admin can turn it on with \`${config.prefix}eco on\`.`,
    });
    return;
  }

  switch (command) {
    case 'balance': {
      const target = memberId(args.shift()) || userId;
      const balance = getBalance(target, serverId);
      const items = inventoryOf(target, serverId).reduce((sum, row) => sum + row.count, 0);
      await message.channel?.send({
        content: `${cfg.currencySymbol} <@${target}> has **${balance.balance.toLocaleString()}** ${cfg.currencyName}${items ? ` · ${items} item(s)` : ''}.`,
      });
      return;
    }

    case 'daily': {
      const result = claimDaily(userId, serverId, authorName);
      await message.channel?.send({
        content: result.ok
          ? `🗓️ You claimed **${money(result.amount)}**${result.streak && result.streak > 1 ? ` · ${result.streak}-day streak` : ''}. Balance: ${money(result.balance)}.`
          : `❌ ${result.error}${result.retryInMs ? ` Try again in ${formatDuration(result.retryInMs)}.` : ''}`,
      });
      return;
    }

    case 'work': {
      const result = doWork(userId, serverId, authorName);
      await message.channel?.send({
        content: result.ok
          ? `💼 You earned **${money(result.amount)}**. Balance: ${money(result.balance)}.`
          : `❌ ${result.error}${result.retryInMs ? ` Try again in ${formatDuration(result.retryInMs)}.` : ''}`,
      });
      return;
    }

    case 'pay': {
      const target = memberId(args.shift());
      const amount = Number(args.shift());
      if (!target || !Number.isFinite(amount)) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}pay @user <amount>\`` });
        return;
      }
      // Coins sent to a bot are gone for good.
      const recipient = client?.users?.cache?.get?.(target);
      if (target === client?.user?.id || recipient?.bot) {
        await message.channel?.send({ content: '❌ Bots cannot hold a balance.' });
        return;
      }
      const result = transfer(userId, target, amount, serverId);
      await message.channel?.send({
        content: result.ok
          ? `💸 Sent **${money(result.received)}** to <@${target}>${result.sent !== result.received ? ` (${money(result.sent - result.received)} tax)` : ''}. Balance: ${money(result.balance)}.`
          : `❌ ${result.error}`,
      });
      return;
    }

    case 'shop': {
      const items = listShop(serverId);
      if (!items.length) {
        await message.channel?.send({ content: 'The shop is empty. Admins add items in the dashboard **Economy** tab.' });
        return;
      }
      const lines = items.map((item) => {
        const stock = item.stock == null ? '' : ` · ${item.stock} left`;
        const role = item.roleId ? ` · grants <%${item.roleId}>` : '';
        return `- **${item.name}** — ${money(item.price)}${stock}${role}${item.description ? `\n  ${item.description}` : ''}`;
      });
      await message.channel?.send({
        content: `${joinLinesWithin('## 🛒 Shop', lines, 1900)}\n\nBuy with \`${config.prefix}buy <name>\`.`,
      });
      return;
    }

    case 'buy': {
      const name = args.join(' ').trim();
      if (!name) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}buy <item name>\`` });
        return;
      }
      const result = await buyItem(client, userId, name, serverId);
      if (!result.ok) {
        await message.channel?.send({ content: `❌ ${result.error}` });
        return;
      }
      const roleNote = result.item.roleId
        ? result.roleGranted
          ? ` The <%${result.item.roleId}> role is yours.`
          : ' I could not assign the role — ask a moderator to add it.'
        : '';
      await message.channel?.send({
        content: `🛍️ You bought **${result.item.name}** for ${money(result.item.price)}. Balance: ${money(result.balance)}.${roleNote}`,
      });
      return;
    }

    case 'inventory': {
      const target = memberId(args.shift()) || userId;
      const items = inventoryOf(target, serverId);
      await message.channel?.send({
        content: items.length
          ? joinLinesWithin(`## 🎒 <@${target}>'s inventory`, items.map((row) => `- **${row.item.name}** ×${row.count}`))
          : `<@${target}> owns nothing yet.`,
      });
      return;
    }

    case 'rich': {
      const rows = getRichList(10, serverId);
      if (!rows.length) {
        await message.channel?.send({ content: 'Nobody has earned anything yet.' });
        return;
      }
      const medals = ['🥇', '🥈', '🥉'];
      const lines = rows.map((row) => `${medals[row.rank - 1] || `${row.rank}.`} <@${row.userId}> — ${money(row.balance)}`);
      await message.channel?.send({ content: `## 💰 Richest members\n${lines.join('\n')}` });
      return;
    }

    case 'gamble': {
      const amount = Number(args.shift());
      if (!Number.isFinite(amount)) {
        await message.channel?.send({ content: `❌ Usage: \`${config.prefix}gamble <amount>\`` });
        return;
      }
      const result = gamble(userId, amount, serverId);
      if (!result.ok) {
        await message.channel?.send({ content: `❌ ${result.error}` });
        return;
      }
      await message.channel?.send({
        content: result.won
          ? `🎲 You won **${money(Math.abs(result.delta))}**! Balance: ${money(result.balance)}.`
          : `🎲 You lost **${money(Math.abs(result.delta))}**. Balance: ${money(result.balance)}.`,
      });
      return;
    }

    default:
      await sendHelp(message, cfg.currencyName);
  }
}

async function adminCommand(
  message: any,
  client: any,
  serverId: string,
  args: string[],
  money: (amount: number) => string,
) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    const p = config.prefix;
    await message.channel?.send({
      content: [
        '## ⚙️ Economy admin',
        `\`${p}eco on|off|status\``,
        `\`${p}eco add|remove|set @user <amount>\``,
        `\`${p}eco reset @user\` · \`${p}eco reset all\` — clears one member, or everyone`,
        '',
        'Rewards, the shop and gambling limits live in the dashboard **Economy** tab.',
      ].join('\n'),
    });
    return;
  }

  if (!(await canManageServerById(client, serverId, message?.authorId))) {
    await message.channel?.send({ content: '❌ You need Manage Server permission for economy admin commands.' });
    return;
  }

  if (sub === 'on' || sub === 'off') {
    setEconomyConfig({ enabled: sub === 'on' }, serverId);
    await message.channel?.send({ content: `Economy **${sub === 'on' ? 'enabled' : 'disabled'}**.` });
    return;
  }

  if (sub === 'status') {
    const cfg = getEconomyConfig(serverId);
    await message.channel?.send({
      content: [
        '## 💰 Economy',
        `**State:** ${cfg.enabled ? 'on' : 'off'} · **Currency:** ${cfg.currencySymbol} ${cfg.currencyName}`,
        `**Per message:** ${cfg.messageMin}–${cfg.messageMax} every ${cfg.messageCooldownSec}s`,
        `**Daily:** ${cfg.dailyAmount} (+${cfg.dailyStreakBonus}/day streak) · **Work:** ${cfg.workMin}–${cfg.workMax} every ${formatDuration(cfg.workCooldownSec * 1000)}`,
        `**Transfers:** ${cfg.payEnabled ? `on (${cfg.payTaxPercent}% tax)` : 'off'} · **Gambling:** ${cfg.gamblingEnabled ? `on (max ${cfg.gambleMaxBet})` : 'off'}`,
        `**Shop items:** ${listShop(serverId).length}`,
      ].join('\n'),
    });
    return;
  }

  if (sub === 'reset') {
    const raw = String(args.shift() || '');
    // Wiping everyone must be asked for by name: a mistyped mention must never
    // fall through to "reset all".
    if (raw.toLowerCase() === 'all') {
      resetEconomyAll(serverId);
      await message.channel?.send({ content: '♻️ Every balance in this server was reset.' });
      return;
    }
    const target = memberId(raw);
    if (!target) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}eco reset @user\` or \`${config.prefix}eco reset all\`` });
      return;
    }
    const done = resetEconomyUser(target, serverId);
    await message.channel?.send({ content: done ? `♻️ Reset <@${target}>.` : 'That member has no balance yet.' });
    return;
  }

  if (sub === 'add' || sub === 'remove' || sub === 'set') {
    const target = memberId(args.shift());
    const amount = Number(args.shift());
    if (!target || !Number.isFinite(amount)) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}eco ${sub} @user <amount>\`` });
      return;
    }
    const balance =
      sub === 'set'
        ? setBalance(target, amount, serverId)
        : addBalance(target, sub === 'add' ? amount : -amount, serverId);
    await message.channel?.send({ content: `✅ <@${target}> now has ${money(balance)}.` });
    return;
  }

  await message.channel?.send({ content: `❌ Unknown economy admin command: \`${sub}\`.` });
}

async function sendHelp(message: any, currencyName: string) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      `## 💰 Economy (${currencyName})`,
      `\`${p}balance [@user]\` · \`${p}daily\` · \`${p}work\` · \`${p}pay @user <amount>\``,
      `\`${p}shop\` · \`${p}buy <item>\` · \`${p}inventory [@user]\` · \`${p}rich\``,
      `\`${p}gamble <amount>\` — only when an admin has enabled it`,
      `\`${p}eco help\` — admin commands`,
    ].join('\n'),
  });
}
