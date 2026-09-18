/**
 * Setup editor — request handler for the dashboard `/setup` namespace.
 * One tab that edits the config-shaped features that previously only had
 * chat commands: ticket IDs, join roles, stats channels, and server logs —
 * plus the bot's own branding (name and logo) and command prefix, which are
 * bot-wide rather than per-server and so are owner-only.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config, prefixError, prefixView, updateRuntimePrefix, updateTicketRuntimeConfig } from './config.js';
import { brandingView, clearLogo, setBrandName, setLogoFromDataUri, MAX_LOGO_BYTES } from './branding.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels, listChannels, listRoles, listCategories } from './editor-lists.js';
import { getJoinRoleIds, addJoinRole, removeJoinRole } from './join-roles.js';
import { getStatsChannels, upsertStatsChannel, removeStatsChannel, refreshStatsChannels, type StatsChannelEntry } from './stats.js';
import { getLogConfig, setLogChannel, disableLogChannel } from './log-system.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
// A logo arrives base64-encoded inside JSON, so the body cap has to clear the
// raw limit by a third plus the envelope.
const MAX_BRAND_BODY_BYTES = Math.ceil(MAX_LOGO_BYTES * 1.5) + 8 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'setup');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/setup',
  label: 'Setup',
});

export async function handleSetupEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string; guest?: boolean }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) {
    sendHtml(response, renderEditorPage('Setup'));
    return;
  }
  if (method === 'GET' && pathname === '/editor.css') {
    sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css');
    return;
  }
  if (method === 'GET' && pathname === '/editor-app.js') {
    editorApp.send(response);
    return;
  }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      // Guests see these as read-only context; the cards are hidden.
      guest: !!ctx.guest,
      branding: brandingView(),
      ...prefixView(),
      tickets: {
        openTicketsCategoryId: config.openTicketsCategoryId || '',
        closedTicketsCategoryId: config.closedTicketsCategoryId || '',
        transcriptChannelId: config.transcriptChannelId || '',
        supportRoleId: config.supportRoleId || '',
      },
      joinRoles: getJoinRoleIds(ctx.serverId),
      stats: getStatsChannels(ctx.serverId),
      logs: getLogConfig(ctx.serverId),
      channels: await listTextChannels(ctx.client, ctx.serverId),
      allChannels: await listChannels(ctx.client, ctx.serverId),
      roles: await listRoles(ctx.client, ctx.serverId),
      categories: await listCategories(ctx.client, ctx.serverId),
    });
    return;
  }

  // Name and logo. Bot-wide, so a share-link guest can never change them even
  // with a read-edit link: renaming the bot is not "editing this server".
  if (method === 'POST' && pathname === '/api/brand') {
    if (!allowBotWideChange(ctx, response)) return;
    let body: any;
    try {
      body = await readJsonBody(request, { maxBytes: MAX_BRAND_BODY_BYTES, reportLimit: true });
    } catch (error: any) {
      sendJson(response, 413, { ok: false, error: error?.message || 'Request body too large.' });
      return;
    }
    // `name` and `logo` are independent: a field that was not sent is left
    // alone, and an explicitly empty one resets to the default.
    if (hasField(body, 'name')) setBrandName(body.name);
    if (hasField(body, 'logo')) {
      const logo = String(body.logo ?? '').trim();
      if (!logo) {
        clearLogo();
      } else {
        const error = setLogoFromDataUri(logo);
        if (error) { sendJson(response, 400, { ok: false, error }); return; }
      }
    }
    sendJson(response, 200, { ok: true, branding: brandingView(), botName: config.botName });
    return;
  }

  // Command prefix. Bot-wide and owner-only, like branding.
  if (method === 'POST' && pathname === '/api/prefix') {
    if (!allowBotWideChange(ctx, response)) return;
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const error = prefixError(body?.prefix);
    if (error) { sendJson(response, 400, { ok: false, error }); return; }
    updateRuntimePrefix(body?.prefix);
    sendJson(response, 200, { ok: true, ...prefixView() });
    return;
  }

  if (method === 'POST' && pathname === '/api/tickets') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    updateTicketRuntimeConfig({
      openTicketsCategoryId: cleanId(body?.openTicketsCategoryId),
      closedTicketsCategoryId: cleanId(body?.closedTicketsCategoryId),
      transcriptChannelId: cleanId(body?.transcriptChannelId),
      supportRoleId: cleanId(body?.supportRoleId),
    });
    sendJson(response, 200, { ok: true, tickets: {
      openTicketsCategoryId: config.openTicketsCategoryId || '',
      closedTicketsCategoryId: config.closedTicketsCategoryId || '',
      transcriptChannelId: config.transcriptChannelId || '',
      supportRoleId: config.supportRoleId || '',
    } });
    return;
  }

  if (method === 'POST' && pathname === '/api/joinroles') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const roleId = cleanId(body?.roleId);
    if (!roleId) { sendJson(response, 400, { ok: false, error: 'A role ID is required.' }); return; }
    sendJson(response, 200, { ok: true, joinRoles: addJoinRole(roleId, ctx.serverId) });
    return;
  }
  const joinRoleRoute = pathname.match(/^\/api\/joinroles\/([^/]+)$/);
  if (joinRoleRoute && method === 'DELETE') {
    sendJson(response, 200, { ok: true, joinRoles: removeJoinRole(decodeURIComponent(joinRoleRoute[1]), ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/stats') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const channelId = cleanId(body?.channelId);
    const mode = body?.mode === 'role' ? 'role' : 'all';
    const roleId = cleanId(body?.roleId);
    if (!channelId) { sendJson(response, 400, { ok: false, error: 'A channel ID is required.' }); return; }
    if (mode === 'role' && !roleId) { sendJson(response, 400, { ok: false, error: 'Role mode needs a role ID.' }); return; }
    const entry: StatsChannelEntry = { channelId, mode, roleId: mode === 'role' ? roleId : undefined, label: String(body?.label || '').trim().slice(0, 60) || undefined, serverId: ctx.serverId };
    upsertStatsChannel(entry);
    sendJson(response, 200, { ok: true, stats: getStatsChannels(ctx.serverId) });
    return;
  }
  const statsRoute = pathname.match(/^\/api\/stats\/([^/]+)$/);
  if (statsRoute && method === 'DELETE') {
    removeStatsChannel(decodeURIComponent(statsRoute[1]));
    sendJson(response, 200, { ok: true, stats: getStatsChannels(ctx.serverId) });
    return;
  }
  if (method === 'POST' && pathname === '/api/stats/refresh') {
    const result = await refreshStatsChannels(ctx.client, ctx.serverId);
    sendJson(response, 200, { ok: true, result, stats: getStatsChannels(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/logs') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const channelId = cleanId(body?.channelId);
    if (!channelId) { sendJson(response, 400, { ok: false, error: 'A channel ID is required.' }); return; }
    sendJson(response, 200, { ok: true, logs: setLogChannel(channelId, ctx.serverId) });
    return;
  }
  if (method === 'POST' && pathname === '/api/logs/disable') {
    sendJson(response, 200, { ok: true, logs: disableLogChannel(ctx.serverId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

/**
 * Guard for the settings that are not per-server (branding, prefix): a
 * share-link guest may edit the server it was given, never the bot itself.
 * Answers the request on refusal and reports whether the caller may continue.
 */
function allowBotWideChange(ctx: { guest?: boolean }, response: ServerResponse): boolean {
  if (!ctx.guest) return true;
  sendJson(response, 403, { ok: false, error: 'This can only be changed from the local dashboard.' });
  return false;
}
