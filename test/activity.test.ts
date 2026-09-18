/**
 * Activity summary: the zero-filled daily series and the "previous period"
 * totals behind the Overview deltas. Runs against a throwaway data directory
 * (YAOSB_DATA_DIR) seeded with an activity file before the module is imported.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function dayStart(offset: number): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offset);
  return d;
}

function dayKey(offset: number): string {
  const d = dayStart(offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const longAgo = new Date(Date.now() - 400 * 86_400_000).toISOString();
const dir = mkdtempSync(join(tmpdir(), 'yaosb-activity-'));
process.env.YAOSB_DATA_DIR = dir;

writeFileSync(join(dir, 'activity.json'), JSON.stringify({
  version: 2,
  startedAt: longAgo,
  servers: {
    busy: {
      totals: { messages: 121, images: 103, attachments: 0 },
      users: {},
      daily: {
        [dayKey(0)]: { messages: 5, images: 1 },
        [dayKey(-6)]: { messages: 3, images: 0 },
        [dayKey(-7)]: { messages: 10, images: 2 },
        [dayKey(-13)]: { messages: 4, images: 1 },
        [dayKey(-14)]: { messages: 99, images: 99 },
      },
    },
  },
}));

const { getActivitySummary, previousWindowTotals } = await import('../src/activity.js');

test('daily series is zero-filled and ends today', () => {
  const summary = getActivitySummary({ days: 7, serverId: 'busy' });
  assert.equal(summary.daily.length, 7);
  assert.equal(summary.daily[6].day, dayKey(0));
  assert.equal(summary.daily[6].messages, 5);
  assert.equal(summary.daily[0].day, dayKey(-6));
  assert.equal(summary.daily[0].messages, 3);
  assert.equal(summary.daily[3].messages, 0);
});

test('previous period covers the same-length window just before', () => {
  const summary = getActivitySummary({ days: 7, serverId: 'busy' });
  // Days -13 … -7 inclusive; day -14 falls outside.
  assert.deepEqual(summary.previous, { messages: 14, images: 3 });
});

test('unknown server yields an empty but complete summary', () => {
  const summary = getActivitySummary({ days: 7, serverId: 'nobody' });
  assert.equal(summary.daily.length, 7);
  assert.deepEqual(summary.previous, { messages: 0, images: 0 });
  assert.equal(summary.topMessages.length, 0);
});

test('previous period is null when tracking started inside it', () => {
  const startedAt = dayStart(-10).toISOString();
  // 7-day window starts at -6, so the previous one starts at -13.
  assert.equal(previousWindowTotals({}, dayStart(-6), 7, startedAt), null);
  assert.deepEqual(previousWindowTotals({}, dayStart(-2), 3, startedAt), { messages: 0, images: 0 });
});

test('previous period is null when tracking started on its first day', () => {
  // Started mid-morning on day -13, the previous window's first day: that day
  // is only partly counted.
  const startedAt = new Date(dayStart(-13).getTime() + 3 * 3_600_000).toISOString();
  assert.equal(previousWindowTotals({}, dayStart(-6), 7, startedAt), null);
  assert.deepEqual(previousWindowTotals({}, dayStart(-5), 7, startedAt), { messages: 0, images: 0 });
});

test('previous period is null when the start date is unreadable', () => {
  assert.equal(previousWindowTotals({}, dayStart(-6), 7, 'not a date'), null);
});

test('previous period is null when pruning cut into it', () => {
  // A full (pruned) series: 120 keys, oldest 119 days back.
  const daily: Record<string, { messages: number; images: number }> = {};
  for (let i = 0; i < 120; i += 1) daily[dayKey(-i)] = { messages: 1, images: 0 };
  // 90-day window starts at -89; the previous one would need day -179.
  assert.equal(previousWindowTotals(daily, dayStart(-89), 90, longAgo), null);
  // 50-day window: the previous one starts at -99, which the series still has.
  assert.deepEqual(previousWindowTotals(daily, dayStart(-49), 50, longAgo), { messages: 50, images: 0 });
});
