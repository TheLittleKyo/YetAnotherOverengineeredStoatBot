/**
 * CheapShark source — heavily discounted PC games across stores.
 *
 * API: https://www.cheapshark.com/api/1.0/deals  (no key, free)
 * Docs: https://apidocs.cheapshark.com/
 *
 * CheapShark requires a descriptive User-Agent or it returns an error JSON.
 * We pull the top deals sorted by savings and filter to the server's minimum
 * discount threshold. The claim URL uses CheapShark's redirect endpoint, which
 * forwards to the actual store deal.
 */

import { fetchJson } from '../../notifications/http.js';
import type { Offer } from '../types.js';

const DEALS_URL = 'https://www.cheapshark.com/api/1.0/deals';
const REDIRECT_URL = 'https://www.cheapshark.com/redirect?dealID=';
const UA = 'YetAnotherOverengineeredStoatBot-FreeStuff/1.0 (Stoat.chat bot; +https://stoat.chat)';

/**
 * Curated CheapShark store catalog — id, display name, and whether it's shown
 * as a default toggle in the dashboard. Ordered by how commonly people want it.
 * (CheapShark's full `/stores` list includes dead stores; this is the useful subset.)
 */
export const CHEAPSHARK_STORES: { id: string; name: string }[] = [
  { id: '1', name: 'Steam' },
  { id: '25', name: 'Epic Games Store' },
  { id: '7', name: 'GOG' },
  { id: '11', name: 'Humble Store' },
  { id: '15', name: 'Fanatical' },
  { id: '3', name: 'GreenManGaming' },
  { id: '31', name: 'Blizzard Shop' },
  { id: '8', name: 'Origin (EA)' },
  { id: '13', name: 'Uplay' },
  { id: '23', name: 'GameBillet' },
  { id: '24', name: 'Voidu' },
  { id: '30', name: 'IndieGala' },
  { id: '29', name: '2Game' },
  { id: '27', name: 'Gamesplanet' },
  { id: '21', name: 'WinGameStore' },
  { id: '2', name: 'GamersGate' },
  { id: '33', name: 'DLGamer' },
  { id: '34', name: 'Noctre' },
  { id: '35', name: 'DreamGame' },
];

/** storeID → display name for the platform label. */
const STORE_NAMES: Record<string, string> = Object.fromEntries(
  CHEAPSHARK_STORES.map((s) => [s.id, s.name]),
);

interface CheapSharkDeal {
  internalName: string;
  title: string;
  dealID: string;
  storeID: string;
  gameID: string;
  salePrice: string;
  normalPrice: string;
  savings: string;
  steamAppID: string | null;
  thumb: string;
}

export interface CheapSharkFilter {
  /** Minimum discount percent (0-100). */
  minSavings: number;
  /** Only include 100%-off (free) deals. */
  onlyFree: boolean;
  /** Store IDs to restrict to. Empty = all stores. */
  stores?: string[];
  /** How many top deals to consider per query. */
  pageSize?: number;
}

function money(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return `$${value}`;
  return n === 0 ? 'Free' : `$${n.toFixed(2)}`;
}

/** Use the high-res Steam capsule when available; fall back to the CheapShark thumb. */
function bigImage(deal: CheapSharkDeal): string {
  if (deal.steamAppID) {
    return `https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${deal.steamAppID}/header.jpg`;
  }
  return deal.thumb;
}

export async function fetchCheapSharkOffers(filter: CheapSharkFilter): Promise<{ offers: Offer[]; error?: string }> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 20, 1), 60);
  const minSavings = filter.onlyFree ? 100 : Math.min(Math.max(filter.minSavings, 0), 100);
  // CheapShark's storeID param takes one store per query, so fan out over the
  // selected stores (capped) and merge. No stores selected = one global query.
  const stores = (filter.stores || []).filter(Boolean).slice(0, 8);
  const queries = stores.length > 0 ? stores : [undefined];

  const seen = new Set<string>();
  const offers: Offer[] = [];
  const errors: string[] = [];

  for (const storeId of queries) {
    const params = new URLSearchParams({ sortBy: 'Savings', onSale: '1', pageSize: String(pageSize) });
    if (filter.onlyFree) params.set('upperPrice', '0');
    if (storeId) params.set('storeID', storeId);

    const res = await fetchJson<CheapSharkDeal[]>(`${DEALS_URL}?${params.toString()}`, {
      headers: { 'User-Agent': UA },
    });
    if (!res.ok || !Array.isArray(res.data)) {
      errors.push(res.error || 'fetch failed');
      continue;
    }

    for (const deal of res.data) {
      const savings = Math.round(Number(deal.savings) || 0);
      if (savings < minSavings) continue;
      if (filter.onlyFree && Number(deal.salePrice) !== 0) continue;
      if (seen.has(deal.dealID)) continue;
      seen.add(deal.dealID);

      offers.push({
        guid: `cs:${deal.dealID}`,
        source: 'cheapshark',
        title: deal.title,
        url: `${REDIRECT_URL}${encodeURIComponent(deal.dealID)}`,
        worth: money(deal.normalPrice),
        salePrice: money(deal.salePrice),
        savings,
        platforms: STORE_NAMES[deal.storeID] || `Store #${deal.storeID}`,
        type: 'Deal',
        image: bigImage(deal),
        thumbnail: deal.thumb,
      });
    }
  }

  // Only surface an error if every query failed (partial success still returns offers).
  const error = offers.length === 0 && errors.length > 0 ? `CheapShark: ${errors[0]}` : undefined;
  return { offers, error };
}
