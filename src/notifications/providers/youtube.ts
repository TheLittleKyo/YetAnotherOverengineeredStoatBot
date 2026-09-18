/**
 * YouTube provider — checks for new videos from a channel.
 *
 * Uses the public Atom feed: https://www.youtube.com/feeds/videos.xml?channel_id=UC...
 *
 * For `@handle` or custom URLs, the caller must resolve to a channel_id first.
 * This provider accepts either a channel_id (starts with UC) or an @handle;
 * it resolves handles by scraping the channel page once and caching.
 */

import { fetchUrl, parseFeed, parseDate } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

const FEED_URL = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const CHANNEL_PAGE = 'https://www.youtube.com/';

// In-memory cache: handle -> channel_id
const handleCache = new Map<string, string>();

async function resolveChannelId(target: string): Promise<string | null> {
  const trimmed = extractIdFromUrl(target, ['youtube.com', 'youtu.be']).trim();
  if (!trimmed) return null;

  // Already a channel ID?
  if (/^UC[A-Za-z0-9_-]{22}$/.test(trimmed)) return trimmed;

  // @handle or /c/customname or /user/username
  let handle = trimmed;
  if (handle.startsWith('@')) handle = handle.slice(1);
  else if (handle.startsWith('youtube.com/')) handle = handle.replace(/^https?:\/\//, '').replace(/^youtube\.com\//, '');

  const cached = handleCache.get(handle.toLowerCase());
  if (cached) return cached;

  const pageUrl = `${CHANNEL_PAGE}@${handle}`;
  const result = await fetchUrl(pageUrl, {
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36' },
  });
  if (!result.ok) return null;

  const match = result.text.match(/"channelId":"(UC[A-Za-z0-9_-]{22})"/) || result.text.match(/channel_id=(UC[A-Za-z0-9_-]{22})/);
  if (match) {
    handleCache.set(handle.toLowerCase(), match[1]);
    return match[1];
  }
  return null;
}

export const youtubeProvider: NotificationProvider = {
  info: {
    id: 'youtube',
    label: 'YouTube',
    kind: 'posts',
    targetLabel: 'Channel ID or @handle',
    targetPlaceholder: '@MrBeast or UCX6OQ3DkcsbYNE6H8uQQuVA',
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const channelId = await resolveChannelId(sub.target);
    if (!channelId) {
      return { error: `Could not resolve YouTube channel: ${sub.target}. Use a channel_id (UC...) or @handle.` };
    }

    const result = await fetchUrl(`${FEED_URL}${encodeURIComponent(channelId)}`, {
      headers: { 'Accept': 'application/atom+xml, application/xml' },
    });
    if (!result.ok) return { error: `YouTube feed fetch failed (HTTP ${result.status})` };

    const entries = parseFeed(result.text);
    if (entries.length === 0) return { newPosts: [] };

    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];
    for (const entry of entries) {
      if (entry.guid && !seenSet.has(entry.guid)) {
        newPosts.push({
          guid: entry.guid,
          title: entry.title,
          url: entry.url || `https://www.youtube.com/watch?v=${entry.guid.replace(/^yt:video:/, '')}`,
          timestamp: parseDate(entry.timestamp)?.toISOString(),
          author: entry.author,
        });
      }
    }

    return { newPosts: newPosts.reverse() };
  },
};
