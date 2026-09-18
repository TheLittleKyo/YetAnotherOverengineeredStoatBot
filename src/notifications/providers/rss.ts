/**
 * Generic RSS/Atom provider — monitors any RSS or Atom feed.
 *
 * The target is the full feed URL. Uses the shared feed parser that handles
 * both RSS 2.0 (<item>) and Atom 1.0 (<entry>).
 */

import { fetchUrl, parseFeed, parseDate } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';

export const rssProvider: NotificationProvider = {
  info: {
    id: 'rss',
    label: 'RSS / Atom Feed',
    kind: 'posts',
    targetLabel: 'Feed URL',
    targetPlaceholder: 'https://example.com/feed.xml',
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const feedUrl = sub.target.trim();
    if (!feedUrl) return { error: 'Missing feed URL' };

    if (!/^https?:\/\//i.test(feedUrl)) {
      return { error: 'Feed URL must start with http:// or https://' };
    }

    const result = await fetchUrl(feedUrl, {
      headers: {
        'Accept': 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8',
      },
    });

    if (!result.ok) {
      return { error: `Feed fetch failed (HTTP ${result.status})` };
    }

    const entries = parseFeed(result.text);
    if (entries.length === 0) return { newPosts: [] };

    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];

    for (const entry of entries) {
      const guid = entry.guid || entry.url || '';
      if (!guid) continue;
      if (seenSet.has(guid)) continue;

      newPosts.push({
        guid,
        title: entry.title,
        url: entry.url || guid,
        timestamp: parseDate(entry.timestamp)?.toISOString(),
        snippet: entry.content ? entry.content.replace(/<[^>]+>/g, '').slice(0, 280) : undefined,
        author: entry.author,
      });
    }

    return { newPosts: newPosts.reverse() };
  },
};
