import vm from 'node:vm';
import { Readable } from 'node:stream';
import { Innertube, Log, Platform, UniversalCache } from 'youtubei.js';
import { debug } from '../logger.js';
import type { Requester, Track } from './types.js';

/**
 * YouTube fast path through youtubei.js (an in-process InnerTube client).
 * Search, metadata and audio URLs come back in a few hundred milliseconds,
 * against 2-8 s for spawning yt-dlp. Anything that fails here falls back to
 * yt-dlp, and a circuit breaker stops trying after repeated failures so a
 * YouTube-side change does not add latency to every request.
 */

Log.setLevel(Log.Level.NONE);

/**
 * youtubei.js needs a JavaScript evaluator to run the deciphering code it
 * extracts from YouTube's player. A fresh V8 context keeps that code out of
 * the bot's globals and puts a time limit on it. It is not a security
 * sandbox (node:vm can be escaped); the trust placed in it is the same as in
 * the YouTube player script itself.
 */
Platform.shim.eval = (data) =>
  vm.runInNewContext(
    `(function(){\n${data.output}\n})()`,
    { URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa },
    { timeout: 5_000 },
  );

/** The player script rotates; a long-lived session eventually deciphers with a stale one. */
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

let session: Promise<Innertube> | null = null;
let sessionCreatedAt = 0;

function getSession(): Promise<Innertube> {
  if (!session || Date.now() - sessionCreatedAt > SESSION_TTL_MS) {
    sessionCreatedAt = Date.now();
    const created = Innertube.create({
      retrieve_player: true,
      generate_session_locally: true,
      cache: new UniversalCache(false),
    });
    session = created;
    created.catch(() => {
      if (session === created) session = null;
    });
  }
  return session;
}

export function resetYouTubeSession() {
  session = null;
}

/** Create the session ahead of the first `play` so it does not pay the setup cost. */
export function warmUpYouTube() {
  getSession().catch((error) => debug('music:youtube', () => `warm-up failed: ${error?.message || error}`));
}

// ── Failure handling ───────────────────────────────────────────────────────

/** The video itself cannot be played (private, removed, region-locked…). yt-dlp would fail too. */
export class YouTubeUnavailableError extends Error {}

/** Live streams are HLS segments; youtubei.js cannot hand them over as one stream. */
export class YouTubeLiveError extends Error {}

/**
 * YouTube refused the direct media URL. Label music and YouTube Music tracks
 * are only served over SABR with a proof-of-origin token, which plain
 * InnerTube clients cannot do (checked 2026-09); yt-dlp can.
 */
export class YouTubeRestrictedError extends Error {}

/**
 * youtubei.js throws an InnertubeError carrying the playability status when a
 * video cannot be played. A bot check also reports LOGIN_REQUIRED, but that is
 * about us, not the video, so yt-dlp should still get a chance.
 */
export function asUnavailable(error: any): YouTubeUnavailableError | null {
  const status = error?.info?.status;
  const message = String(error?.message || '');
  if (/not a bot/i.test(message) || /not a bot/i.test(String(error?.info?.reason || ''))) return null;
  if (status && status !== 'OK') return new YouTubeUnavailableError(message || String(error?.info?.reason || status));
  if (/video (is )?unavailable|private video|has been removed|no longer available/i.test(message)) {
    return new YouTubeUnavailableError(message);
  }
  return null;
}

export class CircuitBreaker {
  private failures = 0;
  private openUntil = 0;

  constructor(
    readonly name: string,
    readonly threshold = 3,
    readonly cooldownMs = 15 * 60 * 1000,
  ) {}

  get available(): boolean {
    return Date.now() >= this.openUntil;
  }

  success() {
    this.failures = 0;
  }

  failure(error: unknown) {
    this.failures += 1;
    if (this.failures < this.threshold) return;
    this.failures = 0;
    this.openUntil = Date.now() + this.cooldownMs;
    resetYouTubeSession();
    console.warn(
      `⚠️ youtubei.js ${this.name} failed ${this.threshold} times in a row; using yt-dlp only for ` +
        `${Math.round(this.cooldownMs / 60_000)} minutes. Last error: ${(error as any)?.message || error}`,
    );
  }
}

export const metadataBreaker = new CircuitBreaker('lookups');
export const streamBreaker = new CircuitBreaker('streaming');

// ── URLs ───────────────────────────────────────────────────────────────────

const VIDEO_ID = /^[\w-]{11}$/;

export type YouTubeRef = { videoId: string | null; playlistId: string | null; music: boolean };

/** Recognize youtube.com / youtu.be / music.youtube.com links. */
export function parseYouTubeUrl(input: string): YouTubeRef | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  const isShort = host === 'youtu.be';
  if (!isShort && !/(^|\.)youtube\.com$/.test(host) && !/(^|\.)youtube-nocookie\.com$/.test(host)) return null;

  const segments = url.pathname.split('/').filter(Boolean);
  let videoId: string | null = null;
  if (isShort) videoId = segments[0] || null;
  else if (segments[0] === 'watch') videoId = url.searchParams.get('v');
  else if (['shorts', 'live', 'embed', 'v'].includes(segments[0])) videoId = segments[1] || null;

  return {
    videoId: videoId && VIDEO_ID.test(videoId) ? videoId : null,
    playlistId: url.searchParams.get('list') || null,
    music: host === 'music.youtube.com',
  };
}

// ── Mapping ────────────────────────────────────────────────────────────────

/** `3:55` → 235, `1:02:05` → 3725. */
export function parseClock(text: string): number | null {
  const parts = String(text || '').trim().split(':');
  if (parts.length < 2 || parts.some((part) => !/^\d+$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

function text(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value.text === 'string') return value.text;
  return typeof value.toString === 'function' ? String(value.toString()) : '';
}

function largestThumbnail(list: any): string | undefined {
  const items = Array.isArray(list) ? list : [];
  const best = [...items].filter((t) => typeof t?.url === 'string').sort((a, b) => (b.width || 0) - (a.width || 0))[0];
  return best?.url;
}

function videoThumbnail(videoId: string) {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

function absoluteChannelUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return url.startsWith('/') ? `https://www.youtube.com${url}` : url;
}

function baseTrack(videoId: string, requester: Requester, music = false): Pick<Track, 'url' | 'source' | 'requester' | 'playbackUrl' | 'thumbnail'> {
  const url = music ? `https://music.youtube.com/watch?v=${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
  return { url, source: 'youtube', requester, playbackUrl: url, thumbnail: videoThumbnail(videoId) };
}

/** A search result / playlist entry node (`Video`, `PlaylistVideo`, or the newer `LockupView`). */
export function trackFromListNode(node: any, requester: Requester): Track | null {
  if (!node) return null;

  if (node.type === 'LockupView') {
    const videoId = node.content_id;
    if (!VIDEO_ID.test(String(videoId || '')) || (node.content_type && node.content_type !== 'VIDEO')) return null;
    const badges = (node.content_image?.overlays || []).flatMap((overlay) => overlay?.badges || []);
    const badge = badges.map((b) => String(b?.text || '')).find(Boolean) || '';
    const author = text(node.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0]?.text);
    return {
      ...baseTrack(videoId, requester),
      title: text(node.metadata?.title) || 'Unknown title',
      author: author || 'Unknown',
      duration: parseClock(badge),
      isLive: /live/i.test(badge),
    };
  }

  const videoId = node.video_id || node.id;
  if (!VIDEO_ID.test(String(videoId || ''))) return null;
  if (node.is_playable === false) return null;
  const seconds = Number(node.duration?.seconds);
  return {
    ...baseTrack(videoId, requester),
    title: text(node.title) || 'Unknown title',
    author: node.author?.name || 'Unknown',
    authorUrl: absoluteChannelUrl(node.author?.url),
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    isLive: Boolean(node.is_live),
  };
}

/** A YouTube Music `song` search result. */
export function trackFromMusicNode(node: any, requester: Requester): Track | null {
  const videoId = node?.id || node?.video_id;
  if (!VIDEO_ID.test(String(videoId || ''))) return null;
  const artists = (Array.isArray(node.artists) ? node.artists : []).map((a) => a?.name).filter(Boolean);
  const seconds = Number(node.duration?.seconds);
  return {
    ...baseTrack(videoId, requester, true),
    title: text(node.title) || 'Unknown title',
    author: artists.join(', ') || node.author?.name || 'YouTube Music',
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    isLive: false,
    thumbnail: largestThumbnail(node.thumbnails) || videoThumbnail(videoId),
  };
}

// ── Lookups ────────────────────────────────────────────────────────────────

export async function searchVideos(query: string, limit: number, requester: Requester): Promise<Track[]> {
  const yt = await getSession();
  const results: any = await yt.search(query, { type: 'video' });
  return (results.videos || [])
    .map((node) => trackFromListNode(node, requester))
    .filter(Boolean)
    .slice(0, limit);
}

export async function searchSongs(query: string, limit: number, requester: Requester): Promise<Track[]> {
  const yt = await getSession();
  const results: any = await yt.music.search(query, { type: 'song' });
  return (results.songs?.contents || [])
    .map((node) => trackFromMusicNode(node, requester))
    .filter(Boolean)
    .slice(0, limit);
}

export async function getVideo(videoId: string, requester: Requester, music = false): Promise<Track> {
  const yt = await getSession();
  let info: any;
  try {
    info = await yt.getBasicInfo(videoId);
  } catch (error) {
    throw asUnavailable(error) || error;
  }
  const status = info.playability_status?.status;
  if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
    throw new YouTubeUnavailableError(info.playability_status?.reason || `This video is not playable (${status}).`);
  }
  const details = info.basic_info || {};
  const seconds = Number(details.duration);
  return {
    ...baseTrack(videoId, requester, music),
    title: details.title || 'Unknown title',
    author: details.channel?.name || details.author || 'Unknown',
    authorUrl: details.channel?.url,
    duration: Number.isFinite(seconds) && seconds > 0 ? seconds : null,
    isLive: Boolean(details.is_live),
  };
}

export async function getPlaylist(
  playlistId: string,
  maxTracks: number,
  requester: Requester,
): Promise<{ title: string; tracks: Track[] }> {
  const yt = await getSession();
  let page: any = await yt.getPlaylist(playlistId);
  const title = text(page.info?.title) || 'YouTube playlist';
  const tracks: Track[] = [];
  const collect = () => {
    for (const node of page.videos || []) {
      const track = trackFromListNode(node, requester);
      if (track) tracks.push(track);
    }
  };
  collect();
  for (let pages = 0; page.has_continuation && tracks.length < maxTracks && pages < 50; pages++) {
    page = await page.getContinuation();
    collect();
  }
  return { title, tracks: tracks.slice(0, maxTracks) };
}

// ── Audio ──────────────────────────────────────────────────────────────────

/** Clients whose audio URLs play without a proof-of-origin token (checked 2026-09). */
const STREAM_CLIENTS = ['IOS', 'MWEB', 'TV_SIMPLY', 'YTMUSIC'] as const;
let preferredStreamClient = 0;
const FIRST_CHUNK_TIMEOUT_MS = 8_000;

/**
 * Open the best audio-only format as a byte stream (usually m4a). Clients are
 * tried until one delivers its first chunk. A refused media URL ends the
 * search at once: when one client gets it, they all do, and yt-dlp is the
 * faster way out.
 */
export async function openAudioStream(videoId: string): Promise<Readable> {
  const yt = await getSession();
  const order = [preferredStreamClient, ...STREAM_CLIENTS.map((_, i) => i).filter((i) => i !== preferredStreamClient)];
  let lastError: unknown = null;
  let allUnavailable = true;

  for (const index of order) {
    const client = STREAM_CLIENTS[index];
    try {
      let info: any;
      try {
        info = await yt.getBasicInfo(videoId, { client });
      } catch (error) {
        throw asUnavailable(error) || error;
      }
      if (info.basic_info?.is_live || info.basic_info?.is_post_live_dvr) throw new YouTubeLiveError('live stream');
      const status = info.playability_status?.status;
      if (status && status !== 'OK') {
        throw asUnavailable({ info: info.playability_status, message: info.playability_status?.reason }) ||
          new Error(info.playability_status?.reason || status);
      }
      let web: ReadableStream<Uint8Array>;
      try {
        web = await info.download({ type: 'audio', quality: 'best', client });
      } catch (error) {
        throw isRefusedMedia(error) ? new YouTubeRestrictedError((error as any)?.message) : error;
      }
      const stream = await startStream(web).catch((error) => {
        throw isRefusedMedia(error) ? new YouTubeRestrictedError(error?.message) : error;
      });
      preferredStreamClient = index;
      debug('music:youtube', () => `streaming ${videoId} via ${client}`);
      return stream;
    } catch (error) {
      if (error instanceof YouTubeLiveError || error instanceof YouTubeRestrictedError) throw error;
      if (!(error instanceof YouTubeUnavailableError)) allUnavailable = false;
      lastError = error;
      debug('music:youtube', () => `${client} could not stream ${videoId}: ${(error as any)?.message || error}`);
    }
  }
  // Only report "unavailable" when every client refused the video itself; otherwise
  // the failure may be ours, and the caller should still try yt-dlp.
  if (allUnavailable && lastError) throw lastError;
  throw new Error((lastError as any)?.message || 'no YouTube client could stream this video');
}

function isRefusedMedia(error: unknown): boolean {
  return /non 2xx|\b403\b|forbidden/i.test(String((error as any)?.message || error));
}

/** Wait for the first chunk (so failures surface here), then hand everything over as a Node stream. */
async function startStream(web: ReadableStream<Uint8Array>): Promise<Readable> {
  const reader = web.getReader();
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('no audio data from YouTube in time')), FIRST_CHUNK_TIMEOUT_MS);
  });
  let first: ReadableStreamReadResult<Uint8Array>;
  try {
    first = await Promise.race([reader.read(), timeout]);
  } catch (error) {
    reader.cancel().catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (first.done || !first.value?.length) {
    reader.cancel().catch(() => {});
    throw new Error('YouTube returned an empty stream');
  }

  async function* chunks() {
    try {
      yield first.value;
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value?.length) yield value;
      }
    } finally {
      reader.cancel().catch(() => {});
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}
