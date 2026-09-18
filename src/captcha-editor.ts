/**
 * Captcha editor — request handler for the dashboard `/captcha` namespace.
 * Configures the anti-bot captcha (trigger, verified role, length, cooldown,
 * DM text). Backed by src/captcha.ts.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listRoles } from './editor-lists.js';
import { getCaptchaConfig, setCaptchaConfig, getCaptchaRuntimeStatus, type CaptchaConfig } from './captcha.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'captcha');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/captcha',
  label: 'Captcha',
  withPrefix: true,
});

export async function handleCaptchaEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Captcha')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      settings: getCaptchaConfig(ctx.serverId),
      status: getCaptchaRuntimeStatus(),
      roles: await listRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const updates = sanitizeSettings(body);
    const settings = setCaptchaConfig(ctx.serverId, updates);
    sendJson(response, 200, { ok: true, settings, status: getCaptchaRuntimeStatus() });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function sanitizeSettings(body: any): Partial<CaptchaConfig> {
  const out: Partial<CaptchaConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'triggerOnJoin')) out.triggerOnJoin = Boolean(body.triggerOnJoin);
  if (hasField(body, 'triggerOnReaction')) out.triggerOnReaction = Boolean(body.triggerOnReaction);
  if (hasField(body, 'roleId')) out.roleId = cleanId(body.roleId) || null;
  if (hasField(body, 'reactionMessageId')) out.reactionMessageId = cleanId(body.reactionMessageId) || null;
  if (hasField(body, 'reactionEmoji')) out.reactionEmoji = body.reactionEmoji ? String(body.reactionEmoji).trim().slice(0, 64) : null;
  if (hasField(body, 'minLength')) out.minLength = Number(body.minLength);
  if (hasField(body, 'maxLength')) out.maxLength = Number(body.maxLength);
  if (hasField(body, 'maxAttempts')) out.maxAttempts = Number(body.maxAttempts);
  if (hasField(body, 'cooldownMinutes')) out.cooldownMinutes = Number(body.cooldownMinutes);
  if (hasField(body, 'expiryMinutes')) out.expiryMinutes = Number(body.expiryMinutes);
  if (hasField(body, 'dmMessage')) out.dmMessage = String(body.dmMessage || '').slice(0, 1000);
  return out;
}
