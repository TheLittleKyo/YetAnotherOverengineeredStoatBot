/**
 * The SQLite-backed stores (src/db.ts): each old JSON file is imported once and
 * set aside, rows are written as they change, and the queries that replaced
 * in-memory sorting agree with each other. Backups still see economy and
 * moderation as JSON files.
 *
 * Runs against a throwaway data directory (YAOSB_DATA_DIR) seeded with the old
 * files before any store is imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'yaosb-sqlite-'));
process.env.YAOSB_DATA_DIR = dir;

const seed = (name: string, data: unknown) => writeFileSync(join(dir, name), JSON.stringify(data));

seed('leveling.json', {
  version: 1,
  servers: {
    LV: {
      config: { enabled: true, xpMin: 5, xpMax: 5, cooldownSeconds: 0 },
      roleRewards: [{ level: 2, roleId: 'ROLE2' }],
      users: {
        alice: { xp: 500, name: 'Alice', lastXpAt: 0 },
        bob: { xp: 300, name: 'Bob', lastXpAt: 0 },
        carol: { xp: 300, name: 'Carol', lastXpAt: 0 },
      },
    },
  },
});
seed('economy.json', {
  version: 1,
  servers: {
    EC: {
      config: { enabled: true, payEnabled: true, payTaxPercent: 10 },
      shop: [{ id: 'it_1', name: 'Badge', price: 30, stock: 1, perUserLimit: 0 }],
      users: { rich: { balance: 100, name: 'Rich', inventory: {} } },
    },
  },
});
seed('moderation.json', {
  version: 1,
  servers: {
    MD: {
      config: { dmOnAction: false, escalation: [] },
      nextCaseId: 9,
      cases: [
        { id: 7, userId: 'u1', action: 'warn', reason: 'old', createdAt: 1, moderatorId: 'm1', moderatorName: 'Mod' },
        { id: 8, userId: 'u2', action: 'ban', reason: 'temp', createdAt: 2, expiresAt: 1000, durationMs: 999, active: true },
      ],
    },
  },
});
seed('audit.json', {
  version: 1,
  servers: { AU: [{ id: 'au_old', at: 1, area: 'economy', action: 'settings', actorName: 'Someone', source: 'dashboard' }] },
});
seed('analytics.json', {
  version: 1,
  startedAt: '2020-01-01T00:00:00.000Z',
  servers: { AN: { since: '2020-01-01T00:00:00.000Z', hours: [0, 0, 7], commands: { ping: 4 }, channels: { c1: { messages: 9, lastAt: 5 } }, voice: { totalMinutes: 12, sessions: 2 } } },
});
seed('channel-sync-messages.json', {
  version: 1,
  entries: [{ linkId: 'L', sourceChannelId: 'A', sourceId: 'S1', targetChannelId: 'B', targetId: 'T1', at: '2020-01-01T00:00:00.000Z' }],
});

const db = await import('../src/db.js');
const leveling = await import('../src/leveling.js');
const economy = await import('../src/economy.js');
const moderation = await import('../src/moderation.js');
const audit = await import('../src/audit.js');
const analytics = await import('../src/analytics.js');
const sync = await import('../src/sync.js');
const store = await import('../src/json-store.js');

test('each old JSON file is imported on first use and set aside as .migrated.bak', () => {
  assert.equal(leveling.getTrackedUserCount('LV'), 3);
  assert.deepEqual(leveling.getRoleRewards('LV'), [{ level: 2, roleId: 'ROLE2' }]);
  assert.equal(economy.getBalance('rich', 'EC').balance, 100);
  assert.equal(moderation.getCase(7, 'MD')?.reason, 'old');
  assert.equal(audit.listAudit('AU')[0]?.id, 'au_old');
  const summary = analytics.getAnalyticsSummary({ serverId: 'AN' });
  assert.equal(summary.hours[2], 7);
  assert.equal(summary.voice.totalMinutes, 12);
  assert.deepEqual(summary.commands, [{ name: 'ping', count: 4 }]);
  assert.equal(sync.listMirrorRows({ limit: 10 })[0]?.targetId, 'T1');

  for (const name of ['leveling.json', 'economy.json', 'moderation.json', 'audit.json', 'analytics.json', 'channel-sync-messages.json']) {
    assert.equal(existsSync(join(dir, name)), false, `${name} moved aside`);
    assert.ok(existsSync(join(dir, `${name}.migrated.bak`)), `${name}.migrated.bak kept`);
  }
});

test('a file already imported is not imported again unless it is newer', () => {
  const name = 'probe.json';
  const rows: unknown[] = [];
  writeFileSync(join(dir, name), JSON.stringify({ n: 1 }));
  db.importLegacyJson(name, (data) => rows.push(data));
  assert.equal(rows.length, 1);

  // The rename failed (simulated): the same, older file shows up again.
  writeFileSync(join(dir, name), JSON.stringify({ n: 2 }));
  utimesSync(join(dir, name), new Date(1000), new Date(1000));
  db.importLegacyJson(name, (data) => rows.push(data));
  assert.equal(rows.length, 1, 'an older file is skipped');

  // A file dropped in later is taken.
  writeFileSync(join(dir, name), JSON.stringify({ n: 3 }));
  utimesSync(join(dir, name), new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
  db.importLegacyJson(name, (data) => rows.push(data));
  assert.deepEqual(rows.at(-1), { n: 3 });
});

test('the leaderboard and a member rank agree, ties broken by user id', () => {
  const board = leveling.getLeaderboard(10, 'LV');
  assert.deepEqual(board.map((row) => [row.userId, row.rank]), [['alice', 1], ['bob', 2], ['carol', 3]]);
  for (const row of board) assert.equal(leveling.getUserRank(row.userId, 'LV')?.rank, row.rank);
  assert.equal(leveling.getUserRank('nobody', 'LV'), null);
});

test('message XP is written to the row at once', () => {
  const message = { serverId: 'LV', authorId: 'dave', author: { username: 'Dave' }, content: 'hello', channelId: 'c' };
  leveling.recordMessageXp({ user: { id: 'bot' } }, message);
  const row = db.sql('SELECT xp, name FROM leveling_users WHERE server_id = ? AND user_id = ?').get('LV', 'dave') as any;
  assert.deepEqual({ xp: row.xp, name: row.name }, { xp: 5, name: 'Dave' });
});

test('a transfer moves coins in one commit, and a failed one moves nothing', () => {
  const ok = economy.transfer('rich', 'poor', 50, 'EC');
  assert.deepEqual([ok.ok, ok.received], [true, 45]);
  assert.equal(economy.getBalance('rich', 'EC').balance, 50);
  assert.equal(economy.getBalance('poor', 'EC').balance, 45);

  const refused = economy.transfer('poor', 'rich', 1000, 'EC');
  assert.equal(refused.ok, false);
  assert.equal(economy.getBalance('poor', 'EC').balance, 45);
  assert.deepEqual(economy.getRichList(5, 'EC').map((row) => row.userId), ['rich', 'poor']);
});

test('a purchase takes the coins and the last item of stock together', async () => {
  const bought = await economy.buyItem({}, 'poor', 'badge', 'EC');
  assert.equal(bought.ok, true);
  assert.equal(economy.getBalance('poor', 'EC').balance, 15);
  assert.equal(economy.listShop('EC')[0].stock, 0);
  assert.equal((await economy.buyItem({}, 'rich', 'badge', 'EC')).error, 'That item is sold out.');
});

test('activity.recordMessage keeps a stored name and avatar when a later message carries none', async () => {
  const activity = await import('../src/activity.js');
  const client = { user: { id: 'BOT' } };
  const img = [{ contentType: 'image/png', filename: 'a.png' }];
  activity.recordMessage(client, { serverId: 'ACT', channel: { serverId: 'ACT' }, channelId: 'c', authorId: 'u1', member: { nickname: 'Nick', avatar: { _id: 'av1' } }, content: 'hi', attachments: img });
  activity.recordMessage(client, { serverId: 'ACT', channel: { serverId: 'ACT' }, authorId: 'u1', author: {}, content: 'again', attachments: [] });
  const sum = activity.getActivitySummary({ serverId: 'ACT', days: 2, topN: 10 });
  assert.equal(sum.totals.messages, 2);
  assert.equal(sum.totals.images, 1);
  const u1 = sum.topMessages.find((r) => r.userId === 'u1')!;
  assert.deepEqual([u1.messages, u1.name, u1.avatarId, u1.images], [2, 'Nick', 'av1', 1]);
  assert.equal(sum.activeToday, 1);
});

test('a throw inside a transaction rolls back every write in it', () => {
  db.setMeta('rb0', 'kept');
  assert.throws(() => db.transaction(() => {
    db.setMeta('rb1', 'x');
    db.setMeta('rb2', 'y');
    throw new Error('boom');
  }));
  assert.equal(db.getMeta('rb1'), null);
  assert.equal(db.getMeta('rb2'), null);
  assert.equal(db.getMeta('rb0'), 'kept');
  // still usable afterwards
  db.transaction(() => db.setMeta('rb3', 'ok'));
  assert.equal(db.getMeta('rb3'), 'ok');
});

test('backups read and restore economy and moderation in their old JSON shape', () => {
  const exported: any = store.readDataFileContent('economy.json');
  assert.equal(exported.servers.EC.users.rich.balance, 50);
  assert.equal(exported.servers.EC.shop[0].stock, 0);

  exported.servers.EC.users.rich.balance = 999;
  store.writeDataFileContent('economy.json', exported);
  store.reloadDataFile('economy.json');
  assert.equal(economy.getBalance('rich', 'EC').balance, 999);
  assert.equal(economy.getBalance('poor', 'EC').balance, 15, 'other rows come back with the restore');

  const cases: any = store.readDataFileContent('moderation.json');
  assert.deepEqual(cases.servers.MD.cases.map((entry: any) => entry.id), [7, 8]);
  assert.equal(cases.servers.MD.nextCaseId, 9);
  assert.ok((store.dataFileSize('moderation.json') || 0) > 0);
});

test('case numbers are never reused, even after the newest case is deleted', async () => {
  const client = { user: { id: 'bot' }, servers: { cache: { get: () => null } }, users: { cache: { get: () => null }, fetch: async () => null } };
  const first = await moderation.runModAction(client, { serverId: 'MD', action: 'warn', userId: 'u3', moderatorId: 'm1' });
  assert.equal(first.case?.id, 9);
  moderation.deleteCase(9, 'MD');
  const second = await moderation.runModAction(client, { serverId: 'MD', action: 'warn', userId: 'u3', moderatorId: 'm1' });
  assert.equal(second.case?.id, 10);
});

test('the expiry tick lifts only what is due, and closes it', async () => {
  const unbanned: string[] = [];
  const client = {
    user: { id: 'bot' },
    api: { delete: async (path: string) => { unbanned.push(path); } },
    servers: { cache: { get: () => null } },
    channels: { cache: { get: () => null }, fetch: async () => null },
  };
  moderation.startModerationScheduler(client);
  try {
    assert.equal(await moderation.expireDue(Date.now()), 1);
  } finally {
    moderation.stopModerationScheduler();
  }
  assert.deepEqual(unbanned, ['/servers/MD/bans/u2']);
  assert.equal(moderation.getCase(8, 'MD')?.active, false);
  assert.equal(moderation.listCases('MD', { activeOnly: true }).length, 0);
});

test('the audit log keeps the newest 2000 entries per server, newest first', () => {
  db.transaction(() => {
    for (let i = 0; i < 2005; i++) audit.recordAudit({ serverId: 'CAP', source: 'system', area: 'test', action: `a${i}` });
  });
  const entries = audit.listAudit('CAP');
  assert.equal(entries.length, 2000);
  assert.equal(entries[0].action, 'a2004');
  assert.equal(entries.at(-1)?.action, 'a5');
  assert.deepEqual(audit.listAuditAreas('CAP'), ['test']);
  assert.equal(audit.listAudit('CAP', { limit: 3 }).length, 3);
});

test('closing and reopening the database keeps every row', () => {
  db.closeDb();
  assert.equal(leveling.getTrackedUserCount('LV'), 4);
  assert.equal(economy.getBalance('rich', 'EC').balance, 999);
});

test('a wipe (the !reset path) empties every table but keeps the schema', () => {
  db.wipeDatabase();
  store.reloadAllDataFiles();
  assert.equal(leveling.getTrackedUserCount('LV'), 0);
  assert.equal(economy.getEconomySummary('EC').holders, 0);
  assert.equal(economy.getEconomyConfig('EC').enabled, false, 'cached settings were dropped with the rows');
  assert.equal(moderation.listCases('MD').length, 0);
  assert.equal(audit.listAudit('CAP').length, 0);
  assert.equal(sync.listMirrorRows({ limit: 10 }).length, 0);
  // Still usable afterwards.
  economy.setEconomyConfig({ enabled: true }, 'EC');
  assert.equal(economy.addBalance('x', 5, 'EC'), 5);
});
