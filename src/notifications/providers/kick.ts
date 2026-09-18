/**
 * Kick provider — checks if a streamer is LIVE.
 *
 * Kick's Cloudflare blocks Node's fetch() and curl based on TLS fingerprinting
 * from datacenter IPs. This provider uses Puppeteer (headless Chromium) which
 * bypasses Cloudflare cleanly.
 *
 * The browser is launched once (singleton) and kept alive for the bot's
 * lifetime. Each poll opens a new page, fetches the Kick API JSON, extracts
 * the livestream status, then closes the page.
 *
 * Accepts: full URL (https://kick.com/xqc) or bare slug.
 */

import { openPage } from '../browser.js';
import { extractIdFromUrl } from '../url-utils.js';
import type { NotificationProvider, PollResult, Subscription } from '../types.js';

const KICK_API = 'https://kick.com/api/v2/channels/';

export const kickProvider: NotificationProvider = {
  info: {
    id: 'kick',
    label: 'Kick',
    kind: 'live',
    targetLabel: 'Channel slug or URL',
    targetPlaceholder: 'xqc or https://kick.com/xqc',
  },

  async poll(sub: Subscription): Promise<PollResult> {
    const slug = extractIdFromUrl(sub.target, ['kick.com']).trim().toLowerCase();
    if (!slug) return { error: 'Missing channel slug' };

    const apiUrl = `${KICK_API}${encodeURIComponent(slug)}`;
    const streamUrl = `https://kick.com/${slug}`;

    // Use Puppeteer to bypass Cloudflare.
    const page = await openPage(apiUrl, {
      timeoutMs: 30000,
      waitForSelector: 'body',
    });

    if (!page) {
      return { error: 'Could not launch Puppeteer browser. See console for setup instructions.' };
    }

    try {
      // The API returns JSON. Puppeteer renders it as plain text in the body.
      const bodyText = await page.evaluate(() => document.body?.innerText || '');

      if (!bodyText) {
        return { error: 'Kick API returned empty response.' };
      }

      let data: any;
      try {
        data = JSON.parse(bodyText);
      } catch {
        return { error: `Kick API returned non-JSON response: ${bodyText.slice(0, 200)}` };
      }

      // Detect 404 "channel not found".
      if (data?.error === 'Not Found' || data?.status === 404) {
        return { error: `Kick channel "${slug}" not found. Use the lowercase username (e.g. "xqc", not "XQC").` };
      }

      const livestream = data.livestream;
      if (livestream && livestream.is_live === true) {
        return {
          isLive: true,
          title: livestream.session_title,
          viewers: typeof livestream.viewer_count === 'number' ? livestream.viewer_count : undefined,
          startedAt: livestream.created_at || livestream.start_time,
          url: streamUrl,
        };
      }

      return { isLive: false, url: streamUrl };
    } catch (error: any) {
      return { error: `Kick page scrape failed: ${error?.message || error}` };
    } finally {
      await page.close().catch(() => {});
    }
  },
};
