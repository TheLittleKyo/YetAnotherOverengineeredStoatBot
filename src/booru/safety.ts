/**
 * Query parsing and the content filter every booru result passes through.
 *
 * Boorus host a lot of adult content, so results are filtered by channel rating,
 * file type, and each server's own blacklist.
 */
import type { BooruPost, BooruRating } from './types.js';

/** File types the bot can show. Flash, ugoira zips and the like are skipped. */
export const SHOWABLE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'mp4', 'webm']);
export const VIDEO_EXTENSIONS = new Set(['mp4', 'webm']);

const MAX_QUERY_TOKENS = 20;
const MAX_TOKEN_LENGTH = 80;
export const MAX_BLACKLIST_TAGS = 200;

/**
 * `Cat Ears` / `cat-ears` → `_cat_ears_`, so a phrase matches only on word
 * boundaries. Anything that is not a letter or digit separates words, so
 * `loli+`, `loli&shota` or `loli;` still match `loli`.
 */
function wordForm(value: string): string {
  const words = String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  return `_${words}_`;
}

/** Whether `tag` contains `term` as a whole word or word sequence. */
export function tagContains(tag: string, term: string): boolean {
  const needle = wordForm(term);
  return needle !== '__' && wordForm(tag).includes(needle);
}

/** Normalize one tag the way sites store them: lowercase, spaces as underscores. */
export function normalizeTag(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[`\x00-\x1f\x7f]/g, '')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, MAX_TOKEN_LENGTH);
}

export type ParsedQuery = {
  tags: string[];
  /** Retained for compatibility; built-in tag blocking is disabled. */
  blockedTag: string | null;
  /** Retained for compatibility with command consumers. */
  blockedEverywhere: boolean;
  /** `rating:` tokens were removed because the channel only allows safe results. */
  droppedRating: boolean;
};

/**
 * Turn the words after the command into site query tokens. In safe mode the
 * member's own `rating:` tokens are dropped, since the bot adds its own.
 */
export function parseQuery(words: string[], options: { safe: boolean }): ParsedQuery {
  const tags: string[] = [];
  let blockedTag: string | null = null;
  let droppedRating = false;

  for (const word of words) {
    const token = normalizeTag(word).replace(/^,+|,+$/g, '');
    if (!token || token === '-' || token === '~') continue;

    const negated = token.startsWith('-');
    const bare = token.replace(/^[-~]/, '');
    if (/^rating:/.test(bare) && options.safe) {
      droppedRating = true;
      continue;
    }
    if (tags.includes(token)) continue;
    if (tags.length >= MAX_QUERY_TOKENS) break;

    tags.push(token);
  }

  return { tags, blockedTag, blockedEverywhere: false, droppedRating };
}

export type RejectReason = 'rating' | 'blocked' | 'blacklist' | 'format';

/** Why a post may not be shown, or null when it may. */
export function rejectPost(
  post: Pick<BooruPost, 'rating' | 'tags' | 'mediaExt'>,
  options: { safe: boolean; blacklist: string[] },
): RejectReason | null {
  if (options.safe && post.rating !== 'general') return 'rating';
  if (!SHOWABLE_EXTENSIONS.has(post.mediaExt)) return 'format';

  if (options.blacklist.length && post.tags.some((tag) => options.blacklist.some((term) => tagContains(tag, term)))) {
    return 'blacklist';
  }
  return null;
}

/** Clean a server blacklist from untrusted input: normalized, deduped, capped. */
export function normalizeBlacklist(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of list) {
    const tag = normalizeTag(String(item ?? '')).replace(/^[-~]/, '');
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= MAX_BLACKLIST_TAGS) break;
  }
  return out;
}

export const RATING_LABELS: Record<BooruRating, string> = {
  general: 'General',
  sensitive: 'Sensitive',
  questionable: 'Questionable',
  explicit: 'Explicit',
};

/** Map a site's rating value onto the shared scale. Unknown values count as explicit. */
export function toRating(value: unknown): BooruRating {
  switch (String(value ?? '').trim().toLowerCase()) {
    case 'g':
    case 'general':
    case 's':
    case 'safe':
      return 'general';
    case 'sensitive':
      return 'sensitive';
    case 'q':
    case 'questionable':
      return 'questionable';
    default:
      return 'explicit';
  }
}
