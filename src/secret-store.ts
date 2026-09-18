/**
 * Encrypted storage for credentials entered in the dashboard (booru API keys).
 *
 * Values are sealed with AES-256-GCM and written to `data/secrets.json`; each
 * entry's name is bound in as additional authenticated data, so a ciphertext
 * copied under another name fails to open. Nothing is ever stored in plain
 * text, and no API hands a stored value back to the browser.
 *
 * The master key comes from `YAOSB_SECRET_KEY` when set (any string; stretched
 * with scrypt). Otherwise a random 32-byte key is generated on first use and
 * kept in `data/secret.key`, readable only by the bot's user where the
 * filesystem supports it. What this protects against: `secrets.json` leaking on
 * its own (a backup, a pasted file, a screenshot of the data folder). Someone
 * who can read the whole data directory, or the process memory, can still open
 * the secrets — set `YAOSB_SECRET_KEY` so the key never sits beside the data.
 *
 * Losing or changing the master key makes stored values unreadable; they then
 * report as `unreadable` and have to be entered again.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { env } from './config.js';
import { dataFile, ensureDataDir, readJson, writeJson } from './json-store.js';
import { warn } from './logger.js';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const STORE_VERSION = 1;
/** Fixed salt: the env passphrase is the secret, the salt only separates this use of it. */
const PASSPHRASE_SALT = 'yaosb-secret-store-v1';

type SealedValue = { iv: string; tag: string; data: string };
type SecretFile = { version: number; secrets: Record<string, SealedValue> };

export type SecretState = 'missing' | 'stored' | 'unreadable';

let masterKey: Buffer | null = null;
const warnedUnreadable = new Set<string>();

const storeFile = () => dataFile('secrets.json');
const keyFile = () => dataFile('secret.key');

function loadMasterKey(): Buffer {
  if (masterKey) return masterKey;

  if (env.secretKey) {
    masterKey = scryptSync(env.secretKey, PASSPHRASE_SALT, KEY_BYTES);
    return masterKey;
  }

  const path = keyFile();
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf-8').trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`${path} is not a valid ${KEY_BYTES}-byte key.`);
    masterKey = key;
    return masterKey;
  }

  ensureDataDir();
  const key = randomBytes(KEY_BYTES);
  // `wx` refuses to overwrite a key another call wrote in the meantime.
  writeFileSync(path, `${key.toString('base64')}\n`, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file inherits the folder's ACL there.
  }
  masterKey = key;
  return masterKey;
}

function readStore(): SecretFile {
  const parsed = readJson<Partial<SecretFile>>(storeFile(), { version: STORE_VERSION, secrets: {} });
  const secrets = parsed?.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {};
  return { version: STORE_VERSION, secrets };
}

function seal(name: string, value: string): SealedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadMasterKey(), iv);
  cipher.setAAD(Buffer.from(name, 'utf-8'));
  const data = Buffer.concat([cipher.update(value, 'utf-8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

function open(name: string, sealed: SealedValue): string | null {
  try {
    const decipher = createDecipheriv(ALGORITHM, loadMasterKey(), Buffer.from(sealed.iv, 'base64'));
    decipher.setAAD(Buffer.from(name, 'utf-8'));
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf-8');
  } catch {
    if (!warnedUnreadable.has(name)) {
      warnedUnreadable.add(name);
      warn(`secret-store: "${name}" could not be decrypted (master key changed?). Enter it again in the dashboard.`);
    }
    return null;
  }
}

/** The stored value, or null when it is missing or cannot be decrypted. */
export function getSecret(name: string): string | null {
  const sealed = readStore().secrets[name];
  return sealed ? open(name, sealed) : null;
}

export function getSecretState(name: string): SecretState {
  const sealed = readStore().secrets[name];
  if (!sealed) return 'missing';
  return open(name, sealed) === null ? 'unreadable' : 'stored';
}

export function setSecret(name: string, value: string): void {
  const store = readStore();
  store.secrets[name] = seal(name, value);
  warnedUnreadable.delete(name);
  writeJson(storeFile(), store);
}

export function deleteSecret(name: string): void {
  const store = readStore();
  if (!(name in store.secrets)) return;
  delete store.secrets[name];
  warnedUnreadable.delete(name);
  writeJson(storeFile(), store);
}

/** Forget the cached master key (tests switch keys between cases). */
export function resetSecretStoreForTests(): void {
  masterKey = null;
  warnedUnreadable.clear();
}
