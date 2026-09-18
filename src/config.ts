import { config as loadEnv } from 'dotenv';
// dotenv 17+ prints an env-injection log to stderr by default; silence it.
loadEnv({ quiet: true });
import { dataFile, readJson, writeJson } from './json-store.js';
import { resolveBotName } from './branding.js';

type RuntimeTicketConfig = {
  serverId?: string;
  openTicketsCategoryId?: string;
  closedTicketsCategoryId?: string;
  transcriptChannelId?: string;
  supportRoleId?: string;
};

/**
 * Everything `data/config.json` holds: the ticket IDs set by `!ticket setup`
 * plus the command prefix set in the dashboard. Written as one object so
 * updating either half never drops the other.
 */
type RuntimeConfig = RuntimeTicketConfig & { prefix?: string };

const RUNTIME_CONFIG_FILE = dataFile('config.json');

/** Prefix used when neither the dashboard nor `PREFIX` provides one. */
export const DEFAULT_PREFIX = '!';

/** Longest accepted prefix — long enough for word prefixes like `bot.`. */
export const MAX_PREFIX_LENGTH = 8;

function loadRuntimeConfig(): RuntimeConfig {
  const parsed = readJson<RuntimeConfig>(RUNTIME_CONFIG_FILE, {});
  return {
    serverId: parsed.serverId,
    openTicketsCategoryId: parsed.openTicketsCategoryId,
    closedTicketsCategoryId: parsed.closedTicketsCategoryId,
    transcriptChannelId: parsed.transcriptChannelId,
    supportRoleId: parsed.supportRoleId,
    prefix: normalizePrefix(parsed.prefix) || undefined,
  };
}

/**
 * Trim a prefix and drop it if it is unusable. Inner whitespace is rejected
 * rather than stripped: `"! "` and `"!"` would behave the same in the command
 * router, so silently rewriting one into the other would be a lie, and a
 * prefix like `"a b"` could never match at all.
 */
function normalizePrefix(value: unknown): string {
  const text = String(value ?? '').trim();
  if (!text || text.length > MAX_PREFIX_LENGTH) return '';
  if (/[\s\p{Cc}\p{Cf}]/u.test(text)) return '';
  return text;
}

/**
 * Why a prefix was rejected, or `null` when it is usable. An empty value is
 * accepted: it means "fall back to the environment".
 */
export function prefixError(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.length > MAX_PREFIX_LENGTH) return `A prefix can be at most ${MAX_PREFIX_LENGTH} characters.`;
  if (/[\s\p{Cc}\p{Cf}]/u.test(text)) return 'A prefix cannot contain spaces.';
  return null;
}

const runtimeConfig: RuntimeConfig = loadRuntimeConfig();

function numEnv(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(value: string | undefined): boolean {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

const MB = 1024 * 1024;

/**
 * Centralized view of every environment variable the bot reads, so modules
 * import a typed value instead of scattering `process.env` lookups (and their
 * default/fallback logic) across the codebase.
 */
export const env = {
  // Optional Stoat session token — some features (backup, category moves) use
  // it to call REST endpoints the bot token cannot.
  sessionToken: String(process.env.SESSION_TOKEN || process.env.STOAT_SESSION_TOKEN || '').trim(),
  // Google API key, used for Google Fonts in the welcome editor.
  googleApiKey: String(process.env.GOOGLE_FONTS_API_KEY || process.env.GOOGLE_API_KEY || '').trim(),
  // Local dashboard HTTP port (picks the next free port if taken).
  dashboardPort: numEnv(process.env.DASHBOARD_PORT, 3030),
  // Launch puppeteer with --no-sandbox (needed in some container/root envs).
  puppeteerNoSandbox: boolEnv(process.env.PUPPETEER_NO_SANDBOX),
  // Allow notification URL checks to resolve private/loopback hosts (testing).
  notifyAllowPrivateHosts: boolEnv(process.env.NOTIFY_ALLOW_PRIVATE_HOSTS),
  // Per-editor request body caps.
  embedEditorMaxBodyBytes: numEnv(process.env.EMBED_EDITOR_MAX_BODY_MB, 2) * MB,
  notifyEditorMaxBodyBytes: numEnv(process.env.NOTIFY_EDITOR_MAX_BODY_MB, 2) * MB,
  roleEditorMaxBodyBytes:
    numEnv(process.env.ROLE_EDITOR_MAX_BODY_MB || process.env.ROLE_GRADIENT_EDITOR_MAX_BODY_MB, 1) * MB,
  welcomeEditorMaxBodyBytes: numEnv(process.env.WELCOME_EDITOR_MAX_BODY_MB, 25) * MB,
  // Debug scope spec (see logger.ts).
  debug: String(process.env.DEBUG || '').trim(),
  // Music: external binaries used to resolve and decode audio. An empty
  // ytDlpPath means the bot downloads and updates its own copy in bin/.
  ytDlpPath: String(process.env.YTDLP_PATH || '').trim(),
  ffmpegPath: getTextEnvValue(process.env.FFMPEG_PATH, 'ffmpeg'),
  // Music: leave the voice channel after this long with nothing playing or
  // nobody listening.
  musicIdleTimeoutMs: numEnv(process.env.MUSIC_IDLE_TIMEOUT_SEC, 180) * 1000,
  // Music: hard cap on queued tracks per server (playlists are truncated).
  musicMaxQueue: numEnv(process.env.MUSIC_MAX_QUEUE, 500),
  // Master key for the encrypted secret store (credentials entered in the
  // dashboard). Empty means a generated key file in the data directory.
  secretKey: String(process.env.YAOSB_SECRET_KEY || ''),
  // Booru image search: largest file the bot downloads to re-upload (Stoat's
  // attachment limit is 20 MB). Bigger posts are sent as a link instead.
  booruMaxUploadBytes: numEnv(process.env.BOORU_MAX_UPLOAD_MB, 20) * MB,
};

function getConfigValue<K extends keyof RuntimeTicketConfig>(key: K, envValue?: string) {
  return runtimeConfig[key] || envValue;
}

function getTextEnvValue(value: string | undefined, fallback: string) {
  const text = String(value || '').trim();
  return text || fallback;
}

/**
 * Bot configuration loaded from environment variables
 */
export const config = {
  // Bot authentication
  botToken: process.env.BOT_TOKEN,

  // Display name used in user-facing pages, transcripts, and defaults. A
  // getter because the dashboard can rename the bot at runtime (see
  // branding.ts); `BOT_NAME` is the fallback when nothing is set there.
  get botName() {
    return resolveBotName();
  },

  // Server configuration
  get serverId() {
    return getConfigValue('serverId', process.env.SERVER_ID);
  },
  
  // Category IDs for ticket organization
  get openTicketsCategoryId() {
    return getConfigValue('openTicketsCategoryId', process.env.OPEN_TICKETS_CATEGORY_ID);
  },
  get closedTicketsCategoryId() {
    return getConfigValue('closedTicketsCategoryId', process.env.CLOSED_TICKETS_CATEGORY_ID);
  },
  
  // Channel where transcripts will be sent
  get transcriptChannelId() {
    return getConfigValue('transcriptChannelId', process.env.TRANSCRIPT_CHANNEL_ID);
  },
  
  // Support staff role ID
  get supportRoleId() {
    return getConfigValue('supportRoleId', process.env.SUPPORT_ROLE_ID);
  },
  
  // Command prefix. A getter because the dashboard can change it at runtime;
  // `PREFIX` is the fallback when nothing is set there. Every command path
  // reads this per message, so a change applies without a restart.
  get prefix() {
    return runtimeConfig.prefix || fallbackPrefix();
  },
};

/** The prefix `PREFIX` (or the default) would give. */
export function fallbackPrefix(): string {
  return normalizePrefix(process.env.PREFIX) || DEFAULT_PREFIX;
}

/**
 * Store (or clear) the dashboard prefix. An empty value removes the override
 * so the environment takes over again. Returns the prefix now in effect.
 */
export function updateRuntimePrefix(value: unknown): string {
  runtimeConfig.prefix = normalizePrefix(value) || undefined;
  writeJson(RUNTIME_CONFIG_FILE, runtimeConfig);
  return config.prefix;
}

/** What the dashboard shows for the prefix: the value plus where it came from. */
export function prefixView() {
  return {
    prefix: config.prefix,
    fallbackPrefix: fallbackPrefix(),
    prefixCustom: !!runtimeConfig.prefix,
    maxPrefixLength: MAX_PREFIX_LENGTH,
  };
}

export function updateTicketRuntimeConfig(updates: RuntimeTicketConfig) {
  const next = {
    ...runtimeConfig,
    ...updates,
  };

  runtimeConfig.serverId = next.serverId;
  runtimeConfig.openTicketsCategoryId = next.openTicketsCategoryId;
  runtimeConfig.closedTicketsCategoryId = next.closedTicketsCategoryId;
  runtimeConfig.transcriptChannelId = next.transcriptChannelId;
  runtimeConfig.supportRoleId = next.supportRoleId;

  writeJson(RUNTIME_CONFIG_FILE, runtimeConfig);

  const { prefix: _prefix, ...tickets } = runtimeConfig;
  return tickets;
}

export function getMissingTicketConfig(requiredKeys: (keyof RuntimeTicketConfig)[]) {
  return requiredKeys.filter((key) => !config[key]);
}

export function isTicketSystemConfigured() {
  return getMissingTicketConfig([
    'openTicketsCategoryId',
    'closedTicketsCategoryId',
    'transcriptChannelId',
    'supportRoleId',
  ]).length === 0;
}

/**
 * Validate that all required config values are present
 */
export function validateConfig() {
  const required = [
    'botToken',
  ];
  
  const missing = required.filter(key => !config[key]);
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
      'Please check your .env file and ensure all variables are set.'
    );
  }
  
  return true;
}
