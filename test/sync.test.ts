/**
 * Channel sync: live edit/delete mirroring, and the `sync debug scan`
 * reconciliation that finds drift the live events never saw (messages added,
 * edited or deleted while the bot was offline).
 *
 * Runs against a throwaway data dir and an in-memory fake client, so no network
 * and no real channels are touched.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-sync-'));
const sync = await import('../src/sync.js');

const BOT_ID = 'BOT';
let idCounter = 0;

// ULID-like ids: sortable as strings, in creation order.
function nextId() {
  idCounter += 1;
  return `01TEST${String(idCounter).padStart(10, '0')}`;
}

type FakeMessage = { id: string; channelId: string; authorId: string; author: any; content: string };

function makeChannel(id: string) {
  const store = new Map<string, FakeMessage>();

  const messages = {
    store,
    async fetch(query: any) {
      if (typeof query === 'string') {
        const hit = store.get(query);
        if (!hit) throw new Error('404 Not Found');
        return hit;
      }
      const limit = query?.limit ?? 100;
      const before = query?.before;
      const after = query?.after;
      let list = [...store.values()].sort((a, b) => a.id.localeCompare(b.id));
      if (before) list = list.filter((m) => m.id < before);
      if (after) list = list.filter((m) => m.id > after);
      list = query?.sort === 'Oldest' ? list.slice(0, limit) : list.slice(-limit).reverse();
      return new Map(list.map((m) => [m.id, m]));
    },
    async edit(messageId: string, options: any) {
      const hit = store.get(messageId);
      if (!hit) throw new Error('404 Not Found');
      hit.content = options.content;
    },
    async delete(messageId: string) {
      if (!store.delete(messageId)) throw new Error('404 Not Found');
    },
    async bulkDelete(ids: string[]) {
      for (const messageId of ids) store.delete(messageId);
    },
  };

  const channel = {
    id,
    messages,
    async send(options: any) {
      const msg: FakeMessage = {
        id: nextId(),
        channelId: id,
        authorId: BOT_ID,
        author: { id: BOT_ID, username: options?.masquerade?.name || 'bot' },
        content: options.content || '',
      };
      store.set(msg.id, msg);
      return { id: msg.id, addReaction: async () => {} };
    },
  };

  return channel;
}

function makeClient(...channelIds: string[]) {
  const channels = new Map(channelIds.map((id) => [id, Object.assign(makeChannel(id), { serverId: 'SRV' })]));
  // One server where every caller is an admin — enough for the permission guards.
  // `memberRoles` lets a test hand members roles for the role filters.
  const memberRoles: Record<string, string[]> = {};
  const memberFor = (userId: any) => ({ hasPermission: () => true, roles: memberRoles[String(userId)] || [] });
  const server = {
    id: 'SRV',
    name: 'Test server',
    members: { fetch: async (userId: any) => memberFor(userId), cache: { get: (userId: any) => memberFor(userId) } },
    roles: { cache: new Map([['ROLE_MOD', { id: 'ROLE_MOD', name: 'Moderator' }]]) },
  };
  const client = {
    user: { id: BOT_ID },
    servers: { cache: { get: () => server }, fetch: async () => server },
    channels: {
      cache: { get: (id: string) => channels.get(id) },
      fetch: async (id: string) => channels.get(id) || null,
    },
  } as any;
  return { client, channels, memberRoles };
}

/** Post a user message straight into a fake channel (no event fired). */
function post(channel: any, content: string, authorId = 'USER1'): FakeMessage {
  const msg: FakeMessage = {
    id: nextId(),
    channelId: channel.id,
    authorId,
    author: { id: authorId, username: 'alice' },
    content,
  };
  channel.messages.store.set(msg.id, msg);
  return msg;
}

function copyOf(sourceId: string): string {
  const row = sync.listMirrorRows({ limit: 200 }).find((r) => r.sourceId === sourceId);
  assert.ok(row, `expected a ledger row for ${sourceId}`);
  return row.targetId;
}

test('live edit and delete of a source message follow to the copy', async () => {
  const { client, channels } = makeClient('liveA', 'liveB');
  const a = channels.get('liveA')!;
  const b = channels.get('liveB')!;
  sync.addSyncLink('liveA', 'liveB', 'oneway');

  const msg = post(a, 'hello');
  await sync.mirrorMessageToLinks(client, msg);
  const copyId = copyOf(msg.id);
  assert.equal(b.messages.store.get(copyId)?.content, 'hello');

  msg.content = 'hello, edited';
  await sync.mirrorMessageEdit(client, 'liveA', msg.id, { content: 'hello, edited' });
  assert.equal(b.messages.store.get(copyId)?.content, 'hello, edited');

  a.messages.store.delete(msg.id);
  await sync.mirrorMessageDelete(client, 'liveA', msg.id);
  assert.equal(b.messages.store.has(copyId), false);
  assert.equal(sync.listMirrorRows({ limit: 200 }).some((r) => r.sourceId === msg.id), false);
});

test('an edit to a copy is never bounced back to the source on a twoway link', async () => {
  const { client, channels } = makeClient('loopA', 'loopB');
  const a = channels.get('loopA')!;
  sync.addSyncLink('loopA', 'loopB', 'twoway');

  const msg = post(a, 'original');
  await sync.mirrorMessageToLinks(client, msg);
  const copyId = copyOf(msg.id);

  // The update packet for the bot's own edit of the copy.
  await sync.mirrorMessageEdit(client, 'loopB', copyId, { content: 'should not travel' });
  assert.equal(a.messages.store.get(msg.id)?.content, 'original');
});

test('scan reports added, edited and deleted drift, and --apply repairs it', async () => {
  const { client, channels } = makeClient('scanA', 'scanB');
  const a = channels.get('scanA')!;
  const b = channels.get('scanB')!;
  const link = sync.addSyncLink('scanA', 'scanB', 'oneway');

  const edited = post(a, 'before edit');
  const deleted = post(a, 'will be deleted');
  const copyGone = post(a, 'copy removed in target');
  const fine = post(a, 'untouched');
  for (const msg of [edited, deleted, copyGone, fine]) await sync.mirrorMessageToLinks(client, msg);

  // Drift while "offline": nothing below fires an event.
  edited.content = 'after edit';
  a.messages.store.delete(deleted.id);
  b.messages.store.delete(copyOf(copyGone.id));
  const added = post(a, 'posted while offline');

  const report = await sync.scanSyncLink(client, link.id);
  const byIssue = (issue: string) => report.findings.filter((f) => f.issue === issue).map((f) => f.sourceId);

  assert.deepEqual(byIssue('stale'), [edited.id]);
  assert.deepEqual(byIssue('orphan'), [deleted.id]);
  assert.deepEqual(byIssue('copy-missing'), [copyGone.id]);
  assert.deepEqual(byIssue('missing'), [added.id]);
  assert.equal(report.repaired, 0, 'read-only scan must not change anything');

  const applied = await sync.scanSyncLink(client, link.id, { apply: true });
  // copy-missing only drops the dead row, so that message then shows as missing
  // on the next pass — apply twice converges.
  assert.equal(applied.repaired, applied.findings.length);
  await sync.scanSyncLink(client, link.id, { apply: true });

  const clean = await sync.scanSyncLink(client, link.id);
  assert.deepEqual(clean.findings, []);
  assert.equal(b.messages.store.get(copyOf(edited.id))?.content, 'after edit');
  assert.equal(b.messages.store.get(copyOf(added.id))?.content, 'posted while offline');
});

test('copies with appended attachment links are not reported as edited', async () => {
  const { client, channels } = makeClient('attA', 'attB');
  const a = channels.get('attA')!;
  const b = channels.get('attB')!;
  const link = sync.addSyncLink('attA', 'attB', 'oneway');

  const msg = post(a, 'see file');
  await sync.mirrorMessageToLinks(client, msg);
  // replayMessage appends URLs of attachments it could not re-upload.
  b.messages.store.get(copyOf(msg.id))!.content = 'see file\nhttps://cdn.example/file.png';

  const report = await sync.scanSyncLink(client, link.id);
  assert.deepEqual(report.findings, []);
});

test('history brought over by sync copy is matched, not reported as never mirrored', async () => {
  const { client, channels } = makeClient('histA', 'histB');
  const a = channels.get('histA')!;
  const b = channels.get('histB')!;

  // `sync copy` posts the history without writing ledger rows.
  const old = [post(a, 'old one'), post(a, 'old two')];
  for (const msg of old) await b.send({ content: msg.content, masquerade: { name: 'alice' } });
  const link = sync.addSyncLink('histA', 'histB', 'oneway');

  const report = await sync.scanSyncLink(client, link.id);
  assert.deepEqual(report.findings.filter((f) => f.issue === 'missing'), []);
  assert.deepEqual(report.findings.map((f) => f.issue), ['untracked', 'untracked']);

  const before = b.messages.store.size;
  const applied = await sync.scanSyncLink(client, link.id, { apply: true });
  assert.equal(applied.repaired, 2);
  assert.equal(b.messages.store.size, before, 'recording an untracked copy must not post anything');
  assert.deepEqual((await sync.scanSyncLink(client, link.id)).findings, []);

  // Now tracked, so an offline edit of that history is caught.
  old[0].content = 'old one, edited';
  const stale = await sync.scanSyncLink(client, link.id);
  assert.deepEqual(stale.findings.map((f) => [f.issue, f.sourceId]), [['stale', old[0].id]]);
});

test('messages posted before the link existed are not drift', async () => {
  const { client, channels } = makeClient('preA', 'preB');
  const a = channels.get('preA')!;
  const early = post(a, 'from before the link');
  // A real ULID timestamped an hour ago.
  a.messages.store.delete(early.id);
  early.id = '01' + 'J'.repeat(24);
  (early as any).createdAt = new Date(Date.now() - 3_600_000).toISOString();
  a.messages.store.set(early.id, early);
  const link = sync.addSyncLink('preA', 'preB', 'oneway');

  const report = await sync.scanSyncLink(client, link.id);
  assert.deepEqual(report.findings, []);
  assert.equal(report.skippedBeforeLink, 1);
});

test('every sync debug subcommand runs and replies within the message size limit', async () => {
  const { syncDebugCommand } = await import('../src/commands/sync-debug.js');
  const { client, channels } = makeClient('dbgA', 'dbgB');
  const a = channels.get('dbgA')!;
  const link = sync.addSyncLink('dbgA', 'dbgB', 'twoway', 'debug link');

  const first = post(a, 'debug me');
  await sync.mirrorMessageToLinks(client, first);
  first.content = 'debug me, edited offline';
  post(a, 'never mirrored');

  const replies: string[] = [];
  const message = {
    authorId: 'USER1',
    serverId: 'SRV',
    channel: { send: async (options: any) => { replies.push(String(options?.content || '')); } },
  };

  const run = async (line: string) => {
    replies.length = 0;
    await syncDebugCommand(message, line.split(/\s+/).filter(Boolean), client);
    assert.ok(replies.length > 0, `"${line}" sent no reply`);
    for (const reply of replies) assert.ok(reply.length <= 2000, `"${line}" sent a ${reply.length}-char message`);
    return replies.join('\n');
  };

  assert.match(await run('help'), /Sync Debug Commands/);
  assert.match(await run('status'), /Since boot/);
  assert.match(await run('links'), new RegExp(link.id));
  assert.match(await run(`link ${link.id}`), /Newest mirrored messages/);
  assert.match(await run(`ledger ${link.id} --limit 5`), new RegExp(first.id));
  assert.match(await run(`trace ${first.id}`), /copy still exists: yes/);
  assert.match(await run(`channel dbgA`), /source/);
  assert.match(await run(`cursor ${link.id}`), /Catch-up cursors/);

  const scan = await run(`scan ${link.id} --limit 50`);
  assert.match(scan, /Edited, copy stale: 1/);
  assert.match(scan, /Added but never mirrored: 1/);
  assert.match(scan, /read-only/);

  const repaired = await run(`scan dbgA --apply`);
  assert.match(repaired, /Repaired: 2/);

  assert.match(await run(`replay ${link.id} ${first.id}`), /Previous copy removed/);
  assert.match(await run(`probe ${link.id}`), /Delete: OK/);
  assert.match(await run('prune'), /Read-only/);
  assert.match(await run('bogus'), /Unknown debug subcommand/);
});

test('dashboard sync debug API: scan, repair, trace, ledger, probe, cursor, prune', async () => {
  const { Readable } = await import('node:stream');
  const { handleDebugEditorRequest } = await import('../src/debug-editor.js');
  const { client, channels } = makeClient('apiA', 'apiB');
  const a = channels.get('apiA')!;
  const link = sync.addSyncLink('apiA', 'apiB', 'oneway', 'api link');

  const first = post(a, 'api message');
  await sync.mirrorMessageToLinks(client, first);
  first.content = 'api message, edited offline';

  // Minimal IncomingMessage / ServerResponse pair for the editor handler.
  async function call(method: string, path: string, body?: any) {
    const request: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = path;
    request.headers = { host: 'localhost', 'sec-fetch-site': 'same-origin' };
    let status = 0;
    let payload = '';
    const response: any = {
      writeHead(code: number) { status = code; return response; },
      setHeader() {},
      end(chunk?: any) { payload = String(chunk || ''); },
    };
    await handleDebugEditorRequest(request, response, { client, serverId: 'SRV' });
    return { status, json: JSON.parse(payload || '{}') };
  }

  const status = await call('GET', '/api/sync/debug/status');
  assert.equal(status.status, 200);
  assert.ok(status.json.links.some((l: any) => l.id === link.id), 'status lists links visible on the server');

  const scan = await call('POST', '/api/sync/debug/scan', { linkId: link.id, limit: 50 });
  assert.equal(scan.status, 200);
  assert.deepEqual(scan.json.report.findings.map((f: any) => f.issue), ['stale']);
  assert.equal(scan.json.report.repaired, 0);

  const repair = await call('POST', '/api/sync/debug/scan', { linkId: link.id, apply: true });
  assert.equal(repair.json.report.repaired, 1);
  assert.equal(channels.get('apiB')!.messages.store.get(copyOf(first.id))?.content, 'api message, edited offline');

  const trace = await call('GET', `/api/sync/debug/trace?messageId=${first.id}`);
  assert.equal(trace.json.trace.asSource[0].targetExists, true);

  const ledger = await call('GET', `/api/sync/debug/ledger?linkId=${link.id}&limit=5`);
  assert.equal(ledger.json.rows[0].sourceId, first.id);

  const probe = await call('POST', '/api/sync/debug/probe', { linkId: link.id });
  assert.deepEqual([probe.json.result.send, probe.json.result.edit, probe.json.result.remove], [true, true, true]);

  const cursor = await call('POST', '/api/sync/debug/cursor', { linkId: link.id, direction: 'source', action: 'set', value: first.id });
  assert.equal(cursor.json.link.lastSourceId, first.id);
  const cleared = await call('POST', '/api/sync/debug/cursor', { linkId: link.id, direction: 'source', action: 'reset' });
  assert.equal(cleared.json.link.lastSourceId, undefined);

  const prune = await call('POST', '/api/sync/debug/prune', { apply: false });
  assert.equal(prune.json.result.apply, false);

  const unknown = await call('POST', '/api/sync/debug/scan', { linkId: 'does-not-exist' });
  assert.equal(unknown.status, 404);

  const badCursor = await call('POST', '/api/sync/debug/cursor', { linkId: link.id, action: 'set' });
  assert.equal(badCursor.status, 400);
});

test('removing a link drops its ledger rows', async () => {
  const { client, channels } = makeClient('rmA', 'rmB');
  const link = sync.addSyncLink('rmA', 'rmB', 'oneway');
  await sync.mirrorMessageToLinks(client, post(channels.get('rmA')!, 'bye'));
  assert.ok(sync.listMirrorRows({ linkId: link.id }).length > 0);

  // The dashboard's per-link activity counts the same rows.
  const activity = sync.getSyncLinkActivity()[link.id];
  assert.equal(activity?.copies, sync.listMirrorRows({ linkId: link.id }).length);
  assert.ok(activity?.lastAt);

  sync.removeSyncLink(link.id);
  assert.equal(sync.getSyncLinkActivity()[link.id], undefined);
  assert.equal(sync.listMirrorRows({ linkId: link.id }).length, 0);
  assert.equal(sync.getSyncDiagnostics().ledger.orphanedRows, 0);
});

// ------------------------------------------------------------
// Allow / deny filters
// ------------------------------------------------------------

test('filter rules: deny wins, users and roles share one allowlist, words need a match', () => {
  const allowed = (filters: any, subject: any) => sync.evaluateSyncFilters(filters, subject).allowed;

  assert.equal(allowed(undefined, { authorId: 'U1', content: 'anything' }), true, 'no filters mirrors everything');

  const senders = sync.normalizeSyncFilters({ allow: { users: ['U1'], roles: ['R_MOD'] }, deny: { users: ['U2'] } });
  assert.equal(allowed(senders, { authorId: 'U1' }), true);
  assert.equal(allowed(senders, { authorId: 'U3', roleIds: ['R_MOD'] }), true, 'an allowed role lets a member through');
  assert.equal(allowed(senders, { authorId: 'U3', roleIds: ['R_OTHER'] }), false);
  assert.equal(allowed(senders, { authorId: 'U2', roleIds: ['R_MOD'] }), false, 'deny beats an allowed role');

  const deniedRole = sync.normalizeSyncFilters({ allow: { users: ['U1'] }, deny: { roles: ['R_MUTED'] } });
  assert.equal(allowed(deniedRole, { authorId: 'U1', roleIds: ['R_MUTED'] }), false, 'deny beats an allowed user');

  const words = sync.normalizeSyncFilters({ allow: { words: ['release', 'patch notes'] }, deny: { words: ['spam*', 'c++', ':)'] } });
  assert.equal(allowed(words, { content: 'New RELEASE today' }), true, 'case-insensitive');
  assert.equal(allowed(words, { content: 'read the patch notes' }), true, 'phrases');
  assert.equal(allowed(words, { content: 'released yesterday' }), false, 'whole words only');
  assert.equal(allowed(words, { content: 'release by a spammer' }), false, 'wildcard deny');
  assert.equal(allowed(words, { content: 'release written in c++' }), false, 'entries ending in symbols');
  assert.equal(allowed(words, { content: 'release :)' }), false);
  assert.equal(allowed(words, { content: 'hello' }), false, 'allowed words need a match');
  assert.match(sync.evaluateSyncFilters(words, { content: 'release spam' }).reason || '', /denied word "spam\*"/);
});

test('filter normalization strips mentions, duplicates, wildcards and junk', () => {
  const filters = sync.normalizeSyncFilters({
    allow: { users: ['<@01USERAAAA>', '01USERAAAA', 'not an id!', 42], roles: '<%01ROLEBBBB>, 01ROLECCCC' },
    deny: { words: ['  Spam ', 'spam', '*', '**', 'free   nitro'], users: { not: 'a list' } },
  });
  assert.deepEqual(filters.allow.users, ['01USERAAAA', '42']);
  assert.deepEqual(filters.allow.roles, ['01ROLEBBBB', '01ROLECCCC']);
  assert.deepEqual(filters.deny.words, ['Spam', 'free nitro']);
  assert.deepEqual(filters.deny.users, []);
  assert.equal(sync.hasSyncFilters(sync.normalizeSyncFilters({ deny: { words: ['*'] } })), false);
});

test('live mirror and catch-up skip messages the filters block', async () => {
  const { client, channels, memberRoles } = makeClient('fltA', 'fltB');
  const a = channels.get('fltA')!;
  const b = channels.get('fltB')!;
  const link = sync.addSyncLink('fltA', 'fltB', 'oneway');
  sync.setSyncLinkFilters(link.id, { allow: { roles: ['ROLE_MOD'] }, deny: { words: ['secret'] } });
  memberRoles.MODUSER = ['ROLE_MOD'];

  const fromMod = post(a, 'hello from a mod', 'MODUSER');
  const fromUser = post(a, 'hello from a user', 'USER1');
  const secret = post(a, 'a secret from a mod', 'MODUSER');
  for (const msg of [fromMod, fromUser, secret]) await sync.mirrorMessageToLinks(client, msg);

  const copies = () => [...b.messages.store.values()].map((m) => m.content).sort();
  assert.deepEqual(copies(), ['hello from a mod']);
  assert.equal(sync.getSyncLink(link.id)?.lastSourceId, secret.id, 'filtered messages still advance the cursor');

  // Posted while offline: catch-up applies the same filters.
  post(a, 'offline mod post', 'MODUSER');
  post(a, 'offline user post', 'USER1');
  await sync.catchUpSyncLinks(client);
  assert.deepEqual(copies(), ['hello from a mod', 'offline mod post']);
});

test('an edit that hits a deny word takes the copy down', async () => {
  const { client, channels } = makeClient('fedA', 'fedB');
  const a = channels.get('fedA')!;
  const b = channels.get('fedB')!;
  const link = sync.addSyncLink('fedA', 'fedB', 'oneway');
  sync.setSyncLinkFilters(link.id, { deny: { words: ['spoiler'] } });

  const msg = post(a, 'the ending is great');
  await sync.mirrorMessageToLinks(client, msg);
  const copyId = copyOf(msg.id);

  await sync.mirrorMessageEdit(client, 'fedA', msg.id, { content: 'the ending is great, still no spoilers' });
  assert.equal(b.messages.store.get(copyId)?.content, 'the ending is great, still no spoilers', '"spoilers" is not the whole word');

  await sync.mirrorMessageEdit(client, 'fedA', msg.id, { content: 'spoiler: everyone lives' });
  assert.equal(b.messages.store.has(copyId), false);
  assert.equal(sync.listMirrorRows({ linkId: link.id }).length, 0);
});

test('scan honours filters: blocked messages are not missing, and copies they block are repaired away', async () => {
  const { client, channels } = makeClient('fscA', 'fscB');
  const a = channels.get('fscA')!;
  const b = channels.get('fscB')!;
  const link = sync.addSyncLink('fscA', 'fscB', 'oneway');

  const keep = post(a, 'keep me', 'USER1');
  const later = post(a, 'from the troll', 'TROLL');
  for (const msg of [keep, later]) await sync.mirrorMessageToLinks(client, msg);

  // Deny the troll after the fact, plus one more troll post nobody mirrored.
  sync.setSyncLinkFilters(link.id, { deny: { users: ['TROLL'] } });
  post(a, 'troll again', 'TROLL');

  const report = await sync.scanSyncLink(client, link.id);
  assert.deepEqual(report.findings.map((f) => [f.issue, f.sourceId]), [['filtered', later.id]]);
  assert.equal(report.skippedByFilters, 1);
  assert.match(report.findings[0].reason || '', /deny list/);

  const applied = await sync.scanSyncLink(client, link.id, { apply: true });
  assert.equal(applied.repaired, 1);
  assert.deepEqual([...b.messages.store.values()].map((m) => m.content), ['keep me']);
  assert.deepEqual((await sync.scanSyncLink(client, link.id)).findings, []);
});

test('sync filter chat command adds, removes, shows and clears entries', async () => {
  const { syncCommand } = await import('../src/commands/sync.js');
  const { client } = makeClient('cmdA', 'cmdB');
  const link = sync.addSyncLink('cmdA', 'cmdB', 'twoway');

  const replies: string[] = [];
  const message = {
    authorId: 'USER1',
    serverId: 'SRV',
    channel: { send: async (options: any) => { replies.push(String(options?.content || '')); } },
  };
  const run = async (line: string) => {
    replies.length = 0;
    await syncCommand(message, line.split(/\s+/).filter(Boolean), client);
    assert.ok(replies.length > 0, `"${line}" sent no reply`);
    for (const reply of replies) assert.ok(reply.length <= 2000, `"${line}" sent a ${reply.length}-char message`);
    return replies.join('\n');
  };

  assert.match(await run('filter'), /Sync Filters/);
  assert.match(await run(`filter ${link.id} allow user <@01USERAAAA> 01USERBBBB`), /Added 2 users/);
  assert.match(await run(`blacklist ${link.id} word spam "free nitro"`), /Added 2 words/);
  assert.match(await run(`whitelist ${link.id} role <%ROLE_MOD>`), /Added 1 roles/);
  assert.deepEqual(sync.getSyncLink(link.id)?.filters, {
    allow: { users: ['01USERAAAA', '01USERBBBB'], roles: ['ROLE_MOD'], words: [] },
    deny: { users: [], roles: [], words: ['spam', 'free nitro'] },
  });

  assert.match(await run(`filter ${link.id} remove allow user 01USERBBBB 01USERZZZZ`), /Removed 1 users[\s\S]*1 were not on the list/);
  const shown = await run(`filter ${link.id}`);
  assert.match(shown, /Users: `01USERAAAA`/);
  assert.match(shown, /"free nitro"/);
  assert.match(await run('list'), /filters: 2 allow, 2 deny/);
  assert.match(await run('filter cmdA'), /Allow list/, 'a channel id on exactly one link resolves to it');

  assert.match(await run(`filter ${link.id} clear deny`), /Cleared all entries on the deny list/);
  assert.equal(sync.getSyncLink(link.id)?.filters?.deny.words.length, 0);
  assert.match(await run(`filter ${link.id} clear`), /now mirrors everything/);
  assert.equal(sync.getSyncLink(link.id)?.filters, undefined);

  assert.match(await run(`filter ${link.id} allow color red`), /Unknown filter command/);
  assert.match(await run('filter nope-link'), /No sync link found/);
});

test('dashboard: link PATCH saves filters and the roles endpoint lists role choices', async () => {
  const { Readable } = await import('node:stream');
  const { handleSyncEditorRequest } = await import('../src/sync-editor.js');
  const { client } = makeClient('dshA', 'dshB');
  const link = sync.addSyncLink('dshA', 'dshB', 'oneway');

  async function call(method: string, path: string, body?: any) {
    const request: any = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    request.method = method;
    request.url = path;
    request.headers = { host: 'localhost', 'sec-fetch-site': 'same-origin' };
    let status = 0;
    let payload = '';
    const response: any = {
      writeHead(code: number) { status = code; return response; },
      setHeader() {},
      end(chunk?: any) { payload = String(chunk || ''); },
    };
    await handleSyncEditorRequest(request, response, { client, serverId: 'SRV' });
    return { status, json: JSON.parse(payload || '{}') };
  }

  const saved = await call('PATCH', `/api/link/${link.id}`, { filters: { deny: { words: ['spam', '*'] }, allow: { users: ['<@01USERAAAA>'] } } });
  assert.equal(saved.status, 200);
  const listed = saved.json.links.find((l: any) => l.id === link.id);
  assert.deepEqual(listed.filters.deny.words, ['spam']);
  assert.deepEqual(listed.filters.allow.users, ['01USERAAAA']);

  // A label-only PATCH leaves filters alone; empty filters remove them.
  await call('PATCH', `/api/link/${link.id}`, { label: 'renamed' });
  assert.deepEqual(sync.getSyncLink(link.id)?.filters?.deny.words, ['spam']);
  await call('PATCH', `/api/link/${link.id}`, { filters: { allow: {}, deny: {} } });
  assert.equal(sync.getSyncLink(link.id)?.filters, undefined);

  // The fake client answers for any server id; make it a stranger to one.
  const getServer = client.servers.cache.get;
  client.servers.cache.get = (id: string) => (id === 'SRV' ? getServer(id) : undefined);
  const roles = await call('GET', '/api/roles?serverId=SRV&serverId=NOT_JOINED');
  assert.equal(roles.status, 200);
  assert.deepEqual(roles.json.roles.map((r: any) => [r.id, r.name, r.serverName]), [['ROLE_MOD', 'Moderator', 'Test server']]);

  // Creating a link can set its filters in the same request, and every listed
  // link carries its copy count and last-copy time.
  const created = await call('POST', '/api/link', { source: 'dshC', target: 'dshD', mode: 'twoway', label: 'both', filters: { deny: { words: ['nope'] } } });
  assert.equal(created.status, 200);
  assert.deepEqual(sync.getSyncLink(created.json.id)?.filters?.deny.words, ['nope']);
  const row = created.json.links.find((l: any) => l.id === created.json.id);
  assert.equal(row.mode, 'twoway');
  assert.equal(row.copies, 0);
  assert.equal(row.lastCopyAt, null);
  sync.removeSyncLink(created.json.id);
});

// ------------------------------------------------------------
// In-memory store and batched writes
// ------------------------------------------------------------

test('a message in an unlinked channel is dropped before any lookup', async () => {
  // A client that fails on any use: the unlinked channel must never reach it.
  const client = {
    user: { id: BOT_ID },
    channels: { cache: { get: () => { throw new Error('looked up'); } }, fetch: async () => { throw new Error('fetched'); } },
    servers: { cache: { get: () => { throw new Error('looked up'); } } },
  } as any;
  await sync.mirrorMessageToLinks(client, { id: nextId(), channelId: 'nowhere', authorId: 'USER1', author: { id: 'USER1' }, content: 'hi' });
  await sync.mirrorMessageEdit(client, 'nowhere', nextId(), { content: 'edited' });
  await sync.mirrorMessageDelete(client, 'nowhere', nextId());
});

test('cursor moves are batched and flushSyncNow writes them; ledger rows are written at once', async () => {
  const { readFileSync } = await import('node:fs');
  const { dataFile } = await import('../src/json-store.js');
  const { sql } = await import('../src/db.js');
  const { client, channels } = makeClient('batchA', 'batchB');
  const link = sync.addSyncLink('batchA', 'batchB', 'oneway');
  const onDisk = () => JSON.parse(readFileSync(dataFile('channel-syncs.json'), 'utf-8')).links.find((l: any) => l.id === link.id);
  // Link edits are written straight away.
  assert.ok(onDisk(), 'a new link is saved at once');

  const msg = post(channels.get('batchA')!, 'batched');
  await sync.mirrorMessageToLinks(client, msg);
  assert.equal(sync.getSyncLink(link.id)?.lastSourceId, msg.id, 'memory has the new cursor');
  assert.notEqual(onDisk()?.lastSourceId, msg.id, 'the file waits for the batch');
  // The ledger is in SQLite, one row per copy, committed with the send.
  assert.ok(sql('SELECT 1 FROM sync_mirrors WHERE source_id = ?').get(msg.id), 'the ledger row is stored straight away');

  sync.flushSyncNow();
  assert.equal(onDisk()?.lastSourceId, msg.id);
  sync.removeSyncLink(link.id);
  assert.equal(sql('SELECT 1 FROM sync_mirrors WHERE source_id = ?').get(msg.id), undefined, 'removing the link drops its rows');
});

test('a restore that replaces the links file is picked up', async () => {
  const { writeFileSync } = await import('node:fs');
  const { dataFile, reloadDataFile } = await import('../src/json-store.js');
  sync.flushSyncNow();
  writeFileSync(dataFile('channel-syncs.json'), JSON.stringify({
    version: 1,
    links: [{ id: 'restored', sourceChannelId: 'resA', targetChannelId: 'resB', mode: 'oneway', createdAt: new Date().toISOString() }],
  }));
  reloadDataFile('channel-syncs.json');
  assert.deepEqual(sync.listSyncLinks().map((l) => l.id), ['restored']);
  assert.equal(sync.findLinksForSource('resA').length, 1);
  sync.removeSyncLink('restored');
});
