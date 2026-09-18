/**
 * Notify editor — request handler that manages notification subscriptions
 * via a browser UI (like the embed/role/welcome editors). Mounted by the
 * dashboard under the `/notify` namespace.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config, env } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, sendHtml, sendJson, sendText } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import {
  getSubscriptions,
  addSubscription,
  removeSubscription,
  generateSubscriptionId,
  getProviderInfos,
  getProvider,
} from './notifications/index.js';
import type { Subscription, PlatformId } from './notifications/index.js';

const MAX_BODY_BYTES = env.notifyEditorMaxBodyBytes;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'notify');
const editorApp = createEditorBundler({ assetDir: EDITOR_ASSET_DIR, apiBase: '/notify', label: 'Notify' });

export async function handleNotifyEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }
  const pathname = url.pathname;

  if (request.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    sendHtml(response, buildEditorHtml(ctx));
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
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      providers: getProviderInfos(),
      channels: await listTextChannels(ctx.client, ctx.serverId),
    });
    return;
  }

  if (pathname === '/api/subscriptions') {
    if (request.method === 'GET') {
      const all = getSubscriptions();
      const filtered = ctx.serverId ? all.filter((s) => s.serverId === ctx.serverId) : all;
      sendJson(response, 200, { ok: true, subscriptions: filtered });
      return;
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
      const result = createSubscription(body, ctx.serverId);
      sendJson(response, result.ok ? 200 : 400, result);
      return;
    }
  }

  if (pathname.startsWith('/api/subscriptions/') && request.method === 'DELETE') {
    const id = decodeURIComponent(pathname.slice('/api/subscriptions/'.length));
    const removed = removeSubscription(id);
    sendJson(response, removed ? 200 : 404, { ok: removed, error: removed ? undefined : 'Not found' });
    return;
  }

  if (pathname.startsWith('/api/test/') && request.method === 'POST') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const result = await testSubscription(body);
    sendJson(response, 200, result);
    return;
  }

  if (pathname.startsWith('/api/subscriptions/') && request.method === 'PATCH') {
    const id = decodeURIComponent(pathname.slice('/api/subscriptions/'.length));
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const result = updateSubscription(id, body);
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found' });
}

function createSubscription(body: any, serverId: string): { ok: boolean; subscription?: Subscription; error?: string } {
  const platform = String(body?.platform || '').toLowerCase() as PlatformId;
  const target = String(body?.target || '').trim();
  const channelId = String(body?.channelId || '').trim();
  const extra = body?.extra && typeof body.extra === 'object' ? body.extra : {};

  if (!platform || !target || !channelId) {
    return { ok: false, error: 'platform, target, and channelId are required.' };
  }

  const infos = getProviderInfos();
  const info = infos.find((p) => p.id === platform);
  if (!info) {
    return { ok: false, error: `Unknown platform: ${platform}` };
  }

  if (info.extraFields) {
    for (const field of info.extraFields) {
      if (field.required && !extra[field.key]) {
        return { ok: false, error: `Missing required field: ${field.key}` };
      }
    }
  }

  const subscription: Subscription = {
    id: generateSubscriptionId(),
    platform,
    target,
    channelId,
    serverId,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
    createdAt: new Date().toISOString(),
    enabled: body?.enabled !== false,
  };

  addSubscription(subscription);
  return { ok: true, subscription };
}

function updateSubscription(id: string, body: any): { ok: boolean; subscription?: Subscription; error?: string } {
  const subs = getSubscriptions();
  const existing = subs.find((s) => s.id === id);
  if (!existing) return { ok: false, error: 'Subscription not found.' };

  if (body?.enabled !== undefined) existing.enabled = Boolean(body.enabled);
  if (typeof body?.target === 'string') existing.target = body.target.trim();
  if (typeof body?.channelId === 'string') existing.channelId = body.channelId.trim();
  if (body?.extra && typeof body.extra === 'object') existing.extra = body.extra;

  // Re-save (addSubscription is idempotent on platform+target+channelId).
  addSubscription(existing);
  return { ok: true, subscription: existing };
}

async function testSubscription(body: any): Promise<{ ok: boolean; result?: any; error?: string }> {
  const platform = String(body?.platform || '').toLowerCase() as PlatformId;
  const target = String(body?.target || '').trim();
  const extra = body?.extra || {};

  if (!platform || !target) {
    return { ok: false, error: 'platform and target are required.' };
  }

  const provider = getProvider(platform);
  if (!provider) return { ok: false, error: `Unknown platform: ${platform}` };

  try {
    const result = await provider.poll(
      { id: 'test', platform, target, channelId: '', serverId: '', createdAt: '', enabled: true, extra },
      undefined,
    );
    return { ok: true, result };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

function buildEditorHtml(ctx: { serverId: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>YetAnotherOverengineeredStoatBot — Notify Editor</title>
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
    console.error('Notify editor asset failed:', error?.message || error);
    sendJson(response, 500, { ok: false, error: 'Editor asset failed.' });
  }
}
