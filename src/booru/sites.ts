/**
 * Every booru the bot can search. Adding a site running one of the supported
 * engines is one entry here.
 */
import { getBooruCredentials } from './accounts.js';
import type { BooruSite } from './types.js';

export const BOORU_SITES: BooruSite[] = [
  {
    id: 'danbooru',
    name: 'Danbooru',
    aliases: ['dan', 'db'],
    engine: 'danbooru',
    baseUrl: 'https://danbooru.donmai.us',
    description: 'Anime art, strict tagging. Two tags per search without a Gold account.',
    account: 'danbooru',
  },
  {
    id: 'safebooru',
    name: 'Safebooru',
    aliases: ['sb'],
    engine: 'gelbooru',
    baseUrl: 'https://safebooru.org',
    description: 'Anime art, work-safe focus.',
    safeTag: 'rating:general',
  },
  {
    id: 'gelbooru',
    name: 'Gelbooru',
    aliases: ['gel', 'gb'],
    engine: 'gelbooru',
    baseUrl: 'https://gelbooru.com',
    description: 'Large anime art archive.',
    safeTag: 'rating:general',
    account: 'gelbooru',
    requiresCredentials: true,
  },
  {
    id: 'tbib',
    name: 'TBIB',
    aliases: ['bigbooru'],
    engine: 'gelbooru',
    baseUrl: 'https://tbib.org',
    description: 'The Big ImageBoard, a mirror of many boorus.',
    safeTag: 'rating:general',
  },
  {
    id: 'yandere',
    name: 'yande.re',
    aliases: ['yande', 'yande.re'],
    engine: 'moebooru',
    baseUrl: 'https://yande.re',
    description: 'High-resolution scans and illustrations.',
    safeTag: 'rating:s',
  },
  {
    id: 'konachan',
    name: 'Konachan',
    aliases: ['kona'],
    engine: 'moebooru',
    baseUrl: 'https://konachan.com',
    description: 'Anime wallpapers.',
    safeTag: 'rating:s',
  },
  {
    id: 'e926',
    name: 'e926',
    aliases: [],
    engine: 'e621',
    baseUrl: 'https://e926.net',
    // Same database as e621. e926.net puts Node's fetch behind a Cloudflare
    // challenge, so the search goes through e621 with the safe rating forced.
    apiUrl: 'https://e621.net',
    description: 'Furry art, safe only (the SFW side of e621).',
    safeOnly: true,
    safeTag: 'rating:s',
    account: 'e621',
  },
  {
    id: 'e621',
    name: 'e621',
    aliases: [],
    engine: 'e621',
    baseUrl: 'https://e621.net',
    description: 'Furry art, all ratings.',
    safeTag: 'rating:s',
    account: 'e621',
  },
  {
    id: 'derpibooru',
    name: 'Derpibooru',
    aliases: ['derpi'],
    engine: 'philomena',
    baseUrl: 'https://derpibooru.org',
    description: 'My Little Pony art. Tags use spaces; type them with underscores.',
    philomena: { api: 'v1', postPath: '/images/', safeFilter: '100073', allFilter: '56027' },
    account: 'derpibooru',
  },
  {
    id: 'manebooru',
    name: 'Manebooru',
    aliases: ['mane'],
    engine: 'philomena',
    baseUrl: 'https://manebooru.art',
    description: 'My Little Pony art, all ratings. Tags use spaces; type them with underscores.',
    philomena: { api: 'v1', postPath: '/images/', safeFilter: '1', allFilter: '2' },
  },
  {
    id: 'twibooru',
    name: 'Twibooru',
    aliases: ['twi'],
    engine: 'philomena',
    baseUrl: 'https://twibooru.org',
    description: 'My Little Pony art archive, all ratings. Tags use spaces; type them with underscores.',
    philomena: { api: 'v3', postPath: '/', allFilter: '2' },
  },
  {
    id: 'furbooru',
    name: 'Furbooru',
    aliases: ['furbu'],
    engine: 'philomena',
    baseUrl: 'https://furbooru.org',
    description: 'Furry art, all ratings. Tags use spaces; type them with underscores.',
    philomena: { api: 'v1', postPath: '/images/', safeFilter: '1', allFilter: '2' },
  },
  {
    id: 'e6ai',
    name: 'e6AI',
    aliases: [],
    engine: 'e621',
    baseUrl: 'https://e6ai.net',
    description: 'AI-generated furry art, all ratings (e621 sister site).',
    safeTag: 'rating:s',
  },
  {
    id: 'atfbooru',
    name: 'AllTheFallen',
    aliases: ['atf', 'allthefallen'],
    engine: 'danbooru',
    baseUrl: 'https://booru.allthefallen.moe',
    description: 'AllTheFallen imageboard, using its Danbooru-compatible API.',
    nsfwOnly: true,
  },
  {
    id: 'rule34',
    name: 'Rule34',
    aliases: ['r34'],
    engine: 'gelbooru',
    baseUrl: 'https://rule34.xxx',
    apiUrl: 'https://api.rule34.xxx',
    description: 'Adult fan art of everything.',
    nsfwOnly: true,
    account: 'rule34',
    requiresCredentials: true,
  },
  {
    id: 'paheal',
    name: 'Rule34 Paheal',
    aliases: ['r34p'],
    engine: 'shimmie',
    baseUrl: 'https://rule34.paheal.net',
    description: 'Adult fan art. Tags are case-insensitive; some use odd names (Porkyman for Pokemon).',
    nsfwOnly: true,
  },
  {
    id: 'xbooru',
    name: 'Xbooru',
    aliases: [],
    engine: 'gelbooru',
    baseUrl: 'https://xbooru.com',
    description: 'Adult art.',
    nsfwOnly: true,
  },
  {
    id: 'hypnohub',
    name: 'Hypnohub',
    aliases: [],
    engine: 'gelbooru',
    baseUrl: 'https://hypnohub.net',
    description: 'Hypnosis-themed art, mostly adult.',
    nsfwOnly: true,
  },
];

const BY_NAME = new Map<string, BooruSite>();
for (const site of BOORU_SITES) {
  for (const name of [site.id, ...site.aliases]) BY_NAME.set(name.toLowerCase(), site);
}

export function findBooruSite(name: string): BooruSite | null {
  return BY_NAME.get(String(name || '').trim().toLowerCase()) ?? null;
}

/** Whether the site can be queried with the accounts saved right now. */
export function isSiteConfigured(site: BooruSite): boolean {
  return !site.requiresCredentials || Boolean(getBooruCredentials(site.account));
}

/** Every name that works as a command on its own (`!danbooru`, `!r34`). */
export const BOORU_SITE_COMMAND_NAMES = [...BY_NAME.keys()].filter((name) => /^[a-z0-9]+$/.test(name));
