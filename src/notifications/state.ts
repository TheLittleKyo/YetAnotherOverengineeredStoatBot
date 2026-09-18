/**
 * Persistent state for the notification system.
 *
 * - `subscriptions.json` — the list of subscriptions (added via `!notify add` or the editor).
 * - `subscription-states.json` — per-subscription poll state (live status, seen GUIDs).
 *
 * Both files are written atomically (tmp + rename) to survive crashes.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { Subscription, SubscriptionStateMap } from './types.js';
import { dataFile, ensureDataDir } from '../json-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SUBSCRIPTIONS_FILE = dataFile('notify-subscriptions.json');
const STATES_FILE = dataFile('notify-states.json');

let subscriptionCache: Subscription[] | null = null;
let stateCache: SubscriptionStateMap | null = null;

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
  } catch (error) {
    console.warn(`[notify] Failed to read ${filePath}: ${error?.message || error}`);
    return defaultValue;
  }
}

// ============================================================
// Subscriptions
// ============================================================

export function getSubscriptions(): Subscription[] {
  if (subscriptionCache) return subscriptionCache;
  subscriptionCache = readJsonOrDefault<Subscription[]>(SUBSCRIPTIONS_FILE, []);
  return subscriptionCache;
}

export function saveSubscriptions(subs: Subscription[]) {
  subscriptionCache = subs;
  writeJsonAtomic(SUBSCRIPTIONS_FILE, subs);
}

export function addSubscription(sub: Subscription): Subscription {
  const subs = getSubscriptions();
  // Idempotent: if an identical subscription exists (same platform+target+channelId), update it.
  const existingIdx = subs.findIndex(
    (s) => s.platform === sub.platform && s.target === sub.target && s.channelId === sub.channelId,
  );
  if (existingIdx >= 0) {
    subs[existingIdx] = { ...subs[existingIdx], ...sub, id: subs[existingIdx].id, createdAt: subs[existingIdx].createdAt };
  } else {
    subs.push(sub);
  }
  saveSubscriptions(subs);
  return sub;
}

export function removeSubscription(id: string): boolean {
  const subs = getSubscriptions();
  const next = subs.filter((s) => s.id !== id);
  if (next.length === subs.length) return false;
  saveSubscriptions(next);
  // Also clean up state.
  const states = getStates();
  if (states[id]) {
    delete states[id];
    writeJsonAtomic(STATES_FILE, states);
  }
  return true;
}

export function getSubscriptionsForChannel(channelId: string): Subscription[] {
  return getSubscriptions().filter((s) => s.channelId === channelId);
}

// ============================================================
// States
// ============================================================

export function getStates(): SubscriptionStateMap {
  if (stateCache) return stateCache;
  stateCache = readJsonOrDefault<SubscriptionStateMap>(STATES_FILE, {});
  return stateCache;
}

export function saveStates(states: SubscriptionStateMap) {
  stateCache = states;
  writeJsonAtomic(STATES_FILE, states);
}

export function updateState(id: string, patch: Partial<SubscriptionStateMap[string]>) {
  const states = getStates();
  states[id] = { ...states[id], ...patch, lastChecked: new Date().toISOString() };
  writeJsonAtomic(STATES_FILE, states);
}

export function clearState(id: string) {
  const states = getStates();
  if (states[id]) {
    delete states[id];
    writeJsonAtomic(STATES_FILE, states);
  }
}

// ============================================================
// ID generator
// ============================================================

let idCounter = 0;
export function generateSubscriptionId(): string {
  idCounter += 1;
  return `n${Date.now().toString(36)}${idCounter.toString(36)}`;
}
