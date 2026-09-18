/**
 * Bluesky provider — checks for new posts.
 *
 * Uses the public Bluesky API:
 * https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=<handle>&limit=10
 * No auth required.
 */

import { fetchJson } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

const BSKY_FEED = 'https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed';

export const blueskyProvider: NotificationProvider = {
  info: {
    id: 'bluesky',
    label: 'Bluesky',
    kind: 'posts',
    targetLabel: 'Handle or DID',
    targetPlaceholder: 'bsky.app',
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const actor = extractIdFromUrl(sub.target, ['bsky.app']).trim();
    if (!actor) return { error: 'Missing handle' };

    const result = await fetchJson<any>(`${BSKY_FEED}?actor=${encodeURIComponent(actor)}&limit=20`, {
      headers: { 'Accept': 'application/json' },
    });

    if (!result.ok) {
      return { error: `Bluesky API fetch failed: ${result.error}` };
    }

    const feed = result.data?.feed;
    if (!Array.isArray(feed)) return { newPosts: [] };

    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];

    for (const item of feed) {
      const post = item?.post;
      if (!post?.uri) continue;

      // Skip reposts (item.reason indicates a repost) and replies (record.reply).
      if (item.reason) continue;
      if (post.record?.reply) continue;

      const uri = post.uri;
      if (seenSet.has(uri)) continue;

      // Extract rkey from URI: at://did:plc:.../app.bsky.feed.post/<rkey>
      const rkey = uri.split('/').pop();
      const handle = post.author?.handle || actor;
      const postUrl = `https://bsky.app/profile/${handle}/post/${rkey}`;

      newPosts.push({
        guid: uri,
        title: undefined,
        url: postUrl,
        timestamp: post.record?.createdAt,
        snippet: post.record?.text,
        author: post.author?.displayName || handle,
        thumbnail: post.embed?.images?.[0]?.thumb || post.embed?.external?.thumb,
      });
    }

    return { newPosts: newPosts.reverse() };
  },
};
