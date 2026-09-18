import { assertPublicHttpUrl } from '../notifications/http.js';
import { withTimeout } from '../async-utils.js';
import { env } from '../config.js';
import { debug } from '../logger.js';
import { BROWSER_UA, extractRadioUrl, isRadioPlaylistUrl, resolveRadio } from './radio.js';
import { runYtDlpJson } from './tools.js';
import type { Requester, ResolveResult, SearchProvider, Track, TrackSource } from './types.js';
import {
  getPlaylist,
  getVideo,
  metadataBreaker,
  parseYouTubeUrl,
  searchSongs,
  searchVideos,
  YouTubeUnavailableError,
  type YouTubeRef,
} from './youtube.js';

/**
 * Turns whatever a user typed after `!play` into queueable tracks.
 *
 * - Spotify track/album/playlist links: metadata comes from Spotify's public
 *   embed page (no API credentials); audio is looked up on YouTube Music at
 *   playback time.
 * - Any other link: yt-dlp (YouTube, YouTube Music, SoundCloud, Bandcamp and
 *   the ~1800 other sites it supports), or a direct audio/radio stream.
 * - Plain text: a search on the chosen provider.
 */

const DIRECT_AUDIO_EXTENSIONS = /\.(mp3|ogg|oga|opus|m4a|aac|wav|flac|webm|weba|mka)$/i;

export type SpotifyRef = { type: 'track' | 'album' | 'playlist'; id: string };

/** Pull `<https://…>` / `https://…` out of a message argument. */
export function extractUrl(input: string): string | null {
  const text = String(input || '').trim().replace(/^<(.+)>$/, '$1');
  if (!/^https?:\/\/\S+$/i.test(text)) return null;
  try {
    return new URL(text).toString();
  } catch {
    return null;
  }
}

export function parseSpotifyRef(input: string): SpotifyRef | null {
  const text = String(input || '').trim().replace(/^<(.+)>$/, '$1');
  const uri = text.match(/^spotify:(track|album|playlist):([A-Za-z0-9]{22})$/);
  if (uri) return { type: uri[1] as SpotifyRef['type'], id: uri[2] };
  const url = text.match(
    /^https?:\/\/(?:open|play)\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(?:embed\/)?(track|album|playlist)\/([A-Za-z0-9]{22})/i,
  );
  if (url) return { type: url[1].toLowerCase() as SpotifyRef['type'], id: url[2] };
  return null;
}

export function isDirectAudioUrl(url: string): boolean {
  try {
    return DIRECT_AUDIO_EXTENSIONS.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function detectSource(extractor: string | undefined, url = ''): TrackSource {
  const key = String(extractor || '').toLowerCase();
  if (key.includes('youtube') || /(?:youtube\.com|youtu\.be)\//i.test(url)) return 'youtube';
  if (key.includes('soundcloud') || /soundcloud\.com\//i.test(url)) return 'soundcloud';
  return 'other';
}

/** A watch link that carries an auto-generated mix (`list=RD…`) is a single video, not an endless playlist. */
export function shouldIgnorePlaylist(url: string): boolean {
  try {
    const parsed = new URL(url);
    const list = parsed.searchParams.get('list') || '';
    return Boolean(parsed.searchParams.get('v')) && /^(RD|UL|LL)/.test(list);
  } catch {
    return false;
  }
}

function pickThumbnail(entry: any, source: TrackSource): string | undefined {
  if (source === 'youtube' && typeof entry?.id === 'string' && /^[\w-]{11}$/.test(entry.id)) {
    return `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`;
  }
  if (typeof entry?.thumbnail === 'string') return entry.thumbnail;
  const list = Array.isArray(entry?.thumbnails) ? entry.thumbnails : [];
  const last = list[list.length - 1];
  return typeof last?.url === 'string' ? last.url : undefined;
}

/** Map one yt-dlp info dict (full or `--flat-playlist` entry) to a Track. */
export function ytDlpEntryToTrack(entry: any, requester: Requester): Track | null {
  if (!entry || typeof entry !== 'object') return null;
  const title = String(entry.title || entry.track || '').trim();
  if (/^\[(private|deleted) video\]$/i.test(title)) return null;

  const pageUrl = String(entry.webpage_url || entry.original_url || entry.url || '').trim();
  if (!pageUrl) return null;

  const source = detectSource(entry.ie_key || entry.extractor_key || entry.extractor, pageUrl);
  const isLive = entry.is_live === true || entry.live_status === 'is_live';
  const duration = Number(entry.duration);

  return {
    title: title || 'Unknown title',
    url: pageUrl,
    source,
    author: String(entry.artist || entry.channel || entry.uploader || entry.creator || 'Unknown').trim(),
    authorUrl: entry.channel_url || entry.uploader_url || undefined,
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    isLive,
    thumbnail: pickThumbnail(entry, source),
    requester,
    playbackUrl: pageUrl,
  };
}

export function searchTarget(query: string, provider: SearchProvider, limit: number): string {
  const count = Math.max(1, Math.min(10, Math.floor(limit) || 1));
  if (provider === 'soundcloud') return `scsearch${count}:${query}`;
  if (provider === 'ytmusic') return `https://music.youtube.com/search?q=${encodeURIComponent(query)}#songs`;
  return `ytsearch${count}:${query}`;
}

/**
 * Try the youtubei.js fast path, then yt-dlp. An empty result also falls
 * back, since a YouTube layout change usually shows up as "nothing parsed"
 * rather than an exception; it only counts against the fast path when yt-dlp
 * then finds something (a search for gibberish is empty for both).
 * "Video unavailable" is final: yt-dlp would agree.
 */
export async function withYouTubeFallback<T>(
  label: string,
  fast: () => Promise<T>,
  slow: () => Promise<T>,
  isEmpty: (value: T) => boolean = (value) => Array.isArray(value) && value.length === 0,
  timeoutMs = 10_000,
): Promise<T> {
  if (!metadataBreaker.available) return slow();

  try {
    const value = await withTimeout(fast(), timeoutMs, `youtubei.js ${label} timed out`);
    if (!isEmpty(value)) {
      metadataBreaker.success();
      return value;
    }
  } catch (error) {
    if (error instanceof YouTubeUnavailableError) throw error;
    metadataBreaker.failure(error);
    debug('music:resolve', () => `youtubei.js ${label} failed, using yt-dlp: ${error?.message || error}`);
    return slow();
  }

  const fallback = await slow();
  if (!isEmpty(fallback)) metadataBreaker.failure(new Error(`youtubei.js ${label} found nothing that yt-dlp found`));
  return fallback;
}

/** Search a provider and return up to `limit` tracks. */
export async function searchTracks(
  query: string,
  provider: SearchProvider,
  requester: Requester,
  limit = 5,
): Promise<Track[]> {
  if (provider === 'youtube') {
    return withYouTubeFallback('search', () => searchVideos(query, limit, requester), () => searchWithYtDlp(query, provider, requester, limit));
  }
  if (provider === 'ytmusic') {
    return withYouTubeFallback('music search', () => searchSongs(query, limit, requester), () => searchWithYtDlp(query, provider, requester, limit));
  }
  return searchWithYtDlp(query, provider, requester, limit);
}

async function searchWithYtDlp(query: string, provider: SearchProvider, requester: Requester, limit: number): Promise<Track[]> {
  const info = await runYtDlpJson(['--flat-playlist', '--playlist-end', String(limit), searchTarget(query, provider, limit)]);
  const entries = Array.isArray(info?.entries) ? info.entries : [];
  return entries
    .map((entry) => ytDlpEntryToTrack(entry, requester))
    .filter(Boolean)
    .slice(0, limit)
    .map((track) => (provider === 'ytmusic' && track.author === 'Unknown' ? { ...track, author: 'YouTube Music' } : track));
}

export async function resolveQuery(
  input: string,
  options: { provider: SearchProvider; requester: Requester; maxTracks?: number },
): Promise<ResolveResult> {
  const maxTracks = Math.max(1, options.maxTracks ?? env.musicMaxQueue);
  const spotify = parseSpotifyRef(input);
  if (spotify) return resolveSpotify(spotify, options.requester, maxTracks);

  const url = extractUrl(input);
  if (!url) {
    // rtsp://, rtmp://, mms://, icy:// … are only ever radio streams.
    if (/^<?[a-z][a-z0-9+.-]*:\/\/\S+>?$/i.test(input.trim())) {
      const radioUrl = extractRadioUrl(input);
      if (radioUrl) return resolveRadio(radioUrl, options.requester);
    }
    const tracks = await searchTracks(input, options.provider, options.requester, 1);
    if (tracks.length === 0) throw new Error(`No results for **${input.slice(0, 100)}**.`);
    return { tracks };
  }

  await assertPublicHttpUrl(url);
  // Radio playlist files and manifests (.pls, .m3u, .m3u8, .asx, .ram, .mpd, …): unwrap them and read the station name.
  if (isRadioPlaylistUrl(url)) return resolveRadio(url, options.requester);
  if (isDirectAudioUrl(url)) return { tracks: [directTrack(url, options.requester)] };

  const youtube = parseYouTubeUrl(url);
  if (youtube) return resolveYouTube(url, youtube, options.requester, maxTracks);

  try {
    return await resolveWithYtDlp(url, options.requester, maxTracks);
  } catch (error) {
    // yt-dlp's generic extractor does not recognize plain radio streams; see whether the link is one.
    try {
      return await resolveRadio(url, options.requester);
    } catch (radioError) {
      debug('music:resolve', () => `not a radio stream either: ${radioError?.message || radioError}`);
      throw error;
    }
  }
}

async function resolveYouTube(url: string, ref: YouTubeRef, requester: Requester, maxTracks: number): Promise<ResolveResult> {
  const slow = () => resolveWithYtDlp(url, requester, maxTracks);
  // Same rule as yt-dlp: a list parameter means the playlist, except auto-generated mixes.
  if (ref.playlistId && !shouldIgnorePlaylist(url)) {
    return withYouTubeFallback(
      'playlist',
      async () => {
        const { title, tracks } = await getPlaylist(ref.playlistId, maxTracks, requester);
        return { tracks, playlistTitle: title };
      },
      slow,
      (result) => result.tracks.length === 0,
      45_000,
    );
  }
  if (ref.videoId) {
    return withYouTubeFallback('video lookup', async () => ({ tracks: [await getVideo(ref.videoId, requester, ref.music)] }), slow, () => false);
  }
  return slow();
}

async function resolveWithYtDlp(url: string, requester: Requester, maxTracks: number): Promise<ResolveResult> {
  const args = ['--flat-playlist', '--playlist-end', String(maxTracks)];
  if (shouldIgnorePlaylist(url)) args.push('--no-playlist');
  const info = await runYtDlpJson([...args, url], 90_000);

  if (info?._type === 'playlist' || Array.isArray(info?.entries)) {
    const tracks = (info.entries || [])
      .map((entry) => ytDlpEntryToTrack(entry, requester))
      .filter(Boolean)
      .slice(0, maxTracks);
    if (tracks.length === 0) throw new Error('That playlist has no playable tracks.');
    return { tracks, playlistTitle: String(info.title || 'Playlist') };
  }

  const track = ytDlpEntryToTrack(info, requester);
  if (!track) throw new Error('Could not read that link.');
  return { tracks: [track] };
}

export function directTrack(url: string, requester: Requester): Track {
  const parsed = new URL(url);
  const fileName = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
  return {
    title: fileName || parsed.hostname,
    url,
    source: 'direct',
    author: parsed.hostname,
    duration: null,
    isLive: false,
    requester,
    playbackUrl: url,
  };
}

// ── Spotify ────────────────────────────────────────────────────────────────

async function resolveSpotify(ref: SpotifyRef, requester: Requester, maxTracks: number): Promise<ResolveResult> {
  const response = await fetch(`https://open.spotify.com/embed/${ref.type}/${ref.id}`, {
    headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Spotify returned HTTP ${response.status} for that link.`);
  const result = parseSpotifyEmbed(await response.text(), requester);
  if (!result || result.tracks.length === 0) throw new Error('Could not read that Spotify link (is it private?).');
  return { ...result, tracks: result.tracks.slice(0, maxTracks) };
}

/** Parse the `__NEXT_DATA__` blob of an open.spotify.com/embed page. Exported for tests. */
export function parseSpotifyEmbed(html: string, requester: Requester): ResolveResult | null {
  const match = String(html || '').match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) return null;
  let entity: any;
  try {
    entity = JSON.parse(match[1])?.props?.pageProps?.state?.data?.entity;
  } catch {
    return null;
  }
  if (!entity) return null;

  const cover = pickSpotifyImage(entity);

  if (entity.type === 'track') {
    const artists = (Array.isArray(entity.artists) ? entity.artists : []).map((a) => a?.name).filter(Boolean);
    const track = spotifyTrack({
      id: entity.id || String(entity.uri || '').split(':').pop(),
      title: entity.name || entity.title,
      artist: artists.join(', '),
      durationMs: entity.duration,
      thumbnail: cover,
      requester,
    });
    return track ? { tracks: [track] } : null;
  }

  const list = Array.isArray(entity.trackList) ? entity.trackList : [];
  const tracks = list
    .filter((item) => item?.isPlayable !== false && (item?.entityType ?? 'track') === 'track')
    .map((item) =>
      spotifyTrack({
        id: String(item.uri || '').split(':').pop(),
        title: item.title,
        artist: item.subtitle,
        durationMs: item.duration,
        thumbnail: cover,
        requester,
      }),
    )
    .filter(Boolean);
  return { tracks, playlistTitle: String(entity.name || entity.title || 'Spotify playlist') };
}

function pickSpotifyImage(entity: any): string | undefined {
  const sources = [
    ...(entity?.coverArt?.sources || []),
    ...(entity?.visualIdentity?.image || []),
  ];
  const best = sources
    .filter((s) => typeof s?.url === 'string')
    .sort((a, b) => (Number(b.maxWidth || b.width) || 0) - (Number(a.maxWidth || a.width) || 0))[0];
  return best?.url;
}

function spotifyTrack(input: {
  id: string;
  title: string;
  artist: string;
  durationMs: number;
  thumbnail?: string;
  requester: Requester;
}): Track | null {
  const title = String(input.title || '').trim();
  if (!title) return null;
  const artist = String(input.artist || '').trim();
  const duration = Number(input.durationMs) / 1000;
  return {
    title,
    url: input.id ? `https://open.spotify.com/track/${input.id}` : '',
    source: 'spotify',
    author: artist || 'Unknown',
    duration: Number.isFinite(duration) && duration > 0 ? duration : null,
    isLive: false,
    thumbnail: input.thumbnail,
    requester: input.requester,
    lookupQuery: artist ? `${artist} - ${title}` : title,
  };
}

/**
 * Make sure a track has something yt-dlp can stream. Spotify tracks are
 * matched on YouTube Music first (studio audio, no video intros) and fall back
 * to a regular YouTube search.
 */
export async function ensurePlaybackUrl(track: Track): Promise<string> {
  if (track.playbackUrl) return track.playbackUrl;
  const query = track.lookupQuery || `${track.author} - ${track.title}`;
  for (const provider of ['ytmusic', 'youtube'] as const) {
    try {
      const [match] = await searchTracks(query, provider, track.requester, 1);
      if (match?.playbackUrl) {
        track.playbackUrl = match.playbackUrl;
        return track.playbackUrl;
      }
    } catch (error) {
      debug('music:resolve', () => `${provider} lookup failed for "${query}": ${error?.message || error}`);
    }
  }
  throw new Error(`Could not find playable audio for **${track.title}**.`);
}
