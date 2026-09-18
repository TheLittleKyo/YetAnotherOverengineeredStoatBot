/**
 * Shared HTTP fetch helper for notification providers.
 * Adds a default User-Agent, timeout, and JSON/XML parsing helpers.
 */

import { lookup } from 'dns/promises';
import { isIP } from 'net';
import { env } from '../config.js';

const DEFAULT_UA = 'YetAnotherOverengineeredStoatBot-Notify/1.0 (Stoat.chat bot; +https://stoat.chat)';

const MAX_REDIRECTS = 5;

/**
 * SSRF guard. Returns true for IP literals that must never be reached from a
 * server-side fetch: loopback, private, link-local, unique-local, and other
 * reserved ranges (both IPv4 and IPv6, including IPv4-mapped IPv6).
 */
export function isPrivateAddress(ip: string): boolean {
  const address = String(ip || '').trim().toLowerCase();
  if (!address) return true;

  const kind = isIP(address);

  if (kind === 4) {
    const parts = address.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;            // this-network, private, loopback
    if (a === 169 && b === 254) return true;                       // link-local (cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true;              // private
    if (a === 192 && b === 168) return true;                       // private
    if (a === 100 && b >= 64 && b <= 127) return true;             // CGNAT
    if (a === 192 && b === 0) return true;                         // 192.0.0.0/24 + test-net
    if (a === 198 && (b === 18 || b === 19)) return true;          // benchmarking
    if (a >= 224) return true;                                     // multicast + reserved
    return false;
  }

  if (kind === 6) {
    const v = address.replace(/^\[|\]$/g, '');
    if (v === '::1' || v === '::') return true;                    // loopback / unspecified
    if (v.startsWith('fe80')) return true;                         // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true;     // unique-local
    if (v.startsWith('ff')) return true;                           // multicast
    // IPv4-mapped (::ffff:a.b.c.d) — validate the embedded v4.
    const mapped = v.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }

  // Not a valid IP literal — caller must resolve the hostname first.
  return true;
}

/**
 * Validate a URL for outbound fetch: must be http/https and must not resolve to
 * a private/loopback/link-local address. Set NOTIFY_ALLOW_PRIVATE_HOSTS=1 to
 * bypass (e.g. for an internal RSSHub on a trusted LAN).
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  if (env.notifyAllowPrivateHosts) return new URL(rawUrl);

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked URL scheme: ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, '');

  // Literal IP in the URL — check directly.
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Blocked request to private address');
    return parsed;
  }

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new Error('Blocked request to localhost');
  }

  // Resolve and reject if ANY resolved address is private (mitigates DNS rebinding).
  let records: Array<{ address: string }> = [];
  try {
    records = await lookup(host, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  if (records.length === 0) throw new Error(`DNS resolution failed for ${host}`);
  for (const record of records) {
    if (isPrivateAddress(record.address)) {
      throw new Error('Blocked request to private address');
    }
  }

  return parsed;
}

export interface FetchOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface FetchResult {
  ok: boolean;
  status: number;
  text: string;
  headers: Record<string, string>;
}

/**
 * `fetch` that follows redirects by hand so every hop is re-validated against
 * the SSRF guard — otherwise a public URL could 302 to http://169.254.169.254/.
 * An Authorization header is dropped once a redirect leaves the original
 * origin, so site credentials never reach a CDN or a third party.
 */
async function fetchPublic(url: string, init: RequestInit & { headers: Record<string, string> }): Promise<Response> {
  let currentUrl = url;
  let headers = init.headers;
  const origin = new URL(url).origin;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicHttpUrl(currentUrl);

    const response = await fetch(currentUrl, { ...init, headers, redirect: 'manual' });

    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      // The redirect body is never read; release the connection.
      await response.body?.cancel().catch(() => {});
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects');
      currentUrl = new URL(response.headers.get('location') as string, currentUrl).toString();
      if (new URL(currentUrl).origin !== origin) {
        headers = Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'authorization'));
      }
      continue;
    }
    return response;
  }
  throw new Error('No response');
}

export async function fetchUrl(url: string, options: FetchOptions = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);

  try {
    const headers: Record<string, string> = {
      'User-Agent': DEFAULT_UA,
      'Accept': '*/*',
      ...options.headers,
    };
    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    const response = await fetchPublic(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body,
      signal: controller.signal,
    });

    const text = await response.text();
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value;
    });

    return {
      ok: response.ok,
      status: response.status,
      text,
      headers: responseHeaders,
    };
  } catch (error: any) {
    return {
      ok: false,
      status: 0,
      text: '',
      headers: {},
    };
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchBytesResult {
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  /** Where the body came from after redirects. */
  url: string;
}

/**
 * Download a binary body through the same SSRF guard as `fetchUrl`, refusing
 * anything larger than `maxBytes` — by Content-Length up front, and again while
 * streaming for servers that omit or understate it. Throws on any failure.
 */
export async function fetchBytes(
  url: string,
  options: { headers?: Record<string, string>; timeoutMs?: number; maxBytes: number },
): Promise<FetchBytesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30000);

  try {
    const response = await fetchPublic(url, {
      method: 'GET',
      headers: { 'User-Agent': DEFAULT_UA, 'Accept': '*/*', ...options.headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > options.maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`File too large (${declared} bytes)`);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty response body');
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`File too large (over ${options.maxBytes} bytes)`);
      }
      chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return {
      bytes,
      contentType: String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),
      url: response.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson<T = any>(url: string, options: FetchOptions = {}): Promise<{ ok: boolean; status: number; data?: T; error?: string }> {
  const result = await fetchUrl(url, { ...options, headers: { 'Accept': 'application/json', ...options.headers } });
  if (!result.ok) {
    return { ok: false, status: result.status, error: `HTTP ${result.status}` };
  }
  try {
    return { ok: true, status: result.status, data: JSON.parse(result.text) as T };
  } catch (error: any) {
    return { ok: false, status: result.status, error: `JSON parse failed: ${error?.message || error}` };
  }
}

/**
 * Minimal RSS/Atom XML parser. Extracts entries with guid, title, link, pubDate.
 * Works for both RSS 2.0 (<item>) and Atom 1.0 (<entry>).
 */
export interface FeedEntry {
  guid: string;
  title?: string;
  url?: string;
  timestamp?: string;
  content?: string;
  author?: string;
}

export function parseFeed(xml: string): FeedEntry[] {
  const entries: FeedEntry[] = [];

  // Atom: <entry>...</entry>
  const atomEntries = xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const block of atomEntries) {
    const guid = extractTag(block, 'id') || extractAttr(block, 'link', 'href') || '';
    const title = extractTag(block, 'title');
    const link = extractAttr(block, 'link', 'href') || extractTag(block, 'link');
    const published = extractTag(block, 'published') || extractTag(block, 'updated');
    const content = extractTag(block, 'content') || extractTag(block, 'summary');
    const author = extractTag(block, 'name'); // inside <author>
    if (guid || link) {
      entries.push({ guid: guid || link || '', title, url: link, timestamp: published, content, author });
    }
  }

  // RSS 2.0: <item>...</item>
  const rssItems = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const block of rssItems) {
    const guid = extractTag(block, 'guid') || extractTag(block, 'link') || '';
    const title = extractTag(block, 'title');
    const link = extractTag(block, 'link');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date');
    const content = extractTag(block, 'description') || extractTag(block, 'content:encoded');
    const author = extractTag(block, 'dc:creator') || extractTag(block, 'author');
    if (guid || link) {
      entries.push({ guid: guid || link || '', title, url: link, timestamp: pubDate, content, author });
    }
  }

  return entries;
}

function extractTag(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(re);
  if (!match) return undefined;
  return decodeEntities(match[1].trim());
}

function extractAttr(xml: string, tag: string, attr: string): string | undefined {
  const re = new RegExp(`<${tag}[^>]*?\\s${attr}=["']([^"']+)["']`, 'i');
  const match = xml.match(re);
  return match ? decodeEntities(match[1]) : undefined;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * Parse a date string that might be ISO 8601 or RFC 822.
 * Returns a Date or null.
 */
export function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isFinite(d.getTime())) return d;
  return null;
}
