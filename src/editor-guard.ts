/**
 * Shared request guard for the local editor HTTP servers (welcome / embed /
 * role / notify).
 *
 * These servers bind to 127.0.0.1 and have no authentication, so they rely on
 * two properties that this guard enforces:
 *
 *   1. DNS-rebinding protection — the `Host` header must be a loopback name.
 *      A malicious page can point a hostname it controls at 127.0.0.1, but it
 *      cannot forge the Host header to loopback for a request the browser
 *      believes is going to the attacker's origin.
 *   2. CSRF protection — mutating requests (POST/PUT/DELETE/PATCH) must be
 *      same-origin. We check `Sec-Fetch-Site` and, as a fallback, the `Origin`
 *      header. This blocks a background page in the operator's browser from
 *      silently POSTing config changes to localhost.
 */
import type { IncomingMessage } from 'http';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function extractHostname(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const value = String(hostHeader).trim();
  // IPv6 literal: [::1]:3030
  const v6 = value.match(/^\[([^\]]+)\]/);
  if (v6) return v6[1].toLowerCase();
  return value.split(':')[0].toLowerCase();
}

export function isEditorRequestAllowed(request: IncomingMessage): { ok: boolean; reason?: string } {
  const method = String(request.method || 'GET').toUpperCase();

  // 1. Host must be present AND loopback (DNS-rebinding protection) — applies to
  //    all methods. A missing Host is not a pass: HTTP/1.1 requires the header,
  //    so an omitted one only shows up in hand-rolled clients probing the port.
  const host = extractHostname(request.headers.host);
  if (!host) {
    return { ok: false, reason: 'missing Host header' };
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    return { ok: false, reason: `non-loopback Host: ${host}` };
  }

  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  if (!mutating) return { ok: true };

  // 2a. Sec-Fetch-Site is set by modern browsers and is not forgeable by page JS.
  const secFetchSite = request.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { ok: false, reason: `cross-site request (Sec-Fetch-Site: ${secFetchSite})` };
  }

  // 2b. Fallback for older browsers: Origin, if present, must be loopback.
  const origin = request.headers.origin;
  if (origin && origin !== 'null') {
    try {
      const originHost = new URL(origin).hostname.toLowerCase();
      if (!LOOPBACK_HOSTS.has(originHost)) {
        return { ok: false, reason: `cross-origin request (Origin: ${origin})` };
      }
    } catch {
      return { ok: false, reason: 'malformed Origin header' };
    }
  }

  return { ok: true };
}

/**
 * CSRF guard for the share-link (guest) path. The dashboard has already
 * authenticated the guest by token before this runs; here we only enforce that
 * a mutating request is same-origin — i.e. the `Origin` matches the request's
 * own `Host` (the tunnel hostname), not loopback. Unlike `isEditorRequestAllowed`
 * this does NOT require a loopback Host, because guest traffic legitimately
 * arrives on a public tunnel hostname.
 */
export function isSameOriginRequest(request: IncomingMessage): { ok: boolean; reason?: string } {
  const method = String(request.method || 'GET').toUpperCase();
  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  if (!mutating) return { ok: true };

  const secFetchSite = request.headers['sec-fetch-site'];
  if (typeof secFetchSite === 'string' && secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
    return { ok: false, reason: `cross-site request (Sec-Fetch-Site: ${secFetchSite})` };
  }

  const origin = request.headers.origin;
  if (origin && origin !== 'null') {
    const host = extractHostname(request.headers.host);
    try {
      const originHost = new URL(origin).hostname.toLowerCase();
      if (!host || originHost !== host) {
        return { ok: false, reason: `cross-origin request (Origin: ${origin})` };
      }
    } catch {
      return { ok: false, reason: 'malformed Origin header' };
    }
  }

  return { ok: true };
}
