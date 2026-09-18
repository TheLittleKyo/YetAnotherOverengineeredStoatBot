/**
 * X/Twitter provider — checks for new posts.
 *
 * Uses Twitter's public guest token mechanism (the same system powering tweet
 * embeds). NO API keys, NO OAuth, NO RSSHub. The bearer token is publicly
 * embedded in Twitter's web app JS — it is not a secret.
 *
 * Flow:
 * 1. POST https://api.x.com/1.1/guest/activate.json with the public bearer
 *    → get a guest_token (cache for 15 min)
 * 2. GET https://x.com/i/api/graphql/<queryId>/UserByScreenName?variables=...
 *    → resolve handle to user ID (cache)
 * 3. GET https://x.com/i/api/graphql/<queryId>/UserTweets?variables=...
 *    → fetch recent tweets
 *
 * Based on the pravaha project (https://github.com/DevamShah/pravaha).
 *
 * NOTE: Twitter's GraphQL query IDs rotate every 2-4 weeks. We try multiple
 * known IDs for each endpoint. If all fail, check
 * https://github.com/fa0311/twitter-openapi for current IDs.
 */

import { fetchUrl, fetchJson, parseDate } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

// Public bearer token — embedded in Twitter's web app JavaScript. Not a secret.
const TWITTER_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL query IDs — these rotate every few weeks. We try multiple known IDs.
// Source: https://github.com/fa0311/twitter-openapi + pravaha
const QUERY_IDS_USER_BY_SCREEN_NAME = [
  'G3KGOASz96M-Qu0nwmGXNg',  // current as of 2026-08
  'sB2zamGswf5foV-jbPI34Q',  // older fallback
  'j3CXXF2F5T5WV2XyJiqLZw',  // older fallback
];

const QUERY_IDS_USER_TWEETS = [
  'V7H0Ap3_Hh2fryS75OCDO3Q',  // current as of 2026-08
  'gIM2iMZy9iJUOGPi9j7XIQ',  // older fallback
  'E3opETHurmVJflFsUBVuUQ',  // older fallback
];

// Required feature flags — Twitter rejects requests without these.
const FEATURES = {
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo_enabled: false,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

// In-memory caches.
let cachedGuestToken: { token: string; expiresAt: number } | null = null;
const userIdCache = new Map<string, string>();

async function getGuestToken(): Promise<string | null> {
  // Cache for 15 minutes.
  if (cachedGuestToken && Date.now() < cachedGuestToken.expiresAt) {
    return cachedGuestToken.token;
  }

  const result = await fetchUrl('https://api.x.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TWITTER_BEARER}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': '*/*',
    },
  });

  if (!result.ok) return null;

  try {
    const data = JSON.parse(result.text);
    if (data?.guest_token) {
      cachedGuestToken = {
        token: data.guest_token,
        expiresAt: Date.now() + 15 * 60 * 1000, // 15 min
      };
      return data.guest_token;
    }
  } catch {
    // ignore
  }
  return null;
}

function twitterHeaders(guestToken: string): Record<string, string> {
  return {
    'Authorization': `Bearer ${TWITTER_BEARER}`,
    'x-guest-token': guestToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://x.com/',
    'Origin': 'https://x.com',
  };
}

/**
 * Try multiple query IDs for UserByScreenName until one works.
 * Twitter rotates these IDs every few weeks.
 */
async function resolveUserId(handle: string, guestToken: string): Promise<{ userId: string | null; error?: string }> {
  const cached = userIdCache.get(handle.toLowerCase());
  if (cached) return { userId: cached };

  const variables = JSON.stringify({ screen_name: handle, withSafetyModeUserFields: true });
  const features = JSON.stringify(FEATURES);

  for (const queryId of QUERY_IDS_USER_BY_SCREEN_NAME) {
    const url = `https://x.com/i/api/graphql/${queryId}/UserByScreenName?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}`;
    const result = await fetchJson<any>(url, { headers: twitterHeaders(guestToken) });

    if (result.ok) {
      const userId = result.data?.data?.user?.result?.rest_id;
      if (userId) {
        userIdCache.set(handle.toLowerCase(), userId);
        return { userId };
      }
      // Got 200 but no user — might be suspended or not found.
      return { userId: null, error: `Twitter user @${handle} not found or suspended.` };
    }

    // 404 = query ID rotated, try next. Other errors = real failure.
    if (result.status !== 404) {
      return { userId: null, error: `Twitter UserByScreenName failed: ${result.error}` };
    }
  }

  return { userId: null, error: 'All Twitter UserByScreenName query IDs returned 404. The IDs may have rotated — check https://github.com/fa0311/twitter-openapi' };
}

interface TwitterTweet {
  id: string;
  text: string;
  url: string;
  createdAt: string;
}

function extractTweets(graphqlResponse: any, handle: string): TwitterTweet[] {
  const tweets: TwitterTweet[] = [];
  const instructions = graphqlResponse?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];
  const target = handle.toLowerCase();

  for (const instruction of instructions) {
    const entries = instruction?.entries || [];
    for (const entry of entries) {
      if (!entry?.entryId?.startsWith('tweet-')) continue;

      const tweetResult = entry?.content?.itemContent?.tweet_results?.result;
      if (!tweetResult) continue;

      if (tweetResult.__typename === 'TweetTombstone') continue;

      const legacy = tweetResult.legacy;
      if (!legacy?.id_str) continue;

      const text = legacy.full_text || '';
      if (text.startsWith('RT @') && legacy.retweeted_status_result) continue;
      if (legacy.in_reply_to_screen_name) continue;

      const author = tweetResult?.core?.user_results?.result?.legacy?.screen_name?.toLowerCase();
      if (author && author !== target) continue;

      tweets.push({
        id: legacy.id_str,
        text: text,
        url: `https://x.com/${handle}/status/${legacy.id_str}`,
        createdAt: legacy.created_at,
      });
    }
  }

  return tweets;
}

export const xProvider: NotificationProvider = {
  info: {
    id: 'x',
    label: 'X (Twitter)',
    kind: 'posts',
    targetLabel: 'Twitter handle (without @)',
    targetPlaceholder: 'elonmusk',
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const handle = extractIdFromUrl(sub.target, ['x.com', 'twitter.com']).trim().replace(/^@/, '');
    if (!handle) return { error: 'Missing Twitter handle' };

    // Step 1: get guest token.
    const guestToken = await getGuestToken();
    if (!guestToken) {
      return { error: 'Could not obtain Twitter guest token.' };
    }

    // Step 2: resolve user ID (tries multiple query IDs).
    const userResult = await resolveUserId(handle, guestToken);
    if (!userResult.userId) {
      return { error: userResult.error || `Could not resolve Twitter user @${handle}.` };
    }

    // Step 3: fetch recent tweets (try multiple query IDs).
    const variables = JSON.stringify({
      userId: userResult.userId,
      count: 20,
      includePromotedContent: false,
      withQuickPromoteEligibilityTweetFields: false,
      withVoice: true,
      withV2Timeline: true,
    });
    const features = JSON.stringify(FEATURES);
    const fieldToggles = JSON.stringify({ withArticlePlainText: false });

    let tweets: TwitterTweet[] = [];
    let lastError = '';

    for (const queryId of QUERY_IDS_USER_TWEETS) {
      const url = `https://x.com/i/api/graphql/${queryId}/UserTweets?variables=${encodeURIComponent(variables)}&features=${encodeURIComponent(features)}&fieldToggles=${encodeURIComponent(fieldToggles)}`;
      const result = await fetchJson<any>(url, { headers: twitterHeaders(guestToken) });

      if (result.ok) {
        tweets = extractTweets(result.data, handle);
        break;
      }

      lastError = result.error || `HTTP ${result.status}`;
      if (result.status !== 404) break; // non-404 = real error, stop trying
    }

    if (tweets.length === 0) {
      if (lastError) {
        return { error: `Twitter UserTweets failed: ${lastError}` };
      }
      return { newPosts: [] };
    }

    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];

    for (const tweet of tweets) {
      if (seenSet.has(tweet.id)) continue;
      newPosts.push({
        guid: tweet.id,
        title: undefined,
        url: tweet.url,
        timestamp: parseDate(tweet.createdAt)?.toISOString(),
        snippet: tweet.text.slice(0, 280),
        author: handle,
      });
    }

    return { newPosts: newPosts.reverse() };
  },
};
