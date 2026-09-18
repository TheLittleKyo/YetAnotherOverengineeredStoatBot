/**
 * Debug editor — request handler for the dashboard `/debug` namespace, the
 * page that holds diagnostic tools. Today that is channel sync diagnostics,
 * the dashboard counterpart of the `sync debug` chat commands.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listServersWithChannels, listTextChannels } from './editor-lists.js';
import { visibleSyncLinks } from './sync-editor.js';
import {
  getSyncDiagnostics,
  listMirrorRows,
  probeSyncLink,
  pruneSyncLedger,
  remirrorMessage,
  scanSyncLink,
  setSyncCursor,
  traceSyncMessage,
} from './sync.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'debug');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/debug',
  label: 'Debug',
});

export async function handleDebugEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Debug')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, { ok: true, botName: config.botName, serverId: ctx.serverId, syncLinks: await visibleSyncLinks(ctx.client, ctx.serverId), channels: await listTextChannels(ctx.client, ctx.serverId), servers: await listServersWithChannels(ctx.client) });
    return;
  }

  if (pathname.startsWith('/api/sync/debug/')) {
    await handleSyncDebugRequest(request, response, ctx, method, pathname.slice('/api/sync/debug/'.length), url);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

/**
 * Sync diagnostics — the dashboard counterpart of the `sync debug` chat
 * commands. Link-scoped tools only accept links visible from the active server,
 * matching what the Channel sync card lists; ledger-wide tools (status, trace,
 * prune) span every link because the ledger itself is global.
 */
async function handleSyncDebugRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: { client: any; serverId: string },
  method: string,
  route: string,
  url: URL,
) {
  try {
    if (method === 'GET' && route === 'status') {
      const visible = new Set((await visibleSyncLinks(ctx.client, ctx.serverId)).map((link: any) => link.id));
      const diag = getSyncDiagnostics();
      sendJson(response, 200, { ok: true, ...diag, links: diag.links.filter((link) => visible.has(link.id)) });
      return;
    }

    if (method === 'GET' && route === 'ledger') {
      const linkId = url.searchParams.get('linkId') || '';
      if (linkId && !(await findVisibleLink(ctx, linkId))) { sendJson(response, 404, { ok: false, error: 'Link not found.' }); return; }
      const limit = Number(url.searchParams.get('limit')) || 25;
      sendJson(response, 200, { ok: true, rows: listMirrorRows({ linkId: linkId || undefined, limit }) });
      return;
    }

    if (method === 'GET' && route === 'trace') {
      const messageId = cleanId(url.searchParams.get('messageId'));
      if (!messageId) { sendJson(response, 400, { ok: false, error: 'Enter a message ID.' }); return; }
      sendJson(response, 200, { ok: true, trace: await traceSyncMessage(ctx.client, messageId) });
      return;
    }

    if (method !== 'POST') { sendJson(response, 404, { ok: false, error: 'Not found.' }); return; }
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });

    if (route === 'prune') {
      sendJson(response, 200, { ok: true, result: await pruneSyncLedger(ctx.client, { apply: body?.apply === true, limit: Number(body?.limit) || undefined }) });
      return;
    }

    // Everything below acts on one link.
    const link = await findVisibleLink(ctx, String(body?.linkId || ''));
    if (!link) { sendJson(response, 404, { ok: false, error: 'Link not found.' }); return; }
    const direction = body?.direction === 'target' ? 'target' : body?.direction === 'source' ? 'source' : undefined;

    if (route === 'scan') {
      const report = await scanSyncLink(ctx.client, link.id, {
        limit: Number(body?.limit) || undefined,
        apply: body?.apply === true,
        direction: body?.direction === 'both' ? 'both' : direction,
      });
      sendJson(response, 200, { ok: true, report });
      return;
    }

    if (route === 'probe') {
      sendJson(response, 200, { ok: true, result: await probeSyncLink(ctx.client, link.id, direction || 'source') });
      return;
    }

    if (route === 'cursor') {
      const action = String(body?.action || '');
      if (action !== 'reset' && action !== 'set') { sendJson(response, 400, { ok: false, error: 'Unknown cursor action.' }); return; }
      const value = action === 'set' ? cleanId(body?.value) : null;
      if (action === 'set' && !value) { sendJson(response, 400, { ok: false, error: 'Enter the message ID to resume after.' }); return; }
      const updated = setSyncCursor(link.id, direction || 'source', value);
      sendJson(response, 200, { ok: true, link: updated });
      return;
    }

    if (route === 'replay') {
      const messageId = cleanId(body?.messageId);
      if (!messageId) { sendJson(response, 400, { ok: false, error: 'Enter a message ID.' }); return; }
      sendJson(response, 200, { ok: true, result: await remirrorMessage(ctx.client, link.id, messageId) });
      return;
    }

    sendJson(response, 404, { ok: false, error: 'Not found.' });
  } catch (e: any) {
    sendJson(response, 400, { ok: false, error: e?.message || 'Sync debug request failed.' });
  }
}

async function findVisibleLink(ctx: { client: any; serverId: string }, linkId: string) {
  if (!linkId) return null;
  const links = await visibleSyncLinks(ctx.client, ctx.serverId);
  return links.find((link: any) => link.id === linkId) || null;
}

