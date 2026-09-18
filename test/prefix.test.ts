/**
 * Dashboard-set command prefix: it overrides `PREFIX`, clears back to it,
 * rejects unusable values, survives a reload, and does not disturb the ticket
 * IDs sharing `data/config.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'yaosb-prefix-'));
process.env.YAOSB_DATA_DIR = dataDir;
process.env.PREFIX = '?';

const configPath = join(dataDir, 'config.json');
// Pre-seed the file so the loader is exercised, not just the writer.
writeFileSync(configPath, JSON.stringify({ supportRoleId: 'role_1', prefix: '$' }), 'utf-8');

const { config, prefixError, prefixView, updateRuntimePrefix, updateTicketRuntimeConfig, MAX_PREFIX_LENGTH } =
  await import('../src/config.js');

const stored = () => JSON.parse(readFileSync(configPath, 'utf-8'));

test('a stored prefix is loaded and beats PREFIX', () => {
  assert.equal(config.prefix, '$');
  assert.equal(prefixView().prefixCustom, true);
  assert.equal(prefixView().fallbackPrefix, '?');
});

test('a new prefix applies at once and clears back to PREFIX', () => {
  assert.equal(updateRuntimePrefix('!!'), '!!');
  assert.equal(config.prefix, '!!');
  assert.equal(stored().prefix, '!!');

  assert.equal(updateRuntimePrefix(''), '?');
  assert.equal(config.prefix, '?');
  assert.equal(prefixView().prefixCustom, false);
  assert.equal(stored().prefix, undefined);
});

test('unusable prefixes are reported and never stored', () => {
  updateRuntimePrefix('!');
  assert.equal(prefixError('!'), null);
  assert.equal(prefixError(''), null);
  assert.match(String(prefixError('bot cmd')), /spaces/);
  assert.match(String(prefixError('x'.repeat(MAX_PREFIX_LENGTH + 1))), /at most/);

  // A rejected value would fall back to the environment rather than persist.
  assert.equal(updateRuntimePrefix('a b'), '?');
  assert.equal(config.prefix, '?');
});

test('writing ticket config keeps the prefix, and vice versa', () => {
  updateRuntimePrefix('%');
  updateTicketRuntimeConfig({ transcriptChannelId: 'chan_1' });
  assert.equal(config.prefix, '%');
  assert.equal(stored().prefix, '%');
  assert.equal(stored().transcriptChannelId, 'chan_1');

  updateRuntimePrefix('&');
  assert.equal(config.transcriptChannelId, 'chan_1');
  assert.equal(stored().transcriptChannelId, 'chan_1');
  // The ticket update's return value stays ticket-shaped.
  assert.equal('prefix' in updateTicketRuntimeConfig({}), false);
});
