/**
 * One adapter per booru software family. Each takes normalized query tokens and
 * returns posts on the shared shape; filtering happens later, in safety.ts.
 *
 * - danbooru:  Danbooru (and its forks)          /posts.json
 * - gelbooru:  Gelbooru 0.2 "dapi"               /index.php?page=dapi
 * - moebooru:  yande.re, Konachan                /post.json
 * - e621:      e621 / e926                        /posts.json
 * - philomena: Derpibooru, Furbooru, Manebooru     /api/v1/json/search/images
 *              Twibooru                            /api/v3/search/posts
 * - shimmie:   Rule34 Paheal                       /api/danbooru/find_posts (XML)
 */
import { debug } from '../logger.js';
import { fetchUrl } from '../notifications/http.js';
import { toRating, normalizeTag } from './safety.js';
import {
  BooruError,
  type BooruCredentials,
  type BooruEngine,
  type BooruEngineId,
  type BooruPost,
  type BooruRating,
  type BooruSite,
  type PhilomenaOptions,
} from './types.js';

export const BOORU_USER_AGENT =
  'YetAnotherOverengineeredStoatBot/1.1 (Stoat bot; +https://github.com/TheLittleKyo/YetAnotherOverengineeredStoatBot)';

const REQUEST_TIMEOUT_MS = 12_000;

type ApiResponse = { ok: boolean; status: number; data: any; text: string };

async function requestJson(url: string, headers: Record<string, string> = {}): Promise<ApiResponse> {
  const result = await fetchUrl(url, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    headers: { 'User-Agent': BOORU_USER_AGENT, 'Accept': 'application/json', ...headers },
  });
  let data: any = null;
  try {
    data = result.text.trim() ? JSON.parse(result.text) : null;
  } catch {
    data = null;
  }
  // The URL can carry an API key (Gelbooru), so only the path is logged.
  debug('booru:http', () => `${new URL(url).host}${new URL(url).pathname} -> ${result.status}`);
  return { ok: result.ok, status: result.status, data, text: result.text };
}

function apiRoot(site: BooruSite): string {
  return (site.apiUrl || site.baseUrl).replace(/\/+$/, '');
}

function basicAuth(creds: BooruCredentials | null | undefined): Record<string, string> {
  if (!creds) return {};
  return { Authorization: `Basic ${Buffer.from(`${creds.user}:${creds.key}`).toString('base64')}` };
}

/** Turn a failed call into the message the member sees. */
function failure(site: BooruSite, response: ApiResponse): BooruError {
  const siteMessage =
    (typeof response.data?.message === 'string' && response.data.message) ||
    (typeof response.data?.reason === 'string' && response.data.reason) ||
    (typeof response.data === 'string' && response.data) ||
    '';
  if (response.status === 0) return new BooruError(`${site.name} did not answer. Try again in a moment.`);
  if (response.status === 401 || response.status === 403) {
    const hint = site.account ? ' Check the site account in the dashboard Booru tab.' : '';
    return new BooruError(`${site.name} refused the request (HTTP ${response.status}).${hint}`, response.status);
  }
  if (response.status === 429) return new BooruError(`${site.name} is rate limiting the bot. Try again in a minute.`);
  const detail = siteMessage ? `: ${siteMessage.slice(0, 200)}` : '';
  return new BooruError(`${site.name} returned HTTP ${response.status}${detail}`, response.status);
}

/** Protocol-relative and root-relative file links, made absolute. */
function absoluteUrl(value: unknown, base: string): string {
  const text = String(value ?? '').trim();
  if (!text) return '';
  try {
    const url = new URL(text.startsWith('//') ? `https:${text}` : text, base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : '';
  } catch {
    return '';
  }
}

function extensionOf(url: string): string {
  try {
    const match = new URL(url).pathname.match(/\.([a-z0-9]+)$/i);
    return match ? match[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

function splitTags(value: unknown): string[] {
  return decodeEntities(String(value ?? ''))
    .split(/\s+/)
    .map(normalizeTag)
    .filter(Boolean);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function numberOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** The first web link in a source field (Gelbooru packs several, space-separated). */
function sourceUrl(value: unknown): string | null {
  const first = String(value ?? '')
    .split(/\s+/)
    .find((part) => /^https?:\/\/\S+$/i.test(part));
  return first || null;
}

/** Prefer the sample for stills; a sample of a GIF or video is a single frame. */
function pickMedia(fileUrl: string, sampleUrl: string): string {
  const ext = extensionOf(fileUrl);
  if (!sampleUrl || ext === 'gif' || ext === 'mp4' || ext === 'webm') return fileUrl;
  return sampleUrl;
}

function tagQuery(tags: string[], extra: (string | undefined | false)[]): string {
  return [...tags, ...extra.filter(Boolean)].join(' ');
}

/** Fisher-Yates, in place. */
function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** A 200 answer that is a web page (Cloudflare challenge, maintenance) rather than API data. */
function isHtml(text: string): boolean {
  return /^\s*</.test(text) && /<(!doctype|html|head|body)\b/i.test(text.slice(0, 1000));
}

// ---------------------------------------------------------------------------
// Danbooru
// ---------------------------------------------------------------------------

const DANBOORU_FIELDS = [
  'id',
  'rating',
  'score',
  'tag_string',
  'tag_string_artist',
  'tag_string_character',
  'tag_string_copyright',
  'file_url',
  'large_file_url',
  'file_ext',
  'source',
  'is_deleted',
  'is_banned',
].join(',');

/** Danbooru's `s` is "sensitive", unlike the `s` = safe of older sites. */
const DANBOORU_RATINGS: Record<string, BooruRating> = {
  g: 'general',
  general: 'general',
  s: 'sensitive',
  sensitive: 'sensitive',
  q: 'questionable',
  questionable: 'questionable',
  e: 'explicit',
  explicit: 'explicit',
};

/** How many single random posts to fetch when a list search hits the tag limit. */
const DANBOORU_SINGLE_FETCHES = 4;

export function mapDanbooruPost(site: BooruSite, raw: any): BooruPost | null {
  if (!raw || raw.id == null || raw.is_deleted) return null;
  const base = site.baseUrl;
  const fileUrl = absoluteUrl(raw.file_url, base);
  const large = absoluteUrl(raw.large_file_url, base);
  // Posts hidden from the current account (banned artists, Gold-only) have no file.
  if (!fileUrl && !large) return null;
  // Ugoira originals are zips; the large file is a playable WebM.
  const mediaUrl = raw.file_ext === 'zip' ? large : pickMedia(fileUrl || large, large);
  return {
    siteId: site.id,
    id: String(raw.id),
    postUrl: `${base}/posts/${raw.id}`,
    rating: DANBOORU_RATINGS[String(raw.rating ?? '').trim().toLowerCase()] ?? 'explicit',
    score: numberOrNull(raw.score),
    tags: splitTags(raw.tag_string),
    artists: splitTags(raw.tag_string_artist),
    characters: splitTags(raw.tag_string_character),
    copyrights: splitTags(raw.tag_string_copyright),
    mediaUrl,
    fileUrl: fileUrl || large,
    mediaExt: extensionOf(mediaUrl),
    source: sourceUrl(raw.source),
  };
}

const danbooru: BooruEngine = async (site, request) => {
  const root = apiRoot(site);
  const headers = basicAuth(request.credentials);
  const tags = request.safe ? [...request.tags, 'rating:g'] : request.tags;
  const map = (raw: any) => mapDanbooruPost(site, raw);

  // `random:N` counts toward the tag limit (two tags without Gold); `rating:` does not.
  const listParams = new URLSearchParams({
    tags: tagQuery(tags, [`random:${request.limit}`]),
    limit: String(request.limit),
    only: DANBOORU_FIELDS,
  });
  const list = await requestJson(`${root}/posts.json?${listParams}`, headers);
  if (list.ok && isHtml(list.text)) {
    throw new BooruError(
      `${site.name} answered with a web page instead of API results. It may be down or blocking bots.`,
    );
  }
  if (list.ok && Array.isArray(list.data)) return list.data.map(map).filter(Boolean) as BooruPost[];
  if (list.ok && list.data == null) {
    throw new BooruError(`${site.name} returned an invalid API response instead of a post list.`);
  }
  if (list.ok && !Array.isArray(list.data)) {
    throw new BooruError(`${site.name} returned an unexpected API response instead of a post list.`);
  }
  if (list.status !== 422) throw failure(site, list);

  // Tag limit reached. `/posts/random` takes the full limit, one post per call.
  const singleParams = new URLSearchParams({ tags: tagQuery(tags, []), only: DANBOORU_FIELDS });
  const singles = await Promise.all(
    Array.from({ length: DANBOORU_SINGLE_FETCHES }, () => requestJson(`${root}/posts/random.json?${singleParams}`, headers)),
  );
  // One call failing (a timeout) must not hide the others; the first answer decides otherwise.
  const first = singles.find((single) => single.ok) ?? singles[0];
  if (first.status === 404) return [];
  if (first.data?.error === 'PostQuery::TagLimitError') {
    const hint = request.credentials ? '' : ' A Gold account, added in the dashboard Booru tab, raises the limit.';
    throw new BooruError(`${site.name}: ${first.data.message || 'Too many tags.'}${hint}`);
  }
  if (!first.ok) throw failure(site, first);
  const seen = new Set<string>();
  const posts: BooruPost[] = [];
  for (const single of singles) {
    const post = single.ok ? map(single.data) : null;
    if (post && !seen.has(post.id)) {
      seen.add(post.id);
      posts.push(post);
    }
  }
  return posts;
};

// ---------------------------------------------------------------------------
// Gelbooru 0.2 (Gelbooru, Safebooru, Rule34, TBIB, Xbooru, Hypnohub)
// ---------------------------------------------------------------------------

export function mapGelbooruPost(site: BooruSite, raw: any): BooruPost | null {
  if (!raw || raw.id == null) return null;
  const base = site.baseUrl;
  const image = String(raw.image ?? '');
  const directory = String(raw.directory ?? '');
  // Some installs (TBIB) leave the URL fields out; the path is predictable.
  const fileUrl =
    absoluteUrl(raw.file_url, base) || (image && directory ? `${base}/images/${directory}/${image}` : '');
  if (!fileUrl) return null;
  const hasSample = raw.sample === true || raw.sample === 1 || raw.sample === '1' || raw.sample === 'true';
  const sampleUrl = hasSample
    ? absoluteUrl(raw.sample_url, base) ||
      (image && directory ? `${base}/samples/${directory}/sample_${image.replace(/\.[^.]+$/, '.jpg')}` : '')
    : '';
  const mediaUrl = pickMedia(fileUrl, sampleUrl);
  return {
    siteId: site.id,
    id: String(raw.id),
    postUrl: `${base}/index.php?page=post&s=view&id=${raw.id}`,
    rating: toRating(raw.rating),
    score: numberOrNull(raw.score),
    tags: splitTags(raw.tags),
    artists: [],
    characters: [],
    copyrights: [],
    mediaUrl,
    fileUrl,
    mediaExt: extensionOf(mediaUrl),
    source: sourceUrl(raw.source),
  };
}

const gelbooru: BooruEngine = async (site, request) => {
  const params = new URLSearchParams({
    page: 'dapi',
    s: 'post',
    q: 'index',
    json: '1',
    limit: String(request.limit),
    tags: tagQuery(request.tags, [request.safe && site.safeTag, 'sort:random']),
  });
  if (request.credentials) {
    params.set('user_id', request.credentials.user);
    params.set('api_key', request.credentials.key);
  }
  const response = await requestJson(`${apiRoot(site)}/index.php?${params}`);
  if (!response.ok) throw failure(site, response);
  // An empty body means no results. A bare string is an error (Rule34 answers 200).
  if (!response.text.trim()) return [];
  if (response.data == null && isHtml(response.text)) {
    throw new BooruError(`${site.name} answered with a web page instead of results. It may be down or blocking bots.`);
  }
  if (typeof response.data === 'string' || response.data == null) {
    throw new BooruError(`${site.name}: ${String(response.data ?? response.text).slice(0, 200)}`);
  }
  const list = Array.isArray(response.data) ? response.data : response.data.post;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => mapGelbooruPost(site, raw)).filter(Boolean) as BooruPost[];
};

// ---------------------------------------------------------------------------
// Moebooru (yande.re, Konachan)
// ---------------------------------------------------------------------------

export function mapMoebooruPost(site: BooruSite, raw: any): BooruPost | null {
  if (!raw || raw.id == null || raw.status === 'deleted') return null;
  const base = site.baseUrl;
  const fileUrl = absoluteUrl(raw.file_url, base);
  if (!fileUrl) return null;
  const sampleUrl = absoluteUrl(raw.sample_url, base) || absoluteUrl(raw.jpeg_url, base);
  const mediaUrl = pickMedia(fileUrl, sampleUrl);
  return {
    siteId: site.id,
    id: String(raw.id),
    postUrl: `${base}/post/show/${raw.id}`,
    rating: toRating(raw.rating),
    score: numberOrNull(raw.score),
    tags: splitTags(raw.tags),
    artists: [],
    characters: [],
    copyrights: [],
    mediaUrl,
    fileUrl,
    mediaExt: extensionOf(mediaUrl),
    source: sourceUrl(raw.source),
  };
}

/** Extra random pages fetched when the first one comes back short. */
const MOEBOORU_EXTRA_RANDOM_PAGES = 2;

const moebooru: BooruEngine = async (site, request) => {
  const page = async (random: boolean): Promise<any[]> => {
    const params = new URLSearchParams({
      limit: String(request.limit),
      tags: tagQuery(request.tags, [request.safe && site.safeTag, random && 'order:random']),
    });
    const response = await requestJson(`${apiRoot(site)}/post.json?${params}`);
    if (!response.ok) throw failure(site, response);
    return Array.isArray(response.data) ? response.data : [];
  };

  // yande.re's `order:random` samples random ids and then applies the tags, so
  // a narrow query often returns a handful of posts, or none, even though
  // plenty match. A short page is topped up with more random pages, and when
  // those are all empty too, the newest matches are shuffled instead.
  let raw = await page(true);
  if (raw.length < request.limit) {
    const extra = await Promise.all(
      Array.from({ length: MOEBOORU_EXTRA_RANDOM_PAGES }, () => page(true).catch(() => [] as any[])),
    );
    raw = raw.concat(...extra);
    if (!raw.length) raw = shuffle(await page(false));
  }

  const seen = new Set<string>();
  const posts: BooruPost[] = [];
  for (const item of raw) {
    const post = mapMoebooruPost(site, item);
    if (post && !seen.has(post.id)) {
      seen.add(post.id);
      posts.push(post);
    }
  }
  return posts;
};

// ---------------------------------------------------------------------------
// e621 / e926
// ---------------------------------------------------------------------------

/** Artist tags that describe the post rather than name anyone. */
const E621_ARTIST_NOISE = new Set(['conditional_dnp', 'sound_warning', 'unknown_artist', 'avoid_posting', 'third-party_edit']);

export function mapE621Post(site: BooruSite, raw: any): BooruPost | null {
  if (!raw || raw.id == null || raw.flags?.deleted) return null;
  const base = site.baseUrl;
  const fileUrl = absoluteUrl(raw.file?.url, base);
  if (!fileUrl) return null;
  const sampleUrl = raw.sample?.has ? absoluteUrl(raw.sample?.url, base) : '';
  const mediaUrl = pickMedia(fileUrl, sampleUrl);
  const groups = raw.tags && typeof raw.tags === 'object' ? raw.tags : {};
  const group = (name: string) => (Array.isArray(groups[name]) ? groups[name].map(normalizeTag).filter(Boolean) : []);
  const tags = Object.keys(groups).flatMap(group);
  return {
    siteId: site.id,
    id: String(raw.id),
    postUrl: `${base}/posts/${raw.id}`,
    rating: toRating(raw.rating),
    score: numberOrNull(raw.score?.total),
    tags,
    artists: group('artist').filter((tag) => !E621_ARTIST_NOISE.has(tag)),
    characters: group('character'),
    copyrights: group('copyright'),
    mediaUrl,
    fileUrl,
    mediaExt: extensionOf(mediaUrl),
    source: sourceUrl(Array.isArray(raw.sources) ? raw.sources[0] : null),
  };
}

const e621: BooruEngine = async (site, request) => {
  const params = new URLSearchParams({
    limit: String(request.limit),
    tags: tagQuery(request.tags, [request.safe && site.safeTag, 'order:random']),
  });
  const response = await requestJson(`${apiRoot(site)}/posts.json?${params}`, basicAuth(request.credentials));
  if (!response.ok) throw failure(site, response);
  const list = response.data?.posts;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => mapE621Post(site, raw)).filter(Boolean) as BooruPost[];
};

// ---------------------------------------------------------------------------
// Philomena (Derpibooru, Furbooru, Manebooru, Twibooru)
// ---------------------------------------------------------------------------

const PHILOMENA_PAGE_MAX = 50;
/** Used when a site entry leaves the options out: Derpibooru's layout. */
const PHILOMENA_DEFAULTS: PhilomenaOptions = { api: 'v1', postPath: '/images/', allFilter: '56027' };

/** Philomena ratings are plain tags; the dark ones are never general. */
export function philomenaRating(tags: string[]): BooruRating {
  if (tags.includes('explicit')) return 'explicit';
  if (tags.includes('questionable') || tags.includes('grimdark') || tags.includes('grotesque')) return 'questionable';
  if (tags.includes('suggestive') || tags.includes('semi-grimdark')) return 'sensitive';
  if (tags.includes('safe')) return 'general';
  return 'explicit';
}

export function mapPhilomenaPost(site: BooruSite, raw: any): BooruPost | null {
  if (!raw || raw.id == null || raw.hidden_from_users || raw.deletion_reason || raw.duplicate_of) return null;
  // Twibooru also hosts text pastes, which have nothing to show.
  if (raw.media_type && raw.media_type !== 'image' && raw.media_type !== 'video') return null;
  const base = site.baseUrl;
  const postPath = (site.philomena ?? PHILOMENA_DEFAULTS).postPath;
  const reps = raw.representations || {};
  const fileUrl = absoluteUrl(reps.full || raw.view_url, base);
  if (!fileUrl) return null;
  const rawTags: string[] = Array.isArray(raw.tags) ? raw.tags.map((tag: unknown) => String(tag).toLowerCase()) : [];
  const mediaUrl = pickMedia(fileUrl, absoluteUrl(reps.large, base));
  return {
    siteId: site.id,
    id: String(raw.id),
    postUrl: `${base}${postPath}${raw.id}`,
    rating: philomenaRating(rawTags),
    score: numberOrNull(raw.score),
    tags: rawTags.map(normalizeTag).filter(Boolean),
    artists: rawTags.filter((tag) => tag.startsWith('artist:')).map((tag) => normalizeTag(tag.slice(7))),
    characters: [],
    copyrights: [],
    mediaUrl,
    fileUrl,
    mediaExt: extensionOf(mediaUrl),
    source: sourceUrl(raw.source_url),
  };
}

/** `rating:` values as the plain rating tags Philomena uses. */
const PHILOMENA_RATING_TAGS: Record<string, string> = {
  g: 'safe',
  general: 'safe',
  s: 'safe',
  safe: 'safe',
  sensitive: 'suggestive',
  suggestive: 'suggestive',
  q: 'questionable',
  questionable: 'questionable',
  e: 'explicit',
  explicit: 'explicit',
};

/**
 * Philomena tags contain spaces and are separated by commas; `_` in a query
 * means a space. `rating:e` style tokens become the site's rating tags.
 */
export function philomenaQuery(tags: string[], safe: boolean): string {
  const terms = tags.map((tag) => {
    const rating = tag.match(/^([-!]?)rating:(\w+)$/);
    if (rating && PHILOMENA_RATING_TAGS[rating[2]]) return `${rating[1]}${PHILOMENA_RATING_TAGS[rating[2]]}`;
    return tag.replace(/_/g, ' ');
  });
  if (safe) terms.push('safe');
  return terms.join(', ') || '*';
}

const philomena: BooruEngine = async (site, request) => {
  const options = site.philomena ?? PHILOMENA_DEFAULTS;
  const params = new URLSearchParams({
    q: philomenaQuery(request.tags, request.safe),
    sf: 'random',
    per_page: String(Math.min(request.limit, PHILOMENA_PAGE_MAX)),
  });
  // Every system filter except "Everything" hides explicit posts.
  const filter = request.safe ? options.safeFilter : options.allFilter;
  if (filter) params.set('filter_id', filter);
  if (request.credentials) params.set('key', request.credentials.key);
  const path = options.api === 'v3' ? '/api/v3/search/posts' : '/api/v1/json/search/images';
  const response = await requestJson(`${apiRoot(site)}${path}?${params}`);
  if (!response.ok) throw failure(site, response);
  const list = options.api === 'v3' ? response.data?.posts : response.data?.images;
  if (!Array.isArray(list)) return [];
  return list.map((raw) => mapPhilomenaPost(site, raw)).filter(Boolean) as BooruPost[];
};

// ---------------------------------------------------------------------------
// Shimmie (Rule34 Paheal), through its Danbooru 1.x compatible XML API
// ---------------------------------------------------------------------------

/** Posts per random page. Paheal has no random sort, so a page is picked from the match count. */
const SHIMMIE_PAGE_SIZE = 20;

/** Every `<tag .../>` element of a find_posts answer, as attribute maps. */
export function parseShimmiePosts(xml: string): { count: number; posts: Record<string, string>[] } {
  const count = Number(xml.match(/<posts\b[^>]*\bcount=['"](\d+)['"]/)?.[1] ?? 0);
  const posts: Record<string, string>[] = [];
  for (const element of xml.matchAll(/<tag\b([^>]*?)\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const [, name, double, single] of element[1].matchAll(/([a-z_]+)=(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[name] = decodeEntities(double ?? single ?? '');
    }
    posts.push(attrs);
  }
  return { count, posts };
}

export function mapShimmiePost(site: BooruSite, raw: Record<string, string>): BooruPost | null {
  if (!raw?.id) return null;
  const fileUrl = absoluteUrl(raw.file_url, site.baseUrl);
  if (!fileUrl) return null;
  // The CDN link has no extension; the original file name does.
  const nameExt = String(raw.file_name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase() ?? '';
  return {
    siteId: site.id,
    id: String(raw.id),
    postUrl: `${site.baseUrl}/post/view/${raw.id}`,
    rating: toRating(raw.rating),
    score: numberOrNull(raw.score),
    tags: splitTags(raw.tags),
    artists: [],
    characters: [],
    copyrights: [],
    mediaUrl: fileUrl,
    fileUrl,
    mediaExt: nameExt || extensionOf(fileUrl),
    source: sourceUrl(raw.source),
  };
}

async function shimmiePage(site: BooruSite, tags: string, page: number, limit: number) {
  const params = new URLSearchParams({ tags, limit: String(limit), page: String(page) });
  const response = await requestJson(`${apiRoot(site)}/api/danbooru/find_posts?${params}`);
  if (!response.ok) throw failure(site, response);
  // A query the site cannot run comes back as an HTML error page.
  if (!/^\s*(<\?xml[^>]*>\s*)?<posts\b/.test(response.text)) {
    throw new BooruError(`${site.name} could not run that search. Try fewer or simpler tags.`);
  }
  return parseShimmiePosts(response.text);
}

const shimmie: BooruEngine = async (site, request) => {
  // Paheal has no ratings: every post counts as explicit, so a safe search has nothing to find.
  if (request.safe) return [];
  // Nothing is rated there, so `rating:` tokens could only turn a search empty.
  const tags = request.tags.filter((tag) => !/^[-~]?rating:/.test(tag)).join(' ');
  const limit = Math.min(request.limit, SHIMMIE_PAGE_SIZE);
  const { count, posts: firstPage } = await shimmiePage(site, tags, 1, limit);
  if (!count) return [];
  const pages = Math.ceil(count / limit);
  const page = 1 + Math.floor(Math.random() * pages);
  const posts = page === 1 ? firstPage : (await shimmiePage(site, tags, page, limit)).posts;
  // A page is a run of neighbouring uploads; shuffle so `-n 3` is not three in a row.
  return shuffle(posts.map((raw) => mapShimmiePost(site, raw)).filter(Boolean) as BooruPost[]);
};

/**
 * Make one real API call with an account and throw a BooruError if the site
 * rejects it. Philomena ignores a bad key on searches, so its check reads the
 * account's own filters, which need a valid key.
 */
export async function verifyBooruCredentials(site: BooruSite, credentials: BooruCredentials): Promise<void> {
  if (site.engine === 'philomena') {
    const params = new URLSearchParams({ key: credentials.key });
    const response = await requestJson(`${apiRoot(site)}/api/v1/json/filters/user?${params}`);
    if (!response.ok) throw failure(site, response);
    return;
  }
  await ENGINES[site.engine](site, { tags: [], safe: false, limit: 1, credentials });
}

export const ENGINES: Record<BooruEngineId, BooruEngine> = {
  danbooru,
  gelbooru,
  moebooru,
  e621,
  philomena,
  shimmie,
};
