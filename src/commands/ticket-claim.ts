import { ticketDb } from '../database.js';
import { logTicketAction } from '../log-system.js';
import { resolveTicketActor } from './ticket-common.js';

/**
 * Claim (assign) the current ticket to a staff member.
 * Usage: !ticket claim            → claim for yourself
 *        !ticket claim @user|<id> → assign to another member (staff only)
 *        !ticket claim clear       → release the claim
 * Must be used inside an open ticket channel; staff only.
 */
export async function ticketClaim(message, args, client) {
  const ticket = ticketDb.getByChannelId(message.channelId);
  if (!ticket) {
    await message.channel?.send({ content: '❌ This command can only be used inside a ticket channel.' });
    return;
  }
  if (ticket.status === 'closed') {
    await message.channel?.send({ content: '❌ This ticket is closed.' });
    return;
  }

  const { isStaff } = await resolveTicketActor(client, message);
  if (!isStaff) {
    await message.channel?.send({ content: '❌ Only support staff can claim tickets.' });
    return;
  }

  const arg = (args[0] || '').trim();

  // Release an existing claim.
  if (arg.toLowerCase() === 'clear' || arg.toLowerCase() === 'release' || arg.toLowerCase() === 'unclaim') {
    if (!ticket.assigneeId) {
      await message.channel?.send({ content: 'ℹ️ This ticket is not claimed.' });
      return;
    }
    ticketDb.update(ticket.ticketId, { assigneeId: null, assigneeUsername: null, claimedAt: null });
    await message.channel?.send({ content: `🔓 Ticket #${ticket.ticketId} released by <@${message.authorId}>.` });
    await logTicketAction(client, {
      action: 'Ticket unclaimed',
      ticketId: ticket.ticketId,
      executorId: message.authorId,
      creatorId: ticket.creatorId,
      channelId: message.channelId,
      serverId: ticket.serverId,
    });
    return;
  }

  // Assignee: an explicit @mention / id, otherwise the command author.
  const assigneeId = extractUserId(arg) || message.authorId;
  const assigneeUsername =
    assigneeId === message.authorId ? message.author?.username || 'Unknown User' : null;

  if (ticket.assigneeId === assigneeId) {
    await message.channel?.send({ content: `ℹ️ Ticket #${ticket.ticketId} is already claimed by <@${assigneeId}>.` });
    return;
  }

  const previousAssignee = ticket.assigneeId;
  ticketDb.update(ticket.ticketId, {
    assigneeId,
    assigneeUsername,
    claimedAt: new Date().toISOString(),
  });

  const reassignNote = previousAssignee ? ` (reassigned from <@${previousAssignee}>)` : '';
  await message.channel?.send({
    content: `🙋 Ticket #${ticket.ticketId} claimed by <@${assigneeId}>${reassignNote}.`,
  });

  await logTicketAction(client, {
    action: 'Ticket claimed',
    ticketId: ticket.ticketId,
    executorId: message.authorId,
    creatorId: ticket.creatorId,
    channelId: message.channelId,
    serverId: ticket.serverId,
    details: `Assigned to ${assigneeId}${previousAssignee ? ` (was ${previousAssignee})` : ''}.`,
  });
}

// Pull a user id out of a `<@id>` mention or a bare id string.
function extractUserId(value: string): string | null {
  const match = String(value || '').match(/^<@!?([A-Za-z0-9]+)>$/);
  if (match) return match[1];
  if (/^[A-Za-z0-9]{16,}$/.test(value)) return value;
  return null;
}
