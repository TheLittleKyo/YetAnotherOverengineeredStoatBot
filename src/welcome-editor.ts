import { type IncomingMessage, type ServerResponse } from 'http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config, env } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels } from './editor-lists.js';
import {
  getEffectiveWelcomeConfig,
  updateWelcomeConfig,
  type WelcomeConfig,
  type WelcomeAvatarLayer,
  type WelcomeImageLayer,
  type WelcomeLayerRef,
  type WelcomeTextLayer,
} from './welcome.js';
import { dataFile, ensureDataDir } from './json-store.js';

type EditorContext = { client?: any; serverId: string };
type SavedWelcomeImage = {
  id: string;
  serverId: string;
  name: string;
  selected: boolean;
  createdAt: string;
  updatedAt: string;
  config: WelcomeConfig;
};
type SavedWelcomeImagesFile = { images: SavedWelcomeImage[] };

const MAX_EDITOR_BODY_BYTES = env.welcomeEditorMaxBodyBytes;
const MAX_EDITOR_IMAGE_BYTES = 10 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'welcome');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/welcome',
  label: 'Welcome',
  define: { __WELCOME_EDITOR_MAX_IMAGE_BYTES__: JSON.stringify(MAX_EDITOR_IMAGE_BYTES) },
});
const WELCOME_IMAGES_FILE = dataFile('welcome-images.json');
const GOOGLE_FONTS_API_KEY = env.googleApiKey;
const SYSTEM_EDITOR_FONTS = [
  'Segoe UI',
  'Arial',
  'Arial Black',
  'Verdana',
  'Tahoma',
  'Trebuchet MS',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Lucida Console',
  'Impact',
  'Comic Sans MS',
];
const FALLBACK_GOOGLE_FONTS = [
  'Inter',
  'Roboto',
  'Open Sans',
  'Montserrat',
  'Poppins',
  'Lato',
  'Oswald',
  'Raleway',
  'Nunito',
  'Merriweather',
  'Playfair Display',
  'Bebas Neue',
  'Lobster',
  'Pacifico',
  'Dancing Script',
  'Anton',
  'Archivo Black',
  'Cinzel',
  'Fira Sans',
  'Rubik',
  'Source Sans 3',
  'Ubuntu',
  'Work Sans',
  'Noto Sans',
  'Roboto Condensed',
  'Roboto Slab',
  'Quicksand',
  'Josefin Sans',
  'Abril Fatface',
  'Caveat',
];
const WELCOME_EDITOR_FONTS = Array.from(new Set(SYSTEM_EDITOR_FONTS.concat(FALLBACK_GOOGLE_FONTS)));
let googleFontsCache: string[] | null = null;
let savedImagesCache: SavedWelcomeImagesFile | null = null;

export async function handleWelcomeEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: EditorContext) {
  // Never operate with an empty server: saved designs are keyed by serverId, so
  // an empty one makes every save fail (buildSavedWelcomeConfig returns null) and
  // the library read find nothing. Fall back to the configured default server.
  const serverId = ctx.serverId || config.serverId;
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);

  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }

  if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/editor' || url.pathname === '/playlist')) {
    sendHtml(response, renderEditorPage('Welcomer'));
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
      config: getEffectiveWelcomeConfig(serverId),
      placeholders: ['{user}', '{username}', '{display}', '{mention}', '{server}', '{count}'],
      channels: await listTextChannels(ctx.client, serverId),
    });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/fonts') {
    sendJson(response, 200, { ok: true, fonts: await getEditorFonts(), source: GOOGLE_FONTS_API_KEY ? 'google' : 'fallback' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/images') {
    sendJson(response, 200, { ok: true, images: listSavedWelcomeImages(serverId) });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images') {
    const body = await readJsonBody(request, { maxBytes: MAX_EDITOR_BODY_BYTES, reportLimit: true });
    const image = createSavedWelcomeImage(body?.name, body?.config || body, serverId, body?.selected);
    sendJson(response, image ? 200 : 400, {
      ok: Boolean(image),
      image,
      error: image ? undefined : 'Could not save welcome image.',
    });
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/images/selection') {
    const body = await readJsonBody(request, { maxBytes: MAX_EDITOR_BODY_BYTES, reportLimit: true });
    const images = updateSelectedWelcomeImages(body?.selectedIds, serverId);
    sendJson(response, images ? 200 : 400, {
      ok: Boolean(images),
      images,
      error: images ? undefined : 'Could not update selected welcome images.',
    });
    return;
  }

  const imageRoute = url.pathname.match(/^\/api\/images\/([^/]+)(?:\/(activate))?$/);
  if (imageRoute) {
    const imageId = decodeURIComponent(imageRoute[1]);
    const action = imageRoute[2];

    if (request.method === 'GET' && !action) {
      const image = getSavedWelcomeImage(imageId, serverId);
      sendJson(response, image ? 200 : 404, { ok: Boolean(image), image, error: image ? undefined : 'Welcome image not found.' });
      return;
    }

    if (request.method === 'PUT' && !action) {
      const body = await readJsonBody(request, { maxBytes: MAX_EDITOR_BODY_BYTES, reportLimit: true });
      const image = updateSavedWelcomeImage(imageId, body, serverId);
      sendJson(response, image ? 200 : 404, { ok: Boolean(image), image, error: image ? undefined : 'Welcome image not found.' });
      return;
    }

    if (request.method === 'DELETE' && !action) {
      const deleted = deleteSavedWelcomeImage(imageId, serverId);
      sendJson(response, deleted ? 200 : 404, { ok: deleted, error: deleted ? undefined : 'Welcome image not found.' });
      return;
    }

    if (request.method === 'POST' && action === 'activate') {
      const image = getSavedWelcomeImage(imageId, serverId);
      const next = image ? updateWelcomeConfig(toWelcomeConfigUpdates(image.config), serverId) : null;
      sendJson(response, next ? 200 : 404, {
        ok: Boolean(next),
        image,
        config: next,
        error: next ? undefined : 'Welcome image not found.',
      });
      return;
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/config') {
    const body = await readJsonBody(request, { maxBytes: MAX_EDITOR_BODY_BYTES, reportLimit: true });
    const next = updateWelcomeConfig(toWelcomeConfigUpdates(body), serverId);
    sendJson(response, next ? 200 : 400, {
      ok: Boolean(next),
      config: next,
      error: next ? undefined : 'Could not save welcome config.',
    });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function readSavedImagesFile(): SavedWelcomeImagesFile {
  if (savedImagesCache) return savedImagesCache;

  try {
    if (!existsSync(WELCOME_IMAGES_FILE)) {
      savedImagesCache = { images: [] };
      return savedImagesCache;
    }

    const raw = readFileSync(WELCOME_IMAGES_FILE, 'utf-8').trim();
    if (!raw) {
      savedImagesCache = { images: [] };
      return savedImagesCache;
    }

    const parsed = JSON.parse(raw);
    savedImagesCache = {
      images: Array.isArray(parsed?.images) ? parsed.images.map(normalizeSavedWelcomeImage).filter(Boolean) : [],
    } as SavedWelcomeImagesFile;
    return savedImagesCache;
  } catch (error) {
    console.error('Failed to read saved welcome images:', error?.message || error);
    savedImagesCache = { images: [] };
    return savedImagesCache;
  }
}

function writeSavedImagesFile(data: SavedWelcomeImagesFile) {
  savedImagesCache = data;
  ensureDataDir();
  writeFileSync(WELCOME_IMAGES_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function listSavedWelcomeImages(serverId: string) {
  return readSavedImagesFile().images
    .filter((image) => image.serverId === serverId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(cloneSavedWelcomeImage);
}

function getSavedWelcomeImage(id: string, serverId: string) {
  const image = readSavedImagesFile().images.find((item) => item.serverId === serverId && item.id === id);
  return image ? cloneSavedWelcomeImage(image) : null;
}

function createSavedWelcomeImage(name: any, configValue: any, serverId: string, selectedValue: any = false) {
  const now = new Date().toISOString();
  const config = buildSavedWelcomeConfig(configValue, serverId);
  if (!config) return null;

  const image: SavedWelcomeImage = {
    id: createImageId(),
    serverId,
    name: normalizeImageName(name, `Welcome image ${new Date().toLocaleString()}`),
    selected: Boolean(selectedValue),
    createdAt: now,
    updatedAt: now,
    config,
  };

  const data = readSavedImagesFile();
  writeSavedImagesFile({ images: data.images.concat(image) });
  return cloneSavedWelcomeImage(image);
}

function updateSavedWelcomeImage(id: string, body: any, serverId: string) {
  const data = readSavedImagesFile();
  const index = data.images.findIndex((item) => item.serverId === serverId && item.id === id);
  if (index < 0) return null;

  const current = data.images[index];
  const nextConfig = hasField(body, 'config') ? buildSavedWelcomeConfig(body.config, serverId) : current.config;
  if (!nextConfig) return null;

  const next: SavedWelcomeImage = {
    ...current,
    name: hasField(body, 'name') ? normalizeImageName(body.name, current.name) : current.name,
    selected: hasField(body, 'selected') ? Boolean(body.selected) : current.selected,
    updatedAt: new Date().toISOString(),
    config: nextConfig,
  };

  const images = data.images.slice();
  images[index] = next;
  writeSavedImagesFile({ images });
  return cloneSavedWelcomeImage(next);
}

function updateSelectedWelcomeImages(selectedIdsValue: any, serverId: string) {
  if (!Array.isArray(selectedIdsValue)) return null;
  const selectedIds = new Set(selectedIdsValue.map((id) => String(id || '').trim()).filter(Boolean));
  const data = readSavedImagesFile();
  let changed = false;
  const now = new Date().toISOString();
  const images = data.images.map((image) => {
    if (image.serverId !== serverId) return image;
    const selected = selectedIds.has(image.id);
    if (image.selected === selected) return image;
    changed = true;
    return { ...image, selected, updatedAt: now };
  });

  if (changed) writeSavedImagesFile({ images });
  return listSavedWelcomeImages(serverId);
}

function deleteSavedWelcomeImage(id: string, serverId: string) {
  const data = readSavedImagesFile();
  const nextImages = data.images.filter((item) => !(item.serverId === serverId && item.id === id));
  if (nextImages.length === data.images.length) return false;
  writeSavedImagesFile({ images: nextImages });
  return true;
}

function normalizeSavedWelcomeImage(value: any): SavedWelcomeImage | null {
  const serverId = String(value?.serverId || '').trim();
  const config = buildSavedWelcomeConfig(value?.config, serverId);
  if (!serverId || !config) return null;

  const now = new Date().toISOString();
  return {
    id: String(value?.id || createImageId()).slice(0, 80),
    serverId,
    name: normalizeImageName(value?.name, 'Welcome image'),
    selected: Boolean(value?.selected),
    createdAt: normalizeIsoDate(value?.createdAt, now),
    updatedAt: normalizeIsoDate(value?.updatedAt, now),
    config,
  };
}

function buildSavedWelcomeConfig(value: any, serverId: string): WelcomeConfig | null {
  if (!serverId) return null;
  const base = getEffectiveWelcomeConfig(serverId);
  if (!base) return null;
  return {
    ...base,
    ...toWelcomeConfigUpdates(value || {}),
    serverId,
  };
}

function normalizeImageName(value: any, fallback: string) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  return name || fallback;
}

function normalizeIsoDate(value: any, fallback: string) {
  const text = String(value || '').trim();
  return Number.isFinite(Date.parse(text)) ? text : fallback;
}

function createImageId() {
  return `welcome-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneSavedWelcomeImage(image: SavedWelcomeImage): SavedWelcomeImage {
  return JSON.parse(JSON.stringify(image));
}

function toWelcomeConfigUpdates(body: any): Partial<WelcomeConfig> {
  const updates: Partial<WelcomeConfig> = {};
  if (hasField(body, 'enabled')) updates.enabled = Boolean(body.enabled);
  if (hasField(body, 'channelId')) updates.channelId = optionalText(body.channelId);
  if (hasField(body, 'message')) updates.message = String(body.message || '').trim();
  if (hasField(body, 'imageEnabled')) updates.imageEnabled = Boolean(body.imageEnabled);
  if (hasField(body, 'background')) updates.background = String(body.background || '').trim();
  if (hasField(body, 'backgroundImageDataUri')) updates.backgroundImageDataUri = normalizeImageDataUri(body.backgroundImageDataUri);
  if (hasField(body, 'textColor')) updates.textColor = String(body.textColor || '').trim();
  if (hasField(body, 'accentColor')) updates.accentColor = String(body.accentColor || '').trim();
  if (hasField(body, 'cardTemplate')) updates.cardTemplate = normalizeCardTemplate(body.cardTemplate) as any;
  if (hasField(body, 'showAvatar')) updates.showAvatar = Boolean(body.showAvatar);
  if (hasField(body, 'titleText')) updates.titleText = String(body.titleText || '').trim();
  if (hasField(body, 'subtitleText')) updates.subtitleText = String(body.subtitleText || '').trim();
  if (hasField(body, 'footerText')) updates.footerText = String(body.footerText || '').trim();
  if (hasField(body, 'outputWidth')) updates.outputWidth = Math.round(clampNumber(body.outputWidth, 64, 8192, 1200));
  if (hasField(body, 'outputHeight')) updates.outputHeight = Math.round(clampNumber(body.outputHeight, 64, 8192, 620));
  if (hasField(body, 'textLayers')) updates.textLayers = normalizeTextLayers(body.textLayers);
  if (hasField(body, 'imageLayers')) updates.imageLayers = normalizeImageLayers(body.imageLayers);
  if (hasField(body, 'avatarLayer')) updates.avatarLayer = normalizeAvatarLayer(body.avatarLayer);
  if (hasField(body, 'customFonts')) updates.customFonts = normalizeCustomFonts(body.customFonts) as any;
  if (hasField(body, 'layerOrder')) updates.layerOrder = normalizeLayerOrder(body.layerOrder, updates.textLayers || body.textLayers, updates.imageLayers || body.imageLayers, hasField(body, 'avatarLayer') ? updates.avatarLayer : body.avatarLayer);

  const layout = String(body?.layout || '').trim().toLowerCase();
  if (layout === 'classic' || layout === 'compact' || layout === 'banner') updates.layout = layout;
  return updates;
}

function optionalText(value: any) {
  const text = String(value || '').trim();
  return text || undefined;
}

function normalizeImageDataUri(value: any) {
  const dataUri = String(value || '').trim();
  if (!dataUri) return undefined;
  if (!/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(dataUri)) return undefined;
  if (dataUri.length > 7 * 1024 * 1024) return undefined;
  return dataUri;
}

function normalizeCustomFonts(value: any) {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .slice(0, 16)
    .flatMap((font, index) => {
      const dataUri = normalizeFontDataUri(font?.dataUri);
      const fontFamily = normalizeFontFamily(font?.fontFamily || font?.name || `Custom Font ${index + 1}`);
      if (!dataUri || seen.has(fontFamily)) return [];
      seen.add(fontFamily);
      return [{
        id: String(font?.id || `font-${index + 1}`).replace(/[^\w-]/g, '').slice(0, 80) || `font-${index + 1}`,
        name: String(font?.name || fontFamily).trim().replace(/\s+/g, ' ').slice(0, 80) || fontFamily,
        fontFamily,
        dataUri,
        mimeType: dataUri.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || 'font/ttf',
      }];
    });
}

function normalizeFontDataUri(value: any) {
  const dataUri = String(value || '').trim();
  if (!dataUri) return undefined;
  if (dataUri.length > 6 * 1024 * 1024) return undefined;
  if (!/^data:(?:font\/(?:ttf|otf|woff2?|sfnt)|application\/(?:font-woff2?|x-font-ttf|x-font-opentype|octet-stream));base64,[a-z0-9+/=]+$/i.test(dataUri)) return undefined;
  return dataUri;
}

function normalizeTextLayers(value: any): WelcomeTextLayer[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 12)
    .map((layer, index) => ({
      id: String(layer?.id || `layer-${index + 1}`).slice(0, 64),
      enabled: layer?.enabled !== false,
      text: String(layer?.text || '').trim().slice(0, 160),
      x: clampNumber(layer?.x, 0, 1200, 600),
      y: clampNumber(layer?.y, 0, 620, 310),
      fontSize: clampNumber(layer?.fontSize, 8, 160, 56),
      width: clampNumber(layer?.width, 8, 2400, 240),
      fontFamily: normalizeFontFamily(layer?.fontFamily),
      color: normalizeColor(layer?.color, '#ffffff'),
      fontWeight: Math.round(clampNumber(layer?.fontWeight, 100, 1000, 800)),
      fontStyle: normalizeFontStyle(layer?.fontStyle),
      anchor: ['start', 'middle', 'end'].includes(String(layer?.anchor)) ? layer.anchor : 'middle',
      rotation: normalizeRotation(layer?.rotation),
      shadowEnabled: layer?.shadowEnabled !== false,
      shadowColor: normalizeColor(layer?.shadowColor, '#000000'),
      shadowBlur: clampNumber(layer?.shadowBlur, 0, 80, 10),
      shadowOffsetX: clampNumber(layer?.shadowOffsetX, -80, 80, 0),
      shadowOffsetY: clampNumber(layer?.shadowOffsetY, -80, 80, 3),
      highlightEnabled: Boolean(layer?.highlightEnabled),
      highlightColor: normalizeColor(layer?.highlightColor, '#38bdf8'),
      highlightOpacity: clampNumber(layer?.highlightOpacity, 0, 1, 0.35),
      highlightPadding: clampNumber(layer?.highlightPadding, 0, 80, 8),
      outlineEnabled: Boolean(layer?.outlineEnabled),
      outlineColor: normalizeColor(layer?.outlineColor, '#000000'),
      outlineWidth: clampNumber(layer?.outlineWidth, 0, 24, 2),
    }))
    .filter((layer) => layer.text);
}

function normalizeImageLayers(value: any): WelcomeImageLayer[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, 16)
    .map((layer, index) => ({
      id: String(layer?.id || `image-${index + 1}`).slice(0, 64),
      enabled: layer?.enabled !== false,
      imageDataUri: normalizeImageDataUri(layer?.imageDataUri) || '',
      x: clampNumber(layer?.x, -1200, 1200, 100),
      y: clampNumber(layer?.y, -620, 620, 100),
      width: clampNumber(layer?.width, 8, 2400, 240),
      height: clampNumber(layer?.height, 8, 1240, 240),
      opacity: clampNumber(layer?.opacity, 0, 1, 1),
      rotation: normalizeRotation(layer?.rotation),
    }))
    .filter((layer) => layer.imageDataUri);
}

function normalizeAvatarLayer(value: any): WelcomeAvatarLayer | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const shape = String(value.shape || '').toLowerCase();
  return {
    id: 'avatar',
    enabled: value.enabled !== false,
    x: clampNumber(value.x, -1200, 1200, 100),
    y: clampNumber(value.y, -620, 1240, 100),
    size: clampNumber(value.size, 24, 1200, 200),
    shape: shape === 'rounded' || shape === 'square' ? shape : 'circle',
    ringEnabled: value.ringEnabled !== false,
    ringColor: normalizeColor(value.ringColor, '#38bdf8'),
    ringWidth: clampNumber(value.ringWidth, 0, 60, 10),
    rotation: normalizeRotation(value.rotation),
  };
}

function normalizeLayerOrder(value: any, textLayersValue: any, imageLayersValue: any, avatarLayerValue?: any): WelcomeLayerRef[] {
  const textIds = new Set((Array.isArray(textLayersValue) ? textLayersValue : []).map((layer) => String(layer?.id || '')).filter(Boolean));
  const imageIds = new Set((Array.isArray(imageLayersValue) ? imageLayersValue : []).map((layer) => String(layer?.id || '')).filter(Boolean));
  const hasAvatar = Boolean(avatarLayerValue && typeof avatarLayerValue === 'object');
  const seen = new Set<string>();
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const rawKind = entry?.kind || entry?.type;
        const kind = rawKind === 'text' ? 'text' : rawKind === 'image' ? 'image' : rawKind === 'avatar' ? 'avatar' : null;
        const id = String(entry?.id || '').slice(0, 64);
        const key = `${kind}:${id}`;
        const exists = kind === 'text' ? textIds.has(id) : kind === 'image' ? imageIds.has(id) : kind === 'avatar' ? hasAvatar && id === 'avatar' : false;
        if (!kind || !id || !exists || seen.has(key)) return [];
        seen.add(key);
        return [{ kind, id } as WelcomeLayerRef];
      })
    : [];
}

function normalizeFontFamily(value: any) {
  const font = String(value || '').trim();
  return isSafeFontFamily(font) ? font : 'Segoe UI';
}

function isSafeFontFamily(value: string) {
  return /^[\w\s.'&-]{1,80}$/.test(value);
}

async function getEditorFonts() {
  if (googleFontsCache) return googleFontsCache;
  const googleFonts = await fetchGoogleFonts();
  googleFontsCache = Array.from(new Set(WELCOME_EDITOR_FONTS.concat(googleFonts))).filter(isSafeFontFamily);
  return googleFontsCache;
}

async function fetchGoogleFonts() {
  if (!GOOGLE_FONTS_API_KEY) return [];
  try {
    const response = await fetch(`https://www.googleapis.com/webfonts/v1/webfonts?sort=popularity&key=${encodeURIComponent(GOOGLE_FONTS_API_KEY)}`);
    if (!response.ok) return [];
    const data = await response.json() as { items?: Array<{ family?: string }> };
    return Array.isArray(data.items) ? data.items.map((item) => String(item.family || '').trim()).filter(Boolean).slice(0, 600) : [];
  } catch {
    return [];
  }
}

function normalizeFontStyle(value: any): 'normal' | 'italic' {
  return String(value || '').trim().toLowerCase() === 'italic' ? 'italic' : 'normal';
}

function normalizeCardTemplate(value: any) {
  const template = String(value || '').trim().toLowerCase();
  return ['modern', 'minimal', 'profile', 'banner'].includes(template) ? template : 'modern';
}

function normalizeColor(value: any, fallback: string) {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) return color;
  if (/^[a-z]+$/i.test(color)) return color;
  return fallback;
}

function clampNumber(value: any, min: number, max: number, fallback: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function normalizeRotation(value: any) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return ((number % 360) + 360) % 360;
}
