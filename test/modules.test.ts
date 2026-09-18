/**
 * Module switches (src/modules.ts): fresh installs start with everything off,
 * existing setups keep what they use, switches persist and notify, and a
 * switched-off module's commands answer without loading anything.
 *
 * Runs against a throwaway data directory (YAOSB_DATA_DIR).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'yaosb-modules-'));
process.env.YAOSB_DATA_DIR = dir;

const modules = await import('../src/modules.js');
const { reloadDataFile } = await import('../src/json-store.js');

const changes: Array<[string, boolean]> = [];
modules.onModuleChange((key, enabled) => changes.push([key, enabled]));

function readModulesFile() {
  return JSON.parse(readFileSync(join(dir, 'modules.json'), 'utf-8'));
}

test('a fresh install starts with every module off and records it', () => {
  for (const def of modules.MODULES) assert.equal(modules.isModuleEnabled(def.key), false, def.key);
  // Core features are not modules and are always on.
  assert.equal(modules.isModuleEnabled('tickets'), true);
  const saved = readModulesFile();
  assert.equal(saved.enabled.music, false);
  assert.equal(Object.keys(saved.enabled).length, modules.MODULES.length);
});

test('a module whose data shows it was set up is switched on; untouched defaults are not', () => {
  writeFileSync(join(dir, 'welcome.json'), JSON.stringify({ servers: { SRV: { enabled: true, channelId: 'CH1' } } }));
  writeFileSync(join(dir, 'channel-syncs.json'), JSON.stringify({ version: 1, links: [] }));
  writeFileSync(join(dir, 'automod.json'), '{ not json');
  rmSync(join(dir, 'modules.json'));
  changes.length = 0;

  // As after a restore: the switches are reread and the differences announced.
  reloadDataFile('modules.json');

  assert.equal(modules.isModuleEnabled('welcome'), true);
  assert.equal(modules.isModuleEnabled('sync'), false, 'an empty default store is not setup');
  assert.equal(modules.isModuleEnabled('automod'), true, 'an unreadable store keeps its module on');
  assert.equal(modules.isModuleEnabled('music'), false);
  assert.deepEqual(changes.sort(), [['automod', true], ['welcome', true]]);
});

test('switching a module persists, notifies once, and ignores no-op flips', () => {
  changes.length = 0;
  const view = modules.setModuleEnabled('music', true);
  assert.equal(view.enabled, true);
  assert.equal(readModulesFile().enabled.music, true);
  modules.setModuleEnabled('music', true);
  assert.deepEqual(changes, [['music', true]]);

  modules.setModuleEnabled('music', false);
  assert.equal(readModulesFile().enabled.music, false);
  assert.throws(() => modules.setModuleEnabled('no-such-module', true), /Unknown module/);
});

test('a recorded choice wins over detection', () => {
  modules.setModuleEnabled('welcome', false);
  reloadDataFile('modules.json');
  assert.equal(modules.isModuleEnabled('welcome'), false, 'welcome.json still has setup, but the owner turned it off');
});

test('after a restore, auto-decided modules follow the restored data; hand-set ones do not', () => {
  // `welcome` was turned off by hand above; `tags` was never touched.
  writeFileSync(join(dir, 'tags.json'), JSON.stringify({ tags: [{ name: 'rules', serverId: 'SRV' }] }));
  changes.length = 0;
  assert.deepEqual(modules.redetectModules(), ['tags']);
  assert.equal(modules.isModuleEnabled('tags'), true);
  assert.equal(modules.isModuleEnabled('welcome'), false);
  assert.deepEqual(changes, [['tags', true]]);
  assert.ok(readModulesFile().chosen.includes('welcome'));
  assert.equal(readModulesFile().chosen.includes('tags'), false);
});

test('commands map to their module through their bot-permission feature', () => {
  assert.equal(modules.disabledModuleForFeature('music')?.key, 'music');
  assert.equal(modules.disabledModuleForFeature('music.dj')?.key, 'music');
  assert.equal(modules.disabledModuleForFeature('tickets'), null);
  assert.equal(modules.disabledModuleForFeature(undefined), null);
  modules.setModuleEnabled('leveling', true);
  assert.equal(modules.disabledModuleForFeature('level'), null);
});

test('a switched-off command replies with the module notice and never loads the music stack', async () => {
  const { handleCommand } = await import('../src/commands/index.js');
  const { config } = await import('../src/config.js');
  const { isMusicLoaded } = await import('../src/music/lazy.js');
  const sent: any[] = [];
  const message = {
    author: { id: 'U1' },
    authorId: 'U1',
    content: `${config.prefix}play never gonna`,
    channel: { serverId: 'SRV', send: async (options: any) => { sent.push(options); } },
  };

  modules.setModuleEnabled('music', false);
  await handleCommand(message, { user: { id: 'BOT' } });
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Music\*\* module is switched off/);
  assert.equal(isMusicLoaded(), false);
});

test('help lists switched-on modules only, and explains a switched-off one asked for by name', async () => {
  const { helpCommand } = await import('../src/commands/help.js');
  const sent: any[] = [];
  const message = { channel: { send: async (options: any) => { sent.push(options); } } };

  modules.setModuleEnabled('music', false);
  modules.setModuleEnabled('leveling', true);
  await helpCommand(message, [], null);
  assert.doesNotMatch(sent[0].content, /help music`/);
  assert.match(sent[0].content, /help leveling`/);
  assert.match(sent[0].content, /help ticket`/);

  await helpCommand(message, ['music'], null);
  assert.match(sent[1].content, /module is switched off/);
});

test('the data directory holds the switches file', () => {
  assert.ok(existsSync(join(dir, 'modules.json')));
});
