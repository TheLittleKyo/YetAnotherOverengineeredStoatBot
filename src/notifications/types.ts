/**
 * Shared types for the notification system.
 *
 * A "subscription" is a watch on one platform account (a streamer, a poster,
 * an RSS feed). Each subscription lives in one Stoat channel — when the
 * provider detects a new event (going live, new post), the bot posts a
 * notification there.
 */

export type PlatformId =
  | 'twitch'
  | 'pomftv'
  | 'x'
  | 'youtube'
  | 'kick'
  | 'bluesky'
  | 'mastodon'
  | 'reddit'
  | 'rss'
  | 'inkbunny';

export type ProviderKind = 'live' | 'posts';

export interface ProviderInfo {
  id: PlatformId;
  label: string;
  kind: ProviderKind;
  /** Human-readable description of what the target field is. */
  targetLabel: string;
  /** Example value for the target field, shown in the editor + help. */
  targetPlaceholder: string;
  /** Optional extra config fields (e.g. Mastodon instance, RSSHub URL). */
  extraFields?: ExtraFieldSpec[];
}

export interface ExtraFieldSpec {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
}

export interface Subscription {
  id: string;
  platform: PlatformId;
  /** Platform-specific target: channel name, handle, feed URL, etc. */
  target: string;
  /** Stoat channel ID where notifications are sent. */
  channelId: string;
  /** Stoat server ID (for filtering). */
  serverId: string;
  /** Extra config (Mastodon instance, RSSHub base, etc.). */
  extra?: Record<string, string>;
  /** ISO timestamp of creation. */
  createdAt: string;
  /** Enabled flag — disabled subscriptions are skipped by the scheduler. */
  enabled: boolean;
}

/**
 * Persisted state for a subscription.
 * - For `live` providers: stores `live: boolean` so we only notify on OFFLINE→LIVE.
 * - For `posts` providers: stores `seenGuids: string[]` (last N post IDs).
 */
export interface SubscriptionState {
  live?: boolean;
  lastChecked?: string;
  /** True once the first successful posts-poll has seeded seenGuids. Until
   *  then, no post notifications are sent (prevents spamming old posts). */
  seeded?: boolean;
  seenGuids?: string[];
  lastGuid?: string;
  lastTimestamp?: string;
}

export type SubscriptionStateMap = Record<string, SubscriptionState>;

/**
 * Result of a provider poll.
 * - For `live` providers: `isLive` + stream metadata.
 * - For `posts` providers: `newPosts` array (already filtered to unseen).
 */
export interface PollResult {
  /** Live providers: current live status. */
  isLive?: boolean;
  /** Live providers: stream title (if available). */
  title?: string;
  /** Live providers: stream URL. */
  url?: string;
  /** Live providers: viewer count (if available). */
  viewers?: number;
  /** Live providers: ISO timestamp when stream started. */
  startedAt?: string;
  /** Posts providers: new posts since last poll. */
  newPosts?: PostEntry[];
  /** Optional error message — if set, the scheduler logs it and skips. */
  error?: string;
}

export interface PostEntry {
  /** Stable GUID (post URL, video ID, etc.) — used for dedup. */
  guid: string;
  title?: string;
  url: string;
  /** ISO timestamp of the post. */
  timestamp?: string;
  /** Optional text snippet / description. */
  snippet?: string;
  /** Optional author name (for reposts / multi-author feeds). */
  author?: string;
  /** Optional thumbnail URL. */
  thumbnail?: string;
}

/**
 * A provider implementation. One instance per platform.
 */
export interface NotificationProvider {
  info: ProviderInfo;
  /**
   * Poll the platform for the given subscription.
   * Should NOT throw — return `error` in the result on failure.
   * The scheduler passes the previous state so the provider can compute
   * "new since last check".
   */
  poll(subscription: Subscription, previousState: SubscriptionState | undefined): Promise<PollResult>;
}

/**
 * Format a notification message for Stoat.
 * Returns the content string the bot will send to the channel.
 */
export interface NotificationFormatter {
  formatLive(subscription: Subscription, result: PollResult): string;
  formatPost(subscription: Subscription, post: PostEntry): string;
}

export const DEFAULT_FORMATTERS: NotificationFormatter = {
  formatLive(sub, result) {
    const title = result.title ? ` **${result.title}**` : '';
    const viewers = typeof result.viewers === 'number' ? ` · ${result.viewers} viewers` : '';
    return `🔴 **${sub.target}** is now LIVE on ${sub.platform}!${title}${viewers}\n${result.url || ''}`;
  },
  formatPost(sub, post) {
    const title = post.title ? `**${post.title}**\n` : '';
    const snippet = post.snippet ? `${post.snippet.slice(0, 280)}${post.snippet.length > 280 ? '…' : ''}\n` : '';
    return `🆕 New post from **${sub.target}** on ${sub.platform}:\n${title}${snippet}${post.url}`;
  },
};
