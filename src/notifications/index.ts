/**
 * Public entry point for the notification system.
 * Re-exports the scheduler, state helpers, and provider registry.
 */

export { startNotificationScheduler, stopNotificationScheduler } from './scheduler.js';
export { getSubscriptions, addSubscription, removeSubscription, generateSubscriptionId } from './state.js';
export { getProvider, getAllProviders, getProviderInfos } from './registry.js';
export { DEFAULT_FORMATTERS } from './types.js';
export type { Subscription, ProviderInfo, PlatformId, ProviderKind, ExtraFieldSpec } from './types.js';
