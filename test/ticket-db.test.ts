/**
 * Ticket database lifecycle + cooldown math. Runs against a throwaway data
 * directory (YAOSB_DATA_DIR) so it never touches real ticket data. The env
 * var is set before the store module is imported (dynamically) so json-store
 * picks up the temp path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-db-'));
const { ticketDb, ticketCooldownDb } = await import('../src/database.js');

test('create → getById / getByChannelId / open+closed queries', () => {
  const created = ticketDb.create({ creatorId: 'u1', serverId: 'srvT', reason: 'need help' });
  assert.ok(created.ticketId);
  assert.equal(created.status, 'open');

  assert.equal(ticketDb.getById(created.ticketId)?.creatorId, 'u1');

  ticketDb.update(created.ticketId, { channelId: 'chan-1' });
  assert.equal(ticketDb.getByChannelId('chan-1')?.ticketId, created.ticketId);

  const open = ticketDb.getOpenTickets('srvT').map((t) => t.ticketId);
  assert.ok(open.includes(created.ticketId));

  ticketDb.update(created.ticketId, { status: 'closed' });
  assert.ok(ticketDb.getClosedTickets('srvT').some((t) => t.ticketId === created.ticketId));
  assert.ok(!ticketDb.getOpenTickets('srvT').some((t) => t.ticketId === created.ticketId));
});

test('ticket ids increment monotonically', () => {
  const a = ticketDb.create({ creatorId: 'u2', serverId: 'srvT' });
  const b = ticketDb.create({ creatorId: 'u3', serverId: 'srvT' });
  assert.equal(Number(b.ticketId), Number(a.ticketId) + 1);
});

test('open tickets are scoped by server id', () => {
  ticketDb.create({ creatorId: 'u4', serverId: 'srvOther' });
  const forT = ticketDb.getOpenTickets('srvT').every((t) => t.serverId === 'srvT');
  assert.ok(forT);
});

test('delete removes a ticket', () => {
  const t = ticketDb.create({ creatorId: 'u5', serverId: 'srvT' });
  assert.equal(ticketDb.delete(t.ticketId), true);
  assert.equal(ticketDb.getById(t.ticketId), null);
  assert.equal(ticketDb.delete(t.ticketId), false);
});

test('cooldown: unknown user has no remaining time', () => {
  assert.equal(ticketCooldownDb.getRemainingMs('never-seen', 60_000), 0);
});

test('cooldown: remaining time counts down and expires', () => {
  const now = Date.now();
  ticketCooldownDb.setLastCreatedAt('cu', new Date(now).toISOString());
  assert.ok(ticketCooldownDb.getRemainingMs('cu', 10_000, now) > 0);
  // Once the window has elapsed, remaining is zero.
  assert.equal(ticketCooldownDb.getRemainingMs('cu', 10_000, now + 20_000), 0);
});
