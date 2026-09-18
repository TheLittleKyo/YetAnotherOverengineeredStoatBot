/**
 * Free Stuff editor — request handler for the dashboard tab that configures
 * the free-games / deals feed. Mounted under the `/freestuff` namespace.
 *
 * Unlike the notify editor (a list of subscriptions), this manages a single
 * per-server config object: channel, sources, GamerPower platform/type
 * filters, and CheapShark discount + per-store toggles.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, sendHtml, sendJson, sendText } from './editor-server.js';
import { listTextChannels, listRoles } from './editor-lists.js';
import {
  getConfig,
  getOrCreateConfig,
  updateConfig,
  fetchOffersForConfig,
  CHEAPSHARK_STORES,
} from './giveaways/index.js';
import type { FreeStuffConfig } from './giveaways/index.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'freestuff');
const editorApp = createEditorBundler({ assetDir: EDITOR_ASSET_DIR, apiBase: '/freestuff', label: 'Free Stuff' });

/** GamerPower platform filter chips offered in the UI (keyword matched). */
const GAMERPOWER_PLATFORMS = [
  'PC', 'Steam', 'Epic', 'GOG', 'Itch.io', 'Ubisoft', 'EA', 'Origin',
  'Xbox', 'PlayStation', 'Switch', 'Android', 'iOS', 'DRM-Free', 'VR',
];
const GAMERPOWER_TYPES = ['game', 'loot', 'dlc', 'beta', 'early access', 'other'];

export async function handleFreeStuffEditorRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: { client: any; serverId: string },
) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }
  const pathname = url.pathname;

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendHtml(response, buildEditorHtml());
    return;
  }

  if (pathname === '/app.js') {
    sendAsset(response, 'application/javascript; charset=utf-8', 'app.ts');
    return;
  }

  if (pathname === '/style.css') {
    sendAsset(response, 'text/css; charset=utf-8', 'style.css');
    return;
  }

  if (pathname === '/api/config') {
    if (request.method === 'GET') {
      const cfg = getConfig(ctx.serverId) || getOrCreateConfig(ctx.serverId);
      sendJson(response, 200, {
        ok: true,
        botName: config.botName,
        serverId: ctx.serverId,
        config: cfg,
        stores: CHEAPSHARK_STORES,
        gamerpowerPlatforms: GAMERPOWER_PLATFORMS,
        gamerpowerTypes: GAMERPOWER_TYPES,
        channels: await listTextChannels(ctx.client, ctx.serverId),
        roles: await listRoles(ctx.client, ctx.serverId),
      });
      return;
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
      const patch = sanitizePatch(body);
      const cfg = updateConfig(ctx.serverId, patch);
      sendJson(response, 200, { ok: true, config: cfg });
      return;
    }
  }

  if (pathname === '/api/test' && request.method === 'POST') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES }).catch(() => ({}));
    // Test against the posted (unsaved) config so the preview reflects the form.
    const base = getConfig(ctx.serverId) || getOrCreateConfig(ctx.serverId);
    const merged: FreeStuffConfig = { ...base, ...sanitizePatch(body || {}) } as FreeStuffConfig;
    const { offers, errors } = await fetchOffersForConfig(merged);
    sendJson(response, 200, { ok: true, offers: offers.slice(0, 12), errors });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found' });
}

/** Whitelist + coerce incoming config fields. */
function sanitizePatch(body: any): Partial<FreeStuffConfig> {
  const patch: Partial<FreeStuffConfig> = {};
  if (typeof body?.channelId === 'string') patch.channelId = body.channelId.trim();
  if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
  if (body?.sources && typeof body.sources === 'object') {
    patch.sources = {
      gamerpower: Boolean(body.sources.gamerpower),
      cheapshark: Boolean(body.sources.cheapshark),
    };
  }
  if (Array.isArray(body?.platforms)) patch.platforms = body.platforms.map((s: any) => String(s).toLowerCase().trim()).filter(Boolean);
  if (Array.isArray(body?.types)) patch.types = body.types.map((s: any) => String(s).toLowerCase().trim()).filter(Boolean);
  if (Array.isArray(body?.stores)) patch.stores = body.stores.map((s: any) => String(s).trim()).filter(Boolean);
  if (body?.minSavings !== undefined) {
    const n = Math.round(Number(body.minSavings));
    if (Number.isFinite(n)) patch.minSavings = Math.min(Math.max(n, 0), 100);
  }
  if (typeof body?.onlyFreeDeals === 'boolean') patch.onlyFreeDeals = body.onlyFreeDeals;
  if (typeof body?.mentionRole === 'string') patch.mentionRole = body.mentionRole.replace(/[<@&>]/g, '').trim() || undefined;
  else if (body?.mentionRole === null) patch.mentionRole = undefined;
  return patch;
}

function buildEditorHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YetAnotherOverengineeredStoatBot — Free Stuff Editor</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<div id="root"></div>
<script src="/app.js" type="module"></script>
</body>
</html>`;
}

function sendAsset(response: ServerResponse, contentType: string, fileName: string) {
  try {
    // `app.ts` is the browser entry point: serve the esbuild bundle, not the source.
    const content = fileName.endsWith('.ts')
      ? editorApp.build()
      : readFileSync(join(EDITOR_ASSET_DIR, fileName), 'utf-8');
    sendText(response, contentType, content);
  } catch (error: any) {
    console.error('Free Stuff editor asset failed:', error?.message || error);
    sendJson(response, 500, { ok: false, error: 'Editor asset failed.' });
  }
}
