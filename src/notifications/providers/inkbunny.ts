/**
 * Inkbunny provider — checks for new artwork submissions.
 *
 * Uses Inkbunny's public API with guest login (truly no-auth — no Inkbunny
 * account needed). Flow:
 *
 * 1. POST https://inkbunny.net/api_login.php with username=guest → get SID
 *    (cache for days; re-login only on invalid SID error)
 * 2. POST https://inkbunny.net/api_userrating.php with sid + tag[2]=yes + tag[3]=yes
 *    → enable Mature (violence + nudity) ratings for the guest session
 *    (only if extra.nsfw is set to 'true' or 'yes')
 * 3. POST https://inkbunny.net/api_search.php with sid + username=<artist>
 *    → get recent submissions
 *
 * Based on the official API docs: https://wiki.inkbunny.net/wiki/API
 *
 * NSFW support: by default, guest sessions only see General-rated content.
 * Set extra.nsfw=true to enable Mature (violence + nudity) and Adult ratings.
 */

import { fetchUrl, parseDate } from '../http.js';
import type { NotificationProvider, PollResult, Subscription, PostEntry } from '../types.js';
import { extractIdFromUrl } from '../url-utils.js';

const INKBUNNY_BASE = 'https://inkbunny.net';

// Cached SID + whether mature ratings have been enabled for it.
let cachedSid: string | null = null;
let cachedMatureEnabled = false;

async function getGuestSid(): Promise<string | null> {
  if (cachedSid) return cachedSid;

  // Login as guest (empty password).
  const body = 'username=guest&password=';
  const result = await fetchUrl(`${INKBUNNY_BASE}/api_login.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });

  if (!result.ok) return null;

  try {
    const data = JSON.parse(result.text);
    if (data?.sid) {
      cachedSid = data.sid;
      cachedMatureEnabled = false; // new SID, mature not yet enabled
      return data.sid;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Enable Mature (violence + nudity) and Adult ratings for the guest session.
 * Must be called after login, before search.
 *
 * Rating tags:
 *   tag[2] = yes → Mature - Violence
 *   tag[3] = yes → Mature - Nudity
 *   tag[4] = yes → Adult
 *
 * We enable 2, 3, and 4 so the guest sees all NSFW content.
 */
async function enableMatureRatings(sid: string): Promise<boolean> {
  if (cachedMatureEnabled) return true;

  const body = `sid=${encodeURIComponent(sid)}&tag[2]=yes&tag[3]=yes&tag[4]=yes`;
  const result = await fetchUrl(`${INKBUNNY_BASE}/api_userrating.php`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
    },
    body,
  });

  if (!result.ok) return false;

  try {
    const data = JSON.parse(result.text);
    if (data?.sid) {
      cachedMatureEnabled = true;
      return true;
    }
  } catch {
    // ignore
  }
  return false;
}

interface InkbunnySubmission {
  submission_id: string;
  title: string;
  username: string;
  create_datetime: string;
  file_url_screen?: string;
  file_url_full?: string;
  thumbnail_url_large?: string;
  thumbnail_url_medium?: string;
  mimetype?: string;
  rating_name?: string;
  type_name?: string;
  pagecount?: string;
}

export const inkbunnyProvider: NotificationProvider = {
  info: {
    id: 'inkbunny',
    label: 'Inkbunny',
    kind: 'posts',
    targetLabel: 'Artist username',
    targetPlaceholder: 'artistname',
    extraFields: [
      {
        key: 'nsfw',
        label: 'Include NSFW content (Mature + Adult ratings)',
        placeholder: 'true',
      },
    ],
  },

  async poll(sub: Subscription, previousState): Promise<PollResult> {
    const username = extractIdFromUrl(sub.target, ['inkbunny.net']).trim();
    if (!username) return { error: 'Missing artist username' };

    // Check if NSFW is requested.
    const nsfwRequested = ['true', 'yes', '1', 'on'].includes(String(sub.extra?.nsfw || '').toLowerCase().trim());

    // Step 1: get guest SID.
    let sid = await getGuestSid();
    if (!sid) {
      return { error: 'Could not obtain Inkbunny guest session.' };
    }

    // Step 2: enable mature ratings if requested.
    if (nsfwRequested) {
      const matureOk = await enableMatureRatings(sid);
      if (!matureOk) {
        // Re-login and retry once.
        cachedSid = null;
        sid = await getGuestSid();
        if (!sid) return { error: 'Could not obtain Inkbunny guest session.' };
        await enableMatureRatings(sid);
      }
    }

    // Step 3: search for the artist's recent submissions.
    const searchBody = `sid=${encodeURIComponent(sid)}&username=${encodeURIComponent(username)}&orderby=create_datetime&submissions_per_page=20&scraps=both&output_mode=json`;
    let result = await fetchUrl(`${INKBUNNY_BASE}/api_search.php`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: searchBody,
    });

    // If SID expired (error code 2), re-login + re-enable mature + retry.
    if (result.ok) {
      try {
        const data = JSON.parse(result.text);
        if (data?.error_code === 2 || data?.error_code === '2') {
          cachedSid = null;
          cachedMatureEnabled = false;
          sid = await getGuestSid();
          if (!sid) return { error: 'Could not refresh Inkbunny guest session.' };
          if (nsfwRequested) await enableMatureRatings(sid);
          result = await fetchUrl(`${INKBUNNY_BASE}/api_search.php`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'Accept': 'application/json',
            },
            body: `sid=${encodeURIComponent(sid)}&username=${encodeURIComponent(username)}&orderby=create_datetime&submissions_per_page=20&scraps=both&output_mode=json`,
          });
        }
      } catch {
        // JSON parse failed
      }
    }

    if (!result.ok) {
      return { error: `Inkbunny search failed: HTTP ${result.status}` };
    }

    let data: any;
    try {
      data = JSON.parse(result.text);
    } catch {
      return { error: 'Inkbunny API returned invalid JSON.' };
    }

    if (data?.error_code) {
      return { error: `Inkbunny API error ${data.error_code}: ${data.error || 'unknown'}` };
    }

    const submissions: InkbunnySubmission[] = Array.isArray(data?.submissions) ? data.submissions : [];
    if (submissions.length === 0) return { newPosts: [] };

    const seenSet = new Set(previousState?.seenGuids || []);
    const newPosts: PostEntry[] = [];

    for (const submission of submissions) {
      if (!submission?.submission_id) continue;
      if (seenSet.has(submission.submission_id)) continue;

      const submissionUrl = `${INKBUNNY_BASE}/s/${encodeURIComponent(submission.submission_id)}`;
      const thumbnail = submission.thumbnail_url_large || submission.thumbnail_url_medium || submission.file_url_screen;

      newPosts.push({
        guid: submission.submission_id,
        title: submission.title || undefined,
        url: submissionUrl,
        timestamp: parseDate(submission.create_datetime)?.toISOString(),
        snippet: submission.type_name ? `${submission.type_name}${submission.rating_name ? ` (${submission.rating_name})` : ''}` : undefined,
        author: submission.username || username,
        thumbnail,
      });
    }

    return { newPosts: newPosts.reverse() };
  },
};
