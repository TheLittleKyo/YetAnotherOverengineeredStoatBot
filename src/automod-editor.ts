/**
 * Automod editor — request handler for the dashboard `/automod` namespace:
 * the filter rules, their actions and scopes, plus the server-wide exemptions.
 * Backed by src/automod.ts.
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
  addAutomodRule,
  defaultThreshold,
  describeRuleType,
  getAutomodConfig,
  getAutomodSummary,
  listAutomodRules,
  removeAutomodRule,
  setAutomodConfig,
  updateAutomodRule,
  type AutomodAction,
  type AutomodConfig,
  type AutomodRule,
  type AutomodRuleType,
} from './automod.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'automod');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/automod',
  label: 'Automod',
  withPrefix: true,
});

const RULE_TYPES: AutomodRuleType[] = [
  'words', 'invites', 'links', 'mentions', 'spam', 'duplicates', 'caps', 'emoji', 'newlines', 'zalgo', 'attachments',
];
const ACTIONS: AutomodAction[] = ['delete', 'warn', 'mute', 'kick', 'ban'];

export async function handleAutomodEditorRequest(
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
    sendHtml(response, renderEditorPage('Automod'));
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
      settings: getAutomodConfig(ctx.serverId),
      rules: listAutomodRules(ctx.serverId),
      summary: getAutomodSummary(ctx.serverId),
      ruleTypes: RULE_TYPES.map((type) => ({ type, label: describeRuleType(type), defaultThreshold: defaultThreshold(type) })),
      actions: ACTIONS,
      channels: await listTextChannels(ctx.client, ctx.serverId),
      roles: await listRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const settings = setAutomodConfig(sanitizeSettings(body), ctx.serverId);
    recordAudit({
      serverId: ctx.serverId,
      actorName: 'Dashboard',
      source: 'dashboard',
      area: 'automod',
      action: 'settings',
      detail: settings.enabled ? 'enabled' : 'disabled',
    });
    sendJson(response, 200, { ok: true, settings });
    return;
  }

  if (method === 'POST' && pathname === '/api/rule') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const rule = addAutomodRule(sanitizeRule(body), ctx.serverId);
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'automod', action: 'rule.add', detail: rule.name });
    sendJson(response, 200, { ok: true, rules: listAutomodRules(ctx.serverId), rule });
    return;
  }

  if (method === 'POST' && pathname === '/api/rule/update') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const id = String(body?.id || '');
    const updated = updateAutomodRule(id, sanitizeRule(body), ctx.serverId);
    if (!updated) {
      sendJson(response, 404, { ok: false, error: 'That rule no longer exists.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'automod', action: 'rule.edit', detail: updated.name });
    sendJson(response, 200, { ok: true, rules: listAutomodRules(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/rule/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const id = String(body?.id || '');
    if (!removeAutomodRule(id, ctx.serverId)) {
      sendJson(response, 404, { ok: false, error: 'That rule no longer exists.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'automod', action: 'rule.delete', detail: id });
    sendJson(response, 200, { ok: true, rules: listAutomodRules(ctx.serverId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function idList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry: any) => cleanId(entry)).filter(Boolean);
}

function sanitizeSettings(body: any): Partial<AutomodConfig> {
  const out: Partial<AutomodConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'notifyChannel')) out.notifyChannel = Boolean(body.notifyChannel);
  if (hasField(body, 'exemptStaffPermissions')) out.exemptStaffPermissions = Boolean(body.exemptStaffPermissions);
  if (hasField(body, 'logChannelId')) out.logChannelId = cleanId(body.logChannelId) || null;
  if (hasField(body, 'exemptRoleIds')) out.exemptRoleIds = idList(body.exemptRoleIds);
  if (hasField(body, 'exemptChannelIds')) out.exemptChannelIds = idList(body.exemptChannelIds);
  return out;
}

function sanitizeRule(body: any): Partial<AutomodRule> {
  const out: Partial<AutomodRule> = {};
  if (hasField(body, 'name')) out.name = String(body.name || '').slice(0, 60);
  if (hasField(body, 'type') && RULE_TYPES.includes(body.type)) out.type = body.type;
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'action') && ACTIONS.includes(body.action)) out.action = body.action;
  if (hasField(body, 'deleteMessage')) out.deleteMessage = Boolean(body.deleteMessage);
  if (hasField(body, 'durationMs')) out.durationMs = body.durationMs == null ? null : Number(body.durationMs);
  if (hasField(body, 'threshold')) out.threshold = Number(body.threshold);
  if (hasField(body, 'windowSec')) out.windowSec = Number(body.windowSec);
  if (hasField(body, 'wholeWord')) out.wholeWord = Boolean(body.wholeWord);
  if (hasField(body, 'words') && Array.isArray(body.words)) {
    out.words = body.words.map((word: any) => String(word || '').trim().toLowerCase()).filter(Boolean);
  }
  if (hasField(body, 'allowedDomains') && Array.isArray(body.allowedDomains)) {
    out.allowedDomains = body.allowedDomains.map((domain: any) => String(domain || '').trim().toLowerCase()).filter(Boolean);
  }
  if (hasField(body, 'channelIds')) out.channelIds = idList(body.channelIds);
  if (hasField(body, 'exemptChannelIds')) out.exemptChannelIds = idList(body.exemptChannelIds);
  if (hasField(body, 'exemptRoleIds')) out.exemptRoleIds = idList(body.exemptRoleIds);
  return out;
}
