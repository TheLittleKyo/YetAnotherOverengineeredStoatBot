import { ticketDb } from '../database.js';
import { logTicketAction } from '../log-system.js';
import {
  resolveTicketActor,
  normalizePriority,
  PRIORITY_META,
  TICKET_PRIORITIES,
  type TicketPriority,
} from './ticket-common.js';

/**
 * View or set the priority of the current ticket.
 * Usage: !ticket priority            → show current priority
 *        !ticket priority <level>    → set priority (low|normal|high|urgent), staff only
 * Must be used inside a ticket channel.
 */
export async function ticketPriority(message, args, client) {
  const ticket = ticketDb.getByChannelId(message.channelId);
  if (!ticket) {
    await message.channel?.send({ content: '❌ This command can only be used inside a ticket channel.' });
    return;
  }

  const current = (normalizePriority(ticket.priority) || 'normal') as TicketPriority;

  // No argument → report current priority.
  if (!args[0]) {
    const meta = PRIORITY_META[current];
    await message.channel?.send({
      content: `${meta.icon} Ticket #${ticket.ticketId} priority: **${meta.label}**.\nSet with \`ticket priority <${TICKET_PRIORITIES.join('|')}>\`.`,
    });
    return;
  }

  const next = normalizePriority(args[0]);
  if (!next) {
    await message.channel?.send({
      content: `❌ Unknown priority. Use one of: ${TICKET_PRIORITIES.map((p) => `\`${p}\``).join(', ')}.`,
    });
    return;
  }

  const { isStaff } = await resolveTicketActor(client, message);
  if (!isStaff) {
    await message.channel?.send({ content: '❌ Only support staff can change ticket priority.' });
    return;
  }

  if (next === current) {
    await message.channel?.send({ content: `ℹ️ Ticket #${ticket.ticketId} is already ${PRIORITY_META[next].label} priority.` });
    return;
  }

  ticketDb.update(ticket.ticketId, { priority: next });

  const meta = PRIORITY_META[next];
  await message.channel?.send({
    content: `${meta.icon} Ticket #${ticket.ticketId} priority set to **${meta.label}** by <@${message.authorId}>.`,
  });

  await logTicketAction(client, {
    action: 'Ticket priority changed',
    ticketId: ticket.ticketId,
    executorId: message.authorId,
    creatorId: ticket.creatorId,
    channelId: message.channelId,
    serverId: ticket.serverId,
    details: `${PRIORITY_META[current].label} → ${meta.label}.`,
  });
}
