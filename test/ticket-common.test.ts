/**
 * Tests for ticket priority helpers used by the `ticket priority` subcommand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePriority,
  PRIORITY_META,
  TICKET_PRIORITIES,
} from '../src/commands/ticket-common.js';

test('normalizePriority accepts known levels case-insensitively', () => {
  assert.equal(normalizePriority('low'), 'low');
  assert.equal(normalizePriority('URGENT'), 'urgent');
  assert.equal(normalizePriority('  High '), 'high');
});

test('normalizePriority rejects unknown values', () => {
  for (const v of ['', 'medium', 'critical', undefined]) {
    assert.equal(normalizePriority(v as any), null, `"${v}"`);
  }
});

test('PRIORITY_META covers every priority level', () => {
  for (const level of TICKET_PRIORITIES) {
    assert.ok(PRIORITY_META[level]?.label, `missing meta for ${level}`);
    assert.ok(PRIORITY_META[level]?.icon, `missing icon for ${level}`);
  }
});
