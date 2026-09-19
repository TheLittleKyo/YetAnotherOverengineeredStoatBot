import { config } from '../config.js';
import { requirePermission } from '../permissions.js';
import { runWithoutBotPermission } from '../bot-permissions.js';
import { startDashboard, startCloudflareDashboard } from '../dashboard.js';
import { sendDirectMessage, describeDmFailure } from '../dm.js';

/** Subcommand words that ask for the public Cloudflare link instead of the local page. */
const CLOUDFLARE_ALIASES = new Set(['cloudflare', 'cf', 'public', 'remote', 'share', 'tunnel']);

/**
 * `dashboard` — open the single local control panel that hosts every editor
 * (welcome image, embeds, roles, notifications) in one page. Replaces the
 * old per-feature `<cmd> editor` subcommands.
 *
 * `dashboard cloudflare` — admin only: expose that same panel over a Cloudflare
 * tunnel and DM the caller a full-access link (read-edit, single-use, and able
 * to mint more links from within the dashboard). The link is a bearer secret to
 * full control, so it is never posted in the channel.
 */
export async function dashboardCommand(message, args, client) {
  // Both flavors are admin-tier: Manage Server (server owners pass too).
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;

  if (CLOUDFLARE_ALIASES.has(String(args?.[0] || '').toLowerCase())) {
    await runCloudflare(message, client);
    return;
  }

  // Default the dashboard to the server the command was run in; the sidebar
  // server switcher can then point every editor at any other server the bot is
  // in, and the browser remembers the last pick.
  const defaultServerId = message.serverId || config.serverId;
  // The HTTP server, the notification scheduler and the tunnel sweep all
  // outlive this command, so they are started outside its permission context.
  const dashboard = await runWithoutBotPermission(() => startDashboard(client, defaultServerId));
  await message.channel?.send({
    content:
      `✅ Dashboard ${dashboard.reused ? 'is already running' : 'started'}: ${dashboard.url}\n` +
      `Open it on this machine. Use the **Server** switcher at the top of the sidebar to control any server the bot is in. One page, every editor:\n` +
      `• **Welcomer** — design the join image with draggable text, images, and the member avatar.\n` +
      `• **Embeds** — build and send rich embeds.\n` +
      `• **Roles** — create, recolor, set role permissions, and choose which bot features each role may use.\n` +
      `• **Notify** — watch streams and feeds.\n` +
      `• **Setup** — ticket IDs, join roles, stats channels, and server logs.\n` +
      `• **Ops** — channel sync, backups, and purge/permission command builders.\n\n` +
      `Off this machine? Run \`${config.prefix}dashboard cloudflare\` for a public link (DMed to you).`,
  });
}

/** Bring up the tunnel, mint an admin link, and DM it to the caller. */
async function runCloudflare(message, client) {
  const serverId = message.serverId || config.serverId;
  if (!serverId) {
    await message.channel?.send({ content: '❌ Run this in the server you want to control.' });
    return;
  }

  let result: Awaited<ReturnType<typeof startCloudflareDashboard>>;
  try {
    // The dashboard, tunnel and tunnel sweep all outlive this command, so they
    // start outside its bot-permission context (same as the local path).
    result = await runWithoutBotPermission(() => startCloudflareDashboard(client, serverId));
  } catch (error: any) {
    await message.channel?.send({
      content: `❌ Could not start the Cloudflare dashboard: ${error?.message || error}`,
    });
    return;
  }

  const expiresDays = Math.round((result.expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
  const dm =
    `🔗 **Cloudflare dashboard link** (server \`${serverId}\`)\n` +
    `${result.url}\n\n` +
    `• **Full access** — read & edit, and you can open **Share access** in the sidebar to hand out more links.\n` +
    `• **Single use** — the first browser to open it claims it; nobody else can reuse this link.\n` +
    `• **Expires** in ~${expiresDays} days, or when you revoke it under **Share access**.\n\n` +
    `⚠️ Anyone who opens this before you gets full control. Don't share it; open it yourself first, then mint scoped links from inside.`;

  const delivery = await sendDirectMessage(client, message.authorId, { content: dm });
  if (delivery.ok) {
    await message.channel?.send({
      content: `✅ Cloudflare dashboard is live — I've DMed you the full-access link. It's single-use, so open it before sharing anything.`,
    });
  } else {
    console.warn(`[dashboard] DM to ${message.authorId} failed (${delivery.reason}): ${delivery.detail}`);
    // Could not DM — do NOT drop a full-access link into the channel. Say why
    // the DM failed and point the caller at the local page.
    await message.channel?.send({
      content:
        `⚠️ Cloudflare dashboard is live, but I couldn't DM you the link: ${describeDmFailure(delivery)}. ` +
        `The local page is at ${result.localUrl} on the bot's machine.`,
    });
  }
}
