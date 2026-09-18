import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config, env } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { Permission } from './permissions.js';
import { getClientToken, getApiBaseUrl } from './stoat-api.js';
import { getReadableError } from './error-utils.js';
import {
  BOT_PERMISSIONS,
  EVERYONE_TARGET,
  getBotPermissions,
  normalizeBotPermissionRule,
  removeBotPermissionRole,
  setBotPermissionRule,
  type BotPermissionRule,
} from './bot-permissions.js';
import { sendServerLog } from './log-system.js';

type PermissionOverride = { allow: number; deny: number };
type RoleSummary = { id: string; name: string; color: string; hoist: boolean; rank: number | null; permissions: PermissionOverride };

const MAX_BODY_BYTES = env.roleEditorMaxBodyBytes;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'role');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/roles',
  label: 'Role',
});
const PERMISSION_DEFINITIONS = Object.entries(Permission).map(([key, value]) => ({
  key,
  label: key.replace(/([a-z])([A-Z])/g, '$1 $2'),
  bit: Number(value),
}));

export async function handleRoleEditorRequest(request: IncomingMessage, response: ServerResponse, context: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/editor')) {
    sendHtml(response, renderEditorPage('Role Editor'));
    return;
  }

  if (request.method === 'GET' && url.pathname === '/editor.css') {
    sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/editor-app.js') {
    editorApp.send(response);
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      prefix: config.prefix,
      permissions: PERMISSION_DEFINITIONS,
      defaults: {
        angle: 90,
        colors: ['#ff4d8d', '#7c3aed', '#00d4ff'],
      },
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/roles') {
    sendJson(response, 200, { ok: true, roles: await listServerRoles(context.client, context.serverId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/roles') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const parsed = normalizeRoleEditRequest(body, { requireName: true });
    if (parsed.ok === false) {
      sendJson(response, 400, { ok: false, error: parsed.error });
      return;
    }

    try {
      const created = await createRole(context.client, context.serverId, parsed.data.name || 'New role');
      const roleId = normalizeCreatedRoleId(created);
      if (!roleId) throw new Error('role was created but no role ID was returned');

      const editData = { ...parsed.data };
      delete editData.name;
      if (Object.keys(editData).length > 0) await editRole(context.client, context.serverId, roleId, editData);
      if (parsed.permissions) await setRolePermissions(context.client, context.serverId, roleId, parsed.permissions);

      sendJson(response, 200, { ok: true, roleId, roles: await listServerRoles(context.client, context.serverId) });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `Failed to create role: ${getReadableError(error)}` });
    }
    return;
  }

  const roleRoute = url.pathname.match(/^\/api\/roles\/([^/]+)(?:\/(duplicate|permissions))?$/);
  if (roleRoute) {
    const roleId = normalizeId(decodeURIComponent(roleRoute[1]));
    const action = roleRoute[2];
    if (!roleId) {
      sendJson(response, 400, { ok: false, error: 'Invalid role ID.' });
      return;
    }

    if (request.method === 'DELETE' && !action) {
      try {
        await deleteRole(context.client, context.serverId, roleId);
        removeBotPermissionRole(context.serverId, roleId);
        sendJson(response, 200, { ok: true, roleId, roles: await listServerRoles(context.client, context.serverId) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `Failed to delete role: ${getReadableError(error)}` });
      }
      return;
    }

    if (request.method === 'PATCH' && !action) {
      const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
      const parsed = normalizeRoleEditRequest(body);
      if (parsed.ok === false) {
        sendJson(response, 400, { ok: false, error: parsed.error });
        return;
      }

      try {
        if (Object.keys(parsed.data).length > 0) await editRole(context.client, context.serverId, roleId, parsed.data);
        if (parsed.permissions) await setRolePermissions(context.client, context.serverId, roleId, parsed.permissions);
        sendJson(response, 200, { ok: true, roleId, roles: await listServerRoles(context.client, context.serverId) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `Failed to update role: ${getReadableError(error)}` });
      }
      return;
    }

    if (request.method === 'POST' && action === 'duplicate') {
      const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
      try {
        const source = (await listServerRoles(context.client, context.serverId)).find((role) => role.id === roleId);
        if (!source) throw new Error('source role not found in cache/API');
        const name = normalizeRoleName(body?.name, `${source.name} copy`);
        const created = await createRole(context.client, context.serverId, name);
        const newRoleId = normalizeCreatedRoleId(created);
        if (!newRoleId) throw new Error('role was duplicated but no role ID was returned');
        await editRole(context.client, context.serverId, newRoleId, { colour: source.color || undefined, hoist: source.hoist });
        await setRolePermissions(context.client, context.serverId, newRoleId, source.permissions);
        // A duplicate carries the source role's bot permissions too, matching
        // the Stoat permissions that were just copied.
        const sourceRule = getBotPermissions(context.serverId).roles[roleId];
        if (sourceRule) setBotPermissionRule(context.serverId, newRoleId, sourceRule);
        sendJson(response, 200, { ok: true, roleId: newRoleId, roles: await listServerRoles(context.client, context.serverId) });
      } catch (error) {
        sendJson(response, 400, { ok: false, error: `Failed to duplicate role: ${getReadableError(error)}` });
      }
      return;
    }

  }

  if (request.method === 'GET' && url.pathname === '/api/bot-permissions') {
    sendJson(response, 200, { ok: true, features: BOT_PERMISSIONS, rules: getBotPermissions(context.serverId) });
    return;
  }

  const botPermissionRoute = url.pathname.match(/^\/api\/bot-permissions\/([^/]+)$/);
  if (request.method === 'PUT' && botPermissionRoute) {
    const rawTarget = decodeURIComponent(botPermissionRoute[1]);
    const target = rawTarget === EVERYONE_TARGET ? EVERYONE_TARGET : normalizeId(rawTarget);
    if (!target) {
      sendJson(response, 400, { ok: false, error: 'Invalid role ID.' });
      return;
    }

    // A rule for a role id this server does not have would lie dormant until a
    // role with that id appeared, so only accept roles the server really has.
    const role = target === EVERYONE_TARGET
      ? null
      : (await listServerRoles(context.client, context.serverId)).find((entry) => entry.id === target);
    if (target !== EVERYONE_TARGET && !role) {
      sendJson(response, 404, { ok: false, error: 'That role is not in this server.' });
      return;
    }

    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const previous = ruleFor(getBotPermissions(context.serverId), target);
    const rules = setBotPermissionRule(context.serverId, target, normalizeBotPermissionRule(body));
    const targetLabel = role ? `${role.name} (\`${role.id}\`)` : 'Everyone';
    logBotPermissionChange(context.client, context.serverId, targetLabel, previous, ruleFor(rules, target));

    sendJson(response, 200, { ok: true, rules });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/roles/gradient') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const parsed = normalizeGradientRequest(body);
    if (parsed.ok === false) {
      sendJson(response, 400, { ok: false, error: parsed.error });
      return;
    }

    const payload = {
      type: 'ServerRoleUpdate',
      id: context.serverId,
      role_id: parsed.roleId,
      data: { color: parsed.gradient },
      clear: [],
    };

    try {
      const result = await updateRoleGradientColor(context.client, context.serverId, parsed.roleId, parsed.gradient, payload);
      sendJson(response, 200, { ok: true, roleId: parsed.roleId, gradient: parsed.gradient, method: result.method, payload });
    } catch (error) {
      sendJson(response, 400, {
        ok: false,
        error: `Failed to update role gradient: ${getReadableError(error)}`,
        roleId: parsed.roleId,
        gradient: parsed.gradient,
        payload,
      });
    }
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function ruleFor(rules: ReturnType<typeof getBotPermissions>, target: string): BotPermissionRule | undefined {
  return target === EVERYONE_TARGET ? rules.everyone : rules.roles[target];
}

/** Post a bot-permission change to the server's log channel, when logging is on. */
function logBotPermissionChange(
  client: any,
  serverId: string,
  targetLabel: string,
  previous: BotPermissionRule | undefined,
  next: BotPermissionRule | undefined,
) {
  const state = (rule: BotPermissionRule | undefined, key: string) =>
    rule?.deny.includes(key) ? 'Deny' : rule?.allow.includes(key) ? 'Allow' : 'Inherit';
  const changes = BOT_PERMISSIONS
    .filter((def) => state(previous, def.key) !== state(next, def.key))
    .map((def) => `• ${def.label}: ${state(previous, def.key)} → ${state(next, def.key)}`);
  if (changes.length === 0) return;

  sendServerLog(client, {
    title: 'Bot Permissions Updated',
    colour: '#06b6d4',
    description: [`**Target:** ${targetLabel}`, '**Changed from:** Dashboard', '', ...changes].join('\n'),
  }, serverId).catch(() => {});
}

async function listServerRoles(client: any, serverId: string): Promise<RoleSummary[]> {
  const roles = new Map<string, RoleSummary>();
  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));

  addRolesFromSource(roles, server?.roles?.cache);
  addRolesFromSource(roles, server?.roles);

  try {
    const rawServer = await client?.api?.get?.(`/servers/${serverId}`);
    addRolesFromSource(roles, rawServer?.roles);
  } catch {
    // Best-effort: cached roles are enough for manual role ID entry.
  }

  return Array.from(roles.values()).sort(compareRoleHierarchy);
}

function addRolesFromSource(target: Map<string, RoleSummary>, source: any) {
  for (const { key, value: role } of iterableEntries(source)) {
    const id = String(role?.id || role?._id || key || '').trim();
    if (!id) continue;

    target.set(id, {
      id,
      name: String(role?.name || role?.title || role?.displayName || role?.display_name || id).trim().slice(0, 80),
      color: normalizeRoleColor(role?.color || role?.colour || role?.colour_css || role?.color_css || ''),
      hoist: Boolean(role?.hoist),
      rank: Number.isFinite(Number(role?.rank)) ? Number(role.rank) : null,
      permissions: normalizePermissionOverride(role?.permissions),
    });
  }
}

function normalizePermissionOverride(value: any): PermissionOverride {
  const allow = value?.allow ?? value?.a ?? 0;
  const deny = value?.deny ?? value?.d ?? 0;
  return { allow: toSafePermissionNumber(allow), deny: toSafePermissionNumber(deny) };
}

function toSafePermissionNumber(value: any) {
  if (typeof value === 'bigint') return Number(value);
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeRoleEditRequest(value: any, options: { requireName?: boolean } = {}):
  | { ok: true; data: Record<string, any>; permissions?: PermissionOverride }
  | { ok: false; error: string } {
  const data: Record<string, any> = {};

  if (options.requireName || hasField(value, 'name')) {
    const name = normalizeRoleName(value?.name, '');
    if (!name) return { ok: false, error: 'Role name is required.' };
    data.name = name;
  }

  if (hasField(value, 'color') || hasField(value, 'colour') || hasField(value, 'gradient')) {
    const color = String(value?.gradient || value?.colour || value?.color || '').trim();
    if (color && !isSafeRoleColor(color)) return { ok: false, error: 'Invalid role color / gradient.' };
    data.colour = color || null;
  }

  if (hasField(value, 'hoist')) data.hoist = Boolean(value.hoist);

  let permissions: PermissionOverride | undefined;
  if (hasField(value, 'permissions')) {
    permissions = normalizePermissionOverride(value.permissions);
  }

  return { ok: true, data, permissions };
}

function normalizeRoleName(value: any, fallback: string) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 64);
  return name || fallback;
}

function isSafeRoleColor(value: string) {
  return /^#[0-9a-f]{3,8}$/i.test(value) || isSafeLinearGradient(value);
}

async function createRole(client: any, serverId: string, name: string) {
  const server = await resolveServer(client, serverId);
  if (server && typeof server.createRole === 'function') {
    try {
      return await server.createRole(name);
    } catch {
      // try direct REST below
    }
  }
  return roleFetch(client, serverId, '', 'POST', { name });
}

async function editRole(client: any, serverId: string, roleId: string, data: Record<string, any>) {
  const server = await resolveServer(client, serverId);
  if (server && typeof server.editRole === 'function') {
    try {
      return await server.editRole(roleId, data);
    } catch {
      // try direct REST below
    }
  }
  return roleFetch(client, serverId, roleId, 'PATCH', data);
}

async function deleteRole(client: any, serverId: string, roleId: string) {
  const server = await resolveServer(client, serverId);
  if (server && typeof server.deleteRole === 'function') {
    try {
      return await server.deleteRole(roleId);
    } catch {
      // try direct REST below
    }
  }
  return roleFetch(client, serverId, roleId, 'DELETE');
}

function compareRoleHierarchy(a: RoleSummary, b: RoleSummary) {
  const aRank = Number.isFinite(Number(a.rank)) ? Number(a.rank) : Number.MAX_SAFE_INTEGER;
  const bRank = Number.isFinite(Number(b.rank)) ? Number(b.rank) : Number.MAX_SAFE_INTEGER;
  return aRank - bRank || a.name.localeCompare(b.name);
}

async function setRolePermissions(client: any, serverId: string, roleId: string, permissions: PermissionOverride) {
  const server = await resolveServer(client, serverId);
  if (server && typeof server.setPermissions === 'function') {
    try {
      return await server.setPermissions(roleId, permissions);
    } catch {
      // try direct REST below
    }
  }
  return apiFetch(client, `/servers/${encodeURIComponent(serverId)}/permissions/${encodeURIComponent(roleId)}`, 'PUT', { permissions });
}

async function resolveServer(client: any, serverId: string) {
  return client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
}

async function roleFetch(client: any, serverId: string, roleId: string, method: string, body?: any) {
  const path = roleId
    ? `/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`
    : `/servers/${encodeURIComponent(serverId)}/roles`;
  return apiFetch(client, path, method, body);
}

async function apiFetch(client: any, path: string, method: string, body?: any) {
  const token = getClientToken(client);
  if (!token) throw new Error('missing bot token for direct role API call');

  const response = await fetch(`${getApiBaseUrl(client)}${path}`, {
    method,
    headers: {
      [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'User-Agent': 'YetAnotherOverengineeredStoatBot role-manager-editor',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (response.ok) {
    const text = await response.text().catch(() => '');
    return text ? JSON.parse(text) : null;
  }

  const responseText = await response.text().catch(() => '');
  throw new Error(`API call failed with status ${response.status}: ${response.statusText}` + (responseText ? ` (${responseText})` : ''));
}

function normalizeCreatedRoleId(value: any) {
  return String(value?.id || value?.roleId || value?.role_id || value?.role?.id || value?.role?._id || '').trim();
}

function iterableEntries(source: any): Array<{ key: string | null; value: any }> {
  if (!source) return [];
  if (source instanceof Map) return Array.from(source.entries()).map(([key, value]) => ({ key: String(key), value }));
  if (Array.isArray(source)) return source.map((value) => ({ key: null, value }));
  if (typeof source.entries === 'function') return Array.from(source.entries()).map(([key, value]: any) => ({ key: String(key), value }));
  if (typeof source === 'object') return Object.entries(source).map(([key, value]) => ({ key, value }));
  return [];
}

function normalizeRoleColor(value: any) {
  const color = String(value || '').trim();
  return color.length <= 320 && isSafeLinearGradient(color) ? color : /^#[0-9a-f]{3,8}$/i.test(color) ? color : '';
}

function normalizeGradientRequest(value: any):
  | { ok: true; roleId: string; gradient: string }
  | { ok: false; error: string } {
  const roleId = normalizeId(value?.roleId || value?.role || value?.id);
  if (!roleId) return { ok: false, error: 'Choose a valid role ID.' };

  const rawGradient = String(value?.gradient || '').trim();
  if (rawGradient) {
    return isSafeLinearGradient(rawGradient)
      ? { ok: true, roleId, gradient: rawGradient }
      : { ok: false, error: 'Invalid linear-gradient value.' };
  }

  const angle = normalizeAngle(value?.angle ?? 90);
  if (!isAngle(angle)) return { ok: false, error: 'Invalid angle. Use a number from 0 to 360.' };

  const colors = (Array.isArray(value?.colors) ? value.colors : [])
    .map((color) => normalizeCssColorToken(color))
    .filter((color): color is string => Boolean(color && isSafeCssColor(color)))
    .slice(0, 8);

  if (colors.length < 2) return { ok: false, error: 'Add at least two color stops.' };
  return { ok: true, roleId, gradient: `linear-gradient(${angle}, ${colors.join(', ')})` };
}

async function updateRoleGradientColor(client: any, serverId: string, roleId: string, gradient: string, rawPayload: any) {
  const errors: string[] = [];

  try {
    await patchRoleColorViaFetch(client, serverId, roleId, { colour: gradient });
    return { method: 'role edit API (`colour`)' };
  } catch (error) {
    errors.push(`direct API colour patch: ${getReadableError(error)}`);
  }

  try {
    await patchRoleColorViaFetch(client, serverId, roleId, { color: gradient });
    return { method: 'role edit API (`color`)' };
  } catch (error) {
    errors.push(`direct API color patch: ${getReadableError(error)}`);
  }

  if (typeof client?.api?.patch === 'function') {
    try {
      await client.api.patch(`/servers/${serverId}/roles/${roleId}`, { colour: gradient });
      return { method: 'client API patch (`colour`)' };
    } catch (error) {
      errors.push(`client API colour patch: ${getReadableError(error)}`);
    }

    try {
      await client.api.patch(`/servers/${serverId}/roles/${roleId}`, { color: gradient });
      return { method: 'client API patch (`color`)' };
    } catch (error) {
      errors.push(`client API color patch: ${getReadableError(error)}`);
    }
  }

  if (typeof client?.events?.send === 'function') {
    try {
      client.events.send(rawPayload);
      return { method: 'raw websocket `ServerRoleUpdate` payload fallback' };
    } catch (error) {
      errors.push(`raw websocket send: ${getReadableError(error)}`);
    }
  }

  throw new Error(errors.join(' | ') || 'no supported role color update method found');
}

async function patchRoleColorViaFetch(client: any, serverId: string, roleId: string, body: Record<string, string>) {
  const token = getClientToken(client);
  if (!token) throw new Error('missing bot token for direct role color API call');

  const response = await fetch(
    `${getApiBaseUrl(client)}/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'PATCH',
      headers: {
        [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
        'Content-Type': 'application/json',
        'User-Agent': 'YetAnotherOverengineeredStoatBot role-editor',
      },
      body: JSON.stringify(body),
    }
  );

  if (response.ok) return;
  const responseText = await response.text().catch(() => '');
  throw new Error(
    `API call failed with status ${response.status}: ${response.statusText}` +
      (responseText ? ` (${responseText})` : '')
  );
}

function isSafeLinearGradient(value: string): boolean {
  const gradient = String(value || '').trim();
  if (gradient.length > 320 || !/^linear-gradient\(.+\)$/i.test(gradient)) return false;
  if (/[;{}<>"']/.test(gradient)) return false;

  const inside = gradient.slice(gradient.indexOf('(') + 1, -1);
  const parts = splitCssArgs(inside);
  if (parts.length < 2) return false;

  const first = parts[0];
  const colorStops = isGradientDirection(first) ? parts.slice(1) : parts;
  return colorStops.length >= 2 && colorStops.length <= 8 && colorStops.every((part) => isSafeCssColorStop(part));
}

function splitCssArgs(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function isGradientDirection(value: string): boolean {
  const input = String(value || '').trim().toLowerCase();
  return isAngle(input) || /^to\s+(left|right|top|bottom)(\s+(left|right|top|bottom))?$/.test(input);
}

function isSafeCssColorStop(value: string): boolean {
  const input = String(value || '').trim();
  if (!input || /[;{}<>"']/.test(input)) return false;
  const parts = input.split(/\s+/);
  const color = parts.slice(0, Math.max(1, parts.length - 1)).join(' ');
  const maybePosition = parts.length > 1 ? parts[parts.length - 1] : null;
  return isSafeCssColor(color) && (!maybePosition || /^-?\d+(?:\.\d+)?(?:%|px|em|rem|vh|vw)?$/i.test(maybePosition));
}

function isSafeCssColor(value: string): boolean {
  const color = String(value || '').trim();
  if (!color || color.length > 80 || /[;{}<>"']/.test(color)) return false;
  return (
    /^#[0-9a-f]{3,8}$/i.test(color) ||
    /^[a-z][a-z0-9_-]*$/i.test(color) ||
    /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([^()]+\)$/i.test(color) ||
    /^var\(--[a-z0-9_-]+\)$/i.test(color)
  );
}

function normalizeCssColorToken(value: any): string | null {
  const color = String(value || '').trim().replace(/,+$/, '');
  return color || null;
}

function isAngle(value: any): boolean {
  const input = String(value || '').trim();
  return /^-?\d+(?:\.\d+)?(?:deg|grad|rad|turn)?$/i.test(input);
}

function normalizeAngle(value: any): string {
  const input = String(value || '').trim();
  return /^-?\d+(?:\.\d+)?$/.test(input) ? `${input}deg` : input;
}

function normalizeId(value: any) {
  const input = String(value || '').trim();
  if (!input) return null;
  const mentionMatch = input.match(/^<[@#&%]?(?:!|&)?([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const tagMatch = input.match(/^(?:<%([A-Za-z0-9_-]+)>|[%@#]<([A-Za-z0-9_-]+)>)$/);
  if (tagMatch?.[1] || tagMatch?.[2]) return tagMatch[1] || tagMatch[2];
  const prefixedMatch = input.match(/^[%@#]([A-Za-z0-9_-]+)$/);
  if (prefixedMatch?.[1]) return prefixedMatch[1];
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : null;
}
