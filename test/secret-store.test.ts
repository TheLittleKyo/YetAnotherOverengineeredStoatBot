/**
 * Encrypted secret store: values never hit disk in plain text, a ciphertext is
 * bound to its name, tampering and a changed master key are detected, and the
 * YAOSB_SECRET_KEY passphrase replaces the generated key file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'yaosb-secrets-'));
process.env.YAOSB_DATA_DIR = dataDir;
delete process.env.YAOSB_SECRET_KEY;

const { env } = await import('../src/config.js');
const { deleteSecret, getSecret, getSecretState, resetSecretStoreForTests, setSecret } = await import('../src/secret-store.js');

const storePath = join(dataDir, 'secrets.json');
const keyPath = join(dataDir, 'secret.key');

function useKey(secretKey: string) {
  env.secretKey = secretKey;
  resetSecretStoreForTests();
}

test('values round-trip and never appear in the file', () => {
  useKey('');
  setSecret('booru.test', 'hunter2-plaintext-marker');
  assert.equal(getSecret('booru.test'), 'hunter2-plaintext-marker');
  assert.equal(getSecretState('booru.test'), 'stored');
  assert.ok(existsSync(keyPath), 'a key file is generated');
  assert.equal(readFileSync(storePath, 'utf-8').includes('hunter2'), false);
  assert.equal(Buffer.from(readFileSync(keyPath, 'utf-8').trim(), 'base64').length, 32);
});

test('each write uses a fresh IV', () => {
  useKey('');
  setSecret('booru.iv', 'same value');
  const first = JSON.parse(readFileSync(storePath, 'utf-8')).secrets['booru.iv'];
  setSecret('booru.iv', 'same value');
  const second = JSON.parse(readFileSync(storePath, 'utf-8')).secrets['booru.iv'];
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test('a ciphertext moved to another name does not open', () => {
  useKey('');
  setSecret('booru.a', 'secret-a');
  const store = JSON.parse(readFileSync(storePath, 'utf-8'));
  store.secrets['booru.b'] = store.secrets['booru.a'];
  writeFileSync(storePath, JSON.stringify(store));
  assert.equal(getSecret('booru.b'), null);
  assert.equal(getSecretState('booru.b'), 'unreadable');
  assert.equal(getSecret('booru.a'), 'secret-a');
});

test('tampered ciphertext is rejected', () => {
  useKey('');
  setSecret('booru.tamper', 'original');
  const store = JSON.parse(readFileSync(storePath, 'utf-8'));
  const bytes = Buffer.from(store.secrets['booru.tamper'].data, 'base64');
  bytes[0] ^= 0xff;
  store.secrets['booru.tamper'].data = bytes.toString('base64');
  writeFileSync(storePath, JSON.stringify(store));
  assert.equal(getSecret('booru.tamper'), null);
});

test('a passphrase key replaces the key file, and a different key cannot read', () => {
  useKey('correct horse battery staple');
  setSecret('booru.env', 'from-env');
  assert.equal(getSecret('booru.env'), 'from-env');

  useKey('some other passphrase');
  assert.equal(getSecret('booru.env'), null);
  assert.equal(getSecretState('booru.env'), 'unreadable');

  // Re-entering the value under the new key makes it readable again.
  setSecret('booru.env', 'from-env-2');
  assert.equal(getSecret('booru.env'), 'from-env-2');
});

test('deleteSecret removes the entry', () => {
  useKey('');
  setSecret('booru.gone', 'x');
  deleteSecret('booru.gone');
  assert.equal(getSecretState('booru.gone'), 'missing');
  assert.equal(getSecret('booru.gone'), null);
  deleteSecret('booru.never-existed');
});
