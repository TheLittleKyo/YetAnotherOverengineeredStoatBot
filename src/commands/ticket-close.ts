import { config } from '../config.js';
import { ticketDb } from '../database.js';
import { isTicketStaff } from '../permissions.js';
import { moveChannelToCategory, getReadableError } from '../category-utils.js';
import { logTicketAction } from '../log-system.js';
import { captureTicketPermissionSnapshot } from '../permission-snapshot.js';
import { sleep } from '../async-utils.js';

/**
 * Close an open ticket
 * Usage: !ticket close
 * Must be used inside a ticket channel
 */
export async function ticketClose(message, args, client) {
  const ticket = ticketDb.getByChannelId(message.channelId);
  
  if (!ticket) {
    await message.channel?.send({
      content: '❌ This command can only be used inside a ticket channel.',
    });
    return;
  }
  
  if (ticket.status === 'closed') {
    await message.channel?.send({
      content: '❌ This ticket is already closed.',
    });
    return;
  }
  
  // Check if user has permission to close
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
      content: '❌ Only the ticket creator or support staff can close this ticket.',
    });
    return;
  }
  
  try {
    const closedAt = new Date().toISOString();
    ticketDb.update(ticket.ticketId, {
      status: 'closed',
      closedAt,
      closedBy: message.authorId,
      closedByUsername: message.author?.username || 'Unknown User',
    });
    console.log(`[ticket:${ticket.ticketId}] close: db updated`);
    
    const channel = client.channels.cache.get(message.channelId) || (await client.channels.fetch(message.channelId).catch(() => null));
    if (!channel) {
      await message.channel?.send({
        content: '❌ Could not find the channel. Please contact an administrator.',
      });
      return;
    }
    
    // Snapshot the channel + participant permissions while the ticket is still
    // in its open state, so the transcript can show access "before close".
    try {
      const permsBeforeClose = await captureTicketPermissionSnapshot(
        client,
        channel,
        { ...ticket, status: 'open', closedBy: message.authorId, closedByUsername: message.author?.username },
        'Before close',
      );
      ticketDb.update(ticket.ticketId, { permsBeforeClose });
      console.log(`[ticket:${ticket.ticketId}] close: permission snapshot captured`);
    } catch (snapshotError) {
      console.warn(`[ticket:${ticket.ticketId}] close: permission snapshot failed:`, getReadableError(snapshotError));
    }

    // Rename the channel to indicate it's closed
    const newName = `closed-${ticket.ticketId}`;
    await channel.edit({ name: newName });
    console.log(`[ticket:${ticket.ticketId}] close: channel renamed`);

    // Send closure message
    await channel.send({
      content: `# 🔒 Ticket Closed\n\n` +
        `**Closed by:** <@${message.authorId}>\n` +
        `**Closed at:** ${new Date(closedAt).toLocaleString()}\n\n` +
        `---\n\n` +
        `This ticket has been closed.\n\n` +
        `**Commands:**\n` +
        `• \`${config.prefix}ticket transcript\` - Generate a transcript of this conversation\n` +
        `• \`${config.prefix}ticket delete\` - Delete this ticket (transcript + DB cleanup + channel delete)`,
    });
    console.log(`[ticket:${ticket.ticketId}] close: closure message sent`);

    // Move channel into the closed category in background so close UX stays fast.
    scheduleClosedCategoryMove({
      client,
      serverId: config.serverId,
      channelId: channel.id,
      categoryId: config.closedTicketsCategoryId,
      ticketId: ticket.ticketId,
    });

    console.log(`Ticket ${ticket.ticketId} closed by ${message.author?.username}`);
    await logTicketAction(client, {
      action: 'Ticket closed',
      ticketId: ticket.ticketId,
      executorId: message.authorId,
      creatorId: ticket.creatorId,
      channelId: channel.id,
      details: `Channel renamed to ${newName}. Closed category move scheduled.`,
    });
    
  } catch (error) {
    console.error('Error closing ticket:', error);
    await message.channel?.send({
      content: '❌ Failed to close the ticket. Please try again or contact an administrator.',
    });
  }
}

function scheduleClosedCategoryMove({ client, serverId, channelId, categoryId, ticketId }) {
  void retryClosedCategoryMove({
    client,
    serverId,
    channelId,
    categoryId,
    ticketId,
    attempts: 3,
    delayMs: 700,
  });
}

async function retryClosedCategoryMove({
  client,
  serverId,
  channelId,
  categoryId,
  ticketId,
  attempts,
  delayMs,
}) {
  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await moveChannelToCategory(client, serverId, channelId, categoryId);
      console.log(`[ticket:${ticketId}] close: moved to closed category (${Date.now() - startedAt}ms, attempt ${attempt}/${attempts})`);
      return;
    } catch (error) {
      lastError = error;
      const detail = getReadableError(error);
      console.warn(`[ticket:${ticketId}] close-category-move attempt ${attempt}/${attempts} failed: ${detail}`);

      if (attempt < attempts) {
        await sleep(delayMs * attempt);
      }
    }
  }

  console.error(`[ticket:${ticketId}] close: failed to move to closed category after ${attempts} attempts: ${getReadableError(lastError)}`);
}
