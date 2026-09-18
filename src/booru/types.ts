/**
 * Shared shapes for the booru image search.
 */

/**
 * One rating scale for every site. Danbooru-style sites use all four; sites
 * with a three-step scale map their "safe" to `general`.
 */
export type BooruRating = 'general' | 'sensitive' | 'questionable' | 'explicit';

export type BooruEngineId = 'danbooru' | 'gelbooru' | 'moebooru' | 'e621' | 'philomena' | 'shimmie';

/** How a Philomena-family site differs from Derpibooru. */
export interface PhilomenaOptions {
  /** `v1`: /api/v1/json/search/images, list in `images`. `v3` (Twibooru): /api/v3/search/posts, list in `posts`. */
  api: 'v1' | 'v3';
  /** Path before the post id in a post link, e.g. `/images/`. */
  postPath: string;
  /** System filter for safe searches; omitted means the site default. */
  safeFilter?: string;
  /** System filter that hides nothing, for NSFW channels. */
  allFilter: string;
}

export interface BooruCredentials {
  user: string;
  key: string;
}

export interface BooruSite {
  /** Canonical id, also the command name (`!danbooru`). */
  id: string;
  name: string;
  /** Extra names accepted after `!booru` and as commands. */
  aliases: string[];
  engine: BooruEngineId;
  /** Web root, used for post links. */
  baseUrl: string;
  /** API root when it differs from `baseUrl`. */
  apiUrl?: string;
  /** One line for `!booru sites`. */
  description: string;
  /** Every post is adult content, so the site is refused outside NSFW channels. */
  nsfwOnly?: boolean;
  /** Only safe results, even in NSFW channels. */
  safeOnly?: boolean;
  /** Query tag that limits results to the safe rating. */
  safeTag?: string;
  /** Philomena-family sites only. */
  philomena?: PhilomenaOptions;
  /** Account (see accounts.ts) the site's API calls use when one is saved. */
  account?: string;
  /** The API refuses anonymous calls. */
  requiresCredentials?: boolean;
}

export interface BooruPost {
  siteId: string;
  id: string;
  postUrl: string;
  rating: BooruRating;
  score: number | null;
  /** Every tag, lowercase with underscores (`cat_ears`). */
  tags: string[];
  artists: string[];
  characters: string[];
  copyrights: string[];
  /** Best file to show: a resized sample when the site has one. */
  mediaUrl: string;
  /** Original file. */
  fileUrl: string;
  /** Lowercase extension of `mediaUrl`, without the dot. */
  mediaExt: string;
  source: string | null;
}

export interface BooruSearchRequest {
  /** Normalized query tokens (see `parseQuery`). */
  tags: string[];
  /** Only general-rated posts may come back. */
  safe: boolean;
  /** How many candidates to ask the site for. */
  limit: number;
  /** The site account to authenticate with, if any. */
  credentials?: BooruCredentials | null;
}

export type BooruEngine = (site: BooruSite, request: BooruSearchRequest) => Promise<BooruPost[]>;

/** A failure worth showing to the member as-is (bad tags, missing account, site down). */
export class BooruError extends Error {
  /** HTTP status of the failed call, when there was one. */
  readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'BooruError';
    this.status = status;
  }
}
