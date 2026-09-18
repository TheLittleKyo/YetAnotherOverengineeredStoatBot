/**
 * Antiraid honeypot channel: posting there deletes the message and actions the
 * author, staff are exempt, bursts cost one member lookup, a kicked raider who
 * rejoins is kicked again, and hits are reported in one batched alert.
 *
 * Runs against a throwaway data dir so antiraid config writes are isolated.
 * Each test uses its own server id because the honeypot keeps per-server
 * runtime state in memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-antiraid-'));
const {
  setAntiraidConfig,
  getAntiraidConfig,
  handleHoneypotMessage,
  createHoneypotChannel,
  inspectHoneypotChannel,
  flushHoneypotAlerts,
  wasDeletedByHoneypot,
} = await import('../src/antiraid.js');
const { antiraidCommand } = await import('../src/commands/antiraid.js');

const TRAP = 'trap';
const KNOWN_PERMISSIONS = ['ManageServer', 'ManageChannel', 'ManageMessages', 'KickMembers', 'BanMembers'];

type WorldOptions = {
  perms?: Record<string, string[]>;
  failFetch?: () => boolean;
  failBan?: boolean;
};

// Minimal fake of the stoatbot client surface the honeypot touches.
function makeWorld(serverId: string, opts: WorldOptions = {}) {
  const calls: { method: string; path: string; body?: any }[] = [];
  const alerts: any[] = [];
  const channels = new Map<string, any>();
  let memberFetches = 0;
  let created = 0;

  function addChannel(id: string, extra: any = {}) {
    const channel: any = {
      id,
      serverId,
      name: id,
      type: 'TEXT',
      sent: [] as any[],
      send: async (payload: any) => { channel.sent.push(payload); },
      messages: { fetch: async () => new Map() },
      ...extra,
    };
    channels.set(id, channel);
    return channel;
  }
  addChannel(TRAP);
  addChannel('alerts', { send: async (payload: any) => { alerts.push(payload.embeds[0].toJSON()); } });

  const member = (id: string) => ({
    id,
    hasPermission: (permission: string) => {
      if (!KNOWN_PERMISSIONS.includes(permission)) throw new RangeError(`unknown permission ${permission}`);
      return (opts.perms?.[id] || []).includes(permission);
    },
  });

  const server = {
    id: serverId,
    ownerId: 'owner',
    members: {
      fetch: async (id: string) => {
        memberFetches++;
        if (opts.failFetch?.()) throw new Error('API call failed with status 429: Too Many Requests');
        return member(id);
      },
      cache: { get: () => null },
    },
    channels: { create: async ({ name }: any) => addChannel(`created${++created}`, { name }) },
  };

  const client = {
    user: { id: 'bot' },
    servers: { cache: { get: (id: string) => (id === serverId ? server : null) }, fetch: async () => server },
    channels: {
      cache: { get: (id: string) => channels.get(id) || null },
      fetch: async (id: string) => channels.get(id) || null,
    },
    api: {
      put: async (path: string, body: any) => {
        if (opts.failBan) throw new Error('API call failed with status 403: Forbidden');
        calls.push({ method: 'PUT', path, body });
      },
      delete: async (path: string) => { calls.push({ method: 'DELETE', path }); },
    },
  } as any;

  setAntiraidConfig(serverId, { enabled: true, honeypotChannelId: TRAP, honeypotAction: 'ban', alertChannelId: 'alerts' });

  let seq = 0;
  const message = (authorId: string, extra: any = {}) => {
    const m: any = { id: `${serverId}-m${++seq}`, authorId, channelId: TRAP, serverId, deleted: false, ...extra };
    m.delete = async () => { m.deleted = true; };
    return m;
  };

  return { client, calls, alerts, channels, addChannel, message, memberFetches: () => memberFetches, created: () => created };
}

const bans = (calls: any[]) => calls.filter((c) => c.method === 'PUT');
const kicks = (calls: any[]) => calls.filter((c) => c.method === 'DELETE' && c.path.includes('/members/'));

test('ban sends the reason as a JSON body and deletes the message', async () => {
  const w = makeWorld('srv-ban');
  const m = w.message('raider');
  assert.equal(await handleHoneypotMessage(w.client, m), true);
  assert.equal(m.deleted, true);
  assert.deepEqual(bans(w.calls), [
    { method: 'PUT', path: '/servers/srv-ban/bans/raider', body: { body: { reason: 'Antiraid: posted in honeypot channel' } } },
  ]);
  await flushHoneypotAlerts(w.client, 'srv-ban');
});

test('a spam burst bans once and stops looking the member up after the first hit', async () => {
  const w = makeWorld('srv-burst');
  const burst = Array.from({ length: 5 }, () => w.message('spammer'));
  await Promise.all(burst.map((m) => handleHoneypotMessage(w.client, m)));
  for (let i = 0; i < 15; i++) await handleHoneypotMessage(w.client, w.message('spammer'));

  assert.equal(bans(w.calls).length, 1);
  assert.ok(w.memberFetches() <= 5, `member fetches: ${w.memberFetches()}`);
  assert.ok(burst.every((m) => m.deleted));
  await flushHoneypotAlerts(w.client, 'srv-burst');
});

test('a kicked raider who rejoins and posts again is kicked again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const w = makeWorld('srv-kick');
  setAntiraidConfig('srv-kick', { honeypotAction: 'kick' });

  await handleHoneypotMessage(w.client, w.message('raider'));
  t.mock.timers.tick(1_000); // a message already in flight when the kick landed
  await handleHoneypotMessage(w.client, w.message('raider'));
  assert.equal(kicks(w.calls).length, 1);

  t.mock.timers.tick(5_000); // rejoined and posted again
  await handleHoneypotMessage(w.client, w.message('raider'));
  assert.equal(kicks(w.calls).length, 2);
  await flushHoneypotAlerts(w.client, 'srv-kick');
});

test('owner and staff with any moderation permission are exempt', async () => {
  const w = makeWorld('srv-staff', {
    perms: { mod: ['ManageMessages'], kicker: ['KickMembers'], admin: ['ManageServer'] },
  });
  for (const author of ['owner', 'mod', 'kicker', 'admin']) {
    const m = w.message(author);
    assert.equal(await handleHoneypotMessage(w.client, m), false, author);
    assert.equal(m.deleted, false, author);
  }
  assert.deepEqual(w.calls, []);
});

test('an unverifiable author gets the message deleted but no action', async () => {
  let failing = true;
  const w = makeWorld('srv-lookup', { failFetch: () => failing });

  const first = w.message('someone');
  assert.equal(await handleHoneypotMessage(w.client, first), true);
  assert.equal(first.deleted, true);
  assert.deepEqual(w.calls, []);

  failing = false; // the next message retries the lookup
  await handleHoneypotMessage(w.client, w.message('someone'));
  assert.equal(bans(w.calls).length, 1);
  await flushHoneypotAlerts(w.client, 'srv-lookup');
});

test('webhook, bot, other-channel and disabled cases are ignored', async () => {
  const w = makeWorld('srv-ignore');
  assert.equal(await handleHoneypotMessage(w.client, w.message('hook', { webhook: { name: 'bridge' } })), false);
  assert.equal(await handleHoneypotMessage(w.client, w.message('bot')), false);
  assert.equal(await handleHoneypotMessage(w.client, w.message('someone', { channelId: 'general' })), false);

  setAntiraidConfig('srv-ignore', { enabled: false });
  const whileOff = w.message('someone');
  assert.equal(await handleHoneypotMessage(w.client, whileOff), false);
  assert.equal(whileOff.deleted, false);
  assert.deepEqual(w.calls, []);
});

test('a failed ban is reported as failed and retried only after the backoff', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  const w = makeWorld('srv-fail', { failBan: true });

  await handleHoneypotMessage(w.client, w.message('highrank'));
  await flushHoneypotAlerts(w.client, 'srv-fail');
  assert.equal(w.alerts.length, 1);
  assert.match(w.alerts[0].description, /ban failed/);

  const fetchesAfterFirst = w.memberFetches();
  t.mock.timers.tick(10_000);
  await handleHoneypotMessage(w.client, w.message('highrank'));
  assert.equal(w.memberFetches(), fetchesAfterFirst, 'no retry inside the backoff');

  t.mock.timers.tick(61_000);
  await handleHoneypotMessage(w.client, w.message('highrank'));
  assert.equal(w.memberFetches(), fetchesAfterFirst + 1, 'retried after the backoff');
  await flushHoneypotAlerts(w.client, 'srv-fail');
});

test('hits are batched into one alert and their deletes skip the delete log', async () => {
  const w = makeWorld('srv-batch');
  const trapped: any[] = [];
  for (const raider of ['r1', 'r2', 'r3']) {
    for (let i = 0; i < 2; i++) {
      const m = w.message(raider);
      trapped.push(m);
      await handleHoneypotMessage(w.client, m);
    }
  }
  assert.equal(w.alerts.length, 0, 'nothing sent before the batch flushes');
  await flushHoneypotAlerts(w.client, 'srv-batch');

  assert.equal(w.alerts.length, 1);
  assert.equal(w.alerts[0].title, 'Honeypot caught 3 users');
  assert.match(w.alerts[0].description, /`r1` — banned, 2 messages deleted/);

  assert.equal(wasDeletedByHoneypot(trapped[0].id), true);
  assert.equal(wasDeletedByHoneypot(trapped[0].id), false, 'consumed once');
  assert.equal(wasDeletedByHoneypot('unrelated'), false);
});

test('createHoneypotChannel refuses a second channel while the first exists', async () => {
  const w = makeWorld('srv-create');
  setAntiraidConfig('srv-create', { honeypotChannelId: null });

  const { channelId, settings } = await createHoneypotChannel(w.client, 'srv-create');
  assert.equal(settings.honeypotChannelId, channelId);
  const notice = w.channels.get(channelId).sent[0].embeds[0].toJSON().description;
  assert.match(notice, /kicked or banned/);

  await assert.rejects(createHoneypotChannel(w.client, 'srv-create'), (error: any) => error.code === 'HONEYPOT_EXISTS');
  assert.equal(w.created(), 1);

  w.channels.delete(channelId); // channel deleted by hand: creating again is allowed
  const again = await createHoneypotChannel(w.client, 'srv-create');
  assert.equal(getAntiraidConfig('srv-create').honeypotChannelId, again.channelId);
});

test('antiraid command asks for confirm before using a live channel and refuses a duplicate', async () => {
  const w = makeWorld('srv-cmd', { perms: { admin: ['ManageServer'] } });
  setAntiraidConfig('srv-cmd', { honeypotChannelId: null });
  w.addChannel('general', { messages: { fetch: async () => new Map([['1', { authorId: 'u1' }]]) } });

  const replies: string[] = [];
  const run = (...args: string[]) => antiraidCommand(
    { authorId: 'admin', serverId: 'srv-cmd', channel: { send: async (p: any) => { replies.push(p.content); } } },
    args,
    w.client,
  );

  await run('set', 'honeypot', 'general');
  assert.match(replies.at(-1)!, /1 member has posted recently/);
  assert.equal(getAntiraidConfig('srv-cmd').honeypotChannelId, null);

  await run('set', 'honeypot', 'general', 'confirm');
  assert.equal(getAntiraidConfig('srv-cmd').honeypotChannelId, 'general');

  await run('set', 'alert', 'general');
  assert.match(replies.at(-1)!, /cannot be the honeypot/);

  await run('honeypot', 'create');
  assert.match(replies.at(-1)!, /already has a honeypot channel: <#general>/);
  assert.equal(w.created(), 0);
});

test('inspectHoneypotChannel flags live channels and rejects bad targets', async () => {
  const w = makeWorld('srv-inspect');
  const history = (authors: any[]) => ({ fetch: async () => new Map(authors.map((a, i) => [String(i), a])) });

  w.addChannel('general', { messages: history([{ authorId: 'u1' }, { authorId: 'u2' }, { authorId: 'u1' }, { authorId: 'bot' }, { authorId: 'hook', webhook: {} }]) });
  w.addChannel('empty');
  w.addChannel('unreadable', { messages: { fetch: async () => { throw new Error('403'); } } });
  w.addChannel('voice', { type: 'VOICE' });
  w.addChannel('elsewhere', { serverId: 'other-server' });

  assert.deepEqual(await inspectHoneypotChannel(w.client, 'srv-inspect', 'general'), { ok: true, name: 'general', recentPosters: 2 });
  assert.deepEqual(await inspectHoneypotChannel(w.client, 'srv-inspect', 'empty'), { ok: true, name: 'empty', recentPosters: 0 });
  assert.equal(((await inspectHoneypotChannel(w.client, 'srv-inspect', 'unreadable')) as any).recentPosters, null);

  for (const id of ['voice', 'elsewhere', 'alerts', 'missing']) {
    assert.equal((await inspectHoneypotChannel(w.client, 'srv-inspect', id)).ok, false, id);
  }
});
