import { config } from '../config.js';
import { requirePermission } from '../permissions.js';

export async function embedCommand(message, args, client) {
  const sub = String(args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  // The embed editor can send embeds to any channel — gate it behind Manage Server.
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;

  await sendHelp(message);
}

async function sendHelp(message) {
  await message.channel?.send({
    content:
      `# 🧩 Embed Creator Help\n\n` +
      `\`${config.prefix}dashboard\` - Open the dashboard and use the **Embeds** tab.\n` +
      `There you can edit message content, title, description, color, and title URL, preview live, save embeds, and send them to a channel by ID.`,
  });
}