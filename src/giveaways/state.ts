/**
 * Persistent state for the Free Stuff feed.
 *
 * - `freestuff-config.json` — per-server config (channel, sources, filters).
 * - `freestuff-states.json` — per-server dedup state (seen offer guids).
 *
 * Both files are written atomically (tmp + rename) to survive crashes,
 * matching the notification system's storage convention.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_CONFIG } from './types.js';
import type { FreeStuffConfig, FreeStuffConfigMap, FreeStuffState, FreeStuffStateMap } from './types.js';
import { dataFile, ensureDataDir } from '../json-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = dataFile('freestuff-config.json');
const STATES_FILE = dataFile('freestuff-states.json');

let configCache: FreeStuffConfigMap | null = null;
let stateCache: FreeStuffStateMap | null = null;

function writeJsonAtomic(filePath: string, data: unknown) {
  ensureDataDir();
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  try {
    renameSync(tmp, filePath);
  } catch {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}

function readJsonOrDefault<T>(filePath: string, defaultValue: T): T {
  try {
    if (!existsSync(filePath)) return defaultValue;
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return defaultValue;
    return JSON.parse(raw) as T;
  } catch (error: any) {
    console.warn(`[freestuff] Failed to read ${filePath}: ${error?.message || error}`);
    return defaultValue;
  }
}

// ============================================================
// Config
// ============================================================

export function getConfigs(): FreeStuffConfigMap {
  if (configCache) return configCache;
  configCache = readJsonOrDefault<FreeStuffConfigMap>(CONFIG_FILE, {});
  return configCache;
}

export function getConfig(serverId: string): FreeStuffConfig | undefined {
  return getConfigs()[serverId];
}

export function getEnabledConfigs(): FreeStuffConfig[] {
  return Object.values(getConfigs()).filter((c) => c.enabled && c.channelId);
}

function saveConfigs(configs: FreeStuffConfigMap) {
  configCache = configs;
  writeJsonAtomic(CONFIG_FILE, configs);
}

/**
 * Get the config for a server, creating a default one if it doesn't exist.
 * Does NOT persist a freshly-created default until you call `updateConfig`.
 */
export function getOrCreateConfig(serverId: string): FreeStuffConfig {
  const existing = getConfig(serverId);
  if (existing) return existing;
  const now = new Date().toISOString();
  return {
    serverId,
    ...structuredClone(DEFAULT_CONFIG),
    createdAt: now,
    updatedAt: now,
  };
}

/** Merge a patch into a server's config and persist it. */
export function updateConfig(serverId: string, patch: Partial<FreeStuffConfig>): FreeStuffConfig {
  const configs = getConfigs();
  const base = configs[serverId] ?? getOrCreateConfig(serverId);
  const next: FreeStuffConfig = {
    ...base,
    ...patch,
    // Deep-merge the sources object so a partial patch doesn't drop a flag.
    sources: { ...base.sources, ...(patch.sources || {}) },
    serverId,
    updatedAt: new Date().toISOString(),
  };
  configs[serverId] = next;
  saveConfigs(configs);
  return next;
}

export function deleteConfig(serverId: string): boolean {
  const configs = getConfigs();
  if (!configs[serverId]) return false;
  delete configs[serverId];
  saveConfigs(configs);
  clearState(serverId);
  return true;
}

// ============================================================
// States
// ============================================================

export function getStates(): FreeStuffStateMap {
  if (stateCache) return stateCache;
  stateCache = readJsonOrDefault<FreeStuffStateMap>(STATES_FILE, {});
  return stateCache;
}

export function getState(serverId: string): FreeStuffState | undefined {
  return getStates()[serverId];
}

export function updateState(serverId: string, patch: Partial<FreeStuffState>) {
  const states = getStates();
  states[serverId] = { ...states[serverId], ...patch, lastChecked: new Date().toISOString() };
  writeJsonAtomic(STATES_FILE, states);
}

export function clearState(serverId: string) {
  const states = getStates();
  if (states[serverId]) {
    delete states[serverId];
    writeJsonAtomic(STATES_FILE, states);
  }
}
