import { ticketOpen } from './ticket-open.js';
import { ticketClose } from './ticket-close.js';
import { ticketTranscript } from './ticket-transcript.js';
import { ticketDelete } from './ticket-delete.js';
import { ticketClaim } from './ticket-claim.js';
import { ticketPriority } from './ticket-priority.js';
import { helpCommand, ticketHelp } from './help.js';
import { ticketPanel } from './ticket-panel.js';
import { ticketSetup } from './ticket-setup.js';
import { statsCommand } from './stats.js';
import { rolesCommand } from './roles.js';
import { logsCommand } from './logs.js';
import { purgeCommand } from './purge.js';
import { permissionsCommand } from './permissions.js';
import { joinRoleCommand } from './joinrole.js';
import { welcomeCommand } from './welcome.js';
import { embedCommand } from './embed.js';
import { backupCommand } from './backup.js';
import { resetCommand } from './reset.js';
import { notifyCommand } from './notify.js';
import { freeStuffCommand } from './freestuff.js';
import { syncCommand } from './sync.js';
import { syncDebugCommand } from './sync-debug.js';
import { dashboardCommand } from './dashboard.js';
import { autoResponderCommand } from './autoresponder.js';
import { autoReactCommand } from './autoreact.js';
import { antiraidCommand } from './antiraid.js';
import { reminderCommand } from './reminder.js';
import { levelCommand } from './level.js';
import { pingCommand } from './ping.js';
import { captchaCommand } from './captcha.js';
import { MUSIC_COMMAND_NAMES } from './music-meta.js';
import { runMusicCommand } from '../music/lazy.js';
import { booruCommand, BOORU_COMMAND_NAMES } from './booru.js';
import { moderationCommand, MODERATION_COMMAND_NAMES } from './moderation.js';
import { automodCommand } from './automod.js';
import { pollCommand } from './poll.js';
import { tempVoiceCommand } from './tempvoice.js';
import { giveawayCommand, GIVEAWAY_COMMAND_NAMES, routeGiveawayArgs } from './giveaway.js';
import { tagCommand } from './tag.js';
import { economyCommand, ECONOMY_COMMAND_NAMES } from './economy.js';
import { birthdayCommand } from './birthday.js';
import { config } from '../config.js';
import { resolveBotPermission, runWithBotPermission } from '../bot-permissions.js';
import { normalizeTagName, runTag, setBuiltinCommandNames, tagNamesFor } from '../tags.js';
import { recordCommandUse } from '../analytics.js';
import { recordCommand as recordHealthCommand } from '../health.js';
import { disabledModuleForFeature, isModuleEnabled, moduleOffMessage } from '../modules.js';

// Register ticket subcommands
const ticketSubcommands = {
  open: ticketOpen,
  close: ticketClose,
  delete: ticketDelete,
  transcript: ticketTranscript,
  claim: ticketClaim,
  priority: ticketPriority,
  help: ticketHelp,
  panel: ticketPanel,
  setup: ticketSetup,
};

/** Bot-permission feature each ticket subcommand belongs to (see bot-permissions.ts). */
const TICKET_FEATURES: Record<string, string> = {
  open: 'tickets',
  close: 'tickets',
  delete: 'tickets',
  transcript: 'tickets',
  claim: 'tickets.staff',
  priority: 'tickets.staff',
  panel: 'tickets.setup',
  setup: 'tickets.setup',
};

type CommandHandler = (message: any, args: string[], client: any) => Promise<unknown> | unknown;

type CommandEntry = {
  /** Every name that invokes this command; the first is the canonical one. */
  names: string[];
  run: CommandHandler;
  /** Text for the reply sent when `run` throws. */
  describeError: (error: any) => string;
  /** Rewrite the argument list for bare aliases (see `level`). */
  routeArgs?: (invokedAs: string, args: string[]) => string[];
  /** Bot-permission feature key the dashboard can allow or deny per role. */
  feature?: string;
};

/** `❌ An error occurred while executing <phrase>` — phrase carries its own period. */
function failed(phrase: string) {
  return () => `❌ An error occurred while executing ${phrase}`;
}

/** Same, with the underlying failure appended. */
function failedWith(phrase: string) {
  return (error: any) => `❌ An error occurred while executing ${phrase}: ${error?.message || error}`;
}

/**
 * Every non-ticket command, its aliases, and how a failure is reported. The
 * dispatcher below is a single table lookup over this list; `ticket` stays
 * special-cased because it dispatches again on a subcommand.
 */
const COMMAND_LIST: CommandEntry[] = [
  { names: ['ping', 'status', 'health'], run: pingCommand, describeError: failed('the ping command.') },
  { names: ['stats'], run: statsCommand, describeError: failed('that stats command.'), feature: 'stats' },
  { names: ['roles'], run: rolesCommand, describeError: failed('that roles command.'), feature: 'reactionroles' },
  {
    names: ['joinrole', 'joinroles'],
    run: joinRoleCommand,
    describeError: failed('that joinrole command.'),
    feature: 'joinroles',
  },
  {
    names: ['welcome', 'welcomes', 'welcomer'],
    run: welcomeCommand,
    describeError: failed('that welcome command.'),
    feature: 'welcome',
  },
  { names: ['embed', 'embeds'], run: embedCommand, describeError: failed('that embed command.'), feature: 'embed' },
  { names: ['help'], run: helpCommand, describeError: failed('help command.') },
  { names: ['backup', 'backups'], run: backupCommand, describeError: formatBackupError, feature: 'backup' },
  { names: ['logs'], run: logsCommand, describeError: failed('logs command.'), feature: 'logs' },
  {
    names: ['purge', 'masseliminate', 'mass-eliminate'],
    run: purgeCommand,
    describeError: failed('purge command.'),
    feature: 'purge',
  },
  {
    names: ['permissions', 'perms', 'massperms', 'mass-perms'],
    run: permissionsCommand,
    describeError: failed('permissions command.'),
    feature: 'perms',
  },
  { names: ['reset'], run: resetCommand, describeError: failedWith('the reset command'), feature: 'reset' },
  {
    names: ['sync', 'mirror', 'copychannel'],
    run: syncCommand,
    describeError: failedWith('the sync command'),
    feature: 'sync',
  },
  {
    names: ['syncdebug', 'sync-debug', 'syncdiag'],
    run: syncDebugCommand,
    describeError: failedWith('the sync debug command'),
    feature: 'sync',
  },
  {
    names: ['notify', 'notifications', 'notif'],
    run: notifyCommand,
    describeError: failedWith('the notify command'),
    feature: 'notify',
  },
  {
    // `giveaway` / `giveaways` used to live here; they now run the hosted
    // giveaway system below, which is what those words mean to a member. The
    // free-games feed keeps its own, unambiguous names.
    names: ['freestuff', 'free', 'freegames', 'deals'],
    run: freeStuffCommand,
    describeError: failedWith('the freestuff command'),
    feature: 'freestuff',
  },
  {
    names: ['autoresponder', 'autorespond', 'responder', 'ar'],
    run: autoResponderCommand,
    describeError: failedWith('the autoresponder command'),
    feature: 'autoresponder',
  },
  {
    names: ['autoreact', 'autoreaction', 'reactor'],
    run: autoReactCommand,
    describeError: failedWith('the autoreact command'),
    feature: 'autoreact',
  },
  {
    names: ['antiraid', 'anti-raid', 'raid', 'raidguard'],
    run: antiraidCommand,
    describeError: failedWith('the antiraid command'),
    feature: 'antiraid',
  },
  {
    names: ['reminder', 'reminders', 'remind', 'schedule', 'scheduledmessage'],
    run: reminderCommand,
    describeError: failedWith('the reminder command'),
    feature: 'reminder',
  },
  {
    names: ['level', 'levels', 'leveling', 'lvl', 'rank', 'leaderboard', 'lb', 'top', 'xp'],
    run: levelCommand,
    describeError: failedWith('the level command'),
    feature: 'level',
    // Map the bare aliases to their level subcommand so `!rank`, `!leaderboard`,
    // `!top` work directly while `!level ...` still routes normally.
    routeArgs: (invokedAs, args) => {
      if (invokedAs === 'rank') return ['rank', ...args];
      if (invokedAs === 'leaderboard' || invokedAs === 'lb' || invokedAs === 'top') return ['leaderboard', ...args];
      return args;
    },
  },
  {
    names: ['captcha', 'verify', 'verification'],
    run: captchaCommand,
    describeError: failedWith('the captcha command'),
    feature: 'captcha',
  },
  {
    names: MUSIC_COMMAND_NAMES,
    // Imported on first use: the music stack is too heavy to load at boot.
    run: runMusicCommand,
    describeError: failedWith('that music command'),
    // Every music command shares one handler that dispatches on the name it was called by.
    routeArgs: (invokedAs, args) => [invokedAs, ...args],
    feature: 'music',
  },
  {
    names: BOORU_COMMAND_NAMES,
    run: booruCommand,
    describeError: failedWith('that booru command'),
    // `!danbooru tags` and `!booru danbooru tags` share one handler that reads the name it was called by.
    routeArgs: (invokedAs, args) => [invokedAs, ...args],
    feature: 'booru',
  },
  {
    names: MODERATION_COMMAND_NAMES,
    run: moderationCommand,
    describeError: failedWith('that moderation command'),
    // Every moderation command shares one handler that dispatches on its name.
    routeArgs: (invokedAs, args) => [invokedAs, ...args],
    feature: 'moderation',
  },
  {
    names: ['automod', 'filter', 'contentfilter'],
    run: automodCommand,
    describeError: failedWith('the automod command'),
    feature: 'automod',
  },
  {
    names: ['poll', 'polls', 'vote'],
    run: pollCommand,
    describeError: failedWith('the poll command'),
    feature: 'polls',
  },
  {
    names: ['vc', 'tempvoice', 'voiceroom'],
    run: tempVoiceCommand,
    describeError: failedWith('the voice room command'),
    feature: 'tempvoice',
  },
  {
    names: GIVEAWAY_COMMAND_NAMES,
    run: giveawayCommand,
    describeError: failedWith('the giveaway command'),
    routeArgs: routeGiveawayArgs,
    feature: 'giveaways',
  },
  {
    names: ['tag', 'tags'],
    run: tagCommand,
    describeError: failedWith('the tag command'),
    feature: 'tags',
  },
  {
    names: ECONOMY_COMMAND_NAMES,
    run: economyCommand,
    describeError: failedWith('that economy command'),
    // One handler for every currency command, dispatching on the name used.
    routeArgs: (invokedAs, args) => [invokedAs, ...args],
    feature: 'economy',
  },
  {
    names: ['birthday', 'birthdays', 'bday'],
    run: birthdayCommand,
    describeError: failedWith('the birthday command'),
    feature: 'birthdays',
  },
  {
    names: ['dashboard', 'dash', 'editors', 'panel'],
    run: dashboardCommand,
    describeError: (error: any) => `❌ An error occurred while opening the dashboard: ${error?.message || error}`,
    feature: 'dashboard',
  },
];

/** Alias → entry, built once at module load. */
const COMMANDS = new Map<string, CommandEntry & { label: string }>();
for (const entry of COMMAND_LIST) {
  const withLabel = { ...entry, label: entry.names[0] };
  for (const name of entry.names) COMMANDS.set(name, withLabel);
}

// Tags resolve after built-ins, so a tag sharing a built-in's name could never
// run; the tag store refuses those names.
setBuiltinCommandNames([...COMMANDS.keys(), 'ticket']);

/**
 * Handle incoming messages and route to commands
 * @param {Object} message - Message object from stoatbot.js
 * @param {Object} client - Stoat client
 */
export async function handleCommand(message, client) {
  // Ignore bot messages
  if (message.author?.bot) return;

  const content = message.content;
  if (!content || !content.startsWith(config.prefix)) return;

  // Parse command
  const args = content.slice(config.prefix.length).trim().split(/\s+/);
  const commandName = args.shift()?.toLowerCase();

  if (!commandName) return;

  // Handle ticket command
  if (commandName === 'ticket') {
    const subcommand = args.shift()?.toLowerCase();

    if (!subcommand || !ticketSubcommands[subcommand]) {
      // Show help if no valid subcommand
      await ticketHelp(message, args, client);
      return;
    }

    noteCommandUse(message, `ticket ${subcommand}`);

    try {
      const feature = TICKET_FEATURES[subcommand];
      if (!(await isFeatureAllowed(message, client, feature))) return;
      await runFeature(message, feature, () => ticketSubcommands[subcommand](message, args, client));
    } catch (error) {
      console.error(`Error executing ticket ${subcommand}:`, error);
      await message.channel?.send({
        content: `❌ An error occurred while executing that command. Please try again later.`,
      });
    }
    return;
  }

  const command = COMMANDS.get(commandName);

  // Not a built-in: it may be one of this server's tags. Tags resolve last so a
  // tag can never shadow a real command.
  if (!command) {
    await tryTag(message, commandName, args, client);
    return;
  }

  noteCommandUse(message, command.label);

  try {
    // A switched-off module answers before any role lookup: it costs nothing.
    const offModule = disabledModuleForFeature(command.feature);
    if (offModule) {
      await message.channel?.send({ content: moduleOffMessage(offModule) });
      return;
    }
    if (!(await isFeatureAllowed(message, client, command.feature))) return;
    const routedArgs = command.routeArgs ? command.routeArgs(commandName, args) : args;
    await runFeature(message, command.feature, () => command.run(message, routedArgs, client));
  } catch (error) {
    console.error(`Error executing ${command.label} command:`, error);
    await message.channel?.send({ content: command.describeError(error) });
  }
}

/** Answer with a server tag, if one goes by this name. */
async function tryTag(message, commandName: string, args: string[], client) {
  // With the Tags module off an unknown command is just unknown.
  if (!isModuleEnabled('tags')) return;
  try {
    // Check the name against the server's tags before anything else: an unknown
    // command is the common case, and it must not cost a member-role lookup.
    const serverId = messageServerId(message);
    // Normalized the same way the store is, so `!rules!` still finds `rules`.
    const wanted = normalizeTagName(commandName);
    if (!serverId || !wanted || !tagNamesFor(serverId).has(wanted)) return;
    if (!(await isFeatureAllowed(message, client, 'tags'))) return;
    const result = await runWithBotPermission('tags', String(message?.authorId || ''), () =>
      runTag(message, commandName, args, client),
    );
    if (result.status === 'sent') noteCommandUse(message, `tag:${commandName}`);
    else if (result.status === 'denied') await message.channel?.send({ content: `❌ ${result.reason}` });
  } catch (error) {
    console.error(`Error running tag ${commandName}:`, error);
  }
}

/** Feed the analytics and health counters. Never throws. */
function noteCommandUse(message, label: string) {
  try {
    recordHealthCommand(label);
    const serverId = messageServerId(message);
    if (serverId && isModuleEnabled('analytics')) recordCommandUse(serverId, label);
  } catch {
    // Counters are best-effort.
  }
}

/**
 * The server a message was sent in, or '' for a DM.
 *
 * `message.serverId` is a getter that reads `message.channel` and throws when
 * the channel is not cached, so the cached channel is read first and the getter
 * itself is guarded — a lookup failure must not turn a command into an error.
 */
function messageServerId(message): string {
  try {
    return String(message?.channel?.serverId || message?.serverId || '');
  } catch {
    return '';
  }
}

/** Refuse, with a reply, a command whose feature the author's roles deny in this server. */
async function isFeatureAllowed(message, client, feature: string | undefined): Promise<boolean> {
  const serverId = messageServerId(message);
  if (!feature || !serverId) return true;
  if ((await resolveBotPermission(client, serverId, message.authorId, feature)) !== 'deny') return true;
  await message.channel?.send({ content: '❌ Your roles are not allowed to use this command in this server.' });
  return false;
}

/** Run a command inside its feature's context so the permission helpers honor an allow. */
function runFeature(message, feature: string | undefined, run: () => unknown) {
  if (!feature || !message?.authorId) return run();
  return runWithBotPermission(feature, String(message.authorId), run);
}

function formatBackupError(error) {
  const detail = error?.message || String(error || 'Unknown error');
  const hint = /403|forbidden|notelevated/i.test(detail)
    ? '\n\nStoat rejected the action with 403 Forbidden. In the target server, give the bot role Manage Channels, Manage Roles, Manage Permissions, and Manage Server, and place the bot role above roles it must create/edit.'
    : '';
  const text = `Backup command failed:\n\`\`\`\n${detail.slice(0, 1500)}\n\`\`\`${hint}`;
  return text.length > 1900 ? `${text.slice(0, 1890)}...` : text;
}
