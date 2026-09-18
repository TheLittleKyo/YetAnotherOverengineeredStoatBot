/**
 * Duration parsing: the three-way answer (milliseconds / null for "no expiry" /
 * undefined for "not a duration") is what keeps `!ban @user spamming` from
 * being read as a timed ban, so each case is pinned here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDuration, formatRelative, parseDuration, MAX_DURATION_MS } from '../src/duration.js';

test('parses compact and spelled-out forms', () => {
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1d'), 86_400_000);
  assert.equal(parseDuration('1w'), 604_800_000);
  assert.equal(parseDuration('10 minutes'), 600_000);
  assert.equal(parseDuration('2 hours'), 7_200_000);
});

test('sums compound durations', () => {
  assert.equal(parseDuration('2h30m'), 9_000_000);
  assert.equal(parseDuration('1d 12h'), 129_600_000);
});

test('permanent spellings mean "no expiry", not zero', () => {
  for (const input of ['permanent', 'perm', 'forever', 'never', '0']) {
    assert.equal(parseDuration(input), null, input);
  }
});

test('non-durations are undefined so a reason is never eaten as a time', () => {
  assert.equal(parseDuration('spamming'), undefined);
  assert.equal(parseDuration('2h and rude'), undefined);
  assert.equal(parseDuration('10x'), undefined);
  assert.equal(parseDuration(''), undefined);
  assert.equal(parseDuration(undefined), undefined);
});

test('a runaway value is clamped rather than accepted', () => {
  assert.equal(parseDuration('9999w'), MAX_DURATION_MS);
});

test('formatting shows at most the two largest units', () => {
  assert.equal(formatDuration(null), 'permanent');
  assert.equal(formatDuration(600_000), '10m');
  assert.equal(formatDuration(9_000_000), '2h 30m');
  assert.equal(formatDuration(90_061_000), '1d 1h');
  assert.equal(formatDuration(500), 'a moment');
});

test('relative times read forwards and backwards', () => {
  const now = 1_000_000_000;
  assert.equal(formatRelative(now + 600_000, now), 'in 10m');
  assert.equal(formatRelative(now - 600_000, now), '10m ago');
  assert.equal(formatRelative(now, now), 'now');
  assert.equal(formatRelative(null, now), 'never');
});
