/**
 * Public entry point for the Free Stuff (free games / deals) feed.
 */

export { startFreeStuffScheduler, stopFreeStuffScheduler } from './scheduler.js';
export {
  getConfig,
  getConfigs,
  getOrCreateConfig,
  updateConfig,
  deleteConfig,
  getEnabledConfigs,
} from './state.js';
export { fetchOffersForConfig } from './feed.js';
export { CHEAPSHARK_STORES } from './sources/cheapshark.js';
export { buildOfferEmbed, buildHeader } from './format.js';
export type { FreeStuffConfig, Offer, SourceId } from './types.js';
