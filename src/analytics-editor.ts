/**
 * Analytics editor — request handler for the dashboard `/analytics` namespace.
 *
 * The Overview tab answers "how busy is this server"; this one answers "why,
 * where and when": membership churn day by day, the hours and weekdays the
 * server is awake, which channels carry the traffic, voice time, and which
 * commands actually get used.
 *
 * Backed by src/analytics.ts, with the message totals and top posters pulled
 * from src/activity.ts so both tabs report the same numbers.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listChannels } from './editor-lists.js';
import { getActivitySummary } from './activity.js';
import { getAnalyticsSummary, resetAnalytics } from './analytics.js';
import { getModerationSummary } from './moderation.js';
import { getEconomySummary } from './economy.js';
import { getTagSummary } from './tags.js';
import { getPollSummary } from './polls.js';
import { getGiveawaySummary } from './hosted-giveaways.js';
import { getBirthdaySummary } from './birthdays.js';
import { getAutomodSummary } from './automod.js';
import { recordAudit } from './audit.js';

const MAX_BODY_BYTES = 256 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'analytics');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/analytics',
  label: 'Analytics',
  withPrefix: true,
});

export async function handleAnalyticsEditorRequest(
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
    sendHtml(response, renderEditorPage('Analytics'));
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
    const days = Math.max(7, Math.min(120, Number(url.searchParams.get('days')) || 30));
    const channelNames: Record<string, string> = {};
    for (const channel of await listChannels(ctx.client, ctx.serverId)) channelNames[channel.id] = channel.name;

    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      days,
      analytics: getAnalyticsSummary({ days, serverId: ctx.serverId, channelNames }),
      activity: getActivitySummary({ days: Math.min(days, 60), topN: 10, serverId: ctx.serverId }),
      features: {
        moderation: getModerationSummary(ctx.serverId),
        automod: getAutomodSummary(ctx.serverId),
        economy: getEconomySummary(ctx.serverId),
        tags: getTagSummary(ctx.serverId),
        polls: getPollSummary(ctx.serverId),
        giveaways: getGiveawaySummary(ctx.serverId),
        birthdays: getBirthdaySummary(ctx.serverId),
      },
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/reset') {
    await readJsonBody(request, { maxBytes: MAX_BODY_BYTES }).catch(() => ({}));
    resetAnalytics(ctx.serverId);
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'analytics', action: 'reset', detail: 'counters cleared' });
    sendJson(response, 200, { ok: true });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}
