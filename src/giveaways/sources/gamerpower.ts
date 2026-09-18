/**
 * GamerPower source — free game / DLC / loot giveaways.
 *
 * API: https://www.gamerpower.com/api/giveaways  (no key, free)
 * Docs: https://www.gamerpower.com/api-read
 *
 * We fetch the full active-giveaway list once per poll and filter client-side
 * against the server's platform/type config. Filtering on the platform string
 * (rather than the API's platform slug param) avoids slug mismatches and keeps
 * us to a single request per poll.
 */

import { fetchJson } from '../../notifications/http.js';
import type { Offer } from '../types.js';

const GAMERPOWER_URL = 'https://www.gamerpower.com/api/giveaways?sort-by=date';
const UA = 'YetAnotherOverengineeredStoatBot-FreeStuff/1.0 (Stoat.chat bot; +https://stoat.chat)';

interface GamerPowerItem {
  id: number;
  title: string;
  worth: string;
  thumbnail: string;
  image: string;
  description: string;
  open_giveaway_url: string;
  published_date: string;
  type: string;
  platforms: string;
  end_date: string;
  status: string;
  gamerpower_url: string;
}

export interface GamerPowerFilter {
  /** Platform keywords, matched case-insensitively. Empty = all. */
  platforms: string[];
  /** Offer types (lowercased). Empty = all. */
  types: string[];
}

/**
 * Fetch and normalize GamerPower giveaways matching the filter.
 * Returns `[]` on any error (logged by the scheduler via the thrown message).
 */
export async function fetchGamerPowerOffers(filter: GamerPowerFilter): Promise<{ offers: Offer[]; error?: string }> {
  const res = await fetchJson<GamerPowerItem[]>(GAMERPOWER_URL, { headers: { 'User-Agent': UA } });
  if (!res.ok || !Array.isArray(res.data)) {
    return { offers: [], error: res.error || 'GamerPower fetch failed' };
  }

  const wantPlatforms = filter.platforms.map((p) => p.toLowerCase().trim()).filter(Boolean);
  const wantTypes = filter.types.map((t) => t.toLowerCase().trim()).filter(Boolean);

  const offers: Offer[] = [];
  for (const item of res.data) {
    if (String(item.status || '').toLowerCase() !== 'active') continue;

    const type = String(item.type || '').toLowerCase();
    if (wantTypes.length > 0 && !wantTypes.includes(type)) continue;

    const platformStr = String(item.platforms || '');
    if (wantPlatforms.length > 0) {
      const hay = platformStr.toLowerCase();
      if (!wantPlatforms.some((kw) => hay.includes(kw))) continue;
    }

    const end = item.end_date && item.end_date !== 'N/A' ? item.end_date : undefined;
    offers.push({
      guid: `gp:${item.id}`,
      source: 'gamerpower',
      title: item.title,
      url: item.open_giveaway_url || item.gamerpower_url,
      worth: item.worth && item.worth !== 'N/A' ? item.worth : 'Free',
      salePrice: 'Free',
      savings: 100,
      description: item.description,
      platforms: platformStr,
      type: item.type,
      endDate: end,
      image: item.image || item.thumbnail,
      thumbnail: item.thumbnail,
    });
  }

  return { offers };
}
