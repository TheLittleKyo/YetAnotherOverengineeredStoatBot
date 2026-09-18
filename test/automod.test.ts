/**
 * Automod matchers. These are the parts that decide whether a member's message
 * is deleted, so the evasion cases (zero-width characters, substrings of
 * innocent words, wildcards) are pinned rather than left to the UI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-automod-'));

const {
  capsRatio,
  countEmoji,
  extractDomains,
  matchBannedWord,
  wordPatternToRegExp,
  zalgoScore,
  addAutomodRule,
  listAutomodRules,
  removeAutomodRule,
  setAutomodConfig,
  getAutomodConfig,
} = await import('../src/automod.js');

test('whole-word matching does not punish innocent substrings', () => {
  assert.equal(matchBannedWord('what a class', ['ass'], true), null);
  assert.equal(matchBannedWord('what an ass', ['ass'], true), 'ass');
  // Off, the substring does match — that is the point of the toggle.
  assert.equal(matchBannedWord('what a class', ['ass'], false), 'ass');
});

test('wildcards span any run of characters', () => {
  assert.equal(matchBannedWord('free nitro scam link', ['scam*'], true), 'scam*');
  assert.equal(matchBannedWord('this is a scammer', ['scam*'], false), 'scam*');
  assert.ok(wordPatternToRegExp('a*z', false).test('abcz'));
});

test('zero-width characters cannot smuggle a banned word through', () => {
  assert.equal(matchBannedWord('b​a​d', ['bad'], true), 'bad');
});

test('a term that cannot compile is skipped, not thrown', () => {
  assert.doesNotThrow(() => matchBannedWord('hello', ['(unclosed'], false));
});

test('caps ratio ignores short messages and punctuation', () => {
  assert.equal(capsRatio('HI!'), 0, 'too short to judge');
  assert.equal(capsRatio('SHOUTING AT EVERYONE'), 100);
  assert.ok(capsRatio('Mostly normal sentence here') < 20);
});

test('emoji and zalgo scoring', () => {
  assert.equal(countEmoji('🎉🎉 party 🎉'), 3);
  assert.ok(zalgoScore('h̵̢̛e̷̢l̴̈l̷̀o̴͝') > 30);
  assert.equal(zalgoScore('hello'), 0);
});

test('domains are extracted without protocol or path', () => {
  assert.deepEqual(extractDomains('see https://www.Example.com/page?x=1 now'), ['example.com']);
  assert.deepEqual(extractDomains('no links here'), []);
});

test('rules round-trip through the store', () => {
  const rule = addAutomodRule({ type: 'words', action: 'warn', words: ['badword'] }, 'srv');
  assert.equal(rule.type, 'words');
  assert.equal(rule.action, 'warn');
  assert.deepEqual(rule.words, ['badword']);

  assert.equal(listAutomodRules('srv').length, 1);
  assert.equal(listAutomodRules('other').length, 0, 'rules are per server');

  assert.equal(removeAutomodRule(rule.id, 'srv'), true);
  assert.equal(removeAutomodRule(rule.id, 'srv'), false);
});

test('config normalizes unknown values instead of storing them', () => {
  const saved = setAutomodConfig({ enabled: true, exemptRoleIds: ['a', 'a', ''] as any }, 'srv');
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.exemptRoleIds, ['a']);
  assert.equal(getAutomodConfig('srv').enabled, true);
});
