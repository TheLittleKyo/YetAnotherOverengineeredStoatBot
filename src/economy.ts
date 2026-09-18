/**
 * Economy — a server currency layered on the same activity the leveling system
 * already watches.
 *
 * It deliberately does *not* fork leveling's XP store: XP measures how much
 * someone talks and cannot be spent, while coins are a balance that moves
 * between members and gets burned in the shop. Sharing one number would make
 * buying a role cost you rank. They earn from the same event, separately.
 *
 * Earning: messages (bounded random amount, own cooldown), `daily` with a
 * streak bonus, and `work` on a cooldown. Spending: the shop, which can hand
 * out a role, and member-to-member transfers. Gambling is off by default and
 * capped when on.
 *
 * Storage: SQLite (db.ts). Each member is one row in `economy_users`, written
 * as it changes; anything that moves coins between two rows (a transfer, a
 * purchase and its stock) commits in one transaction. A server's config and
 * shop live in `module_settings`, cached in memory because the message reward
 * reads them every time. Backups still see all of it as `economy.json` (see
 * `registerVirtualDataFile`), and the old file is imported on first use.
 */

import { config } from './config.js';
import { registerDataFileHooks, registerVirtualDataFile } from './json-store.js';
import { debug } from './logger.js';
import {
  deleteModuleSettings,
  importLegacyJson,
  listModuleSettings,
  readModuleSettings,
  sql,
  transaction,
  writeModuleSettings,
} from './db.js';

export type ShopItem = {
  id: string;
  name: string;
  description: string;
  price: number;
  /** Granted on purchase, when set. */
  roleId: string | null;
  /** Remaining stock; null means unlimited. */
  stock: number | null;
  /** How many one member may own; 0 means no limit. */
  perUserLimit: number;
};

export type EconomyConfig = {
  enabled: boolean;
  currencyName: string;
  currencySymbol: string;
  startingBalance: number;
  /** Message reward bounds and cooldown. */
  messageMin: number;
  messageMax: number;
  messageCooldownSec: number;
  dailyAmount: number;
  /** Added per consecutive day, capped at 7 days' worth. */
  dailyStreakBonus: number;
  workMin: number;
  workMax: number;
  workCooldownSec: number;
  /** Member-to-member transfers. */
  payEnabled: boolean;
  /** Percentage taken from each transfer, 0–50. */
  payTaxPercent: number;
  gamblingEnabled: boolean;
  gambleMaxBet: number;
  /** Channels where messages earn nothing. */
  noEarnChannelIds: string[];
};

type UserRecord = {
  balance: number;
  name: string;
  totalEarned: number;
  lastMessageAt: number;
  lastDailyAt: number;
  dailyStreak: number;
  lastWorkAt: number;
  inventory: Record<string, number>;
};

type ServerSettings = {
  config: EconomyConfig;
  shop: ShopItem[];
};

const SETTINGS_MODULE = 'economy';
const LEGACY_FILE = 'economy.json';

const settingsCache = new Map<string, ServerSettings>();
let ready = false;

export function defaultEconomyConfig(): EconomyConfig {
  return {
    enabled: false,
    currencyName: 'coins',
    currencySymbol: '🪙',
    startingBalance: 0,
    messageMin: 1,
    messageMax: 3,
    messageCooldownSec: 60,
    dailyAmount: 100,
    dailyStreakBonus: 25,
    workMin: 25,
    workMax: 120,
    workCooldownSec: 3600,
    payEnabled: true,
    payTaxPercent: 0,
    gamblingEnabled: false,
    gambleMaxBet: 500,
    noEarnChannelIds: [],
  };
}

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeConfig(value: any): EconomyConfig {
  const base = defaultEconomyConfig();
  if (!value || typeof value !== 'object') return base;
  const messageMin = Math.max(0, Math.floor(num(value.messageMin, base.messageMin)));
  const workMin = Math.max(0, Math.floor(num(value.workMin, base.workMin)));
  return {
    enabled: value.enabled === true,
    currencyName: text(value.currencyName, 24) || base.currencyName,
    currencySymbol: text(value.currencySymbol, 8) || base.currencySymbol,
    startingBalance: Math.max(0, Math.floor(num(value.startingBalance, base.startingBalance))),
    messageMin,
    messageMax: Math.max(messageMin, Math.floor(num(value.messageMax, base.messageMax))),
    messageCooldownSec: Math.max(0, Math.floor(num(value.messageCooldownSec, base.messageCooldownSec))),
    dailyAmount: Math.max(0, Math.floor(num(value.dailyAmount, base.dailyAmount))),
    dailyStreakBonus: Math.max(0, Math.floor(num(value.dailyStreakBonus, base.dailyStreakBonus))),
    workMin,
    workMax: Math.max(workMin, Math.floor(num(value.workMax, base.workMax))),
    workCooldownSec: Math.max(60, Math.floor(num(value.workCooldownSec, base.workCooldownSec))),
    payEnabled: value.payEnabled !== false,
    payTaxPercent: Math.min(50, Math.max(0, Math.floor(num(value.payTaxPercent, 0)))),
    gamblingEnabled: value.gamblingEnabled === true,
    gambleMaxBet: Math.max(1, Math.floor(num(value.gambleMaxBet, base.gambleMaxBet))),
    noEarnChannelIds: Array.isArray(value.noEarnChannelIds)
      ? Array.from(new Set(value.noEarnChannelIds.map((id: any) => text(id, 64)).filter(Boolean) as string[])).slice(0, 100)
      : [],
  };
}

function normalizeItem(value: any): ShopItem | null {
  const name = text(value?.name, 60);
  if (!name) return null;
  return {
    id: text(value?.id, 40) || `it_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name,
    description: text(value?.description, 300),
    price: Math.max(0, Math.floor(num(value?.price, 0))),
    roleId: text(value?.roleId, 64) || null,
    stock: value?.stock == null ? null : Math.max(0, Math.floor(num(value.stock, 0))),
    perUserLimit: Math.max(0, Math.floor(num(value?.perUserLimit, 0))),
  };
}

function normalizeShop(value: any): ShopItem[] {
  return Array.isArray(value) ? (value.map(normalizeItem).filter(Boolean) as ShopItem[]) : [];
}

function normalizeInventory(value: any): Record<string, number> {
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries<any>(value).map(([key, count]) => [text(key, 40), Math.max(0, Math.floor(num(count, 0)))]),
      )
    : {};
}

function normalizeUser(value: any): UserRecord {
  return {
    balance: Math.max(0, Math.floor(num(value?.balance, 0))),
    name: text(value?.name, 80),
    totalEarned: Math.max(0, Math.floor(num(value?.totalEarned, 0))),
    lastMessageAt: num(value?.lastMessageAt, 0),
    lastDailyAt: num(value?.lastDailyAt, 0),
    dailyStreak: Math.max(0, Math.floor(num(value?.dailyStreak, 0))),
    lastWorkAt: num(value?.lastWorkAt, 0),
    inventory: normalizeInventory(value?.inventory),
  };
}

// ---- Storage ---------------------------------------------------------------

/**
 * Write a whole store in the old `economy.json` shape: the legacy import, and
 * a backup restore. Servers not in `data` are left alone.
 */
function importStore(data: any) {
  const servers = data?.servers && typeof data.servers === 'object' ? data.servers : {};
  for (const [serverId, state] of Object.entries<any>(servers)) {
    if (!serverId) continue;
    writeModuleSettings(SETTINGS_MODULE, serverId, { config: normalizeConfig(state?.config), shop: normalizeShop(state?.shop) });
    const users = state?.users && typeof state.users === 'object' ? state.users : {};
    for (const [userId, user] of Object.entries<any>(users)) {
      if (userId) writeUser(serverId, userId, normalizeUser(user));
    }
  }
}

/** Every server's economy in the old `economy.json` shape, for backups. */
function exportStore(): unknown | null {
  ensureReady();
  const servers: Record<string, { config: EconomyConfig; shop: ShopItem[]; users: Record<string, UserRecord> }> = {};
  const serverFor = (serverId: string) => (servers[serverId] ||= { ...settings(serverId), users: {} });
  for (const { serverId } of listModuleSettings(SETTINGS_MODULE)) serverFor(serverId);
  for (const row of sql('SELECT * FROM economy_users ORDER BY server_id, user_id').all() as any[]) {
    serverFor(row.server_id).users[row.user_id] = rowToUser(row);
  }
  return Object.keys(servers).length ? { version: 1, servers } : null;
}

function ensureReady() {
  if (ready) return;
  importLegacyJson(LEGACY_FILE, importStore);
  ready = true;
}

registerVirtualDataFile(LEGACY_FILE, {
  read: exportStore,
  // A restore hands over the whole file (the other servers merged back in), so
  // the store is replaced as a whole.
  write: (data) => {
    ensureReady();
    transaction(() => {
      sql('DELETE FROM economy_users').run();
      deleteModuleSettings(SETTINGS_MODULE);
      importStore(data);
    });
    settingsCache.clear();
  },
});

// A restore or `!reset` replaced what is stored: drop the cached settings.
registerDataFileHooks(LEGACY_FILE, { reload: () => resetEconomyCache() });

/** Largest balance or amount the store accepts, so a typo cannot reach Infinity. */
const MAX_AMOUNT = 1_000_000_000_000;

function clampAmount(value: any): number {
  return Math.max(-MAX_AMOUNT, Math.min(MAX_AMOUNT, Math.floor(num(value, 0))));
}

/** Drop the cached per-server settings so the next read comes from the database. */
export function resetEconomyCache() {
  settingsCache.clear();
}

function settings(serverId: string): ServerSettings {
  ensureReady();
  let cached = settingsCache.get(serverId);
  if (!cached) {
    const stored: any = readModuleSettings(SETTINGS_MODULE, serverId);
    cached = { config: normalizeConfig(stored?.config), shop: normalizeShop(stored?.shop) };
    settingsCache.set(serverId, cached);
  }
  return cached;
}

function saveSettings(serverId: string, next: ServerSettings) {
  writeModuleSettings(SETTINGS_MODULE, serverId, next);
  settingsCache.set(serverId, next);
}

function rowToUser(row: any): UserRecord {
  let inventory: Record<string, number> = {};
  try {
    inventory = normalizeInventory(JSON.parse(row.inventory || '{}'));
  } catch {
    // A damaged inventory reads as empty rather than losing the balance too.
  }
  return {
    balance: row.balance,
    name: row.name,
    totalEarned: row.total_earned,
    lastMessageAt: row.last_message_at,
    lastDailyAt: row.last_daily_at,
    dailyStreak: row.daily_streak,
    lastWorkAt: row.last_work_at,
    inventory,
  };
}

/** A member's record for reading only: never creates one. */
function peekRecord(serverId: string, userId: string): UserRecord | null {
  ensureReady();
  const row = sql('SELECT * FROM economy_users WHERE server_id = ? AND user_id = ?').get(serverId, userId);
  return row ? rowToUser(row) : null;
}

/** A member's record, or a fresh one holding the starting balance (saved by `writeUser`). */
function userRecord(serverId: string, userId: string): UserRecord {
  return peekRecord(serverId, userId) || normalizeUser({ balance: settings(serverId).config.startingBalance });
}

function writeUser(serverId: string, userId: string, record: UserRecord) {
  sql(
    `INSERT INTO economy_users
       (server_id, user_id, balance, name, total_earned, last_message_at, last_daily_at, daily_streak, last_work_at, inventory)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(server_id, user_id) DO UPDATE SET
       balance = excluded.balance, name = excluded.name, total_earned = excluded.total_earned,
       last_message_at = excluded.last_message_at, last_daily_at = excluded.last_daily_at,
       daily_streak = excluded.daily_streak, last_work_at = excluded.last_work_at, inventory = excluded.inventory`,
  ).run(
    serverId,
    userId,
    record.balance,
    record.name,
    record.totalEarned,
    record.lastMessageAt,
    record.lastDailyAt,
    record.dailyStreak,
    record.lastWorkAt,
    JSON.stringify(record.inventory),
  );
}

// ---- Config / shop ---------------------------------------------------------

export function getEconomyConfig(serverId = config.serverId || ''): EconomyConfig {
  return { ...settings(serverId).config };
}

export function setEconomyConfig(patch: Partial<EconomyConfig>, serverId = config.serverId || ''): EconomyConfig {
  const current = settings(serverId);
  const next = { ...current, config: normalizeConfig({ ...current.config, ...patch }) };
  saveSettings(serverId, next);
  return { ...next.config };
}

export function listShop(serverId = config.serverId || ''): ShopItem[] {
  return settings(serverId).shop.map((item) => ({ ...item }));
}

export function addShopItem(input: Partial<ShopItem>, serverId = config.serverId || ''): ShopItem | null {
  const item = normalizeItem({ ...input, id: undefined });
  if (!item) return null;
  const current = settings(serverId);
  saveSettings(serverId, { ...current, shop: [...current.shop, item] });
  return { ...item };
}

export function updateShopItem(id: string, patch: Partial<ShopItem>, serverId = config.serverId || ''): ShopItem | null {
  const current = settings(serverId);
  const index = current.shop.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const merged = normalizeItem({ ...current.shop[index], ...patch, id });
  if (!merged) return null;
  const shop = [...current.shop];
  shop[index] = merged;
  saveSettings(serverId, { ...current, shop });
  return { ...merged };
}

export function removeShopItem(id: string, serverId = config.serverId || ''): boolean {
  const current = settings(serverId);
  const shop = current.shop.filter((item) => item.id !== id);
  if (shop.length === current.shop.length) return false;
  saveSettings(serverId, { ...current, shop });
  return true;
}

// ---- Balances --------------------------------------------------------------

export type Balance = { balance: number; totalEarned: number; inventory: Record<string, number> };

export function getBalance(userId: string, serverId = config.serverId || ''): Balance {
  // Looking someone up must not open an account for them: that would inflate
  // the holder count and hand out the starting balance twice.
  const record = peekRecord(serverId, userId);
  if (!record) return { balance: settings(serverId).config.startingBalance, totalEarned: 0, inventory: {} };
  return { balance: record.balance, totalEarned: record.totalEarned, inventory: { ...record.inventory } };
}

export function addBalance(userId: string, value: number, serverId = config.serverId || '', name?: string): number {
  return transaction(() => {
    const record = userRecord(serverId, userId);
    const delta = clampAmount(value);
    record.balance = Math.min(MAX_AMOUNT, Math.max(0, record.balance + delta));
    if (delta > 0) record.totalEarned += delta;
    if (name) record.name = text(name, 80);
    writeUser(serverId, userId, record);
    return record.balance;
  });
}

export function setBalance(userId: string, value: number, serverId = config.serverId || ''): number {
  return transaction(() => {
    const record = userRecord(serverId, userId);
    record.balance = Math.max(0, clampAmount(value));
    writeUser(serverId, userId, record);
    return record.balance;
  });
}

export function resetEconomyUser(userId: string, serverId = config.serverId || ''): boolean {
  ensureReady();
  return Number(sql('DELETE FROM economy_users WHERE server_id = ? AND user_id = ?').run(serverId, userId).changes) > 0;
}

export function resetEconomyAll(serverId = config.serverId || ''): void {
  ensureReady();
  sql('DELETE FROM economy_users WHERE server_id = ?').run(serverId);
}

export type RichRow = { userId: string; name: string; balance: number; rank: number };

export function getRichList(topN = 10, serverId = config.serverId || ''): RichRow[] {
  ensureReady();
  const rows = sql(
    'SELECT user_id, name, balance FROM economy_users WHERE server_id = ? AND balance > 0 ORDER BY balance DESC, user_id LIMIT ?',
  ).all(serverId, Math.max(0, Math.floor(topN))) as any[];
  return rows.map((row, index) => ({ userId: row.user_id, name: row.name || row.user_id, balance: row.balance, rank: index + 1 }));
}

export function getEconomySummary(serverId = config.serverId || '') {
  const current = settings(serverId);
  const totals = sql(
    'SELECT COUNT(*) AS holders, COALESCE(SUM(balance), 0) AS circulating FROM economy_users WHERE server_id = ?',
  ).get(serverId) as { holders: number; circulating: number };
  return {
    enabled: current.config.enabled,
    holders: totals.holders,
    circulating: totals.circulating,
    shopItems: current.shop.length,
  };
}

// ---- Earning ---------------------------------------------------------------

function randomBetween(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/**
 * Award the per-message amount. Best-effort and content-free, mirroring the
 * leveling hook it runs beside.
 */
export function recordMessageEarning(client: any, message: any): void {
  try {
    if (!message || message.author?.bot) return;
    if (message.systemMessage || message.isSystem) return;
    const serverId = String(message?.channel?.serverId || message?.serverId || '');
    if (!serverId) return;
    const cfg = settings(serverId).config;
    if (!cfg.enabled) return;

    // Command invocations are not chat, the same way they earn no XP — otherwise
    // running `!balance` in a loop would pay for itself.
    if (String(message.content || '').startsWith(config.prefix)) return;

    const channelId = String(message.channelId || message.channel?.id || '');
    if (cfg.noEarnChannelIds.includes(channelId)) return;

    const userId = String(message.authorId || message.author?.id || '');
    if (!userId || userId === client?.user?.id) return;

    const record = userRecord(serverId, userId);
    const now = Date.now();
    if (now - record.lastMessageAt < cfg.messageCooldownSec * 1000) return;

    const amount = randomBetween(cfg.messageMin, cfg.messageMax);
    record.lastMessageAt = now;
    record.balance += amount;
    record.totalEarned += amount;
    const name = message?.member?.nickname || message?.author?.username;
    if (name) record.name = text(name, 80);
    writeUser(serverId, userId, record);
  } catch (error) {
    debug('economy', () => `message earning failed: ${(error as Error)?.message || error}`);
  }
}

export type ClaimResult = { ok: boolean; amount?: number; balance?: number; streak?: number; error?: string; retryInMs?: number };

export function claimDaily(userId: string, serverId = config.serverId || '', name?: string): ClaimResult {
  const cfg = settings(serverId).config;
  if (!cfg.enabled) return { ok: false, error: 'The economy is switched off in this server.' };

  return transaction(() => {
    const record = userRecord(serverId, userId);
    const now = Date.now();
    const sinceLast = now - record.lastDailyAt;
    if (record.lastDailyAt && sinceLast < 86_400_000) {
      return { ok: false, error: 'You already claimed today.', retryInMs: 86_400_000 - sinceLast };
    }

    // A claim within 48 hours keeps the streak; anything longer resets it.
    record.dailyStreak = record.lastDailyAt && sinceLast < 172_800_000 ? record.dailyStreak + 1 : 1;
    const bonus = Math.min(7, record.dailyStreak - 1) * cfg.dailyStreakBonus;
    const amount = cfg.dailyAmount + bonus;

    record.lastDailyAt = now;
    record.balance += amount;
    record.totalEarned += amount;
    if (name) record.name = text(name, 80);
    writeUser(serverId, userId, record);

    return { ok: true, amount, balance: record.balance, streak: record.dailyStreak };
  });
}

export function doWork(userId: string, serverId = config.serverId || '', name?: string): ClaimResult {
  const cfg = settings(serverId).config;
  if (!cfg.enabled) return { ok: false, error: 'The economy is switched off in this server.' };

  return transaction(() => {
    const record = userRecord(serverId, userId);
    const now = Date.now();
    const cooldownMs = cfg.workCooldownSec * 1000;
    const sinceLast = now - record.lastWorkAt;
    if (record.lastWorkAt && sinceLast < cooldownMs) {
      return { ok: false, error: 'You are still resting.', retryInMs: cooldownMs - sinceLast };
    }

    const amount = randomBetween(cfg.workMin, cfg.workMax);
    record.lastWorkAt = now;
    record.balance += amount;
    record.totalEarned += amount;
    if (name) record.name = text(name, 80);
    writeUser(serverId, userId, record);

    return { ok: true, amount, balance: record.balance };
  });
}

export type TransferResult = { ok: boolean; sent?: number; received?: number; balance?: number; error?: string };

export function transfer(fromId: string, toId: string, amount: number, serverId = config.serverId || ''): TransferResult {
  const cfg = settings(serverId).config;
  if (!cfg.enabled) return { ok: false, error: 'The economy is switched off in this server.' };
  if (!cfg.payEnabled) return { ok: false, error: 'Transfers are switched off in this server.' };
  if (fromId === toId) return { ok: false, error: 'You cannot pay yourself.' };

  const value = Math.floor(num(amount, 0));
  if (value <= 0) return { ok: false, error: 'Enter an amount above zero.' };

  // Both sides in one commit: coins never leave one balance without reaching the other.
  return transaction(() => {
    const sender = userRecord(serverId, fromId);
    if (sender.balance < value) return { ok: false, error: 'You do not have that much.' };

    const tax = Math.floor((value * cfg.payTaxPercent) / 100);
    const received = value - tax;

    sender.balance -= value;
    const recipient = userRecord(serverId, toId);
    recipient.balance += received;
    recipient.totalEarned += received;
    writeUser(serverId, fromId, sender);
    writeUser(serverId, toId, recipient);

    return { ok: true, sent: value, received, balance: sender.balance };
  });
}

// ---- Shop ------------------------------------------------------------------

export type PurchaseResult = { ok: boolean; item?: ShopItem; balance?: number; roleGranted?: boolean; error?: string };

/**
 * Buy an item. The role grant is attempted after the coins are taken; a failed
 * grant is reported rather than silently refunded, because the purchase is
 * still recorded in the buyer's inventory and a moderator can hand the role
 * over by hand.
 */
export async function buyItem(client: any, userId: string, itemRef: string, serverId = config.serverId || ''): Promise<PurchaseResult> {
  if (!settings(serverId).config.enabled) return { ok: false, error: 'The economy is switched off in this server.' };

  // The balance, the inventory and the stock change together, before any await.
  const purchase = transaction((): PurchaseResult => {
    const current = settings(serverId);
    const needle = String(itemRef || '').trim().toLowerCase();
    const index = current.shop.findIndex((entry) => entry.id === itemRef || entry.name.toLowerCase() === needle);
    if (index < 0) return { ok: false, error: 'No shop item by that name.' };
    const item = current.shop[index];
    if (item.stock != null && item.stock <= 0) return { ok: false, error: 'That item is sold out.' };

    const record = userRecord(serverId, userId);
    const owned = record.inventory[item.id] || 0;
    if (item.perUserLimit > 0 && owned >= item.perUserLimit) {
      return { ok: false, error: `You already own the maximum of ${item.perUserLimit}.` };
    }
    if (record.balance < item.price) return { ok: false, error: 'You cannot afford that.' };

    record.balance -= item.price;
    record.inventory[item.id] = owned + 1;
    writeUser(serverId, userId, record);

    const sold = item.stock != null ? { ...item, stock: Math.max(0, item.stock - 1) } : item;
    if (sold !== item) {
      const shop = [...current.shop];
      shop[index] = sold;
      saveSettings(serverId, { ...current, shop });
    }
    return { ok: true, item: { ...sold }, balance: record.balance };
  });
  if (!purchase.ok || !purchase.item) return purchase;

  let roleGranted = false;
  if (purchase.item.roleId) {
    try {
      const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
      const member = await server?.members?.fetch?.(userId).catch(() => server?.members?.cache?.get?.(userId) || null);
      if (member?.addRole) {
        await member.addRole(purchase.item.roleId);
        roleGranted = true;
      }
    } catch (error) {
      debug('economy', () => `role grant failed: ${(error as Error)?.message || error}`);
    }
  }

  return { ...purchase, roleGranted };
}

export function inventoryOf(userId: string, serverId = config.serverId || ''): { item: ShopItem; count: number }[] {
  const { shop } = settings(serverId);
  const record = peekRecord(serverId, userId);
  if (!record) return [];
  return Object.entries(record.inventory)
    .filter(([, count]) => count > 0)
    .map(([itemId, count]) => {
      const item = shop.find((entry) => entry.id === itemId);
      return item ? { item: { ...item }, count } : null;
    })
    .filter(Boolean) as { item: ShopItem; count: number }[];
}

// ---- Gambling --------------------------------------------------------------

export type GambleResult = { ok: boolean; won?: boolean; delta?: number; balance?: number; roll?: number; error?: string };

/**
 * A single coin-flip style bet: 47.5% to double, otherwise the stake is lost.
 * The house edge is deliberate and fixed — a fair coin makes the currency
 * meaningless over time.
 */
export function gamble(userId: string, amount: number, serverId = config.serverId || ''): GambleResult {
  const cfg = settings(serverId).config;
  if (!cfg.enabled) return { ok: false, error: 'The economy is switched off in this server.' };
  if (!cfg.gamblingEnabled) return { ok: false, error: 'Gambling is switched off in this server.' };

  const bet = Math.floor(num(amount, 0));
  if (bet <= 0) return { ok: false, error: 'Enter a bet above zero.' };
  if (bet > cfg.gambleMaxBet) return { ok: false, error: `The maximum bet is ${cfg.gambleMaxBet}.` };

  return transaction(() => {
    const record = userRecord(serverId, userId);
    if (record.balance < bet) return { ok: false, error: 'You do not have that much.' };

    const roll = Math.random();
    const won = roll < 0.475;
    const delta = won ? bet : -bet;
    record.balance = Math.max(0, record.balance + delta);
    if (won) record.totalEarned += bet;
    writeUser(serverId, userId, record);

    return { ok: true, won, delta, balance: record.balance, roll: Math.round(roll * 1000) / 10 };
  });
}
