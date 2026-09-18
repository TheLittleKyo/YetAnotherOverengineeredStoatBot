import { config } from '../config.js';
import { ticketDb } from '../database.js';
import { isTicketStaff } from '../permissions.js';
import { generateAndSendTranscriptForTicket } from './ticket-transcript.js';
import { logTicketAction } from '../log-system.js';

/**
 * Delete a ticket channel and remove the ticket from DB.
 * Usage: !ticket delete
 * Must be used inside a ticket channel.
 */
export async function ticketDelete(message, args, client) {
  const ticket = ticketDb.getByChannelId(message.channelId);

  if (!ticket) {
    await message.channel?.send({
      content: '❌ This command can only be used inside a ticket channel.',
    });
    return;
  }

  const isCreator = message.authorId === ticket.creatorId;
  let server = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }
  const member = await server?.members?.fetch(message.authorId).catch(() => server?.members?.cache?.get?.(message.authorId) || null);
  const isStaff = await isTicketStaff(client, config.serverId, message.authorId, member, config.supportRoleId);

  if (!isCreator && !isStaff) {
    await message.channel?.send({
      content: '❌ Only the ticket creator or support staff can delete this ticket.',
    });
    return;
  }

  await message.channel?.send({
    content: '🗑️ Deleting ticket... generating transcript first.',
  });

  // Mark as closed if still open, so metadata is complete
  if (ticket.status !== 'closed') {
    ticketDb.update(ticket.ticketId, {
      status: 'closed',
      closedAt: new Date().toISOString(),
      closedBy: message.authorId,
      closedByUsername: message.author?.username || 'Unknown User',
      closeReason: 'Deleted via !ticket delete',
    });
  }

  const updatedTicket = ticketDb.getById(ticket.ticketId);
  if (!updatedTicket) {
    await message.channel?.send({
      content: '❌ Failed to refresh ticket data before delete.',
    });
    return;
  }

  const transcriptResult = await generateAndSendTranscriptForTicket({
    client,
    sourceChannelId: message.channelId,
    ticket: { ...updatedTicket, ticketId: ticket.ticketId },
    generatedById: message.authorId,
    generatedByUsername: message.author?.username || 'Unknown User',
    generatedForAction: 'ticket delete command',
  });

  if (!transcriptResult.ok) {
    await message.channel?.send({
      content:
        `❌ Could not generate transcript, ticket deletion aborted.\n` +
        `Reason: ${transcriptResult.error || 'unknown error'}`,
    });
    return;
  }

  try {
    // Remove per-ticket access role if present
    if (ticket.ticketRoleId && server) {
      try {
        await server.roles.delete(ticket.ticketRoleId);
      } catch (roleDeleteError) {
        console.error(`[ticket:${ticket.ticketId}] failed to delete ticket role ${ticket.ticketRoleId}:`, roleDeleteError);
      }
    }

    const channel = client.channels.cache.get(message.channelId) || (await client.channels.fetch(message.channelId).catch(() => null));
    if (!channel) {
      await message.channel?.send({
        content: '❌ Could not find this channel to delete.',
      });
      return;
    }

    // Remove DB record first to satisfy request that DB is deleted with ticket deletion flow.
    const deleted = ticketDb.delete(ticket.ticketId);
    if (!deleted) {
      await message.channel?.send({
        content: '❌ Failed to delete ticket data from database.',
      });
      return;
    }

    await logTicketAction(client, {
      action: 'Ticket deleted',
      ticketId: ticket.ticketId,
      executorId: message.authorId,
      creatorId: ticket.creatorId,
      channelId: message.channelId,
      details: 'Transcript generated, DB record removed, channel deletion requested.',
    });

    await channel.delete();
    console.log(`[ticket:${ticket.ticketId}] deleted by ${message.author?.username || message.authorId}`);
  } catch (error) {
    console.error('Error deleting ticket channel:', error);
    await message.channel?.send({
      content: '❌ Failed to delete the ticket channel. The transcript was generated; please delete manually if needed.',
    });
  }
}
