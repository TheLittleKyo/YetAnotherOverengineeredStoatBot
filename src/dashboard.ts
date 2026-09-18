/**
 * YetAnotherOverengineeredStoatBot dashboard — one local HTTP server that hosts every editor
 * (welcome / embed / roles / notify) in a single page. Each editor is
 * mounted under a path namespace and loaded in an iframe; requests to
 * `/<ns>/...` are delegated to that editor's exported request handler
 * with the `/<ns>` prefix stripped, so all existing editor logic and
 * APIs keep working unchanged.
 *
 * Replaces the four standalone editor servers (welcome-editor.ts etc.)
 * and their per-command `editor` subcommands.
 *
 * Binds to 127.0.0.1:3030 by default (override with DASHBOARD_PORT).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { readFileSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { config, env } from './config.js';
import { readLogo } from './branding.js';
import { isEditorRequestAllowed, isSameOriginRequest } from './editor-guard.js';
import { runWithoutBotPermission } from './bot-permissions.js';
import { NO_FRAMING_HEADERS, escapeHtml, readJsonBody as readEditorJsonBody, sendHtml, sendJson, sendText } from './editor-server.js';
import { startNotificationScheduler } from './notifications/index.js';
import {
  createShareLink,
  getValidShareLink,
  claimSession,
  revokeShareLink,
  listActiveShareLinks,
  countActiveShareLinks,
  hashSecret,
  type ShareLink,
  type ShareScope,
} from './share-links.js';
import { ensureTunnel, stopTunnel } from './share-tunnel.js';
import { debug, error as logError } from './logger.js';
import { handleWelcomeEditorRequest } from './welcome-editor.js';
import { handleEmbedEditorRequest } from './embed-editor.js';
import { handleRoleEditorRequest } from './role-editor.js';
import { handleNotifyEditorRequest } from './notify-editor.js';
import { handleFreeStuffEditorRequest } from './freestuff-editor.js';
import { handleSetupEditorRequest } from './setup-editor.js';
import { handleOpsEditorRequest } from './ops-editor.js';
import { handleSyncEditorRequest } from './sync-editor.js';
import { handleDebugEditorRequest } from './debug-editor.js';
import { handleOverviewEditorRequest } from './overview-editor.js';
import { handleAutoEditorRequest } from './auto-editor.js';
import { handleAntiraidEditorRequest } from './antiraid-editor.js';
import { handleReminderEditorRequest } from './reminder-editor.js';
import { handleLevelingEditorRequest } from './leveling-editor.js';
import { handleCaptchaEditorRequest } from './captcha-editor.js';
import { handleBooruEditorRequest } from './booru-editor.js';
import { handleModerationEditorRequest } from './moderation-editor.js';
import { handleAutomodEditorRequest } from './automod-editor.js';
import { handleEngagementEditorRequest } from './engagement-editor.js';
import { handleCommunityEditorRequest } from './community-editor.js';
import { handleEconomyEditorRequest } from './economy-editor.js';
import { handleAnalyticsEditorRequest } from './analytics-editor.js';
import { handleModulesEditorRequest } from './modules-editor.js';
import { isModuleEnabled } from './modules.js';
import { recordAudit } from './audit.js';

/** `guest` is set for share-link visitors, so editors can hide owner-only data. */
type EditorContext = { client: any; serverId: string; guest?: boolean };
type EditorHandler = (request: IncomingMessage, response: ServerResponse, ctx: EditorContext) => Promise<void>;
type DashboardInstance = { server: Server; port: number; serverId: string; client: any };

// Sidebar sections, in display order. Every editor belongs to exactly one.
const NAV_GROUPS = ['Workspace', 'Community', 'Automation', 'Safety', 'System'] as const;
type NavGroup = (typeof NAV_GROUPS)[number];

type EditorDef = {
  ns: string;
  label: string;
  group: NavGroup;
  title: string;
  blurb: string;
  icon: string; // inner SVG markup for a monochrome line icon (no emoji)
  css: string;
  js: string;
  handler: EditorHandler;
};

// Feather-style line icons as inner SVG markup, rendered monochrome via
// currentColor. Kept as raw strings because the shell is plain HTML, not React.
const ICON = {
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  welcome: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/>',
  embed: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  roles: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  notify: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  setup: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  ops: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  debug: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  sync: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  auto: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><circle cx="8.5" cy="10" r="1"/><circle cx="12" cy="10" r="1"/><circle cx="15.5" cy="10" r="1"/>',
  antiraid: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/>',
  reminder: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="m22 6-3-3"/>',
  leveling: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  captcha: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/><path d="M12 15v3"/>',
  freestuff: '<polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/>',
  booru: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  moderation: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="15.5" x2="12.01" y2="15.5"/>',
  automod: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  engagement: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  community: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  economy: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
  analytics: '<path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/>',
  modules: '<rect x="1" y="5" width="22" height="14" rx="7" ry="7"/><circle cx="16" cy="12" r="3"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
  // Shell chrome.
  menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  reload: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  selector: '<polyline points="7 15 12 20 17 15"/><polyline points="7 9 12 4 17 9"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  themeAuto: '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>',
  themeLight: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  themeDark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
};

function iconSvg(inner: string) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_BYTES = 1_000_000;
const SHARED_TOKENS_FILE = join(__dirname, 'editors', 'shared', 'tokens.css');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = env.dashboardPort;

// Lifetime of the admin link minted by `!dashboard cloudflare`. "No limits" in
// the sense that matters — full read-edit and the power to mint more links —
// with the only cap being single-use (one browser session per link). The clock
// is the system-max TTL (7 days), long enough to be practically unlimited for a
// working session while still guaranteeing the public tunnel dies on its own.
const CLOUDFLARE_ADMIN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let instance: DashboardInstance | null = null;
let sharedTokensCache: { mtimeMs: number; css: string } | null = null;
// Periodically drops the Cloudflare tunnel once every share link has expired
// (expiry fires no event, so a revoke alone cannot catch this case).
let tunnelSweep: ReturnType<typeof setInterval> | null = null;

const EDITORS: EditorDef[] = [
  {
    ns: 'home',
    label: 'Overview',
    group: 'Workspace',
    title: 'Dashboard overview',
    blurb: 'Live stats, activity graphs, and leaderboards.',
    icon: ICON.home,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleOverviewEditorRequest(req, res, ctx),
  },
  {
    ns: 'welcome',
    label: 'Welcome images',
    group: 'Community',
    title: 'Welcome image editor',
    blurb: 'Design the image new members see when they join.',
    icon: ICON.welcome,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleWelcomeEditorRequest(req, res, ctx),
  },
  {
    ns: 'embed',
    label: 'Embeds',
    group: 'Community',
    title: 'Embed builder',
    blurb: 'Compose rich embeds and send them to any channel.',
    icon: ICON.embed,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleEmbedEditorRequest(req, res, ctx),
  },
  {
    ns: 'roles',
    label: 'Roles',
    group: 'Community',
    title: 'Role editor',
    blurb: 'Create, recolor, and set permissions on server roles.',
    icon: ICON.roles,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleRoleEditorRequest(req, res, ctx),
  },
  {
    ns: 'notify',
    label: 'Notifications',
    group: 'Automation',
    title: 'Notification subscriptions',
    blurb: 'Watch streams and feeds, post updates to a channel.',
    icon: ICON.notify,
    css: 'style.css',
    js: 'app.js',
    handler: (req, res, ctx) => handleNotifyEditorRequest(req, res, ctx),
  },
  {
    ns: 'freestuff',
    label: 'Free Stuff',
    group: 'Automation',
    title: 'Free games & deals feed',
    blurb: 'Auto-post free game giveaways and big discounts to a channel.',
    icon: ICON.freestuff,
    css: 'style.css',
    js: 'app.js',
    handler: (req, res, ctx) => handleFreeStuffEditorRequest(req, res, ctx),
  },
  {
    ns: 'booru',
    label: 'Booru',
    group: 'Automation',
    title: 'Booru image search',
    blurb: 'Site accounts, adult-content setting, and tag blacklist.',
    icon: ICON.booru,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleBooruEditorRequest(req, res, ctx),
  },
  {
    ns: 'setup',
    label: 'Server setup',
    group: 'Workspace',
    title: 'Server setup',
    blurb: 'Tickets, join roles, stats channels, and logs.',
    icon: ICON.setup,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleSetupEditorRequest(req, res, ctx),
  },
  {
    ns: 'sync',
    label: 'Channel sync',
    group: 'Automation',
    title: 'Channel sync',
    blurb: 'Mirror messages between channels, even across servers.',
    icon: ICON.sync,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleSyncEditorRequest(req, res, ctx),
  },
  {
    ns: 'ops',
    label: 'Moderation & ops',
    group: 'Safety',
    title: 'Moderation & operations',
    blurb: 'Backups, purge and permission command builders.',
    icon: ICON.ops,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleOpsEditorRequest(req, res, ctx),
  },
  {
    ns: 'modules',
    label: 'Modules',
    group: 'System',
    title: 'Modules',
    blurb: 'Switch whole features on or off for the entire bot.',
    icon: ICON.modules,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleModulesEditorRequest(req, res, ctx),
  },
  {
    ns: 'debug',
    label: 'Debug tools',
    group: 'System',
    title: 'Debug tools',
    blurb: 'Sync diagnostics: drift scan, trace, ledger, self-test.',
    icon: ICON.debug,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleDebugEditorRequest(req, res, ctx),
  },
  {
    ns: 'auto',
    label: 'Auto responses',
    group: 'Automation',
    title: 'Auto-responder & auto-react',
    blurb: 'Keyword auto-replies and automatic emoji reactions.',
    icon: ICON.auto,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleAutoEditorRequest(req, res, ctx),
  },
  {
    ns: 'antiraid',
    label: 'Antiraid',
    group: 'Safety',
    title: 'Raid protection',
    blurb: 'Join-flood detection, account-age gate, lockdown.',
    icon: ICON.antiraid,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleAntiraidEditorRequest(req, res, ctx),
  },
  {
    ns: 'reminder',
    label: 'Reminders',
    group: 'Automation',
    title: 'Scheduled messages',
    blurb: 'Recurring and one-off messages on a schedule.',
    icon: ICON.reminder,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleReminderEditorRequest(req, res, ctx),
  },
  {
    ns: 'leveling',
    label: 'Leveling',
    group: 'Community',
    title: 'Leveling & leaderboard',
    blurb: 'XP, ranks, leaderboard, and level-based auto-add roles.',
    icon: ICON.leveling,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleLevelingEditorRequest(req, res, ctx),
  },
  {
    ns: 'captcha',
    label: 'Captcha',
    group: 'Safety',
    title: 'Anti-bot captcha',
    blurb: 'DM image verification before granting a role.',
    icon: ICON.captcha,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleCaptchaEditorRequest(req, res, ctx),
  },
  {
    ns: 'moderation',
    label: 'Moderation',
    group: 'Safety',
    title: 'Moderation cases',
    blurb: 'Case history, escalation ladder, mute and DM settings.',
    icon: ICON.moderation,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleModerationEditorRequest(req, res, ctx),
  },
  {
    ns: 'automod',
    label: 'Automod',
    group: 'Safety',
    title: 'Automod filters',
    blurb: 'Banned words, invites, links, spam, caps and mass mentions.',
    icon: ICON.automod,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleAutomodEditorRequest(req, res, ctx),
  },
  {
    ns: 'engagement',
    label: 'Polls & giveaways',
    group: 'Community',
    title: 'Polls & giveaways',
    blurb: 'Run votes and draws, and review the results.',
    icon: ICON.engagement,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleEngagementEditorRequest(req, res, ctx),
  },
  {
    ns: 'community',
    label: 'Community',
    group: 'Community',
    title: 'Tags, birthdays & voice rooms',
    blurb: 'Custom commands, birthday announcements, temporary voice rooms.',
    icon: ICON.community,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleCommunityEditorRequest(req, res, ctx),
  },
  {
    ns: 'economy',
    label: 'Economy',
    group: 'Community',
    title: 'Economy & shop',
    blurb: 'Currency, rewards, the shop, and member balances.',
    icon: ICON.economy,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleEconomyEditorRequest(req, res, ctx),
  },
  {
    ns: 'analytics',
    label: 'Analytics',
    group: 'Workspace',
    title: 'Server analytics',
    blurb: 'Joins and leaves, busiest hours, top channels, voice time.',
    icon: ICON.analytics,
    css: 'editor.css',
    js: 'editor-app.js',
    handler: (req, res, ctx) => handleAnalyticsEditorRequest(req, res, ctx),
  },
];

const EDITORS_BY_NS = new Map(EDITORS.map((editor) => [editor.ns, editor]));

/**
 * Namespaces whose handlers (or the feature modules behind them) write their
 * own audit entries, with detail the dashboard cannot see — a case number, a
 * rule name, the giveaway that ended. Everything else gets the generic
 * "something was saved here" line below, so no tab is silently unaudited.
 */
const SELF_AUDITING_NS = new Set(['moderation', 'automod', 'economy', 'community', 'analytics', 'engagement', 'ops', 'modules']);

/**
 * Record that a dashboard tab changed something. Only non-GET requests count:
 * a GET is someone looking, and the log is about changes.
 */
function auditEditorWrite(request: IncomingMessage, ns: string, rest: string, serverId: string, guest?: boolean) {
  const method = String(request.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || SELF_AUDITING_NS.has(ns)) return;
  const action = rest.replace(/^\/api\/?/, '').replace(/\/+$/, '') || 'save';
  recordAudit({
    serverId,
    actorId: '',
    actorName: guest ? 'Share-link guest' : 'Dashboard',
    source: 'dashboard',
    area: ns,
    action,
    detail: `${method} ${rest}`,
  });
}

export async function startDashboard(client: any, serverId = config.serverId) {
  // No single-server requirement anymore: the dashboard can drive any server
  // the bot is in, chosen per request. `serverId` is only the default landing
  // selection; an empty default resolves to the first server the bot is in.
  if (instance) {
    instance.client = client;
    if (serverId) instance.serverId = serverId;
    return { url: buildUrl(instance.port), port: instance.port, reused: true };
  }

  const server = createServer((request, response) => {
    // Read the current client/default off `instance` so a reused start (new
    // client after a reconnect) is picked up on the next request.
    const active = instance || { client, serverId };
    // `!dashboard` starts this server inside its own bot-permission context,
    // which every later request callback would otherwise inherit. Requests are
    // the operator's, not that command's, so the context is cleared here.
    runWithoutBotPermission(() =>
      handleRequest(request, response, { client: active.client, serverId: active.serverId }).catch((error) => {
        console.error('Dashboard request failed:', error?.message || error);
        sendJson(response, 500, { ok: false, error: 'Internal dashboard error.' });
      }),
    );
  });

  const port = await listenWithFallback(server, DEFAULT_HOST, DEFAULT_PORT);
  instance = { server, port, serverId: serverId || '', client };

  // The notify editor used to start the scheduler; keep polling alive now
  // that the dashboard owns the socket — unless the module is switched off.
  if (isModuleEnabled('notify')) startNotificationScheduler(client);

  // Sweep every 2 minutes: if no share links are live, stop the tunnel so a
  // cloudflared process never lingers past the last link's expiry.
  if (!tunnelSweep) {
    tunnelSweep = setInterval(() => {
      try {
        if (countActiveShareLinks() === 0) stopTunnel();
      } catch (err) {
        debug('share', () => `tunnel sweep error: ${(err as Error)?.message || err}`);
      }
    }, 120_000);
    if (typeof tunnelSweep.unref === 'function') tunnelSweep.unref();
  }

  return { url: buildUrl(port), port, reused: false };
}

/**
 * Start the dashboard (if needed), bring up the Cloudflare tunnel, and mint one
 * admin share link for it. The returned `url` is a public `trycloudflare.com`
 * link carrying a full read-edit token that may itself mint further links
 * (`canShare`) and is single-use (bound to the first browser that opens it).
 *
 * This is the engine behind `!dashboard cloudflare`. The link is a bearer
 * secret to full control of the server's dashboard, so the command DMs it to
 * the admin rather than posting it in a channel.
 */
export async function startCloudflareDashboard(client: any, serverId: string) {
  if (!serverId) throw new Error('No server selected for the Cloudflare dashboard.');

  const dash = await startDashboard(client, serverId);
  const port = instance ? instance.port : DEFAULT_PORT;
  const tunnel = await ensureTunnel(port);

  const link = createShareLink({
    serverId,
    scope: 'read-edit',
    ttlMs: CLOUDFLARE_ADMIN_TTL_MS,
    singleUse: true,
    canShare: true,
    createdBy: 'admin',
  });
  const url = `${tunnel.replace(/\/+$/, '')}/?token=${encodeURIComponent(link.token)}`;
  return { url, token: link.token, expiresAt: link.expiresAt, localUrl: dash.url, reused: dash.reused };
}

export function stopDashboard() {
  // Kill the Cloudflare tunnel child first so it never outlives the dashboard.
  if (tunnelSweep) {
    clearInterval(tunnelSweep);
    tunnelSweep = null;
  }
  try {
    stopTunnel();
  } catch (error) {
    console.warn('Failed to stop share tunnel:', (error as Error)?.message || error);
  }
  if (!instance) return;
  try {
    instance.server.close();
  } catch (error) {
    console.warn('Failed to close dashboard server:', error?.message || error);
  }
  instance = null;
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1', 'localhost']);
const SHARE_TOKEN_COOKIE = 'yaosb-share';
const SHARE_SESSION_COOKIE = 'yaosb-share-sess';
// Editor namespaces that a share-link guest may never reach because they act
// across every server the bot is in (not just the link's bound server).
const GUEST_BLOCKED_NS = new Set(['ops', 'sync', 'debug', 'modules']);

function requestHostname(request: IncomingMessage): string {
  const value = String(request.headers.host || '').trim();
  const v6 = value.match(/^\[([^\]]+)\]/);
  if (v6) return v6[1].toLowerCase();
  return value.split(':')[0].toLowerCase();
}

async function handleRequest(request: IncomingMessage, response: ServerResponse, ctx: EditorContext) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const cookies = parseCookies(request.headers.cookie);
  const isLoopback = LOOPBACK_HOSTNAMES.has(requestHostname(request));
  const queryToken = url.searchParams.get('token') || '';

  // Guest (share-link) path: any request that did NOT arrive on loopback — i.e.
  // it came in through the Cloudflare tunnel — or a loopback request that
  // explicitly carries `?token=` (the owner testing a link locally). A stale
  // share cookie on a plain loopback visit is deliberately ignored so it can
  // never lock the owner out of their own machine.
  if (!isLoopback || queryToken) {
    await handleGuestRequest(request, response, ctx, url, cookies, queryToken);
    return;
  }

  // ---- Owner path (loopback, no token): the original security model, unchanged. ----
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }

  // Which server the operator is currently controlling. Chosen per request from
  // the `yaosb-server` cookie (set by the shell's switcher) or a `?server=`
  // override, validated against the servers the bot is actually in, and falling
  // back to the configured default / first server.
  const activeServerId = resolveActiveServerId(ctx.client, url, cookies, ctx.serverId);
  const editorCtx: EditorContext = { client: ctx.client, serverId: activeServerId };

  // Share-link mint / list / revoke. Owner-only: it lives on the loopback path,
  // so a guest reaching `/api/share` over the tunnel never gets here.
  if (pathname === '/api/share') {
    await handleShareApi(request, response, activeServerId);
    return;
  }

  if (request.method === 'GET' && pathname === '/') {
    sendHtml(response, renderShellPage());
    return;
  }

  if (request.method === 'GET' && pathname === '/shared.css') {
    sendCss(response, getSharedTokens());
    return;
  }

  if (request.method === 'GET' && pathname === '/dashboard.css') {
    sendCss(response, DASHBOARD_CSS);
    return;
  }

  // The logo, for the sidebar and every page's favicon.
  if (request.method === 'GET' && pathname === '/brand/logo') {
    sendLogo(response);
    return;
  }

  // The servers the bot is in, which one is currently active, and the bot's
  // gateway state. Powers the sidebar server switcher and the top-bar status,
  // which re-polls this every 30 seconds.
  if (request.method === 'GET' && pathname === '/api/servers') {
    sendJson(response, 200, { ok: true, servers: listBotServers(ctx.client), activeId: activeServerId, bot: botStatus(ctx.client) });
    return;
  }

  // Editor namespace: `/welcome`, `/welcome/`, `/welcome/api/...`, assets.
  const match = pathname.match(/^\/([a-z]+)(\/.*)?$/);
  const editor = match ? EDITORS_BY_NS.get(match[1]) : undefined;
  if (editor) {
    const rest = match![2] || '/';
    if (request.method === 'GET' && (rest === '/' || rest === '')) {
      // Editors have no standalone existence: the frame is only served when the
      // shell loads it as an iframe. A direct top-level visit to `/<ns>/` (typed
      // URL, bookmark, opened in a new tab) redirects to the dashboard so every
      // editor is reached through the one control panel. `Sec-Fetch-Dest` is set
      // by the browser and cannot be forged by page JS — same trust the request
      // guard already relies on. Absent header (old browsers) falls through to
      // serving the frame so the dashboard keeps working.
      const dest = request.headers['sec-fetch-dest'];
      if (typeof dest === 'string' && dest !== 'iframe' && dest !== 'frame') {
        response.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      sendHtml(response, renderEditorFrame(editor));
      return;
    }
    // Strip the `/<ns>` prefix and delegate to the editor's own handler, scoped
    // to the currently selected server.
    auditEditorWrite(request, editor.ns, rest, editorCtx.serverId);
    request.url = rest + (url.search || '');
    await editor.handler(request, response, editorCtx);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

// ---- Share-link (guest) request handling. ----

async function handleGuestRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: EditorContext,
  url: URL,
  cookies: Record<string, string>,
  queryToken: string,
) {
  const token = queryToken || cookies[SHARE_TOKEN_COOKIE] || '';
  const link = getValidShareLink(token);
  if (!link) {
    sendShareError(response, 'This share link is invalid or has expired.');
    return;
  }

  // Bind the link to the first guest's browser session (single-use), or verify
  // an existing bind. A fresh browser gets a new session secret; if the link is
  // already claimed by someone else, this comes back 'mismatch'.
  let sessionSecret = cookies[SHARE_SESSION_COOKIE] || '';
  let setSessionCookie = false;
  if (!sessionSecret) {
    sessionSecret = randomBytes(32).toString('base64url');
    setSessionCookie = true;
  }
  const claim = claimSession(link.token, hashSecret(sessionSecret));
  if (claim === 'invalid') {
    sendShareError(response, 'This share link is invalid or has expired.');
    return;
  }
  if (claim === 'mismatch') {
    sendShareError(response, 'This link has already been claimed by someone else.');
    return;
  }

  // Persist token (and, on first hit, the session secret) so query-less
  // sub-requests — iframe docs, editor APIs, assets — stay authenticated.
  // `Secure` is only sent over HTTPS — set it when the request actually arrived
  // over TLS (cloudflared forwards `X-Forwarded-Proto: https`) or on any
  // non-loopback host. Omitting it for a plain-http loopback visit lets the
  // owner test a single-use link locally without the browser dropping the
  // (Secure-only) cookie and breaking the bind.
  const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const isSecure = forwardedProto === 'https' || !LOOPBACK_HOSTNAMES.has(requestHostname(request));
  const maxAge = Math.max(1, Math.floor((link.expiresAt - Date.now()) / 1000));
  const cookieAttrs = `Path=/; HttpOnly;${isSecure ? ' Secure;' : ''} SameSite=Lax; Max-Age=${maxAge}`;
  const setCookies = [`${SHARE_TOKEN_COOKIE}=${encodeURIComponent(link.token)}; ${cookieAttrs}`];
  if (setSessionCookie) {
    setCookies.push(`${SHARE_SESSION_COOKIE}=${encodeURIComponent(sessionSecret)}; ${cookieAttrs}`);
  }
  response.setHeader('Set-Cookie', setCookies);

  const readOnly = link.scope === 'read';
  const pathname = url.pathname;
  const method = String(request.method || 'GET').toUpperCase();
  const mutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

  // CSRF: mutating guest requests must be same-origin with the tunnel host.
  const sameOrigin = isSameOriginRequest(request);
  if (!sameOrigin.ok) {
    debug('share', () => `guest CSRF blocked: ${sameOrigin.reason}`);
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }

  // Read-only links: block every mutating method server-side. Hiding buttons in
  // the UI is not enough — a guest can hand-craft the request.
  if (readOnly && mutating) {
    sendJson(response, 403, { ok: false, error: 'This share link is read-only.' });
    return;
  }

  // Share-link API. An ordinary guest can never mint / list / revoke links; an
  // admin link (`canShare`, minted by `!dashboard cloudflare`) can — that is how
  // its holder "creates more links from that link". Links it creates are plain
  // (never `canShare`), so the power to hand out access does not propagate. The
  // panel is scoped to the link's own server, exactly like a read-edit guest.
  if (pathname === '/api/share') {
    if (!link.canShare) {
      sendJson(response, 403, { ok: false, error: 'Forbidden.' });
      return;
    }
    await handleShareApi(request, response, link.serverId);
    return;
  }

  // The link is bound to one server; ignore any `?server=` / switcher cookie.
  const editorCtx: EditorContext = { client: ctx.client, serverId: link.serverId, guest: true };

  if (request.method === 'GET' && pathname === '/') {
    sendHtml(response, renderShellPage({ guest: true, readOnly, canShare: link.canShare }));
    return;
  }
  if (request.method === 'GET' && pathname === '/shared.css') {
    sendCss(response, getSharedTokens());
    return;
  }
  if (request.method === 'GET' && pathname === '/dashboard.css') {
    sendCss(response, DASHBOARD_CSS);
    return;
  }
  if (request.method === 'GET' && pathname === '/brand/logo') {
    sendLogo(response);
    return;
  }
  // Only ever expose the bound server; never leak the full server list.
  if (request.method === 'GET' && pathname === '/api/servers') {
    const bound = listBotServers(ctx.client).filter((s) => s.id === link.serverId);
    const servers = bound.length ? bound : [{ id: link.serverId, name: link.serverId }];
    sendJson(response, 200, { ok: true, servers, activeId: link.serverId, bot: botStatus(ctx.client) });
    return;
  }

  const match = pathname.match(/^\/([a-z]+)(\/.*)?$/);
  const editor = match ? EDITORS_BY_NS.get(match[1]) : undefined;
  if (editor) {
    // Some editors are cross-server by design (sync: links and copies across
    // every server the bot is in, and its `/api/config` lists them all; ops:
    // backups; debug: sync diagnostics over the same links and a global ledger).
    // Those escape the "current server only" scope, so they are never reachable
    // through a share link — even by a crafted URL. They are also hidden from
    // the guest nav, so a normal guest never sees them.
    if (GUEST_BLOCKED_NS.has(editor.ns)) {
      sendJson(response, 403, { ok: false, error: 'This section is not available for shared access.' });
      return;
    }
    const rest = match![2] || '/';
    if (request.method === 'GET' && (rest === '/' || rest === '')) {
      const dest = request.headers['sec-fetch-dest'];
      if (typeof dest === 'string' && dest !== 'iframe' && dest !== 'frame') {
        response.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        response.end();
        return;
      }
      sendHtml(response, renderEditorFrame(editor));
      return;
    }
    // Delegate to the editor. Its own handler re-runs `isEditorRequestAllowed`,
    // which requires a loopback Host and loopback Origin — so we normalize those
    // for the internal call. The guest is already authenticated (token) and
    // CSRF-checked (isSameOriginRequest) above, so this is a trusted proxy hop.
    auditEditorWrite(request, editor.ns, rest, editorCtx.serverId, true);
    request.url = rest + (url.search || '');
    request.headers.host = 'localhost';
    delete request.headers.origin;
    await editor.handler(request, response, editorCtx);
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

// Owner-only share-link API. Reached only from the loopback path.
async function handleShareApi(request: IncomingMessage, response: ServerResponse, activeServerId: string) {
  const method = String(request.method || 'GET').toUpperCase();

  if (method === 'GET') {
    const links = listActiveShareLinks(activeServerId).map(shareLinkPublicView);
    sendJson(response, 200, { ok: true, links });
    return;
  }

  if (method === 'POST') {
    if (!activeServerId) {
      sendJson(response, 400, { ok: false, error: 'No server selected.' });
      return;
    }
    const body = await readJsonBody(request);
    const scope: ShareScope = body?.scope === 'read' ? 'read' : 'read-edit';
    const singleUse = body?.singleUse !== false;
    const ttlMs = clampTtl(Number(body?.ttlMs));

    let tunnel: string;
    try {
      tunnel = await ensureTunnel(instance ? instance.port : DEFAULT_PORT);
    } catch (err) {
      logError('[share] tunnel start failed: ' + ((err as Error)?.message || err));
      sendJson(response, 502, { ok: false, error: 'Could not start the Cloudflare tunnel. Check the bot logs.' });
      return;
    }

    const link = createShareLink({ serverId: activeServerId, scope, ttlMs, singleUse, createdBy: 'operator' });
    const shareUrl = `${tunnel.replace(/\/+$/, '')}/?token=${encodeURIComponent(link.token)}`;
    sendJson(response, 200, {
      ok: true,
      url: shareUrl,
      token: link.token,
      scope: link.scope,
      singleUse: link.singleUse,
      expiresAt: link.expiresAt,
    });
    return;
  }

  if (method === 'DELETE') {
    // The token to revoke rides in the JSON body, NOT the query string: on the
    // guest path `?token=` is the caller's own auth credential, so a query
    // param here would be read as "who am I", not "what to revoke" (and could
    // even claim a single-use link as a side effect). Body first, query only as
    // a legacy fallback.
    const body = await readJsonBody(request);
    const url = new URL(request.url || '/', 'http://localhost');
    const token = String(body?.token || url.searchParams.get('token') || '');
    const ok = revokeShareLink(token);
    // No links left → tear the tunnel down now instead of waiting for the sweep.
    if (ok && countActiveShareLinks() === 0) stopTunnel();
    sendJson(response, ok ? 200 : 404, { ok });
    return;
  }

  sendJson(response, 405, { ok: false, error: 'Method not allowed.' });
}

function clampTtl(ms: number): number {
  const HOUR = 60 * 60 * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return HOUR;
  const MAX = 7 * 24 * HOUR;
  return Math.min(Math.max(ms, 60 * 1000), MAX);
}

// Owner-facing view of a link: token is included (the owner needs it to re-copy
// the URL), but the session bind hash is not.
function shareLinkPublicView(link: ShareLink) {
  return {
    token: link.token,
    scope: link.scope,
    singleUse: link.singleUse,
    claimed: link.boundSession != null,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt,
  };
}

// The dashboard's own API never surfaces a body-parse failure to the caller:
// an oversized, malformed or truncated body is simply an empty object, and the
// route's own validation then rejects it. Shared parser, forgiving wrapper.
function readJsonBody(request: IncomingMessage): Promise<any> {
  return readEditorJsonBody(request, { maxBytes: MAX_BODY_BYTES }).catch(() => ({}));
}

// Friendly page shown to a guest whose link is expired / claimed / invalid,
// instead of a raw JSON 403.
function sendShareError(response: ServerResponse, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(config.botName)} · Share link</title>${faviconTag()}<style>
    body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#070b10;color:#ecf1f5;font:15px/1.55 'Segoe UI',system-ui,sans-serif}
    .card{max-width:400px;padding:32px 28px;text-align:center;background:#0e141b;border:1px solid #232c36}
    .mark{width:44px;height:44px;border-radius:8px;display:block;margin:0 auto 18px;object-fit:contain}
    h1{font-size:18px;font-weight:700;margin:0 0 8px}
    p{color:#a3b0bc;margin:0}
  </style></head><body><div class="card"><img class="mark" src="${logoUrl()}" alt=""><h1>${escapeHtml(message)}</h1><p>Ask the dashboard owner for a fresh link.</p></div></body></html>`;
  response.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...NO_FRAMING_HEADERS });
  response.end(html);
}

// Parse a `Cookie` header into a plain map. Loopback-only server, so this is a
// convenience for reading the operator's server selection, not a security path.
function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

// Gateway state for the top-bar status indicator. `ws` is protected in the
// stoatbot.js typings but public at runtime; any read failure reports offline.
function botStatus(client: any): { online: boolean; reconnecting: boolean; ping: number | null } {
  try {
    const ws = client?.ws;
    const online = Boolean(ws ? ws.connected : client?.isReady?.());
    const ping = Number(ws?.ping);
    return {
      online,
      reconnecting: Boolean(ws?.reconnecting),
      ping: online && Number.isFinite(ping) && ping > 0 ? Math.round(ping) : null,
    };
  } catch {
    return { online: false, reconnecting: false, ping: null };
  }
}

// Every server the bot is a member of, as `{ id, name }`, sorted by name.
function listBotServers(client: any): { id: string; name: string }[] {
  const cache = client?.servers?.cache;
  if (!cache || typeof cache.forEach !== 'function') return [];
  const servers: { id: string; name: string }[] = [];
  cache.forEach((server: any, key: any) => {
    const id = String(server?.id || server?._id || key || '').trim();
    if (!id) return;
    const name = String(server?.name || server?.title || '').trim() || id;
    servers.push({ id, name });
  });
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return servers;
}

// Resolve which server this request targets. Priority: explicit `?server=`
// override, then the `yaosb-server` cookie, then the configured default,
// then the first server the bot is in. Candidates that name a server the bot
// is not in are rejected (falls through), unless the cache is not populated
// yet, in which case we trust the candidate as a best effort.
function resolveActiveServerId(
  client: any,
  url: URL,
  cookies: Record<string, string>,
  defaultServerId: string,
): string {
  const servers = listBotServers(client);
  const known = new Set(servers.map((s) => s.id));
  const candidates = [url.searchParams.get('server'), cookies['yaosb-server'], defaultServerId];
  for (const candidate of candidates) {
    const id = String(candidate || '').trim();
    if (id && (known.size === 0 || known.has(id))) return id;
  }
  return servers[0]?.id || String(defaultServerId || '').trim();
}

// Re-read when the file changes, like the editor bundles, so a stylesheet edit
// shows up on reload without restarting the bot.
function getSharedTokens(): string {
  const mtimeMs = statSync(SHARED_TOKENS_FILE).mtimeMs;
  if (sharedTokensCache?.mtimeMs !== mtimeMs) {
    sharedTokensCache = { mtimeMs, css: readFileSync(SHARED_TOKENS_FILE, 'utf-8') };
  }
  return sharedTokensCache.css;
}

// The dashboard logo, as a URL rather than an inlined data URI: every page
// (shell, editor frames, the share-error page) then points at one route, so an
// uploaded logo applies everywhere on reload. The `?v=` stamp changes with the
// logo so a browser that cached it does not keep the old one.
function logoUrl() {
  return `/brand/logo?v=${encodeURIComponent(readLogo().stamp)}`;
}

/** Favicon shared by every page: whatever `/brand/logo` currently serves. */
function faviconTag() {
  const logo = readLogo();
  return `<link rel="icon" type="${escapeHtml(logo.mime)}" href="${logoUrl()}">`;
}

/**
 * Serve the branding logo. `nosniff` plus a no-permissions CSP matter because
 * an uploaded SVG is a document when opened directly: this keeps any script
 * inside one from running on the dashboard's own origin.
 */
function sendLogo(response: ServerResponse) {
  const logo = readLogo();
  response.writeHead(200, {
    'Content-Type': logo.mime,
    'Content-Length': logo.body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  });
  response.end(logo.body);
}

// The per-editor iframe document: shared tokens + the editor's own assets,
// plus a tiny theme-sync bridge driven by the shell (postMessage + storage).
function renderEditorFrame(editor: EditorDef) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.botName)} · ${escapeHtml(editor.label)}</title>
  ${faviconTag()}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="/shared.css">
  <link rel="stylesheet" href="/${editor.ns}/${editor.css}">
  <script>
    (function () {
      function apply(t) {
        var r = document.documentElement;
        if (t === 'light' || t === 'dark') r.setAttribute('data-theme', t);
        else r.removeAttribute('data-theme');
      }
      try { apply(localStorage.getItem('yaosb-theme')); } catch (e) {}
      addEventListener('message', function (e) {
        if (e.origin !== location.origin || !e.data || e.data.type !== 'yaosb-theme') return;
        try { localStorage.setItem('yaosb-theme', e.data.theme || ''); } catch (_) {}
        apply(e.data.theme);
      });
      addEventListener('storage', function (e) { if (e.key === 'yaosb-theme') apply(e.newValue); });
    })();
  </script>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/${editor.ns}/${editor.js}"></script>
</body>
</html>`;
}

function renderShellPage(opts: { guest?: boolean; readOnly?: boolean; canShare?: boolean } = {}) {
  const guest = !!opts.guest;
  const readOnly = !!opts.readOnly;
  // An admin (`canShare`) guest gets the Share panel too, so it can mint further
  // links; every ordinary guest does not.
  const canShare = !guest || !!opts.canShare;
  const botName = config.botName;

  // Guests never see cross-server editors (they are also 403'd server-side).
  const visibleEditors = guest ? EDITORS.filter((e) => !GUEST_BLOCKED_NS.has(e.ns)) : EDITORS;

  const nav = NAV_GROUPS.map((group) => {
    const items = visibleEditors.filter((editor) => editor.group === group);
    if (items.length === 0) return '';
    const buttons = items.map(
      (editor) => `
          <button class="nav-item" data-ns="${editor.ns}" type="button" title="${escapeHtml(editor.blurb)}">
            <span class="nav-ico" aria-hidden="true">${iconSvg(editor.icon)}</span>
            <span class="nav-label">${escapeHtml(editor.label)}</span>
            <span class="nav-unsaved" title="Unsaved changes" aria-hidden="true"></span>
          </button>`,
    ).join('');
    return `
        <div class="nav-group">
          <span class="nav-heading">${escapeHtml(group)}</span>
          ${buttons}
        </div>`;
  }).join('');

  // Guests get a fixed server card (the link is bound to one server), no Share
  // row, and no share panel. The owner gets a switcher and all three.
  const serverFace = `
          <span class="server-tile" id="server-tile" aria-hidden="true">&middot;</span>
          <span class="server-meta">
            <span class="server-name" id="server-name">Loading&hellip;</span>
            <span class="server-sub" id="server-sub">${guest ? 'Shared with you' : 'Active server'}</span>
          </span>`;
  const serverSwitchHtml = guest
    ? `<div class="server-switch is-static">${serverFace}</div>`
    : `<button class="server-switch" id="server-switch" type="button" disabled
          role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="server-menu-list" aria-label="Server to control">${serverFace}
          <span class="server-chevron" aria-hidden="true">${iconSvg(ICON.selector)}</span>
        </button>
        <div class="server-menu" id="server-menu" hidden>
          <div class="select-search" id="server-search-wrap" hidden>
            ${iconSvg(ICON.search)}
            <input class="select-search-input" id="server-search" type="text" placeholder="Search servers…" autocomplete="off" spellcheck="false"
              role="combobox" aria-expanded="true" aria-controls="server-menu-list" aria-autocomplete="list" aria-label="Search servers">
          </div>
          <div class="select-list" id="server-menu-list" role="listbox" aria-label="Servers"></div>
        </div>`;

  const shareRowHtml = canShare
    ? `<button class="nav-item" id="share-open" type="button">
          <span class="nav-ico" aria-hidden="true">${iconSvg(ICON.share)}</span>
          <span class="nav-label">Share access</span>
        </button>`
    : '';

  const operatorHtml = `
        <div class="operator">
          <span class="operator-avatar" aria-hidden="true">${iconSvg(ICON.user)}</span>
          <span class="operator-meta">
            <span class="operator-name">${guest ? 'Guest' : 'Operator'}</span>
            <span class="operator-sub">${guest ? (readOnly ? 'Read-only link' : opts.canShare ? 'Admin link' : 'Shared link') : 'Local session'}</span>
          </span>
        </div>`;

  const sharePanelHtml = canShare ? SHARE_PANEL_HTML : '';
  const shareScriptHtml = canShare ? `<script>${SHARE_PANEL_JS}</script>` : '';
  const editorsJson = JSON.stringify(
    visibleEditors.map((e) => ({ ns: e.ns, label: e.label, title: e.title, group: e.group, blurb: e.blurb })),
  ).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(botName)} Dashboard</title>
  <meta name="description" content="Local control panel for ${escapeHtml(botName)}: server setup, community tools, automation, and moderation.">
  ${faviconTag()}
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="/shared.css">
  <link rel="stylesheet" href="/dashboard.css">
  <script>
    try {
      var storedTheme = localStorage.getItem('yaosb-theme');
      if (storedTheme === 'light' || storedTheme === 'dark') document.documentElement.setAttribute('data-theme', storedTheme);
    } catch (e) {}
  </script>
</head>
<body>
  <div class="shell" id="shell">
    <aside class="sidebar" id="sidebar" aria-label="Dashboard navigation">
      <div class="brand">
        <span class="brand-mark" aria-hidden="true"><img class="brand-logo" id="brand-logo" src="${logoUrl()}" alt="">
          <span class="brand-dot" id="brand-dot"></span></span>
        <span class="brand-meta">
          <span class="brand-name" id="brand-name" title="${escapeHtml(botName)}">${escapeHtml(botName)}</span>
          <span class="brand-tag">Control panel</span>
        </span>
        <button class="icon-btn sidebar-close" id="nav-close" type="button" aria-label="Close navigation">${iconSvg(ICON.close)}</button>
      </div>
      <div class="server-wrap">${serverSwitchHtml}</div>
      <nav class="nav" aria-label="Editors">${nav}
      </nav>
      <div class="sidebar-foot">
        ${shareRowHtml}
        ${operatorHtml}
      </div>
    </aside>
    <div class="nav-scrim" id="nav-scrim" hidden></div>
    <div class="main">
      <header class="topbar" id="topbar">
        <button class="icon-btn nav-open" id="nav-open" type="button" aria-label="Open navigation">${iconSvg(ICON.menu)}</button>
        <div class="crumbs">
          <span class="crumb-group" id="crumb-group"></span>
          <span class="crumb-sep" aria-hidden="true">/</span>
          <span class="crumb-page" id="crumb-page"></span>
        </div>
        <div class="jump" id="jump">
          <span class="jump-ico" aria-hidden="true">${iconSvg(ICON.search)}</span>
          <input class="jump-input" id="jump-input" type="text" placeholder="Jump to…" autocomplete="off" spellcheck="false"
            role="combobox" aria-expanded="false" aria-controls="jump-list" aria-label="Jump to a section">
          <kbd class="jump-kbd" id="jump-kbd" aria-hidden="true">Ctrl K</kbd>
          <div class="jump-list" id="jump-list" role="listbox" hidden></div>
        </div>
        <button class="icon-btn theme-btn" id="theme-btn" type="button" data-theme-val="auto">
          <span class="theme-ico theme-ico-auto" aria-hidden="true">${iconSvg(ICON.themeAuto)}</span>
          <span class="theme-ico theme-ico-light" aria-hidden="true">${iconSvg(ICON.themeLight)}</span>
          <span class="theme-ico theme-ico-dark" aria-hidden="true">${iconSvg(ICON.themeDark)}</span>
        </button>
        <button class="icon-btn" id="frame-reload" type="button" title="Reload this section" aria-label="Reload this section">${iconSvg(ICON.reload)}</button>
        <span class="topbar-rule" aria-hidden="true"></span>
        <div class="status" id="status" data-state="pending">
          <span class="status-dot" aria-hidden="true"></span>
          <span class="status-text" id="status-text" role="status">Connecting&hellip;</span>
          <span class="status-ping" id="status-ping"></span>
        </div>
      </header>
      <main class="stage">
        <div class="frames" id="frames"></div>
      </main>
    </div>
  </div>
  ${sharePanelHtml}
  ${shareScriptHtml}
  <script>
    (function () {
      var EDITORS = ${editorsJson};
      var BOT_NAME = ${JSON.stringify(botName).replace(/</g, '\\u003c')};
      var frames = document.getElementById('frames');
      var navItems = Array.prototype.slice.call(document.querySelectorAll('.nav-item[data-ns]'));
      var sidebar = document.getElementById('sidebar');
      var scrim = document.getElementById('nav-scrim');
      var crumbGroup = document.getElementById('crumb-group');
      var crumbPage = document.getElementById('crumb-page');
      var loaded = {};
      var currentNs = 'home';
      var root = document.documentElement;
      var shellEl = document.getElementById('shell');
      var topbar = document.getElementById('topbar');
      // Which frames report an open modal (see yaosb-modal below).
      var modalOpen = {};
      // Which frames report unsaved changes (see yaosb-dirty below).
      var dirtyFrames = {};

      function byNs(ns) {
        for (var i = 0; i < EDITORS.length; i++) if (EDITORS[i].ns === ns) return EDITORS[i];
        return null;
      }

      function applyTheme(t) {
        if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
        else root.removeAttribute('data-theme');
        Array.prototype.forEach.call(frames.querySelectorAll('iframe'), function (f) {
          try { f.contentWindow.postMessage({ type: 'yaosb-theme', theme: t }, location.origin); } catch (e) {}
        });
      }

      var navOpenBtn = document.getElementById('nav-open');
      var navCloseBtn = document.getElementById('nav-close');
      // The drawer only exists on narrow screens; move focus into it and back so
      // keyboard users are not left behind the scrim.
      function openNav() {
        sidebar.classList.add('is-open');
        scrim.hidden = false;
        navCloseBtn.focus();
      }
      function closeNav() {
        if (!sidebar.classList.contains('is-open')) return;
        sidebar.classList.remove('is-open');
        scrim.hidden = true;
        if (sidebar.contains(document.activeElement)) navOpenBtn.focus();
      }
      navOpenBtn.addEventListener('click', openNav);
      navCloseBtn.addEventListener('click', closeNav);
      scrim.addEventListener('click', closeNav);

      function show(ns) {
        currentNs = ns;
        var def = byNs(ns) || { label: ns, title: ns, group: '' };
        if (!loaded[ns]) {
          var frame = document.createElement('iframe');
          frame.className = 'frame';
          frame.title = def.title;
          frame.src = '/' + ns + '/';
          // A (re)loaded document starts with no modal open and nothing unsaved.
          frame.addEventListener('load', function () { modalOpen[ns] = false; syncModal(); setDirty(ns, false); });
          frames.appendChild(frame);
          loaded[ns] = frame;
        }
        Array.prototype.forEach.call(frames.children, function (f) {
          f.classList.toggle('is-active', f === loaded[ns]);
        });
        // Frames stay loaded in the background; tell the one coming forward so
        // it can refresh anything that went stale while hidden.
        try { loaded[ns].contentWindow.postMessage({ type: 'yaosb-shown' }, location.origin); } catch (e) {}
        navItems.forEach(function (b) {
          var on = b.getAttribute('data-ns') === ns;
          b.classList.toggle('is-active', on);
          if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
        syncModal();
        crumbGroup.textContent = def.group;
        crumbPage.textContent = def.label;
        document.title = def.label + ' · ' + BOT_NAME;
        closeNav();
        try { localStorage.setItem('yaosb-tab', ns); } catch (e) {}
      }

      navItems.forEach(function (b) {
        b.addEventListener('click', function () { show(b.getAttribute('data-ns')); });
      });

      // ---- Frame modals: dim the shell chrome while the visible frame shows one,
      // and turn a click on the dimmed chrome into a dismiss request. ----
      function syncModal() { shellEl.classList.toggle('has-modal', !!modalOpen[currentNs]); }
      function frameNsOf(source) {
        var found = '';
        Object.keys(loaded).forEach(function (ns) { if (loaded[ns].contentWindow === source) found = ns; });
        return found;
      }
      addEventListener('message', function (e) {
        if (e.origin !== location.origin || !e.data) return;
        var ns = frameNsOf(e.source);
        if (!ns) return;
        if (e.data.type === 'yaosb-modal') {
          modalOpen[ns] = !!e.data.open;
          syncModal();
        } else if (e.data.type === 'yaosb-dirty') {
          setDirty(ns, !!e.data.dirty);
        } else if (e.data.type === 'yaosb-brand') {
          applyBrand(e.data.name, e.data.logoStamp);
          rebuildOtherFrames(ns);
        } else if (e.data.type === 'yaosb-prefix') {
          rebuildOtherFrames(ns);
        } else if (e.data.type === 'yaosb-open' && byNs(e.data.ns)) {
          // A page linking to another section.
          show(e.data.ns);
        }
      });

      // ---- Branding: the Setup page reports a new name or logo, so the
      // sidebar, tab title and favicon follow without a reload. Other open
      // editor frames keep their own copy of the name until they reload. ----
      function applyBrand(name, stamp) {
        var version = '/brand/logo?v=' + encodeURIComponent(stamp || String(Date.now()));
        if (typeof name === 'string' && name) {
          BOT_NAME = name;
          var nameEl = document.getElementById('brand-name');
          if (nameEl) { nameEl.textContent = name; nameEl.title = name; }
          var def = byNs(currentNs);
          document.title = def ? def.label + ' · ' + BOT_NAME : BOT_NAME + ' Dashboard';
        }
        var logoEl = document.getElementById('brand-logo');
        if (logoEl) logoEl.src = version;
        var iconEl = document.querySelector('link[rel="icon"]');
        if (iconEl) iconEl.setAttribute('href', version);
      }

      // The bot name and command prefix are compiled into each editor's
      // bundle, so after one of them changes every other frame is showing stale
      // text. Drop the frames with nothing unsaved — they rebuild when next
      // shown, and right away if one is on screen. A frame with unsaved edits
      // is left alone: stale labels are better than losing someone's work.
      function rebuildOtherFrames(exceptNs) {
        Object.keys(loaded).forEach(function (ns) {
          if (ns === exceptNs || dirtyFrames[ns]) return;
          try { frames.removeChild(loaded[ns]); } catch (e) {}
          delete loaded[ns];
          delete modalOpen[ns];
        });
        if (!loaded[currentNs]) show(currentNs);
      }

      // ---- Unsaved changes: mark the tab, and ask before throwing them away. ----
      function setDirty(ns, dirty) {
        if (dirty) dirtyFrames[ns] = true; else delete dirtyFrames[ns];
        navItems.forEach(function (b) {
          if (b.getAttribute('data-ns') === ns) b.classList.toggle('has-unsaved', dirty);
        });
      }
      function dirtyLabels(only) {
        return Object.keys(dirtyFrames)
          .filter(function (ns) { return !only || ns === only; })
          .map(function (ns) { return (byNs(ns) || { label: ns }).label; });
      }

      // Styled confirm, same look as the editors' dialogs (shared.css .dialog).
      function confirmShell(title, message, confirmLabel) {
        return new Promise(function (resolve) {
          var opener = document.activeElement;
          var scrimEl = document.createElement('div');
          scrimEl.className = 'dialog-scrim';
          var panel = document.createElement('div');
          panel.className = 'dialog';
          panel.setAttribute('role', 'alertdialog');
          panel.setAttribute('aria-modal', 'true');
          panel.setAttribute('aria-labelledby', 'shell-dialog-title');
          var body = document.createElement('div');
          body.className = 'dialog-body';
          var icon = document.createElement('span');
          icon.className = 'dialog-icon';
          icon.setAttribute('aria-hidden', 'true');
          icon.innerHTML = WARN_SVG;
          var text = document.createElement('div');
          text.className = 'dialog-text';
          var heading = document.createElement('h2');
          heading.id = 'shell-dialog-title';
          heading.textContent = title;
          var para = document.createElement('p');
          para.textContent = message;
          text.appendChild(heading);
          text.appendChild(para);
          body.appendChild(icon);
          body.appendChild(text);
          var actions = document.createElement('div');
          actions.className = 'dialog-actions';
          var cancelBtn = document.createElement('button');
          cancelBtn.type = 'button';
          cancelBtn.className = 'btn btn-quiet';
          cancelBtn.textContent = 'Keep editing';
          var okBtn = document.createElement('button');
          okBtn.type = 'button';
          okBtn.className = 'btn btn-danger-solid';
          okBtn.textContent = confirmLabel;
          actions.appendChild(cancelBtn);
          actions.appendChild(okBtn);
          panel.appendChild(body);
          panel.appendChild(actions);
          scrimEl.appendChild(panel);
          document.body.appendChild(scrimEl);
          cancelBtn.focus();
          function done(ok) {
            scrimEl.remove();
            if (opener && opener.focus) opener.focus();
            resolve(ok);
          }
          cancelBtn.addEventListener('click', function () { done(false); });
          okBtn.addEventListener('click', function () { done(true); });
          scrimEl.addEventListener('mousedown', function (e) { if (e.target === scrimEl) done(false); });
          panel.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
            else if (e.key === 'Tab') {
              e.preventDefault();
              (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
            }
          });
        });
      }
      var WARN_SVG = ${JSON.stringify(iconSvg(ICON.warn))};
      function dismissFrameModal(e) {
        if (!shellEl.classList.contains('has-modal')) return;
        e.preventDefault();
        e.stopPropagation();
        var f = loaded[currentNs];
        if (f) f.contentWindow.postMessage({ type: 'yaosb-modal-dismiss' }, location.origin);
      }
      sidebar.addEventListener('click', dismissFrameModal, true);
      topbar.addEventListener('click', dismissFrameModal, true);

      document.getElementById('frame-reload').addEventListener('click', function () {
        var ns = currentNs;
        var f = loaded[ns];
        if (!f) return;
        var ask = dirtyFrames[ns]
          ? confirmShell('Discard unsaved changes?', 'Reloading ' + (byNs(ns) || { label: ns }).label + ' throws away your edits.', 'Discard and reload')
          : Promise.resolve(true);
        ask.then(function (ok) {
          if (!ok) return;
          // Tell the page the operator already agreed, so it does not ask again.
          try { f.contentWindow.postMessage({ type: 'yaosb-discard' }, location.origin); } catch (e) {}
          try { f.contentWindow.location.reload(); } catch (e) { f.src = f.src; }
        });
      });

      // ---- Theme: one button cycling Auto → Light → Dark. ----
      var themeBtn = document.getElementById('theme-btn');
      var THEME_NEXT = { auto: 'light', light: 'dark', dark: 'auto' };
      var THEME_NAME = { auto: 'Auto (system)', light: 'Light', dark: 'Dark' };
      function markTheme(v) {
        themeBtn.setAttribute('data-theme-val', v);
        var label = 'Theme: ' + THEME_NAME[v] + '. Switch to ' + THEME_NAME[THEME_NEXT[v]];
        themeBtn.title = label;
        themeBtn.setAttribute('aria-label', label);
      }
      var storedTheme = 'auto';
      try { storedTheme = localStorage.getItem('yaosb-theme') || 'auto'; } catch (e) {}
      if (storedTheme !== 'light' && storedTheme !== 'dark') storedTheme = 'auto';
      applyTheme(storedTheme === 'auto' ? null : storedTheme);
      markTheme(storedTheme);
      themeBtn.addEventListener('click', function () {
        var v = THEME_NEXT[themeBtn.getAttribute('data-theme-val')] || 'auto';
        try { localStorage.setItem('yaosb-theme', v === 'auto' ? '' : v); } catch (e) {}
        applyTheme(v === 'auto' ? null : v);
        markTheme(v);
      });
      // Another dashboard tab changed the theme: its frames already follow via
      // their own storage listener, so only this shell needs updating.
      addEventListener('storage', function (e) {
        if (e.key !== 'yaosb-theme') return;
        var v = e.newValue === 'light' || e.newValue === 'dark' ? e.newValue : 'auto';
        if (v === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', v);
        markTheme(v);
      });

      // ---- Jump-to search: filter sections, arrows + Enter to open. ----
      var jump = document.getElementById('jump');
      var jumpInput = document.getElementById('jump-input');
      var jumpList = document.getElementById('jump-list');
      var jumpMatches = [];
      var jumpIndex = 0;

      if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) {
        document.getElementById('jump-kbd').textContent = '\u2318K';
      }

      function navIconMarkup(ns) {
        var btn = document.querySelector('.nav-item[data-ns="' + ns + '"] .nav-ico');
        return btn ? btn.innerHTML : '';
      }
      function closeJump() {
        jumpList.hidden = true;
        jumpInput.setAttribute('aria-expanded', 'false');
        jumpInput.removeAttribute('aria-activedescendant');
      }
      function renderJump() {
        var q = jumpInput.value.trim().toLowerCase();
        jumpMatches = EDITORS.filter(function (e) {
          return !q || (e.label + ' ' + e.title + ' ' + e.group + ' ' + e.blurb).toLowerCase().indexOf(q) !== -1;
        });
        if (jumpIndex >= jumpMatches.length) jumpIndex = Math.max(0, jumpMatches.length - 1);
        jumpList.innerHTML = '';
        if (!jumpMatches.length) {
          var empty = document.createElement('div');
          empty.className = 'jump-empty';
          empty.textContent = 'No sections match.';
          jumpList.appendChild(empty);
        }
        jumpMatches.forEach(function (e, i) {
          var item = document.createElement('div');
          item.className = 'jump-item' + (i === jumpIndex ? ' is-active' : '');
          item.id = 'jump-opt-' + e.ns;
          item.setAttribute('role', 'option');
          item.setAttribute('aria-selected', i === jumpIndex ? 'true' : 'false');
          var ico = document.createElement('span');
          ico.className = 'jump-item-ico';
          ico.innerHTML = navIconMarkup(e.ns);
          var text = document.createElement('span');
          text.className = 'jump-item-text';
          var label = document.createElement('span');
          label.className = 'jump-item-label';
          label.textContent = e.label;
          var blurb = document.createElement('span');
          blurb.className = 'jump-item-blurb';
          blurb.textContent = e.blurb;
          text.appendChild(label);
          text.appendChild(blurb);
          var group = document.createElement('span');
          group.className = 'jump-item-group';
          group.textContent = e.group;
          item.appendChild(ico);
          item.appendChild(text);
          item.appendChild(group);
          item.addEventListener('mousedown', function (ev) { ev.preventDefault(); pickJump(e.ns); });
          item.addEventListener('mousemove', function () {
            if (jumpIndex !== i) { jumpIndex = i; renderJump(); }
          });
          jumpList.appendChild(item);
        });
        jumpList.hidden = false;
        jumpInput.setAttribute('aria-expanded', 'true');
        if (jumpMatches[jumpIndex]) jumpInput.setAttribute('aria-activedescendant', 'jump-opt-' + jumpMatches[jumpIndex].ns);
      }
      function pickJump(ns) {
        show(ns);
        jumpInput.value = '';
        closeJump();
        jumpInput.blur();
      }
      jumpInput.addEventListener('focus', function () { jumpIndex = 0; renderJump(); });
      jumpInput.addEventListener('input', function () { jumpIndex = 0; renderJump(); });
      jumpInput.addEventListener('blur', closeJump);
      jumpInput.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); if (jumpMatches.length) { jumpIndex = (jumpIndex + 1) % jumpMatches.length; renderJump(); } }
        else if (e.key === 'ArrowUp') { e.preventDefault(); if (jumpMatches.length) { jumpIndex = (jumpIndex - 1 + jumpMatches.length) % jumpMatches.length; renderJump(); } }
        else if (e.key === 'Enter') { e.preventDefault(); if (jumpMatches[jumpIndex]) pickJump(jumpMatches[jumpIndex].ns); }
        else if (e.key === 'Escape') { jumpInput.value = ''; closeJump(); jumpInput.blur(); }
      });
      document.addEventListener('keydown', function (e) {
        var tag = (e.target && e.target.tagName) || '';
        var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
        if (((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) || (e.key === '/' && !typing)) {
          if (getComputedStyle(jump).display === 'none') return;
          e.preventDefault();
          jumpInput.focus();
          jumpInput.select();
        } else if (e.key === 'Escape') {
          closeNav();
        }
      });

      var startTab = 'home';
      try { startTab = localStorage.getItem('yaosb-tab') || 'home'; } catch (e) {}
      if (!byNs(startTab)) startTab = 'home';
      show(startTab);

      // ---- Server card + bot status (both fed by /api/servers). ----
      var switchBtn = document.getElementById('server-switch');
      var serverName = document.getElementById('server-name');
      var serverSub = document.getElementById('server-sub');
      var serverTile = document.getElementById('server-tile');
      var statusEl = document.getElementById('status');
      var statusText = document.getElementById('status-text');
      var brandDot = document.getElementById('brand-dot');

      function initials(name) {
        var words = String(name || '').replace(/[^\\p{L}\\p{N}\\s]/gu, ' ').trim().split(/\\s+/).filter(Boolean);
        if (!words.length) return '#';
        // Array.from splits by code point, so astral letters stay whole.
        var first = Array.from(words[0]);
        var out = first[0] + (words.length > 1 ? Array.from(words[1])[0] : first[1] || '');
        return out.toUpperCase();
      }
      function showServer(name) {
        serverName.textContent = name;
        serverName.title = name;
        serverTile.textContent = initials(name);
      }
      var statusPing = document.getElementById('status-ping');
      // Only the state label is a live region, and it is only rewritten when the
      // state changes, so screen readers are not told the ping every 30 s.
      function setStatus(state, text, ping) {
        if (statusEl.getAttribute('data-state') !== state || statusText.textContent !== text) {
          statusEl.setAttribute('data-state', state);
          brandDot.setAttribute('data-state', state);
          statusText.textContent = text;
        }
        statusPing.textContent = ping ? ping + ' ms' : '';
      }
      function updateStatus(data) {
        var bot = (data && data.bot) || {};
        if (bot.online) setStatus('ok', 'Online', bot.ping);
        else if (bot.reconnecting) setStatus('warn', 'Reconnecting');
        else setStatus('down', 'Bot offline');
      }

      function getCookie(name) {
        var m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
        return m ? decodeURIComponent(m[1]) : '';
      }
      function setServerCookie(id) {
        // path=/ so every editor namespace's requests carry it; year-long max-age.
        document.cookie = 'yaosb-server=' + encodeURIComponent(id) + '; path=/; max-age=31536000; SameSite=Strict';
      }
      // Drop all loaded iframes and re-open the active tab so editors re-fetch
      // scoped to the newly selected server.
      function reloadFrames() {
        Object.keys(loaded).forEach(function (ns) {
          var f = loaded[ns];
          if (f && f.parentNode) f.parentNode.removeChild(f);
        });
        loaded = {};
        modalOpen = {};
        Object.keys(dirtyFrames).forEach(function (ns) { setDirty(ns, false); });
        show(currentNs);
      }

      // ---- Server menu: a listbox under the card, same look and keys as the
      // editors' dropdowns (shared/select.ts). ----
      var serverMenu = document.getElementById('server-menu');
      var serverList = document.getElementById('server-menu-list');
      var serverSearchWrap = document.getElementById('server-search-wrap');
      var serverSearch = document.getElementById('server-search');
      var serverItems = [];
      var activeServerId = '';
      var menuMatches = [];
      var menuIndex = 0;
      var CHECK_SVG = ${JSON.stringify(iconSvg(ICON.check))};

      function menuOpen() { return !!serverMenu && !serverMenu.hidden; }
      function searching() { return !serverSearchWrap.hidden; }
      function focusHolder() { return searching() ? serverSearch : switchBtn; }
      function markMenuIndex() {
        Array.prototype.forEach.call(serverList.children, function (el, i) {
          var on = i === menuIndex;
          el.classList.toggle('is-active', on);
          if (on) el.scrollIntoView({ block: 'nearest' });
        });
        var holder = focusHolder();
        if (menuMatches[menuIndex]) holder.setAttribute('aria-activedescendant', 'server-opt-' + menuIndex);
        else holder.removeAttribute('aria-activedescendant');
        if (holder !== switchBtn) switchBtn.removeAttribute('aria-activedescendant');
      }
      function renderServerMenu() {
        var q = serverSearch.value.trim().toLowerCase();
        menuMatches = serverItems.filter(function (s) { return !q || s.name.toLowerCase().indexOf(q) !== -1; });
        if (menuIndex >= menuMatches.length) menuIndex = Math.max(0, menuMatches.length - 1);
        serverList.innerHTML = '';
        if (!menuMatches.length) {
          var empty = document.createElement('div');
          empty.className = 'select-empty';
          empty.textContent = 'No servers match.';
          serverList.appendChild(empty);
        }
        menuMatches.forEach(function (s, i) {
          var isActive = s.id === activeServerId;
          var row = document.createElement('div');
          row.className = 'select-option server-option' + (isActive ? ' is-selected' : '');
          row.id = 'server-opt-' + i;
          row.setAttribute('role', 'option');
          row.setAttribute('aria-selected', isActive ? 'true' : 'false');
          var tile = document.createElement('span');
          tile.className = 'server-option-tile';
          tile.setAttribute('aria-hidden', 'true');
          tile.textContent = initials(s.name);
          var name = document.createElement('span');
          name.className = 'select-option-text';
          var label = document.createElement('span');
          label.className = 'select-option-label';
          label.textContent = s.name;
          name.appendChild(label);
          row.appendChild(tile);
          row.appendChild(name);
          if (isActive) {
            var check = document.createElement('span');
            check.className = 'select-check';
            check.setAttribute('aria-hidden', 'true');
            check.innerHTML = CHECK_SVG;
            row.appendChild(check);
          }
          row.addEventListener('mousedown', function (e) { e.preventDefault(); });
          row.addEventListener('mousemove', function () { if (menuIndex !== i) { menuIndex = i; markMenuIndex(); } });
          row.addEventListener('click', function () { pickServer(s.id); });
          serverList.appendChild(row);
        });
        markMenuIndex();
      }
      function openServerMenu() {
        if (!switchBtn || switchBtn.disabled || menuOpen()) return;
        serverSearch.value = '';
        serverSearchWrap.hidden = serverItems.length <= 8;
        menuIndex = Math.max(0, serverItems.findIndex(function (s) { return s.id === activeServerId; }));
        serverMenu.hidden = false;
        switchBtn.setAttribute('aria-expanded', 'true');
        switchBtn.classList.add('is-open');
        renderServerMenu();
        if (searching()) serverSearch.focus();
      }
      function closeServerMenu(refocus) {
        if (!menuOpen()) return;
        serverMenu.hidden = true;
        switchBtn.setAttribute('aria-expanded', 'false');
        switchBtn.classList.remove('is-open');
        switchBtn.removeAttribute('aria-activedescendant');
        if (refocus) switchBtn.focus();
      }
      function pickServer(id) {
        closeServerMenu(true);
        if (!id || id === activeServerId) return;
        var unsaved = dirtyLabels();
        if (!unsaved.length) { switchServer(id); return; }
        confirmShell(
          'Discard unsaved changes?',
          'Switching servers reloads every section. Unsaved changes in ' + unsaved.join(', ') + ' will be lost.',
          'Switch anyway'
        ).then(function (ok) { if (ok) switchServer(id); });
      }
      function switchServer(id) {
        var chosen = serverItems.filter(function (s) { return s.id === id; })[0];
        activeServerId = id;
        if (chosen) showServer(chosen.name);
        setServerCookie(id);
        try { localStorage.setItem('yaosb-server', id); } catch (e) {}
        reloadFrames();
      }
      function onServerMenuKey(e) {
        var key = e.key;
        if (!menuOpen()) {
          if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') { e.preventDefault(); openServerMenu(); }
          return;
        }
        var n = menuMatches.length;
        if (key === 'ArrowDown') { e.preventDefault(); if (n) { menuIndex = (menuIndex + 1) % n; markMenuIndex(); } }
        else if (key === 'ArrowUp') { e.preventDefault(); if (n) { menuIndex = (menuIndex - 1 + n) % n; markMenuIndex(); } }
        else if (key === 'Home') { e.preventDefault(); menuIndex = 0; markMenuIndex(); }
        else if (key === 'End') { e.preventDefault(); menuIndex = Math.max(0, n - 1); markMenuIndex(); }
        else if (key === 'Enter' || (key === ' ' && !searching())) { e.preventDefault(); if (menuMatches[menuIndex]) pickServer(menuMatches[menuIndex].id); }
        else if (key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeServerMenu(true); }
        else if (key === 'Tab') { if (searching()) e.preventDefault(); closeServerMenu(searching()); }
        else if (!searching() && key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Type-ahead: jump to the next server starting with the letter.
          for (var step = 1; step <= n; step++) {
            var i = (menuIndex + step) % n;
            if (menuMatches[i].name.toLowerCase().indexOf(key.toLowerCase()) === 0) { menuIndex = i; markMenuIndex(); break; }
          }
        }
      }
      if (switchBtn) {
        switchBtn.addEventListener('click', function () { if (menuOpen()) closeServerMenu(true); else openServerMenu(); });
        switchBtn.addEventListener('keydown', onServerMenuKey);
        serverSearch.addEventListener('keydown', onServerMenuKey);
        serverSearch.addEventListener('input', function () { menuIndex = 0; renderServerMenu(); });
        document.addEventListener('pointerdown', function (e) {
          if (!menuOpen() || switchBtn.contains(e.target) || serverMenu.contains(e.target)) return;
          closeServerMenu(false);
        }, true);
        // Clicking into an editor frame blurs this window.
        addEventListener('blur', function () { closeServerMenu(false); });
      }

      function populateServers(data) {
        if (!data || !data.ok || !Array.isArray(data.servers)) return;
        var servers = data.servers;
        if (servers.length === 0) {
          showServer('No servers');
          serverSub.textContent = 'Invite the bot first';
          if (switchBtn) switchBtn.disabled = true;
          return;
        }
        var active = data.activeId || servers[0].id;
        var activeServer = servers.filter(function (s) { return s.id === active; })[0] || servers[0];
        showServer(activeServer.name);
        // Guests have no switcher (the link is bound to one server).
        if (!switchBtn) return;
        serverSub.textContent = servers.length > 1 ? 'Active server · ' + servers.length + ' total' : 'Active server';
        serverItems = servers;
        activeServerId = activeServer.id;
        switchBtn.disabled = false;

        // Keep the cookie in sync with what the shell shows so iframe requests
        // target the same server. Only reload if a stale cookie disagreed —
        // on a fresh load the frames already match the backend default.
        var prev = getCookie('yaosb-server');
        if (!prev) {
          setServerCookie(active);
        } else if (prev !== active) {
          setServerCookie(active);
          reloadFrames();
        }
      }

      function poll(first) {
        fetch('/api/servers', { headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (first) populateServers(data);
            updateStatus(data);
          })
          .catch(function () { setStatus('down', 'Dashboard unreachable'); });
      }
      poll(true);
      setInterval(function () { if (!document.hidden) poll(false); }, 30000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(false); });
    })();
  </script>
</body>
</html>`;
}

// The Share-access panel: markup injected into the owner shell only.
const SHARE_PANEL_HTML = `
  <div class="share-overlay" id="share-overlay" hidden>
    <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <div class="share-head">
        <h2 id="share-title">Share dashboard access</h2>
        <button class="share-x" id="share-close" type="button" aria-label="Close">&times;</button>
      </div>
      <div class="share-body">
        <p class="share-note">Creates a temporary public link to this server's dashboard through a Cloudflare tunnel. The link is the only lock — it expires automatically.</p>
        <div class="share-field">
          <span class="share-field-label">Permission</span>
          <div class="share-seg" id="share-scope" role="radiogroup" aria-label="Permission">
            <button type="button" role="radio" data-val="read" aria-checked="true" class="is-active">Read only</button>
            <button type="button" role="radio" data-val="read-edit" aria-checked="false">Read &amp; edit</button>
          </div>
        </div>
        <div class="share-field">
          <span class="share-field-label" id="share-ttl-label">Expires after</span>
          <div class="share-seg" id="share-ttl" role="radiogroup" aria-labelledby="share-ttl-label">
            <button type="button" role="radio" data-val="900000" aria-checked="false">15 min</button>
            <button type="button" role="radio" data-val="3600000" aria-checked="true" class="is-active">1 hour</button>
            <button type="button" role="radio" data-val="21600000" aria-checked="false">6 hours</button>
            <button type="button" role="radio" data-val="86400000" aria-checked="false">24 hours</button>
          </div>
        </div>
        <label class="share-check">
          <input type="checkbox" id="share-single" checked>
          <span>Only the first person who opens it can use it</span>
        </label>
        <button class="share-create" id="share-create" type="button">Create link</button>
        <p class="share-error" id="share-error" role="alert" hidden></p>
        <div class="share-result" id="share-result" hidden>
          <div class="share-url-row">
            <input id="share-url" readonly>
            <button id="share-copy" type="button">Copy</button>
          </div>
          <div class="share-meta" id="share-meta"></div>
        </div>
        <div class="share-list-wrap">
          <span class="share-list-head">Active links</span>
          <div class="share-list" id="share-list"></div>
        </div>
      </div>
    </div>
  </div>`;

// Client script for the Share panel. Plain ES5 (matches the shell script style);
// no backticks or template interpolation because it is embedded in a template.
const SHARE_PANEL_JS = `
    (function () {
      var overlay = document.getElementById('share-overlay');
      if (!overlay) return;
      var openBtn = document.getElementById('share-open');
      var closeBtn = document.getElementById('share-close');
      var scopeSeg = document.getElementById('share-scope');
      var ttlSeg = document.getElementById('share-ttl');
      var singleChk = document.getElementById('share-single');
      var createBtn = document.getElementById('share-create');
      var result = document.getElementById('share-result');
      var urlInput = document.getElementById('share-url');
      var copyBtn = document.getElementById('share-copy');
      var meta = document.getElementById('share-meta');
      var list = document.getElementById('share-list');
      var errorLine = document.getElementById('share-error');
      var scope = 'read';
      var ttlMs = 3600000;

      function showError(text) {
        errorLine.textContent = text || '';
        errorLine.hidden = !text;
      }
      function open() {
        overlay.hidden = false;
        showError('');
        loadList();
        closeBtn.focus();
      }
      function close() {
        if (overlay.hidden) return;
        overlay.hidden = true;
        openBtn.focus();
      }
      openBtn.addEventListener('click', open);
      closeBtn.addEventListener('click', close);
      overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !overlay.hidden) close(); });

      // Segmented radio groups: click or arrow keys pick one.
      function radioGroup(seg, onPick) {
        var btns = Array.prototype.slice.call(seg.querySelectorAll('button'));
        function select(b, focus) {
          btns.forEach(function (x) {
            var on = x === b;
            x.classList.toggle('is-active', on);
            x.setAttribute('aria-checked', on ? 'true' : 'false');
            x.tabIndex = on ? 0 : -1;
          });
          if (focus) b.focus();
          onPick(b.getAttribute('data-val'));
        }
        btns.forEach(function (b, i) {
          b.tabIndex = b.classList.contains('is-active') ? 0 : -1;
          b.addEventListener('click', function () { select(b, false); });
          b.addEventListener('keydown', function (e) {
            var step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            select(btns[(i + step + btns.length) % btns.length], true);
          });
        });
      }
      radioGroup(scopeSeg, function (v) { scope = v; });
      radioGroup(ttlSeg, function (v) { ttlMs = Number(v); });

      function fmtLeft(ms) {
        var s = Math.max(0, Math.floor(ms / 1000));
        if (s >= 3600) return Math.round(s / 3600) + 'h';
        if (s >= 60) return Math.round(s / 60) + 'm';
        return s + 's';
      }

      createBtn.addEventListener('click', function () {
        createBtn.disabled = true;
        createBtn.textContent = 'Creating…';
        showError('');
        fetch('/api/share', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scope: scope, ttlMs: ttlMs, singleUse: !!singleChk.checked })
        }).then(function (r) { return r.json(); }).then(function (data) {
          createBtn.disabled = false;
          createBtn.textContent = 'Create link';
          if (!data || !data.ok) { showError((data && data.error) || 'Could not create link.'); return; }
          urlInput.value = data.url;
          var bits = [data.scope === 'read' ? 'Read only' : 'Read & edit'];
          bits.push('expires in ' + fmtLeft(data.expiresAt - Date.now()));
          bits.push(data.singleUse ? 'single use' : 'multi use');
          meta.textContent = bits.join(' · ');
          result.hidden = false;
          loadList();
        }).catch(function () {
          createBtn.disabled = false;
          createBtn.textContent = 'Create link';
          showError('Could not create link.');
        });
      });

      copyBtn.addEventListener('click', function () {
        urlInput.select();
        var done = function () { copyBtn.textContent = 'Copied'; setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1500); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(urlInput.value).then(done, function () { try { document.execCommand('copy'); done(); } catch (e) {} });
        } else { try { document.execCommand('copy'); done(); } catch (e) {} }
      });

      function loadList() {
        fetch('/api/share', { headers: { 'Accept': 'application/json' } })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            list.innerHTML = '';
            if (!data || !data.ok || !data.links || !data.links.length) {
              list.innerHTML = '<div class="share-empty">No active links.</div>';
              return;
            }
            data.links.sort(function (a, b) { return b.createdAt - a.createdAt; }).forEach(function (l) {
              var row = document.createElement('div');
              row.className = 'share-item';
              var info = document.createElement('div');
              info.className = 'share-item-info';
              var tag = (l.scope === 'read' ? 'Read only' : 'Read & edit');
              tag += ' · ' + fmtLeft(l.expiresAt - Date.now()) + ' left';
              if (l.singleUse) tag += ' · ' + (l.claimed ? 'claimed' : 'single use');
              info.innerHTML = '<span class="share-item-scope">' + tag + '</span>' +
                '<span class="share-item-token">…' + String(l.token).slice(-8) + '</span>';
              var rev = document.createElement('button');
              rev.className = 'share-revoke';
              rev.type = 'button';
              rev.textContent = 'Revoke';
              rev.addEventListener('click', function () {
                fetch('/api/share', {
                  method: 'DELETE',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ token: l.token })
                }).then(function () { loadList(); }).catch(function () {});
              });
              row.appendChild(info);
              row.appendChild(rev);
              list.appendChild(row);
            });
          }).catch(function () {});
      }
    })();`;

const DASHBOARD_CSS = `
:root { --bar-h: 60px; --side-w: 248px; }
body { overflow: hidden; }
.shell { display: grid; grid-template-columns: var(--side-w) minmax(0, 1fr); height: 100dvh; }

.icon-btn {
  display: grid; place-items: center; flex: none;
  width: 34px; height: 34px; padding: 0;
  border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--text-muted); cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.icon-btn:hover { background: var(--surface-2); color: var(--text); }
.icon-btn svg { width: 17px; height: 17px; }
.theme-ico { display: none; }
.theme-btn[data-theme-val='auto'] .theme-ico-auto,
.theme-btn[data-theme-val='light'] .theme-ico-light,
.theme-btn[data-theme-val='dark'] .theme-ico-dark { display: grid; }

/* ---- Sidebar ---- */
.sidebar {
  position: relative; display: flex; flex-direction: column; min-height: 0;
  background: var(--sidebar);
  border-right: 1px solid var(--line);
}

.brand {
  display: flex; align-items: center; gap: 11px; flex: none;
  height: var(--bar-h); padding: 0 16px;
  border-bottom: 1px solid var(--line);
}
.brand-mark {
  position: relative; display: grid; place-items: center; flex: none;
  width: 32px; height: 32px; border-radius: var(--r-sm);
}
/* The logo carries its own background, so the tile behind it stays neutral —
   a custom upload with transparency still reads on both themes. */
.brand-logo {
  width: 100%; height: 100%; border-radius: inherit;
  object-fit: contain; background: var(--surface-2);
}
.brand-dot {
  position: absolute; right: -3px; top: -3px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--text-faint); border: 2px solid var(--sidebar);
}
.brand-dot[data-state='ok'] { background: var(--ok); }
.brand-dot[data-state='warn'] { background: var(--warn); }
.brand-dot[data-state='down'] { background: var(--danger); }
.brand-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.brand-name {
  font-family: var(--font-display); font-weight: 700; font-size: 14.5px; line-height: 1.2;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.brand-tag {
  font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-faint);
}
.sidebar-close { display: none; }

/* Server card: a button that opens the server menu below it. */
.server-wrap { position: relative; z-index: 6; flex: none; padding: 10px 12px; border-bottom: 1px solid var(--line); }
.server-switch {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--surface); color: var(--text);
  font: inherit; text-align: left;
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
}
button.server-switch { cursor: pointer; }
button.server-switch:disabled { cursor: default; }
button.server-switch:hover:not(:disabled) { border-color: var(--line-strong); background: var(--surface-2); }
button.server-switch:focus-visible,
button.server-switch.is-open { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-quiet); }
.server-tile {
  display: grid; place-items: center; flex: none;
  width: 30px; height: 30px; border-radius: var(--r-xs);
  background: var(--info-quiet); color: var(--info);
  font-family: var(--font-display); font-weight: 700; font-size: 12px;
}
.server-meta { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.server-name { font-size: 12.5px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.server-sub { font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.server-chevron { display: grid; place-items: center; flex: none; color: var(--text-faint); }
.server-chevron svg { width: 15px; height: 15px; }
button.server-switch:disabled .server-chevron { opacity: 0.4; }
.server-menu {
  position: absolute; left: 12px; right: 12px; top: calc(100% - 4px);
  display: flex; flex-direction: column; max-height: min(360px, 60dvh);
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-sm);
  box-shadow: var(--shadow-lg); overflow: hidden;
  animation: select-in 120ms var(--ease);
}
.server-menu[hidden] { display: none; }
.server-option-tile {
  display: grid; place-items: center; flex: none;
  width: 24px; height: 24px; border-radius: var(--r-xs);
  background: var(--info-quiet); color: var(--info);
  font-family: var(--font-display); font-weight: 700; font-size: 10px;
}
.select-check svg { display: block; width: 15px; height: 15px; }

.nav { flex: 1; min-height: 0; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 14px; }
.nav-group { display: flex; flex-direction: column; gap: 2px; }
.nav-heading {
  padding: 0 10px 6px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase;
  color: var(--text-faint);
}
.nav-item {
  display: flex; align-items: center; gap: 11px; width: 100%;
  height: 32px; padding: 0 10px; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--text-muted);
  font: inherit; font-size: 13px; font-weight: 600; text-align: left; cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease);
}
.nav-item:hover { background: var(--surface-2); color: var(--text); }
.nav-item.is-active { background: var(--surface-2); color: var(--text); }
.nav-ico { display: grid; place-items: center; flex: none; width: 16px; height: 16px; }
.nav-ico svg { width: 16px; height: 16px; }
.nav-item.is-active .nav-ico { color: var(--accent); }
.nav-label { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nav-unsaved { display: none; flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.nav-item.has-unsaved .nav-unsaved { display: block; }
.dialog-icon svg { display: block; }

.sidebar-foot {
  flex: none; display: flex; flex-direction: column; gap: 8px;
  padding: 8px 12px 12px; border-top: 1px solid var(--line);
}

.operator {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 4px 0 6px; border-top: 1px solid var(--line);
}
.operator-avatar {
  display: grid; place-items: center; flex: none;
  width: 30px; height: 30px; border-radius: 50%;
  background: var(--surface-3); color: var(--text-muted);
}
.operator-avatar svg { width: 15px; height: 15px; }
.operator-meta { display: flex; flex-direction: column; min-width: 0; }
.operator-name { font-size: 12.5px; font-weight: 700; }
.operator-sub { font-size: 11px; color: var(--text-faint); }

.nav-scrim { display: none; }

/* ---- Main column: top bar over the editor frames ---- */
.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }

.topbar {
  position: relative; display: flex; align-items: center; gap: 8px; flex: none;
  height: var(--bar-h); padding: 0 20px 0 24px;
  background: var(--bg); border-bottom: 1px solid var(--line);
}
.nav-open { display: none; margin-left: -8px; }
.crumbs { display: flex; align-items: baseline; gap: 8px; flex: 0 0 auto; max-width: 45%; min-width: 0; margin-right: auto; }
.crumb-group { font-size: 12px; font-weight: 600; color: var(--text-faint); white-space: nowrap; }
.crumb-sep { color: var(--line-strong); }
.crumb-page {
  font-family: var(--font-display); font-size: 15px; font-weight: 700;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* The search box gives up width before the page title does. */
.jump { position: relative; flex: 0 1 280px; min-width: 150px; margin-right: 4px; }
.jump-ico {
  position: absolute; left: 11px; top: 50%; transform: translateY(-50%);
  display: grid; place-items: center; color: var(--text-faint); pointer-events: none;
}
.jump-ico svg { width: 15px; height: 15px; }
.jump .jump-input {
  height: 34px; padding: 0 64px 0 34px;
  background: var(--surface); border-color: var(--line); font-size: 12.5px;
}
.jump-kbd {
  position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
  padding: 1px 6px; border: 1px solid var(--line); border-radius: var(--r-xs);
  background: var(--surface-2); color: var(--text-faint);
  font: 600 10.5px/16px var(--font); pointer-events: none;
}
.jump-input:focus ~ .jump-kbd { opacity: 0; }
.jump-list {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 30;
  width: 360px; max-height: min(420px, 70dvh); overflow-y: auto; padding: 6px;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-sm);
  box-shadow: var(--shadow-lg);
}
.jump-list[hidden] { display: none; }
.jump-item {
  display: flex; align-items: center; gap: 11px;
  padding: 8px 10px; border-radius: var(--r-xs); cursor: pointer;
}
.jump-item.is-active { background: var(--surface-2); }
.jump-item-ico {
  display: grid; place-items: center; flex: none;
  width: 28px; height: 28px; border-radius: var(--r-xs);
  background: var(--surface-2); color: var(--text-muted);
}
.jump-item.is-active .jump-item-ico { background: var(--accent-quiet); color: var(--accent-ink); }
.jump-item-ico svg { width: 15px; height: 15px; }
.jump-item-text { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.jump-item-label { font-size: 13px; font-weight: 700; }
.jump-item-blurb { font-size: 11.5px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.jump-item-group {
  flex: none; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  color: var(--text-faint);
}
.jump-empty { padding: 14px 10px; font-size: 12.5px; color: var(--text-faint); }

.topbar-rule { width: 1px; height: 22px; margin: 0 8px; background: var(--line); flex: none; }
.status { display: flex; align-items: center; gap: 8px; flex: none; font-size: 12px; font-weight: 700; white-space: nowrap; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex: none; }
.status[data-state='ok'] .status-dot { background: var(--ok); animation: pulse-dot 2s ease-in-out infinite; }
.status[data-state='warn'] .status-dot { background: var(--warn); }
.status[data-state='down'] .status-dot { background: var(--danger); }
.status[data-state='down'] .status-text { color: var(--danger); }
.status-ping { color: var(--text-muted); font-weight: 600; }
.status-ping:empty { display: none; }
.status-ping::before { content: '·' / ''; margin-right: 8px; color: var(--text-faint); }

/* Matches the scrim a frame draws over its own page while a modal is open. */
.shell.has-modal .sidebar::after,
.shell.has-modal .topbar::after {
  content: ''; position: absolute; inset: 0; z-index: 25;
  background: var(--scrim); cursor: default;
  animation: chrome-scrim-in var(--dur) var(--ease);
}
@keyframes chrome-scrim-in { from { opacity: 0; } to { opacity: 1; } }

.stage { position: relative; flex: 1; min-height: 0; background: var(--bg); overflow: hidden; }
.frames { position: absolute; inset: 0; }
/* Hidden frames also leave the tab order and accessibility tree; visibility
   flips after the fade so the outgoing frame still fades. */
.frame {
  position: absolute; inset: 0; width: 100%; height: 100%;
  border: 0; background: var(--bg); opacity: 0; visibility: hidden;
  transition: opacity 140ms var(--ease), visibility 0s linear 140ms;
}
.frame.is-active { opacity: 1; visibility: visible; transition: opacity 140ms var(--ease), visibility 0s; }

/* ---- Narrow screens: sidebar becomes an off-canvas drawer ---- */
@media (max-width: 960px) {
  .shell { grid-template-columns: minmax(0, 1fr); }
  .sidebar {
    position: fixed; inset: 0 auto 0 0; z-index: 40; width: min(var(--side-w), 86vw);
    transform: translateX(-100%); visibility: hidden;
    transition: transform 220ms var(--ease), visibility 0s linear 220ms;
  }
  .sidebar.is-open {
    transform: none; visibility: visible; box-shadow: var(--shadow-lg);
    transition: transform 220ms var(--ease), visibility 0s;
  }
  .sidebar-close { display: grid; margin-right: -8px; }
  .nav-scrim { display: block; position: fixed; inset: 0; z-index: 35; background: var(--scrim); }
  .nav-scrim[hidden] { display: none; }
  .nav-open { display: grid; }
  .topbar { padding: 0 12px 0 16px; }
}
@media (max-width: 640px) {
  .jump, .topbar-rule, .crumb-group, .crumb-sep { display: none; }
  .status-ping { display: none; }
}

/* ---- Share-access panel ---- */
.share-overlay {
  position: fixed; inset: 0; z-index: 50;
  display: grid; place-items: center; padding: 20px;
  background: var(--scrim);
}
/* A class-level display: wins over the bare [hidden] UA rule, so restore it. */
.share-overlay[hidden], .share-result[hidden] { display: none; }
.share-modal {
  width: 100%; max-width: 440px; max-height: 88dvh; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-sm);
  box-shadow: var(--shadow-lg);
}
.share-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 18px; border-bottom: 1px solid var(--line);
}
.share-head h2 { margin: 0; font-size: 15px; }
.share-x {
  border: 0; background: transparent; color: var(--text-muted);
  font-size: 22px; line-height: 1; cursor: pointer; padding: 0 4px;
}
.share-x:hover { color: var(--text); }
.share-body { padding: 16px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
.share-note { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--text-muted); }
.share-field { display: flex; flex-direction: column; gap: 6px; }
.share-field-label { font-size: 12px; font-weight: 700; color: var(--text-muted); }
.share-seg {
  display: flex; padding: 2px; gap: 2px;
  background: var(--bg-sunken); border: 1px solid var(--line); border-radius: var(--r-sm);
}
.share-seg button {
  flex: 1; border: 0; background: transparent; color: var(--text-muted);
  padding: 6px 8px; border-radius: var(--r-xs); font: inherit; font-weight: 600; font-size: 12.5px; cursor: pointer;
}
.share-seg button:hover { color: var(--text); }
.share-seg button.is-active { background: var(--control-active); color: var(--text); box-shadow: var(--shadow-sm); }
.share-check { display: flex; align-items: center; gap: 9px; font-size: 12.5px; color: var(--text); cursor: pointer; }
.share-check input { accent-color: var(--accent); width: 15px; height: 15px; }
.share-create {
  height: 36px; border: 0; border-radius: var(--r-sm);
  background: var(--accent); color: var(--on-accent); font: inherit; font-weight: 700; font-size: 13px; cursor: pointer;
}
.share-create:hover { background: var(--accent-strong); }
.share-create:disabled { opacity: 0.6; cursor: default; }
.share-error { margin: 0; font-size: 12.5px; font-weight: 600; color: var(--danger); }
.share-error[hidden] { display: none; }
.share-result {
  display: flex; flex-direction: column; gap: 8px;
  padding: 12px; border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--bg-sunken);
}
.share-url-row { display: flex; gap: 6px; }
.share-url-row input { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: 12px; }
.share-url-row button {
  border: 1px solid var(--line); border-radius: var(--r-sm); background: var(--surface-2);
  color: var(--text); font: inherit; font-weight: 700; font-size: 12px; padding: 0 12px; cursor: pointer;
}
.share-meta { font-size: 11.5px; color: var(--text-faint); }
.share-list-wrap { display: flex; flex-direction: column; gap: 8px; border-top: 1px solid var(--line); padding-top: 14px; }
.share-list-head { font-size: 10px; text-transform: uppercase; letter-spacing: 0.09em; font-weight: 700; color: var(--text-faint); }
.share-list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-sm); }
.share-empty { font-size: 12px; color: var(--text-faint); padding: 10px 12px; }
.share-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  padding: 9px 12px;
}
.share-item + .share-item { border-top: 1px solid var(--line); }
.share-item-info { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.share-item-scope { font-size: 12px; font-weight: 600; color: var(--text); }
.share-item-token { font-size: 11px; color: var(--text-faint); font-family: var(--font-mono); }
.share-revoke {
  border: 1px solid var(--line); border-radius: var(--r-sm); background: transparent;
  color: var(--text-muted); font: inherit; font-size: 11.5px; font-weight: 700; padding: 4px 10px; cursor: pointer; flex: none;
}
.share-revoke:hover { color: var(--danger); border-color: var(--danger-border); }
`;

// ---- HTTP helpers (mirror the editor servers' shape). ----

function buildUrl(port: number) {
  return `http://localhost:${port}/`;
}

function listenWithFallback(server: Server, host: string, startPort: number): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  let port = startPort;
  const tryListen = () => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off('listening', onListening);
      if (error.code === 'EADDRINUSE' && port < startPort + 20) {
        port += 1;
        tryListen();
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  };
  tryListen();
  return promise;
}

function sendCss(response: ServerResponse, css: string) {
  sendText(response, 'text/css; charset=utf-8', css);
}
