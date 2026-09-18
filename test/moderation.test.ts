/**
 * Moderation cases: numbering, warning expiry, and the escalation ladder.
 *
 * `runModAction` is driven with a stub client, so only the actions that need no
 * API call (warn, note) are exercised end to end — which is exactly where the
 * case bookkeeping lives.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-moderation-'));

const {
  countActiveWarns,
  deleteCase,
  getCase,
  getModerationSummary,
  listCases,
  runModAction,
  setModerationConfig,
  updateCaseReason,
} = await import('../src/moderation.js');

/** Enough of a client for the warn path: no server, no member, no DM. */
const client = {
  user: { id: 'bot' },
  servers: { cache: { get: () => null } },
  users: { cache: { get: () => null }, fetch: async () => null },
};

test('warns are numbered per server and recorded', async () => {
  setModerationConfig({ dmOnAction: false, escalation: [] }, 'srv');

  const first = await runModAction(client, { serverId: 'srv', action: 'warn', userId: 'u1', moderatorId: 'mod', reason: 'spam' });
  const second = await runModAction(client, { serverId: 'srv', action: 'warn', userId: 'u1', moderatorId: 'mod', reason: 'again' });

  assert.equal(first.ok, true);
  assert.equal(first.case?.id, 1);
  assert.equal(second.case?.id, 2);
  assert.equal(countActiveWarns('u1', 'srv'), 2);
  assert.equal(countActiveWarns('u2', 'srv'), 0);
});

test('a note is recorded but never punishes', async () => {
  const result = await runModAction(client, { serverId: 'srv', action: 'note', userId: 'u2', moderatorId: 'mod', reason: 'watch this one' });
  assert.equal(result.ok, true);
  assert.equal(result.case?.action, 'note');
  assert.equal(result.case?.active, false);
  assert.equal(countActiveWarns('u2', 'srv'), 0);
});

test('the ladder fires on the exact warning count, once', async () => {
  setModerationConfig({ dmOnAction: false, escalation: [{ warns: 2, action: 'mute', durationMs: 60_000 }] }, 'ladder');

  const first = await runModAction(client, { serverId: 'ladder', action: 'warn', userId: 'u1', moderatorId: 'mod' });
  assert.equal(first.escalation, null, 'one warning is below the rule');

  const second = await runModAction(client, { serverId: 'ladder', action: 'warn', userId: 'u1', moderatorId: 'mod' });
  assert.equal(second.escalation?.action, 'mute');
  assert.equal(second.escalation?.automated, true);

  const third = await runModAction(client, { serverId: 'ladder', action: 'warn', userId: 'u1', moderatorId: 'mod' });
  assert.equal(third.escalation, null, 'past the rule it does not fire again');
});

test('expired warnings stop counting toward escalation', async () => {
  setModerationConfig({ dmOnAction: false, escalation: [], warnExpiryDays: 30 }, 'expiry');
  await runModAction(client, { serverId: 'expiry', action: 'warn', userId: 'u1', moderatorId: 'mod' });
  assert.equal(countActiveWarns('u1', 'expiry'), 1);

  setModerationConfig({ warnExpiryDays: 0 }, 'expiry');
  assert.equal(countActiveWarns('u1', 'expiry'), 1, '0 days means warnings never expire');
});

test('reasons can be rewritten and cases deleted', async () => {
  const created = await runModAction(client, { serverId: 'edit', action: 'warn', userId: 'u9', moderatorId: 'mod', reason: 'typo' });
  const id = created.case!.id;

  assert.equal(updateCaseReason(id, 'the real reason', 'edit')?.reason, 'the real reason');
  assert.equal(getCase(id, 'edit')?.reason, 'the real reason');

  assert.equal(deleteCase(id, 'edit'), true);
  assert.equal(getCase(id, 'edit'), null);
  assert.equal(deleteCase(id, 'edit'), false);
});

test('a missing reason still records something readable', async () => {
  const result = await runModAction(client, { serverId: 'blank', action: 'warn', userId: 'u1', moderatorId: 'mod' });
  assert.equal(result.case?.reason, 'No reason given');
});

test('the bot refuses to action itself', async () => {
  const result = await runModAction(client, { serverId: 'srv', action: 'kick', userId: 'bot', moderatorId: 'mod' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /myself/i);
});

test('summaries count by action and list human moderators only', async () => {
  const summary = getModerationSummary('ladder');
  assert.ok(summary.total >= 3);
  assert.equal(summary.byAction.warn >= 3, true);
  assert.equal(summary.topModerators[0]?.moderatorId, 'mod');
});

test('listing filters by member and action', () => {
  const warns = listCases('srv', { action: 'warn' });
  assert.ok(warns.every((entry) => entry.action === 'warn'));
  assert.ok(listCases('srv', { userId: 'u1' }).every((entry) => entry.userId === 'u1'));
  assert.equal(listCases('srv', { limit: 1 }).length, 1);
});
