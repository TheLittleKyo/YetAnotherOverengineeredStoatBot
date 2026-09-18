/**
 * Sync editor — request handler for the dashboard `/sync` namespace, the
 * Channel sync page: live links between channels (in any server the bot is
 * in), their filters, and one-off channel copies. Diagnostics for the same
 * links live on the Debug tools page (debug-editor.ts).
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listRoles, listServersWithChannels, listTextChannels } from './editor-lists.js';
import {
  addSyncLink,
  copyChannelContent,
  getSyncLinkActivity,
  listSyncLinks,
  removeSyncLink,
  updateSyncLink,
} from './sync.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'sync');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/sync',
  label: 'Sync',
});

export async function handleSyncEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Channel sync')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      links: await linksForPage(ctx.client, ctx.serverId),
      servers: await listServersWithChannels(ctx.client),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/link') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    try {
      const link = addSyncLink(cleanId(body?.source), cleanId(body?.target), body?.mode === 'twoway' ? 'twoway' : 'oneway', body?.label);
      // Filters are set in the same step as the channels on this page.
      if (hasField(body, 'filters')) updateSyncLink(link.id, { filters: body.filters });
      sendJson(response, 200, { ok: true, id: link.id, links: await linksForPage(ctx.client, ctx.serverId) });
    } catch (e: any) { sendJson(response, 400, { ok: false, error: e?.message || 'Could not create the link.' }); }
    return;
  }

  const linkRoute = pathname.match(/^\/api\/link\/([^/]+)$/);
  if (linkRoute && method === 'PATCH') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    try {
      const link = updateSyncLink(decodeURIComponent(linkRoute[1]), {
        label: hasField(body, 'label') ? String(body.label || '') : undefined,
        sourceChannelId: hasField(body, 'source') ? cleanId(body.source) : undefined,
        targetChannelId: hasField(body, 'target') ? cleanId(body.target) : undefined,
        mode: body?.mode === 'twoway' ? 'twoway' : body?.mode === 'oneway' ? 'oneway' : undefined,
        filters: hasField(body, 'filters') ? body.filters : undefined,
      });
      sendJson(response, link ? 200 : 404, {
        ok: Boolean(link),
        links: await linksForPage(ctx.client, ctx.serverId),
        error: link ? undefined : 'That link no longer exists.',
      });
    } catch (e: any) { sendJson(response, 400, { ok: false, error: e?.message || 'Could not update the link.' }); }
    return;
  }
  if (linkRoute && method === 'DELETE') {
    const removed = removeSyncLink(decodeURIComponent(linkRoute[1]));
    sendJson(response, removed ? 200 : 404, {
      ok: removed > 0,
      links: await linksForPage(ctx.client, ctx.serverId),
      error: removed ? undefined : 'That link no longer exists.',
    });
    return;
  }

  // Role choices for a link's filters, from the servers its two channels are
  // in. One API call per server, so it is only loaded when the editor opens.
  if (method === 'GET' && pathname === '/api/roles') {
    const serverIds = [...new Set(url.searchParams.getAll('serverId').map(cleanId).filter(Boolean))].slice(0, 2);
    const roles = [];
    for (const serverId of serverIds) {
      // Only servers the bot is in — the same set the channel pickers offer.
      const server = ctx.client?.servers?.cache?.get?.(serverId);
      if (!server) continue;
      const serverName = String(server.name || serverId);
      for (const role of await listRoles(ctx.client, serverId)) roles.push({ ...role, serverId, serverName });
    }
    sendJson(response, 200, { ok: true, roles });
    return;
  }

  if (method === 'POST' && pathname === '/api/copy') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    try {
      const summary = await copyChannelContent(ctx.client, cleanId(body?.source), cleanId(body?.target));
      sendJson(response, 200, { ok: true, summary });
    } catch (e: any) { sendJson(response, 400, { ok: false, error: e?.message || 'Copy failed.' }); }
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

async function linksForPage(client: any, serverId: string) {
  const activity = getSyncLinkActivity();
  return (await visibleSyncLinks(client, serverId)).map((link) => ({
    ...link,
    copies: activity[link.id]?.copies || 0,
    lastCopyAt: activity[link.id]?.lastAt || null,
  }));
}

// Sync links that touch the given server: a link shows on a server when its
// source OR target channel belongs to that server. A 2-way link between two
// servers is therefore visible from both; a 1-way link shows on whichever
// server owns an endpoint. Falls back to all links if the channel set can't
// be resolved (cold cache), so nothing silently disappears.
export async function visibleSyncLinks(client: any, serverId: string) {
  const links = listSyncLinks();
  try {
    const channels = await listTextChannels(client, serverId);
    const ids = new Set(channels.map((c) => c.id));
    if (ids.size > 0) {
      const filtered = links.filter((l: any) => ids.has(l.sourceChannelId) || ids.has(l.targetChannelId));
      return withChannelNames(client, filtered);
    }
  } catch { /* fall through to all links */ }
  return withChannelNames(client, links);
}

// Attach human-readable channel names so links are recognizable in the UI.
function withChannelNames(client: any, links: any[]) {
  return links.map((link) => ({
    ...link,
    sourceName: resolveChannelName(client, link.sourceChannelId),
    targetName: resolveChannelName(client, link.targetChannelId),
  }));
}

function resolveChannelName(client: any, channelId: string): string | null {
  const channel = client?.channels?.cache?.get?.(channelId);
  const name = channel?.name || channel?.title || channel?.displayName || channel?.display_name;
  return name ? String(name).trim() : null;
}
