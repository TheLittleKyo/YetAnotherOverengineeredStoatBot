import type { Track } from './types.js';

/**
 * Lyrics from LRCLIB (https://lrclib.net) — free, keyless, community-run.
 */

export type LyricsResult = {
  title: string;
  artist: string;
  lyrics: string;
};

const USER_AGENT = 'YetAnotherOverengineeredStoatBot-Music/1.0 (Stoat.chat bot)';

/** Strip video-title noise so `Artist - Song (Official Video) [4K]` searches as `Artist Song`. */
export function cleanSearchTitle(title: string): string {
  return String(title || '')
    .replace(/\((?:official|lyric|lyrics|audio|video|visualizer|music video|hd|4k|remaster(?:ed)?)[^)]*\)/gi, '')
    .replace(/\[(?:official|lyric|lyrics|audio|video|visualizer|music video|hd|4k|remaster(?:ed)?)[^\]]*\]/gi, '')
    .replace(/\b(?:ft|feat)\.?\s.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function lyricsQueryFor(track: Track): string {
  const title = cleanSearchTitle(track.title);
  // YouTube titles usually already carry the artist; channel names like "Rick Astley - Topic" add noise.
  if (track.source === 'spotify' || !/\s[-–]\s/.test(title)) {
    const author = String(track.author || '').replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
    return author && author !== 'Unknown' ? `${author} ${title}` : title;
  }
  return title.replace(/\s[-–]\s/, ' ');
}

export async function fetchLyrics(query: string): Promise<LyricsResult | null> {
  const response = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LRCLIB returned HTTP ${response.status}.`);
  const results = await response.json();
  return pickLyrics(results);
}

export function pickLyrics(results: any): LyricsResult | null {
  const list = Array.isArray(results) ? results : [];
  const hit = list.find((entry) => typeof entry?.plainLyrics === 'string' && entry.plainLyrics.trim());
  if (hit) return { title: hit.trackName || 'Unknown', artist: hit.artistName || 'Unknown', lyrics: hit.plainLyrics.trim() };
  const instrumental = list.find((entry) => entry?.instrumental === true);
  if (instrumental) {
    return { title: instrumental.trackName || 'Unknown', artist: instrumental.artistName || 'Unknown', lyrics: '*(instrumental)*' };
  }
  return null;
}
