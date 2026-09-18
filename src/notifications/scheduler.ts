/**
 * Notification scheduler — polls all enabled subscriptions on an interval,
 * detects new events, and posts notifications to the configured Stoat channels.
 *
 * State is persisted so restarting the bot doesn't create duplicate notifications.
 *
 * Polling cadence:
 *   - Live providers (twitch, kick, pomftv): every 60s (fast detection)
 *   - Posts providers: every 180s (3 min) — Reddit rate-limits hard, others are gentle
 *
 * The scheduler is a single setInterval; each tick iterates all subscriptions
 * and polls them sequentially with a small pacing delay.
 */

import { getSubscriptions, getStates, updateState } from './state.js';
import { getProvider } from './registry.js';
import { DEFAULT_FORMATTERS } from './types.js';
import type { Subscription, SubscriptionState, PollResult } from './types.js';
import { sleep } from '../async-utils.js';

const LIVE_POLL_INTERVAL_MS = 60_000;
const POSTS_POLL_INTERVAL_MS = 180_000;
const POLL_PACING_MS = 500;

let schedulerTimer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let isPolling = false;

export function startNotificationScheduler(client: any) {
  if (schedulerTimer) return;
  clientRef = client;
  console.log(`[notify] Scheduler started (live: ${LIVE_POLL_INTERVAL_MS / 1000}s, posts: ${POSTS_POLL_INTERVAL_MS / 1000}s).`);
  // Run an initial poll immediately.
  setTimeout(() => { void pollAll().catch(console.error); }, 5000);
  // Then on the faster of the two intervals — the poll function itself decides
  // which subscriptions are due based on their last-checked time.
  schedulerTimer = setInterval(() => { void pollAll().catch(console.error); }, LIVE_POLL_INTERVAL_MS);
}

/** Whether the poll interval is armed, for the ops health panel. */
export function isNotificationSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

export function stopNotificationScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  clientRef = null;
}

async function pollAll() {
  if (isPolling || !clientRef) return;
  isPolling = true;
  try {
    const subs = getSubscriptions().filter((s) => s.enabled);
    const states = getStates();
    const now = Date.now();

    for (const sub of subs) {
      const provider = getProvider(sub.platform);
      if (!provider) continue;

      const state = states[sub.id];
      const lastCheckedMs = state?.lastChecked ? new Date(state.lastChecked).getTime() : 0;
      const interval = provider.info.kind === 'live' ? LIVE_POLL_INTERVAL_MS : POSTS_POLL_INTERVAL_MS;

      // Skip if not due yet (allow 5s slack).
      if (lastCheckedMs && now - lastCheckedMs < interval - 5000) continue;

      try {
        const result = await provider.poll(sub, state);
        await handlePollResult(sub, state, result);
      } catch (error: any) {
        console.warn(`[notify] Provider ${sub.platform} threw for ${sub.target}: ${error?.message || error}`);
      }

      await sleep(POLL_PACING_MS);
    }
  } finally {
    isPolling = false;
  }
}

async function handlePollResult(sub: Subscription, previousState: SubscriptionState | undefined, result: PollResult) {
  if (result.error) {
    // Update lastChecked but don't notify on errors.
    updateState(sub.id, {});
    if (!previousState?.lastChecked) {
      // Only log once per subscription to avoid spam.
      console.warn(`[notify] ${sub.platform}/${sub.target}: ${result.error}`);
    }
    return;
  }

  const provider = getProvider(sub.platform);
  if (!provider) return;

  if (provider.info.kind === 'live') {
    const wasLive = previousState?.live === true;
    const isLive = result.isLive === true;

    if (!wasLive && isLive) {
      // OFFLINE → LIVE: notify.
      await sendNotification(sub, DEFAULT_FORMATTERS.formatLive(sub, result));
    }
    // LIVE → LIVE or LIVE → OFFLINE: just update state, no notification.
    updateState(sub.id, { live: isLive });
  } else {
    // Posts provider.
    const newPosts = result.newPosts || [];

    // FIRST-POLL INITIALIZATION: until a subscription has been seeded, treat
    // every current post as "already seen" WITHOUT notifying. This prevents
    // spamming old posts when a subscription is first added — or when the
    // first few polls errored / returned nothing (so lastChecked got set but
    // seenGuids never did). We key off an explicit `seeded` flag, NOT
    // lastChecked, because lastChecked is bumped on every poll including
    // errors. Existing subs with a non-empty seenGuids are considered already
    // seeded so a version upgrade doesn't re-seed them.
    const seeded = previousState?.seeded === true
      || (previousState?.seenGuids?.length ?? 0) > 0;

    if (!seeded) {
      if (newPosts.length === 0) {
        // Nothing to seed from yet (empty feed or a failed fetch upstream).
        // Bump lastChecked for pacing but stay unseeded so the next
        // successful poll seeds instead of flooding.
        updateState(sub.id, {});
        return;
      }
      const seedGuids = newPosts.map((p) => p.guid);
      const seenGuids = [...(previousState?.seenGuids || []), ...seedGuids].slice(-50);
      updateState(sub.id, { seeded: true, seenGuids });
      console.log(`[notify] ${sub.platform}/${sub.target}: first poll — seeded ${seedGuids.length} existing post(s), no notifications sent.`);
      return;
    }

    if (newPosts.length > 0) {
      for (const post of newPosts) {
        await sendNotification(sub, DEFAULT_FORMATTERS.formatPost(sub, post));
        await sleep(300); // brief pacing between multi-post notifications
      }
    }
    // Update seen GUIDs (keep last 50).
    const seenGuids = [...(previousState?.seenGuids || []), ...newPosts.map((p) => p.guid)].slice(-50);
    updateState(sub.id, { seenGuids });
  }
}

async function sendNotification(sub: Subscription, content: string) {
  if (!clientRef || !sub.channelId) return;
  try {
    const channel = clientRef.channels?.cache?.get?.(sub.channelId)
      || await clientRef.channels?.fetch?.(sub.channelId).catch(() => null);
    if (channel && typeof channel.send === 'function') {
      await channel.send({ content });
    } else {
      console.warn(`[notify] Could not resolve channel ${sub.channelId} for ${sub.platform}/${sub.target}`);
    }
  } catch (error: any) {
    console.warn(`[notify] Failed to send notification to ${sub.channelId}: ${error?.message || error}`);
  }
}
