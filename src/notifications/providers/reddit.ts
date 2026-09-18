/**
 * Reddit provider — checks for new posts.
 *
 * Uses the public RSS feed: https://www.reddit.com/user/<user>/.rss or /r/<sub>/new.rss
 * A descriptive User-Agent is required (Reddit blocks default curl UAs).
 *
 * Rate limits are very tight (~1 req per 30-60s unauthenticated). The scheduler
 * polls at most every 3 minutes for Reddit subscriptions.
 *
 * Target can be:
 *   - u/<username>  → user posts
 *   - r/<subreddit> → subreddit new posts
 *   - <subreddit>   → subreddit new posts (default)
 */

import { fetchUrl, parseFeed, parseDate } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

const REDDIT_BASE = 'https://www.reddit.com';

export const redditProvider: NotificationProvider = {
  info: {
    id: 'reddit',
    label: 'Reddit',
    kind: 'posts',
    targetLabel: 'Subreddit (r/name) or user (u/name)',
    targetPlaceholder: 'r/programming or u/spez',
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const target = extractIdFromUrl(sub.target, ['reddit.com']).trim();
    if (!target) return { error: 'Missing target' };

    let feedPath: string;
    if (target.startsWith('u/')) {
      feedPath = `/user/${encodeURIComponent(target.slice(2))}.rss?limit=25`;
    } else if (target.startsWith('r/')) {
      feedPath = `/r/${encodeURIComponent(target.slice(2))}/new.rss?limit=25`;
    } else {
      feedPath = `/r/${encodeURIComponent(target)}/new.rss?limit=25`;
    }

    const result = await fetchUrl(`${REDDIT_BASE}${feedPath}`, {
      headers: {
        'Accept': 'application/rss+xml, application/atom+xml, application/xml',
        'User-Agent': 'YetAnotherOverengineeredStoatBot-Notify/1.0 (Stoat.chat bot; notifications)',
      },
    });

    if (!result.ok) {
      return { error: `Reddit fetch failed (HTTP ${result.status}). Rate-limited?` };
    }

    const entries = parseFeed(result.text);
    if (entries.length === 0) return { newPosts: [] };

    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];

    for (const entry of entries) {
      if (entry.guid && !seenSet.has(entry.guid)) {
        newPosts.push({
          guid: entry.guid,
          title: entry.title,
          url: entry.url || '',
          timestamp: parseDate(entry.timestamp)?.toISOString(),
          snippet: entry.content ? entry.content.replace(/<[^>]+>/g, '').slice(0, 280) : undefined,
          author: entry.author,
        });
      }
    }

    return { newPosts: newPosts.reverse() };
  },
};
