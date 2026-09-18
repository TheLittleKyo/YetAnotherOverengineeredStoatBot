/**
 * Aggregates offers from all enabled sources for a given server config.
 * Shared by the scheduler (periodic posting) and the `!freestuff test` command.
 */

import { fetchGamerPowerOffers } from './sources/gamerpower.js';
import { fetchCheapSharkOffers } from './sources/cheapshark.js';
import type { FreeStuffConfig, Offer } from './types.js';

export interface FeedResult {
  offers: Offer[];
  /** Non-fatal per-source errors (feed still returns whatever succeeded). */
  errors: string[];
}

/**
 * Fetch offers from every source enabled in `config`, applying its filters.
 * Never throws — source failures are collected in `errors`.
 */
export async function fetchOffersForConfig(config: FreeStuffConfig): Promise<FeedResult> {
  const offers: Offer[] = [];
  const errors: string[] = [];

  if (config.sources.gamerpower) {
    const { offers: gp, error } = await fetchGamerPowerOffers({
      platforms: config.platforms,
      types: config.types,
    });
    offers.push(...gp);
    if (error) errors.push(`GamerPower: ${error}`);
  }

  if (config.sources.cheapshark) {
    const { offers: cs, error } = await fetchCheapSharkOffers({
      minSavings: config.minSavings,
      onlyFree: config.onlyFreeDeals,
      stores: config.stores,
    });
    offers.push(...cs);
    if (error) errors.push(`CheapShark: ${error}`);
  }

  return { offers, errors };
}
