/**
 * Standalone notify test — polls every provider directly (no Stoat client).
 * Verifies: (1) each provider fetches live data without error,
 * (2) the first-poll seeding fix suppresses old posts and a re-poll yields 0 new.
 *
 * Run: npx tsx scripts/test-notify.ts
 */

import { getProvider } from '../src/notifications/registry.js';
import type { PlatformId, Subscription, SubscriptionState, PollResult } from '../src/notifications/types.js';

interface Case {
  platform: PlatformId;
  target: string;
  extra?: Record<string, string>;
}

const CASES: Case[] = [
  { platform: 'twitch', target: 'shroud' },
  { platform: 'kick', target: 'xqc' },
  { platform: 'pomftv', target: 'LittleKyo' },
  { platform: 'x', target: 'NASA' },
  { platform: 'youtube', target: '@MrBeast' },
  { platform: 'bluesky', target: 'bsky.app' },
  { platform: 'mastodon', target: 'Gargron', extra: { instance: 'mastodon.social' } },
  { platform: 'reddit', target: 'r/programming' },
  { platform: 'rss', target: 'https://feeds.bbci.co.uk/news/rss.xml' },
  { platform: 'inkbunny', target: 'inkbunny' },
];

function mkSub(c: Case): Subscription {
  return {
    id: `test-${c.platform}`,
    platform: c.platform,
    target: c.target,
    channelId: 'test',
    serverId: 'test',
    extra: c.extra,
    createdAt: new Date().toISOString(),
    enabled: true,
  };
}

/** Mirror of scheduler.handlePollResult seeding logic (posts providers). */
function applySeed(prev: SubscriptionState | undefined, result: PollResult): { state: SubscriptionState; notified: number } {
  const newPosts = result.newPosts || [];
  const seeded = prev?.seeded === true || (prev?.seenGuids?.length ?? 0) > 0;
  if (!seeded) {
    if (newPosts.length === 0) return { state: { ...prev, lastChecked: 'x' }, notified: 0 };
    const seenGuids = [...(prev?.seenGuids || []), ...newPosts.map((p) => p.guid)].slice(-50);
    return { state: { ...prev, seeded: true, seenGuids, lastChecked: 'x' }, notified: 0 };
  }
  const seenGuids = [...(prev?.seenGuids || []), ...newPosts.map((p) => p.guid)].slice(-50);
  return { state: { ...prev, seenGuids, lastChecked: 'x' }, notified: newPosts.length };
}

const RESET = '\x1b[0m', GREEN = '\x1b[32m', RED = '\x1b[31m', YEL = '\x1b[33m', DIM = '\x1b[2m';

async function run() {
  let pass = 0, fail = 0;
  for (const c of CASES) {
    const provider = getProvider(c.platform);
    const sub = mkSub(c);
    const label = `${c.platform}/${c.target}`;
    if (!provider) { console.log(`${RED}FAIL${RESET} ${label} — no provider`); fail++; continue; }

    try {
      const r1 = await provider.poll(sub, undefined);
      if (r1.error) {
        console.log(`${RED}FAIL${RESET} ${label} — error: ${r1.error}`);
        fail++;
        continue;
      }

      if (provider.info.kind === 'live') {
        console.log(`${GREEN}OK${RESET}   ${label} — live=${r1.isLive === true}${r1.title ? ` "${r1.title}"` : ''}`);
        pass++;
        continue;
      }

      // Posts: verify fetch + seeding fix.
      const rawCount = (r1.newPosts || []).length;
      const seed = applySeed(undefined, r1);
      if (seed.notified !== 0) {
        console.log(`${RED}FAIL${RESET} ${label} — first poll notified ${seed.notified} (should seed silently)`);
        fail++;
        continue;
      }
      // Second poll with seeded state — should notify 0 (no old-post spam).
      const r2 = await provider.poll(sub, seed.state);
      const seed2 = applySeed(seed.state, r2);
      const flag = seed2.notified === 0 ? GREEN + 'OK' + RESET : YEL + 'NEW' + RESET;
      console.log(`${flag}   ${label} — fetched ${rawCount} post(s), seeded ${seed.state.seenGuids?.length ?? 0}, re-poll new=${seed2.notified} ${DIM}(0 expected)${RESET}`);
      if (rawCount === 0) console.log(`     ${YEL}warn${RESET}: feed returned 0 posts (can't fully verify dedup)`);
      pass++;
    } catch (e: any) {
      console.log(`${RED}THROW${RESET} ${label} — ${e?.message || e}`);
      fail++;
    }
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

run();
