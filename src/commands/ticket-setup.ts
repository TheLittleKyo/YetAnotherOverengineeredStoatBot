import { getMissingTicketConfig, updateTicketRuntimeConfig } from '../config.js';
import { config } from '../config.js';
import { logTicketAction } from '../log-system.js';
import { requirePermission } from '../permissions.js';
import { normalizeId } from '../id-utils.js';

/**
 * Configure runtime ticket IDs without editing .env.
 * Usage: !ticket setup <openCategoryId> <closedCategoryId> <transcriptChannelId> <supportRoleId>
 */
export async function ticketSetup(message, args, client) {
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;

  if (args.length < 4) {
    await message.channel?.send({
      content:
        `❌ Missing arguments.\n` +
        `Usage: \`${config.prefix}ticket setup <openCategoryId> <closedCategoryId> <transcriptChannelId> <supportRoleId>\`\n` +
        `You can use raw IDs or tag formats like <#channelId> and <%roleId>.`,
    });
    return;
  }

  const [openRaw, closedRaw, transcriptRaw, supportRaw] = args;
  const openTicketsCategoryId = normalizeId(openRaw);
  const closedTicketsCategoryId = normalizeId(closedRaw);
  const transcriptChannelId = normalizeId(transcriptRaw);
  const supportRoleId = normalizeId(supportRaw);

  const invalid = [
    ['openCategoryId', openTicketsCategoryId],
    ['closedCategoryId', closedTicketsCategoryId],
    ['transcriptChannelId', transcriptChannelId],
    ['supportRoleId', supportRoleId],
  ].filter(([, id]) => !id);

  if (invalid.length > 0) {
    await message.channel?.send({
      content: `❌ Invalid ID(s): ${invalid.map(([name]) => name).join(', ')}. Please provide valid IDs.`,
    });
    return;
  }

  updateTicketRuntimeConfig({
    serverId: message?.serverId,
    openTicketsCategoryId,
    closedTicketsCategoryId,
    transcriptChannelId,
    supportRoleId,
  });

  const missing = getMissingTicketConfig([
    'openTicketsCategoryId',
    'closedTicketsCategoryId',
    'transcriptChannelId',
    'supportRoleId',
  ]);

  if (missing.length > 0) {
    await message.channel?.send({
      content: `⚠️ Saved, but configuration is still incomplete: ${missing.join(', ')}`,
    });
    return;
  }

  await message.channel?.send({
    content:
      `✅ Ticket configuration saved successfully.\n` +
      `• Open Category: \`${openTicketsCategoryId}\`\n` +
      `• Closed Category: \`${closedTicketsCategoryId}\`\n` +
      `• Transcript Channel: <#${transcriptChannelId}> (\`${transcriptChannelId}\`)\n` +
      `• Support Role: <%${supportRoleId}> (\`${supportRoleId}\`)\n` +
      `• Server: \`${message?.serverId || 'unknown'}\`\n\n` +
      `Stored in \`data/config.json\` (no .env edit needed for these IDs).`,
  });
  await logTicketAction(client, {
    action: 'Ticket configuration updated',
    executorId: message.authorId,
    details:
      `Open Category: ${openTicketsCategoryId}\n` +
      `Closed Category: ${closedTicketsCategoryId}\n` +
      `Transcript Channel: ${transcriptChannelId}\n` +
      `Support Role: ${supportRoleId}`,
  });
}
