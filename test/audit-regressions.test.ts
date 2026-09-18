/**
 * Regression tests for the bugs found in the audit of the community and
 * moderation features: each test pins one behaviour that used to be wrong.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-audit-'));

const { parseDuration } = await import('../src/duration.js');
const health = await import('../src/health.js');
const limits = await import('../src/embed-limits.js');
const automod = await import('../src/automod.js');
const moderation = await import('../src/moderation.js');
const polls = await import('../src/polls.js');
const giveaways = await import('../src/hosted-giveaways.js');
const tags = await import('../src/tags.js');
const economy = await import('../src/economy.js');
const birthdays = await import('../src/birthdays.js');
const tempvoice = await import('../src/tempvoice.js');
const analytics = await import('../src/analytics.js');
const backup = await import('../src/backup.js');
const { previewServerBackup } = await import('../src/backup-preview.js');
const { readDataFileContent, reloadDataFile, writeDataFileContent } = await import('../src/json-store.js');
const { isStoatId } = await import('../src/id-utils.js');
const { config } = await import('../src/config.js');

const ZWSP = String.fromCharCode(0x200b);
const VS16 = String.fromCharCode(0xfe0f);

// ---- Stub client -----------------------------------------------------------

type Calls = string[];

function makeMember(id: string, calls: Calls, options: { roles?: any[]; failTimeout?: boolean } = {}) {
  return {
    id,
    nickname: null,
    roles: options.roles || [],
    hasPermission: () => false,
    timeout: async () => {
      if (options.failTimeout) throw new Error('API call failed with status 403: Forbidden');
      calls.push(`timeout:${id}`);
    },
    kick: async () => calls.push(`kick:${id}`),
    addRole: async (roleId: string) => calls.push(`addRole:${id}:${roleId}`),
    removeRole: async (roleId: string) => calls.push(`removeRole:${id}:${roleId}`),
    sendDM: async () => calls.push(`dm:${id}`),
  };
}

function makeClient(serverId: string, calls: Calls) {
  const members = new Map<string, any>();
  const channels = new Map<string, any>();
  const roles = new Map<string, any>();
  const server = {
    id: serverId,
    name: 'Test server',
    ownerId: 'OWNER',
    roles: { cache: roles },
    members: {
      cache: members,
      fetch: async (id: string) => {
        if (members.has(id)) return members.get(id);
        throw new Error('API call failed with status 404: Not Found');
      },
    },
    channels: {
      create: async ({ name }: any) => {
        calls.push(`createChannel:${name}`);
        const id = `CHAN${channels.size}`.padEnd(26, '0');
        const channel = { id, serverId, name, edit: async (data: any) => calls.push(`edit:${JSON.stringify(data)}`), delete: async () => calls.push(`delete:${id}`) };
        channels.set(id, channel);
        return channel;
      },
    },
  };
  const client = {
    user: { id: 'BOT' },
    servers: { cache: new Map([[serverId, server]]), fetch: async () => server },
    channels: { cache: channels, fetch: async (id: string) => channels.get(id) || null },
    users: { cache: new Map(), fetch: async () => null },
    api: {
      patch: async (path: string, body: any) => calls.push(`patch:${path}:${JSON.stringify(body?.body)}`),
      put: async (path: string) => calls.push(`put:${path}`),
      delete: async (path: string) => calls.push(`del:${path}`),
    },
  };
  return { client, server, members, channels, roles };
}

// Message ids are unique across the whole file: polls and giveaways are found
// by message id, and a repeat would route a reaction to another test's post.
let messageCounter = 0;

function textChannel(id: string, serverId: string, sent: any[]) {
  return {
    id,
    serverId,
    send: async (payload: any) => {
      sent.push(JSON.parse(JSON.stringify(payload)));
      return {
        id: `MSG${++messageCounter}`,
        addReaction: async () => {},
        delete: async () => {},
      };
    },
    messages: { fetch: async () => null },
  };
}

// ---- Durations, health, limits ---------------------------------------------

test('a duration with stray words is not a duration, even with inner spaces', () => {
  assert.equal(parseDuration('1 d x'), undefined);
  assert.equal(parseDuration('10 m'), 600_000);
  assert.equal(parseDuration('2h 30m'), 9_000_000);
});

test('every repeated 429 counts as a rate limit', () => {
  health.resetHealth();
  health.recordError(new Error('API call failed with status 429'));
  health.recordError(new Error('API call failed with status 429'));
  const snapshot = health.getHealthSnapshot();
  assert.equal(snapshot.rateLimits.hits, 2);
  assert.equal(snapshot.errors.recent.length, 1);
  assert.equal(snapshot.errors.recent[0].count, 2);
});

test('the per-minute event rate counts recent events cheaply', () => {
  health.resetHealth();
  for (let i = 0; i < 500; i++) health.recordEvent('Message');
  assert.equal(health.getHealthSnapshot().events.perMinute, 500);
});

test('list replies never pass the message limit and say what was cut', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `- line number ${i} with some padding text to make it long enough`);
  const out = limits.joinLinesWithin('## Header', lines);
  assert.ok(out.length <= limits.MESSAGE_CONTENT_MAX, `length ${out.length}`);
  assert.match(out, /…and \d+ more$/);
  assert.equal(limits.clampText('abcdef', 4), 'abc…');
});

test('mass mentions typed by a member are defused', () => {
  assert.equal(limits.neutraliseMentions('@everyone hi <%ROLE>'), `@${ZWSP}everyone hi <${ZWSP}%ROLE>`);
});

test('stoat ids are ULIDs; words are not', () => {
  assert.equal(isStoatId('01ARZ3NDEKTSV4RRFFQ69G5FAV'), true);
  assert.equal(isStoatId('spam'), false);
});

// ---- Automod ----------------------------------------------------------------

test('link hosts ignore trailing punctuation, ports and user-info decoys', () => {
  assert.deepEqual(automod.extractDomains('(see https://youtube.com)'), ['youtube.com']);
  assert.deepEqual(automod.extractDomains('https://example.com:8080/x'), ['example.com']);
  assert.deepEqual(automod.extractDomains('https://youtube.com@evil.com/login'), ['evil.com']);
});

function automodMessage(serverId: string, content: string, member: any, sent: any[], state: { deleted: boolean }) {
  return {
    content,
    authorId: 'AUTHOR',
    author: { id: 'AUTHOR' },
    channelId: 'CHANNEL',
    member,
    channel: { id: 'CHANNEL', serverId, send: async (payload: any) => { sent.push(payload); return { delete: async () => {} }; } },
    delete: async () => { state.deleted = true; },
  };
}

test("a rule's own exempt role skips that rule only, not the rules after it", async () => {
  const serverId = 'am-exempt';
  automod.setAutomodConfig({ enabled: true, notifyChannel: false }, serverId);
  const links = automod.addAutomodRule({ type: 'links', action: 'delete' }, serverId);
  automod.updateAutomodRule(links.id, { exemptRoleIds: ['TRUSTED'] }, serverId);
  const words = automod.addAutomodRule({ type: 'words', action: 'delete' }, serverId);
  automod.updateAutomodRule(words.id, { words: ['badword'] }, serverId);

  const calls: Calls = [];
  const { client } = makeClient(serverId, calls);
  const member = { roles: ['TRUSTED'], hasPermission: () => false };
  const state = { deleted: false };
  const removed = await automod.handleAutomodMessage(client, automodMessage(serverId, 'https://x.com badword', member, [], state));
  assert.equal(removed, true);
  assert.equal(state.deleted, true);
});

test('a spam rule fires once per burst, not on every message after it', async () => {
  const serverId = 'am-spam';
  automod.setAutomodConfig({ enabled: true, notifyChannel: false }, serverId);
  const rule = automod.addAutomodRule({ type: 'spam', action: 'delete' }, serverId);
  automod.updateAutomodRule(rule.id, { threshold: 2, windowSec: 60 }, serverId);
  const { client } = makeClient(serverId, []);
  const member = { roles: [], hasPermission: () => false };
  const results: boolean[] = [];
  for (let i = 0; i < 4; i++) {
    results.push(await automod.handleAutomodMessage(client, automodMessage(serverId, `m${i}`, member, [], { deleted: false })));
  }
  assert.deepEqual(results, [false, false, true, false]);
});

test('a rule that keeps the message says so instead of claiming removal', async () => {
  const serverId = 'am-notice';
  automod.setAutomodConfig({ enabled: true, notifyChannel: true }, serverId);
  const rule = automod.addAutomodRule({ type: 'caps', action: 'delete' }, serverId);
  automod.updateAutomodRule(rule.id, { deleteMessage: false }, serverId);
  const sent: any[] = [];
  const { client } = makeClient(serverId, []);
  const state = { deleted: false };
  const removed = await automod.handleAutomodMessage(client, automodMessage(serverId, 'THIS IS ALL SHOUTING TEXT', { roles: [], hasPermission: () => false }, sent, state));
  assert.equal(removed, false);
  assert.equal(state.deleted, false);
  assert.match(sent[0].content, /flagged/);
});

test('a duplicates threshold of 1 does not flag every message', async () => {
  const serverId = 'am-dupes';
  automod.setAutomodConfig({ enabled: true, notifyChannel: false }, serverId);
  const rule = automod.addAutomodRule({ type: 'duplicates', action: 'delete' }, serverId);
  automod.updateAutomodRule(rule.id, { threshold: 1 }, serverId);
  const { client } = makeClient(serverId, []);
  const removed = await automod.handleAutomodMessage(client, automodMessage(serverId, 'hello there', { roles: [], hasPermission: () => false }, [], { deleted: false }));
  assert.equal(removed, false);
});

test('editing a rule never resets its hit counter', async () => {
  const serverId = 'am-hits';
  automod.setAutomodConfig({ enabled: true, notifyChannel: false }, serverId);
  const rule = automod.addAutomodRule({ type: 'caps', action: 'delete' }, serverId);
  const { client } = makeClient(serverId, []);
  await automod.handleAutomodMessage(client, automodMessage(serverId, 'THIS IS ALL SHOUTING TEXT', { roles: [], hasPermission: () => false }, [], { deleted: false }));
  assert.equal(automod.listAutomodRules(serverId)[0].hits, 1);
  // The dashboard sends the whole rule back, hit count included.
  const updated = automod.updateAutomodRule(rule.id, { hits: 0, name: 'Renamed' } as any, serverId);
  assert.equal(updated?.name, 'Renamed');
  assert.equal(updated?.hits, 1);
});

test('an automod mute without a length uses the default mute length', async () => {
  const serverId = 'am-mute';
  moderation.setModerationConfig({ dmOnAction: false, escalation: [], defaultMuteMs: 2 * 3_600_000 }, serverId);
  automod.setAutomodConfig({ enabled: true, notifyChannel: false }, serverId);
  automod.addAutomodRule({ type: 'caps', action: 'mute', durationMs: null }, serverId);
  const calls: Calls = [];
  const { client, members } = makeClient(serverId, calls);
  members.set('AUTHOR', makeMember('AUTHOR', calls));
  await automod.handleAutomodMessage(client, automodMessage(serverId, 'THIS IS ALL SHOUTING TEXT', { roles: [], hasPermission: () => false }, [], { deleted: false }));
  const [muteCase] = moderation.listCases(serverId, { action: 'mute' });
  assert.equal(muteCase?.durationMs, 2 * 3_600_000);
  assert.equal(muteCase?.failed, false);
});

// ---- Moderation -------------------------------------------------------------

test('a failed re-mute leaves the earlier mute active', async () => {
  const serverId = 'mod-remute';
  moderation.setModerationConfig({ dmOnAction: false, escalation: [] }, serverId);
  const calls: Calls = [];
  const { client, members } = makeClient(serverId, calls);
  members.set('TARGET', makeMember('TARGET', calls));
  const first = await moderation.runModAction(client, { serverId, action: 'mute', userId: 'TARGET', moderatorId: 'MOD', durationMs: 60_000 });
  assert.equal(first.ok, true);

  members.set('TARGET', makeMember('TARGET', calls, { failTimeout: true }));
  const second = await moderation.runModAction(client, { serverId, action: 'mute', userId: 'TARGET', moderatorId: 'MOD', durationMs: 60_000 });
  assert.equal(second.ok, false);
  assert.equal(second.case?.failed, true, 'the attempt is still recorded');
  assert.equal(moderation.getCase(first.case!.id, serverId)?.active, true);
});

test('a kicked member is told before the kick, while they can still be reached', async () => {
  const serverId = 'mod-kick';
  moderation.setModerationConfig({ dmOnAction: true, escalation: [] }, serverId);
  const calls: Calls = [];
  const { client, members } = makeClient(serverId, calls);
  members.set('TARGET', makeMember('TARGET', calls));
  const result = await moderation.runModAction(client, { serverId, action: 'kick', userId: 'TARGET', moderatorId: 'MOD' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.filter((call) => call.startsWith('dm') || call.startsWith('kick')), ['dm:TARGET', 'kick:TARGET']);
});

test('a permanent ban stays active so it can be lifted from the dashboard', async () => {
  const serverId = 'mod-ban';
  moderation.setModerationConfig({ dmOnAction: false, escalation: [] }, serverId);
  const { client } = makeClient(serverId, []);
  const result = await moderation.runModAction(client, { serverId, action: 'ban', userId: 'TARGET', moderatorId: 'MOD', durationMs: null });
  assert.equal(result.case?.active, true);
  await moderation.runModAction(client, { serverId, action: 'unban', userId: 'TARGET', moderatorId: 'MOD' });
  assert.equal(moderation.getCase(result.case!.id, serverId)?.active, false);
});

test('an unmute whose only attempt fails reports the failure', async () => {
  const serverId = 'mod-unmute';
  moderation.setModerationConfig({ dmOnAction: false, escalation: [], muteRoleId: null }, serverId);
  const { client } = makeClient(serverId, []);
  client.api.patch = async () => { throw new Error('API call failed with status 403: Forbidden'); };
  const result = await moderation.runModAction(client, { serverId, action: 'unmute', userId: 'TARGET', moderatorId: 'MOD' });
  assert.equal(result.ok, false);
});

test('a timeout mute replacing a role mute also removes the role', async () => {
  const serverId = 'mod-role';
  moderation.setModerationConfig({ dmOnAction: false, escalation: [], muteRoleId: 'MUTEROLE', preferTimeout: false }, serverId);
  const calls: Calls = [];
  const { client, members } = makeClient(serverId, calls);
  members.set('TARGET', makeMember('TARGET', calls));
  await moderation.runModAction(client, { serverId, action: 'mute', userId: 'TARGET', moderatorId: 'MOD', durationMs: 60_000 });
  moderation.setModerationConfig({ preferTimeout: true }, serverId);
  await moderation.runModAction(client, { serverId, action: 'mute', userId: 'TARGET', moderatorId: 'MOD', durationMs: 60_000 });
  assert.ok(calls.includes('removeRole:TARGET:MUTEROLE'));
  assert.equal(moderation.listCases(serverId, { action: 'mute', activeOnly: true }).length, 1);
});

test('a moderator cannot act on someone ranked at or above them', async () => {
  const serverId = 'mod-rank';
  const { client, members, roles } = makeClient(serverId, []);
  roles.set('HIGH', { id: 'HIGH', rank: 1 });
  roles.set('LOW', { id: 'LOW', rank: 5 });
  members.set('ADMIN', { id: 'ADMIN', roles: ['HIGH'] });
  members.set('HELPER', { id: 'HELPER', roles: ['LOW'] });
  assert.equal(await moderation.outranks(client, serverId, 'HELPER', 'ADMIN'), false);
  assert.equal(await moderation.outranks(client, serverId, 'ADMIN', 'HELPER'), true);
  assert.equal(await moderation.outranks(client, serverId, 'HELPER', 'OWNER'), false);
  assert.equal(await moderation.outranks(client, serverId, 'HELPER', 'NOT_A_MEMBER'), true);
});

// ---- Polls ------------------------------------------------------------------

test('a long poll question fits Stoat embed limits', async () => {
  const sent: any[] = [];
  const { client, channels } = makeClient('poll-srv', []);
  channels.set('PCHAN', textChannel('PCHAN', 'poll-srv', sent));
  const question = 'Q'.repeat(400);
  const options = Array.from({ length: 10 }, (_, i) => `${'o'.repeat(115)}${i}`);
  const result = await polls.createPoll(client, { serverId: 'poll-srv', channelId: 'PCHAN', question, options, createdBy: 'U' });
  assert.equal(result.ok, true);
  const embed = sent[0].embeds[0];
  assert.ok(embed.title.length <= 100);
  assert.ok(embed.description.length <= 2000);
  assert.ok(embed.description.includes('Q'.repeat(50)), 'the question is still shown');
});

test('a vote counts whether or not the emoji carries its variation selector', async () => {
  const sent: any[] = [];
  const { client, channels } = makeClient('poll-vs', []);
  channels.set('VCHAN', textChannel('VCHAN', 'poll-vs', sent));
  const created = await polls.createPoll(client, { serverId: 'poll-vs', channelId: 'VCHAN', question: 'Pick', options: ['a', 'b'], createdBy: 'U' });
  const poll = created.poll!;
  await polls.handlePollReaction({ client, messageId: poll.messageId, userId: 'VOTER', emoji: poll.emoji[0].replace(VS16, '') });
  assert.deepEqual(polls.countVotes(polls.getPoll(poll.id)!).perOption, [1, 0]);
});

test('an endless or negative poll duration does not close the poll at once', async () => {
  const sent: any[] = [];
  const { client, channels } = makeClient('poll-dur', []);
  channels.set('DCHAN', textChannel('DCHAN', 'poll-dur', sent));
  const negative = await polls.createPoll(client, { serverId: 'poll-dur', channelId: 'DCHAN', question: 'Neg', durationMs: -5, createdBy: 'U' });
  assert.equal(negative.poll?.endsAt, null);
  const huge = await polls.createPoll(client, { serverId: 'poll-dur', channelId: 'DCHAN', question: 'Inf', durationMs: Infinity, createdBy: 'U' });
  assert.equal(huge.poll?.endsAt, null);
});

// ---- Giveaways --------------------------------------------------------------

test('ending a giveaway twice at once draws only once', async () => {
  const sent: any[] = [];
  const { client, channels, members } = makeClient('gw-srv', []);
  channels.set('GCHAN', textChannel('GCHAN', 'gw-srv', sent));
  const created = await giveaways.createGiveaway(client, { serverId: 'gw-srv', channelId: 'GCHAN', prize: 'P'.repeat(200), durationMs: 60_000, hostId: 'HOST' });
  const embed = sent[0].embeds[0];
  assert.ok(embed.title.length <= 100, 'a 200-character prize no longer breaks the title');
  const giveaway = created.giveaway!;
  for (const id of ['A', 'B', 'C']) {
    members.set(id, { id, roles: [] });
    await giveaways.handleGiveawayReaction({ client, messageId: giveaway.messageId, userId: id, emoji: giveaways.GIVEAWAY_EMOJI });
  }
  const [first, second] = await Promise.all([giveaways.endGiveaway(client, giveaway.id), giveaways.endGiveaway(client, giveaway.id)]);
  assert.equal([first.ok, second.ok].filter(Boolean).length, 1);
  const announcements = sent.filter((payload) => typeof payload.content === 'string' && payload.content.includes('Giveaway ended'));
  assert.equal(announcements.length, 1);
});

test('members who left before the draw cannot win', async () => {
  const { client, channels, members } = makeClient('gw-left', []);
  channels.set('LCHAN', textChannel('LCHAN', 'gw-left', []));
  const created = await giveaways.createGiveaway(client, { serverId: 'gw-left', channelId: 'LCHAN', prize: 'Key', durationMs: 60_000, hostId: 'HOST', winnerCount: 5 });
  const giveaway = created.giveaway!;
  members.set('STAYS', { id: 'STAYS', roles: [] });
  members.set('LEAVES', { id: 'LEAVES', roles: [] });
  for (const id of ['STAYS', 'LEAVES']) {
    await giveaways.handleGiveawayReaction({ client, messageId: giveaway.messageId, userId: id, emoji: giveaways.GIVEAWAY_EMOJI });
  }
  members.delete('LEAVES');
  const result = await giveaways.endGiveaway(client, giveaway.id);
  assert.deepEqual(result.winners, ['STAYS']);
});

// ---- Tags -------------------------------------------------------------------

test('a tag cannot take the name of a built-in command', () => {
  tags.setBuiltinCommandNames(['ban', 'warn']);
  const result = tags.createTag({ serverId: 'tag-srv', name: 'ban', content: 'x', createdBy: 'U' });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /already a bot command/);
  const created = tags.createTag({ serverId: 'tag-srv', name: 'rules', content: 'Be nice', createdBy: 'U' });
  assert.equal(created.ok, true);
  const renamed = tags.updateTag('tag-srv', 'rules', { name: 'warn' });
  assert.equal(renamed.ok, false);
});

test('a rejected tag edit leaves the stored tag untouched', () => {
  tags.createTag({ serverId: 'tag-edit', name: 'faq', content: 'Answer', createdBy: 'U' });
  tags.createTag({ serverId: 'tag-edit', name: 'other', content: 'Other', createdBy: 'U' });
  const result = tags.updateTag('tag-edit', 'faq', { content: 'Changed', name: 'other' });
  assert.equal(result.ok, false);
  assert.equal(tags.getTag('tag-edit', 'faq')?.content, 'Answer');
});

test('tags can be edited and deleted through an alias', () => {
  tags.createTag({ serverId: 'tag-alias', name: 'ip', content: 'play.example.com', createdBy: 'U' });
  tags.addTagAlias('tag-alias', 'ip', 'server');
  assert.equal(tags.updateTag('tag-alias', 'server', { content: 'new.example.com' }).ok, true);
  assert.equal(tags.getTag('tag-alias', 'ip')?.content, 'new.example.com');
  assert.equal(tags.deleteTag('tag-alias', 'server'), true);
  assert.equal(tags.getTag('tag-alias', 'ip'), null);
});

test('a tag keeps line breaks in {args} and defuses mass mentions', async () => {
  tags.createTag({ serverId: 'tag-run', name: 'say', content: '{args}', createdBy: 'U' });
  const sent: any[] = [];
  const message = {
    content: `${config.prefix}say line one\nline two @everyone`,
    authorId: 'U',
    channelId: 'C',
    channel: { serverId: 'tag-run', send: async (payload: any) => sent.push(payload) },
  };
  const result = await tags.runTag(message, 'say', ['line', 'one', 'line', 'two', '@everyone'], { servers: { cache: new Map() } });
  assert.equal(result.status, 'sent');
  assert.equal(sent[0].content, `line one\nline two @${ZWSP}everyone`);
});

// ---- Economy ----------------------------------------------------------------

test('looking up a balance does not open an account', () => {
  economy.setEconomyConfig({ enabled: true, startingBalance: 50 }, 'eco-peek');
  assert.equal(economy.getBalance('NOBODY', 'eco-peek').balance, 50);
  assert.deepEqual(economy.inventoryOf('NOBODY', 'eco-peek'), []);
  assert.equal(economy.getEconomySummary('eco-peek').holders, 0);
});

test('the rich list skips empty balances and amounts are bounded', () => {
  economy.setEconomyConfig({ enabled: true, startingBalance: 0 }, 'eco-rich');
  economy.addBalance('RICH', 1e300, 'eco-rich');
  economy.setBalance('ZERO', 0, 'eco-rich');
  const rows = economy.getRichList(10, 'eco-rich');
  assert.deepEqual(rows.map((row) => row.userId), ['RICH']);
  assert.ok(Number.isFinite(rows[0].balance) && rows[0].balance <= 1e12);
});

// ---- Birthdays --------------------------------------------------------------

test('two-digit years pick the right century and short month names are refused', () => {
  const recent = birthdays.parseBirthday('15/03/05');
  assert.ok(!('error' in recent) && recent.year === 2005);
  const older = birthdays.parseBirthday('15/03/98');
  assert.ok(!('error' in older) && older.year === 1998);
  assert.ok('error' in birthdays.parseBirthday('15 Ma'));
});

test('the birthday role is removed even after the setting is cleared', async () => {
  const serverId = 'bday-role';
  const calls: Calls = [];
  const { client, members, channels } = makeClient(serverId, calls);
  members.set('BDAY', makeMember('BDAY', calls));
  channels.set('BCHAN', textChannel('BCHAN', serverId, []));
  const today = new Date();
  birthdays.setBirthdayConfig({ enabled: true, channelId: 'BCHAN', roleId: 'CAKE' }, serverId);
  birthdays.setBirthday('BDAY', { month: today.getUTCMonth() + 1, day: today.getUTCDate(), year: null }, serverId);

  const now = Date.now();
  assert.equal(await birthdays.runBirthdaysForServer(client, serverId, now, { force: true }), 1);
  await birthdays.runBirthdaysForServer(client, serverId, now, { force: true });
  assert.equal(calls.filter((call) => call === 'addRole:BDAY:CAKE').length, 2);

  birthdays.setBirthdayConfig({ roleId: null }, serverId);
  birthdays.startBirthdayScheduler(client);
  try {
    await birthdays.runBirthdayTick(now + 2 * 86_400_000);
  } finally {
    birthdays.stopBirthdayScheduler();
  }
  assert.equal(calls.filter((call) => call === 'removeRole:BDAY:CAKE').length, 1, 'removed once, not once per test run');
});

// ---- Temporary voice --------------------------------------------------------

test('voice rooms cannot be created while the feature is off', async () => {
  const { client } = makeClient('tv-off', []);
  const result = await tempvoice.createRoom(client, { serverId: 'tv-off', ownerId: 'OWNER1' });
  assert.equal(result.ok, false);
  assert.match(result.error || '', /switched off/);
});

test('two quick creates make one room, with a short name and the user limit applied', async () => {
  const calls: Calls = [];
  const { client } = makeClient('tv-on', calls);
  tempvoice.setTempVoiceConfig({ enabled: true, userLimit: 4, nameTemplate: '{user} has an extremely long room name here' }, 'tv-on');
  const [a, b] = await Promise.all([
    tempvoice.createRoom(client, { serverId: 'tv-on', ownerId: 'OWNER2', ownerName: 'Someone' }),
    tempvoice.createRoom(client, { serverId: 'tv-on', ownerId: 'OWNER2', ownerName: 'Someone' }),
  ]);
  assert.equal([a.ok, b.ok].filter(Boolean).length, 1);
  const room = (a.ok ? a.room : b.room)!;
  assert.ok(room.name.length <= 32);
  assert.ok(calls.some((call) => call.includes('"max_users":4')), 'the limit is set with an edit');
});

// ---- Analytics --------------------------------------------------------------

test("the bot's own voice time is not counted, and Ready seeds sessions", () => {
  const client = { user: { id: 'BOT' }, channels: { cache: new Map([['VOICE', { serverId: 'an-srv' }]]) } };
  analytics.recordAnalyticsVoicePacket(client, { type: 'VoiceChannelJoin', id: 'VOICE', state: { id: 'BOT' } } as any);
  analytics.recordAnalyticsVoicePacket(client, { type: 'Ready', voice_states: [{ id: 'VOICE', participants: [{ id: 'MEMBER' }] }] } as any);
  assert.equal(analytics.getAnalyticsSummary({ serverId: 'an-srv' }).voice.liveSessions, 1);
});

// ---- Backups ----------------------------------------------------------------

test('restoring one server leaves the other servers in shared files alone', () => {
  const current = { version: 1, servers: { A: { balance: 'current A' }, B: { balance: 'current B' } } };
  const restored = { version: 1, servers: { B: { balance: 'restored B' }, C: { balance: 'stale C' } } };
  const merged = backup.mergeServerScopedData('economy.json', current, restored, 'B');
  assert.deepEqual(merged.servers, { A: { balance: 'current A' }, B: { balance: 'restored B' } });

  const tagMerge = backup.mergeServerScopedData(
    'tags.json',
    { tags: [{ serverId: 'A', name: 'a' }, { serverId: 'B', name: 'old' }] },
    { tags: [{ serverId: 'B', name: 'new' }, { serverId: 'A', name: 'stale' }] },
    'B',
  );
  assert.deepEqual(tagMerge.tags.map((tag: any) => `${tag.serverId}:${tag.name}`), ['A:a', 'B:new']);

  const voice = backup.mergeServerScopedData(
    'tempvoice.json',
    { servers: { B: { config: { enabled: false }, rooms: [{ channelId: 'LIVE' }] } } },
    { servers: { B: { config: { enabled: true }, rooms: [{ channelId: 'GONE' }] } } },
    'B',
  );
  assert.deepEqual(voice.servers.B, { config: { enabled: true }, rooms: [{ channelId: 'LIVE' }] });
  assert.equal(backup.mergeServerScopedData('economy.json', current, { servers: {} }, 'B'), null);
});

test('a restored data file replaces what the module holds in memory', () => {
  economy.setEconomyConfig({ enabled: true, currencyName: 'before' }, 'eco-reload');
  // Economy lives in SQLite; a backup still reads and restores it as economy.json.
  const raw: any = readDataFileContent('economy.json');
  raw.servers['eco-reload'].config.currencyName = 'after';
  writeDataFileContent('economy.json', raw);
  reloadDataFile('economy.json');
  assert.equal(economy.getEconomyConfig('eco-reload').currencyName, 'after');
});

test('the backup diff reads categories where backups keep them', async () => {
  const file = join(process.env.YAOSB_DATA_DIR!, 'preview.json');
  writeFileSync(file, JSON.stringify({
    format: 'yaosb.stoat.server-backup',
    version: 1,
    sourceServerId: 'SRC',
    server: { categories: [{ id: 'cat1', title: 'General', channels: ['c1'] }] },
    channels: [{ id: 'c1', name: 'chat', type: 'Text' }],
    roles: [],
    botData: { 'economy.json': {}, 'not-a-bot-file.json': {} },
  }));
  const client = { api: { get: async () => ({ channels: [], roles: {}, categories: [{ title: 'General' }] }) }, servers: { cache: new Map() }, channels: { cache: new Map() } };
  const preview = await previewServerBackup(client, file, 'TARGET');
  assert.equal(preview.categories.length, 1);
  assert.equal(preview.categories[0].status, 'existing');
  assert.equal(preview.channels[0].detail, 'Text');
  assert.equal(preview.file, 'preview.json');
  assert.deepEqual(preview.dataFiles.map((entry) => entry.file), ['economy.json']);
});
