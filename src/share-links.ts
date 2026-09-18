/**
 * Temporary share-link store for the dashboard.
 *
 * The dashboard itself has no user auth (see editor-guard.ts). When it is
 * exposed off-machine through a Cloudflare tunnel, a share-link token becomes
 * the ONLY thing standing between a guest and full control — so tokens are long
 * random secrets, checked server-side on every request, with an expiry and an
 * optional single-use bind to the first guest's browser session.
 *
 * Persistence uses the shared json-store helpers (data/share-links.json). All
 * ops are synchronous read-modify-write, so there is no interleave race within
 * the single bot process.
 */
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { dataFile, readJson, updateJson } from './json-store.js';

export type ShareScope = 'read' | 'read-edit';

export interface ShareLink {
  /** base64url of 32 random bytes — the secret carried in the link. */
  token: string;
  /** Server this link is bound to (scope = current server only). */
  serverId: string;
  scope: ShareScope;
  createdAt: number;
  /** ms epoch after which the link is dead. */
  expiresAt: number;
  /** When true, only the first guest session may use the link. */
  singleUse: boolean;
  /**
   * When true, the guest holding this link may itself mint / list / revoke
   * further share links over the tunnel (the `/api/share` panel). This is the
   * "admin" grade minted by `!dashboard cloudflare`; ordinary links (including
   * the ones an admin link then creates) leave this false, so the power to hand
   * out access never propagates on its own.
   */
  canShare: boolean;
  /** sha256(session secret) of the guest that claimed a single-use link. */
  boundSession: string | null;
  createdBy: string;
  revoked: boolean;
}

interface Store {
  links: ShareLink[];
}

const DEFAULT_STORE: Store = { links: [] };
const storeFile = () => dataFile('share-links.json');

function now(): number {
  return Date.now();
}

/** A link is usable when it is neither revoked nor past its expiry. */
function isLive(link: ShareLink, at = now()): boolean {
  return !link.revoked && link.expiresAt > at;
}

/** Drop links that expired more than an hour ago (keeps the file from growing). */
function prune(links: ShareLink[]): ShareLink[] {
  const cutoff = now() - 60 * 60 * 1000;
  return links.filter((l) => l.expiresAt > cutoff);
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'hex');
    const bb = Buffer.from(b, 'hex');
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export function createShareLink(opts: {
  serverId: string;
  scope: ShareScope;
  ttlMs: number;
  singleUse: boolean;
  canShare?: boolean;
  createdBy?: string;
}): ShareLink {
  const link: ShareLink = {
    token: randomBytes(32).toString('base64url'),
    serverId: opts.serverId,
    scope: opts.scope,
    createdAt: now(),
    expiresAt: now() + Math.max(60_000, opts.ttlMs),
    singleUse: opts.singleUse,
    canShare: opts.canShare === true,
    boundSession: null,
    createdBy: opts.createdBy || 'operator',
    revoked: false,
  };
  updateJson<Store>(storeFile(), DEFAULT_STORE, (s) => ({ links: [...prune(s.links), link] }));
  return link;
}

/** Look up a link only if it is still live; expired/revoked/missing → null. */
export function getValidShareLink(token: string): ShareLink | null {
  if (!token) return null;
  const store = readJson<Store>(storeFile(), DEFAULT_STORE);
  const link = store.links.find((l) => l.token === token);
  if (!link || !isLive(link)) return null;
  return link;
}

/**
 * Bind (single-use) or verify a guest session against a link.
 *  - multi-use link            → always 'ok'
 *  - single-use, unbound       → binds this session, 'ok'
 *  - single-use, bound + match → 'ok'
 *  - single-use, bound + other → 'mismatch' (already claimed)
 *  - dead / missing link       → 'invalid'
 */
export function claimSession(token: string, sessionHash: string): 'ok' | 'mismatch' | 'invalid' {
  let result: 'ok' | 'mismatch' | 'invalid' = 'invalid';
  updateJson<Store>(storeFile(), DEFAULT_STORE, (s) => {
    const link = s.links.find((l) => l.token === token);
    if (!link || !isLive(link)) {
      result = 'invalid';
      return s;
    }
    if (!link.singleUse) {
      result = 'ok';
      return s;
    }
    if (link.boundSession == null) {
      link.boundSession = sessionHash;
      result = 'ok';
      return s;
    }
    result = safeEqualHex(link.boundSession, sessionHash) ? 'ok' : 'mismatch';
    return s;
  });
  return result;
}

export function revokeShareLink(token: string): boolean {
  let found = false;
  updateJson<Store>(storeFile(), DEFAULT_STORE, (s) => {
    const link = s.links.find((l) => l.token === token);
    if (link) {
      link.revoked = true;
      found = true;
    }
    return s;
  });
  return found;
}

/** All live links bound to a given server. */
export function listActiveShareLinks(serverId: string): ShareLink[] {
  const store = readJson<Store>(storeFile(), DEFAULT_STORE);
  return store.links.filter((l) => l.serverId === serverId && isLive(l));
}

/** Count of live links across all servers — used to decide if the tunnel is still needed. */
export function countActiveShareLinks(): number {
  const store = readJson<Store>(storeFile(), DEFAULT_STORE);
  return store.links.filter((l) => isLive(l)).length;
}
