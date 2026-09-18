/**
 * Economy: the rules that decide whether currency moves — cooldowns, streaks,
 * the transfer tax, shop stock and per-member limits.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-economy-'));

const {
  addBalance,
  addShopItem,
  buyItem,
  claimDaily,
  doWork,
  gamble,
  getBalance,
  getRichList,
  inventoryOf,
  listShop,
  resetEconomyAll,
  setBalance,
  setEconomyConfig,
  transfer,
} = await import('../src/economy.js');

/** No server, no roles: purchases that grant a role simply report that. */
const client = { servers: { cache: { get: () => null }, fetch: async () => null } };

test('everything is refused while the economy is off', () => {
  setEconomyConfig({ enabled: false }, 'off');
  assert.equal(claimDaily('u1', 'off').ok, false);
  assert.equal(doWork('u1', 'off').ok, false);
  assert.equal(transfer('u1', 'u2', 10, 'off').ok, false);
});

test('daily can only be claimed once, and reports the wait', () => {
  setEconomyConfig({ enabled: true, dailyAmount: 100, dailyStreakBonus: 25 }, 'srv');

  const first = claimDaily('u1', 'srv');
  assert.equal(first.ok, true);
  assert.equal(first.amount, 100);
  assert.equal(first.streak, 1);

  const second = claimDaily('u1', 'srv');
  assert.equal(second.ok, false);
  assert.ok((second.retryInMs || 0) > 0);
});

test('work respects its own cooldown', () => {
  setEconomyConfig({ enabled: true, workMin: 10, workMax: 10, workCooldownSec: 3600 }, 'srv');
  assert.equal(doWork('u2', 'srv').amount, 10);
  const again = doWork('u2', 'srv');
  assert.equal(again.ok, false);
  assert.ok((again.retryInMs || 0) > 0);
});

test('transfers move the amount, take the tax, and refuse what is not there', () => {
  setEconomyConfig({ enabled: true, payEnabled: true, payTaxPercent: 10 }, 'pay');
  setBalance('sender', 100, 'pay');

  const sent = transfer('sender', 'receiver', 50, 'pay');
  assert.equal(sent.ok, true);
  assert.equal(sent.sent, 50);
  assert.equal(sent.received, 45, '10% tax is burned');
  assert.equal(getBalance('sender', 'pay').balance, 50);
  assert.equal(getBalance('receiver', 'pay').balance, 45);

  assert.equal(transfer('sender', 'receiver', 500, 'pay').ok, false, 'cannot send what you do not have');
  assert.equal(transfer('sender', 'sender', 5, 'pay').ok, false, 'cannot pay yourself');
});

test('transfers can be switched off entirely', () => {
  setEconomyConfig({ enabled: true, payEnabled: false }, 'pay');
  setBalance('sender', 100, 'pay');
  assert.equal(transfer('sender', 'receiver', 10, 'pay').ok, false);
});

test('a purchase takes the coins, the stock, and respects the per-member limit', async () => {
  setEconomyConfig({ enabled: true }, 'shop');
  const item = addShopItem({ name: 'Badge', price: 30, stock: 2, perUserLimit: 1 }, 'shop');
  assert.ok(item);
  setBalance('buyer', 100, 'shop');

  const bought = await buyItem(client, 'buyer', 'Badge', 'shop');
  assert.equal(bought.ok, true);
  assert.equal(bought.balance, 70);
  assert.equal(bought.roleGranted, false, 'no role configured');
  assert.equal(listShop('shop')[0].stock, 1);
  assert.equal(inventoryOf('buyer', 'shop')[0].count, 1);

  const again = await buyItem(client, 'buyer', 'Badge', 'shop');
  assert.equal(again.ok, false);
  assert.match(String(again.error), /maximum/i);
});

test('an unaffordable or unknown item is refused', async () => {
  setEconomyConfig({ enabled: true }, 'shop2');
  addShopItem({ name: 'Statue', price: 1000 }, 'shop2');
  setBalance('broke', 10, 'shop2');

  assert.match(String((await buyItem(client, 'broke', 'Statue', 'shop2')).error), /afford/i);
  assert.match(String((await buyItem(client, 'broke', 'Nothing', 'shop2')).error), /no shop item/i);
});

test('gambling is off until enabled, then capped', () => {
  setEconomyConfig({ enabled: true, gamblingEnabled: false }, 'bet');
  setBalance('player', 1000, 'bet');
  assert.equal(gamble('player', 10, 'bet').ok, false);

  setEconomyConfig({ gamblingEnabled: true, gambleMaxBet: 100 }, 'bet');
  assert.match(String(gamble('player', 500, 'bet').error), /maximum bet/i);

  const played = gamble('player', 50, 'bet');
  assert.equal(played.ok, true);
  assert.equal(Math.abs(played.delta || 0), 50);
});

test('a balance never goes below zero', () => {
  setBalance('floor', 10, 'srv');
  assert.equal(addBalance('floor', -999, 'srv'), 0);
});

test('the leaderboard ranks by balance and reset clears it', () => {
  setEconomyConfig({ enabled: true }, 'board');
  setBalance('rich', 500, 'board');
  setBalance('poor', 5, 'board');

  const rows = getRichList(10, 'board');
  assert.equal(rows[0].userId, 'rich');
  assert.equal(rows[0].rank, 1);

  resetEconomyAll('board');
  assert.equal(getRichList(10, 'board').length, 0);
});
