import { config } from '../config.js';
import {
  addReminder,
  listReminders,
  removeReminder,
  toggleReminder,
  parseScheduleText,
  describeSchedule,
  sendReminderNow,
} from '../reminders.js';
import { normalizeSimpleId } from '../id-utils.js';
import { canManageServerById } from '../permissions.js';

/**
 * `reminder` command — schedule recurring or one-off messages to a channel.
 *
 *   reminder add <#channel> <schedule> | <message>
 *   reminder list
 *   reminder remove <id>
 *   reminder toggle <id>
 *   reminder test <id>
 *
 * Schedule forms:
 *   every 30s | every 2 hours | every 1 week | every 3 months
 *   weekly mon,wed,fri 09:00
 *   monthly 15 09:00
 *   on 2026-12-25 10:00        (specific calendar date; time optional)
 */
export async function reminderCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({ content: 'You need Manage Server permission to manage reminders.' });
    return;
  }

  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  if (!serverId) {
    await message.channel?.send({ content: 'Reminders only work inside a server.' });
    return;
  }

  if (sub === 'add' || sub === 'create') {
    const rest = args.join(' ');
    const pipe = rest.indexOf('|');
    if (pipe === -1) {
      await sendHelp(message, 'Usage: `reminder add <#channel> <schedule> | <message>`');
      return;
    }

    const left = rest.slice(0, pipe).trim();
    const messageText = rest.slice(pipe + 1).trim();
    if (!messageText) { await sendHelp(message, 'Provide a message after `|`.'); return; }

    const leftTokens = left.split(/\s+/).filter(Boolean);
    const channelToken = leftTokens.shift();
    const channelId = normalizeSimpleId(channelToken) || '';
    if (!channelId) { await sendHelp(message, 'Start with a channel: `reminder add <#channel> ...`'); return; }

    const parsed = parseScheduleText(leftTokens.join(' '));
    if (parsed.error || !parsed.schedule) {
      await sendHelp(message, parsed.error || 'Could not parse the schedule.');
      return;
    }

    const reminder = addReminder({ serverId, channelId, message: messageText, schedule: parsed.schedule });
    await message.channel?.send({
      content:
        `# ⏰ Reminder Added\n\n` +
        `ID: \`${reminder.id}\`\n` +
        `Channel: <#${reminder.channelId}>\n` +
        `Schedule: ${describeSchedule(reminder.schedule)}\n` +
        `Next: ${reminder.nextRunAt ? formatTime(reminder.nextRunAt) : 'n/a'}\n` +
        `Message: ${truncate(reminder.message, 120)}`,
    });
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const reminders = listReminders(serverId);
    if (reminders.length === 0) {
      await message.channel?.send({ content: `No reminders configured. Add one with \`${config.prefix}reminder add <#channel> <schedule> | <message>\`.` });
      return;
    }
    const lines = reminders.map((r) => {
      const state = r.enabled ? '🟢' : '🔴';
      const next = r.enabled && r.nextRunAt ? ` — next ${formatTime(r.nextRunAt)}` : '';
      return `- ${state} \`${r.id}\` → <#${r.channelId}> · ${describeSchedule(r.schedule)}${next}\n   ${truncate(r.message, 80)}`;
    });
    await message.channel?.send({ content: `# ⏰ Reminders\n\n${lines.join('\n')}` });
    return;
  }

  if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
    const id = args[0];
    if (!id) { await sendHelp(message, 'Usage: `reminder remove <id>`'); return; }
    const removed = removeReminder(id);
    await message.channel?.send({ content: removed ? `Removed reminder \`${id}\`.` : `No reminder found with ID \`${id}\`.` });
    return;
  }

  if (sub === 'toggle' || sub === 'enable' || sub === 'disable') {
    const id = args[0];
    if (!id) { await sendHelp(message, 'Usage: `reminder toggle <id>`'); return; }
    const reminder = toggleReminder(id);
    await message.channel?.send({
      content: reminder
        ? `Reminder \`${id}\` is now ${reminder.enabled ? 'enabled 🟢' : 'disabled 🔴'}${reminder.enabled && reminder.nextRunAt ? ` — next ${formatTime(reminder.nextRunAt)}` : ''}.`
        : `No reminder found with ID \`${id}\`.`,
    });
    return;
  }

  if (sub === 'test' || sub === 'send' || sub === 'run') {
    const id = args[0];
    if (!id) { await sendHelp(message, 'Usage: `reminder test <id>`'); return; }
    const ok = await sendReminderNow(client, id);
    await message.channel?.send({ content: ok ? `Sent reminder \`${id}\` now.` : `No reminder found with ID \`${id}\`.` });
    return;
  }

  await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
}

function formatTime(ms: number): string {
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# ⏰ Reminder Commands\n\n` +
      `- \`${config.prefix}reminder add <#channel> <schedule> | <message>\` - Schedule a message\n` +
      `- \`${config.prefix}reminder list\` - List reminders\n` +
      `- \`${config.prefix}reminder remove <id>\` / \`${config.prefix}reminder toggle <id>\` - Delete or enable/disable\n` +
      `- \`${config.prefix}reminder test <id>\` - Send it now\n\n` +
      `**Schedules:**\n` +
      `- \`every 30s\` · \`every 10m\` · \`every 2h\` · \`every 1d\` · \`every 1w\` · \`every 3mo\`\n` +
      `- \`weekly mon,wed,fri 09:00\` - Specific weekdays at a time\n` +
      `- \`monthly 15 09:00\` - A day of the month at a time\n` +
      `- \`on 2026-12-25 10:00\` - A specific calendar date (time optional)\n\n` +
      `Times use the bot host's local time. Placeholders: \`{time}\` \`{date}\`. Or use the dashboard Reminders tab.`,
  });
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}
