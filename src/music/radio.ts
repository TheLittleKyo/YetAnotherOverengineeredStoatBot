import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { assertPublicHttpUrl, isPrivateAddress } from '../notifications/http.js';
import { sleep } from '../async-utils.js';
import { debug } from '../logger.js';
import type { RadioInfo, Requester, ResolveResult, Track } from './types.js';

/**
 * Internet radio in every form station links come in:
 *
 * - Streams: Icecast/SHOUTcast over HTTP(S) (also written `icy://`), HLS
 *   `.m3u8`, DASH `.mpd`, RTSP, RTMP and Windows Media (`mms://`).
 * - Playlists pointing at streams: `.pls`, `.m3u`, `.asx`/`.wax`/`.wvx`,
 *   `.xspf`, `.ram`/`.rpm` (RealAudio), `.smil`, `.wpl`, `.b4s` (Winamp),
 *   `.qtl` (QuickTime) and `.strm` (Kodi).
 *
 * An HTTP link is probed once when queued: redirects are followed hop by hop
 * through the SSRF guard, and the first bytes of the body decide what it is
 * (servers mislabel playlists as audio and audio as `text/plain` all the time).
 * Playlists are unwrapped; ICY headers give the station name, genre and
 * bitrate. `fetchNowPlaying` reads the in-band ICY metadata for the song on air.
 */

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

/**
 * Sent to radio servers. SHOUTcast redirects anything that looks like a browser
 * ("Mozilla") to its HTML status page, and some CDNs send VLC to an `icyx://`
 * address; a plain client name gets the stream everywhere.
 */
export const RADIO_USER_AGENT = 'YetAnotherOverengineeredStoatBot-Music/1.0';

/** Where users can look up a station's direct stream links (shown in help and errors). */
export const STREAM_DIRECTORY_URL = 'https://streamurl.link/';

const PROBE_TIMEOUT_MS = 10_000;
const SNIFF_BYTES = 2048;
const MAX_PLAYLIST_BYTES = 256 * 1024;
const MAX_PLAYLIST_DEPTH = 3;
const MAX_REDIRECTS = 5;
/** Largest ICY metadata interval we are willing to read past to reach the title. */
const MAX_ICY_METAINT = 512 * 1024;
const NOW_PLAYING_TTL_MS = 15_000;

/** Stream protocols ffmpeg plays directly, besides HTTP(S). */
const STREAM_SCHEMES = new Set(['rtsp:', 'rtsps:', 'rtmp:', 'rtmps:', 'rtmpt:', 'rtmpts:', 'rtmpe:', 'mmsh:', 'mmst:']);

// ── Links ──────────────────────────────────────────────────────────────────

/**
 * Normalize a radio link from a message: `icy://`/`icyx://` become HTTP,
 * `mms://` becomes `mmsh://` (the HTTP flavour ffmpeg speaks). Returns null for
 * anything that is not a playable network address, and throws with an
 * explanation for protocols that exist but cannot be played.
 */
export function extractRadioUrl(input: string): string | null {
  const text = String(input || '').trim().replace(/^<(.+)>$/, '$1');
  const match = text.match(/^([a-z][a-z0-9+.-]*):\/\/\S+$/i);
  if (!match) return null;
  const scheme = match[1].toLowerCase();
  let rewritten = text;
  if (scheme === 'icy' || scheme === 'icyx') rewritten = `http${text.slice(scheme.length)}`;
  else if (scheme === 'mms') rewritten = `mmsh${text.slice(scheme.length)}`;
  else if (scheme === 'pnm') throw new Error('`pnm://` is RealNetworks\' old protocol, which nothing plays any more. Look for the station\'s MP3/AAC link.');
  else if (['udp', 'rtp', 'srt', 'file', 'ftp', 'sftp', 'smb'].includes(scheme)) {
    throw new Error(`\`${scheme}://\` links are not supported. Use the station's HTTP, HLS, RTSP or RTMP stream link.`);
  }
  let url: URL;
  try {
    url = new URL(rewritten);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && !STREAM_SCHEMES.has(url.protocol)) return null;
  if (!url.hostname) return null;
  return url.toString();
}

export function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export type LinkKind = 'm3u' | 'pls' | 'xml' | 'lines' | 'dash';

/** What a link is by its content type or extension alone (before reading the body). */
export function playlistKind(contentType: string, url: string): LinkKind | null {
  const type = String(contentType || '').toLowerCase();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    // keep empty
  }
  if (type.includes('dash+xml') || path.endsWith('.mpd')) return 'dash';
  if (type.includes('scpls') || path.endsWith('.pls')) return 'pls';
  if (type.includes('mpegurl') || /\.m3u8?$/.test(path)) return 'm3u';
  if (/xspf|x-ms-(wax|wvx)|smil|ms-wpl|x-quicktimeplayer/.test(type) || /\.(asx|wax|wvx|xspf|smil?|wpl|b4s|qtl)$/.test(path)) return 'xml';
  if (/x-pn-realaudio(?!-plugin)|vnd\.rn-realaudio/.test(type) || /\.(ram|rpm|strm)$/.test(path)) return 'lines';
  return null;
}

/** A link that is obviously a radio playlist or manifest, before any request is made. */
export function isRadioPlaylistUrl(url: string): boolean {
  return playlistKind('', url) !== null;
}

export type SniffedKind = 'm3u' | 'pls' | 'xml' | 'lines' | 'dash' | 'html' | 'text' | 'audio';

/**
 * Decide from the first bytes of a response what it really is. Text formats
 * are recognized by their markers; anything binary is audio, and readable text
 * that matches no format is `text` (an error page, "stream offline", …).
 */
export function sniffBody(head: Uint8Array): SniffedKind {
  const bytes = Buffer.from(head);
  if (bytes.length === 0) return 'audio';
  // Binary content (MP3/AAC/Ogg/FLAC/NSV/ASF frames) is audio.
  const sample = bytes.subarray(0, Math.min(bytes.length, 512));
  let control = 0;
  for (const byte of sample) if (byte === 0 || (byte < 9) || (byte > 13 && byte < 32)) control++;
  if (control > sample.length * 0.05) return 'audio';

  const text = sample.toString('utf8').replace(/^﻿/, '').trimStart();
  const lower = text.toLowerCase();
  // Stream proxies (Centova's stream.php) forward the station's own response header before the audio.
  if (/^(icy \d{3}|http\/\d(\.\d)? \d{3})/.test(lower)) return 'audio';
  if (lower.startsWith('#extm3u') || lower.includes('#ext-x-') || lower.startsWith('#extinf')) return 'm3u';
  if (lower.startsWith('[playlist]')) return 'pls';
  if (/^(<\?xml[^>]*>\s*)?<mpd[\s>]/.test(lower)) return 'dash';
  if (/^(<!doctype html|<html|<head|<body)/.test(lower)) return 'html';
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<(asx|playlist|smil|winampxml|\?wpl|\?quicktime|embed|kpl)/.test(lower) || lower.startsWith('<?xml')) {
    return 'xml';
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (lines.length > 0 && lines.every((line) => /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(line) || line === '--stop--')) return 'lines';
  return 'text';
}

// ── Parsing ────────────────────────────────────────────────────────────────

/** `File1=http://…` entries of a `.pls` playlist, in their numbered order. */
export function parsePls(text: string): string[] {
  const entries: Array<[number, string]> = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^File(\d+)\s*=\s*(\S+)$/i);
    if (match) entries.push([Number(match[1]), match[2]]);
  }
  return entries.sort((a, b) => a[0] - b[0]).map(([, url]) => url);
}

/**
 * Stream URLs of a plain `.m3u` playlist. `hls` is true for an HLS playlist
 * (`#EXT-X-…` tags), which ffmpeg plays directly instead of being unwrapped.
 */
export function parseM3u(text: string): { hls: boolean; urls: string[] } {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const hls = lines.some((line) => /^#EXT-X-/i.test(line));
  const urls = lines.filter((line) => !line.startsWith('#'));
  return { hls, urls };
}

/** One URL per line: RealAudio `.ram`/`.rpm` and Kodi `.strm` files. */
export function parseLinePlaylist(text: string): string[] {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && line !== '--stop--' && /^[a-z][a-z0-9+.-]*:\/\//i.test(line));
}

/**
 * Entry URLs of the XML playlist family: ASX/WAX/WVX (`<ref href>`,
 * `<entryref href>`), XSPF (`<location>`), SMIL and WPL (`<audio|video|media|ref src>`),
 * Winamp B4S (`Playstring="file:…"`) and QuickTime QTL (`<embed src>`).
 */
export function parseXmlPlaylist(text: string): string[] {
  const body = String(text || '');
  const attr = (tags: string, name: string) =>
    [...body.matchAll(new RegExp(`<(?:${tags})\\s[^>]*?\\b${name}\\s*=\\s*["']([^"']+)["']`, 'gi'))].map((m) => m[1]);
  const urls = [
    ...attr('ref|entryref', 'href'),
    ...[...body.matchAll(/<location>\s*([^<\s]+)\s*<\/location>/gi)].map((m) => m[1]),
    ...attr('audio|video|media|ref|embed|source|stream', 'src'),
    ...attr('entry', 'playstring').map((value) => value.replace(/^file:/i, '')),
    ...attr('embed', 'qtnext\\d*').map((value) => value.replace(/^<|>T<[^>]*>$/g, '')),
  ];
  return [...new Set(urls.map((url) => url.replace(/&amp;/g, '&').trim()))];
}

export function parsePlaylist(kind: Exclude<SniffedKind, 'html' | 'text' | 'audio' | 'dash'>, text: string): { hls: boolean; urls: string[] } {
  if (kind === 'm3u') return parseM3u(text);
  if (kind === 'pls') return { hls: false, urls: parsePls(text) };
  if (kind === 'lines') return { hls: false, urls: parseLinePlaylist(text) };
  return { hls: false, urls: parseXmlPlaylist(text) };
}

/** `StreamTitle='Artist - Song';StreamUrl='';` → `Artist - Song`. */
export function parseIcyStreamTitle(metadata: string): string | null {
  const match = String(metadata || '').match(/StreamTitle='((?:[^']|'(?!;))*)';/);
  const title = match?.[1]?.trim();
  return title ? title : null;
}

/** ICY text arrives as raw bytes; most stations send UTF-8, some Latin-1. */
export function fixIcyEncoding(value: string): string {
  const utf8 = Buffer.from(value, 'latin1').toString('utf8');
  return utf8.includes('�') ? value : utf8;
}

/** A header value, re-decoded and stripped of the HTML some servers put in it. */
export function decodeIcyText(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const text = fixIcyEncoding(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return text || undefined;
}

export function radioInfoFromHeaders(headers: { get(name: string): string | null }): RadioInfo {
  const homepage = decodeIcyText(headers.get('icy-url'));
  const bitrate = Number(String(headers.get('icy-br') || '').split(',')[0]);
  return {
    name: decodeIcyText(headers.get('icy-name')),
    genre: decodeIcyText(headers.get('icy-genre')),
    description: decodeIcyText(headers.get('icy-description')),
    homepage: homepage && /^https?:\/\//i.test(homepage) ? homepage : undefined,
    bitrate: Number.isFinite(bitrate) && bitrate > 0 ? bitrate : undefined,
  };
}

export function radioTrack(input: { pageUrl: string; streamUrl: string; info: RadioInfo; requester: Requester }): Track {
  const stream = new URL(input.streamUrl);
  const fallbackName = `${stream.hostname}${stream.pathname === '/' ? '' : stream.pathname}`;
  return {
    title: input.info.name || fallbackName,
    url: input.info.homepage || (isHttpUrl(input.pageUrl) ? input.pageUrl : ''),
    source: 'radio',
    author: input.info.genre || stream.hostname,
    duration: null,
    isLive: true,
    requester: input.requester,
    playbackUrl: input.streamUrl,
    radio: input.info,
  };
}

/**
 * fetch is stricter than ffmpeg with radio servers. Its HTTP parser rejects old
 * SHOUTcast "ICY 200 OK" status lines and bare-LF line endings, and it refuses
 * certificates with an incomplete chain, which browsers repair and ffmpeg does
 * not check. The stream can still play, only without station details.
 */
export function isLenientServerError(error: any): boolean {
  const code = String(error?.cause?.code || '');
  const detail = String(error?.cause?.message || '');
  if (code.startsWith('HPE_') || /does not match the HTTP\/1\.1 protocol|Parse Error|invalid (status|header)/i.test(detail)) return true;
  return /^(UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)?|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|CERT_HAS_EXPIRED|ERR_TLS_CERT_ALTNAME_INVALID)$/.test(code);
}

// ── Network ────────────────────────────────────────────────────────────────

/** Some resolvers answer "try again" under load; a couple of quick retries hide that. */
async function withDnsRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 2 || !/DNS resolution failed|EAI_AGAIN|ENOTFOUND/i.test(String(error?.message || error?.code || ''))) throw error;
      await sleep(400 * (attempt + 1));
    }
  }
}

/** The SSRF check for non-HTTP stream links, which ffmpeg connects to directly. */
async function assertPublicStreamHost(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('Blocked request to private address');
    return;
  }
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Blocked request to localhost');
  const records = await withDnsRetry(async () => {
    try {
      return await lookup(host, { all: true });
    } catch {
      throw new Error(`DNS resolution failed for ${host}`);
    }
  });
  if (records.length === 0 || records.some((record) => isPrivateAddress(record.address))) {
    throw new Error(records.length === 0 ? `DNS resolution failed for ${host}` : 'Blocked request to private address');
  }
}

/** GET with redirects followed manually so every hop passes the private-address check. */
async function openPublic(url: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ response: Response | null; url: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await withDnsRetry(() => assertPublicHttpUrl(current));
    const response = await fetch(current, {
      headers: { 'User-Agent': RADIO_USER_AGENT, Accept: '*/*', ...headers },
      redirect: 'manual',
      signal,
    });
    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      await response.body?.cancel().catch(() => {});
      const next = extractRadioUrl(new URL(location, current).toString());
      if (!next) throw new Error('That radio link redirects somewhere that is not a stream.');
      // A redirect onto RTSP/RTMP/MMS hands over to ffmpeg; report it as the final address.
      if (!isHttpUrl(next)) return { response: null, url: next };
      current = next;
      continue;
    }
    return { response, url: current };
  }
  throw new Error('That radio link redirects too many times.');
}

async function readBytes(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number, initial: Buffer = Buffer.alloc(0)): Promise<{ bytes: Buffer; done: boolean }> {
  const chunks: Uint8Array[] = [initial];
  let size = initial.length;
  let done = false;
  while (size < maxBytes) {
    const result = await reader.read();
    if (result.done) {
      done = true;
      break;
    }
    chunks.push(result.value);
    size += result.value.length;
  }
  return { bytes: Buffer.concat(chunks), done };
}

/**
 * Probe a station link and return it as a live track. Playlists are unwrapped
 * (trying up to three of their entries); web pages are rejected with a hint.
 */
export async function resolveRadio(url: string, requester: Requester): Promise<ResolveResult> {
  const normalized = extractRadioUrl(url);
  if (!normalized) throw new Error('That is not a radio stream link.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS * 2);
  try {
    return { tracks: [await probe(normalized, normalized, requester, 0, controller.signal)] };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The radio station did not answer in time.');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function probe(url: string, pageUrl: string, requester: Requester, depth: number, signal: AbortSignal): Promise<Track> {
  if (depth > MAX_PLAYLIST_DEPTH) throw new Error('That radio playlist nests too many other playlists.');

  if (!isHttpUrl(url)) {
    // RTSP/RTMP/MMS cannot be inspected with fetch; check the host and let ffmpeg connect.
    await assertPublicStreamHost(url);
    return radioTrack({ pageUrl, streamUrl: url, info: {}, requester });
  }

  let opened: { response: Response | null; url: string };
  try {
    opened = await openPublic(url, { 'Icy-MetaData': '0' }, signal);
  } catch (error) {
    if (!signal.aborted && isLenientServerError(error)) {
      debug('music:radio', () => `fetch could not parse ${url} (${error?.cause?.message || error}); letting ffmpeg try`);
      return radioTrack({ pageUrl, streamUrl: url, info: {}, requester });
    }
    if (signal.aborted || !(error instanceof TypeError)) throw error;
    const code = String((error.cause as any)?.code || '');
    throw new Error(`Could not reach that radio station${code ? ` (${code})` : ''}.`);
  }
  if (!opened.response) return probe(opened.url, pageUrl, requester, depth + 1, signal);

  const { response } = opened;
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`The radio station answered HTTP ${response.status}.`);
  }

  const headerKind = playlistKind(contentType, opened.url);
  if (headerKind === 'dash') {
    await response.body?.cancel().catch(() => {});
    return radioTrack({ pageUrl, streamUrl: opened.url, info: { ...radioInfoFromHeaders(response.headers), manifest: 'dash' }, requester });
  }

  const reader = response.body?.getReader();
  const head = reader ? await readBytes(reader, SNIFF_BYTES) : { bytes: Buffer.alloc(0), done: true };
  // The body decides: servers mislabel playlists as audio and audio as text.
  let sniffed = sniffBody(head.bytes);
  if (head.bytes.length === 0) {
    await reader?.cancel().catch(() => {});
    throw new Error(headerKind ? 'That radio playlist is empty.' : 'The radio station sent no data.');
  }
  // Unrecognized text under a playlist type or extension (a bare .m3u, an odd .asx) is parsed as that playlist;
  // under an audio type it goes to ffmpeg, which skips junk before the first audio frame.
  if (sniffed === 'text' && headerKind) sniffed = headerKind;
  else if (sniffed === 'text' && /^(audio\/|video\/|application\/(ogg|octet-stream))/i.test(contentType)) sniffed = 'audio';

  if (sniffed === 'audio') {
    await reader?.cancel().catch(() => {});
    return radioTrack({ pageUrl, streamUrl: opened.url, info: radioInfoFromHeaders(response.headers), requester });
  }

  if (sniffed === 'text') {
    await reader?.cancel().catch(() => {});
    const snippet = head.bytes.toString('utf8').replace(/\s+/g, ' ').trim().slice(0, 80);
    throw new Error(`That link does not serve audio (it sent \`${contentType.split(';')[0] || 'text'}\`: "${snippet}").`);
  }

  if (sniffed === 'html') {
    await reader?.cancel().catch(() => {});
    throw new Error(
      'That link is a web page, not a stream. Use the station\'s direct stream link ' +
        `(it usually ends in \`.mp3\`, \`.aac\`, \`.m3u\`, \`.pls\`, \`.m3u8\` or \`/stream\`); <${STREAM_DIRECTORY_URL}> lists them.`,
    );
  }

  if (sniffed === 'dash') {
    await reader?.cancel().catch(() => {});
    return radioTrack({ pageUrl, streamUrl: opened.url, info: { ...radioInfoFromHeaders(response.headers), manifest: 'dash' }, requester });
  }

  const rest = head.done || !reader ? head : await readBytes(reader, MAX_PLAYLIST_BYTES, head.bytes);
  await reader?.cancel().catch(() => {});
  const text = rest.bytes.subarray(0, MAX_PLAYLIST_BYTES).toString('utf8');
  const playlist = parsePlaylist(sniffed, text);
  if (playlist.hls) {
    return radioTrack({ pageUrl, streamUrl: opened.url, info: { ...radioInfoFromHeaders(response.headers), manifest: 'hls' }, requester });
  }
  return firstPlayable(playlist.urls, opened.url, pageUrl, requester, depth, signal);
}

async function firstPlayable(
  entries: string[],
  baseUrl: string,
  pageUrl: string,
  requester: Requester,
  depth: number,
  signal: AbortSignal,
): Promise<Track> {
  let lastError: unknown = new Error('That radio playlist has no streams in it.');
  let tried = 0;
  for (const entry of entries) {
    if (tried >= 3) break;
    let next: string | null;
    try {
      next = extractRadioUrl(new URL(entry, baseUrl).toString());
    } catch (error) {
      lastError = error;
      continue;
    }
    if (!next) continue;
    tried++;
    try {
      return await probe(next, pageUrl, requester, depth + 1, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

const nowPlayingCache = new Map<string, { title: string | null; at: number }>();

/**
 * The song on air, from the stream's in-band ICY metadata (`StreamTitle`), or
 * null when the station does not send any. Cached briefly per stream.
 */
export async function fetchNowPlaying(track: Track): Promise<string | null> {
  const url = track.playbackUrl;
  if (!url || !isHttpUrl(url) || track.radio?.manifest) return null;
  const cached = nowPlayingCache.get(url);
  if (cached && Date.now() - cached.at < NOW_PLAYING_TTL_MS) return cached.title;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let title: string | null = null;
  try {
    const { response } = await openPublic(url, { 'Icy-MetaData': '1' }, controller.signal);
    const metaint = Number(response?.headers.get('icy-metaint'));
    const reader = response?.body?.getReader();
    if (reader && response.ok && Number.isInteger(metaint) && metaint > 0 && metaint <= MAX_ICY_METAINT) {
      title = await readIcyTitle(reader, metaint);
    }
    await reader?.cancel().catch(() => {});
  } catch (error) {
    debug('music:radio', () => `now-playing lookup failed for ${url}: ${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
  nowPlayingCache.set(url, { title, at: Date.now() });
  if (nowPlayingCache.size > 200) nowPlayingCache.delete(nowPlayingCache.keys().next().value);
  return title;
}

/** Skip `metaint` audio bytes, then read the length-prefixed metadata block that follows. */
export async function readIcyTitle(reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> }, metaint: number): Promise<string | null> {
  let buffer = Buffer.alloc(0);
  const need = async (bytes: number) => {
    while (buffer.length < bytes) {
      const { done, value } = await reader.read();
      if (done || !value) return false;
      buffer = Buffer.concat([buffer, value]);
    }
    return true;
  };
  if (!(await need(metaint + 1))) return null;
  const length = buffer[metaint] * 16;
  if (length === 0) return null;
  if (!(await need(metaint + 1 + length))) return null;
  const block = buffer.subarray(metaint + 1, metaint + 1 + length);
  const title = parseIcyStreamTitle(block.toString('latin1').replace(/\0+$/, ''));
  return title ? fixIcyEncoding(title) : null;
}
