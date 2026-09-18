import { createTicketForUser } from './ticket-open.js';
import { MessageEmbed } from 'stoatbot.js';
import { config } from '../config.js';
import { logTicketAction } from '../log-system.js';
import { requirePermission } from '../permissions.js';
import { resolveBotPermission } from '../bot-permissions.js';

export const TICKET_PANEL_EMOJI = '🎫';
export const TICKET_PANEL_TITLE = '🎫 Ticket Panel';

/**
 * Send a ticket panel embed and attach the ticket reaction.
 * Usage: !ticket panel
 */
export async function ticketPanel(message, args, client) {
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;

  const panelEmbed = new MessageEmbed()
    .setTitle(TICKET_PANEL_TITLE)
    .setDescription(
      `React with ${TICKET_PANEL_EMOJI} on this message to open a support ticket.\n\n` +
      `A private ticket channel will be created for you automatically.`
    )
    .setColor('#3b82f6');

  const panelMessage = await message.channel?.send({
    embeds: [panelEmbed],
  });

  if (!panelMessage) {
    return;
  }

  await panelMessage.addReaction(TICKET_PANEL_EMOJI);

  await message.channel?.send({
    content: '✅ Ticket panel sent. Users can now react to open tickets.',
  });
  await logTicketAction(client, {
    action: 'Ticket panel sent',
    executorId: message.authorId,
    channelId: message.channelId,
    details: `Panel message ID: ${panelMessage.id || 'unknown'}`,
  });
}

/**
 * Handle reaction-based ticket opening from ticket panels.
 */
export async function handleTicketPanelReaction({ client, message, userId, emoji }) {
  if (!isTicketPanelMessage(message, client)) {
    return;
  }

  if (emoji !== TICKET_PANEL_EMOJI) {
    return;
  }

  if (!userId || userId === client.user?.id) {
    return;
  }

  let user = client.users.cache.get(userId);
  if (!user) {
    try {
      user = await client.users.fetch(userId);
    } catch {
      user = null;
    }
  }

  if (user?.bot) {
    return;
  }

  // Panel reactions never pass through the command dispatcher, so the Tickets
  // bot permission is enforced here as well — otherwise a denied role could
  // still open tickets from a panel. Both the server the panel lives in and the
  // server the ticket is created in get a say.
  if (await isTicketsDenied(client, message?.channel?.serverId, userId)) {
    return;
  }

  await createTicketForUser({
    client,
    userId,
    username: user?.username || 'Unknown User',
    responseChannel: message.channel,
    reason: '',
  });
}

async function isTicketsDenied(client, panelServerId: string | undefined, userId: string): Promise<boolean> {
  const serverIds = new Set([panelServerId, config.serverId].filter(Boolean) as string[]);
  for (const serverId of serverIds) {
    if ((await resolveBotPermission(client, serverId, userId, 'tickets')) === 'deny') return true;
  }
  return false;
}

function isTicketPanelMessage(message, client) {
  if (!message || !client?.user?.id) {
    return false;
  }

  if (message.authorId !== client.user.id) {
    return false;
  }

  const embeds = message.embeds || [];
  return embeds.some((embed) => embed?.title === TICKET_PANEL_TITLE);
}
