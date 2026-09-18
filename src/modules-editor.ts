/**
 * Modules editor — request handler for the dashboard `/modules` namespace.
 * Switches whole features on or off for the entire bot (see modules.ts). The
 * switches act across every server, so share-link guests never reach this
 * namespace (dashboard.ts blocks it).
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { getModule, listModules, MODULE_GROUPS, setModuleEnabled } from './modules.js';
import { isMusicLoaded } from './music/lazy.js';
import { recordAudit } from './audit.js';

const MAX_BODY_BYTES = 16 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'modules');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/modules',
  label: 'Modules',
});

export async function handleModulesEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Modules')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, snapshot());
    return;
  }

  if (method === 'POST' && pathname === '/api/module') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const key = String(body?.key || '');
    const def = getModule(key);
    if (!def) { sendJson(response, 400, { ok: false, error: 'Unknown module.' }); return; }
    const enabled = Boolean(body?.enabled);
    setModuleEnabled(key, enabled);
    // One switch covers every server, but the audit log is per server: record
    // it where it was flipped from.
    recordAudit({
      serverId: ctx.serverId,
      actorName: 'Dashboard',
      source: 'dashboard',
      area: 'modules',
      action: enabled ? 'module.enable' : 'module.disable',
      detail: def.label,
    });
    sendJson(response, 200, snapshot());
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function snapshot() {
  const memory = process.memoryUsage();
  return {
    ok: true,
    botName: config.botName,
    groups: MODULE_GROUPS,
    modules: listModules(),
    // Once imported, the music code stays in memory until a restart, even with
    // the module switched off; the page says so.
    musicLoaded: isMusicLoaded(),
    memory: { rssMb: Math.round(memory.rss / (1024 * 1024)), heapUsedMb: Math.round(memory.heapUsed / (1024 * 1024)) },
  };
}
