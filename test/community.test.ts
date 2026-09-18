/**
 * Tags, birthdays, giveaway draws and poll argument parsing — the pure logic
 * behind the community features, kept honest without a Stoat connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-community-'));

const { addTagAlias, createTag, deleteTag, getTag, listTags, normalizeTagName, renderTag, updateTag } =
  await import('../src/tags.js');
const { daysUntil, fallsOn, formatBirthday, parseBirthday } = await import('../src/birthdays.js');
const { drawWinners } = await import('../src/hosted-giveaways.js');
const { parsePollArgs } = await import('../src/commands/poll.js');

// ---- Tags ------------------------------------------------------------------

test('tag names are normalized to one safe token', () => {
  assert.equal(normalizeTagName('  Server Rules! '), 'serverrules');
  assert.equal(normalizeTagName('faq-2'), 'faq-2');
  assert.equal(normalizeTagName('###'), '');
});

test('tags are created, found by alias, and never duplicated', () => {
  const created = createTag({ serverId: 'srv', name: 'rules', content: 'Be nice.', createdBy: 'u1' });
  assert.equal(created.ok, true);

  const duplicate = createTag({ serverId: 'srv', name: 'rules', content: 'Again', createdBy: 'u1' });
  assert.equal(duplicate.ok, false);

  assert.equal(addTagAlias('srv', 'rules', 'r').ok, true);
  assert.equal(getTag('srv', 'r')?.name, 'rules');
  assert.equal(getTag('other', 'rules'), null, 'tags are per server');
});

test('reserved names are refused so a tag cannot shadow the bot', () => {
  const result = createTag({ serverId: 'srv', name: 'help', content: 'nope', createdBy: 'u1' });
  assert.equal(result.ok, false);
  assert.match(String(result.error), /reserved/i);
});

test('a tag cannot be emptied by an edit', () => {
  const result = updateTag('srv', 'rules', { content: '   ' });
  assert.equal(result.ok, false);
});

test('placeholders are filled from the invocation context', () => {
  const rendered = renderTag('Hi {user} ({mention}) in {channel} of {server}: {args}', {
    userName: 'Ada', userId: 'u1', serverName: 'Lab', channelId: 'c1', args: 'hello there',
  });
  assert.equal(rendered, 'Hi Ada (<@u1>) in <#c1> of Lab: hello there');
});

test('deleting a tag removes it once', () => {
  assert.equal(deleteTag('srv', 'rules'), true);
  assert.equal(deleteTag('srv', 'rules'), false);
  assert.equal(listTags('srv').length, 0);
});

// ---- Birthdays -------------------------------------------------------------

test('birthday dates parse day-first, named, and ISO', () => {
  assert.deepEqual(parseBirthday('15/03'), { month: 3, day: 15, year: null });
  assert.deepEqual(parseBirthday('15-03-1998'), { month: 3, day: 15, year: 1998 });
  assert.deepEqual(parseBirthday('15 March'), { month: 3, day: 15, year: null });
  assert.deepEqual(parseBirthday('March 15 1998'), { month: 3, day: 15, year: 1998 });
  assert.deepEqual(parseBirthday('1998-03-15'), { month: 3, day: 15, year: 1998 });
});

test('impossible dates are rejected with a reason', () => {
  assert.match(String((parseBirthday('31/02') as any).error), /does not have 31 days/);
  assert.match(String((parseBirthday('15/13') as any).error), /month/);
  assert.match(String((parseBirthday('nonsense') as any).error), /Could not read/);
});

test('29 February falls on 1 March in a non-leap year', () => {
  assert.equal(fallsOn({ month: 2, day: 29 }, 3, 1, 2027), true, '2027 is not a leap year');
  assert.equal(fallsOn({ month: 2, day: 29 }, 3, 1, 2028), false, '2028 has its own 29 February');
  assert.equal(fallsOn({ month: 2, day: 29 }, 2, 29, 2028), true);
});

test('days-until wraps into next year', () => {
  const newYear = Date.UTC(2026, 11, 31, 12);
  assert.equal(daysUntil({ month: 1, day: 1 }, newYear), 1);
  assert.equal(daysUntil({ month: 12, day: 31 }, newYear), 0);
});

test('birthdays format with and without a year', () => {
  assert.equal(formatBirthday({ month: 3, day: 15, year: 1998 }), '15 March 1998');
  assert.equal(formatBirthday({ month: 3, day: 15, year: null }), '15 March');
});

// ---- Giveaway draws --------------------------------------------------------

test('winners are drawn without replacement, even with weighted entries', () => {
  const pool = ['a', 'a', 'a', 'b', 'c'];
  const winners = drawWinners(pool, 3);
  assert.equal(winners.length, 3);
  assert.equal(new Set(winners).size, 3, 'nobody wins twice');
});

test('a reroll never re-picks an existing winner', () => {
  const winners = drawWinners(['a', 'b', 'c'], 2, ['a']);
  assert.ok(!winners.includes('a'));
});

test('an empty pool yields no winners rather than throwing', () => {
  assert.deepEqual(drawWinners([], 3), []);
  assert.deepEqual(drawWinners(['a'], 3), ['a'], 'asking for more winners than entrants is fine');
});

// ---- Poll arguments --------------------------------------------------------

test('quoted polls split question and options', () => {
  const parsed = parsePollArgs('"Best colour?" "Red" "Blue"') as any;
  assert.equal(parsed.question, 'Best colour?');
  assert.deepEqual(parsed.options, ['Red', 'Blue']);
});

test('shorthand splits options on commas after the question mark', () => {
  const parsed = parsePollArgs('Game night? friday, saturday, sunday') as any;
  assert.equal(parsed.question, 'Game night?');
  assert.deepEqual(parsed.options, ['friday', 'saturday', 'sunday']);
});

test('flags are pulled out of the text, not left in the question', () => {
  const parsed = parsePollArgs('"Ship it?" --time 2h --multi --anon') as any;
  assert.equal(parsed.question, 'Ship it?');
  assert.equal(parsed.durationMs, 7_200_000);
  assert.equal(parsed.multi, true);
  assert.equal(parsed.anonymous, true);
});

test('a bare question becomes a yes/no poll and a bad time is reported', () => {
  const parsed = parsePollArgs('Ship it') as any;
  assert.deepEqual(parsed.options, []);
  assert.match(String((parsePollArgs('"Q" --time banana') as any).error), /not a duration/);
});
