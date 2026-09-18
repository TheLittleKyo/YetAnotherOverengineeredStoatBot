/**
 * Reminder editor — request handler for the dashboard `/reminder` namespace.
 * Schedules recurring or one-off messages to a channel. Backed by
 * src/reminders.ts (the same store and scheduler the chat command uses).
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { channelInServer, listTextChannels } from './editor-lists.js';
import {
  addReminder,
  editReminder,
  listReminders,
  removeReminder,
  toggleReminder,
  sendReminderNow,
  describeSchedule,
  type ReminderSchedule,
  type IntervalUnit,
} from './reminders.js';
import { cleanId } from './id-utils.js';
import type { CustomEmbedConfig } from './embed-editor.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'reminder');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/reminder',
  label: 'Reminder',
  withPrefix: true,
});

const UNITS: IntervalUnit[] = ['second', 'minute', 'hour', 'day', 'week', 'month'];

export async function handleReminderEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Reminders')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      reminders: withDescriptions(listReminders(ctx.serverId)),
      channels: await listTextChannels(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/reminder') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const channelId = cleanId(body?.channelId);
    const messageText = String(body?.message || '').trim();
    const embed = buildEmbed(body?.embed);
    if (!channelId) { sendJson(response, 400, { ok: false, error: 'Choose a channel.' }); return; }
    if (!(await channelInServer(ctx.client, ctx.serverId, channelId))) { sendJson(response, 400, { ok: false, error: 'Choose a channel in this server.' }); return; }
    // An embed is a complete post on its own, so text is only required without one.
    if (!messageText && !embed) { sendJson(response, 400, { ok: false, error: 'Add a message, or an embed title or description.' }); return; }

    const schedule = buildSchedule(body?.schedule);
    if ('error' in schedule) { sendJson(response, 400, { ok: false, error: schedule.error }); return; }

    const reminder = addReminder({ serverId: ctx.serverId, channelId, message: messageText, embed, schedule: schedule.value });
    sendJson(response, 200, { ok: true, reminder, reminders: withDescriptions(listReminders(ctx.serverId)) });
    return;
  }

  // Edit an existing reminder in place: channel, text, embed, or schedule.
  if (method === 'POST' && pathname === '/api/reminder/update') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const id = String(body?.id || '');
    // Reminder ids are global; this tab edits only this server's reminders.
    if (!listReminders(ctx.serverId).some((reminder) => reminder.id === id)) {
      sendJson(response, 404, { ok: false, error: 'Reminder not found.' });
      return;
    }
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body || {}, key);
    const patch: Parameters<typeof editReminder>[1] = {};
    if (has('channelId')) {
      const channelId = cleanId(body.channelId);
      if (!channelId || !(await channelInServer(ctx.client, ctx.serverId, channelId))) {
        sendJson(response, 400, { ok: false, error: 'Choose a channel in this server.' });
        return;
      }
      patch.channelId = channelId;
    }
    if (has('message')) patch.message = String(body.message || '');
    if (has('embed')) patch.embed = buildEmbed(body.embed);
    if (has('schedule')) {
      const schedule = buildSchedule(body.schedule);
      if ('error' in schedule) { sendJson(response, 400, { ok: false, error: schedule.error }); return; }
      patch.schedule = schedule.value;
    }

    const updated = editReminder(id, patch);
    if (!updated) { sendJson(response, 400, { ok: false, error: 'Reminder not found, or the edit would leave it with nothing to post.' }); return; }
    sendJson(response, 200, { ok: true, reminders: withDescriptions(listReminders(ctx.serverId)) });
    return;
  }

  const route = pathname.match(/^\/api\/reminder\/([^/]+?)(\/toggle|\/test)?$/);
  if (route && method === 'PATCH' && route[2] === '/toggle') {
    const reminder = toggleReminder(decodeURIComponent(route[1]));
    sendJson(response, reminder ? 200 : 404, { ok: Boolean(reminder), reminders: withDescriptions(listReminders(ctx.serverId)), error: reminder ? undefined : 'Reminder not found.' });
    return;
  }
  if (route && method === 'POST' && route[2] === '/test') {
    const ok = await sendReminderNow(ctx.client, decodeURIComponent(route[1]));
    sendJson(response, ok ? 200 : 404, { ok, error: ok ? undefined : 'Reminder not found.' });
    return;
  }
  if (route && method === 'DELETE') {
    const removed = removeReminder(decodeURIComponent(route[1]));
    sendJson(response, removed ? 200 : 404, { ok: removed, reminders: withDescriptions(listReminders(ctx.serverId)), error: removed ? undefined : 'Reminder not found.' });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function withDescriptions(reminders: ReturnType<typeof listReminders>) {
  return reminders.map((r) => ({ ...r, describe: describeSchedule(r.schedule) }));
}

/** Keep only the embed fields a reminder can post, or null when it is empty. */
function buildEmbed(raw: any): CustomEmbedConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const embed: CustomEmbedConfig = {};
  const title = String(raw.title || '').trim();
  const description = String(raw.description || '').trim();
  const color = String(raw.color || '').trim();
  const url = String(raw.url || '').trim();
  if (title) embed.title = title;
  if (description) embed.description = description;
  if (color) embed.color = color;
  if (url) embed.url = url;
  return embed.title || embed.description ? embed : null;
}

function buildSchedule(raw: any): { value: ReminderSchedule } | { error: string } {
  const type = String(raw?.type || '');

  if (type === 'interval') {
    const every = Math.round(Number(raw?.every));
    const unit = String(raw?.unit) as IntervalUnit;
    if (!UNITS.includes(unit)) return { error: 'Invalid interval unit.' };
    if (!Number.isFinite(every) || every < 1) return { error: 'Interval must be at least 1.' };
    if (unit === 'second' && every < 5) return { error: 'Minimum interval is 5 seconds.' };
    return { value: { type: 'interval', every, unit } };
  }

  if (type === 'weekly') {
    const days: number[] = Array.isArray(raw?.days)
      ? raw.days.map((d: any) => Number(d)).filter((d: number) => Number.isFinite(d) && d >= 0 && d <= 6)
      : [];
    const time = normalizeTime(raw?.time);
    if (days.length === 0) return { error: 'Pick at least one weekday.' };
    if (!time) return { error: 'Provide a valid time (HH:MM).' };
    const uniqueDays: number[] = Array.from(new Set<number>(days)).sort((a, b) => a - b);
    return { value: { type: 'weekly', days: uniqueDays, time } };
  }

  if (type === 'monthly') {
    const day = Math.round(Number(raw?.day));
    const time = normalizeTime(raw?.time);
    if (!Number.isFinite(day) || day < 1 || day > 31) return { error: 'Day of month must be 1–31.' };
    if (!time) return { error: 'Provide a valid time (HH:MM).' };
    return { value: { type: 'monthly', day, time } };
  }

  if (type === 'once') {
    const at = parseDateTime(raw?.date, raw?.time);
    if (at == null) return { error: 'Provide a valid date.' };
    if (at <= Date.now()) return { error: 'That date/time is in the past.' };
    return { value: { type: 'once', at } };
  }

  return { error: 'Choose a schedule type.' };
}

function normalizeTime(value: any): string | null {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]); const m = Number(match[2]);
  if (h > 23 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${match[2]}`;
}

function parseDateTime(dateStr: any, timeStr: any): number | null {
  const dm = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return null;
  const t = normalizeTime(timeStr) || '09:00';
  const [h, mi] = t.split(':').map(Number);
  const date = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), h, mi, 0, 0);
  const ms = date.getTime();
  return Number.isFinite(ms) ? ms : null;
}
