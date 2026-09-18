/**
 * Tests for the debug logger's DEBUG-spec parsing and scope matching (the pure
 * pieces that decide whether a debug line is emitted).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDebugSpec, scopeMatches } from '../src/logger.js';

test('parseDebugSpec treats unset/off values as disabled', () => {
  for (const v of [undefined, '', '0', 'false', 'off', '  ']) {
    assert.deepEqual(parseDebugSpec(v), { all: false, scopes: [] }, `"${v}"`);
  }
});

test('parseDebugSpec treats truthy/wildcard values as all-on', () => {
  for (const v of ['1', 'true', '*', 'all', 'on', 'ALL']) {
    assert.deepEqual(parseDebugSpec(v), { all: true, scopes: [] }, `"${v}"`);
  }
});

test('parseDebugSpec splits a scope list on commas and whitespace', () => {
  assert.deepEqual(parseDebugSpec('logs, notify  stats').scopes, ['logs', 'notify', 'stats']);
});

test('scopeMatches: all-on matches everything', () => {
  assert.equal(scopeMatches({ all: true, scopes: [] }, 'anything'), true);
});

test('scopeMatches: empty spec matches nothing', () => {
  assert.equal(scopeMatches({ all: false, scopes: [] }, 'logs'), false);
});

test('scopeMatches: exact and prefix (colon sub-scope) match', () => {
  const spec = { all: false, scopes: ['notify'] };
  assert.equal(scopeMatches(spec, 'notify'), true);
  assert.equal(scopeMatches(spec, 'notify:poll'), true);
  assert.equal(scopeMatches(spec, 'NOTIFY'), true); // case-insensitive
  assert.equal(scopeMatches(spec, 'logs'), false);
});
