/**
 * Community editor — request handler for the dashboard `/community` namespace.
 *
 * Three small features share one tab because each is a short settings form plus
 * a list, and none of them justifies its own sidebar entry:
 *   - Tags: server-defined custom commands
 *   - Birthdays: the registry and its announcement settings
 *   - Voice rooms: the join-to-create hub and the rooms currently open
 *
 * Backed by src/tags.ts, src/birthdays.ts and src/tempvoice.ts.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listRoles, listTextChannels, listVoiceChannels } from './editor-lists.js';
import { cleanId } from './id-utils.js';
import { recordAudit } from './audit.js';
import { createTag, deleteTag, listTags, updateTag } from './tags.js';
import {
  formatBirthday,
  getBirthdayConfig,
  listBirthdays,
  removeBirthday,
  runBirthdaysForServer,
  setBirthdayConfig,
  upcomingBirthdays,
  type BirthdayConfig,
} from './birthdays.js';
import {
  deleteRoom,
  getRoomByChannel,
  getTempVoiceConfig,
  listTempRooms,
  setTempVoiceConfig,
  type TempVoiceConfig,
} from './tempvoice.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'community');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/community',
  label: 'Community',
  withPrefix: true,
});

export async function handleCommunityEditorRequest(
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
    sendHtml(response, renderEditorPage('Community'));
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
      tags: listTags(ctx.serverId),
      birthdaySettings: getBirthdayConfig(ctx.serverId),
      birthdays: upcomingBirthdays(50, ctx.serverId).map((entry) => ({
        userId: entry.userId,
        name: entry.name,
        date: formatBirthday(entry),
        inDays: entry.inDays,
      })),
      birthdayCount: listBirthdays(ctx.serverId).length,
      voiceSettings: getTempVoiceConfig(ctx.serverId),
      rooms: listTempRooms(ctx.serverId),
      channels: await listTextChannels(ctx.client, ctx.serverId),
      voiceChannels: await listVoiceChannels(ctx.client, ctx.serverId),
      roles: await listRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  // ---- Tags ----
  if (method === 'POST' && pathname === '/api/tag') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const result = createTag({
      serverId: ctx.serverId,
      name: String(body?.name || ''),
      content: String(body?.content || ''),
      createdBy: '',
      createdByName: 'Dashboard',
      source: 'dashboard',
    });
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, tags: listTags(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/tag/update') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const patch: any = {};
    if (hasField(body, 'content')) patch.content = String(body.content || '');
    if (hasField(body, 'restrictedRoleIds')) patch.restrictedRoleIds = idList(body.restrictedRoleIds);
    if (hasField(body, 'channelIds')) patch.channelIds = idList(body.channelIds);
    const result = updateTag(ctx.serverId, String(body?.name || ''), patch, 'dashboard');
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, tags: listTags(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/tag/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    if (!deleteTag(ctx.serverId, String(body?.name || ''), 'dashboard')) {
      sendJson(response, 404, { ok: false, error: 'That tag no longer exists.' });
      return;
    }
    sendJson(response, 200, { ok: true, tags: listTags(ctx.serverId) });
    return;
  }

  // ---- Birthdays ----
  if (method === 'POST' && pathname === '/api/birthday/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const settings = setBirthdayConfig(sanitizeBirthdaySettings(body), ctx.serverId);
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'birthdays', action: 'settings', detail: settings.enabled ? 'enabled' : 'disabled' });
    sendJson(response, 200, { ok: true, birthdaySettings: settings });
    return;
  }

  if (method === 'POST' && pathname === '/api/birthday/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const userId = cleanId(body?.userId);
    if (!userId || !removeBirthday(userId, ctx.serverId)) {
      sendJson(response, 404, { ok: false, error: 'That member has no birthday saved.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'birthdays', action: 'delete', detail: userId });
    sendJson(response, 200, {
      ok: true,
      birthdays: upcomingBirthdays(50, ctx.serverId).map((entry) => ({
        userId: entry.userId,
        name: entry.name,
        date: formatBirthday(entry),
        inDays: entry.inDays,
      })),
      birthdayCount: listBirthdays(ctx.serverId).length,
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/birthday/test') {
    await readJsonBody(request, { maxBytes: MAX_BODY_BYTES }).catch(() => ({}));
    if (!getBirthdayConfig(ctx.serverId).channelId) {
      sendJson(response, 400, { ok: false, error: 'Choose an announcement channel and save first.' });
      return;
    }
    const announced = await runBirthdaysForServer(ctx.client, ctx.serverId, Date.now(), { force: true });
    sendJson(response, 200, { ok: true, announced });
    return;
  }

  // ---- Voice rooms ----
  if (method === 'POST' && pathname === '/api/voice/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const settings = setTempVoiceConfig(sanitizeVoiceSettings(body), ctx.serverId);
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'tempvoice', action: 'settings', detail: settings.enabled ? 'enabled' : 'disabled' });
    sendJson(response, 200, { ok: true, voiceSettings: settings });
    return;
  }

  if (method === 'POST' && pathname === '/api/voice/close') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const channelId = cleanId(body?.channelId);
    // Room ids are global; only this server's rooms may be closed from its tab.
    const room = channelId ? getRoomByChannel(channelId) : null;
    if (!room || room.serverId !== ctx.serverId || !(await deleteRoom(ctx.client, channelId, 'closed from the dashboard'))) {
      sendJson(response, 404, { ok: false, error: 'That room no longer exists.' });
      return;
    }
    sendJson(response, 200, { ok: true, rooms: listTempRooms(ctx.serverId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function idList(value: any): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry: any) => cleanId(entry)).filter(Boolean);
}

function sanitizeBirthdaySettings(body: any): Partial<BirthdayConfig> {
  const out: Partial<BirthdayConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'allowYear')) out.allowYear = Boolean(body.allowYear);
  if (hasField(body, 'channelId')) out.channelId = cleanId(body.channelId) || null;
  if (hasField(body, 'roleId')) out.roleId = cleanId(body.roleId) || null;
  if (hasField(body, 'message')) out.message = String(body.message || '');
  if (hasField(body, 'announceHour')) out.announceHour = Number(body.announceHour);
  if (hasField(body, 'utcOffsetMinutes')) out.utcOffsetMinutes = Number(body.utcOffsetMinutes);
  return out;
}

function sanitizeVoiceSettings(body: any): Partial<TempVoiceConfig> {
  const out: Partial<TempVoiceConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'hubChannelId')) out.hubChannelId = cleanId(body.hubChannelId) || null;
  if (hasField(body, 'noticeChannelId')) out.noticeChannelId = cleanId(body.noticeChannelId) || null;
  if (hasField(body, 'nameTemplate')) out.nameTemplate = String(body.nameTemplate || '');
  if (hasField(body, 'userLimit')) out.userLimit = Number(body.userLimit);
  if (hasField(body, 'emptyGraceSec')) out.emptyGraceSec = Number(body.emptyGraceSec);
  if (hasField(body, 'claimGraceSec')) out.claimGraceSec = Number(body.claimGraceSec);
  if (hasField(body, 'maxRoomsPerUser')) out.maxRoomsPerUser = Number(body.maxRoomsPerUser);
  return out;
}
