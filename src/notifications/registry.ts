/**
 * Provider registry — maps platform IDs to provider implementations.
 */

import type { NotificationProvider, PlatformId, ProviderInfo } from './types.js';
import { twitchProvider } from './providers/twitch.js';
import { pomfTvProvider } from './providers/pomftv.js';
import { xProvider } from './providers/x.js';
import { youtubeProvider } from './providers/youtube.js';
import { kickProvider } from './providers/kick.js';
import { blueskyProvider } from './providers/bluesky.js';
import { mastodonProvider } from './providers/mastodon.js';
import { redditProvider } from './providers/reddit.js';
import { rssProvider } from './providers/rss.js';
import { inkbunnyProvider } from './providers/inkbunny.js';

const providers: Record<PlatformId, NotificationProvider> = {
  twitch: twitchProvider,
  pomftv: pomfTvProvider,
  x: xProvider,
  youtube: youtubeProvider,
  kick: kickProvider,
  bluesky: blueskyProvider,
  mastodon: mastodonProvider,
  reddit: redditProvider,
  rss: rssProvider,
  inkbunny: inkbunnyProvider,
};

export function getProvider(id: PlatformId): NotificationProvider | undefined {
  return providers[id];
}

export function getAllProviders(): NotificationProvider[] {
  return Object.values(providers);
}

export function getProviderInfos(): ProviderInfo[] {
  return getAllProviders().map((p) => p.info);
}
