import { config } from '../config.js';
import { MUSIC_HELP_LINES } from './music-meta.js';
import { BOORU_HELP_LINES } from './booru.js';
import { getModule, isModuleEnabled } from '../modules.js';

/**
 * Help categories
 */
const HELP_CATEGORIES = {
  dashboard: {
    title: '🤖 Dashboard',
    lines: [
      '`{p}dashboard` - Open the local control panel that hosts every editor in one page',
      '`{p}dashboard cloudflare` - Admin only: expose it over a Cloudflare tunnel and DM you a full-access, single-use link (open it in Share access to mint more)',
      'Tabs: Welcomer (join image), Embeds, Roles, Notify, Free Stuff (free games & deals), Booru (site accounts, blacklist), Setup (tickets/join roles/stats/logs), Ops (backups, runtime health, bot audit log, purge builders), Automation (auto-responder/auto-react), Antiraid (raid protection), Reminders (scheduled messages), Leveling (XP/leaderboard/role rewards), Moderation (cases + escalation), Automod (content filters), Polls & giveaways, Community (tags/birthdays/voice rooms), Economy (currency + shop), Analytics (churn, busiest hours, top channels), Modules (switch whole features on or off)',
      'Aliases: `{p}dash`, `{p}editors`, `{p}panel`. `{p}dashboard` runs on this machine only; `cloudflare` makes it reachable anywhere.',
    ],
  },
  ping: {
    title: '🏓 Ping & Status',
    lines: [
      '`{p}ping` - Show latency (message + API) and host hardware status',
      'Reports CPU load, process/system RAM, bot + host uptime, Node version, and connected servers.',
      'Aliases: `{p}status`, `{p}health`.',
    ],
  },
  music: {
    title: '🎵 Music',
    lines: MUSIC_HELP_LINES,
  },
  booru: {
    title: '🖼️ Booru Image Search',
    lines: BOORU_HELP_LINES,
  },
  ticket: {
    title: '🎫 Ticket Commands',
    lines: [
      '`{p}ticket open [reason]` - Open a new support ticket',
      '`{p}ticket panel` - Send the reaction ticket panel',
      '`{p}ticket close` - Close current ticket',
      '`{p}ticket claim [@user|clear]` - Claim/assign (or release) the current ticket (staff)',
      '`{p}ticket priority [low|normal|high|urgent]` - View or set ticket priority (staff)',
      '`{p}ticket transcript` - Generate transcript for closed ticket',
      '`{p}ticket delete` - Generate transcript + delete ticket channel/data',
      '`{p}ticket setup <openCat> <closedCat> <transcriptChannel> <supportRole>` - Configure ticket IDs',
      '`{p}ticket help [category]` - Show ticket help (or forward to category)',
    ],
  },
  stats: {
    title: '📊 Stats Channels',
    lines: [
      '`{p}stats add all <channelId> [label]` - Track all members in a text channel name',
      '`{p}stats add role <roleId> <channelId> [label]` - Track members with a specific role',
      '`{p}stats list` - List configured stats channels',
      '`{p}stats remove <channelId>` - Remove one stats channel config',
      '`{p}stats refresh` - Force refresh all stats channels now',
    ],
  },
  roles: {
    title: '🎭 Roles',
    lines: [
      '`{p}dashboard` - Open the dashboard and use the Roles tab (create, recolor, permissions)',
      'Roles tab → **Bot permissions**: allow or deny each bot feature per role (Everyone rule included).',
      '`{p}roles gradient <roleId> <col1> <col2> [col3] [col4] [--angle 90]` - Set a role CSS linear-gradient color',
      '`{p}roles add <messageId> <emoji> <roleId> [emoji roleId ...]` - Add reaction roles to an existing message in the current channel',
      '`{p}roles remove <messageId> [emoji ...]` - Remove mappings from a message',
      '`{p}roles list` - List configured reaction-role messages',
      'React = get role, remove reaction = remove role.',
    ],
  },
  joinrole: {
    title: '👋 Join Roles',
    lines: [
      '`{p}joinrole add <roleId>` - Give this role to every new server member',
      '`{p}joinrole remove <roleId>` - Stop auto-assigning a role',
      '`{p}joinrole list` - List configured join roles',
      '`{p}joinrole clear` - Remove all configured join roles',
      'Bot must be elevated above the join role and have AssignRoles/ManageRole.',
    ],
  },
  welcome: {
    title: '👋 Welcome Images',
    lines: [
      '`{p}dashboard` - Open the dashboard Welcomer tab: a Canva-like editor for draggable text, images, and the member avatar',
      '`{p}welcome set <channelId>` - Set the welcome channel and enable welcomes',
      '`{p}welcome message <text>` - Set welcome message with `{user}`, `{mention}`, `{server}`, `{count}`',
      '`{p}welcome image <on|off>` - Toggle generated welcome image attachment',
      '`{p}welcome background <hex|color|imageUrl>` - Customize image background',
      '`{p}welcome textcolor <hex|color>` / `{p}welcome accent <hex|color>` - Customize image text/accent colors',
      '`{p}welcome layout <classic|compact|banner>` - Choose image layout',
      '`{p}welcome status` / `{p}welcome test [channelId]` - Inspect or test welcome config',
    ],
  },
  embed: {
    title: '🧩 Embed Creator',
    lines: [
      '`{p}dashboard` - Open the dashboard and use the Embeds tab',
      'Create embeds with live preview, save them to a local library, and send them to a channel by ID.',
      'Supported embed parts: message content, title, description, color, and title URL.',
    ],
  },
  logs: {
    title: '🧾 Server Logs',
    lines: [
      '`{p}logs set <channelId>` - Set the channel where logs are sent',
      '`{p}logs status` - Show log system status',
      '`{p}logs test` - Send a test log message',
      '`{p}logs disable` - Disable server logs',
      'Logs include server/channel/role/member/message modifications (excluding message create).',
    ],
  },
  purge: {
    title: '🧹 Purge / MassEliminate',
    lines: [
      '`{p}purge <count>` - Delete the last messages in the current channel',
      '`{p}purge count @user [#channel|all-channels]` - Count messages from a user without deleting',
      '`{p}purge last <count> @user [#channel|all-channels]` - Delete recent messages from a user',
      '`{p}purge all [@user] [#channel|all-channels] --confirm` - Mass-eliminate matching messages',
      '`{p}masseliminate ...` / `{p}mass-eliminate ...` - Aliases for purge',
      'Requires support role or Manage Messages permission. Use `{p}purge help` for details.',
    ],
  },
  moderation: {
    title: '🔨 Moderation cases',
    lines: [
      '`{p}warn @user [reason]` - Record a warning (may trigger the escalation ladder)',
      '`{p}mute @user [duration] [reason]` - Timeout a member, e.g. `{p}mute @user 2h spam`',
      '`{p}unmute @user [reason]` - Lift a mute early',
      '`{p}kick @user [reason]` / `{p}ban @user [duration] [reason]` / `{p}unban <userId>`',
      '`{p}note @user <text>` - Staff-only note; the member is never told',
      '`{p}cases [@user]` - Case history · `{p}case <id>` - One case in full',
      '`{p}case reason <id> <text>` / `{p}case delete <id>` - Edit a record, or remove it (Ban Members)',
      '`{p}modstats` - Totals per action and the busiest moderators',
      'A duration makes a ban temporary; it is lifted automatically. Escalation, the mute role and DM notices live in the dashboard Moderation tab.',
      'Related: `{p}help purge`, `{p}help permissions`, `{p}help automod`.',
    ],
  },
  automod: {
    title: '🛡️ Automod',
    lines: [
      '`{p}automod on|off|status|list` - Turn filtering on and inspect it',
      '`{p}automod add <type> [action] [duration]` - Add a rule',
      'Types: `words` `invites` `links` `mentions` `spam` `duplicates` `caps` `emoji` `newlines` `zalgo` `attachments`',
      'Actions: `delete` (remove the message only), `warn`, `mute`, `kick`, `ban` — the rest also delete it and open a case',
      '`{p}automod words <id> add|remove <word…>` - Edit a word list (`*` is a wildcard)',
      '`{p}automod set <id> threshold|action|window|name <value>` - Tune a rule',
      '`{p}automod remove <id>` / `{p}automod toggle <id>` / `{p}automod exempt role|channel <id>`',
      'Staff with Manage Messages and friends are exempt by default. Or use the dashboard Automod tab.',
    ],
  },
  polls: {
    title: '📊 Polls',
    lines: [
      '`{p}poll "Question" "Option A" "Option B"` - Post a poll (up to 10 options)',
      '`{p}poll "Ship it?"` - A yes/no poll',
      '`{p}poll Ship it? yes, no, later` - Shorthand: options split on commas',
      '`--time 2h` closes it automatically · `--multi` allows several votes · `--anon` hides who voted',
      '`{p}poll list` / `{p}poll end <id>` / `{p}poll delete <id>`',
      'Votes are reactions; removing your reaction withdraws the vote.',
    ],
  },
  giveaways: {
    title: '🎉 Giveaways',
    lines: [
      '`{p}giveaway start 1h 2w Discord Nitro` - 1 hour, 2 winners (`{p}gstart` is the same thing)',
      '`{p}giveaway end <id>` / `{p}giveaway reroll <id> [count]` / `{p}giveaway list` / `{p}giveaway info <id>`',
      'Requirements: `--level 5`, `--role <roleId>`, `--age 7` (account age in days)',
      '`--bonus <roleId>:3` gives that role three entries · `--desc <text>` adds a line to the embed',
      'Members enter by reacting 🎉; ineligible entries are refused straight away with a DM.',
      'Free game deals are a separate feature: `{p}help freestuff`.',
    ],
  },
  tags: {
    title: '🏷️ Tags (custom commands)',
    lines: [
      '`{p}tag create <name> <content>` - Make `{p}<name>` answer with that content',
      '`{p}tag edit <name> <content>` / `{p}tag delete <name>` / `{p}tag rename <name> <new>`',
      '`{p}tag list` / `{p}tag search <text>` / `{p}tag info <name>` / `{p}tag raw <name>`',
      '`{p}tag alias add <name> <alias>` / `{p}tag alias remove <alias>`',
      '`{p}tag restrict <name> <roleId|off>` / `{p}tag channel <name> <channelId|off>`',
      'Placeholders: `{user}` `{mention}` `{server}` `{channel}` `{count}` `{args}`. Tags never shadow a built-in command.',
    ],
  },
  economy: {
    title: '💰 Economy',
    lines: [
      '`{p}balance [@user]` - Check a balance (aliases: `{p}bal`, `{p}wallet`)',
      '`{p}daily` - Claim the daily amount, with a streak bonus · `{p}work` - Earn on a cooldown',
      '`{p}pay @user <amount>` - Send currency to someone',
      '`{p}shop` / `{p}buy <item>` / `{p}inventory [@user]` - Spend it',
      '`{p}rich` - Balance leaderboard (aliases: `{p}baltop`, `{p}richest`)',
      '`{p}gamble <amount>` - Only when an admin has enabled it',
      '`{p}eco on|off|status` · `{p}eco add|remove|set @user <amount>` · `{p}eco reset @user|all` - Admin (Manage Server)',
      'Coins are separate from leveling XP on purpose, so buying a role never costs you rank. Shop items and rates live in the dashboard Economy tab.',
    ],
  },
  birthday: {
    title: '🎂 Birthdays',
    lines: [
      '`{p}birthday set <date>` - `15/03`, `15 March`, or `1998-03-15`',
      '`{p}birthday remove` / `{p}birthday show [@user]` / `{p}birthday next` / `{p}birthday list`',
      '`{p}birthday channel <id|off>` / `{p}birthday role <id|off>` - Where it is announced, and the role for the day',
      '`{p}birthday hour <0-23>` / `{p}birthday offset <hours>` - Announcement time in the server timezone',
      '`{p}birthday message <text>` - Placeholders: `{mention}` `{user}` `{age}` `{server}`',
      '`{p}birthday year <on|off>` / `{p}birthday test` / `{p}birthday status`',
      'Setup commands need Manage Server. 29 February rolls to 1 March in non-leap years.',
    ],
  },
  voice: {
    title: '🔊 Temporary voice rooms',
    lines: [
      '`{p}vc create [name]` - Open your own room (once an admin has run `{p}vc on`)',
      '`{p}vc name <text>` / `{p}vc limit <0-99>` / `{p}vc lock` / `{p}vc unlock`',
      '`{p}vc claim` - Take over a room whose owner left · `{p}vc close` · `{p}vc list`',
      '`{p}vc on|off|status` / `{p}vc hub <channelId|off>` / `{p}vc notice <channelId|off>` - Setup (Manage Server)',
      'Stoat cannot move members between voice channels, so joining the hub posts a link to your new room rather than dragging you in.',
      'Rooms close themselves once they have been empty for a while.',
    ],
  },
  permissions: {
    title: '🧬 Mass Permissions',
    lines: [
      '`{p}perms clone <sourceChannel> <targetChannel> --confirm` - Clone permission overwrites to one channel',
      '`{p}perms clone <sourceChannel> category <categoryId> --confirm` - Clone overwrites to all channels in a category',
      '`{p}perms nsfw <on|off> <targetChannel|category <categoryId>|all> --confirm` - Mass mark channels NSFW or safe',
      '`--no-default` - Skip default permissions and copy only role overwrites',
      '`{p}permissions`, `{p}massperms`, `{p}mass-perms` - Aliases',
      'Requires Manage Permissions or Manage Channels permission.',
    ],
  },
  backup: {
    title: 'Server Backups',
    lines: [
      '`{p}backup export [serverId] [name]` - Save channels, roles, permissions, bot feature JSON, and transcripts',
      '`{p}backup import <file> [targetServerId] --confirm` - Restore into an empty server',
      '`{p}backup import <file> [targetServerId] --dry-run` - Preview restore counts',
      '`{p}backup preview <file> [targetServerId]` - Diff a backup against the live server before restoring',
      '`{p}backup list` - Show recent files in data/backups',
      'Import order: channels, roles, permissions, then bot features.',
    ],
  },
  reminder: {
    title: '⏰ Reminders',
    lines: [
      '`{p}reminder add <#channel> <schedule> | <message>` - Schedule a recurring or one-off message',
      '`{p}reminder list` - List reminders',
      '`{p}reminder remove <id>` / `{p}reminder toggle <id>` / `{p}reminder test <id>` - Delete, enable/disable, or send now',
      'Schedules: `every 30s|10m|2h|1d|1w|3mo`, `weekly mon,fri 09:00`, `monthly 15 09:00`, `on 2026-12-25 10:00`',
      'Times use the bot host local time. Placeholders: `{time}` `{date}`. Or use the dashboard Reminders tab.',
    ],
  },
  antiraid: {
    title: '🛡️ Antiraid',
    lines: [
      '`{p}antiraid on` / `{p}antiraid off` - Enable or disable raid protection',
      '`{p}antiraid status` - Show settings and current raid state',
      '`{p}antiraid lockdown <on|off>` - Manually force raid mode',
      '`{p}antiraid set joins <n>` / `{p}antiraid set window <sec>` - Join-flood trigger',
      '`{p}antiraid set action <kick|ban|alert>` - What to do to raiders',
      '`{p}antiraid set minage <minutes>` / `{p}antiraid set ageaction <kick|ban|alert|off>` - Account-age gate',
      '`{p}antiraid set alert <channelId|off>` / `{p}antiraid set lockdown <min>` - Alerts and lockdown length',
      '`{p}antiraid honeypot create [name]` / `{p}antiraid honeypot off` - Trap channel: non-staff who post there get actioned',
      '`{p}antiraid set honeypot <channelId|off> [confirm]` / `{p}antiraid set honeypotaction <kick|ban|alert>` - Honeypot channel and action',
      'Bot must be elevated above members it kicks/bans, with Kick/Ban permission. Or use the dashboard Antiraid tab.',
    ],
  },
  autoresponder: {
    title: '💬 Auto-Responder',
    lines: [
      '`{p}autoresponder add <trigger> | <response> [flags]` - Auto-reply when a message matches',
      '`{p}autoresponder list` - List configured responders',
      '`{p}autoresponder remove <id>` / `{p}autoresponder toggle <id>` - Delete or enable/disable',
      'Flags: `--exact` `--starts` `--ends` `--regex` `--case` `--channel <id>` `--cooldown <sec>` (default match: contains)',
      'Placeholders: `{user}` `{mention}` `{channel}`. Aliases: `{p}ar`, `{p}responder`.',
      'Or configure it visually in the dashboard Automation tab.',
    ],
  },
  autoreact: {
    title: '😀 Auto-React',
    lines: [
      '`{p}autoreact add <trigger> | <emoji> [emoji2 ...] [flags]` - Auto-react to matching messages',
      '`{p}autoreact add --all | <emoji>` - React to every message',
      '`{p}autoreact list` - List configured auto-reacts',
      '`{p}autoreact remove <id>` / `{p}autoreact toggle <id>` - Delete or enable/disable',
      'Flags: `--exact` `--starts` `--ends` `--regex` `--all` `--case` `--channel <id>` (default match: contains)',
      'Emoji can be unicode or a custom emoji id. Or use the dashboard Automation tab.',
    ],
  },
  leveling: {
    title: '📈 Leveling & Leaderboard',
    lines: [
      '`{p}rank [@user]` - Show a rank card (level, XP, progress)',
      '`{p}leaderboard [count]` - Show the top members (aliases: `{p}top`, `{p}lb`)',
      '`{p}level enable | disable` - Turn XP earning on/off',
      '`{p}level setxp <min> <max>` / `{p}level cooldown <seconds>` - XP rate + anti-spam cooldown',
      '`{p}level announce <on|off|here|#channelId>` - Level-up messages',
      '`{p}level rolereward add <level> <roleId>` - Auto-add a role when a member hits a level',
      '`{p}level rolereward remove <level>` / `{p}level rolereward list` - Manage role rewards',
      '`{p}level stack <on|off>` - Keep every reward role, or only the highest',
      '`{p}level givexp <@user> <amount>` / `{p}level setlevel <@user> <level>` / `{p}level reset <@user|all>`',
      'Or configure everything visually in the dashboard Leveling tab.',
    ],
  },
  sync: {
    title: 'Channel Sync & Copy',
    lines: [
      '`{p}sync copy <source> <target>` - Copy every message from one channel into another (same or different server)',
      '`{p}sync link <source> <target> [--twoway]` - Live-mirror new messages, edits and deletes between two channels',
      '`{p}sync unlink <linkId|channelId>` - Stop a live link',
      '`{p}sync list` - Show active live links',
      '`{p}sync filter <linkId> allow|deny <user|role|word> <values…>` - Whitelist / blacklist what a link mirrors',
      '`{p}sync debug scan <linkId|channelId> [--apply]` - Find messages added, edited or deleted without being mirrored',
      '`{p}sync debug` - All diagnostics: status, links, ledger, trace, prune, cursor, replay, probe, channel',
      'Channels accept an ID or #mention. Cross-server needs the bot in both servers with Send + Masquerade.',
      'Requires Manage Server permission.',
    ],
  },
  freestuff: {
    title: '🎁 Free Stuff (free games & deals)',
    lines: [
      '`{p}freestuff setup` - Enable the feed in the current channel',
      '`{p}freestuff enable|disable` - Toggle the feed (keeps settings)',
      '`{p}freestuff sources gamerpower cheapshark` - Pick offer sources',
      '`{p}freestuff platforms epic steam gog` - GamerPower platform filter (or `all`)',
      '`{p}freestuff types game loot dlc` - GamerPower offer types (or `all`)',
      '`{p}freestuff deals 80` - Enable CheapShark deals at ≥80% off',
      '`{p}freestuff mention @Role` - Ping a role on new offers (`off` to clear)',
      '`{p}freestuff test [n]` - Preview the latest offers now',
      '`{p}freestuff status` - Show current settings',
      'Auto-posts free giveaways (GamerPower) + big discounts (CheapShark). Requires Manage Server.',
    ],
  },
};

/** Help category → the module it documents (see modules.ts). Unlisted = core. */
const CATEGORY_MODULES: Record<string, string> = {
  music: 'music',
  booru: 'booru',
  stats: 'stats',
  joinrole: 'joinroles',
  welcome: 'welcome',
  logs: 'logs',
  moderation: 'moderation',
  automod: 'automod',
  polls: 'polls',
  giveaways: 'giveaways',
  tags: 'tags',
  economy: 'economy',
  birthday: 'birthdays',
  voice: 'tempvoice',
  reminder: 'reminders',
  antiraid: 'antiraid',
  autoresponder: 'autoresponder',
  autoreact: 'autoreact',
  leveling: 'leveling',
  sync: 'sync',
  freestuff: 'freestuff',
};

/** Categories to list: switched-off modules are left out. */
function visibleCategories(): string[] {
  return Object.keys(HELP_CATEGORIES).filter((key) => !CATEGORY_MODULES[key] || isModuleEnabled(CATEGORY_MODULES[key]));
}

/**
 * Ticket help command
 * Usage: !ticket help [category]
 */
export async function ticketHelp(message, args, client) {
  const prefix = config.prefix;

  const category = normalizeCategory(args?.[0]);
  if (category && HELP_CATEGORIES[category]) {
    await message.channel?.send({
      content: renderCategory(prefix, category),
    });
    return;
  }

  await message.channel?.send({
    content: renderCategory(prefix, 'ticket'),
  });
}

/**
 * Global help command
 * Usage: !help [category]
 */
export async function helpCommand(message, args, client) {
  const prefix = config.prefix;
  const category = normalizeCategory(args?.[0]);

  if (!category) {
    await message.channel?.send({
      content: renderCategoryList(prefix),
    });
    return;
  }

  if (category === 'all') {
    const content = visibleCategories()
      .map((key) => renderCategory(prefix, key))
      .join('\n\n');

    await message.channel?.send({ content });
    return;
  }

  if (!HELP_CATEGORIES[category]) {
    await message.channel?.send({
      content: `❌ Unknown help category: \`${args[0]}\`.\n\n${renderCategoryList(prefix)}`,
    });
    return;
  }

  await message.channel?.send({
    content: renderCategory(prefix, category),
  });
}

function renderCategoryList(prefix) {
  const categories = visibleCategories()
    .map((category) => `• \`${prefix}help ${category}\``)
    .join('\n');

  return (
    `# 📚 Help Categories\n\n` +
    `Use \`${prefix}help <category>\`\n` +
    `Use \`${prefix}help all\` to show everything.\n\n` +
    `${categories}`
  );
}

function renderCategory(prefix, category) {
  const data = HELP_CATEGORIES[category];
  const lines = data.lines.map((line) => `• ${line.replaceAll('{p}', prefix)}`).join('\n');
  // Asked for by name while switched off: still documented, with a note why it does nothing.
  const moduleKey = CATEGORY_MODULES[category];
  const off = moduleKey && !isModuleEnabled(moduleKey)
    ? `\n\n*The ${getModule(moduleKey)?.label || moduleKey} module is switched off; the bot owner can turn it on in the dashboard, under Modules.*`
    : '';
  return `# ${data.title}\n\n${lines}${off}`;
}

function normalizeCategory(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
}
