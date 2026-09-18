/**
 * Booru editor — request handler for the dashboard `/booru` namespace.
 *
 * Two kinds of settings live here:
 * - per server: adult results, disabled sites, tag blacklist;
 * - bot-wide: site accounts (API keys). These go straight into the encrypted
 *   secret store; the browser can save, test, and remove a key but never read
 *   one back. Share-link guests cannot see or touch accounts at all, since a
 *   key belongs to the bot owner, not to the server the link was made for.
 */
import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, hasField, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { info } from './logger.js';
import {
  BOORU_ACCOUNTS,
  BOORU_SITES,
  BooruError,
  findBooruAccount,
  getBooruAccountState,
  getBooruCredentials,
  getBooruSettings,
  isSiteConfigured,
  normalizeBlacklist,
  normalizeBooruCredentials,
  removeBooruCredentials,
  saveBooruCredentials,
  testBooruAccount,
  updateBooruSettings,
  type BooruServerSettings,
} from './booru/index.js';

const MAX_BODY_BYTES = 256 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'booru');
const editorApp = createEditorBundler({ assetDir: EDITOR_ASSET_DIR, apiBase: '/booru', label: 'Booru', withPrefix: true });

type BooruEditorContext = { client: any; serverId: string; guest?: boolean };

export async function handleBooruEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: BooruEditorContext) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) {
    sendHtml(response, renderEditorPage('Booru'));
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
      serverId: ctx.serverId,
      settings: getBooruSettings(ctx.serverId),
      sites: siteViews(!ctx.guest),
      accounts: ctx.guest ? null : accountViews(),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/settings') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const settings = updateBooruSettings(ctx.serverId, () => sanitizeSettings(body));
    sendJson(response, 200, { ok: true, settings });
    return;
  }

  const accountMatch = pathname.match(/^\/api\/accounts\/([a-z0-9]+)$/);
  if (accountMatch) {
    if (ctx.guest) {
      sendJson(response, 403, { ok: false, error: 'Site accounts are only available to the bot owner.' });
      return;
    }
    const account = findBooruAccount(accountMatch[1]);
    if (!account) {
      sendJson(response, 404, { ok: false, error: 'Unknown account.' });
      return;
    }

    if (method === 'POST') {
      const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
      let credentials;
      try {
        credentials = normalizeBooruCredentials(account, body);
      } catch (error) {
        sendJson(response, 400, { ok: false, error: (error as Error).message });
        return;
      }
      // Check the key against the site first, unless the owner already saw
      // the check fail and chose to keep the key anyway (site down, etc.).
      if (body?.force !== true) {
        try {
          await testBooruAccount(account.id, credentials);
        } catch (error) {
          const message =
            error instanceof BooruError
              ? error.status === 401 || error.status === 403
                ? `${account.name} rejected these credentials (HTTP ${error.status}).`
                : error.message
              : 'The site could not be reached.';
          sendJson(response, 400, { ok: false, error: message, canForce: true });
          return;
        }
      }
      saveBooruCredentials(account.id, credentials);
      info(`booru: saved the ${account.name} account from the dashboard${body?.force === true ? ' (unverified)' : ''}.`);
      sendJson(response, 200, { ok: true, account: accountView(account.id), sites: siteViews(true) });
      return;
    }

    if (method === 'DELETE') {
      removeBooruCredentials(account.id);
      info(`booru: removed the ${account.name} account from the dashboard.`);
      sendJson(response, 200, { ok: true, account: accountView(account.id), sites: siteViews(true) });
      return;
    }
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function sanitizeSettings(body: any): Partial<BooruServerSettings> {
  const out: Partial<BooruServerSettings> = {};
  if (hasField(body, 'nsfw')) out.nsfw = body.nsfw !== false;
  if (hasField(body, 'blacklist')) out.blacklist = normalizeBlacklist(body.blacklist);
  // Unknown ids are dropped by the settings store.
  if (hasField(body, 'disabledSites') && Array.isArray(body.disabledSites)) {
    out.disabledSites = body.disabledSites.map((id: unknown) => String(id));
  }
  return out;
}

function siteViews(includeConfiguration = true) {
  return BOORU_SITES.map((site) => ({
    id: site.id,
    name: site.name,
    aliases: site.aliases.filter((alias) => /^[a-z0-9]+$/.test(alias)),
    description: site.description,
    baseUrl: site.baseUrl,
    nsfwOnly: Boolean(site.nsfwOnly),
    safeOnly: Boolean(site.safeOnly),
    account: site.account || null,
    requiresCredentials: Boolean(site.requiresCredentials),
    ...(includeConfiguration ? { configured: isSiteConfigured(site) } : {}),
  }));
}

/** Everything about an account except the key itself. */
function accountView(accountId: string) {
  const account = findBooruAccount(accountId)!;
  const state = getBooruAccountState(accountId);
  return {
    ...account,
    state,
    user: state === 'stored' ? getBooruCredentials(accountId)?.user || '' : '',
    sites: BOORU_SITES.filter((site) => site.account === accountId).map((site) => site.name),
  };
}

function accountViews() {
  return BOORU_ACCOUNTS.map((account) => accountView(account.id));
}
