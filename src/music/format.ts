import type { LoopMode, Track } from './types.js';

/** Stoat rejects messages over 2000 characters; leave room for markup. */
export const MESSAGE_LIMIT = 1900;

/** `213` → `3:33`, `3725` → `1:02:05`. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '?:??';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}

export function formatTrackDuration(track: Track): string {
  return track.isLive ? 'live' : formatDuration(track.duration);
}

/**
 * Break mention syntax in text the bot did not write (video titles, channel
 * names, nicknames, lyrics) so echoing it cannot ping a user, role or everyone.
 */
export function neutralizeMentions(text: string): string {
  return String(text || '')
    .replace(/<([@%#])/g, '<​$1')
    .replace(/@(everyone|online|here)\b/gi, '@​$1');
}

/** Strip characters that would break a `[title](url)` markdown link, and neutralize mentions. */
export function escapeLinkText(text: string): string {
  return neutralizeMentions(String(text || '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim()) || 'Unknown';
}

/** Percent-encode what would end a markdown link target early. */
export function escapeLinkUrl(url: string): string {
  return String(url || '').replace(/[()\s<>]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

export function trackLink(track: Track): string {
  const title = escapeLinkText(track.title);
  return track.url ? `[${title}](${escapeLinkUrl(track.url)})` : `**${title}**`;
}

/** Text progress bar: `▬▬▬▬🔘▬▬▬▬▬`. */
export function progressBar(elapsed: number, duration: number | null, width = 16): string {
  if (!duration || duration <= 0) return '';
  const ratio = Math.min(1, Math.max(0, elapsed / duration));
  const knob = Math.min(width - 1, Math.floor(ratio * width));
  return `${'▬'.repeat(knob)}🔘${'▬'.repeat(width - knob - 1)}`;
}

export function describeLoop(mode: LoopMode): string {
  if (mode === 'track') return 'Track';
  if (mode === 'queue') return 'Queue';
  return 'Off';
}

export type QueuePage = {
  page: number;
  pages: number;
  lines: string[];
};

/** Slice the upcoming queue into numbered lines (1-based) for one page. */
export function paginateQueue(queue: Track[], page: number, perPage = 10): QueuePage {
  const pages = Math.max(1, Math.ceil(queue.length / perPage));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * perPage;
  const lines = queue.slice(start, start + perPage).map((track, index) => {
    return `\`${start + index + 1}.\` ${trackLink(track)} \`${formatTrackDuration(track)}\``;
  });
  return { page: current, pages, lines };
}

/** Sum of known durations; live / unknown tracks are skipped. */
export function totalDuration(tracks: Track[]): number {
  return tracks.reduce((sum, track) => sum + (track.isLive || !track.duration ? 0 : track.duration), 0);
}

/** Trim a message body to the Stoat limit without cutting a line in half. */
export function clampMessage(text: string, limit = MESSAGE_LIMIT): string {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf('\n', limit - 2);
  return `${text.slice(0, cut > 0 ? cut : limit - 2)}\n…`;
}
