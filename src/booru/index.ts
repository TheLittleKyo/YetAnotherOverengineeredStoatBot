/**
 * Booru image search: random posts by tag from a dozen imageboards, filtered
 * for the channel they are posted in.
 */
import { File as NodeFile } from 'node:buffer';
import { env } from '../config.js';
import { fetchBytes } from '../notifications/http.js';
import { BOORU_USER_AGENT, ENGINES, verifyBooruCredentials } from './engines.js';
import { getBooruCredentials } from './accounts.js';
import { BOORU_SITES } from './sites.js';
import { rejectPost } from './safety.js';
import type { BooruCredentials, BooruPost, BooruSite } from './types.js';

import { BooruError } from './types.js';

export { BooruError };
export type { BooruPost, BooruRating, BooruSite } from './types.js';
export { BOORU_SITES, BOORU_SITE_COMMAND_NAMES, findBooruSite, isSiteConfigured } from './sites.js';
export { getBooruSettings, updateBooruSettings } from './settings.js';
export type { BooruServerSettings } from './settings.js';
export {
  BOORU_ACCOUNTS,
  findBooruAccount,
  getBooruAccountState,
  getBooruCredentials,
  normalizeBooruCredentials,
  removeBooruCredentials,
  saveBooruCredentials,
} from './accounts.js';
export type { BooruAccountDef } from './accounts.js';
export { parseQuery, normalizeBlacklist, RATING_LABELS, MAX_BLACKLIST_TAGS } from './safety.js';

/** Posts asked for per round; most are thrown away by the random pick and the filter. */
const CANDIDATES_PER_ROUND = 30;
/** A second random batch helps when the filter removed most of the first. */
const MAX_ROUNDS = 2;
const DOWNLOAD_TIMEOUT_MS = 30_000;

export type BooruSearchResult = {
  posts: BooruPost[];
  /** Candidates the rating filter, the blocklist or the server blacklist removed. */
  hidden: number;
};

export async function searchBooru(
  site: BooruSite,
  options: {
    tags: string[];
    safe: boolean;
    count: number;
    blacklist: string[];
    /** Overrides the saved account (the dashboard tests a key before saving it). */
    credentials?: BooruCredentials | null;
  },
): Promise<BooruSearchResult> {
  const engine = ENGINES[site.engine];
  const credentials = options.credentials !== undefined ? options.credentials : getBooruCredentials(site.account);
  const seen = new Set<string>();
  const posts: BooruPost[] = [];
  let hidden = 0;

  for (let round = 0; round < MAX_ROUNDS && posts.length < options.count; round++) {
    const candidates = await engine(site, {
      tags: options.tags,
      safe: options.safe,
      limit: CANDIDATES_PER_ROUND,
      credentials,
    });
    let fresh = 0;
    for (const post of candidates) {
      if (seen.has(post.id)) continue;
      seen.add(post.id);
      fresh++;
      const reason = rejectPost(post, options);
      if (reason) {
        if (reason !== 'format') hidden++;
        continue;
      }
      if (posts.length < options.count) posts.push(post);
    }
    // Nothing new came back, so another round would only repeat it.
    if (fresh === 0 || candidates.length < CANDIDATES_PER_ROUND / 2) break;
  }

  return { posts, hidden };
}

/** Check an account against the first site that uses it; throws a BooruError when refused. */
export async function testBooruAccount(accountId: string, credentials: BooruCredentials): Promise<void> {
  const site = BOORU_SITES.find((candidate) => candidate.account === accountId);
  if (!site) throw new BooruError('No site uses that account.');
  await verifyBooruCredentials(site, credentials);
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  webm: 'video/webm',
};

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** Content types that say nothing about the file, so its extension decides. */
const UNTYPED = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/**
 * The upload type for a download: the served type when it is one the bot can
 * show, the extension's type when the server did not say, otherwise null (an
 * HTML error page, an SVG, a hotlink placeholder).
 */
export function mediaTypeFor(contentType: string, ext: string): string | null {
  const served = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
  if (EXT_BY_MIME[served]) return served;
  if (UNTYPED.has(served)) return MIME_BY_EXT[ext] || null;
  return null;
}

export type DownloadedMedia = {
  file: InstanceType<typeof NodeFile>;
  isVideo: boolean;
};

/**
 * Fetch a post's file so it can be uploaded to Stoat. Throws when the file is
 * over the upload cap or is not an image or video.
 */
export async function downloadPostMedia(site: BooruSite, post: BooruPost): Promise<DownloadedMedia> {
  const { bytes, contentType } = await fetchBytes(post.mediaUrl, {
    maxBytes: env.booruMaxUploadBytes,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    headers: { 'User-Agent': BOORU_USER_AGENT, 'Referer': `${site.baseUrl}/` },
  });
  const type = mediaTypeFor(contentType, post.mediaExt);
  if (!type) throw new Error(`Unexpected content type ${contentType || 'none'}`);
  // The upload is typed by its file name, so the name follows what was served.
  const ext = MIME_BY_EXT[post.mediaExt] === type ? post.mediaExt : EXT_BY_MIME[type];
  return {
    file: new NodeFile([bytes], `${site.id}-${post.id}.${ext}`, { type }),
    isVideo: type.startsWith('video/'),
  };
}
