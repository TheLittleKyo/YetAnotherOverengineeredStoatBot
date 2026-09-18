/**
 * Free-games / deals feed ("Free Stuff") — shared types.
 *
 * Unlike the notification system (which watches one account per subscription),
 * this is a GLOBAL feed: the bot polls public giveaway/deal APIs and posts new
 * offers to one configured channel per server. There is one config per server.
 *
 * Sources:
 *   - GamerPower (https://www.gamerpower.com/api-read) — free game/DLC/loot giveaways.
 *   - CheapShark  (https://www.cheapshark.com/api/)    — heavily discounted PC games.
 * Both are free and require no API key.
 */

export type SourceId = 'gamerpower' | 'cheapshark';

/** GamerPower offer types we can filter on (item.type lowercased). */
export type GiveawayType = 'game' | 'loot' | 'dlc' | 'beta' | 'early access' | 'other';

/**
 * A normalized offer, produced by either source. The scheduler dedups on
 * `guid` and renders `format.ts` embeds from these fields.
 */
export interface Offer {
  /** Stable dedup key, prefixed by source (e.g. "gp:3767", "cs:<dealID>"). */
  guid: string;
  source: SourceId;
  title: string;
  /** Landing/claim URL the user clicks. */
  url: string;
  /** Original price, e.g. "$19.99" or "Free". */
  worth?: string;
  /** Sale price for deals, e.g. "$1.09" or "Free". */
  salePrice?: string;
  /** Discount percent 0-100 (deals). */
  savings?: number;
  /** Short description. */
  description?: string;
  /** Human platform string, e.g. "PC, Epic Games Store" or store name. */
  platforms?: string;
  /** GamerPower offer type. */
  type?: string;
  /** ISO or "YYYY-MM-DD HH:mm:ss" end date, or undefined/N/A. */
  endDate?: string;
  /** Large image URL for the embed media. */
  image?: string;
  /** Small thumbnail (fallback image). */
  thumbnail?: string;
}

/** Per-server configuration. One entry per serverId. */
export interface FreeStuffConfig {
  serverId: string;
  /** Channel offers are posted to. Empty until `setup` is run. */
  channelId: string;
  enabled: boolean;
  /** Which sources are active. */
  sources: { gamerpower: boolean; cheapshark: boolean };
  /**
   * Platform keyword filter for GamerPower (matched case-insensitively against
   * the offer's platform string). Empty = all platforms.
   * e.g. ['epic', 'steam', 'gog'].
   */
  platforms: string[];
  /** GamerPower offer types to include. Empty = all. Default ['game']. */
  types: string[];
  /** CheapShark: minimum discount percent to post (0-100). */
  minSavings: number;
  /** CheapShark: only post 100%-off (free) deals. */
  onlyFreeDeals: boolean;
  /**
   * CheapShark store IDs to include (e.g. ['1','25','7'] = Steam, Epic, GOG).
   * Empty = all stores.
   */
  stores: string[];
  /** Optional role id to mention in the message content. */
  mentionRole?: string;
  createdAt: string;
  updatedAt: string;
}

/** Per-server poll state (dedup memory). */
export interface FreeStuffState {
  /** True once the first successful poll seeded seenGuids (prevents old-offer flood). */
  seeded?: boolean;
  /** Last N offer guids we've already posted. */
  seenGuids?: string[];
  lastChecked?: string;
}

export type FreeStuffConfigMap = Record<string, FreeStuffConfig>;
export type FreeStuffStateMap = Record<string, FreeStuffState>;

export const DEFAULT_CONFIG: Omit<FreeStuffConfig, 'serverId' | 'createdAt' | 'updatedAt'> = {
  channelId: '',
  enabled: false,
  sources: { gamerpower: true, cheapshark: false },
  platforms: [],
  types: ['game'],
  minSavings: 80,
  onlyFreeDeals: false,
  stores: [],
};
