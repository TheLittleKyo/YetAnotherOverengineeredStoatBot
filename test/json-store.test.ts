/**
 * Tests for the shared JSON store: roundtrip, missing/empty/corrupt handling,
 * and the read-modify-write helper. Uses throwaway temp file paths so it never
 * touches the real data directory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson, updateJson } from '../src/json-store.js';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'yaosb-store-'));
}

test('writeJson then readJson round-trips a value', () => {
  const dir = freshDir();
  const file = join(dir, 'data.json');
  const value = { a: 1, nested: { b: [1, 2, 3] }, s: 'hi' };
  writeJson(file, value);
  assert.deepEqual(readJson(file, null), value);
  rmSync(dir, { recursive: true, force: true });
});

test('readJson returns the default for a missing file', () => {
  const dir = freshDir();
  assert.deepEqual(readJson(join(dir, 'nope.json'), { fallback: true }), { fallback: true });
  rmSync(dir, { recursive: true, force: true });
});

test('readJson heals an empty file by writing the default', () => {
  const dir = freshDir();
  const file = join(dir, 'empty.json');
  writeFileSync(file, '   ', 'utf-8');
  const def = { healed: true };
  assert.deepEqual(readJson(file, def), def);
  // The file should now contain the default.
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf-8')), def);
  rmSync(dir, { recursive: true, force: true });
});

test('readJson quarantines a corrupt file and returns the default', () => {
  const dir = freshDir();
  const file = join(dir, 'corrupt.json');
  writeFileSync(file, '{ this is not valid json ]', 'utf-8');
  const def = { ok: 1 };
  assert.deepEqual(readJson(file, def), def);
  // A .corrupt.<ts>.bak backup should have been created next to it.
  const backups = readdirSync(dir).filter((f) => f.includes('.corrupt.') && f.endsWith('.bak'));
  assert.equal(backups.length, 1);
  rmSync(dir, { recursive: true, force: true });
});

test('updateJson applies the mutator and persists', () => {
  const dir = freshDir();
  const file = join(dir, 'counter.json');
  const first = updateJson(file, { n: 0 }, (c) => ({ n: c.n + 1 }));
  assert.equal(first.n, 1);
  const second = updateJson(file, { n: 0 }, (c) => ({ n: c.n + 1 }));
  assert.equal(second.n, 2);
  assert.equal(readJson<{ n: number }>(file, { n: 0 }).n, 2);
  rmSync(dir, { recursive: true, force: true });
});
