/**
 * Mastodon provider — checks for new posts.
 *
 * Two-step public flow:
 * 1. Resolve username → account ID via /api/v1/accounts/lookup?acct=<user>
 * 2. Fetch recent statuses via /api/v1/accounts/<id>/statuses?limit=10
 *
 * The instance is configured via extra.instance (default: mastodon.social).
 * The account_id is cached in-memory to skip step 1 on subsequent polls.
 */

import { fetchJson } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

const DEFAULT_INSTANCE = 'mastodon.social';

// Cache: instance|username -> account_id
const accountIdCache = new Map<string, string>();

export const mastodonProvider: NotificationProvider = {
  info: {
    id: 'mastodon',
    label: 'Mastodon',
    kind: 'posts',
    targetLabel: 'Username (without @)',
    targetPlaceholder: 'Gargron',
    extraFields: [
      { key: 'instance', label: 'Instance', placeholder: 'mastodon.social', required: true },
    ],
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const username = extractIdFromUrl(sub.target, []).trim().replace(/^@/, '');
    if (!username) return { error: 'Missing username' };

    const instance = (sub.extra?.instance || DEFAULT_INSTANCE).replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const base = `https://${instance}`;
    const cacheKey = `${instance}|${username.toLowerCase()}`;

    // Step 1: resolve account_id (cached).
    let accountId = accountIdCache.get(cacheKey);
    if (!accountId) {
      const lookup = await fetchJson<any>(`${base}/api/v1/accounts/lookup?acct=${encodeURIComponent(username)}`, {
        headers: { 'Accept': 'application/json' },
      });
      if (!lookup.ok || !lookup.data?.id) {
        return { error: `Mastodon lookup failed: ${lookup.error || 'no account id'}` };
      }
      accountId = lookup.data.id;
      accountIdCache.set(cacheKey, accountId);
    }

    // Step 2: fetch statuses.
    const result = await fetchJson<any>(`${base}/api/v1/accounts/${accountId}/statuses?limit=20`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!result.ok) {
      // If account_id is stale, clear cache and let next poll re-resolve.
      accountIdCache.delete(cacheKey);
      return { error: `Mastodon statuses fetch failed: ${result.error}` };
    }

    const statuses = Array.isArray(result.data) ? result.data : [];
    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];

    for (const status of statuses) {
      if (!status?.id) continue;
      if (status.visibility && status.visibility !== 'public') continue;
      if (status.reblog) continue; // skip boosts
      if (seenSet.has(status.id)) continue;

      // Strip HTML from content for snippet.
      const snippet = status.content ? status.content.replace(/<[^>]+>/g, '').slice(0, 280) : undefined;

      newPosts.push({
        guid: status.id,
        title: undefined,
        url: status.url || `${base}/@${username}/${status.id}`,
        timestamp: status.created_at,
        snippet: snippet || undefined,
        author: status.account?.display_name || username,
      });
    }

    return { newPosts: newPosts.reverse() };
  },
};
