/**
 * Booru site accounts, entered in the dashboard Booru tab and kept in the
 * encrypted secret store. One account can serve several sites (e621 / e926).
 */
import { deleteSecret, getSecret, getSecretState, setSecret, type SecretState } from '../secret-store.js';
import type { BooruCredentials } from './types.js';

export type BooruAccountDef = {
  id: string;
  name: string;
  /** Label for the account identifier, or null when the site only takes a key. */
  userLabel: string | null;
  keyLabel: string;
  /** Without an account the site refuses every API call. */
  required: boolean;
  /** Where the key is shown on the site. */
  helpUrl: string;
  help: string;
};

export const BOORU_ACCOUNTS: BooruAccountDef[] = [
  {
    id: 'danbooru',
    name: 'Danbooru',
    userLabel: 'Username',
    keyLabel: 'API key',
    required: false,
    helpUrl: 'https://danbooru.donmai.us/profile',
    help: 'Optional. Profile → API Key. A Gold account raises the two-tag search limit.',
  },
  {
    id: 'gelbooru',
    name: 'Gelbooru',
    userLabel: 'User ID',
    keyLabel: 'API key',
    required: true,
    helpUrl: 'https://gelbooru.com/index.php?page=account&s=options',
    help: 'Required. Account → Options → API Access Credentials.',
  },
  {
    id: 'rule34',
    name: 'Rule34',
    userLabel: 'User ID',
    keyLabel: 'API key',
    required: true,
    helpUrl: 'https://rule34.xxx/index.php?page=account&s=options',
    help: 'Required. My Account → Options → API Access Credentials.',
  },
  {
    id: 'e621',
    name: 'e621 / e926',
    userLabel: 'Username',
    keyLabel: 'API key',
    required: false,
    helpUrl: 'https://e621.net/users/home',
    help: 'Optional. Account → Manage API Access. Used for both e621 and e926.',
  },
  {
    id: 'derpibooru',
    name: 'Derpibooru',
    userLabel: null,
    keyLabel: 'API key',
    required: false,
    helpUrl: 'https://derpibooru.org/registrations/edit',
    help: 'Optional. Account settings → API key.',
  },
];

const BY_ID = new Map(BOORU_ACCOUNTS.map((account) => [account.id, account]));
const MAX_FIELD_LENGTH = 256;

const secretName = (accountId: string) => `booru.${accountId}`;

export function findBooruAccount(id: string): BooruAccountDef | null {
  return BY_ID.get(String(id || '')) ?? null;
}

/** The stored account for a site, or null when none is saved (or it cannot be decrypted). */
export function getBooruCredentials(accountId: string | undefined): BooruCredentials | null {
  if (!accountId || !BY_ID.has(accountId)) return null;
  const raw = getSecret(secretName(accountId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const key = String(parsed?.key || '');
    return key ? { user: String(parsed?.user || ''), key } : null;
  } catch {
    return null;
  }
}

export function getBooruAccountState(accountId: string): SecretState {
  return getSecretState(secretName(accountId));
}

/** Validate dashboard input for an account; throws a message fit for the form. */
export function normalizeBooruCredentials(account: BooruAccountDef, value: any): BooruCredentials {
  const clean = (input: unknown) => String(input ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim();
  const user = account.userLabel ? clean(value?.user) : '';
  const key = clean(value?.key);
  if (account.userLabel && !user) throw new Error(`${account.userLabel} is required.`);
  if (!key) throw new Error(`${account.keyLabel} is required.`);
  if (user.length > MAX_FIELD_LENGTH || key.length > MAX_FIELD_LENGTH) throw new Error('That value is too long.');
  if (account.userLabel === 'User ID' && !/^\d+$/.test(user)) throw new Error('User ID is a number.');
  return { user, key };
}

export function saveBooruCredentials(accountId: string, credentials: BooruCredentials): void {
  if (!BY_ID.has(accountId)) throw new Error('Unknown account.');
  setSecret(secretName(accountId), JSON.stringify(credentials));
}

export function removeBooruCredentials(accountId: string): void {
  deleteSecret(secretName(accountId));
}
