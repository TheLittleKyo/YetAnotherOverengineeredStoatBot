/**
 * Antiraid editor — request handler for the dashboard `/antiraid` namespace.
 * Configures raid protection (join-rate detection, account-age gate, actions)
 * and can force raid mode on/off or create a honeypot channel. Backed by
 * src/antiraid.ts.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import {
  getAntiraidConfig,
  setAntiraidConfig,
  getRaidStatus,
  setRaidActive,
  createHoneypotChannel,
  inspectHoneypotChannel,
  type AntiraidConfig,
  type RaidAction,
  type AgeAction,
} from './antiraid.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'antiraid');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/antiraid',
  label: 'Antiraid',
  withPrefix: true,
});

const RAID_ACTIONS: RaidAction[] = ['kick', 'ban', 'alert'];
const AGE_ACTIONS: AgeAction[] = ['kick', 'ban', 'alert', 'off'];

export async function handleAntiraidEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Antiraid')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      settings: getAntiraidConfig(ctx.serverId),
      raid: getRaidStatus(ctx.serverId),
      channels: await listTextChannels(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const updates = sanitizeSettings(body);
    const current = getAntiraidConfig(ctx.serverId);

    const nextHoneypot = hasField(updates, 'honeypotChannelId') ? updates.honeypotChannelId : current.honeypotChannelId;
    if (updates.alertChannelId && updates.alertChannelId === nextHoneypot) {
      sendJson(response, 400, { ok: false, error: 'The alert channel cannot be the honeypot channel.' });
      return;
    }

    if (updates.honeypotChannelId && updates.honeypotChannelId !== current.honeypotChannelId) {
      const check = await inspectHoneypotChannel(ctx.client, ctx.serverId, updates.honeypotChannelId);
      if ('error' in check) { sendJson(response, 400, { ok: false, error: check.error }); return; }
      // A channel people already talk in would get every one of them actioned.
      if (check.recentPosters !== 0 && body?.confirmHoneypot !== true) {
        const action = updates.honeypotAction || current.honeypotAction;
        const who = check.recentPosters === null
          ? `The bot could not read the recent history of #${check.name}.`
          : `${check.recentPosters} member${check.recentPosters === 1 ? ' has' : 's have'} posted recently in #${check.name}.`;
        sendJson(response, 409, {
          ok: false,
          needsConfirm: true,
          error: `${who} As the honeypot, anyone without staff permissions who posts there gets "${action}". Use it anyway?`,
        });
        return;
      }
    }

    const settings = setAntiraidConfig(ctx.serverId, updates);
    sendJson(response, 200, { ok: true, settings, raid: getRaidStatus(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/honeypot') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    try {
      const { channelId, settings } = await createHoneypotChannel(ctx.client, ctx.serverId, String(body?.name || ''));
      sendJson(response, 200, { ok: true, channelId, settings, channels: await listTextChannels(ctx.client, ctx.serverId) });
    } catch (error) {
      if (error?.code === 'HONEYPOT_EXISTS') { sendJson(response, 409, { ok: false, error: error.message }); return; }
      sendJson(response, 502, { ok: false, error: `Could not create the honeypot channel: ${error?.message || error}` });
    }
    return;
  }

  if (method === 'POST' && pathname === '/api/lockdown') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    setRaidActive(ctx.serverId, Boolean(body?.active));
    sendJson(response, 200, { ok: true, raid: getRaidStatus(ctx.serverId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function sanitizeSettings(body: any): Partial<AntiraidConfig> {
  const out: Partial<AntiraidConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'joinThreshold')) out.joinThreshold = Number(body.joinThreshold);
  if (hasField(body, 'joinWindowSec')) out.joinWindowSec = Number(body.joinWindowSec);
  if (hasField(body, 'minAccountAgeMin')) out.minAccountAgeMin = Number(body.minAccountAgeMin);
  if (hasField(body, 'lockdownMinutes')) out.lockdownMinutes = Number(body.lockdownMinutes);
  if (hasField(body, 'action') && RAID_ACTIONS.includes(String(body.action) as RaidAction)) out.action = body.action;
  if (hasField(body, 'accountAgeAction') && AGE_ACTIONS.includes(String(body.accountAgeAction) as AgeAction)) out.accountAgeAction = body.accountAgeAction;
  if (hasField(body, 'alertChannelId')) out.alertChannelId = cleanId(body.alertChannelId) || null;
  if (hasField(body, 'honeypotChannelId')) out.honeypotChannelId = cleanId(body.honeypotChannelId) || null;
  if (hasField(body, 'honeypotAction') && RAID_ACTIONS.includes(String(body.honeypotAction) as RaidAction)) out.honeypotAction = body.honeypotAction;
  return out;
}
