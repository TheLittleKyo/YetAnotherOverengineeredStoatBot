/**
 * Regression test for multi-server log routing (the bug where every server's
 * events were logged to the ONE configured server's log channel).
 *
 * Asserts that:
 *   - sendServerLog with a given serverId hits that server's channel only.
 *   - an event helper (logMemberJoin) derives the origin server from the event
 *     payload and routes there — NOT to the default server's channel.
 *   - a server with no logging configured produces no send.
 *
 * Runs against a throwaway data dir so log config writes are isolated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-logs-'));
const { setLogChannel, sendServerLog, logMemberJoin } = await import('../src/log-system.js');

setLogChannel('chanA', 'srvA');
setLogChannel('chanB', 'srvB');

// Minimal fake client that records which channel .send() was called on.
function makeClient() {
  const sent: { id: string }[] = [];
  const make = (id: string) => ({ id, send: async () => { sent.push({ id }); } });
  const cache = new Map([['chanA', make('chanA')], ['chanB', make('chanB')]]);
  const client = {
    channels: {
      cache: { get: (id: string) => cache.get(id) },
      fetch: async (id: string) => cache.get(id) || null,
    },
  } as any;
  return { client, sent };
}

test('sendServerLog routes to the channel of the given server', async () => {
  const { client, sent } = makeClient();
  await sendServerLog(client, { title: 't', description: 'd' }, 'srvA');
  assert.deepEqual(sent.map((s) => s.id), ['chanA']);
});

test('sendServerLog for server B never touches server A channel', async () => {
  const { client, sent } = makeClient();
  await sendServerLog(client, { title: 't', description: 'd' }, 'srvB');
  assert.deepEqual(sent.map((s) => s.id), ['chanB']);
});

test('logMemberJoin derives the origin server from the event payload', async () => {
  const { client, sent } = makeClient();
  // Member carrying a composite _id → server srvB. Pre-fix this went to the
  // default server's channel regardless of origin.
  await logMemberJoin(client, { _id: { server: 'srvB', user: 'u1' }, user: { username: 'x' } });
  assert.deepEqual(sent.map((s) => s.id), ['chanB']);
});

test('a server with no logging configured produces no send', async () => {
  const { client, sent } = makeClient();
  const result = await sendServerLog(client, { title: 't', description: 'd' }, 'srvUnconfigured');
  assert.equal(result, false);
  assert.equal(sent.length, 0);
});
