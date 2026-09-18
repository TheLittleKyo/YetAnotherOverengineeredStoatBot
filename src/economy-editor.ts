/**
 * Economy editor — request handler for the dashboard `/economy` namespace:
 * currency settings, the shop, and the balance leaderboard with the admin
 * adjustments. Backed by src/economy.ts.
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
  addBalance,
  addShopItem,
  getEconomyConfig,
  getEconomySummary,
  getRichList,
  listShop,
  removeShopItem,
  resetEconomyAll,
  resetEconomyUser,
  setBalance,
  setEconomyConfig,
  updateShopItem,
  type EconomyConfig,
  type ShopItem,
} from './economy.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'economy');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/economy',
  label: 'Economy',
  withPrefix: true,
});

export async function handleEconomyEditorRequest(
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
    sendHtml(response, renderEditorPage('Economy'));
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
      settings: getEconomyConfig(ctx.serverId),
      shop: listShop(ctx.serverId),
      leaderboard: getRichList(25, ctx.serverId),
      summary: getEconomySummary(ctx.serverId),
      channels: await listTextChannels(ctx.client, ctx.serverId),
      roles: await listRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const settings = setEconomyConfig(sanitizeSettings(body), ctx.serverId);
    recordAudit({
      serverId: ctx.serverId,
      actorName: 'Dashboard',
      source: 'dashboard',
      area: 'economy',
      action: 'settings',
      detail: `${settings.enabled ? 'enabled' : 'disabled'} · ${settings.currencyName}`,
    });
    sendJson(response, 200, { ok: true, settings });
    return;
  }

  if (method === 'POST' && pathname === '/api/shop') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const item = addShopItem(sanitizeItem(body), ctx.serverId);
    if (!item) {
      sendJson(response, 400, { ok: false, error: 'An item needs a name.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'economy', action: 'shop.add', detail: item.name });
    sendJson(response, 200, { ok: true, shop: listShop(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/shop/update') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const updated = updateShopItem(String(body?.id || ''), sanitizeItem(body), ctx.serverId);
    if (!updated) {
      sendJson(response, 404, { ok: false, error: 'That item no longer exists.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'economy', action: 'shop.edit', detail: updated.name });
    sendJson(response, 200, { ok: true, shop: listShop(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/shop/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const id = String(body?.id || '');
    const item = listShop(ctx.serverId).find((entry) => entry.id === id);
    if (!item || !removeShopItem(id, ctx.serverId)) {
      sendJson(response, 404, { ok: false, error: 'That item no longer exists.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'economy', action: 'shop.delete', detail: item.name });
    sendJson(response, 200, { ok: true, shop: listShop(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/balance') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const userId = cleanId(body?.userId);
    const amount = Math.floor(Number(body?.amount));
    const action = String(body?.action || '');
    if (!userId || !Number.isFinite(amount)) {
      sendJson(response, 400, { ok: false, error: 'A member and an amount are required.' });
      return;
    }

    if (action === 'set') setBalance(userId, amount, ctx.serverId);
    else if (action === 'add') addBalance(userId, amount, ctx.serverId);
    else if (action === 'remove') addBalance(userId, -amount, ctx.serverId);
    else {
      sendJson(response, 400, { ok: false, error: 'Unknown balance action.' });
      return;
    }

    recordAudit({
      serverId: ctx.serverId,
      actorName: 'Dashboard',
      source: 'dashboard',
      area: 'economy',
      action: `balance.${action}`,
      detail: `${userId} · ${amount}`,
    });
    sendJson(response, 200, { ok: true, leaderboard: getRichList(25, ctx.serverId), summary: getEconomySummary(ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/reset') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const userId = cleanId(body?.userId);
    // Wiping every balance must be asked for explicitly; a request that merely
    // lost its member id must not fall through to it.
    if (userId) resetEconomyUser(userId, ctx.serverId);
    else if (body?.all === true) resetEconomyAll(ctx.serverId);
    else {
      sendJson(response, 400, { ok: false, error: 'Name a member, or confirm resetting everyone.' });
      return;
    }
    recordAudit({
      serverId: ctx.serverId,
      actorName: 'Dashboard',
      source: 'dashboard',
      area: 'economy',
      action: 'reset',
      detail: userId || 'every balance',
    });
    sendJson(response, 200, { ok: true, leaderboard: getRichList(25, ctx.serverId), summary: getEconomySummary(ctx.serverId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function sanitizeSettings(body: any): Partial<EconomyConfig> {
  const out: Partial<EconomyConfig> = {};
  const numberFields: (keyof EconomyConfig)[] = [
    'startingBalance', 'messageMin', 'messageMax', 'messageCooldownSec', 'dailyAmount', 'dailyStreakBonus',
    'workMin', 'workMax', 'workCooldownSec', 'payTaxPercent', 'gambleMaxBet',
  ];
  for (const field of numberFields) {
    if (hasField(body, field)) (out as any)[field] = Number((body as any)[field]);
  }
  if (hasField(body, 'enabled')) out.enabled = Boolean(body.enabled);
  if (hasField(body, 'payEnabled')) out.payEnabled = Boolean(body.payEnabled);
  if (hasField(body, 'gamblingEnabled')) out.gamblingEnabled = Boolean(body.gamblingEnabled);
  if (hasField(body, 'currencyName')) out.currencyName = String(body.currencyName || '');
  if (hasField(body, 'currencySymbol')) out.currencySymbol = String(body.currencySymbol || '');
  if (hasField(body, 'noEarnChannelIds') && Array.isArray(body.noEarnChannelIds)) {
    out.noEarnChannelIds = body.noEarnChannelIds.map((id: any) => cleanId(id)).filter(Boolean);
  }
  return out;
}

function sanitizeItem(body: any): Partial<ShopItem> {
  const out: Partial<ShopItem> = {};
  if (hasField(body, 'name')) out.name = String(body.name || '');
  if (hasField(body, 'description')) out.description = String(body.description || '');
  if (hasField(body, 'price')) out.price = Number(body.price);
  if (hasField(body, 'roleId')) out.roleId = cleanId(body.roleId) || null;
  if (hasField(body, 'stock')) out.stock = body.stock == null || body.stock === '' ? null : Number(body.stock);
  if (hasField(body, 'perUserLimit')) out.perUserLimit = Number(body.perUserLimit);
  return out;
}
