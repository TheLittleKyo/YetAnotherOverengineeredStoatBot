/**
 * Booru image search: query parsing, the content filter, each engine's post
 * mapping, the Danbooru tag-limit fallback (against a stubbed fetch), and the
 * per-server settings store, and the dashboard editor. Runs against a throwaway data directory, and lets
 * the SSRF guard skip DNS so the stubbed hosts never hit the network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-booru-'));
process.env.NOTIFY_ALLOW_PRIVATE_HOSTS = '1';

const { parseQuery, rejectPost, tagContains, normalizeBlacklist, toRating } = await import('../src/booru/safety.js');
const {
  ENGINES,
  mapDanbooruPost,
  mapE621Post,
  mapGelbooruPost,
  mapMoebooruPost,
  mapPhilomenaPost,
  philomenaQuery,
} = await import('../src/booru/engines.js');
const { findBooruSite, BOORU_SITE_COMMAND_NAMES } = await import('../src/booru/sites.js');
const { searchBooru, getBooruSettings, updateBooruSettings, mediaTypeFor, BOORU_SITES } = await import('../src/booru/index.js');
const { extractCount, describePost, renderSites } = await import('../src/commands/booru.js');
const { fetchUrl } = await import('../src/notifications/http.js');

const site = (id: string) => {
  const found = findBooruSite(id);
  assert.ok(found, `site ${id} exists`);
  return found;
};

function post(overrides: Record<string, unknown> = {}) {
  return {
    siteId: 'danbooru',
    id: '1',
    postUrl: 'https://danbooru.donmai.us/posts/1',
    rating: 'general' as const,
    score: 3,
    tags: ['1girl', 'cat_ears', 'solo'],
    artists: [],
    characters: [],
    copyrights: [],
    mediaUrl: 'https://cdn.donmai.us/sample/a.jpg',
    fileUrl: 'https://cdn.donmai.us/original/a.png',
    mediaExt: 'jpg',
    source: null,
    ...overrides,
  };
}

/** Swap `fetch` for a router over URL substrings for the length of one test. */
function stubFetch(t: any, routes: Array<[string, (url: string, init: any) => Response]>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: any }> = [];
  globalThis.fetch = (async (input: any, init: any) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find(([needle]) => url.includes(needle));
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route[1](url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
// Query parsing and filtering
// ---------------------------------------------------------------------------

test('parseQuery lowercases, dedupes and keeps negations', () => {
  const parsed = parseQuery(['Cat_Ears', 'cat_ears', '-Dog', '`solo`', ''], { safe: false });
  assert.deepEqual(parsed.tags, ['cat_ears', '-dog', 'solo']);
  assert.equal(parsed.blockedTag, null);
});

test('parseQuery drops rating tokens only in safe mode', () => {
  assert.deepEqual(parseQuery(['rating:e', 'fox'], { safe: true }), { tags: ['fox'], blockedTag: null, blockedEverywhere: false, droppedRating: true });
  assert.deepEqual(parseQuery(['rating:e', 'fox'], { safe: false }).tags, ['rating:e', 'fox']);
});

test('parseQuery allows all tags and keeps negations', () => {
  const parsed = parseQuery(['loli', 'oppai_loli', 'lol*', '~shota', '-child'], { safe: false });
  assert.deepEqual(parsed.tags, ['loli', 'oppai_loli', 'lol*', '~shota', '-child']);
  assert.equal(parsed.blockedTag, null);
  assert.equal(parsed.blockedEverywhere, false);
});

test('tagContains matches whole words only', () => {
  assert.equal(tagContains('oppai_loli', 'loli'), true);
  assert.equal(tagContains('goth-loli', 'loli'), true);
  assert.equal(tagContains('lolita_fashion', 'loli'), false);
  assert.equal(tagContains('shotgun', 'shota'), false);
  assert.equal(tagContains('elementary_school_student', 'elementary_school'), true);
  assert.equal(tagContains('anything', ''), false);
});

test('rejectPost enforces the safe rating, the blocklist and the server blacklist', () => {
  const open = { safe: false, blacklist: [] };
  assert.equal(rejectPost(post(), { safe: true, blacklist: [] }), null);
  assert.equal(rejectPost(post({ rating: 'sensitive' }), { safe: true, blacklist: [] }), 'rating');
  assert.equal(rejectPost(post({ rating: 'sensitive', tags: ['loli', 'panties'] }), open), null);
  assert.equal(rejectPost(post({ tags: ['loli'] }), { safe: true, blacklist: [] }), null);
  // Tags are no longer filtered by the built-in tag lists.
  assert.equal(rejectPost(post({ tags: ['child', 'park'] }), open), null);
  assert.equal(rejectPost(post({ rating: 'explicit', tags: ['young'] }), open), null);
  assert.equal(rejectPost(post({ tags: ['spider'] }), { safe: false, blacklist: ['spider'] }), 'blacklist');
  assert.equal(rejectPost(post({ mediaExt: 'swf' }), open), 'format');
});

test('normalizeBlacklist cleans untrusted input', () => {
  assert.deepEqual(normalizeBlacklist(['Spider', 'spider', '-gore', '  big eyes ', 42, null]), ['spider', 'gore', 'big_eyes', '42']);
  assert.deepEqual(normalizeBlacklist('nope'), []);
});

test('toRating maps three- and four-step scales', () => {
  assert.equal(toRating('safe'), 'general');
  assert.equal(toRating('s'), 'general');
  assert.equal(toRating('sensitive'), 'sensitive');
  assert.equal(toRating('q'), 'questionable');
  assert.equal(toRating('e'), 'explicit');
  assert.equal(toRating('???'), 'explicit');
});

// ---------------------------------------------------------------------------
// Engine mapping
// ---------------------------------------------------------------------------

test('Danbooru posts: s means sensitive, samples preferred, hidden files skipped', () => {
  const mapped = mapDanbooruPost(site('danbooru'), {
    id: 5,
    rating: 's',
    score: 10,
    tag_string: 'cat_ears solo hatsune_miku',
    tag_string_artist: 'some_artist',
    tag_string_character: 'hatsune_miku',
    tag_string_copyright: 'vocaloid',
    file_url: 'https://cdn.donmai.us/original/x.png',
    large_file_url: 'https://cdn.donmai.us/sample/x.jpg',
    file_ext: 'png',
    source: 'https://example.com/art',
  });
  assert.equal(mapped?.rating, 'sensitive');
  assert.equal(mapped?.mediaUrl, 'https://cdn.donmai.us/sample/x.jpg');
  assert.equal(mapped?.mediaExt, 'jpg');
  assert.equal(mapped?.postUrl, 'https://danbooru.donmai.us/posts/5');
  assert.deepEqual(mapped?.artists, ['some_artist']);

  assert.equal(mapDanbooruPost(site('danbooru'), { id: 6, rating: 'g' }), null);

  const gif = mapDanbooruPost(site('danbooru'), {
    id: 7,
    rating: 'g',
    file_url: 'https://cdn.donmai.us/original/y.gif',
    large_file_url: 'https://cdn.donmai.us/sample/y.jpg',
    file_ext: 'gif',
  });
  assert.equal(gif?.mediaUrl, 'https://cdn.donmai.us/original/y.gif');

  const ugoira = mapDanbooruPost(site('danbooru'), {
    id: 8,
    rating: 'g',
    file_url: 'https://cdn.donmai.us/original/z.zip',
    large_file_url: 'https://cdn.donmai.us/sample/z.webm',
    file_ext: 'zip',
  });
  assert.equal(ugoira?.mediaExt, 'webm');
});

test('Gelbooru posts: rebuilt file paths, decoded tags, first source link', () => {
  const mapped = mapGelbooruPost(site('tbib'), {
    id: 9,
    rating: 'general',
    directory: 4137,
    image: 'abc.png',
    sample: true,
    tags: 'cat_ears don&#039;t_care',
    source: 'not-a-link https://pixiv.net/1 https://x.com/2',
  });
  assert.equal(mapped?.fileUrl, 'https://tbib.org/images/4137/abc.png');
  assert.equal(mapped?.mediaUrl, 'https://tbib.org/samples/4137/sample_abc.jpg');
  assert.deepEqual(mapped?.tags, ['cat_ears', "don't_care"]);
  assert.equal(mapped?.source, 'https://pixiv.net/1');
  assert.equal(mapped?.postUrl, 'https://tbib.org/index.php?page=post&s=view&id=9');
});

test('Moebooru posts: protocol-relative links, deleted posts skipped', () => {
  const mapped = mapMoebooruPost(site('konachan'), {
    id: 10,
    rating: 's',
    tags: 'animal_ears',
    file_url: '//konachan.com/image/a.png',
    sample_url: '//konachan.com/sample/a.jpg',
  });
  assert.equal(mapped?.rating, 'general');
  assert.equal(mapped?.fileUrl, 'https://konachan.com/image/a.png');
  assert.equal(mapped?.mediaUrl, 'https://konachan.com/sample/a.jpg');
  assert.equal(mapMoebooruPost(site('konachan'), { id: 11, status: 'deleted', file_url: 'https://x/a.png' }), null);
});

test('e621 posts: grouped tags, noise artists dropped, hidden files skipped', () => {
  const mapped = mapE621Post(site('e621'), {
    id: 12,
    rating: 'q',
    score: { total: 40 },
    tags: { general: ['Fox'], artist: ['someone', 'conditional_dnp'], character: ['nick_wilde'], copyright: ['zootopia'] },
    file: { url: 'https://static1.e621.net/data/a.webm', ext: 'webm' },
    sample: { has: true, url: 'https://static1.e621.net/data/sample/a.jpg' },
    sources: ['https://example.com'],
  });
  assert.equal(mapped?.rating, 'questionable');
  assert.equal(mapped?.score, 40);
  assert.equal(mapped?.mediaUrl, 'https://static1.e621.net/data/a.webm');
  assert.deepEqual(mapped?.artists, ['someone']);
  assert.ok(mapped?.tags.includes('fox'));
  assert.equal(mapE621Post(site('e621'), { id: 13, file: { url: null } }), null);
});

test('Philomena posts: rating from tags, artist tags, query syntax', () => {
  const mapped = mapPhilomenaPost(site('derpibooru'), {
    id: 14,
    score: 5,
    tags: ['safe', 'twilight sparkle', 'artist:some one', 'grimdark'],
    representations: { full: 'https://derpicdn.net/full.png', large: 'https://derpicdn.net/large.png' },
  });
  assert.equal(mapped?.rating, 'questionable');
  assert.deepEqual(mapped?.artists, ['some_one']);
  assert.ok(mapped?.tags.includes('twilight_sparkle'));
  assert.equal(mapped?.mediaUrl, 'https://derpicdn.net/large.png');
  assert.equal(philomenaQuery(['twilight_sparkle', '-pinkie_pie'], true), 'twilight sparkle, -pinkie pie, safe');
  assert.equal(philomenaQuery([], false), '*');
});

// ---------------------------------------------------------------------------
// Engines over a stubbed fetch
// ---------------------------------------------------------------------------

const danbooruRaw = (id: number, rating = 'g', tags = 'cat_ears') => ({
  id,
  rating,
  tag_string: tags,
  file_url: `https://cdn.donmai.us/original/${id}.png`,
  large_file_url: `https://cdn.donmai.us/sample/${id}.jpg`,
  file_ext: 'png',
});

test('Danbooru falls back to single random posts when the tag limit is hit', async (t) => {
  let single = 0;
  const calls = stubFetch(t, [
    ['/posts.json', () => json({ success: false, error: 'PostQuery::TagLimitError', message: 'You cannot search for more than 2 tags at a time.' }, 422)],
    ['/posts/random.json', () => json(danbooruRaw(100 + (single++ % 2)))],
  ]);
  const posts = await ENGINES.danbooru(site('danbooru'), { tags: ['cat_ears', 'solo'], safe: true, limit: 30 });
  assert.deepEqual(posts.map((p) => p.id).sort(), ['100', '101']);
  const list = new URL(calls[0].url);
  assert.equal(list.searchParams.get('tags'), 'cat_ears solo rating:g random:30');
  const fallback = new URL(calls[1].url);
  assert.equal(fallback.searchParams.get('tags'), 'cat_ears solo rating:g');
});

test('Danbooru reports the tag limit when even single posts refuse the query', async (t) => {
  stubFetch(t, [
    ['/posts', () => json({ success: false, error: 'PostQuery::TagLimitError', message: 'You cannot search for more than 2 tags at a time.' }, 422)],
  ]);
  await assert.rejects(
    ENGINES.danbooru(site('danbooru'), { tags: ['a', 'b', 'c'], safe: false, limit: 30 }),
    /more than 2 tags.*dashboard Booru tab/,
  );
});

test('Danbooru treats a 404 from the random fallback as no results', async (t) => {
  stubFetch(t, [
    ['/posts.json', () => json({ error: 'PostQuery::TagLimitError' }, 422)],
    ['/posts/random.json', () => json({ success: false, message: 'That record was not found.' }, 404)],
  ]);
  assert.deepEqual(await ENGINES.danbooru(site('danbooru'), { tags: ['a', 'b'], safe: false, limit: 30 }), []);
});

test('Gelbooru engine handles an empty body, a wrapped list and a bare error string', async (t) => {
  let body = '';
  stubFetch(t, [['safebooru.org', () => new Response(body, { status: 200 })]]);
  assert.deepEqual(await ENGINES.gelbooru(site('safebooru'), { tags: ['x'], safe: true, limit: 5 }), []);

  body = JSON.stringify({ '@attributes': { count: 1 }, post: [{ id: 1, rating: 'general', file_url: 'https://safebooru.org/images/1/a.jpg', tags: 'a' }] });
  const posts = await ENGINES.gelbooru(site('safebooru'), { tags: ['x'], safe: true, limit: 5 });
  assert.equal(posts[0]?.id, '1');

  body = JSON.stringify('Missing authentication.');
  await assert.rejects(ENGINES.gelbooru(site('safebooru'), { tags: ['x'], safe: true, limit: 5 }), /Missing authentication/);
});

test('searchBooru filters candidates and counts what it hid', async (t) => {
  stubFetch(t, [
    ['/posts.json', () => json([
      danbooruRaw(1, 'g', 'cat_ears loli'),
      danbooruRaw(2, 'g', 'cat_ears spider'),
      danbooruRaw(3, 'g', 'cat_ears'),
      danbooruRaw(4, 'g', 'cat_ears'),
    ])],
  ]);
  const result = await searchBooru(site('danbooru'), { tags: ['cat_ears'], safe: true, count: 1, blacklist: ['spider'] });
  assert.deepEqual(result.posts.map((p) => p.id), ['1']);
  assert.equal(result.hidden, 1);
});

test('fetchUrl drops Authorization when a redirect leaves the origin', async (t) => {
  const calls = stubFetch(t, [
    ['https://api.example.test/start', () => new Response(null, { status: 302, headers: { location: 'https://cdn.other.test/file' } })],
    ['https://cdn.other.test/file', () => new Response('ok', { status: 200 })],
  ]);
  const result = await fetchUrl('https://api.example.test/start', { headers: { Authorization: 'Basic secret' } });
  assert.equal(result.text, 'ok');
  assert.equal(calls[0].init.headers.Authorization, 'Basic secret');
  assert.equal(calls[1].init.headers.Authorization, undefined);
});

// ---------------------------------------------------------------------------
// Command helpers and settings
// ---------------------------------------------------------------------------

test('extractCount reads every flag spelling and clamps', () => {
  assert.deepEqual(extractCount(['cat', '-n', '3']), { count: 3, rest: ['cat'] });
  assert.deepEqual(extractCount(['--count=9', 'cat']), { count: 5, rest: ['cat'] });
  assert.deepEqual(extractCount(['-n', 'cat']), { count: 1, rest: ['-n', 'cat'] });
  assert.deepEqual(extractCount(['-n=0']), { count: 1, rest: [] });
});

test('describePost stays under the embed limit and neutralizes mentions', () => {
  const tags = Array.from({ length: 400 }, (_, i) => `tag_number_${i}_with_a_long_name`);
  const text = describePost(
    post({ tags: [...tags, '<@everyone>'], artists: ['*bold*_artist'], source: 'https://example.com/a (b)' }),
  );
  assert.ok(text.length <= 2000);
  assert.match(text, /\*\*Artist:\*\* bold artist/);
  assert.match(text, /\[Source\]\(https:\/\/example\.com\/a%20%28b%29\)/);
  assert.match(text, /\+\d+ more/);
  assert.equal(describePost(post({ tags: ['<@01ABC>'] })).includes('<@01ABC>'), false);
});

test('settings default, persist per server and reject unknown sites', () => {
  assert.deepEqual(getBooruSettings('srvA'), { serverId: 'srvA', nsfw: true, blacklist: [], disabledSites: [] });
  updateBooruSettings('srvA', () => ({ nsfw: false, blacklist: ['Gore'], disabledSites: ['r34', 'nope', 'rule34'] }));
  updateBooruSettings('srvB', () => ({ blacklist: ['spider'] }));
  assert.deepEqual(getBooruSettings('srvA'), { serverId: 'srvA', nsfw: false, blacklist: ['gore'], disabledSites: ['rule34'] });
  assert.deepEqual(getBooruSettings('srvB').blacklist, ['spider']);
  assert.equal(getBooruSettings('').nsfw, true);
});

test('site shortcuts are plain command names', () => {
  for (const name of ['danbooru', 'db', 'r34', 'e621', 'e926', 'derpi', 'paheal', 'r34p', 'furbooru', 'mane', 'twi', 'e6ai', 'atfbooru', 'atf', 'allthefallen']) assert.ok(BOORU_SITE_COMMAND_NAMES.includes(name), name);
  assert.equal(BOORU_SITE_COMMAND_NAMES.includes('yande.re'), false);
});

test('AllTheFallen uses the Danbooru API and is NSFW-only', async (t) => {
  const calls = stubFetch(t, [['booru.allthefallen.moe', () => json([])]]);
  const atf = site('atf');
  assert.equal(atf.id, 'atfbooru');
  assert.equal(atf.nsfwOnly, true);
  assert.equal(atf.engine, 'danbooru');

  await ENGINES.danbooru(atf, { tags: ['character_tag'], safe: false, limit: 5 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, '/posts.json');
  assert.equal(url.searchParams.get('limit'), '5');
  assert.match(url.searchParams.get('tags') || '', /character_tag/);
  assert.match(url.searchParams.get('tags') || '', /random:5/);
});

test('Danbooru reports an HTML challenge instead of treating HTTP 200 as results', async (t) => {
  stubFetch(t, [['booru.allthefallen.moe', () => new Response('<!doctype html><html><body>Verification</body></html>')]]);
  await assert.rejects(
    ENGINES.danbooru(site('atfbooru'), { tags: [], safe: false, limit: 1 }),
    /web page instead of API results/,
  );
});

test('Danbooru accepts textual rating names while unknown ratings remain explicit', () => {
  const atf = site('atfbooru');
  const base = {
    id: 1,
    file_url: 'https://cdn.example.test/a.jpg',
    tag_string: '',
  };
  assert.equal(mapDanbooruPost(atf, { ...base, rating: 'general' })?.rating, 'general');
  assert.equal(mapDanbooruPost(atf, { ...base, rating: 'sensitive' })?.rating, 'sensitive');
  assert.equal(mapDanbooruPost(atf, { ...base, rating: 'unknown' })?.rating, 'explicit');
});

// ---------------------------------------------------------------------------
// Dashboard editor: accounts are owner-only and keys never leave the server
// ---------------------------------------------------------------------------

const { Readable } = await import('node:stream');
const { readFileSync } = await import('node:fs');
const { handleBooruEditorRequest } = await import('../src/booru-editor.js');
const { getBooruCredentials } = await import('../src/booru/accounts.js');
const { isSiteConfigured } = await import('../src/booru/sites.js');

async function callEditor(method: string, url: string, body?: unknown, ctx: Record<string, unknown> = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request: any = Readable.from(chunks);
  request.method = method;
  request.url = url;
  request.headers = { host: 'localhost' };
  let status = 0;
  let text = '';
  const response: any = {
    writeHead: (code: number) => {
      status = code;
    },
    setHeader: () => {},
    end: (chunk?: string) => {
      text = chunk || '';
    },
  };
  await handleBooruEditorRequest(request, response, { client: {}, serverId: 'srvEditor', ...ctx });
  return { status, text, json: text ? JSON.parse(text) : null };
}

test('editor saves server settings and drops unknown sites', async () => {
  const result = await callEditor('POST', '/api/settings', { nsfw: false, blacklist: ['Gore', 'gore'], disabledSites: ['xbooru', 'bogus'] });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.settings, { serverId: 'srvEditor', nsfw: false, blacklist: ['gore'], disabledSites: ['xbooru'] });
});

test('guests get no accounts and cannot change them', async () => {
  const config = await callEditor('GET', '/api/config', undefined, { guest: true });
  assert.equal(config.json.accounts, null);
  assert.equal(Object.prototype.hasOwnProperty.call(config.json.sites.find((s: any) => s.id === 'gelbooru'), 'configured'), false);
  const save = await callEditor('POST', '/api/accounts/gelbooru', { user: '1', key: 'k', force: true }, { guest: true });
  assert.equal(save.status, 403);
  const remove = await callEditor('DELETE', '/api/accounts/gelbooru', undefined, { guest: true });
  assert.equal(remove.status, 403);
});

test('a key that fails the check is not saved unless forced', async (t) => {
  stubFetch(t, [['gelbooru.com', () => new Response('', { status: 401 })]]);
  const refused = await callEditor('POST', '/api/accounts/gelbooru', { user: '123', key: 'wrong-key' });
  assert.equal(refused.status, 400);
  assert.equal(refused.json.canForce, true);
  assert.equal(refused.json.error, 'Gelbooru rejected these credentials (HTTP 401).');
  assert.equal(getBooruCredentials('gelbooru'), null);
  assert.equal(isSiteConfigured(site('gelbooru')), false);
});

test('a verified key is stored encrypted and never returned', async (t) => {
  const calls = stubFetch(t, [['gelbooru.com', () => new Response('', { status: 200 })]]);
  const saved = await callEditor('POST', '/api/accounts/gelbooru', { user: '123', key: 'super-secret-key-value' });
  assert.equal(saved.status, 200);
  assert.equal(new URL(calls[0].url).searchParams.get('api_key'), 'super-secret-key-value');
  assert.equal(saved.json.account.state, 'stored');
  assert.equal(saved.json.account.user, '123');
  assert.equal(saved.text.includes('super-secret-key-value'), false);

  const config = await callEditor('GET', '/api/config');
  assert.equal(config.text.includes('super-secret-key-value'), false);
  assert.equal(config.json.sites.find((s: any) => s.id === 'gelbooru').configured, true);

  const onDisk = readFileSync(join(process.env.YAOSB_DATA_DIR!, 'secrets.json'), 'utf-8');
  assert.equal(onDisk.includes('super-secret-key-value'), false);
  assert.deepEqual(getBooruCredentials('gelbooru'), { user: '123', key: 'super-secret-key-value' });

  // Searches pick the saved account up.
  const search = stubFetch(t, [['gelbooru.com', () => new Response('', { status: 200 })]]);
  await searchBooru(site('gelbooru'), { tags: ['x'], safe: true, count: 1, blacklist: [] });
  assert.equal(new URL(search[0].url).searchParams.get('user_id'), '123');

  const removed = await callEditor('DELETE', '/api/accounts/gelbooru');
  assert.equal(removed.json.account.state, 'missing');
  assert.equal(getBooruCredentials('gelbooru'), null);
});

test('forced saves skip the check; bad input is refused first', async (t) => {
  const calls = stubFetch(t, []);
  const forced = await callEditor('POST', '/api/accounts/rule34', { user: '5', key: 'offline-key', force: true });
  assert.equal(forced.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(isSiteConfigured(site('rule34')), true);

  assert.equal((await callEditor('POST', '/api/accounts/rule34', { user: 'abc', key: 'k', force: true })).status, 400);
  assert.equal((await callEditor('POST', '/api/accounts/danbooru', { user: '', key: 'k', force: true })).status, 400);
  assert.equal((await callEditor('POST', '/api/accounts/nope', { user: '1', key: 'k' })).status, 404);
});

test('Derpibooru keys are checked against the account filters endpoint', async (t) => {
  const calls = stubFetch(t, [['derpibooru.org', () => json({ filters: [] })]]);
  const saved = await callEditor('POST', '/api/accounts/derpibooru', { key: 'derpi-key' });
  assert.equal(saved.status, 200);
  assert.match(calls[0].url, /\/api\/v1\/json\/filters\/user\?key=derpi-key$/);
});

// ---------------------------------------------------------------------------
// Shimmie (Rule34 Paheal) and the Philomena variants
// ---------------------------------------------------------------------------

const { parseShimmiePosts, mapShimmiePost } = await import('../src/booru/engines.js');

const PAHEAL_XML = `<posts count='45' offset='0'><tag id='7449461' md5='89f1' file_name='IMG_1483.png' file_url='https://r34i.paheal-cdn.net/89/f1/89f1' rating='?' tags='Porkyman Tsareena Don&#039;t_Stop' source='https://example.com/a https://example.com/b' score='3' author='x'></tag><tag id="2" file_name="clip.MP4" file_url="https://r34i.paheal-cdn.net/aa/bb/aabb" tags="loli" rating="?"/></posts>`;

test('parseShimmiePosts reads the count and both quote styles', () => {
  const { count, posts } = parseShimmiePosts(PAHEAL_XML);
  assert.equal(count, 45);
  assert.equal(posts.length, 2);
  assert.equal(posts[0].tags, "Porkyman Tsareena Don't_Stop");
  assert.equal(posts[1].file_name, 'clip.MP4');
  assert.deepEqual(parseShimmiePosts("<posts count='0' offset='0'></posts>"), { count: 0, posts: [] });
});

test('Paheal posts take the extension from the file name and count as explicit', () => {
  const [first, second] = parseShimmiePosts(PAHEAL_XML).posts.map((raw) => mapShimmiePost(site('paheal'), raw));
  assert.equal(first?.mediaExt, 'png');
  assert.equal(first?.rating, 'explicit');
  assert.equal(first?.postUrl, 'https://rule34.paheal.net/post/view/7449461');
  assert.deepEqual(first?.tags, ['porkyman', 'tsareena', "don't_stop"]);
  assert.equal(first?.source, 'https://example.com/a');
  assert.equal(second?.mediaExt, 'mp4');
  assert.equal(rejectPost(second!, { safe: false, blacklist: [] }), null);
});

test('Paheal engine picks a random page from the match count', async (t) => {
  const calls = stubFetch(t, [
    ['find_posts', () => new Response(PAHEAL_XML.replace("count='45'", "count='100'"), { status: 200 })],
  ]);
  const original = Math.random;
  Math.random = () => 0.99;
  t.after(() => {
    Math.random = original;
  });
  const posts = await ENGINES.shimmie(site('paheal'), { tags: ['pokemon'], safe: false, limit: 30 });
  assert.equal(posts.length, 2);
  const first = new URL(calls[0].url).searchParams;
  assert.equal(first.get('limit'), '20');
  assert.equal(first.get('page'), '1');
  // 100 matches at 20 per page: pages 1-5, and 0.99 lands on the last one.
  assert.equal(new URL(calls[1].url).searchParams.get('page'), '5');
  assert.deepEqual(await ENGINES.shimmie(site('paheal'), { tags: [], safe: true, limit: 30 }), []);
});

test('Paheal reports a query it cannot run', async (t) => {
  stubFetch(t, [['find_posts', () => new Response('<!doctype html><title>Error</title>', { status: 200 })]]);
  await assert.rejects(ENGINES.shimmie(site('paheal'), { tags: ['a'], safe: false, limit: 5 }), /could not run that search/);
});

test('Philomena sites use their own API path, filters and post links', async (t) => {
  const image = { id: 9, tags: ['explicit'], representations: { full: 'https://cdn.example/full.png' } };
  const calls = stubFetch(t, [
    ['twibooru.org', () => json({ posts: [image, { ...image, id: 10, media_type: 'paste' }] })],
    ['furbooru.org', () => json({ images: [image] })],
  ]);

  const twi = await ENGINES.philomena(site('twibooru'), { tags: ['princess_luna'], safe: false, limit: 5 });
  assert.deepEqual(twi.map((p) => p.postUrl), ['https://twibooru.org/9']);
  const twiUrl = new URL(calls[0].url);
  assert.equal(twiUrl.pathname, '/api/v3/search/posts');
  assert.equal(twiUrl.searchParams.get('filter_id'), '2');

  await ENGINES.philomena(site('twibooru'), { tags: [], safe: true, limit: 5 });
  assert.equal(new URL(calls[1].url).searchParams.has('filter_id'), false);

  const fur = await ENGINES.philomena(site('furbooru'), { tags: ['fox'], safe: true, limit: 5 });
  assert.equal(fur[0]?.postUrl, 'https://furbooru.org/images/9');
  const furUrl = new URL(calls[2].url);
  assert.equal(furUrl.pathname, '/api/v1/json/search/images');
  assert.equal(furUrl.searchParams.get('filter_id'), '1');
  assert.equal(furUrl.searchParams.get('q'), 'fox, safe');
});

// ---------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------

const moebooruRaw = (id: number) => ({
  id,
  rating: 's',
  tags: 'animal_ears',
  file_url: `https://files.yande.re/image/${id}.jpg`,
  sample_url: `https://files.yande.re/sample/${id}.jpg`,
});

test('yande.re short random pages are topped up, and empty ones fall back to the newest posts', async (t) => {
  let randomCall = 0;
  const calls = stubFetch(t, [
    ['yande.re', (url) => {
      const random = new URL(url).searchParams.get('tags')!.includes('order:random');
      if (!random) return json([moebooruRaw(7), moebooruRaw(8)]);
      randomCall++;
      return json(randomCall === 1 ? [moebooruRaw(1)] : randomCall === 2 ? [moebooruRaw(1), moebooruRaw(2)] : []);
    }],
  ]);
  const topped = await ENGINES.moebooru(site('yandere'), { tags: ['animal_ears'], safe: true, limit: 30 });
  assert.deepEqual(topped.map((p) => p.id).sort(), ['1', '2']);
  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[0].url).searchParams.get('tags'), 'animal_ears rating:s order:random');

  const fallback = await ENGINES.moebooru(site('yandere'), { tags: ['animal_ears'], safe: true, limit: 30 });
  assert.deepEqual(fallback.map((p) => p.id).sort(), ['7', '8']);
  assert.equal(new URL(calls.at(-1)!.url).searchParams.get('tags'), 'animal_ears rating:s');
});

test('a full random page needs no extra calls', async (t) => {
  const calls = stubFetch(t, [['konachan.com', () => json(Array.from({ length: 5 }, (_, i) => moebooruRaw(i + 1)))]]);
  const posts = await ENGINES.moebooru(site('konachan'), { tags: [], safe: false, limit: 5 });
  assert.equal(posts.length, 5);
  assert.equal(calls.length, 1);
});

test('downloads trust only image and video types, or the extension when untyped', () => {
  assert.equal(mediaTypeFor('image/png', 'jpg'), 'image/png');
  assert.equal(mediaTypeFor('image/jpg', 'jpg'), 'image/jpeg');
  assert.equal(mediaTypeFor('', 'webm'), 'video/webm');
  assert.equal(mediaTypeFor('application/octet-stream', 'png'), 'image/png');
  assert.equal(mediaTypeFor('text/html', 'jpg'), null);
  assert.equal(mediaTypeFor('image/svg+xml', 'png'), null);
  assert.equal(mediaTypeFor('', 'swf'), null);
});

test('built-in tag blocking is disabled', () => {
  assert.equal(parseQuery(['loli'], { safe: false }).blockedEverywhere, false);
  assert.equal(parseQuery(['young'], { safe: false }).blockedTag, null);
  assert.equal(parseQuery(['young'], { safe: true }).blockedTag, null);
  assert.equal(parseQuery(['cat_ears'], { safe: false }).blockedEverywhere, false);
});

test('any non-alphanumeric character separates words in the filter', () => {
  assert.equal(tagContains('loli+', 'loli'), true);
  assert.equal(tagContains('loli&shota', 'shota'), true);
  assert.equal(tagContains('lolita_fashion', 'loli'), false);
  assert.equal(rejectPost(post({ tags: ['oppai_loli;'] }), { safe: false, blacklist: [] }), null);
});

test('the site list stays under the message limit with every site turned off', () => {
  const parts = renderSites({ serverId: 's', nsfw: true, blacklist: [], disabledSites: BOORU_SITES.map((s) => s.id) });
  assert.ok(parts.length >= 1);
  for (const part of parts) assert.ok(part.length <= 2000, `part is ${part.length} characters`);
  const joined = parts.join('\n');
  for (const s of BOORU_SITES) assert.ok(joined.includes(`**${s.name}**`), s.name);
});

test('Philomena turns rating tokens into its rating tags', () => {
  assert.equal(philomenaQuery(['rating:e', '-rating:q', 'twilight_sparkle'], false), 'explicit, -questionable, twilight sparkle');
  assert.equal(philomenaQuery(['rating:s'], false), 'safe');
});

test('Paheal drops rating tokens it cannot use', async (t) => {
  const calls = stubFetch(t, [['paheal.net', () => new Response('<posts count="0" offset="0"></posts>')]]);
  await ENGINES.shimmie(site('paheal'), { tags: ['rating:e', 'pokemon'], safe: false, limit: 20 });
  assert.equal(new URL(calls[0].url).searchParams.get('tags'), 'pokemon');
});

test('Gelbooru reports a web page answer plainly', async (t) => {
  stubFetch(t, [['safebooru.org', () => new Response('<!DOCTYPE html><html><body>Just a moment...</body></html>')]]);
  await assert.rejects(ENGINES.gelbooru(site('safebooru'), { tags: [], safe: true, limit: 5 }), /web page instead of results/);
});

test('Danbooru fallback uses a successful single even when the first one failed', async (t) => {
  let single = 0;
  stubFetch(t, [
    ['/posts.json', () => json({ error: 'PostQuery::TagLimitError' }, 422)],
    ['/posts/random.json', () => (single++ === 0 ? json({ message: 'timeout' }, 500) : json(danbooruRaw(5)))],
  ]);
  const posts = await ENGINES.danbooru(site('danbooru'), { tags: ['a', 'b'], safe: false, limit: 30 });
  assert.deepEqual(posts.map((p) => p.id), ['5']);
});
