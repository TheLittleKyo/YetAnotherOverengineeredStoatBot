import { config } from '../config.js';
import { isStoatId, normalizeId } from '../id-utils.js';
import { requirePermission } from '../permissions.js';
import { joinLinesWithin } from '../embed-limits.js';
import { formatDuration, formatRelative, parseDuration } from '../duration.js';
import {
  countActiveWarns,
  deleteCase,
  getCase,
  getModerationSummary,
  listCases,
  outranks,
  runModAction,
  updateCaseReason,
  type ModActionType,
} from '../moderation.js';

/**
 * Moderation commands. Every punishment runs through the case system, so
 * `!warn`, the escalation ladder, and an automod hit all land in the same
 * history with the same numbering.
 *
 *   warn @user [reason]
 *   mute @user [duration] [reason]        duration defaults to the configured one
 *   unmute @user [reason]
 *   kick @user [reason]
 *   ban @user [duration] [reason]         a duration makes it a temp ban
 *   unban <userId> [reason]
 *   note @user <text>                     recorded, never shown to the member
 *   cases [@user]                         a member's history, or the latest cases
 *   case <id> | case reason <id> <text> | case delete <id>
 *   modstats                              counts per action, top moderators
 *
 * Each command is gated on the Stoat permission that matches its severity, so
 * a helper with Manage Messages can warn without also being able to ban.
 */

export const MODERATION_COMMAND_NAMES = [
  'warn',
  'mute',
  'timeout',
  'unmute',
  'untimeout',
  'kick',
  'ban',
  'unban',
  'note',
  'cases',
  'history',
  'modlogs',
  'case',
  'modstats',
  'moderation',
];

/** Stoat permissions accepted for each command, with the label shown on refusal. */
const REQUIRED_PERMISSION: Record<string, { names: string[]; label: string }> = {
  warn: { names: ['ManageMessages', 'KickMembers', 'ManageServer'], label: 'Manage Messages' },
  note: { names: ['ManageMessages', 'KickMembers', 'ManageServer'], label: 'Manage Messages' },
  mute: { names: ['TimeoutMembers', 'ManageMessages', 'ManageServer'], label: 'Timeout Members' },
  unmute: { names: ['TimeoutMembers', 'ManageMessages', 'ManageServer'], label: 'Timeout Members' },
  kick: { names: ['KickMembers', 'ManageServer'], label: 'Kick Members' },
  ban: { names: ['BanMembers', 'ManageServer'], label: 'Ban Members' },
  unban: { names: ['BanMembers', 'ManageServer'], label: 'Ban Members' },
  cases: { names: ['ManageMessages', 'KickMembers', 'ManageServer'], label: 'Manage Messages' },
  case: { names: ['ManageMessages', 'KickMembers', 'ManageServer'], label: 'Manage Messages' },
  modstats: { names: ['ManageMessages', 'KickMembers', 'ManageServer'], label: 'Manage Messages' },
};

const ALIASES: Record<string, string> = {
  timeout: 'mute',
  untimeout: 'unmute',
  history: 'cases',
  modlogs: 'cases',
  moderation: 'help',
};

export async function moderationCommand(message: any, args: string[], client: any) {
  const invokedAs = (args.shift() || '').toLowerCase();
  const command = ALIASES[invokedAs] || invokedAs;

  const serverId = resolveServerId(message);
  if (!serverId) {
    await message.channel?.send({ content: '❌ Moderation commands only work inside a server.' });
    return;
  }

  if (command === 'help') {
    await sendHelp(message);
    return;
  }

  const permission = REQUIRED_PERMISSION[command];
  if (permission && !(await requirePermission(message, client, permission.names, permission.label))) return;

  switch (command) {
    case 'warn':
    case 'note':
    case 'kick':
      return runSimpleAction(message, client, serverId, command as ModActionType, args);
    case 'mute':
    case 'ban':
      return runTimedAction(message, client, serverId, command as ModActionType, args);
    case 'unmute':
    case 'unban':
      return runSimpleAction(message, client, serverId, command as ModActionType, args);
    case 'cases':
      return showCases(message, serverId, args);
    case 'case':
      return handleCase(message, client, serverId, args);
    case 'modstats':
      return showStats(message, serverId);
    default:
      return sendHelp(message, `Unknown moderation command: \`${invokedAs}\`.`);
  }
}

function resolveServerId(message: any): string {
  try {
    return String(message?.channel?.serverId || message?.serverId || config.serverId || '');
  } catch {
    return String(config.serverId || '');
  }
}

/** A member id from a mention or a pasted id, or null for anything else. */
function targetId(value: unknown): string | null {
  const id = normalizeId(value);
  return id && isStoatId(id) ? id : null;
}

/**
 * Refuse actions against the caller, the bot, the server owner, and anyone at
 * or above the caller in the role order — the bot's own role usually sits
 * high, and must not let a moderator reach past their own rank.
 */
async function guardTarget(message: any, client: any, serverId: string, userId: string): Promise<string | null> {
  const actorId = String(message?.authorId || '');
  if (userId === actorId) return 'You cannot use that on yourself.';
  if (userId === String(client?.user?.id || '')) return 'I am not going to do that to myself.';

  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  const ownerId = String(server?.ownerId || server?.owner?.id || server?.owner || '');
  if (ownerId && ownerId === userId) return 'That is the server owner.';
  if (!(await outranks(client, serverId, actorId, userId))) return 'They are at or above your highest role.';
  return null;
}

async function runSimpleAction(message: any, client: any, serverId: string, action: ModActionType, args: string[]) {
  const userId = targetId(args.shift());
  if (!userId) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}${action} @user [reason]\`` });
    return;
  }

  // `unban` targets someone who is no longer in the server, and a note changes
  // nothing for the member, so the guards below do not apply to them.
  if (action !== 'unban' && action !== 'note') {
    const problem = await guardTarget(message, client, serverId, userId);
    if (problem) {
      await message.channel?.send({ content: `❌ ${problem}` });
      return;
    }
  }

  const reason = args.join(' ').trim();
  if (action === 'note' && !reason) {
    await message.channel?.send({ content: `❌ A note needs text: \`${config.prefix}note @user <text>\`` });
    return;
  }

  const result = await runModAction(client, {
    serverId,
    action,
    userId,
    moderatorId: String(message?.authorId || ''),
    reason,
  });

  await message.channel?.send({ content: describeResult(result, action, userId) });
}

async function runTimedAction(message: any, client: any, serverId: string, action: ModActionType, args: string[]) {
  const userId = targetId(args.shift());
  if (!userId) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}${action} @user [duration] [reason]\` — e.g. \`${config.prefix}${action} @user 2h spamming\``,
    });
    return;
  }

  const problem = await guardTarget(message, client, serverId, userId);
  if (problem) {
    await message.channel?.send({ content: `❌ ${problem}` });
    return;
  }

  // The first argument is a duration only when it parses as one; otherwise it
  // is the first word of the reason ("!ban @user forever spamming" still bans
  // permanently, "!ban @user spamming" does not try to parse "spamming").
  let durationMs: number | null | undefined;
  const maybeDuration = parseDuration(args[0]);
  if (maybeDuration !== undefined) {
    durationMs = maybeDuration;
    args.shift();
  } else if (action === 'ban') {
    durationMs = null;
  }

  const result = await runModAction(client, {
    serverId,
    action,
    userId,
    moderatorId: String(message?.authorId || ''),
    reason: args.join(' ').trim(),
    durationMs,
  });

  await message.channel?.send({ content: describeResult(result, action, userId) });
}

function describeResult(result: Awaited<ReturnType<typeof runModAction>>, action: ModActionType, userId: string): string {
  if (!result.ok) {
    return `❌ Could not ${action} <@${userId}>: ${result.error}${result.case ? ` (recorded as case #${result.case.id})` : ''}`;
  }

  const record = result.case!;
  const icon = { warn: '⚠️', mute: '🔇', unmute: '🔊', kick: '👢', ban: '🔨', unban: '♻️', note: '📝' }[action] || '✅';
  const parts = [`${icon} **${actionPastTense(action)}** <@${userId}> — case #${record.id}`];
  if (record.durationMs) parts.push(`for ${formatDuration(record.durationMs)}`);
  parts.push(`\n**Reason:** ${record.reason}`);

  if (action === 'warn') {
    const warns = countActiveWarns(userId, record.serverId);
    parts.push(`\n**Warnings on record:** ${warns}`);
  }
  if (result.escalation) {
    parts.push(`\n⚡ Escalation applied: **${result.escalation.action}** (case #${result.escalation.id}).`);
  }
  if (result.dmFailed) parts.push('\n_Could not DM them — their DMs are closed._');

  return parts.join(' ');
}

function actionPastTense(action: ModActionType): string {
  return { warn: 'Warned', mute: 'Muted', unmute: 'Unmuted', kick: 'Kicked', ban: 'Banned', unban: 'Unbanned', note: 'Noted' }[action];
}

async function showCases(message: any, serverId: string, args: string[]) {
  const userId = targetId(args[0]) || null;
  const cases = listCases(serverId, { userId: userId || undefined, limit: 15 });

  if (!cases.length) {
    await message.channel?.send({
      content: userId ? `✅ <@${userId}> has no cases on record.` : 'No moderation cases yet.',
    });
    return;
  }

  const header = userId
    ? `## 🗂️ Cases for <@${userId}> (${countActiveWarns(userId, serverId)} active warning(s))`
    : `## 🗂️ Latest cases`;

  const lines = cases.map((entry) => {
    const when = new Date(entry.createdAt).toLocaleDateString();
    const duration = entry.durationMs ? ` · ${formatDuration(entry.durationMs)}` : '';
    const state = entry.active ? ' · **active**' : entry.failed ? ' · *failed*' : '';
    const who = userId ? '' : ` · <@${entry.userId}>`;
    return `\`#${entry.id}\` **${entry.action}**${who}${duration}${state} · ${when}\n  ${entry.reason.slice(0, 160)}`;
  });

  await message.channel?.send({ content: joinLinesWithin(header, lines) });
}

async function handleCase(message: any, client: any, serverId: string, args: string[]) {
  const first = (args.shift() || '').toLowerCase();

  if (first === 'delete' || first === 'remove') {
    // Erasing a record is heavier than writing one: a helper who may warn must
    // not be able to wipe a ban from someone's history.
    if (!(await requirePermission(message, client, ['BanMembers', 'ManageServer'], 'Ban Members'))) return;
    const id = Number(args.shift());
    if (!Number.isInteger(id) || id < 1) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}case delete <id>\`` });
      return;
    }
    const removed = deleteCase(id, serverId);
    await message.channel?.send({ content: removed ? `🗑️ Case #${id} deleted.` : `❌ No case #${id}.` });
    return;
  }

  if (first === 'reason' || first === 'edit') {
    const id = Number(args.shift());
    const reason = args.join(' ').trim();
    if (!Number.isInteger(id) || id < 1 || !reason) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}case reason <id> <new reason>\`` });
      return;
    }
    const updated = updateCaseReason(id, reason, serverId);
    await message.channel?.send({ content: updated ? `✏️ Case #${id} reason updated.` : `❌ No case #${id}.` });
    return;
  }

  const id = Number(first.replace(/^#/, ''));
  if (!first || !Number.isInteger(id) || id < 1) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}case <id>\`, \`${config.prefix}case reason <id> <text>\`, or \`${config.prefix}case delete <id>\``,
    });
    return;
  }

  const entry = getCase(id, serverId);
  if (!entry) {
    await message.channel?.send({ content: `❌ No case #${id}.` });
    return;
  }

  const lines = [
    `## 🗂️ Case #${entry.id} · ${entry.action}`,
    `**Member:** <@${entry.userId}> (${entry.userName})`,
    `**Moderator:** ${entry.automated ? 'Automatic' : `<@${entry.moderatorId}>`}`,
    `**Reason:** ${entry.reason}`,
    `**When:** ${new Date(entry.createdAt).toLocaleString()}`,
  ];
  if (entry.durationMs) lines.push(`**Duration:** ${formatDuration(entry.durationMs)}`);
  if (entry.expiresAt) lines.push(`**Expires:** ${formatRelative(entry.expiresAt)}`);
  if (entry.active) lines.push('**Status:** active');
  if (entry.failed) lines.push('**Status:** the action failed on Stoat; only the record exists');

  await message.channel?.send({ content: lines.join('\n') });
}

async function showStats(message: any, serverId: string) {
  const summary = getModerationSummary(serverId);
  const byAction = Object.entries(summary.byAction)
    .filter(([, count]) => count > 0)
    .map(([action, count]) => `${action} ${count}`)
    .join(' · ') || 'nothing yet';

  const moderators = summary.topModerators.length
    ? summary.topModerators.map((row, index) => `${index + 1}. <@${row.moderatorId}> — ${row.count}`).join('\n')
    : '_No moderator actions yet._';

  await message.channel?.send({
    content: [
      '## 📊 Moderation stats',
      `**Total cases:** ${summary.total} · **last 30 days:** ${summary.last30Days}`,
      `**Active punishments:** ${summary.activePunishments}`,
      `**By action:** ${byAction}`,
      '',
      '**Top moderators**',
      moderators,
    ].join('\n'),
  });
}

async function sendHelp(message: any, prefixLine?: string) {
  const p = config.prefix;
  const lines = [
    prefixLine || '## 🔨 Moderation',
    `\`${p}warn @user [reason]\` — record a warning (may trigger escalation)`,
    `\`${p}mute @user [duration] [reason]\` — timeout, e.g. \`${p}mute @user 2h spam\``,
    `\`${p}unmute @user [reason]\` — lift a mute early`,
    `\`${p}kick @user [reason]\``,
    `\`${p}ban @user [duration] [reason]\` — a duration makes it temporary`,
    `\`${p}unban <userId> [reason]\``,
    `\`${p}note @user <text>\` — staff-only note, the member is not told`,
    `\`${p}cases [@user]\` — case history`,
    `\`${p}case <id>\` · \`${p}case reason <id> <text>\` · \`${p}case delete <id>\``,
    `\`${p}modstats\` — totals and top moderators`,
    '',
    `Escalation rules, the mute role and DM notices are configured in the dashboard's **Moderation** tab.`,
  ];
  await message.channel?.send({ content: lines.join('\n') });
}
