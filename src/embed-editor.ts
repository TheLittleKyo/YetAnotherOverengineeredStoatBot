import { type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { MessageEmbed } from 'stoatbot.js';
import { config, env } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import { dataFile, ensureDataDir } from './json-store.js';

export type CustomEmbedConfig = {
  content?: string;
  title?: string;
  description?: string;
  color?: string;
  url?: string;
};

type SavedCustomEmbed = {
  id: string;
  serverId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  embed: CustomEmbedConfig;
};

type SavedEmbedsFile = { embeds: SavedCustomEmbed[] };

let savedEmbedsCache: SavedEmbedsFile | null = null;
let mentionLabelsCache: { expiresAt: number; serverId: string; labels: MentionLabels } | null = null;

type MentionLabels = {
  users: Record<string, string>;
  channels: Record<string, string>;
  roles: Record<string, string>;
};

const MAX_BODY_BYTES = env.embedEditorMaxBodyBytes;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'embed');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/embed',
  label: 'Embed',
});
const EMBEDS_FILE = dataFile('custom-embeds.json');

export async function handleEmbedEditorRequest(request: IncomingMessage, response: ServerResponse, context: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/editor')) {
    sendHtml(response, renderEditorPage('Embed Editor'));
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
      defaults: defaultEmbedConfig(),
      limits: { content: 1800, title: 256, description: 4000 },
      channels: await listTextChannels(context.client, context.serverId),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/embeds') {
    sendJson(response, 200, { ok: true, embeds: listSavedEmbeds(context.serverId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/mentions/resolve') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const labels = await resolveMentionLabels(context.client, context.serverId, body?.mentions || body);
    sendJson(response, 200, { ok: true, labels });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/embeds') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const saved = createSavedEmbed(body?.name, body?.embed || body, context.serverId);
    sendJson(response, saved ? 200 : 400, {
      ok: Boolean(saved),
      embed: saved,
      error: saved ? undefined : 'Could not save embed. Add content, a title, or a description first.',
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/embeds/send') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
    const result = await sendCustomEmbedSafe(context.client, body?.channelId, body?.embed || body, body?.content);
    sendJson(response, result.ok ? 200 : 400, result);
    return;
  }

  const embedRoute = url.pathname.match(/^\/api\/embeds\/([^/]+)$/);
  if (embedRoute) {
    const embedId = decodeURIComponent(embedRoute[1]);

    if (request.method === 'GET') {
      const saved = getSavedEmbed(embedId, context.serverId);
      sendJson(response, saved ? 200 : 404, { ok: Boolean(saved), embed: saved, error: saved ? undefined : 'Embed not found.' });
      return;
    }

    if (request.method === 'PUT') {
      const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES, reportLimit: true });
      const saved = updateSavedEmbed(embedId, body, context.serverId);
      sendJson(response, saved ? 200 : 404, { ok: Boolean(saved), embed: saved, error: saved ? undefined : 'Embed not found or invalid.' });
      return;
    }

    if (request.method === 'DELETE') {
      const deleted = deleteSavedEmbed(embedId, context.serverId);
      sendJson(response, deleted ? 200 : 404, { ok: deleted, error: deleted ? undefined : 'Embed not found.' });
      return;
    }
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

export async function sendCustomEmbed(client: any, channelIdValue: any, embedValue: any, contentValue?: any) {
  const channelId = normalizeId(channelIdValue);
  if (!channelId) return { ok: false, error: 'Choose a valid channel ID.' };

  const embedConfig = normalizeEmbedConfig({ ...(embedValue || {}), ...(hasField(embedValue, 'content') ? {} : { content: contentValue }) });
  if (!hasSendableBody(embedConfig)) return { ok: false, error: 'Add message content, a title, or a description before sending.' };

  const channel = await resolveTextChannel(client, channelId);
  if (!channel) return { ok: false, error: `Could not find text channel ${channelId}.` };

  const payload = toSendPayload(embedConfig);
  await channel.send(payload);
  return { ok: true, channelId };
}

async function sendCustomEmbedSafe(client: any, channelIdValue: any, embedValue: any, contentValue?: any) {
  try {
    return await sendCustomEmbed(client, channelIdValue, embedValue, contentValue);
  } catch (error) {
    return { ok: false, error: normalizeRequestError(error, 'Failed to send embed.') };
  }
}

function toMessageEmbed(config: CustomEmbedConfig) {
  const embed = new MessageEmbed();
  if (config.title) embed.setTitle(config.title);
  if (config.description) embed.setDescription(config.description);
  if (config.color) embed.setColor(config.color);
  if (config.url) embed.setURL(config.url);
  return embed;
}

function toSendPayload(embedConfig: CustomEmbedConfig) {
  const payload: any = {};

  if (embedConfig.content) {
    payload.content = embedConfig.content;
  }

  if (embedConfig.title || embedConfig.description || embedConfig.url) {
    payload.embeds = [toMessageEmbed(embedConfig)];
  }

  return payload;
}

async function resolveTextChannel(client: any, channelId: string) {
  const channel = client?.channels?.cache?.get?.(channelId) || (await client?.channels?.fetch?.(channelId).catch(() => null));
  if (!channel || (typeof channel.isText === 'function' && !channel.isText())) return null;
  return typeof channel.send === 'function' ? channel : null;
}

async function resolveMentionLabels(client: any, serverId: string, mentionsValue: any) {
  const mentions = normalizeMentionLookupRequest(mentionsValue);
  const allLabels = buildMentionLabelCache(client, serverId);

  const users: Record<string, string> = {};
  const channels: Record<string, string> = {};
  const roles: Record<string, string> = {};

  for (const userId of mentions.users) {
    if (allLabels.users[userId]) users[userId] = allLabels.users[userId];
  }

  for (const channelId of mentions.channels) {
    if (allLabels.channels[channelId]) channels[channelId] = allLabels.channels[channelId];
  }

  for (const roleId of mentions.roles) {
    if (allLabels.roles[roleId]) roles[roleId] = allLabels.roles[roleId];
  }

  return { users, channels, roles };
}

function buildMentionLabelCache(client: any, serverId: string): MentionLabels {
  const now = Date.now();
  if (mentionLabelsCache?.serverId === serverId && mentionLabelsCache.expiresAt > now) {
    return mentionLabelsCache.labels;
  }

  const server = client?.servers?.cache?.get?.(serverId);
  const labels: MentionLabels = { users: {}, channels: {}, roles: {} };

  addUsersFromSource(labels.users, client?.users?.cache);
  addUsersFromSource(labels.users, server?.members?.cache, true);
  addUsersFromSource(labels.users, server?.members, true);
  addChannelsFromSource(labels.channels, client?.channels?.cache);
  addChannelsFromSource(labels.channels, server?.channels?.cache);
  addChannelsFromSource(labels.channels, server?.channels);
  addRolesFromSource(labels.roles, server?.roles?.cache);
  addRolesFromSource(labels.roles, server?.roles);

  mentionLabelsCache = { serverId, expiresAt: now + 10_000, labels };
  return labels;
}

function addUsersFromSource(target: Record<string, string>, source: any, sourceIsMembers = false) {
  for (const item of iterableValues(source)) {
    const id = getUserIdFromValue(item, sourceIsMembers);
    const label = sourceIsMembers ? getMemberLabel(item) : getUserLabel(item);
    if (id && label && !target[id]) target[id] = label;
  }
}

function addChannelsFromSource(target: Record<string, string>, source: any) {
  for (const channel of iterableValues(source)) {
    const id = String(channel?.id || channel?._id || '').trim();
    const label = normalizeMentionLabel(channel?.name || channel?.title || channel?.displayName || channel?.display_name || '');
    if (id && label && !target[id]) target[id] = label;
  }
}

function addRolesFromSource(target: Record<string, string>, source: any) {
  for (const role of iterableValues(source)) {
    const id = String(role?.id || role?._id || '').trim();
    const label = normalizeMentionLabel(role?.name || role?.title || role?.displayName || role?.display_name || '');
    if (id && label && !target[id]) target[id] = label;
  }
}

function iterableValues(source: any): any[] {
  if (!source) return [];
  if (source instanceof Map) return Array.from(source.values());
  if (typeof source.values === 'function') return Array.from(source.values());
  if (Array.isArray(source)) return source;
  if (typeof source === 'object') return Object.values(source);
  return [];
}

function getUserIdFromValue(value: any, valueIsMember = false) {
  if (!value) return '';
  if (valueIsMember) {
    return String(value?.id?.user || value?._id?.user || value?.userId || value?.user_id || value?.user?.id || value?.user?._id || '').trim();
  }
  return String(value?.id || value?._id || value?.userId || value?.user_id || '').trim();
}

function getUserLabel(user: any) {
  return normalizeMentionLabel(user?.displayName || user?.display_name || user?.username || '');
}

function getMemberLabel(member: any) {
  return normalizeMentionLabel(
    member?.nickname ||
    member?.displayName ||
    member?.display_name ||
    member?.username ||
    member?.user?.displayName ||
    member?.user?.display_name ||
    member?.user?.username ||
    ''
  );
}

function normalizeMentionLookupRequest(value: any) {
  return {
    users: normalizeMentionIds(value?.users),
    channels: normalizeMentionIds(value?.channels),
    roles: normalizeMentionIds(value?.roles),
  };
}

function normalizeMentionIds(value: any) {
  return Array.from(new Set(
    (Array.isArray(value) ? value : [])
      .map((id) => String(id || '').trim())
      .filter((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id))
      .slice(0, 50)
  ));
}

function normalizeMentionLabel(value: any) {
  return String(value || '').trim().replace(/^[@#%]+/, '').replace(/\s+/g, ' ').slice(0, 80);
}

function normalizeRequestError(error: any, fallback: string) {
  const status = error?.response?.status || error?.status || error?.code;
  if (String(status) === '429') return 'Rate limited by Stoat. Please wait a moment and try again.';
  const message = error?.response?.data?.error || error?.response?.data?.message || error?.message || '';
  return message ? `${fallback} ${message}` : fallback;
}

function readSavedEmbedsFile(): SavedEmbedsFile {
  if (savedEmbedsCache) return savedEmbedsCache;

  try {
    if (!existsSync(EMBEDS_FILE)) {
      savedEmbedsCache = { embeds: [] };
      return savedEmbedsCache;
    }

    const raw = readFileSync(EMBEDS_FILE, 'utf-8').trim();
    if (!raw) {
      savedEmbedsCache = { embeds: [] };
      return savedEmbedsCache;
    }

    const parsed = JSON.parse(raw);
    savedEmbedsCache = {
      embeds: Array.isArray(parsed?.embeds) ? parsed.embeds.map(normalizeSavedEmbed).filter(Boolean) : [],
    } as SavedEmbedsFile;
    return savedEmbedsCache;
  } catch (error) {
    console.error('Failed to read saved embeds:', error?.message || error);
    savedEmbedsCache = { embeds: [] };
    return savedEmbedsCache;
  }
}

function writeSavedEmbedsFile(data: SavedEmbedsFile) {
  savedEmbedsCache = data;
  ensureDataDir();
  writeFileSync(EMBEDS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function listSavedEmbeds(serverId: string) {
  return readSavedEmbedsFile().embeds
    .filter((embed) => embed.serverId === serverId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(cloneSavedEmbed);
}

function getSavedEmbed(id: string, serverId: string) {
  const saved = readSavedEmbedsFile().embeds.find((item) => item.serverId === serverId && item.id === id);
  return saved ? cloneSavedEmbed(saved) : null;
}

function createSavedEmbed(nameValue: any, embedValue: any, serverId: string) {
  const embed = normalizeEmbedConfig(embedValue);
  if (!hasSendableBody(embed)) return null;

  const now = new Date().toISOString();
  const saved: SavedCustomEmbed = {
    id: createEmbedId(),
    serverId,
    name: normalizeName(nameValue, `Embed ${new Date().toLocaleString()}`),
    createdAt: now,
    updatedAt: now,
    embed,
  };

  const data = readSavedEmbedsFile();
  writeSavedEmbedsFile({ embeds: data.embeds.concat(saved) });
  return cloneSavedEmbed(saved);
}

function updateSavedEmbed(id: string, body: any, serverId: string) {
  const data = readSavedEmbedsFile();
  const index = data.embeds.findIndex((item) => item.serverId === serverId && item.id === id);
  if (index < 0) return null;

  const current = data.embeds[index];
  const nextEmbed = hasField(body, 'embed') ? normalizeEmbedConfig(body.embed) : current.embed;
  if (!hasSendableBody(nextEmbed)) return null;

  const next: SavedCustomEmbed = {
    ...current,
    name: hasField(body, 'name') ? normalizeName(body.name, current.name) : current.name,
    updatedAt: new Date().toISOString(),
    embed: nextEmbed,
  };

  const embeds = data.embeds.slice();
  embeds[index] = next;
  writeSavedEmbedsFile({ embeds });
  return cloneSavedEmbed(next);
}

function deleteSavedEmbed(id: string, serverId: string) {
  const data = readSavedEmbedsFile();
  const nextEmbeds = data.embeds.filter((item) => !(item.serverId === serverId && item.id === id));
  if (nextEmbeds.length === data.embeds.length) return false;
  writeSavedEmbedsFile({ embeds: nextEmbeds });
  return true;
}

function normalizeSavedEmbed(value: any): SavedCustomEmbed | null {
  const serverId = String(value?.serverId || '').trim();
  const embed = normalizeEmbedConfig(value?.embed || value);
  if (!serverId || !hasSendableBody(embed)) return null;
  const now = new Date().toISOString();

  return {
    id: String(value?.id || createEmbedId()).slice(0, 80),
    serverId,
    name: normalizeName(value?.name, 'Embed'),
    createdAt: normalizeIsoDate(value?.createdAt, now),
    updatedAt: normalizeIsoDate(value?.updatedAt, now),
    embed,
  };
}

function defaultEmbedConfig(): CustomEmbedConfig {
  return {
    content: '',
    title: `${config.botName} Embed`,
    description: 'Write your custom embed description here.',
    color: '#00bcd4',
    url: '',
  };
}

function normalizeEmbedConfig(value: any): CustomEmbedConfig {
  return {
    content: normalizeText(value?.content, 1800),
    title: normalizeText(value?.title, 256),
    description: normalizeText(value?.description, 4000),
    color: normalizeColor(value?.color, '#00bcd4'),
    url: normalizeUrl(value?.url),
  };
}

function hasSendableBody(embed: CustomEmbedConfig) {
  return Boolean(embed.content || embed.title || embed.description);
}

function normalizeText(value: any, maxLength: number) {
  return String(value || '').trim().slice(0, maxLength);
}

function normalizeColor(value: any, fallback: string) {
  const color = String(value || '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function normalizeUrl(value: any) {
  const text = String(value || '').trim().slice(0, 1200);
  if (!text) return '';
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function normalizeName(value: any, fallback: string) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return name || fallback;
}

function normalizeIsoDate(value: any, fallback: string) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}

function normalizeId(value: any) {
  const input = String(value || '').trim();
  if (!input) return null;
  const mentionMatch = input.match(/^<[@#%]?!?([A-Za-z0-9_-]+)>$/);
  if (mentionMatch?.[1]) return mentionMatch[1];
  const prefixedMatch = input.match(/^[#]([A-Za-z0-9_-]+)$/);
  if (prefixedMatch?.[1]) return prefixedMatch[1];
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : null;
}

function createEmbedId() {
  return `embed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSavedEmbed(embed: SavedCustomEmbed): SavedCustomEmbed {
  return JSON.parse(JSON.stringify(embed));
}
