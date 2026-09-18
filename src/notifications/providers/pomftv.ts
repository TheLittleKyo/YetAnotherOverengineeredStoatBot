/**
 * Pomf.TV provider — checks if a streamer is LIVE.
 *
 * Pomf.TV is behind Cloudflare's JS challenge, which blocks all server-side
 * HTTP requests (fetch + curl both fail with 403). This provider uses
 * Puppeteer (headless Chromium) to bypass the challenge.
 *
 * Strategy: instead of loading the individual stream page (which hits a
 * second Cloudflare challenge), we load the homepage which lists ALL
 * currently-online streamers with their viewer counts. If the target
 * streamer appears in that list, they're live.
 *
 * The browser is launched once (singleton) and kept alive for the bot's
 * lifetime. Each poll opens a new page, navigates, extracts the streamer
 * list, then closes the page.
 *
 * Accepts: full URL (https://pomf.tv/stream/username) or bare username.
 */

import { openPage } from '../browser.js';
import { extractIdFromUrl } from '../url-utils.js';
import type { NotificationProvider, PollResult, Subscription } from '../types.js';

const POMF_HOME = 'https://pomf.tv/';

export const pomfTvProvider: NotificationProvider = {
  info: {
    id: 'pomftv',
    label: 'Pomf.TV',
    kind: 'live',
    targetLabel: 'Streamer username or stream URL',
    targetPlaceholder: 'LittleKyo or https://pomf.tv/stream/LittleKyo',
  },

  async poll(sub: Subscription): Promise<PollResult> {
    const username = extractIdFromUrl(sub.target, ['pomf.tv']).trim();
    if (!username) return { error: 'Missing username' };

    const streamUrl = `https://pomf.tv/stream/${encodeURIComponent(username)}`;

    // Use Puppeteer to load the homepage and scrape the online streamer list.
    const page = await openPage(POMF_HOME, {
      timeoutMs: 30000,
      waitForSelector: 'body',
    });

    if (!page) {
      return { error: 'Could not launch Puppeteer browser. See console for setup instructions.' };
    }

    try {
      // The streamer list is rendered client-side (a tiny-slider carousel of
      // /stream/ links), and Pomf.TV sits behind Cloudflare's JS challenge
      // ("Just a moment..."). A fixed sleep is unreliable: if we scrape before
      // the challenge clears and the slider populates, we see zero streamers
      // and wrongly report EVERYONE as offline. That false-offline flips a
      // live sub to offline and the next poll flips it back, firing a
      // DUPLICATE live alert.
      //
      // So: wait until at least one /stream/ link exists. If the Cloudflare
      // interstitial is still up, reload once to give it another chance. If it
      // never clears, return an error (NOT offline) so the scheduler leaves
      // prior state untouched — no false flip, no dup alert.
      const waitForList = () =>
        page
          .waitForFunction(
            () => document.querySelectorAll('a[href*="/stream/"]').length > 0,
            { timeout: 20000, polling: 250 },
          )
          .then(() => true)
          .catch(() => false);

      let listReady = await waitForList();
      if (!listReady) {
        // Still challenged — reload and wait once more.
        await page.reload({ waitUntil: 'networkidle0', timeout: 30000 }).catch(() => {});
        listReady = await waitForList();
      }

      if (!listReady) {
        return { error: 'Pomf.TV streamer list did not render (Cloudflare challenge did not clear).' };
      }

      // Extract all online streamers from the homepage.
      const streamers = await page.evaluate(() => {
        const results: { name: string; viewers: number }[] = [];
        const links = document.querySelectorAll('a[href*="/stream/"]');
        for (const link of links) {
          const href = link.getAttribute('href') || '';
          const match = href.match(/\/stream\/([^/]+)/);
          if (!match) continue;
          const name = match[1];
          // Viewer count is usually a number at the end of the link text.
          const text = link.textContent || '';
          const viewersMatch = text.match(/(\d+)\s*$/);
          const viewers = viewersMatch ? parseInt(viewersMatch[1], 10) : 0;
          results.push({ name, viewers });
        }
        return results;
      });

      // Check if the target streamer is in the online list (case-insensitive).
      const target = username.toLowerCase();
      const match = streamers.find((s) => s.name.toLowerCase() === target);

      if (match) {
        return {
          isLive: true,
          title: undefined, // Pomf homepage doesn't show stream titles
          viewers: match.viewers || undefined,
          url: streamUrl,
        };
      }

      return { isLive: false, url: streamUrl };
    } catch (error: any) {
      return { error: `Pomf.TV page scrape failed: ${error?.message || error}` };
    } finally {
      // Always close the page (browser stays alive for reuse).
      await page.close().catch(() => {});
    }
  },
};
