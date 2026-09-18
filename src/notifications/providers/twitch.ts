/**
 * Twitch provider — checks if a streamer is LIVE.
 *
 * Uses the anonymous GQL endpoint (the same one twitch.tv uses in the browser).
 * No OAuth token — only the well-known public Client-ID header.
 *
 * Fallback: DecAPI plain-text uptime endpoint.
 */

import { fetchUrl, fetchJson } from '../http.js';
import type { NotificationProvider, PollResult, Subscription } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko'; // public web client ID
const DECAPI_BASE = 'https://decapi.me';

export const twitchProvider: NotificationProvider = {
  info: {
    id: 'twitch',
    label: 'Twitch',
    kind: 'live',
    targetLabel: 'Channel name',
    targetPlaceholder: 'shroud',
  },

  async poll(sub: Subscription): Promise<PollResult> {
    const channel = extractIdFromUrl(sub.target, ['twitch.tv']).trim().toLowerCase();
    if (!channel) return { error: 'Missing channel name' };

    // Try GQL first.
    try {
      const result = await fetchJson<any>('https://gql.twitch.tv/gql', {
        method: 'POST',
        headers: {
          'Client-ID': TWITCH_CLIENT_ID,
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          query: `{user(login:"${channel}"){stream{id type viewersCount title createdAt} broadcastSettings{title game{name}}}}`,
        }),
      });

      if (result.ok && result.data?.data?.user) {
        const stream = result.data.data.user.stream;
        if (stream && stream.type === 'live') {
          return {
            isLive: true,
            title: stream.title || result.data.data.user.broadcastSettings?.title,
            viewers: typeof stream.viewersCount === 'number' ? stream.viewersCount : undefined,
            startedAt: stream.createdAt,
            url: `https://twitch.tv/${channel}`,
          };
        }
        return { isLive: false, url: `https://twitch.tv/${channel}` };
      }
    } catch {
      // fall through to DecAPI
    }

    // Fallback: DecAPI.
    const decResult = await fetchUrl(`${DECAPI_BASE}/twitch/uptime/${encodeURIComponent(channel)}`, {
      headers: { 'Accept': 'text/plain' },
    });
    if (decResult.ok) {
      const text = decResult.text.trim().toLowerCase();
      if (text.includes('is offline')) {
        return { isLive: false, url: `https://twitch.tv/${channel}` };
      }
      // Non-empty uptime text means live.
      return {
        isLive: true,
        title: undefined,
        url: `https://twitch.tv/${channel}`,
      };
    }

    return { error: `Could not check Twitch status (GQL + DecAPI both failed)` };
  },
};
