/**
 * Dashboard branding — the display name and logo the bot shows everywhere.
 *
 * The name used to come only from `BOT_NAME` in the environment, which meant
 * renaming the bot required editing `.env` and restarting. Both the name and
 * the logo are editable from the dashboard (Setup → Branding) and stored in
 * `data/branding.json`, so a change applies to the running process at once:
 * every reader goes through `config.botName` / the `/brand/logo` route rather
 * than holding its own copy.
 *
 * Precedence for the name is custom (dashboard) → `BOT_NAME` → the project
 * default, so clearing the field in the dashboard falls back to the
 * environment instead of leaving the bot nameless. The logo falls back to the
 * bundled `assets/logo.svg`.
 *
 * The stored logo is a base64 payload plus its media type rather than a file
 * in the data directory: it keeps the whole branding state in one atomically
 * written JSON file, so a half-applied change is not possible.
 */
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { dataFile, readJson, writeJson } from './json-store.js';
import { warn } from './logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Name used when neither the dashboard nor `BOT_NAME` provides one. */
export const DEFAULT_BOT_NAME = 'YetAnotherOverengineeredStoatBot';

/** The logo shipped with the project, used until one is uploaded. */
const DEFAULT_LOGO_FILE = join(__dirname, '..', 'assets', 'logo.svg');
const DEFAULT_LOGO_MIME = 'image/svg+xml';

/** Longest accepted name. The sidebar ellipsizes beyond ~24 characters. */
export const MAX_NAME_LENGTH = 80;

/** Largest accepted logo, before base64 encoding. */
export const MAX_LOGO_BYTES = 512 * 1024;

/** Image types accepted for a custom logo, by media type. */
export const LOGO_MIME_TYPES = ['image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;

type StoredLogo = { mime: string; data: string; updatedAt: number };
type BrandingFile = { name?: string; logo?: StoredLogo | null };

/** What the dashboard API hands the browser: metadata only, never the bytes. */
export type BrandingView = {
  /** The name in effect right now. */
  name: string;
  /** What clearing the custom name would fall back to. */
  fallbackName: string;
  /** Whether the name was set in the dashboard (as opposed to env/default). */
  nameCustom: boolean;
  /** Whether a logo was uploaded (as opposed to the bundled default). */
  logoCustom: boolean;
  logoMime: string;
  /** Changes whenever the logo does, for cache-busting `/brand/logo?v=`. */
  logoStamp: string;
  maxLogoBytes: number;
  maxNameLength: number;
};

const brandingFile = () => dataFile('branding.json');

// This process is the only writer, so a cache filled on read cannot go stale
// behind our back — and `config.botName` is read on every page render, every
// editor bundle check and several command paths.
let cache: BrandingFile | null = null;

function read(): BrandingFile {
  if (!cache) cache = readJson<BrandingFile>(brandingFile(), {});
  return cache;
}

function write(next: BrandingFile): void {
  cache = next;
  writeJson(brandingFile(), next);
}

/** Collapse whitespace, drop control characters, and cap the length. */
function normalizeName(value: unknown): string {
  return String(value ?? '')
    // Control and format characters would break the sidebar / page title.
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

/**
 * The name `BOT_NAME` (or the default) would give. Read lazily rather than at
 * module load: `dotenv` runs in `config.ts`'s body, which is evaluated after
 * this module's imports.
 */
export function fallbackBotName(): string {
  return normalizeName(process.env.BOT_NAME) || DEFAULT_BOT_NAME;
}

/** The display name in effect: dashboard value, else `BOT_NAME`, else default. */
export function resolveBotName(): string {
  return normalizeName(read().name) || fallbackBotName();
}

/**
 * Store (or clear) the dashboard name. An empty value removes the override so
 * the environment takes over again. Returns the name now in effect.
 */
export function setBrandName(value: unknown): string {
  const name = normalizeName(value);
  const current = read();
  write({ ...current, name: name || undefined });
  return resolveBotName();
}

// Default-logo bytes, keyed on mtime so editing `assets/logo.svg` during
// development shows up without a restart.
let defaultLogoCache: { mtimeMs: number; body: Buffer } | null = null;

function readDefaultLogo(): { mime: string; body: Buffer; stamp: string } {
  try {
    const mtimeMs = statSync(DEFAULT_LOGO_FILE).mtimeMs;
    if (defaultLogoCache?.mtimeMs !== mtimeMs) {
      defaultLogoCache = { mtimeMs, body: readFileSync(DEFAULT_LOGO_FILE) };
    }
    return { mime: DEFAULT_LOGO_MIME, body: defaultLogoCache.body, stamp: `d${Math.round(mtimeMs)}` };
  } catch (error) {
    warn(`branding: default logo missing at ${DEFAULT_LOGO_FILE}: ${(error as Error)?.message || error}`);
    // A 1x1 transparent GIF, so the dashboard renders without a broken image.
    return {
      mime: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'),
      stamp: 'd0',
    };
  }
}

/** The logo to serve: the uploaded one when present, else the bundled default. */
export function readLogo(): { mime: string; body: Buffer; stamp: string } {
  const stored = read().logo;
  if (stored?.data && stored.mime) {
    try {
      return { mime: stored.mime, body: Buffer.from(stored.data, 'base64'), stamp: `c${stored.updatedAt}` };
    } catch (error) {
      warn(`branding: stored logo could not be decoded: ${(error as Error)?.message || error}`);
    }
  }
  return readDefaultLogo();
}

/**
 * Accept a logo as a `data:` URI, the shape a browser `FileReader` produces.
 * The media type has to be one we are willing to serve back, and the decoded
 * size is checked rather than the encoded one so the limit means what it says.
 *
 * Returns a message describing why the image was rejected, or `null` once it
 * is stored.
 */
export function setLogoFromDataUri(dataUri: unknown): string | null {
  const raw = String(dataUri ?? '').trim();
  const match = raw.match(/^data:([a-z0-9.+/-]+);base64,([a-z0-9+/=\s]+)$/i);
  if (!match) return 'Upload a PNG, JPEG, GIF, WebP or SVG image.';

  const mime = match[1].toLowerCase();
  if (!(LOGO_MIME_TYPES as readonly string[]).includes(mime)) {
    return 'Unsupported image type. Use PNG, JPEG, GIF, WebP or SVG.';
  }

  const data = match[2].replace(/\s+/g, '');
  const body = Buffer.from(data, 'base64');
  if (body.length === 0) return 'That image file is empty.';
  if (body.length > MAX_LOGO_BYTES) {
    return `That image is too large. The limit is ${Math.round(MAX_LOGO_BYTES / 1024)}KB.`;
  }

  // Re-encode from the decoded bytes so what is stored is canonical base64,
  // not whatever padding/whitespace arrived.
  write({ ...read(), logo: { mime, data: body.toString('base64'), updatedAt: Date.now() } });
  return null;
}

/** Drop the uploaded logo, falling back to the bundled default. */
export function clearLogo(): BrandingView {
  write({ ...read(), logo: null });
  return brandingView();
}

export function brandingView(): BrandingView {
  const stored = read();
  const logo = readLogo();
  return {
    name: resolveBotName(),
    fallbackName: fallbackBotName(),
    nameCustom: !!normalizeName(stored.name),
    logoCustom: !!stored.logo?.data,
    logoMime: logo.mime,
    logoStamp: logo.stamp,
    maxLogoBytes: MAX_LOGO_BYTES,
    maxNameLength: MAX_NAME_LENGTH,
  };
}

/** Test seam: drop the in-memory copy so the next read hits the file again. */
export function resetBrandingForTests(): void {
  cache = null;
  defaultLogoCache = null;
}
