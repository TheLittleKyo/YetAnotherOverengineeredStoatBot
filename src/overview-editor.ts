/**
 * Overview editor — request handler for the dashboard `/home` namespace.
 *
 * This is the landing page of the dashboard: a customizable control room that
 * surfaces live bot stats (tickets, members, notify feeds, sync links, …), an
 * activity time-series, bot health (gateway, CPU, memory), and the "most sent
 * images" / "most active" leaderboards. All widgets read real data; there is
 * nothing to mutate here, so the only endpoint is a single aggregated GET.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { availableParallelism, totalmem } from 'os';
import { getHeapStatistics } from 'v8';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import { ticketDb } from './database.js';
import { getSubscriptions } from './notifications/state.js';
import { listSyncLinks } from './sync.js';
import { getStatsChannels } from './stats.js';
import { getWelcomeConfig, getSelectedWelcomeImageCount } from './welcome.js';
import { getLogConfig } from './log-system.js';
import { getJoinRoleIds } from './join-roles.js';
import { getReactionRoleMessages } from './reaction-roles.js';
import { getActivitySummary } from './activity.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'overview');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/home',
  label: 'Overview',
  withPrefix: true,
});

export async function handleOverviewEditorRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: { client: any; serverId: string; guest?: boolean },
) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Overview')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/overview') {
    const days = clampInt(url.searchParams.get('days'), 14, 1, 120);
    const topN = clampInt(url.searchParams.get('top'), 8, 1, 25);
    try {
      sendJson(response, 200, { ok: true, ...(await buildOverview(ctx, days, topN)) });
    } catch (error: any) {
      console.error('Overview build failed:', error?.message || error);
      sendJson(response, 500, { ok: false, error: 'Could not build overview.' });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

async function buildOverview(ctx: { client: any; serverId: string; guest?: boolean }, days: number, topN: number) {
  const rawActivity = getActivitySummary({ days, topN, serverId: ctx.serverId });
  // Attach a resolved avatar URL to each leaderboard row (built from the file
  // id captured on the user's last message + the instance CDN base).
  const activity = {
    ...rawActivity,
    topMessages: rawActivity.topMessages.map((r) => withAvatar(ctx.client, r)),
    topImages: rawActivity.topImages.map((r) => withAvatar(ctx.client, r)),
  };

  const tickets = safe(() => {
    const open = ticketDb.getOpenTickets(ctx.serverId).length;
    const closed = ticketDb.getClosedTickets(ctx.serverId).length;
    return { open, closed, total: open + closed };
  }, { open: 0, closed: 0, total: 0 });

  // Sync links that touch the active server (source or target channel is in
  // it), matching the ops editor's per-server view. Resolving the server's
  // channels is an API round trip, and the page auto-refreshes, so it is only
  // made when there are links to filter.
  const allLinks = safe(() => listSyncLinks(), []);
  const serverChannelIds = allLinks.length === 0 ? new Set<string>() : await safeAsync(async () => {
    const channels = await listTextChannels(ctx.client, ctx.serverId);
    return new Set(channels.map((c) => c.id));
  }, new Set<string>());

  const notify = safe(() => {
    const subs = getSubscriptions().filter((s: any) => !ctx.serverId || s?.serverId === ctx.serverId);
    const live = subs.filter((s: any) => s?.enabled !== false).length;
    return { total: subs.length, live };
  }, { total: 0, live: 0 });

  const sync = safe(() => {
    const links = allLinks.filter((l: any) =>
      serverChannelIds.size === 0 || serverChannelIds.has(l.sourceChannelId) || serverChannelIds.has(l.targetChannelId));
    return { total: links.length, twoWay: links.filter((l: any) => l?.mode === 'twoway').length };
  }, { total: 0, twoWay: 0 });

  const statsChannels = safe(() => getStatsChannels(ctx.serverId).length, 0);
  const joinRoles = safe(() => getJoinRoleIds(ctx.serverId).length, 0);
  const reactionRoles = safe(() => getReactionRoleMessages().filter((m: any) => !ctx.serverId || m?.serverId === ctx.serverId).length, 0);
  const welcome = safe(() => {
    const cfg = getWelcomeConfig(ctx.serverId);
    return { enabled: !!cfg, images: getSelectedWelcomeImageCount(ctx.serverId) };
  }, { enabled: false, images: 0 });
  const logs = safe(() => {
    const cfg = getLogConfig(ctx.serverId);
    return { enabled: !!cfg?.enabled, channelId: cfg?.channelId || null };
  }, { enabled: false, channelId: null });

  const server = safe(() => resolveServerInfo(ctx.client, ctx.serverId), { name: null, memberCount: null });

  return {
    botName: config.botName,
    prefix: config.prefix,
    serverId: ctx.serverId,
    server,
    generatedAt: new Date().toISOString(),
    days,
    features: { tickets, notify, sync, statsChannels, joinRoles, reactionRoles, welcome, logs },
    activity,
    health: safe(() => readHealth(ctx.client, !!ctx.guest), null),
  };
}

// CPU is sampled between Overview requests. The baseline is process start
// (`performance.now()` counts from there, and `cpuUsage()` from zero), so the
// first reading is the lifetime average. Requests closer together than the
// minimum window (several open tabs, a guest and the owner) reuse the last
// reading instead of dividing by a few milliseconds.
const CPU_MIN_WINDOW_MS = 5_000;
let lastCpuSample = { usage: { user: 0, system: 0 }, at: 0, percent: 0 };

function sampleCpuPercent(): number {
  const now = performance.now();
  const elapsedMs = now - lastCpuSample.at;
  if (lastCpuSample.at > 0 && elapsedMs < CPU_MIN_WINDOW_MS) return lastCpuSample.percent;
  const usage = process.cpuUsage();
  const cpuMs = (usage.user - lastCpuSample.usage.user + usage.system - lastCpuSample.usage.system) / 1000;
  const cores = Math.max(1, availableParallelism());
  const percent = Math.min(100, Math.max(0, (cpuMs / Math.max(1, elapsedMs) / cores) * 100));
  lastCpuSample = { usage, at: now, percent };
  return percent;
}

// Share-link guests get the bot's own figures but not the host's memory size.
function readHealth(client: any, guest: boolean) {
  const cpuPercent = sampleCpuPercent();

  const mem = process.memoryUsage();
  const heapLimit = getHeapStatistics().heap_size_limit;
  const ws = client?.ws;
  const connected = Boolean(ws ? ws.connected : client?.isReady?.());
  const ping = Number(ws?.ping);
  const uptimeMs = Number(client?.uptime);

  return {
    connected,
    ping: connected && Number.isFinite(ping) && ping > 0 ? Math.round(ping) : null,
    // Gateway session uptime when the client exposes it, else the process's.
    uptimeMs: Number.isFinite(uptimeMs) && uptimeMs > 0 ? uptimeMs : Math.round(process.uptime() * 1000),
    cpuPercent: Math.round(cpuPercent * 10) / 10,
    heapUsed: mem.heapUsed,
    heapLimit,
    rss: mem.rss,
    systemMemory: guest ? null : totalmem(),
    servers: typeof client?.servers?.cache?.size === 'number' ? client.servers.cache.size : null,
  };
}

function resolveServerInfo(client: any, serverId: string): { name: string | null; memberCount: number | null } {
  try {
    const server = client?.servers?.cache?.get?.(serverId);
    if (!server) return { name: null, memberCount: null };
    const memberCount =
      typeof server.memberCount === 'number' ? server.memberCount :
      typeof server.members?.size === 'number' ? server.members.size :
      null;
    const name = String(server.name || server.title || '').trim() || null;
    return { name, memberCount };
  } catch {
    return { name: null, memberCount: null };
  }
}

function withAvatar<T extends { avatarId: string | null }>(client: any, row: T): T & { avatar: string | null } {
  return { ...row, avatar: buildAvatarUrl(client, row.avatarId) };
}

function buildAvatarUrl(client: any, avatarId: string | null): string | null {
  if (!avatarId) return null;
  const cdnBase = String(client?.options?.rest?.instanceCDNURL || 'https://autumn.stoat.chat').replace(/\/$/, '');
  return `${cdnBase}/avatars/${encodeURIComponent(avatarId)}`;
}

function safe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try { return await fn(); } catch { return fallback; }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
