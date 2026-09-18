import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { File as NodeFile } from 'node:buffer';
import { renderSvgToPngAsync } from './svg-render.js';
import { config } from './config.js';
import { assertPublicHttpUrl } from './notifications/http.js';
import { getApiBaseUrl } from './stoat-api.js';
import { getMemberIds } from './member-utils.js';
import { dataFile, ensureDataDir } from './json-store.js';

type WelcomeLayout = 'classic' | 'compact' | 'banner';
type WelcomeCardTemplate = 'modern' | 'minimal' | 'profile' | 'banner';

export type WelcomeTextLayer = {
  id: string;
  enabled: boolean;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  width: number;
  fontFamily: string;
  color: string;
  fontWeight: number;
  fontStyle: 'normal' | 'italic';
  anchor: 'start' | 'middle' | 'end';
  rotation: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffsetX: number;
  shadowOffsetY: number;
  highlightEnabled: boolean;
  highlightColor: string;
  highlightOpacity: number;
  highlightPadding: number;
  outlineEnabled: boolean;
  outlineColor: string;
  outlineWidth: number;
};

export type WelcomeImageLayer = {
  id: string;
  enabled: boolean;
  imageDataUri: string;
  x: number;
  y: number;
  width: number;
  height: number;
  opacity: number;
  rotation: number;
};

export type WelcomeCustomFont = {
  id: string;
  name: string;
  fontFamily: string;
  dataUri: string;
  mimeType: string;
};

/**
 * The member's avatar as a first-class, draggable layer (April-style).
 * A single instance per design; positioned/sized by the editor and honored
 * verbatim at send time, replacing the fixed per-template avatar slot.
 */
export type WelcomeAvatarLayer = {
  id: string;
  enabled: boolean;
  x: number;
  y: number;
  size: number;
  shape: 'circle' | 'rounded' | 'square';
  ringEnabled: boolean;
  ringColor: string;
  ringWidth: number;
  rotation: number;
};

export type WelcomeLayerRef = {
  kind: 'text' | 'image' | 'avatar';
  id: string;
};

export type WelcomeConfig = {
  serverId: string;
  enabled: boolean;
  channelId?: string;
  message: string;
  imageEnabled: boolean;
  background: string;
  backgroundImageDataUri?: string;
  textColor: string;
  accentColor: string;
  layout: WelcomeLayout;
  cardTemplate: WelcomeCardTemplate;
  showAvatar: boolean;
  titleText: string;
  subtitleText: string;
  footerText: string;
  outputWidth: number;
  outputHeight: number;
  textLayers: WelcomeTextLayer[];
  imageLayers: WelcomeImageLayer[];
  avatarLayer?: WelcomeAvatarLayer;
  customFonts: WelcomeCustomFont[];
  layerOrder: WelcomeLayerRef[];
};

const AVATAR_LAYER_ID = 'avatar';

type WelcomeFile = {
  servers: WelcomeConfig[];
};

type SavedWelcomeImageEntry = {
  id?: string;
  serverId?: string;
  name?: string;
  selected?: boolean;
  config?: Partial<WelcomeConfig>;
};

type SavedWelcomeImagesFile = {
  images: SavedWelcomeImageEntry[];
};

type WelcomeContext = {
  serverId: string;
  serverName: string;
  userId: string;
  username: string;
  displayName: string;
  mention: string;
  memberCount: number | null;
};

type SelectedWelcomeImageEntry = {
  id?: string;
  name?: string;
  config: WelcomeConfig;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELCOME_FILE = dataFile('welcome.json');
const WELCOME_IMAGES_FILE = dataFile('welcome-images.json');
const WELCOME_FONT_CACHE_DIR = dataFile('welcome-fonts');
const DEFAULT_BACKGROUND = 'linear-gradient(135deg, #16181d 0%, #fd6671 100%)';
const DEFAULT_TEXT_COLOR = '#ffffff';
const DEFAULT_ACCENT_COLOR = '#fd6671';
const DEFAULT_MESSAGE = 'Welcome {mention} to **{server}**!';
const DEFAULT_TITLE_TEXT = 'Welcome, {user}!';
const DEFAULT_SUBTITLE_TEXT = 'to {server}';
const DEFAULT_FOOTER_TEXT = 'Member #{count}';
const WELCOME_SYSTEM_FONT_FAMILIES = [
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
] as const;
const WELCOME_FALLBACK_GOOGLE_FONT_FAMILIES = [
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
] as const;
const WELCOME_FONT_FAMILIES = [...WELCOME_SYSTEM_FONT_FAMILIES, ...WELCOME_FALLBACK_GOOGLE_FONT_FAMILIES] as const;
const MAX_WELCOME_CUSTOM_FONTS = 16;
const MAX_WELCOME_FONT_DATA_URI_BYTES = 6 * 1024 * 1024;
let welcomeCache: WelcomeFile | null = null;
let savedWelcomeImagesCache: SavedWelcomeImagesFile | null = null;

function readWelcomeFile(): WelcomeFile {
  if (welcomeCache) return welcomeCache;

  try {
    if (!existsSync(WELCOME_FILE)) {
      welcomeCache = { servers: [] };
      return welcomeCache;
    }

    const raw = readFileSync(WELCOME_FILE, 'utf-8').trim();
    if (!raw) {
      welcomeCache = { servers: [] };
      return welcomeCache;
    }

    const parsed = JSON.parse(raw);
    welcomeCache = {
      servers: Array.isArray(parsed?.servers) ? parsed.servers.map(normalizeWelcomeConfig).filter(Boolean) : [],
    };
    return welcomeCache;
  } catch (error) {
    console.error('Failed to read welcome config file:', error?.message || error);
    welcomeCache = { servers: [] };
    return welcomeCache;
  }
}

function writeWelcomeFile(data: WelcomeFile) {
  welcomeCache = data;
  ensureDataDir();
  writeFileSync(WELCOME_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function readSavedWelcomeImagesFile(): SavedWelcomeImagesFile {
  try {
    if (!existsSync(WELCOME_IMAGES_FILE)) {
      savedWelcomeImagesCache = { images: [] };
      return savedWelcomeImagesCache;
    }

    const raw = readFileSync(WELCOME_IMAGES_FILE, 'utf-8').trim();
    if (!raw) {
      savedWelcomeImagesCache = { images: [] };
      return savedWelcomeImagesCache;
    }

    const parsed = JSON.parse(raw);
    savedWelcomeImagesCache = {
      images: Array.isArray(parsed?.images) ? parsed.images : [],
    };
    return savedWelcomeImagesCache;
  } catch (error) {
    console.error('Failed to read selected welcome images:', error?.message || error);
    savedWelcomeImagesCache = { images: [] };
    return savedWelcomeImagesCache;
  }
}

function getSelectedWelcomeImageEntries(serverId: string): SelectedWelcomeImageEntry[] {
  if (!serverId) return [];

  return readSavedWelcomeImagesFile().images.flatMap((image) => {
    if (!image?.selected || image.serverId !== serverId || !image.config) return [];
    const normalized = normalizeWelcomeConfig({ ...image.config, serverId });
    return normalized ? [{ id: image.id, name: image.name, config: normalized }] : [];
  });
}

export function getSelectedWelcomeImageCount(serverId = config.serverId): number {
  return serverId ? getSelectedWelcomeImageEntries(serverId).length : 0;
}

function pickSelectedWelcomeImageEntry(serverId: string): SelectedWelcomeImageEntry | null {
  const selected = getSelectedWelcomeImageEntries(serverId);
  if (!selected.length) return null;
  return selected[Math.floor(Math.random() * selected.length)] || null;
}

function mergeWelcomeImageDesign(activeConfig: WelcomeConfig, imageConfig: WelcomeConfig): WelcomeConfig {
  return {
    ...activeConfig,
    background: imageConfig.background,
    backgroundImageDataUri: imageConfig.backgroundImageDataUri,
    textColor: imageConfig.textColor,
    accentColor: imageConfig.accentColor,
    layout: imageConfig.layout,
    cardTemplate: imageConfig.cardTemplate,
    showAvatar: imageConfig.showAvatar,
    titleText: imageConfig.titleText,
    subtitleText: imageConfig.subtitleText,
    footerText: imageConfig.footerText,
    outputWidth: imageConfig.outputWidth,
    outputHeight: imageConfig.outputHeight,
    textLayers: imageConfig.textLayers,
    imageLayers: imageConfig.imageLayers,
    avatarLayer: imageConfig.avatarLayer,
    customFonts: imageConfig.customFonts,
    layerOrder: imageConfig.layerOrder,
    serverId: activeConfig.serverId,
    enabled: activeConfig.enabled,
    channelId: activeConfig.channelId,
    message: activeConfig.message,
    imageEnabled: activeConfig.imageEnabled,
  };
}

export function getWelcomeConfig(serverId = config.serverId): WelcomeConfig | null {
  if (!serverId) return null;
  const entry = readWelcomeFile().servers.find((item) => item.serverId === serverId);
  return entry ? { ...entry } : null;
}

export function getEffectiveWelcomeConfig(serverId = config.serverId): WelcomeConfig | null {
  if (!serverId) return null;
  return getWelcomeConfig(serverId) || createDefaultWelcomeConfig(serverId);
}

export function updateWelcomeConfig(updates: Partial<WelcomeConfig>, serverId = config.serverId): WelcomeConfig | null {
  if (!serverId) return null;

  const data = readWelcomeFile();
  const current = getEffectiveWelcomeConfig(serverId) || createDefaultWelcomeConfig(serverId);
  const next = normalizeWelcomeConfig({
    ...current,
    ...updates,
    serverId,
  });

  if (!next) return null;

  writeWelcomeFile({
    servers: data.servers.filter((item) => item.serverId !== serverId).concat(next),
  });

  return { ...next };
}

export function clearWelcomeConfig(serverId = config.serverId) {
  if (!serverId) return;
  const data = readWelcomeFile();
  writeWelcomeFile({ servers: data.servers.filter((item) => item.serverId !== serverId) });
}

export function scheduleWelcomeForMember(client, member) {
  setTimeout(() => {
    sendWelcomeForMember(client, member).catch((error) => {
      console.error('Failed to send welcome:', error?.message || error);
    });
  }, 1500);
}

export async function sendWelcomeForMember(client, member, overrides: Partial<WelcomeConfig> = {}) {
  const ids = getMemberIds(member, config.serverId);
  if (!ids) return { ok: false, skipped: true, reason: 'missing member ids' };

  const welcomeConfig = {
    ...(getEffectiveWelcomeConfig(ids.serverId) || createDefaultWelcomeConfig(ids.serverId)),
    ...overrides,
    serverId: ids.serverId,
  };

  if (!welcomeConfig.enabled) return { ok: false, skipped: true, reason: 'disabled' };
  if (!welcomeConfig.channelId) return { ok: false, skipped: true, reason: 'missing welcome channel' };

  const channel = await resolveTextChannel(client, welcomeConfig.channelId);
  if (!channel) return { ok: false, skipped: true, reason: 'welcome channel not found' };

  const server = await resolveServer(client, ids.serverId);
  const context = await buildWelcomeContext(client, server, member, ids.serverId, ids.userId);
  const content = renderWelcomeMessage(welcomeConfig.message, context);

  if (!welcomeConfig.imageEnabled) {
    await channel.send({ content });
    return { ok: true, image: false };
  }

  try {
    const avatarUrl = await getMemberAvatarUrl(client, member, ids.userId);
    const avatarDataUri = await fetchImageDataUri(avatarUrl);
    const selectedImage = pickSelectedWelcomeImageEntry(ids.serverId);
    const renderConfig = selectedImage ? mergeWelcomeImageDesign(welcomeConfig, selectedImage.config) : welcomeConfig;
    const svg = generateWelcomeSvg(renderConfig, context, avatarDataUri || avatarUrl);
    const png = await renderSvgToPng(svg, renderConfig);
    // Node 26 types: Buffer<ArrayBufferLike> isn't assignable to BlobPart.
    // Wrap in Uint8Array to guarantee an ArrayBuffer-backed view.
    const file = new NodeFile([new Uint8Array(png)], `welcome-${ids.userId}.png`, {
      type: 'image/png',
    });

    await channel.send({
      content,
      attachments: [file],
    });

    return { ok: true, image: true, selectedImageId: selectedImage?.id, selectedImageName: selectedImage?.name };
  } catch (error) {
    console.error('Welcome image failed; sending text-only fallback:', error?.message || error);
    await channel.send({ content });
    return { ok: true, image: false, fallback: true };
  }
}

export function renderWelcomeMessage(template: string, context: WelcomeContext) {
  return String(template || DEFAULT_MESSAGE)
    .replaceAll('{user}', context.displayName || context.username || context.userId)
    .replaceAll('{username}', context.username || context.displayName || context.userId)
    .replaceAll('{display}', context.displayName || context.username || context.userId)
    .replaceAll('{mention}', context.mention)
    .replaceAll('{server}', context.serverName || 'this server')
    .replaceAll('{count}', context.memberCount == null ? '?' : String(context.memberCount));
}

function createDefaultWelcomeConfig(serverId: string): WelcomeConfig {
  return {
    serverId,
    enabled: false,
    channelId: undefined,
    message: DEFAULT_MESSAGE,
    imageEnabled: true,
    background: DEFAULT_BACKGROUND,
    backgroundImageDataUri: undefined,
    textColor: DEFAULT_TEXT_COLOR,
    accentColor: DEFAULT_ACCENT_COLOR,
    layout: 'classic',
    cardTemplate: 'modern',
    showAvatar: true,
    titleText: DEFAULT_TITLE_TEXT,
    subtitleText: DEFAULT_SUBTITLE_TEXT,
    footerText: DEFAULT_FOOTER_TEXT,
    outputWidth: 1200,
    outputHeight: 620,
    textLayers: [],
    imageLayers: [],
    customFonts: [],
    layerOrder: [],
  };
}

function normalizeWelcomeConfig(value: any): WelcomeConfig | null {
  const serverId = typeof value?.serverId === 'string' ? value.serverId : null;
  if (!serverId) return null;

  const layout = normalizeLayout(value?.layout);
  const cardTemplate = normalizeCardTemplate(value?.cardTemplate);
  const customFonts = normalizeCustomFonts(value?.customFonts);
  const textLayers = normalizeTextLayers(value?.textLayers);
  const imageLayers = normalizeImageLayers(value?.imageLayers);
  const avatarLayer = normalizeAvatarLayer(value?.avatarLayer);
  const defaultOutputHeight = layout === 'compact' ? 420 : 620;

  return {
    serverId,
    enabled: Boolean(value?.enabled),
    channelId: typeof value?.channelId === 'string' && value.channelId ? value.channelId : undefined,
    message: typeof value?.message === 'string' && value.message.trim() ? value.message : DEFAULT_MESSAGE,
    imageEnabled: value?.imageEnabled !== false,
    background: typeof value?.background === 'string' && value.background.trim() ? value.background.trim() : DEFAULT_BACKGROUND,
    backgroundImageDataUri: normalizeImageDataUri(value?.backgroundImageDataUri),
    textColor: normalizeColor(value?.textColor, DEFAULT_TEXT_COLOR),
    accentColor: normalizeColor(value?.accentColor, DEFAULT_ACCENT_COLOR),
    layout,
    cardTemplate,
    showAvatar: value?.showAvatar !== false,
    titleText: typeof value?.titleText === 'string' && value.titleText.trim() ? value.titleText.trim().slice(0, 160) : DEFAULT_TITLE_TEXT,
    subtitleText: typeof value?.subtitleText === 'string' && value.subtitleText.trim() ? value.subtitleText.trim().slice(0, 160) : DEFAULT_SUBTITLE_TEXT,
    footerText: typeof value?.footerText === 'string' && value.footerText.trim() ? value.footerText.trim().slice(0, 160) : DEFAULT_FOOTER_TEXT,
    outputWidth: Math.round(clampNumber(value?.outputWidth, 64, 8192, 1200)),
    outputHeight: Math.round(clampNumber(value?.outputHeight, 64, 8192, defaultOutputHeight)),
    textLayers,
    imageLayers,
    avatarLayer,
    customFonts,
    layerOrder: normalizeLayerOrder(value?.layerOrder, textLayers, imageLayers, avatarLayer),
  };
}

function normalizeAvatarLayer(value: any): WelcomeAvatarLayer | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const shape = String(value.shape || '').toLowerCase();
  return {
    id: AVATAR_LAYER_ID,
    enabled: value.enabled !== false,
    x: clampNumber(value.x, -1200, 1200, 100),
    y: clampNumber(value.y, -620, 1240, 100),
    size: clampNumber(value.size, 24, 1200, 200),
    shape: shape === 'rounded' || shape === 'square' ? shape : 'circle',
    ringEnabled: value.ringEnabled !== false,
    ringColor: normalizeColor(value.ringColor, DEFAULT_ACCENT_COLOR),
    ringWidth: clampNumber(value.ringWidth, 0, 60, 10),
    rotation: normalizeRotation(value.rotation),
  };
}

function normalizeLayerOrder(value: any, textLayers: WelcomeTextLayer[], imageLayers: WelcomeImageLayer[], avatarLayer?: WelcomeAvatarLayer): WelcomeLayerRef[] {
  const fallback = defaultLayerOrder(textLayers, imageLayers, avatarLayer);
  const valid = new Set(fallback.map(layerOrderKey));
  const seen = new Set<string>();
  const ordered = Array.isArray(value)
    ? value.flatMap((entry) => {
        const ref = normalizeLayerRef(entry);
        const key = ref ? layerOrderKey(ref) : '';
        if (!ref || !valid.has(key) || seen.has(key)) return [];
        seen.add(key);
        return [ref];
      })
    : [];
  return ordered.concat(fallback.filter((ref) => !seen.has(layerOrderKey(ref))));
}

function normalizeLayerRef(entry: any): WelcomeLayerRef | null {
  const rawKind = entry?.kind || entry?.type;
  const kind = rawKind === 'text' ? 'text' : rawKind === 'image' ? 'image' : rawKind === 'avatar' ? 'avatar' : null;
  const id = String(entry?.id || '').trim().slice(0, 64);
  return kind && id ? { kind, id } : null;
}

function defaultLayerOrder(textLayers: WelcomeTextLayer[], imageLayers: WelcomeImageLayer[], avatarLayer?: WelcomeAvatarLayer): WelcomeLayerRef[] {
  return [
    ...imageLayers.map((layer): WelcomeLayerRef => ({ kind: 'image', id: layer.id })),
    ...(avatarLayer ? [{ kind: 'avatar', id: avatarLayer.id } as WelcomeLayerRef] : []),
    ...textLayers.map((layer): WelcomeLayerRef => ({ kind: 'text', id: layer.id })),
  ];
}

function layerOrderKey(entry: WelcomeLayerRef) {
  return `${entry.kind}:${entry.id}`;
}

function normalizeLayout(value: any): WelcomeLayout {
  const layout = String(value || '').trim().toLowerCase();
  return layout === 'compact' || layout === 'banner' || layout === 'classic' ? layout : 'classic';
}

function normalizeCardTemplate(value: any): WelcomeCardTemplate {
  const template = String(value || '').trim().toLowerCase();
  return template === 'minimal' || template === 'profile' || template === 'banner' || template === 'modern' ? template : 'modern';
}

function normalizeColor(value: any, fallback: string) {
  const color = String(value || '').trim();
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(color)) return color;
  if (/^[a-z]+$/i.test(color)) return color;
  return fallback;
}

function normalizeImageDataUri(value: any) {
  const dataUri = String(value || '').trim();
  if (!dataUri) return undefined;
  if (!/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[a-z0-9+/=]+$/i.test(dataUri)) return undefined;
  if (dataUri.length > 7 * 1024 * 1024) return undefined;
  return dataUri;
}

function normalizeCustomFonts(value: any): WelcomeCustomFont[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();

  return value
    .slice(0, MAX_WELCOME_CUSTOM_FONTS)
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
        mimeType: getFontMimeType(dataUri),
      } satisfies WelcomeCustomFont];
    });
}

function normalizeFontDataUri(value: any) {
  const dataUri = String(value || '').trim();
  if (!dataUri) return undefined;
  if (dataUri.length > MAX_WELCOME_FONT_DATA_URI_BYTES) return undefined;
  if (!/^data:(?:font\/(?:ttf|otf|woff2?|sfnt)|application\/(?:font-woff2?|x-font-ttf|x-font-opentype|octet-stream));base64,[a-z0-9+/=]+$/i.test(dataUri)) return undefined;
  return dataUri;
}

function getFontMimeType(dataUri: string) {
  return dataUri.match(/^data:([^;,]+)/i)?.[1]?.toLowerCase() || 'font/ttf';
}

function normalizeTextLayers(value: any): WelcomeTextLayer[] {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, 12)
    .map((layer, index) => {
      const text = String(layer?.text || '').trim();
      if (!text) return null;

      const anchor = String(layer?.anchor || '').toLowerCase();

      return {
        id: String(layer?.id || `layer-${index + 1}`).slice(0, 64),
        enabled: layer?.enabled !== false,
        text: text.slice(0, 160),
        x: clampNumber(layer?.x, 0, 1200, 600),
        y: clampNumber(layer?.y, 0, 620, 310),
        fontSize: clampNumber(layer?.fontSize, 8, 160, 56),
        width: clampNumber(layer?.width, 8, 2400, estimateTextWidth(text, clampNumber(layer?.fontSize, 8, 160, 56))),
        fontFamily: normalizeFontFamily(layer?.fontFamily),
        color: normalizeColor(layer?.color, DEFAULT_TEXT_COLOR),
        fontWeight: Math.round(clampNumber(layer?.fontWeight, 100, 1000, 800)),
        fontStyle: normalizeFontStyle(layer?.fontStyle),
        anchor: anchor === 'start' || anchor === 'end' || anchor === 'middle' ? anchor : 'middle',
        rotation: normalizeRotation(layer?.rotation),
        shadowEnabled: layer?.shadowEnabled !== false,
        shadowColor: normalizeColor(layer?.shadowColor, '#000000'),
        shadowBlur: clampNumber(layer?.shadowBlur, 0, 80, 10),
        shadowOffsetX: clampNumber(layer?.shadowOffsetX, -80, 80, 0),
        shadowOffsetY: clampNumber(layer?.shadowOffsetY, -80, 80, 3),
        highlightEnabled: Boolean(layer?.highlightEnabled),
        highlightColor: normalizeColor(layer?.highlightColor, DEFAULT_ACCENT_COLOR),
        highlightOpacity: clampNumber(layer?.highlightOpacity, 0, 1, 0.35),
        highlightPadding: clampNumber(layer?.highlightPadding, 0, 80, 8),
        outlineEnabled: Boolean(layer?.outlineEnabled),
        outlineColor: normalizeColor(layer?.outlineColor, '#000000'),
        outlineWidth: clampNumber(layer?.outlineWidth, 0, 24, 2),
      } satisfies WelcomeTextLayer;
    })
    .filter((layer): layer is WelcomeTextLayer => Boolean(layer));
}

function normalizeImageLayers(value: any): WelcomeImageLayer[] {
  if (!Array.isArray(value)) return [];

  return value
    .slice(0, 16)
    .map((layer, index) => {
      const imageDataUri = normalizeImageDataUri(layer?.imageDataUri);
      if (!imageDataUri) return null;

      return {
        id: String(layer?.id || `image-${index + 1}`).slice(0, 64),
        enabled: layer?.enabled !== false,
        imageDataUri,
        x: clampNumber(layer?.x, -1200, 1200, 100),
        y: clampNumber(layer?.y, -620, 620, 100),
        width: clampNumber(layer?.width, 8, 2400, 240),
        height: clampNumber(layer?.height, 8, 1240, 240),
        opacity: clampNumber(layer?.opacity, 0, 1, 1),
        rotation: normalizeRotation(layer?.rotation),
      } satisfies WelcomeImageLayer;
    })
    .filter((layer): layer is WelcomeImageLayer => Boolean(layer));
}

function normalizeFontFamily(value: any) {
  const font = String(value || '').trim();
  return isSafeFontFamily(font) ? font : 'Segoe UI';
}

function isSafeFontFamily(value: string) {
  return /^[\w\s.'&-]{1,80}$/.test(value);
}

function normalizeFontStyle(value: any): 'normal' | 'italic' {
  return String(value || '').trim().toLowerCase() === 'italic' ? 'italic' : 'normal';
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

function generateWelcomeSvg(welcomeConfig: WelcomeConfig, context: WelcomeContext, avatarUrl: string | null) {
  const width = 1200;
  const height = welcomeConfig.layout === 'compact' ? 420 : 620;
  const outputWidth = Math.round(clampNumber(welcomeConfig.outputWidth, 64, 8192, width));
  const outputHeight = Math.round(clampNumber(welcomeConfig.outputHeight, 64, 8192, height));
  const templateLayout = getTemplateLayout(welcomeConfig.cardTemplate, width, height, welcomeConfig.showAvatar);
  const avatarSize = templateLayout.avatarSize;
  const avatarX = templateLayout.avatarX;
  const avatarY = templateLayout.avatarY;
  const textX = templateLayout.textX;
  const textAnchor = templateLayout.textAnchor;
  const titleY = templateLayout.titleY;
  const subtitleY = templateLayout.subtitleY;
  const countY = templateLayout.footerY;
  const background = renderSvgBackground(welcomeConfig, width, height);
  const safeDisplayName = truncate(context.displayName || context.username || 'New member', 34);
  const safeServerName = truncate(context.serverName || 'this server', 44);
  const initials = getInitials(safeDisplayName);
  const customLayers = welcomeConfig.textLayers.filter((layer) => layer.enabled);
  const customImageLayers = welcomeConfig.imageLayers.filter((layer) => layer.enabled);
  const avatarLayerActive = Boolean(welcomeConfig.avatarLayer?.enabled);
  const customFontCss = renderFontStyles(customLayers.map((layer) => layer.fontFamily), welcomeConfig.customFonts);
  const stackLayerSvg = getOrderedLayerEntries(welcomeConfig)
    .filter((entry) => entry.layer.enabled)
    .map((entry) =>
      entry.kind === 'image'
        ? renderImageLayer(entry.layer as WelcomeImageLayer)
        : entry.kind === 'avatar'
          ? renderAvatarLayer(entry.layer as WelcomeAvatarLayer, avatarUrl, initials, welcomeConfig)
          : renderTextLayer(entry.layer as WelcomeTextLayer, context),
    )
    .join('\n  ');

  if (customLayers.length > 0 || customImageLayers.length > 0 || avatarLayerActive) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Welcome ${escapeXml(safeDisplayName)} to ${escapeXml(safeServerName)}">
  <defs>
    <linearGradient id="defaultBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#16181d"/>
      <stop offset="100%" stop-color="#fd6671"/>
    </linearGradient>
    <filter id="layerShadow" x="-20%" y="-60%" width="140%" height="220%">
      <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="#000000" flood-opacity="0.45"/>
    </filter>
    ${customFontCss}
  </defs>
  ${background}
  ${stackLayerSvg}
</svg>`;
  }

  const avatar = avatarUrl
    ? `<image href="${escapeXml(avatarUrl)}" x="${avatarX}" y="${avatarY}" width="${avatarSize}" height="${avatarSize}" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
    : `<text x="${avatarX + avatarSize / 2}" y="${avatarY + avatarSize / 2 + 24}" text-anchor="middle" font-size="74" font-weight="800" fill="${escapeXml(welcomeConfig.textColor)}">${escapeXml(initials)}</text>`;
  const avatarBlock = welcomeConfig.showAvatar ? `
  <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2 + 10}" fill="${escapeXml(welcomeConfig.accentColor)}" filter="url(#shadow)"/>
  <circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}" fill="rgba(255,255,255,0.12)"/>
  ${avatar}` : '';
  const safeTitleText = truncate(renderWelcomeMessage(welcomeConfig.titleText, context), 40);
  const safeSubtitleText = truncate(renderWelcomeMessage(welcomeConfig.subtitleText, context), 50);
  const safeFooterText = truncate(renderWelcomeMessage(welcomeConfig.footerText, context), 50);
  const panel = welcomeConfig.cardTemplate === 'minimal'
    ? `<rect x="0" y="0" width="${width}" height="${height}" fill="rgba(0,0,0,0.18)"/>`
    : welcomeConfig.cardTemplate === 'banner'
      ? `<rect x="40" y="120" width="${width - 80}" height="${height - 240}" rx="42" fill="rgba(0,0,0,0.32)" stroke="rgba(255,255,255,0.20)"/>`
      : `<rect x="40" y="40" width="${width - 80}" height="${height - 80}" rx="42" fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.20)"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${outputWidth}" height="${outputHeight}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Welcome ${escapeXml(safeDisplayName)} to ${escapeXml(safeServerName)}">
  <defs>
    <linearGradient id="defaultBg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#16181d"/>
      <stop offset="100%" stop-color="#fd6671"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="18" stdDeviation="18" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
    <clipPath id="avatarClip"><circle cx="${avatarX + avatarSize / 2}" cy="${avatarY + avatarSize / 2}" r="${avatarSize / 2}"/></clipPath>
  </defs>
  ${background}
  ${panel}
  ${avatarBlock}
  <text x="${textX}" y="${titleY}" text-anchor="${textAnchor}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${templateLayout.titleSize}" font-weight="900" fill="${escapeXml(welcomeConfig.textColor)}">${escapeXml(safeTitleText)}</text>
  <text x="${textX}" y="${subtitleY}" text-anchor="${textAnchor}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${templateLayout.subtitleSize}" font-weight="700" fill="${escapeXml(welcomeConfig.accentColor)}">${escapeXml(safeSubtitleText)}</text>
  <text x="${textX}" y="${countY}" text-anchor="${textAnchor}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${templateLayout.footerSize}" fill="rgba(255,255,255,0.82)">${escapeXml(safeFooterText)}</text>
</svg>`;
}

function renderSvgToPng(svg: string, welcomeConfig: WelcomeConfig): Promise<Buffer> {
  const fontFiles = writeCustomFontFiles(welcomeConfig.customFonts);
  return renderSvgToPngAsync(svg, {
    fitTo: { mode: 'original' },
    font: {
      loadSystemFonts: true,
      fontFiles,
      defaultFontFamily: 'Segoe UI',
    },
  });
}

function getTemplateLayout(template: WelcomeCardTemplate, width: number, height: number, showAvatar: boolean) {
  if (template === 'banner') {
    return {
      avatarSize: showAvatar ? 170 : 0,
      avatarX: 96,
      avatarY: 225,
      textX: showAvatar ? 330 : width / 2,
      textAnchor: showAvatar ? 'start' : 'middle' as 'start' | 'middle',
      titleY: 270,
      subtitleY: 332,
      footerY: 382,
      titleSize: 54,
      subtitleSize: 32,
      footerSize: 24,
    };
  }

  if (template === 'profile') {
    return {
      avatarSize: showAvatar ? 220 : 0,
      avatarX: (width - 220) / 2,
      avatarY: 74,
      textX: width / 2,
      textAnchor: 'middle' as const,
      titleY: showAvatar ? 365 : 260,
      subtitleY: showAvatar ? 430 : 325,
      footerY: showAvatar ? 484 : 380,
      titleSize: 56,
      subtitleSize: 32,
      footerSize: 24,
    };
  }

  if (template === 'minimal') {
    return {
      avatarSize: showAvatar ? 140 : 0,
      avatarX: (width - 140) / 2,
      avatarY: 115,
      textX: width / 2,
      textAnchor: 'middle' as const,
      titleY: showAvatar ? 315 : 265,
      subtitleY: showAvatar ? 374 : 326,
      footerY: showAvatar ? 424 : 378,
      titleSize: 50,
      subtitleSize: 30,
      footerSize: 22,
    };
  }

  return {
    avatarSize: showAvatar ? 190 : 0,
    avatarX: (width - 190) / 2,
    avatarY: 92,
    textX: width / 2,
    textAnchor: 'middle' as const,
    titleY: showAvatar ? 350 : 260,
    subtitleY: showAvatar ? 424 : 334,
    footerY: showAvatar ? 482 : 392,
    titleSize: 58,
    subtitleSize: 34,
    footerSize: 25,
  };
}

function renderTextLayer(layer: WelcomeTextLayer, context: WelcomeContext) {
  const text = truncate(renderWelcomeMessage(layer.text, context), 96);
  const baselineY = layer.y + layer.fontSize * 0.35;
  const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${layer.x} ${layer.y})"` : '';
  const textWidth = Math.max(24, Number(layer.width) || estimateTextWidth(text, layer.fontSize));
  const textHeight = Math.max(8, layer.fontSize * 1.22);
  const padding = layer.highlightEnabled ? clampNumber(layer.highlightPadding, 0, 80, 8) : 0;
  const rectX = textRectX(layer, textWidth) - padding;
  const rectY = layer.y - textHeight / 2 - padding;
  const filterId = `textShadow-${String(layer.id || '').replace(/[^a-z0-9_-]/gi, '-')}`;
  const baseAttrs = `x="${layer.x}" y="${baselineY}" text-anchor="${layer.anchor}" font-family="${escapeXml(layer.fontFamily)}, Segoe UI, Arial, sans-serif" font-size="${layer.fontSize}" font-weight="${layer.fontWeight}" font-style="${layer.fontStyle}"`;
  const shadow = layer.shadowEnabled
    ? `<defs><filter id="${filterId}" x="-50%" y="-100%" width="200%" height="300%"><feDropShadow dx="${clampNumber(layer.shadowOffsetX, -80, 80, 0)}" dy="${clampNumber(layer.shadowOffsetY, -80, 80, 3)}" stdDeviation="${clampNumber(layer.shadowBlur, 0, 80, 10)}" flood-color="${escapeXml(layer.shadowColor)}" flood-opacity="0.85"/></filter></defs>`
    : '';
  const highlight = layer.highlightEnabled
    ? `<rect x="${rectX}" y="${rectY}" width="${textWidth + padding * 2}" height="${textHeight + padding * 2}" rx="${Math.min(18, padding)}" fill="${escapeXml(layer.highlightColor)}" opacity="${clampNumber(layer.highlightOpacity, 0, 1, 0.35)}"/>`
    : '';
  const outlineAttrs = layer.outlineEnabled && layer.outlineWidth > 0
    ? ` stroke="${escapeXml(layer.outlineColor)}" stroke-width="${clampNumber(layer.outlineWidth, 0, 24, 2)}" paint-order="stroke fill" stroke-linejoin="round"`
    : '';
  const filterAttr = layer.shadowEnabled ? ` filter="url(#${filterId})"` : '';
  return `<g${transform}>${shadow}${highlight}<text ${baseAttrs} fill="${escapeXml(layer.color)}"${outlineAttrs}${filterAttr}>${escapeXml(text)}</text></g>`;
}

function textRectX(layer: WelcomeTextLayer, width: number) {
  if (layer.anchor === 'start') return layer.x;
  if (layer.anchor === 'end') return layer.x - width;
  return layer.x - width / 2;
}

function renderImageLayer(layer: WelcomeImageLayer) {
  const centerX = layer.x + layer.width / 2;
  const centerY = layer.y + layer.height / 2;
  const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${centerX} ${centerY})"` : '';
  return `<image href="${escapeXml(layer.imageDataUri)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" opacity="${layer.opacity}" preserveAspectRatio="none"${transform}/>`;
}

function renderFontStyles(fontFamilies: string[], customFonts: WelcomeCustomFont[] = []) {
  const customFontFamilies = new Set(customFonts.map((font) => font.fontFamily));
  const fonts = Array.from(new Set(fontFamilies.map((font) => String(font || '').trim()).filter((font) => font && isSafeFontFamily(font) && !customFontFamilies.has(font) && !(WELCOME_SYSTEM_FONT_FAMILIES as readonly string[]).includes(font))));
  const googleImports = fonts.map((font) => `@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(font).replace(/%20/g, '+')}:ital,wght@0,100;0,200;0,300;0,400;0,500;0,600;0,700;0,800;0,900;1,100;1,200;1,300;1,400;1,500;1,600;1,700;1,800;1,900&display=swap');`);
  const customFaces = customFonts
    .filter((font) => fontFamilies.includes(font.fontFamily))
    .map((font) => `@font-face { font-family: '${font.fontFamily.replace(/'/g, "\\'")}'; src: url('${font.dataUri}') format('${fontFormat(font.mimeType)}'); font-weight: 100 1000; font-style: normal; font-display: swap; }`);
  const rules = googleImports.concat(customFaces);
  if (!rules.length) return '';
  return `<style><![CDATA[
      ${rules.join('\n      ')}
    ]]></style>`;
}

function fontFormat(mimeType: string) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('woff2')) return 'woff2';
  if (mime.includes('woff')) return 'woff';
  if (mime.includes('opentype') || mime.includes('otf')) return 'opentype';
  return 'truetype';
}

function writeCustomFontFiles(customFonts: WelcomeCustomFont[] = []) {
  const fontFiles: string[] = [];
  if (!customFonts.length) return fontFiles;

  try {
    mkdirSync(WELCOME_FONT_CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('Failed to create welcome font cache:', error?.message || error);
    return fontFiles;
  }

  customFonts.forEach((font) => {
    const bytes = decodeDataUri(font.dataUri);
    if (!bytes) return;
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24);
    const filePath = join(WELCOME_FONT_CACHE_DIR, `${hash}.${fontExtension(font.mimeType)}`);
    try {
      if (!existsSync(filePath)) writeFileSync(filePath, bytes);
      fontFiles.push(filePath);
    } catch (error) {
      console.error(`Failed to cache welcome font ${font.fontFamily}:`, error?.message || error);
    }
  });

  return fontFiles;
}

function decodeDataUri(dataUri: string): Buffer | null {
  const match = String(dataUri || '').match(/^data:[^;,]+;base64,([a-z0-9+/=]+)$/i);
  if (!match) return null;
  const bytes = Buffer.from(match[1], 'base64');
  return bytes.length ? bytes : null;
}

function fontExtension(mimeType: string) {
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('woff2')) return 'woff2';
  if (mime.includes('woff')) return 'woff';
  if (mime.includes('opentype') || mime.includes('otf')) return 'otf';
  return 'ttf';
}

type OrderedLayerEntry =
  | { kind: 'text'; layer: WelcomeTextLayer }
  | { kind: 'image'; layer: WelcomeImageLayer }
  | { kind: 'avatar'; layer: WelcomeAvatarLayer };

function getOrderedLayerEntries(welcomeConfig: WelcomeConfig): OrderedLayerEntry[] {
  const entries: OrderedLayerEntry[] = [];
  normalizeLayerOrder(welcomeConfig.layerOrder, welcomeConfig.textLayers, welcomeConfig.imageLayers, welcomeConfig.avatarLayer).forEach((ref) => {
    if (ref.kind === 'image') {
      const layer = welcomeConfig.imageLayers.find((item) => item.id === ref.id);
      if (layer) entries.push({ kind: 'image', layer });
      return;
    }
    if (ref.kind === 'avatar') {
      if (welcomeConfig.avatarLayer && welcomeConfig.avatarLayer.id === ref.id) entries.push({ kind: 'avatar', layer: welcomeConfig.avatarLayer });
      return;
    }
    const layer = welcomeConfig.textLayers.find((item) => item.id === ref.id);
    if (layer) entries.push({ kind: 'text', layer });
  });
  return entries;
}

function renderAvatarLayer(layer: WelcomeAvatarLayer, avatarUrl: string | null, initials: string, welcomeConfig: WelcomeConfig) {
  const size = Math.max(24, layer.size);
  const cx = layer.x + size / 2;
  const cy = layer.y + size / 2;
  const r = size / 2;
  const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${cx} ${cy})"` : '';
  const ringWidth = layer.ringEnabled ? clampNumber(layer.ringWidth, 0, 60, 10) : 0;
  const clipId = 'avatarLayerClip';

  let clipShape: string;
  let ringShape = '';
  if (layer.shape === 'circle') {
    clipShape = `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
    if (ringWidth) ringShape = `<circle cx="${cx}" cy="${cy}" r="${r + ringWidth / 2}" fill="none" stroke="${escapeXml(layer.ringColor)}" stroke-width="${ringWidth}"/>`;
  } else {
    const rx = layer.shape === 'rounded' ? Math.min(60, size * 0.18) : 0;
    clipShape = `<rect x="${layer.x}" y="${layer.y}" width="${size}" height="${size}" rx="${rx}"/>`;
    if (ringWidth) ringShape = `<rect x="${layer.x - ringWidth / 2}" y="${layer.y - ringWidth / 2}" width="${size + ringWidth}" height="${size + ringWidth}" rx="${rx ? rx + ringWidth / 2 : 0}" fill="none" stroke="${escapeXml(layer.ringColor)}" stroke-width="${ringWidth}"/>`;
  }

  const inner = avatarUrl
    ? `<image href="${escapeXml(avatarUrl)}" x="${layer.x}" y="${layer.y}" width="${size}" height="${size}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${clipId})"/>`
    : `<g clip-path="url(#${clipId})"><rect x="${layer.x}" y="${layer.y}" width="${size}" height="${size}" fill="${escapeXml(welcomeConfig.accentColor)}"/><text x="${cx}" y="${cy + size * 0.16}" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${Math.round(size * 0.4)}" font-weight="800" fill="${escapeXml(welcomeConfig.textColor)}">${escapeXml(initials)}</text></g>`;

  return `<g${transform}><defs><clipPath id="${clipId}">${clipShape}</clipPath></defs>${inner}${ringShape}</g>`;
}

function renderSvgBackground(welcomeConfig: WelcomeConfig, width: number, height: number) {
  if (welcomeConfig.backgroundImageDataUri) {
    return `<rect width="${width}" height="${height}" fill="url(#defaultBg)"/><image href="${escapeXml(welcomeConfig.backgroundImageDataUri)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`;
  }

  const value = String(welcomeConfig.background || '').trim();
  if (/^https?:\/\//i.test(value)) {
    return `<rect width="${width}" height="${height}" fill="url(#defaultBg)"/><image href="${escapeXml(value)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="0.88"/>`;
  }

  const gradient = parseLinearGradient(value);
  if (gradient) {
    const end = gradientEndPoint(gradient.angle);
    return `<defs><linearGradient id="customBg" x1="${end.x1}" y1="${end.y1}" x2="${end.x2}" y2="${end.y2}"><stop offset="0%" stop-color="${escapeXml(gradient.from)}"/><stop offset="100%" stop-color="${escapeXml(gradient.to)}"/></linearGradient></defs><rect width="${width}" height="${height}" fill="url(#customBg)"/>`;
  }

  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) || /^[a-z]+$/i.test(value)) {
    return `<rect width="${width}" height="${height}" fill="${escapeXml(value)}"/>`;
  }

  return `<rect width="${width}" height="${height}" fill="url(#defaultBg)"/>`;
}

function parseLinearGradient(value: string): { angle: number; from: string; to: string } | null {
  const match = String(value || '').trim().match(/^linear-gradient\(\s*([\d.]+)deg\s*,\s*(#[0-9a-f]{3,8})[^,]*,\s*(#[0-9a-f]{3,8})/i);
  return match ? { angle: Number(match[1]) || 0, from: normalizeColor(match[2], '#16181d'), to: normalizeColor(match[3], '#fd6671') } : null;
}

function gradientEndPoint(angle: number) {
  const radians = ((angle - 90) * Math.PI) / 180;
  const x = Math.cos(radians);
  const y = Math.sin(radians);
  return {
    x1: ((1 - x) / 2).toFixed(3),
    y1: ((1 - y) / 2).toFixed(3),
    x2: ((1 + x) / 2).toFixed(3),
    y2: ((1 + y) / 2).toFixed(3),
  };
}

async function buildWelcomeContext(client, server, member, serverId: string, userId: string): Promise<WelcomeContext> {
  const user = await resolveUser(client, userId, member);
  const username = String(user?.username || member?.username || member?.user?.username || userId).trim();
  const displayName = String(
    member?.nickname ||
      user?.displayName ||
      user?.display_name ||
      member?.user?.displayName ||
      member?.user?.display_name ||
      username ||
      userId
  ).trim();

  return {
    serverId,
    serverName: String(server?.name || server?.title || server?.serverName || 'this server').trim(),
    userId,
    username,
    displayName,
    mention: `<@${userId}>`,
    memberCount: getMemberCount(server),
  };
}

async function getMemberAvatarUrl(client, member, userId: string): Promise<string | null> {
  const candidates = [member, member?.user, await resolveUser(client, userId, member)];

  for (const entity of candidates) {
    const url = getEntityAvatarUrl(client, entity);
    if (url) return url;
  }

  return `${getApiBaseUrl(client)}/users/${encodeURIComponent(userId)}/default_avatar`;
}

async function fetchImageDataUri(url: string | null): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    // Avatar URLs can come straight from a member's profile, so this is an
    // attacker-influenced server-side fetch: run it through the same SSRF guard
    // the notification providers use, and never follow a redirect unchecked.
    let currentUrl = url;
    let response: Response | null = null;
    for (let hop = 0; hop <= 3; hop++) {
      await assertPublicHttpUrl(currentUrl);
      response = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'YetAnotherOverengineeredStoatBot welcome image generator',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
      const location = response.status >= 300 && response.status < 400 ? response.headers.get('location') : null;
      if (!location) break;
      if (hop === 3) return null;
      currentUrl = new URL(location, currentUrl).toString();
    }
    if (!response || !response.ok) return null;

    const contentType = response.headers.get('content-type') || 'image/png';
    if (!contentType.toLowerCase().startsWith('image/')) return null;

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > 4 * 1024 * 1024) return null;

    return `data:${contentType};base64,${bytes.toString('base64')}`;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function getEntityAvatarUrl(client, entity) {
  if (!entity) return null;

  if (typeof entity.avatarURL === 'string' && entity.avatarURL) return entity.avatarURL;
  if (typeof entity.avatarURL === 'function') {
    try {
      const url = entity.avatarURL(true) || entity.avatarURL();
      if (url) return url;
    } catch {
      // Continue with direct file resolution.
    }
  }

  if (typeof entity.avatar === 'string' && /^https?:\/\//i.test(entity.avatar)) return entity.avatar;
  if (entity.avatar && typeof entity.avatar.createFileURL === 'function') {
    try {
      const url = entity.avatar.createFileURL(true) || entity.avatar.createFileURL();
      if (url) return url;
    } catch {
      // Continue with id extraction.
    }
  }

  const avatar = entity.avatar || entity.profile?.avatar || null;
  const avatarId = extractFileId(avatar);
  return avatarId ? `${getCdnBaseUrl(client)}/avatars/${encodeURIComponent(avatarId)}` : null;
}

async function resolveTextChannel(client, channelId: string) {
  const channel = client.channels?.cache?.get?.(channelId) || (await client.channels?.fetch?.(channelId).catch(() => null));
  if (!channel || (typeof channel.isText === 'function' && !channel.isText())) return null;
  return typeof channel.send === 'function' ? channel : null;
}

async function resolveServer(client, serverId: string) {
  return client.servers?.cache?.get?.(serverId) || (await client.servers?.fetch?.(serverId).catch(() => null));
}

async function resolveUser(client, userId: string, member?) {
  return (
    member?.user ||
    client.users?.cache?.get?.(userId) ||
    (await client.users?.fetch?.(userId).catch(() => null)) ||
    null
  );
}

function getMemberCount(server): number | null {
  const count = server?.memberCount || server?.member_count || server?.members?.cache?.size;
  return typeof count === 'number' && Number.isFinite(count) ? count : null;
}

function extractFileId(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return value._id || value.id || value.fileId || value.file_id || value.tag || null;
}

function getCdnBaseUrl(client): string {
  return String(
    client?.options?.rest?.instanceCDNURL ||
      client?.configuration?.features?.autumn?.url ||
      'https://autumn.stoat.chat'
  ).replace(/\/+$/, '');
}

function getInitials(value: string) {
  const parts = String(value || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : parts[0]?.slice(0, 2) || '?').toUpperCase();
}

function truncate(value: string, maxLength: number) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function estimateTextWidth(text: string, fontSize: number) {
  return Math.max(24, String(text || '').length * (fontSize || 24) * 0.56);
}

function escapeXml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
