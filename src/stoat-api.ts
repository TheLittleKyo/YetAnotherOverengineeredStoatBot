/**
 * Direct-REST access helpers for the Stoat API.
 *
 * Most work goes through stoatbot.js, but several features need endpoints the
 * wrapper does not expose (role assignment, member fetches, permission edits)
 * and call `fetch` themselves. Those call sites all need the same two things:
 * the instance base URL and the session token the client authenticated with.
 * Nine modules used to carry identical private copies of this pair; they live
 * here now so token-shape handling stays consistent.
 */

/** Fallback instance used when the client does not report its own base URL. */
export const DEFAULT_API_URL = 'https://api.stoat.chat';

/**
 * Pull the bot's auth token off the client. stoatbot.js has stored it in three
 * different places across versions (and either as a bare string or wrapped in
 * an object), so all known shapes are probed before giving up.
 */
export function getClientToken(client: any): string | null {
  const rawToken = client?.token || client?.api?.authentication?.revolt || client?.api?.authentication?.rauth;
  if (!rawToken) return null;
  if (typeof rawToken === 'string') return rawToken;
  if (typeof rawToken === 'object' && typeof rawToken.token === 'string') return rawToken.token;
  return null;
}

/** Base URL for direct REST calls, without a trailing slash. */
export function getApiBaseUrl(source: any): string {
  return String(source?.options?.rest?.instanceURL || source?.api?.baseURL || DEFAULT_API_URL).replace(/\/+$/, '');
}

/**
 * Direct REST call against the Stoat API, authenticated as the running client.
 *
 * Used by the feature modules that need an endpoint stoatbot.js does not model
 * (member timeouts, ban removal, channel permission edits). Errors carry the
 * status and the API's own error type so a command can report something more
 * useful than "request failed".
 */
export async function stoatRequest(client: any, method: string, path: string, body?: unknown): Promise<any> {
  const token = getClientToken(client);
  if (!token) throw new Error('No bot token available for a direct API call.');
  const baseUrl = getApiBaseUrl(client);

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
      'Content-Type': 'application/json',
      'User-Agent': 'YetAnotherOverengineeredStoatBot',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text().catch(() => '');
  if (response.ok) {
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  let detail = response.statusText;
  try {
    detail = JSON.parse(text)?.type || detail;
  } catch {
    if (text) detail = text.slice(0, 200);
  }
  throw new Error(`API ${method} ${path} failed with status ${response.status}: ${detail}`);
}

/**
 * True when a stoatbot.js REST helper is missing rather than the request having
 * genuinely failed — the signal to retry the call through `stoatRequest`.
 */
export function shouldFallbackToRawRequest(error: any): boolean {
  const message = String(error?.message || error || '');
  return /is not a function|undefined|no method/i.test(message);
}
