import { client as Client } from 'stoatbot.js';
import { config, validateConfig } from './config.js';
import { handleCommand } from './commands/index.js';
import { handleTicketPanelReaction, TICKET_PANEL_EMOJI } from './commands/ticket-panel.js';
import { handleReactionRoleAdd, handleReactionRoleRemove } from './reaction-roles.js';
import { scheduleJoinRolesForMember } from './join-roles.js';
import { scheduleWelcomeForMember } from './welcome.js';
import { handleCaptchaReaction, handleCaptchaDM, scheduleCaptchaForMember } from './captcha.js';
import {
  diffMemberRoles,
  getLogConfig,
  logChannelCreate,
  logChannelDelete,
  logChannelUpdate,
  logMemberJoin,
  logMemberLeave,
  logMemberProfileUpdate,
  logMemberUpdate,
  logMessageDelete,
  logMessageUpdate,
  logRoleCreate,
  logRoleDelete,
  logRoleUpdate,
  logServerUpdate,
  logUserUpdate,
} from './log-system.js';
import { getStatsChannels, refreshAllStatsChannels } from './stats.js';
import { startNotificationScheduler, stopNotificationScheduler } from './notifications/index.js';
import { isNotificationSchedulerRunning } from './notifications/scheduler.js';
import { startFreeStuffScheduler, stopFreeStuffScheduler } from './giveaways/index.js';
import { isFreeStuffSchedulerRunning } from './giveaways/scheduler.js';
import { closeBrowser } from './notifications/browser.js';
import { stopDashboard } from './dashboard.js';
import { forgetMemberRoles, removeBotPermissionRole } from './bot-permissions.js';
import {
  mirrorMessageToLinks,
  mirrorMessageEdit,
  mirrorMessageDelete,
  mirrorBulkMessageDelete,
  catchUpSyncLinks,
  flushSyncNow,
} from './sync.js';
import { recordMessage } from './activity.js';
import { recordMessageXp } from './leveling.js';
import { handleAutoResponder } from './autoresponder.js';
import { handleAutoReact } from './autoreact.js';
import { handleAntiraidJoin, handleHoneypotMessage, wasDeletedByHoneypot } from './antiraid.js';
import { isReminderSchedulerRunning, startReminderScheduler, stopReminderScheduler } from './reminders.js';
import { handleAutomodMessage } from './automod.js';
import { isModerationSchedulerRunning, startModerationScheduler, stopModerationScheduler } from './moderation.js';
import {
  handlePollReaction,
  handlePollUnreaction,
  isPollSchedulerRunning,
  startPollScheduler,
  stopPollScheduler,
} from './polls.js';
import {
  handleGiveawayReaction,
  handleGiveawayUnreaction,
  isGiveawaySchedulerRunning,
  startGiveawayScheduler,
  stopGiveawayScheduler,
} from './hosted-giveaways.js';
import {
  handleTempVoicePacket,
  isTempVoiceSweeperRunning,
  startTempVoiceSweeper,
  stopTempVoiceSweeper,
} from './tempvoice.js';
import { isBirthdaySchedulerRunning, startBirthdayScheduler, stopBirthdayScheduler } from './birthdays.js';
import { recordMessageEarning } from './economy.js';
import {
  recordAnalyticsMessage,
  recordAnalyticsVoicePacket,
  recordMemberJoin,
  recordMemberLeave,
} from './analytics.js';
import { closeDb } from './db.js';
import { recordError as recordHealthError, recordEvent as recordHealthEvent, recordReconnect, registerScheduler } from './health.js';
import { debug } from './logger.js';
import { getMemberIds } from './member-utils.js';
import { handleVoicePacket } from './music/voice-state.js';
import { handleMusicPanelReaction, handleMusicSearchReply, shutdownMusic, startMusicBackground } from './music/lazy.js';
import { isModuleEnabled, onModuleChange } from './modules.js';

/**
 * Stoat Ticket Bot
 * A complete ticket system for Stoat servers
 */

// ASCII art banner
const banner = createBanner(config.botName);

console.log(banner);

function createBanner(botName: string) {
  const title = `🤖 ${botName} BOT 🤖`;
  const width = Math.max(43, title.length + 2);
  const padding = Math.max(0, width - title.length);
  const left = Math.floor(padding / 2);
  const right = padding - left;

  return `
╔${'═'.repeat(width)}╗
║${' '.repeat(left)}${title}${' '.repeat(right)}║
╚${'═'.repeat(width)}╝
`;
}

// Validate configuration
try {
  validateConfig();
  console.log('✅ Configuration validated successfully');
} catch (error) {
  console.error('❌ Configuration Error:', error.message);
  process.exit(1);
}

// Create Stoat client
const client = new Client();

let lastClientErrorSummary = '';
let lastClientErrorAt = 0;
let suppressedDuplicateErrors = 0;
let lastUnhandledWsRetryAt = 0;
let wsRecoveryTimer: NodeJS.Timeout | null = null;
let wsRecoveryAttempts = 0;
let pendingStatsRefreshTimeout: NodeJS.Timeout | null = null;
const lastNativeMemberUpdateAt = new Map<string, number>();
const lastNativeUserUpdateAt = new Map<string, number>();
const memberSnapshotCache = new Map<string, MemberSnapshot>();
const userSnapshotCache = new Map<string, UserSnapshot>();

type MemberSnapshot = {
  serverId: string;
  userId: string;
  nickname: string;
  avatarId: string | null;
  roleIds: string[];
};

type UserSnapshot = {
  userId: string;
  username: string;
  displayName: string;
  avatarId: string | null;
};

// `ready` fires on the initial connect AND on every websocket reconnect.
// Heavy one-time setup (banner, scheduler start, cache priming) must run once;
// only lightweight resync work should repeat on reconnect.
let hasCompletedFirstReady = false;

// Ready event
client.on('ready', async () => {
  wsRecoveryAttempts = 0;
  if (wsRecoveryTimer) {
    clearTimeout(wsRecoveryTimer);
    wsRecoveryTimer = null;
  }

  // Reconnect path: schedulers are already running and caches are primed.
  // Re-running that work would double-start intervals and re-fetch every
  // member on each gateway flap. Just resync the state that can drift while
  // offline (stats counters, missed synced messages).
  if (hasCompletedFirstReady) {
    recordReconnect();
    console.log(`\n🔁 Reconnected as ${client.user?.username}. Resyncing…`);
    if (isModuleEnabled('stats')) {
      try {
        await refreshAllStatsChannels(client);
      } catch (error) {
        console.warn('⚠️ Reconnect stats refresh failed:', error?.message || error);
      }
    }
    if (isModuleEnabled('sync')) await runSyncCatchUp();
    return;
  }
  hasCompletedFirstReady = true;

  console.log(`\n✅ Logged in as ${client.user?.username}!`);
  console.log(`📊 Connected to ${client.servers.cache.size} servers`);
  console.log(`🔧 Command prefix: ${config.prefix}`);
  console.log(`\n📋 Available commands:`);
  console.log(`   ${config.prefix}ping - Latency + host hardware status (CPU/RAM/uptime)`);
  console.log(`   ${config.prefix}ticket open [reason] - Open a new ticket`);
  console.log(`   ${config.prefix}ticket panel - Send a ticket panel embed`);
  console.log(`   ${config.prefix}ticket close - Close the current ticket`);
  console.log(`   ${config.prefix}ticket claim [@user|clear] - Claim/assign the current ticket (staff)`);
  console.log(`   ${config.prefix}ticket priority [level] - View/set ticket priority (staff)`);
  console.log(`   ${config.prefix}ticket delete - Delete ticket channel + DB entry (with transcript)`);
  console.log(`   ${config.prefix}ticket transcript - Generate ticket transcript`);
  console.log(`   ${config.prefix}ticket help - Show help message`);
  console.log(`   ${config.prefix}stats ... - Configure and refresh stats channels`);
  console.log(`   ${config.prefix}roles editor - Open the role editor site`);
  console.log(`   ${config.prefix}roles ... - Manage roles, role gradients, and reaction roles`);
  console.log(`   ${config.prefix}joinrole ... - Auto-assign roles to new members`);
  console.log(`   ${config.prefix}welcome ... - Configure personalized welcome images/messages`);
  console.log(`   ${config.prefix}embed editor - Open the custom embed creator site`);
  console.log(`   ${config.prefix}logs ... - Configure server modification logs`);
  console.log(`   ${config.prefix}purge ... - Purge / mass-eliminate messages`);
  console.log(`   ${config.prefix}perms ... - Mass clone channel permissions`);
  console.log(`   ${config.prefix}backup ... - Export/import server structure and bot feature data`);
  console.log(`   ${config.prefix}sync ... - Copy or live-mirror channel content across channels/servers`);
  console.log(`   ${config.prefix}autoresponder ... - Keyword-triggered auto replies`);
  console.log(`   ${config.prefix}autoreact ... - Automatic emoji reactions on matching messages`);
  console.log(`   ${config.prefix}antiraid ... - Raid protection: join-flood detection + account-age gate + honeypot channel`);
  console.log(`   ${config.prefix}reminder ... - Scheduled/recurring messages (interval, weekly, monthly, date)`);
  console.log(`   ${config.prefix}level ... - Leveling, leaderboard, and level-based auto-add roles`);
  console.log(`   ${config.prefix}rank / ${config.prefix}leaderboard - Show rank card / top members`);
  console.log(`   ${config.prefix}warn / mute / kick / ban ... - Moderation cases with history and escalation`);
  console.log(`   ${config.prefix}automod ... - Content filters (words, invites, spam, caps, mentions)`);
  console.log(`   ${config.prefix}poll ... - Reaction polls with optional auto-close`);
  console.log(`   ${config.prefix}giveaway ... - Host giveaways with entry requirements and rerolls`);
  console.log(`   ${config.prefix}tag ... - Server-defined custom commands`);
  console.log(`   ${config.prefix}balance / daily / shop ... - Economy currency and shop`);
  console.log(`   ${config.prefix}birthday ... - Birthday registry and announcements`);
  console.log(`   ${config.prefix}vc ... - Temporary voice rooms`);
  console.log(`   ${config.prefix}play <song|link> - Music in voice channels (${config.prefix}help music for queue/skip/loop/volume/lyrics)`);

  await logCategoryDiagnostics(client);

  // Lifting timed mutes and bans is not a module: automod hands out timed
  // punishments too, and a ban must still end on time after Moderation is
  // switched off. The check is an in-memory scan every 30 seconds.
  try {
    startModerationScheduler(client);
  } catch (error) {
    console.warn('⚠️ Moderation scheduler failed to start:', error?.message || error);
  }

  // Start every switched-on module's background work: schedulers, the stats
  // refresh, member snapshots for logging, music upkeep, sync catch-up. A
  // switched-off module starts nothing; flipping it later starts it then.
  for (const key of Object.keys(MODULE_LIFECYCLE)) {
    if (isModuleEnabled(key)) await startModule(key);
  }

  registerSchedulersForHealth();

  console.log('\n🎫 Ticket bot is ready to receive commands!\n');
});

type ModuleLifecycle = {
  start?: () => unknown;
  stop?: () => unknown;
};

/**
 * Background work per module (see modules.ts). Modules not listed here only
 * handle events and commands, which check `isModuleEnabled` as they arrive.
 * Every start is safe to call twice, and every stop leaves the module able to
 * start again.
 */
const MODULE_LIFECYCLE: Record<string, ModuleLifecycle> = {
  // Member snapshots let both detect role changes the native event missed.
  stats: {
    start: async () => {
      await startStatsRefresh();
      await primeSnapshotCaches();
    },
    stop: () => {
      stopStatsRefresh();
      pruneSnapshotCaches();
    },
  },
  logs: { start: primeSnapshotCaches, stop: pruneSnapshotCaches },
  notify: {
    start: () => startNotificationScheduler(client),
    stop: async () => {
      stopNotificationScheduler();
      await closeBrowser();
    },
  },
  freestuff: { start: () => startFreeStuffScheduler(client), stop: stopFreeStuffScheduler },
  reminders: { start: () => startReminderScheduler(client), stop: stopReminderScheduler },
  polls: { start: () => startPollScheduler(client), stop: stopPollScheduler },
  giveaways: { start: () => startGiveawayScheduler(client), stop: stopGiveawayScheduler },
  birthdays: { start: () => startBirthdayScheduler(client), stop: stopBirthdayScheduler },
  tempvoice: { start: () => startTempVoiceSweeper(client), stop: stopTempVoiceSweeper },
  // Imports the music stack in the background and keeps yt-dlp current, so the
  // first `play` is quick. Switched off, none of it is ever loaded. Not awaited:
  // the import takes seconds and must not hold up the rest of startup.
  music: {
    start: () => {
      startMusicBackground().catch((error) => console.warn('⚠️ Music background setup failed:', error?.message || error));
    },
    stop: shutdownMusic,
  },
  // Replay messages posted in synced channels while the bot was offline.
  sync: { start: runSyncCatchUp, stop: flushSyncNow },
};

async function startModule(key: string) {
  try {
    await MODULE_LIFECYCLE[key]?.start?.();
  } catch (error) {
    console.warn(`⚠️ Module ${key} failed to start:`, error?.message || error);
  }
}

async function stopModule(key: string) {
  try {
    await MODULE_LIFECYCLE[key]?.stop?.();
  } catch (error) {
    console.warn(`⚠️ Module ${key} failed to stop:`, error?.message || error);
  }
}

// Switched from the dashboard at runtime. Before the first Ready there is no
// client to start anything with; Ready starts whatever is on by then.
onModuleChange((key, enabled) => {
  console.log(`🧩 Module ${key} switched ${enabled ? 'on' : 'off'}.`);
  if (!hasCompletedFirstReady) return;
  void (enabled ? startModule(key) : stopModule(key));
});

/**
 * Tell the health panel which background loops exist, and how to ask each one
 * whether it is actually armed — so "scheduler running" reflects the timer, not
 * the fact that `start…` was called once at boot. A switched-off module's loop
 * is reported as off rather than as stopped.
 */
function registerSchedulersForHealth() {
  const enabled = (key: string) => () => isModuleEnabled(key);
  registerScheduler('notifications', isNotificationSchedulerRunning, enabled('notify'));
  registerScheduler('free stuff', isFreeStuffSchedulerRunning, enabled('freestuff'));
  registerScheduler('reminders', isReminderSchedulerRunning, enabled('reminders'));
  registerScheduler('moderation expiry', isModerationSchedulerRunning);
  registerScheduler('polls', isPollSchedulerRunning, enabled('polls'));
  registerScheduler('giveaways', isGiveawaySchedulerRunning, enabled('giveaways'));
  registerScheduler('birthdays', isBirthdaySchedulerRunning, enabled('birthdays'));
  registerScheduler('temp voice sweeper', isTempVoiceSweeperRunning, enabled('tempvoice'));
  registerScheduler('stats refresh', () => statsRefreshTimer !== null, enabled('stats'));
}

// 'ready' fires on every reconnect; guard against overlapping catch-up runs.
let syncCatchUpRunning = false;
async function runSyncCatchUp() {
  if (syncCatchUpRunning) return;
  syncCatchUpRunning = true;
  try {
    const result = await catchUpSyncLinks(client);
    if (result.replayed > 0) {
      console.log(`🔁 Channel sync catch-up: replayed ${result.replayed} missed message(s) across ${result.links} link(s).`);
    }
  } catch (error) {
    console.warn('⚠️ Channel sync catch-up failed:', error?.message || error);
  } finally {
    syncCatchUpRunning = false;
  }
}

// Stats channels (member counters): refreshed on start, every 5 minutes, and
// shortly after joins, leaves and tracked role changes.
let statsRefreshTimer: NodeJS.Timeout | null = null;

async function startStatsRefresh() {
  if (!statsRefreshTimer) {
    statsRefreshTimer = setInterval(async () => {
      try {
        await refreshAllStatsChannels(client);
      } catch (error) {
        console.warn('⚠️ Periodic stats refresh failed:', error?.message || error);
      }
    }, 5 * 60 * 1000);
  }

  try {
    const statsSummary = await refreshAllStatsChannels(client);
    if (statsSummary.configured > 0) {
      console.log(
        `📊 Stats channels refreshed: configured=${statsSummary.configured}, updated=${statsSummary.updated}, skipped=${statsSummary.skipped}`
      );
    }
  } catch (error) {
    console.warn('⚠️ Initial stats channel refresh failed:', error?.message || error);
  }
}

function stopStatsRefresh() {
  if (statsRefreshTimer) clearInterval(statsRefreshTimer);
  statsRefreshTimer = null;
  if (pendingStatsRefreshTimeout) clearTimeout(pendingStatsRefreshTimeout);
  pendingStatsRefreshTimeout = null;
}

function scheduleStatsRefresh(reason = 'unknown') {
  if (!config.serverId || !isModuleEnabled('stats')) return;

  if (pendingStatsRefreshTimeout) {
    clearTimeout(pendingStatsRefreshTimeout);
  }

  pendingStatsRefreshTimeout = setTimeout(async () => {
    pendingStatsRefreshTimeout = null;

    try {
      const summary = await refreshAllStatsChannels(client);
      if (summary.configured > 0) {
        console.log(`📊 Stats refreshed (${reason}): updated=${summary.updated}, skipped=${summary.skipped}`);
      }
    } catch (error) {
      console.warn('⚠️ Event-driven stats refresh failed:', error?.message || error);
    }
  }, 2500);
}

// Message event. Each feature step runs only while its module is switched on
// (modules.ts); a switched-off module costs one map lookup per message.
client.on('message', async (message) => {
  // Captcha verification replies arrive in the bot's DMs. Handle first and stop
  // so DM traffic never falls through to command/activity handling.
  if (isModuleEnabled('captcha')) {
    try {
      if (await handleCaptchaDM(client, message)) return;
    } catch (error) {
      console.error('Error handling captcha DM:', error);
    }
  }

  // Antiraid honeypot: a trapped message is deleted and its author actioned, so
  // it must not count toward activity/XP or reach commands and mirrors.
  if (isModuleEnabled('antiraid') && (await handleHoneypotMessage(client, message))) return;

  // Automod runs before anything else reads the message: a filtered message is
  // deleted, so it must not earn XP, mirror to a synced channel, or run a
  // command. A rule that only logs (no delete) returns false and falls through.
  if (isModuleEnabled('automod')) {
    try {
      if (await handleAutomodMessage(client, message)) return;
    } catch (error) {
      console.error('Error running automod:', error);
    }
  }

  if (isModuleEnabled('analytics')) {
    // Count activity (messages / images) for the dashboard Overview. Best-effort
    // and content-free — never blocks or breaks command handling.
    recordMessage(client, message);

    // Per-channel / per-hour counters for the Analytics tab.
    recordAnalyticsMessage(client, message);
  }

  // Award leveling XP (best-effort, content-free, handles level-up + role rewards).
  if (isModuleEnabled('leveling')) recordMessageXp(client, message);

  // Award economy currency (separate from XP: coins are spendable, XP is rank).
  if (isModuleEnabled('economy')) recordMessageEarning(client, message);

  // A bare number answering a pending music `search` picks that result.
  if (isModuleEnabled('music')) {
    try {
      await handleMusicSearchReply(message, client);
    } catch (error) {
      console.error('Error handling music search reply:', error);
    }
  }

  try {
    await handleCommand(message, client);
  } catch (error) {
    console.error('Error handling message:', error);
  }

  // Mirror new messages into any linked channels (live channel sync).
  if (isModuleEnabled('sync')) {
    try {
      await mirrorMessageToLinks(client, message);
    } catch (error) {
      console.error('Error mirroring message to sync links:', error);
    }
  }

  // Auto-responder + auto-react (best-effort, never block command handling).
  if (isModuleEnabled('autoresponder')) {
    try {
      await handleAutoResponder(client, message);
    } catch (error) {
      console.error('Error running auto-responder:', error);
    }
  }

  if (isModuleEnabled('autoreact')) {
    try {
      await handleAutoReact(client, message);
    } catch (error) {
      console.error('Error running auto-react:', error);
    }
  }
});

// Raw packet events: reactions (stoatbot emits messageReact/messageUnreact
// without user/emoji args) plus message edits/deletes for channel sync.
client.on('raw', async (packet: any) => {
  try {
    if (!packet || typeof packet !== 'object') return;

    recordHealthEvent(String(packet.type || 'unknown'));

    // Who sits in which voice channel, for the music commands. Kept even with
    // the Music module off: it is cheap, and music needs it the moment it is on.
    handleVoicePacket(packet);
    // The same packets drive temporary-room occupancy and voice-time analytics.
    if (isModuleEnabled('tempvoice')) handleTempVoicePacket(client, packet);
    if (isModuleEnabled('analytics')) recordAnalyticsVoicePacket(client, packet);

    if (packet.type === 'MessageReact') {
      const reaction = {
        client,
        messageId: getRawMessageId(packet),
        userId: getRawUserId(packet),
        emoji: getRawEmoji(packet),
      };

      // Captcha reaction trigger takes priority over reaction roles so the role
      // is gated behind verification rather than granted on the raw react.
      if (isModuleEnabled('captcha') && (await handleCaptchaReaction(reaction))) return;
      if (isModuleEnabled('music') && (await handleMusicPanelReaction(reaction))) return;
      if (isModuleEnabled('polls') && (await handlePollReaction(reaction))) return;
      if (isModuleEnabled('giveaways') && (await handleGiveawayReaction(reaction))) return;

      if (isModuleEnabled('reactionroles') && (await handleReactionRoleAdd(reaction))) {
        scheduleStatsRefresh('reaction role add');
        return;
      }

      // Only a ticket-panel reaction is left to handle. Checking the emoji first
      // spares a message fetch (a REST call on a cache miss) for every other
      // reaction anywhere in the server.
      if (reaction.emoji !== TICKET_PANEL_EMOJI) return;

      const message = await resolveMessageFromRawPacket(packet);
      if (!message) return;

      await handleTicketPanelReaction({
        client,
        message,
        userId: reaction.userId,
        emoji: reaction.emoji,
      });
      return;
    }

    if (packet.type === 'MessageUnreact') {
      const reaction = {
        client,
        messageId: getRawMessageId(packet),
        userId: getRawUserId(packet),
        emoji: getRawEmoji(packet),
      };

      if (isModuleEnabled('polls') && (await handlePollUnreaction(reaction))) return;
      if (isModuleEnabled('giveaways') && (await handleGiveawayUnreaction(reaction))) return;

      if (isModuleEnabled('reactionroles') && (await handleReactionRoleRemove(reaction))) {
        scheduleStatsRefresh('reaction role remove');
      }

      return;
    }

    // Channel sync follows edits and deletes off the raw packets rather than the
    // client's messageUpdate/messageDelete events: those only fire for messages
    // still in the channel cache, so an edit to anything older than this session
    // would never reach the mirror.
    if (packet.type === 'MessageUpdate') {
      if (isModuleEnabled('sync')) await mirrorMessageEdit(client, packet.channel, getRawMessageId(packet), packet.data);
      return;
    }

    if (packet.type === 'MessageDelete') {
      if (isModuleEnabled('sync')) await mirrorMessageDelete(client, packet.channel, getRawMessageId(packet));
      return;
    }

    if (packet.type === 'BulkMessageDelete') {
      if (isModuleEnabled('sync')) await mirrorBulkMessageDelete(client, packet.channel, packet.ids);
      return;
    }

    if (packet.type === 'ServerMemberUpdate') {
      scheduleRawMemberUpdateFallback(packet);
      return;
    }

    if (packet.type === 'UserUpdate') {
      scheduleRawUserUpdateFallback(packet);
    }
  } catch (error) {
    console.error('Error handling raw packet:', error);
  }
});

function getRawMessageId(packet: any) {
  return packet?.id || packet?.message_id || packet?.messageId || packet?.message;
}

function getRawUserId(packet: any) {
  return packet?.user_id || packet?.userId || packet?.user;
}

function getRawEmoji(packet: any) {
  return packet?.emoji_id || packet?.emojiId || packet?.emoji;
}

// Refresh stats for joins/leaves (role updates handled below when role diff is detected)

client.on('serverMemberJoin', () => {
  scheduleStatsRefresh('serverMemberJoin');
});

client.on('serverMemberLeave', () => {
  scheduleStatsRefresh('serverMemberLeave');
});

/**
 * Server log listeners (exclude message create logs). All of them stand down
 * while the Logs module is off.
 */
client.on('messageUpdate', async (oldMessage, newMessage) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logMessageUpdate(client, oldMessage, newMessage);
  } catch (error) {
    console.error('Error logging message update:', error);
  }
});

client.on('messageDelete', async (message) => {
  if (!isModuleEnabled('logs')) return;
  try {
    // Honeypot deletions are reported in one batched antiraid alert instead.
    if (wasDeletedByHoneypot(message?.id)) return;
    await logMessageDelete(client, message);
  } catch (error) {
    console.error('Error logging message delete:', error);
  }
});

client.on('channelCreate', async (channel) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logChannelCreate(client, channel);
  } catch (error) {
    console.error('Error logging channel create:', error);
  }
});

client.on('channelDelete', async (channel) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logChannelDelete(client, channel);
  } catch (error) {
    console.error('Error logging channel delete:', error);
  }
});

client.on('channelUpdate', async (oldChannel, newChannel) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logChannelUpdate(client, oldChannel, newChannel);
  } catch (error) {
    console.error('Error logging channel update:', error);
  }
});

client.on('serverMemberJoin', async (member) => {
  try {
    if (isModuleEnabled('analytics')) recordMemberJoin(String(member?.serverId || ''));
    // Run antiraid first so raiders are removed before welcomes/join roles fire.
    if (isModuleEnabled('antiraid')) await handleAntiraidJoin(client, member);
    if (isModuleEnabled('joinroles')) scheduleJoinRolesForMember(client, member);
    if (isModuleEnabled('welcome')) scheduleWelcomeForMember(client, member);
    if (isModuleEnabled('captcha')) scheduleCaptchaForMember(client, member);
    cacheMemberSnapshot(member);
    if (isModuleEnabled('logs')) await logMemberJoin(client, member);
  } catch (error) {
    console.error('Error logging member join:', error);
  }
});

client.on('serverMemberLeave', async (member) => {
  try {
    if (isModuleEnabled('analytics')) recordMemberLeave(String(member?.serverId || ''));
    removeMemberSnapshot(member);
    if (isModuleEnabled('logs')) await logMemberLeave(client, member);
  } catch (error) {
    console.error('Error logging member leave:', error);
  }
});

client.on('serverMemberUpdate', async (previousMember, member) => {
  try {
    // Always: it also drops the member's memoized roles for bot permissions.
    markNativeMemberUpdate(member, previousMember);

    const logsOn = isModuleEnabled('logs');
    if (!logsOn && !isModuleEnabled('stats')) return;

    // Stats channels only need the role change itself, not a log entry.
    const roleResult = logsOn
      ? await logMemberUpdate(client, previousMember, member)
      : diffMemberRoles(previousMember, member);
    if (logsOn) await logMemberProfileUpdate(client, previousMember, member);

    cacheMemberSnapshot(member);

    if (shouldRefreshStatsForRoleChange(roleResult)) {
      scheduleStatsRefresh('Member Roles Updated (tracked role)');
    }
  } catch (error) {
    console.error('Error logging member update:', error);
  }
});

client.on('userUpdate', async (previousUser, user) => {
  try {
    markNativeUserUpdate(user, previousUser);
    if (!isModuleEnabled('logs')) return;

    await logUserUpdate(client, previousUser, user);

    cacheUserSnapshot(user);
  } catch (error) {
    console.error('Error logging user update:', error);
  }
});

client.on('roleCreate', async (role) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logRoleCreate(client, role);
  } catch (error) {
    console.error('Error logging role create:', error);
  }
});

client.on('roleUpdate', async (oldRole, role) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logRoleUpdate(client, oldRole, role);
  } catch (error) {
    console.error('Error logging role update:', error);
  }
});

client.on('roleDelete', async (role) => {
  try {
    // Drop the deleted role's bot permissions, the same way the dashboard does
    // when a role is deleted from the Roles tab.
    const roleServerId = (role as any)?.serverId || (role as any)?.server?.id || config.serverId;
    const roleId = (role as any)?.id || (role as any)?._id;
    if (roleServerId && roleId) removeBotPermissionRole(String(roleServerId), String(roleId));
  } catch (error) {
    console.error('Error clearing bot permissions for deleted role:', error);
  }

  if (!isModuleEnabled('logs')) return;
  try {
    await logRoleDelete(client, role);
  } catch (error) {
    console.error('Error logging role delete:', error);
  }
});

client.on('serverUpdate', async (oldServer, newServer) => {
  if (!isModuleEnabled('logs')) return;
  try {
    await logServerUpdate(client, oldServer, newServer);
  } catch (error) {
    console.error('Error logging server update:', error);
  }
});

// Error handling
client.on('error', (error) => {
  const summary = formatClientError(error);
  const now = Date.now();

  // Counted before the duplicate-suppression below, so the health panel still
  // shows a flapping error's real rate while the console stays readable.
  recordHealthError(summary);

  // Prevent log spam when websocket repeatedly fails with the same generic ErrorEvent
  if (summary === lastClientErrorSummary && now - lastClientErrorAt < 15000) {
    suppressedDuplicateErrors += 1;
    return;
  }

  if (suppressedDuplicateErrors > 0) {
    console.warn(`⚠️ Suppressed ${suppressedDuplicateErrors} duplicate client error(s).`);
    suppressedDuplicateErrors = 0;
  }

  lastClientErrorSummary = summary;
  lastClientErrorAt = now;

  console.error(`❌ Client error: ${summary}`);

});

// Graceful shutdown — close HTTP editors, drain in-flight work, then logout.
// A 6-second timeout forces exit if something hangs.
let shuttingDown = false;
async function gracefulShutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n👋 Received ${signal}, shutting down gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.warn('⚠️ Graceful shutdown timed out after 6s, forcing exit.');
    process.exit(1);
  }, 6000);
  forceExitTimer.unref?.();

  try {
    flushSyncNow();
    stopStatsRefresh();
    stopDashboard();
    stopNotificationScheduler();
    stopReminderScheduler();
    stopFreeStuffScheduler();
    stopModerationScheduler();
    stopPollScheduler();
    stopGiveawayScheduler();
    stopBirthdayScheduler();
    stopTempVoiceSweeper();
    await closeBrowser();
  } catch (error) {
    console.warn('⚠️ Error closing editor servers:', error?.message || error);
  }

  try {
    await shutdownMusic();
  } catch (error) {
    console.warn('⚠️ Error leaving voice channels:', error?.message || error);
  }

  try {
    if (typeof (client as any)?.logout === 'function') {
      await (client as any).logout();
      console.log('✅ Logged out from Stoat.');
    }
  } catch (error) {
    console.warn('⚠️ Error during logout:', error?.message || error);
  }

  // Everything in SQLite is already committed; closing just checkpoints the WAL.
  try {
    closeDb();
  } catch (error) {
    console.warn('⚠️ Error closing the database:', error?.message || error);
  }

  clearTimeout(forceExitTimer);
  process.exit(0);
}

process.on('SIGINT', () => { void gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { void gracefulShutdown('SIGTERM'); });

// Unhandled rejection handler
process.on('unhandledRejection', (reason, promise) => {
  if (isStoatWebSocketRetryExhausted(reason)) {
    const now = Date.now();
    if (now - lastUnhandledWsRetryAt > 60_000) {
      console.warn(
        '⚠️ Stoat websocket retry limit reached. The gateway may be temporarily unavailable, ' +
        'your network may be offline, or the token/session may have been interrupted. ' +
        'stoatbot.js already retried; scheduling a guarded reconnect.'
      );
      lastUnhandledWsRetryAt = now;
    }
    scheduleWebSocketRecovery();
    return;
  }

  console.error('Unhandled Rejection:', formatUnhandledReason(reason));
  if (process.env.DEBUG_UNHANDLED_REJECTIONS === '1') {
    console.error('Unhandled Rejection promise:', promise);
  }
});

// Login to Stoat
console.log('🔄 Starting bot...');
client.login(config.botToken).catch((error) => {
  console.error('❌ Failed to login:', error.message);
  process.exit(1);
});

function scheduleWebSocketRecovery() {
  if (wsRecoveryTimer) return;

  wsRecoveryAttempts += 1;
  const delayMs = Math.min(5 * 60_000, 15_000 * wsRecoveryAttempts);
  console.warn(`🔁 Scheduling Stoat websocket recovery attempt ${wsRecoveryAttempts} in ${Math.round(delayMs / 1000)}s.`);

  wsRecoveryTimer = setTimeout(() => {
    wsRecoveryTimer = null;
    recoverWebSocketConnection().catch((error) => {
      console.warn(`⚠️ Stoat websocket recovery attempt ${wsRecoveryAttempts} failed: ${formatUnhandledReason(error)}`);
      scheduleWebSocketRecovery();
    });
  }, delayMs);
}

async function recoverWebSocketConnection() {
  const ws = (client as any)?.ws;
  if (!ws || typeof ws !== 'object') {
    throw new Error('Client websocket object is unavailable.');
  }

  if (typeof client.isReady === 'function' && client.isReady() && ws.connected && ws.ready) {
    wsRecoveryAttempts = 0;
    return;
  }

  console.warn(`🔁 Attempting Stoat websocket recovery attempt ${wsRecoveryAttempts}.`);

  if (typeof ws.destroy === 'function') {
    await ws.destroy(true).catch((error: unknown) => {
      console.warn(`⚠️ Could not destroy stale websocket before recovery: ${formatUnhandledReason(error)}`);
    });
  }

  // stoatbot.js leaves retryCount > 10 after retry exhaustion; reset it before relogin.
  if ('retryCount' in ws) ws.retryCount = 0;
  if ('reconnecting' in ws) ws.reconnecting = null;

  await client.login(config.botToken);
  console.log('✅ Stoat websocket recovery succeeded.');
  wsRecoveryAttempts = 0;
}

/**
 * Diagnostic output to help verify ticket category configuration.
 */
// `client: any` — this diagnostic pokes at raw REST response shapes
// (`client.api.get`, `server.me`) that the typed client does not model.
async function logCategoryDiagnostics(client: any) {
  try {
    const server = await client.servers.fetch(config.serverId);
    const canManageServer = typeof server?.me?.hasPermission === 'function'
      ? server.me.hasPermission('ManageServer')
      : null;

    if (canManageServer === false) {
      console.warn('⚠️ Bot is missing ManageServer permission. Category moves may fail.');
    } else if (canManageServer === true) {
      console.log('✅ Bot has ManageServer permission');
    }

    const data = await client.api.get(`/servers/${config.serverId}`, { include_channels: true });
    const categories = Array.isArray(data.categories) ? data.categories : [];

    if (categories.length === 0) {
      console.warn('⚠️ No categories found in the configured server.');
      return;
    }

    const openCategory = categories.find(c => c.id === config.openTicketsCategoryId);
    const closedCategory = categories.find(c => c.id === config.closedTicketsCategoryId);

    if (openCategory) {
      console.log(`✅ Open ticket category found: ${openCategory.title} (${openCategory.id})`);
    } else {
      console.warn(`⚠️ OPEN_TICKETS_CATEGORY_ID not found: ${config.openTicketsCategoryId}`);
    }

    if (closedCategory) {
      console.log(`✅ Closed ticket category found: ${closedCategory.title} (${closedCategory.id})`);
    } else {
      console.warn(`⚠️ CLOSED_TICKETS_CATEGORY_ID not found: ${config.closedTicketsCategoryId}`);
    }

    if (!openCategory || !closedCategory) {
      console.log('ℹ️ Available categories:');
      for (const category of categories) {
        console.log(`   - ${category.title} (${category.id})`);
      }
    }
  } catch (error) {
    console.warn('⚠️ Category diagnostics failed:', error?.message || error);
  }
}

/**
 * Convert low-detail stoat.js websocket errors into actionable logs.
 */
function formatClientError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (error && typeof error === 'object') {
    const type = error.type ? `type=${error.type}` : 'type=unknown';
    const message = error.message ? ` message=${error.message}` : '';
    return `Unknown client error object (${type}${message})`;
  }

  return String(error);
}

function isStoatWebSocketRetryExhausted(reason: unknown): boolean {
  return /max retry attempts reached on ws connection/i.test(formatUnhandledReason(reason));
}

function formatUnhandledReason(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }

  if (typeof reason === 'string') return reason;

  if (reason && typeof reason === 'object') {
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }

  return String(reason ?? 'unknown rejection');
}

async function resolveMessageFromRawPacket(packet) {
  const channelId = packet?.channel_id;
  const messageId = packet?.id;
  if (!channelId || !messageId) return null;

  let channel = client.channels.cache.get(channelId);
  if (!channel) {
    channel = await client.channels.fetch(channelId).catch(() => null);
  }

  if (!channel || typeof channel.isText !== 'function' || !channel.isText()) {
    return null;
  }

  const cachedMessage = channel.messages?.cache?.get?.(messageId);
  if (cachedMessage) {
    return cachedMessage;
  }

  return channel.messages.fetch(messageId).catch(() => null);
}

/**
 * Whether member snapshots are worth keeping for a server. They exist so the
 * raw member-update fallback can tell what changed: for the role and profile
 * logs, and for role-based stats channels. A server with neither needs none,
 * and fetching its member list would be pure waste.
 */
function memberSnapshotsNeeded(serverId: string): boolean {
  if (!serverId) return false;
  if (isModuleEnabled('logs')) {
    const logConfig = getLogConfig(serverId);
    if (logConfig.enabled && logConfig.channelId) return true;
  }
  return isModuleEnabled('stats') && getStatsChannels(serverId).some((entry) => entry?.mode === 'role');
}

// Servers whose member list was already fetched, so a second module starting
// (logs after stats) does not fetch it again.
const primedServers = new Set<string>();

async function primeSnapshotCaches() {
  if (isModuleEnabled('logs')) {
    cacheUserSnapshot(client.user);

    const usersCache = client?.users?.cache;
    if (usersCache && typeof usersCache.values === 'function') {
      for (const user of usersCache.values()) {
        cacheUserSnapshot(user);
      }
    }
  }

  // Prime member snapshots for every server that needs them (logging on with a
  // channel, or a role stats channel), not just the configured default. Other
  // servers are skipped: a member list is a large response and stays in memory.
  const serverIds = listServerIds().filter((serverId) => !primedServers.has(serverId) && memberSnapshotsNeeded(serverId));
  for (const serverId of serverIds) {
    try {
      const response: any = await client.api.get(`/servers/${serverId}/members`);
      const members = Array.isArray(response?.members)
        ? response.members
        : Array.isArray(response)
          ? response
          : [];

      for (const member of members) {
        const snapshot = toMemberSnapshot(member, serverId);
        if (!snapshot) continue;
        memberSnapshotCache.set(toMemberKey(snapshot.serverId, snapshot.userId), snapshot);
      }
      primedServers.add(serverId);
    } catch (error) {
      // best-effort preload only; continue with the next server
      debug('prime', () => `member preload failed for server ${serverId}: ${(error as Error)?.message || error}`);
    }
  }
}

/** Drop the snapshots nothing needs any more (after Logs or Stats was switched off). */
function pruneSnapshotCaches() {
  for (const [key, snapshot] of memberSnapshotCache) {
    if (!memberSnapshotsNeeded(snapshot.serverId)) memberSnapshotCache.delete(key);
  }
  for (const serverId of primedServers) {
    if (!memberSnapshotsNeeded(serverId)) primedServers.delete(serverId);
  }
  if (!isModuleEnabled('logs')) userSnapshotCache.clear();
}

// Every server the bot is in (by id). Falls back to the configured default so
// a cold cache still primes at least the primary server.
function listServerIds(): string[] {
  const ids = new Set<string>();
  const cache = client?.servers?.cache;
  if (cache && typeof cache.forEach === 'function') {
    cache.forEach((server: any, key: any) => {
      const id = String(server?.id || server?._id || key || '').trim();
      if (id) ids.add(id);
    });
  }
  if (ids.size === 0 && config.serverId) ids.add(config.serverId);
  return Array.from(ids);
}

function scheduleRawMemberUpdateFallback(packet: any) {
  const ids = getMemberIds(packet?.id) || getMemberIds(packet);
  if (!ids) return;

  // Raw packet: the member's roles may have changed even when stoatbot's own
  // member-update event never fires, so invalidate the memoized roles here too.
  forgetMemberRoles(ids.serverId, ids.userId);

  setTimeout(() => {
    handleRawMemberUpdateFallback(packet, ids.serverId, ids.userId).catch((error) => {
      console.error('Error in raw ServerMemberUpdate fallback:', error);
    });
  }, 900);
}

async function handleRawMemberUpdateFallback(packet: any, serverId: string, userId: string) {
  const key = toMemberKey(serverId, userId);
  const nativeAt = lastNativeMemberUpdateAt.get(key) || 0;

  // skip fallback if normal stoatbot serverMemberUpdate fired
  if (Date.now() - nativeAt < 1600) {
    return;
  }

  // Nothing would log the change or count it: skip the member fetch too.
  if (!memberSnapshotsNeeded(serverId)) return;

  let before = memberSnapshotCache.get(key) || null;
  if (!before) {
    before = await fetchMemberSnapshot(serverId, userId);
    if (!before) return;
  }

  const after = patchMemberSnapshot(before, packet?.data, packet?.clear);
  memberSnapshotCache.set(key, after);

  const oldMember = memberSnapshotToLogObject(before);
  const newMember = memberSnapshotToLogObject(after);

  const logsOn = isModuleEnabled('logs');
  const roleResult = logsOn ? await logMemberUpdate(client, oldMember, newMember) : diffMemberRoles(oldMember, newMember);
  if (logsOn) await logMemberProfileUpdate(client, oldMember, newMember);

  if (shouldRefreshStatsForRoleChange(roleResult)) {
    scheduleStatsRefresh('Member Roles Updated (raw fallback tracked role)');
  }
}

function shouldRefreshStatsForRoleChange(roleResult: any): boolean {
  if (!roleResult?.changed) {
    return false;
  }

  const changedRoleIds = new Set<string>();

  for (const roleId of Array.isArray(roleResult?.added) ? roleResult.added : []) {
    if (typeof roleId === 'string' && roleId) {
      changedRoleIds.add(roleId);
    }
  }

  for (const roleId of Array.isArray(roleResult?.removed) ? roleResult.removed : []) {
    if (typeof roleId === 'string' && roleId) {
      changedRoleIds.add(roleId);
    }
  }

  if (changedRoleIds.size === 0) {
    return false;
  }

  const trackedRoleIds = new Set(
    getStatsChannels()
      .filter((entry) => entry?.mode === 'role' && typeof entry?.roleId === 'string' && entry.roleId)
      .map((entry) => entry.roleId as string)
  );

  if (trackedRoleIds.size === 0) {
    return false;
  }

  for (const roleId of changedRoleIds) {
    if (trackedRoleIds.has(roleId)) {
      return true;
    }
  }

  return false;
}

function scheduleRawUserUpdateFallback(packet: any) {
  const userId = getUserId(packet?.id) || getUserId(packet);
  if (!userId) return;

  setTimeout(() => {
    handleRawUserUpdateFallback(packet, userId).catch((error) => {
      console.error('Error in raw UserUpdate fallback:', error);
    });
  }, 900);
}

async function handleRawUserUpdateFallback(packet: any, userId: string) {
  // Profile changes are only ever logged.
  if (!isModuleEnabled('logs')) return;
  const nativeAt = lastNativeUserUpdateAt.get(userId) || 0;
  if (Date.now() - nativeAt < 1600) {
    return;
  }

  let before = userSnapshotCache.get(userId) || null;
  if (!before) {
    before = await fetchUserSnapshot(userId);
    if (!before) return;
  }

  const after = patchUserSnapshot(before, packet?.data, packet?.clear);
  userSnapshotCache.set(userId, after);

  await logUserUpdate(client, userSnapshotToLogObject(before), userSnapshotToLogObject(after));
}

function markNativeMemberUpdate(member, previousMember) {
  const ids = getMemberIds(member) || getMemberIds(previousMember);
  if (!ids) return;

  lastNativeMemberUpdateAt.set(toMemberKey(ids.serverId, ids.userId), Date.now());
  // Their roles may have changed, so the next bot-permission check refetches
  // instead of reusing the memoized roles.
  forgetMemberRoles(ids.serverId, ids.userId);
}

function markNativeUserUpdate(user, previousUser) {
  const userId = getUserId(user) || getUserId(previousUser);
  if (!userId) return;

  lastNativeUserUpdateAt.set(userId, Date.now());
}

function toMemberKey(serverId: string, userId: string) {
  return `${serverId}:${userId}`;
}

function cacheMemberSnapshot(member) {
  const snapshot = toMemberSnapshot(member, config.serverId);
  if (!snapshot || !memberSnapshotsNeeded(snapshot.serverId)) return;

  memberSnapshotCache.set(toMemberKey(snapshot.serverId, snapshot.userId), snapshot);
}

function removeMemberSnapshot(member) {
  const ids = getMemberIds(member);
  if (!ids) return;

  memberSnapshotCache.delete(toMemberKey(ids.serverId, ids.userId));
}

function cacheUserSnapshot(user) {
  const snapshot = toUserSnapshot(user);
  if (!snapshot) return;

  userSnapshotCache.set(snapshot.userId, snapshot);
}

async function fetchMemberSnapshot(serverId: string, userId: string): Promise<MemberSnapshot | null> {
  let server = client.servers.cache.get(serverId);
  if (!server) {
    server = await client.servers.fetch(serverId).catch(() => null);
  }

  const member = await server?.members?.fetch?.(userId).catch(() => null);
  if (!member) return null;

  return toMemberSnapshot(member, serverId);
}

async function fetchUserSnapshot(userId: string): Promise<UserSnapshot | null> {
  let user = client?.users?.cache?.get?.(userId) || null;
  if (!user) {
    user = await client?.users?.fetch?.(userId).catch(() => null);
  }

  return toUserSnapshot(user);
}

function toMemberSnapshot(member: any, fallbackServerId?: string): MemberSnapshot | null {
  const ids = getMemberIds(member, fallbackServerId);
  if (!ids) return null;

  return {
    serverId: ids.serverId,
    userId: ids.userId,
    nickname: String(member?.nickname || '').trim(),
    avatarId: getAvatarId(member?.avatar),
    roleIds: toRoleIds(member?.roles || member?.roleIds || member?.role_ids || []),
  };
}

function toUserSnapshot(user: any): UserSnapshot | null {
  const userId = getUserId(user);
  if (!userId) return null;

  return {
    userId,
    username: String(user?.username || '').trim(),
    displayName: String(user?.displayName || user?.display_name || '').trim(),
    avatarId: getAvatarId(user?.avatar || user?.profile?.avatar),
  };
}

function patchMemberSnapshot(before: MemberSnapshot, data: any, clear: any): MemberSnapshot {
  const next: MemberSnapshot = {
    ...before,
    roleIds: [...before.roleIds],
  };

  const clears = normalizeClears(clear);

  if (clears.has('nickname')) next.nickname = '';
  if (clears.has('avatar')) next.avatarId = null;
  if (clears.has('roles') || clears.has('roleids') || clears.has('role_ids')) next.roleIds = [];

  if (data && typeof data === 'object') {
    if (Object.prototype.hasOwnProperty.call(data, 'nickname')) {
      next.nickname = String(data.nickname || '').trim();
    }

    if (Object.prototype.hasOwnProperty.call(data, 'avatar')) {
      next.avatarId = getAvatarId(data.avatar);
    }

    if (
      Object.prototype.hasOwnProperty.call(data, 'roles') ||
      Object.prototype.hasOwnProperty.call(data, 'roleIds') ||
      Object.prototype.hasOwnProperty.call(data, 'role_ids')
    ) {
      next.roleIds = toRoleIds(data.roles || data.roleIds || data.role_ids || []);
    }
  }

  return next;
}

function patchUserSnapshot(before: UserSnapshot, data: any, clear: any): UserSnapshot {
  const next: UserSnapshot = { ...before };
  const clears = normalizeClears(clear);

  if (clears.has('username')) next.username = '';
  if (clears.has('displayname') || clears.has('display_name')) next.displayName = '';
  if (clears.has('avatar')) next.avatarId = null;

  if (data && typeof data === 'object') {
    if (Object.prototype.hasOwnProperty.call(data, 'username')) {
      next.username = String(data.username || '').trim();
    }

    if (Object.prototype.hasOwnProperty.call(data, 'displayName') || Object.prototype.hasOwnProperty.call(data, 'display_name')) {
      next.displayName = String(data.displayName || data.display_name || '').trim();
    }

    if (Object.prototype.hasOwnProperty.call(data, 'avatar')) {
      next.avatarId = getAvatarId(data.avatar);
    }
  }

  return next;
}

function memberSnapshotToLogObject(snapshot: MemberSnapshot) {
  return {
    id: { server: snapshot.serverId, user: snapshot.userId },
    _id: { server: snapshot.serverId, user: snapshot.userId },
    nickname: snapshot.nickname || null,
    avatar: snapshot.avatarId ? { _id: snapshot.avatarId } : null,
    roles: snapshot.roleIds,
    roleIds: snapshot.roleIds,
  };
}

function userSnapshotToLogObject(snapshot: UserSnapshot) {
  return {
    id: snapshot.userId,
    _id: snapshot.userId,
    username: snapshot.username,
    displayName: snapshot.displayName,
    avatar: snapshot.avatarId ? { _id: snapshot.avatarId } : null,
  };
}

function getUserId(value: any): string | null {
  if (!value) return null;

  return (
    (typeof value?.id === 'string' && value.id) ||
    (typeof value?._id === 'string' && value._id) ||
    (typeof value?.userId === 'string' && value.userId) ||
    (typeof value?.user_id === 'string' && value.user_id) ||
    (typeof value?.id?.user === 'string' && value.id.user) ||
    (typeof value?._id?.user === 'string' && value._id.user) ||
    (typeof value?.user === 'string' && value.user) ||
    null
  );
}

function getAvatarId(value: any): string | null {
  if (!value) return null;

  if (typeof value === 'string') return value;

  return (
    (typeof value?._id === 'string' && value._id) ||
    (typeof value?.id === 'string' && value.id) ||
    (typeof value?.fileId === 'string' && value.fileId) ||
    (typeof value?.file_id === 'string' && value.file_id) ||
    (typeof value?.tag === 'string' && value.tag) ||
    null
  );
}

function toRoleIds(roles: any): string[] {
  const values = Array.isArray(roles)
    ? roles
    : roles instanceof Set
      ? Array.from(roles)
      : roles instanceof Map
        ? Array.from(roles.keys())
        : [];

  // A Set keeps the dedupe linear; insertion order is preserved either way.
  const roleIds = new Set<string>();

  for (const role of values) {
    const roleId =
      (typeof role === 'string' && role) ||
      (typeof role?.id === 'string' && role.id) ||
      (typeof role?._id === 'string' && role._id) ||
      null;

    if (roleId) roleIds.add(roleId);
  }

  return Array.from(roleIds);
}

function normalizeClears(clear: any): Set<string> {
  if (!Array.isArray(clear)) {
    return new Set();
  }

  return new Set(clear.map((field) => String(field || '').toLowerCase()));
}
