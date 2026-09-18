/**
 * Moderation editor — request handler for the dashboard `/moderation`
 * namespace: case history, the escalation ladder, and the mute/DM settings.
 * Backed by src/moderation.ts.
 *
 * Actions that *punish* stay in chat, where the moderator is present and the
 * member can be told immediately. The dashboard only lifts punishments, edits
 * reasons, and deletes records — reviewing work rather than doing it.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listRoles, listTextChannels } from './editor-lists.js';
import { cleanId } from './id-utils.js';
import { recordAudit } from './audit.js';
import {
  deleteCase,
  getModerationConfig,
  getModerationSummary,
  listCases,
  runModAction,
  setModerationConfig,
  updateCaseReason,
  type EscalationRule,
  type ModerationConfig,
} from './moderation.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'moderation');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/moderation',
  label: 'Moderation',
  withPrefix: true,
});

export async function handleModerationEditorRequest(
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
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) {
    sendHtml(response, renderEditorPage('Moderation'));
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
      settings: getModerationConfig(ctx.serverId),
      summary: getModerationSummary(ctx.serverId),
      cases: listCases(ctx.serverId, { limit: 200 }),
      channels: await listTextChannels(ctx.client, ctx.serverId),
      roles: await listRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const settings = setModerationConfig(sanitizeSettings(body), ctx.serverId);
    recordAudit({
      serverId: ctx.serverId,
      actorName: 'Dashboard',
      source: 'dashboard',
      area: 'moderation',
      action: 'settings',
      detail: `escalation rules: ${settings.escalation.length}`,
    });
    sendJson(response, 200, { ok: true, settings });
    return;
  }

  if (method === 'POST' && pathname === '/api/case/reason') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const id = Math.floor(Number(body?.id));
    const reason = String(body?.reason || '').trim();
    if (!Number.isFinite(id) || !reason) {
      sendJson(response, 400, { ok: false, error: 'A case id and a reason are required.' });
      return;
    }
    const updated = updateCaseReason(id, reason, ctx.serverId);
    if (!updated) {
      sendJson(response, 404, { ok: false, error: `No case #${id}.` });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'moderation', action: 'case.reason', detail: `case #${id}` });
    sendJson(response, 200, { ok: true, cases: listCases(ctx.serverId, { limit: 200 }) });
    return;
  }

  if (method === 'POST' && pathname === '/api/case/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const id = Math.floor(Number(body?.id));
    if (!deleteCase(id, ctx.serverId)) {
      sendJson(response, 404, { ok: false, error: `No case #${id}.` });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'moderation', action: 'case.delete', detail: `case #${id}` });
    sendJson(response, 200, {
      ok: true,
      cases: listCases(ctx.serverId, { limit: 200 }),
      summary: getModerationSummary(ctx.serverId),
    });
    return;
  }

  // Lifting a punishment is the one live action the dashboard performs: it
  // undoes something, so it cannot be used to moderate from behind the glass.
  if (method === 'POST' && pathname === '/api/lift') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const userId = cleanId(body?.userId);
    const action = body?.action === 'unban' ? 'unban' : 'unmute';
    if (!userId) {
      sendJson(response, 400, { ok: false, error: 'A member is required.' });
      return;
    }

    const result = await runModAction(ctx.client, {
      serverId: ctx.serverId,
      action,
      userId,
      moderatorId: '',
      moderatorName: 'Dashboard',
      source: 'dashboard',
      reason: String(body?.reason || 'Lifted from the dashboard').slice(0, 500),
    });

    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error || 'The action failed.' });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      cases: listCases(ctx.serverId, { limit: 200 }),
      summary: getModerationSummary(ctx.serverId),
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function sanitizeEscalation(value: any): EscalationRule[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((rule: any) => ({
      warns: Math.floor(Number(rule?.warns)),
      action: rule?.action === 'kick' || rule?.action === 'ban' ? rule.action : 'mute',
      durationMs: rule?.durationMs == null ? null : Math.max(0, Math.floor(Number(rule.durationMs))) || null,
    }))
    .filter((rule) => Number.isFinite(rule.warns) && rule.warns >= 1) as EscalationRule[];
}

function sanitizeSettings(body: any): Partial<ModerationConfig> {
  const out: Partial<ModerationConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'dmOnAction')) out.dmOnAction = Boolean(body.dmOnAction);
  if (hasField(body, 'preferTimeout')) out.preferTimeout = Boolean(body.preferTimeout);
  if (hasField(body, 'muteRoleId')) out.muteRoleId = cleanId(body.muteRoleId) || null;
  if (hasField(body, 'caseChannelId')) out.caseChannelId = cleanId(body.caseChannelId) || null;
  if (hasField(body, 'defaultMuteMs')) out.defaultMuteMs = Number(body.defaultMuteMs);
  if (hasField(body, 'warnExpiryDays')) out.warnExpiryDays = Number(body.warnExpiryDays);
  if (hasField(body, 'escalation')) out.escalation = sanitizeEscalation(body.escalation);
  return out;
}
