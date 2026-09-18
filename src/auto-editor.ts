/**
 * Automation editor — request handler for the dashboard `/auto` namespace.
 * Manages auto-responders (keyword → reply) and auto-reacts (keyword → emoji)
 * that fire on every incoming message. Backed by src/autoresponder.ts and
 * src/autoreact.ts, the same stores the chat commands use.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import {
  addAutoResponder,
  listAutoResponders,
  removeAutoResponder,
  toggleAutoResponder,
  type ResponderMatch,
} from './autoresponder.js';
import {
  addAutoReact,
  listAutoReacts,
  removeAutoReact,
  toggleAutoReact,
  type ReactMatch,
} from './autoreact.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'auto');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/auto',
  label: 'Automation',
  withPrefix: true,
});

const RESPONDER_MATCHES: ResponderMatch[] = ['contains', 'exact', 'starts', 'ends', 'regex'];
const REACT_MATCHES: ReactMatch[] = ['contains', 'exact', 'starts', 'ends', 'regex', 'all'];

export async function handleAutoEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Automation')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      prefix: config.prefix,
      serverId: ctx.serverId,
      responders: listAutoResponders(ctx.serverId),
      reactors: listAutoReacts(ctx.serverId),
      channels: await listTextChannels(ctx.client, ctx.serverId),
    });
    return;
  }

  // ---- Auto-responders ----
  if (method === 'POST' && pathname === '/api/responder') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const trigger = String(body?.trigger || '').trim();
    const responseText = String(body?.response || '').trim();
    if (!trigger || !responseText) { sendJson(response, 400, { ok: false, error: 'Trigger and response are required.' }); return; }

    const responder = addAutoResponder({
      serverId: ctx.serverId,
      trigger,
      response: responseText,
      match: normalizeResponderMatch(body?.match),
      caseSensitive: Boolean(body?.caseSensitive),
      channelId: cleanId(body?.channelId) || null,
      cooldownMs: Math.max(0, Number(body?.cooldownSec) || 0) * 1000,
      enabled: true,
    });
    sendJson(response, 200, { ok: true, responder, responders: listAutoResponders(ctx.serverId) });
    return;
  }
  const responderRoute = pathname.match(/^\/api\/responder\/([^/]+?)(\/toggle)?$/);
  if (responderRoute && method === 'PATCH' && responderRoute[2]) {
    const responder = toggleAutoResponder(decodeURIComponent(responderRoute[1]));
    sendJson(response, responder ? 200 : 404, { ok: Boolean(responder), responders: listAutoResponders(ctx.serverId), error: responder ? undefined : 'Responder not found.' });
    return;
  }
  if (responderRoute && method === 'DELETE') {
    const removed = removeAutoResponder(decodeURIComponent(responderRoute[1]));
    sendJson(response, removed ? 200 : 404, { ok: removed, responders: listAutoResponders(ctx.serverId), error: removed ? undefined : 'Responder not found.' });
    return;
  }

  // ---- Auto-reacts ----
  if (method === 'POST' && pathname === '/api/react') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const match = normalizeReactMatch(body?.match);
    const trigger = String(body?.trigger || '').trim();
    const emojis = normalizeEmojis(body?.emojis);
    if (emojis.length === 0) { sendJson(response, 400, { ok: false, error: 'At least one emoji is required.' }); return; }
    if (match !== 'all' && !trigger) { sendJson(response, 400, { ok: false, error: 'A trigger is required unless match is "all".' }); return; }

    const reactor = addAutoReact({
      serverId: ctx.serverId,
      trigger,
      emojis,
      match,
      caseSensitive: Boolean(body?.caseSensitive),
      channelId: cleanId(body?.channelId) || null,
      enabled: true,
    });
    sendJson(response, 200, { ok: true, reactor, reactors: listAutoReacts(ctx.serverId) });
    return;
  }
  const reactRoute = pathname.match(/^\/api\/react\/([^/]+?)(\/toggle)?$/);
  if (reactRoute && method === 'PATCH' && reactRoute[2]) {
    const reactor = toggleAutoReact(decodeURIComponent(reactRoute[1]));
    sendJson(response, reactor ? 200 : 404, { ok: Boolean(reactor), reactors: listAutoReacts(ctx.serverId), error: reactor ? undefined : 'Auto-react not found.' });
    return;
  }
  if (reactRoute && method === 'DELETE') {
    const removed = removeAutoReact(decodeURIComponent(reactRoute[1]));
    sendJson(response, removed ? 200 : 404, { ok: removed, reactors: listAutoReacts(ctx.serverId), error: removed ? undefined : 'Auto-react not found.' });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function normalizeResponderMatch(value: any): ResponderMatch {
  const v = String(value || '').toLowerCase();
  return (RESPONDER_MATCHES as string[]).includes(v) ? (v as ResponderMatch) : 'contains';
}

function normalizeReactMatch(value: any): ReactMatch {
  const v = String(value || '').toLowerCase();
  return (REACT_MATCHES as string[]).includes(v) ? (v as ReactMatch) : 'contains';
}

function normalizeEmojis(value: any): string[] {
  const raw = Array.isArray(value) ? value : String(value || '').split(/\s+/);
  const out: string[] = [];
  for (const item of raw) {
    const emoji = normalizeEmojiInput(String(item || ''));
    if (emoji && !out.includes(emoji)) out.push(emoji);
  }
  return out;
}

function normalizeEmojiInput(raw: string): string {
  const input = raw.trim();
  if (!input) return '';
  const custom = input.match(/^<a?:[^:>]+:([A-Za-z0-9_-]+)>$/);
  return custom?.[1] || input;
}

// Best-effort list of text channels for the dropdowns, merged from the API and
// the client cache so it works even when the cache is cold.
