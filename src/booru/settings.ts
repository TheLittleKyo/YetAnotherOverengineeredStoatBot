/**
 * Per-server booru settings, stored in `data/booru.json`:
 *   { "servers": [{ serverId, nsfw, blacklist, disabledSites }] }
 */
import { createArrayFileStore, dataFile } from '../json-store.js';
import { normalizeBlacklist } from './safety.js';
import { findBooruSite } from './sites.js';

export type BooruServerSettings = {
  serverId: string;
  /** Allow non-general results in channels marked NSFW. Off makes every channel safe. */
  nsfw: boolean;
  /** Tags whose posts are never shown in this server. */
  blacklist: string[];
  /** Site ids members may not search here. */
  disabledSites: string[];
};

const store = createArrayFileStore<BooruServerSettings>(dataFile('booru.json'), 'servers', 'booru settings');

function defaults(serverId: string): BooruServerSettings {
  return { serverId, nsfw: true, blacklist: [], disabledSites: [] };
}

function normalize(serverId: string, value: Partial<BooruServerSettings> | undefined): BooruServerSettings {
  const disabled = Array.isArray(value?.disabledSites) ? value.disabledSites : [];
  return {
    serverId,
    nsfw: value?.nsfw !== false,
    blacklist: normalizeBlacklist(value?.blacklist),
    disabledSites: [...new Set(disabled.map((id) => findBooruSite(String(id))?.id).filter(Boolean) as string[])],
  };
}

/** Settings for a server; defaults when it has none. An empty id (DMs) always gets defaults. */
export function getBooruSettings(serverId: string): BooruServerSettings {
  if (!serverId) return defaults('');
  return normalize(serverId, store.read().find((entry) => entry.serverId === serverId));
}

export function updateBooruSettings(
  serverId: string,
  change: (current: BooruServerSettings) => Partial<BooruServerSettings>,
): BooruServerSettings {
  const current = getBooruSettings(serverId);
  const next = normalize(serverId, { ...current, ...change(current) });
  const others = store.read().filter((entry) => entry.serverId !== serverId);
  store.write([...others, next]);
  return next;
}
