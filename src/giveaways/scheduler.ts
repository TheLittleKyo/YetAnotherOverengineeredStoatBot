/**
 * Free Stuff scheduler — polls giveaway/deal sources on an interval and posts
 * new offers to each server's configured channel.
 *
 * Dedup + seeding mirror the notification system: on a server's first
 * successful poll we seed all current offers as "seen" WITHOUT posting, so
 * enabling the feed doesn't flood the channel with existing giveaways. Only
 * offers appearing after seeding are posted.
 *
 * One setInterval drives all servers. Offers are gentle, public, cached APIs,
 * so a 10-minute cadence is plenty and stays well within rate limits.
 */

import { getEnabledConfigs, getState, updateState } from './state.js';
import { fetchOffersForConfig } from './feed.js';
import { buildOfferEmbed, buildHeader } from './format.js';
import type { FreeStuffConfig, Offer } from './types.js';
import { sleep } from '../async-utils.js';

const POLL_INTERVAL_MS = 10 * 60_000; // 10 minutes
const INITIAL_DELAY_MS = 8_000;
const SEND_PACING_MS = 800;
const MAX_POSTS_PER_TICK = 8; // safety cap against a burst of new offers
const SEEN_MEMORY = 200;

let schedulerTimer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let isPolling = false;

export function startFreeStuffScheduler(client: any) {
  if (schedulerTimer) return;
  clientRef = client;
  console.log(`[freestuff] Scheduler started (every ${POLL_INTERVAL_MS / 60_000} min).`);
  setTimeout(() => { void pollAll().catch(console.error); }, INITIAL_DELAY_MS);
  schedulerTimer = setInterval(() => { void pollAll().catch(console.error); }, POLL_INTERVAL_MS);
}

/** Whether the poll interval is armed, for the ops health panel. */
export function isFreeStuffSchedulerRunning(): boolean {
  return schedulerTimer !== null;
}

export function stopFreeStuffScheduler() {
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
    for (const config of getEnabledConfigs()) {
      try {
        await pollServer(config);
      } catch (error: any) {
        console.warn(`[freestuff] Poll failed for server ${config.serverId}: ${error?.message || error}`);
      }
    }
  } finally {
    isPolling = false;
  }
}

async function pollServer(config: FreeStuffConfig) {
  const { offers, errors } = await fetchOffersForConfig(config);
  const state = getState(config.serverId);

  if (errors.length > 0 && offers.length === 0) {
    // Total failure this tick — bump lastChecked, keep seeding for next time.
    updateState(config.serverId, {});
    if (!state?.lastChecked) console.warn(`[freestuff] ${config.serverId}: ${errors.join('; ')}`);
    return;
  }

  const seeded = state?.seeded === true || (state?.seenGuids?.length ?? 0) > 0;
  const seenSet = new Set(state?.seenGuids || []);

  // FIRST POLL: seed everything currently live, post nothing.
  if (!seeded) {
    if (offers.length === 0) {
      updateState(config.serverId, {});
      return;
    }
    const seen = offers.map((o) => o.guid).slice(-SEEN_MEMORY);
    updateState(config.serverId, { seeded: true, seenGuids: seen });
    console.log(`[freestuff] ${config.serverId}: seeded ${seen.length} existing offer(s), none posted.`);
    return;
  }

  const fresh = offers.filter((o) => !seenSet.has(o.guid));
  if (fresh.length === 0) {
    updateState(config.serverId, {});
    return;
  }

  const toPost = fresh.slice(0, MAX_POSTS_PER_TICK);
  let posted = 0;
  for (const offer of toPost) {
    const ok = await postOffer(config, offer);
    if (ok) posted++;
    await sleep(SEND_PACING_MS);
  }

  // Mark all fresh offers seen (even any beyond the per-tick cap) so we don't
  // re-post the overflow next tick — they'll simply be skipped.
  const seenGuids = [...(state?.seenGuids || []), ...fresh.map((o) => o.guid)].slice(-SEEN_MEMORY);
  updateState(config.serverId, { seenGuids });
  if (posted > 0) console.log(`[freestuff] ${config.serverId}: posted ${posted} new offer(s).`);
}

async function postOffer(config: FreeStuffConfig, offer: Offer): Promise<boolean> {
  if (!clientRef || !config.channelId) return false;
  try {
    const channel = clientRef.channels?.cache?.get?.(config.channelId)
      || await clientRef.channels?.fetch?.(config.channelId).catch(() => null);
    if (!channel || typeof channel.send !== 'function') {
      console.warn(`[freestuff] Could not resolve channel ${config.channelId} for server ${config.serverId}`);
      return false;
    }
    await channel.send({
      content: buildHeader(offer, config.mentionRole),
      embeds: [buildOfferEmbed(offer)],
    });
    return true;
  } catch (error: any) {
    console.warn(`[freestuff] Failed to post to ${config.channelId}: ${error?.message || error}`);
    return false;
  }
}
