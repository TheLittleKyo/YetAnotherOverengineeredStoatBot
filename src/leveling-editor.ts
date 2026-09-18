/**
 * Leveling editor — request handler for the dashboard `/leveling` namespace.
 * Configures the XP/leveling system, level-based auto-add role rewards, and
 * shows the live leaderboard. Backed by src/leveling.ts.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import {
  addRoleReward,
  addUserXp,
  clearRoleRewards,
  getAvatarCdnUrl,
  getLeaderboard,
  getLevelingConfig,
  getLevelProgress,
  getRoleRewards,
  getTrackedUserCount,
  removeRoleReward,
  resetAll,
  resetUser,
  setLevelingConfig,
  setUserLevel,
  setUserXp,
  type LevelingConfig,
} from './leveling.js';
import { cleanId } from './id-utils.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'leveling');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/leveling',
  label: 'Leveling',
  withPrefix: true,
});

export async function handleLevelingEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Leveling')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      settings: getLevelingConfig(ctx.serverId),
      rewards: getRoleRewards(ctx.serverId),
      leaderboard: buildLeaderboard(ctx.client, ctx.serverId),
      trackedUsers: getTrackedUserCount(ctx.serverId),
      channels: await listTextChannels(ctx.client, ctx.serverId),
      roles: await listServerRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const updates = sanitizeSettings(body);
    const settings = setLevelingConfig(updates, ctx.serverId);
    sendJson(response, 200, { ok: true, settings });
    return;
  }

  if (method === 'POST' && pathname === '/api/reward') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const level = Math.floor(Number(body?.level));
    const roleId = cleanId(body?.roleId);
    if (!(level >= 1) || !roleId) { sendJson(response, 400, { ok: false, error: 'A level (≥1) and role are required.' }); return; }
    const rewards = addRoleReward(level, roleId, ctx.serverId);
    sendJson(response, 200, { ok: true, rewards });
    return;
  }

  if (method === 'POST' && pathname === '/api/reward/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const level = Math.floor(Number(body?.level));
    const rewards = removeRoleReward(level, ctx.serverId);
    sendJson(response, 200, { ok: true, rewards });
    return;
  }

  if (method === 'POST' && pathname === '/api/reward/clear') {
    clearRoleRewards(ctx.serverId);
    sendJson(response, 200, { ok: true, rewards: [] });
    return;
  }

  if (method === 'POST' && pathname === '/api/user') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const userId = cleanId(body?.userId);
    const action = String(body?.action || '');
    const value = Math.floor(Number(body?.value));
    if (!userId) { sendJson(response, 400, { ok: false, error: 'A user is required.' }); return; }

    if (action === 'reset') {
      resetUser(userId, ctx.serverId);
    } else if (action === 'setlevel' && Number.isFinite(value) && value >= 0) {
      setUserLevel(userId, value, ctx.serverId);
    } else if (action === 'setxp' && Number.isFinite(value) && value >= 0) {
      setUserXp(userId, value, ctx.serverId);
    } else if (action === 'addxp' && Number.isFinite(value)) {
      addUserXp(userId, value, ctx.serverId);
    } else {
      sendJson(response, 400, { ok: false, error: 'Invalid user action or value.' });
      return;
    }

    sendJson(response, 200, {
      ok: true,
      leaderboard: buildLeaderboard(ctx.client, ctx.serverId),
      trackedUsers: getTrackedUserCount(ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/reset-all') {
    resetAll(ctx.serverId);
    sendJson(response, 200, { ok: true, leaderboard: [], trackedUsers: 0 });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function buildLeaderboard(client: any, serverId: string) {
  return getLeaderboard(25, serverId).map((row) => {
    const progress = getLevelProgress(row.xp);
    return {
      userId: row.userId,
      name: row.name,
      rank: row.rank,
      level: row.level,
      xp: row.xp,
      currentLevelXp: progress.currentLevelXp,
      neededForNext: progress.neededForNext,
      avatarUrl: getAvatarCdnUrl(client, row.avatarId),
    };
  });
}

function sanitizeSettings(body: any): Partial<LevelingConfig> {
  const out: Partial<LevelingConfig> = {};
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'xpMin')) out.xpMin = Number(body.xpMin);
  if (hasField(body, 'xpMax')) out.xpMax = Number(body.xpMax);
  if (hasField(body, 'cooldownSeconds')) out.cooldownSeconds = Number(body.cooldownSeconds);
  if (hasField(body, 'announce')) out.announce = Boolean(body.announce);
  if (hasField(body, 'announceChannelId')) out.announceChannelId = cleanId(body.announceChannelId) || null;
  if (hasField(body, 'stackRoles')) out.stackRoles = Boolean(body.stackRoles);
  if (hasField(body, 'noXpChannelIds') && Array.isArray(body.noXpChannelIds)) {
    out.noXpChannelIds = body.noXpChannelIds.map((id: any) => cleanId(id)).filter(Boolean);
  }
  return out;
}

type RoleOption = { id: string; name: string; color: string | null };

async function listServerRoles(client: any, serverId: string): Promise<RoleOption[]> {
  const roles = new Map<string, RoleOption>();

  const add = (source: any) => {
    if (!source) return;
    const entries = source instanceof Map
      ? Array.from(source.entries())
      : typeof source?.entries === 'function' && !Array.isArray(source)
        ? Array.from(source.entries())
        : Array.isArray(source)
          ? source.map((r: any) => [r?.id || r?._id, r])
          : Object.entries(source);
    for (const [key, role] of entries as any[]) {
      const id = String((role as any)?.id || (role as any)?._id || key || '').trim();
      if (!id) continue;
      roles.set(id, {
        id,
        name: String((role as any)?.name || (role as any)?.title || id).trim().slice(0, 80),
        color: normalizeColor((role as any)?.colour || (role as any)?.color),
      });
    }
  };

  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  add(server?.roles?.cache);
  add(server?.roles);

  try {
    const rawServer = await client?.api?.get?.(`/servers/${serverId}`);
    add(rawServer?.roles);
  } catch { /* cached roles are enough for manual entry */ }

  return Array.from(roles.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function normalizeColor(value: any): string | null {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) return color;
  return null;
}
