/**
 * Shared id normalizers.
 *
 * Ids reach the bot in several shapes depending on where they were typed: a
 * bare id pasted from the client, a mention the client expanded
 * (`<@01ABC…>`, `<#01ABC…>`, `<%01ABC…>`), or a sigil-prefixed id someone
 * typed by hand (`#general-id`). Every command and editor needs the bare id.
 *
 * The three normalizers below differ in which of those shapes they accept,
 * and that difference is deliberate: they were extracted from ~15 near-copies
 * and each one preserves exactly what its call sites used to accept, so no
 * command starts accepting (or rejecting) input it did not before.
 *
 *   cleanId / normalizeSimpleId  mentions, any sigil prefix, bare
 *   normalizeId                  the above plus role (`&`) mentions and the
 *                                `%<id>` / `#<id>` tag forms
 *   normalizeMentionOrId         mentions and bare ids only — no sigil prefix
 */

/** Bare id characters: the alphabet every Stoat id is made of. */
const ID = '[A-Za-z0-9_-]+';

const SIMPLE_MENTION = new RegExp(`^<[@#%]?!?(${ID})>$`);
const SIMPLE_PREFIX = new RegExp(`^[#%@](${ID})$`);
const BARE = new RegExp(`^${ID}$`);

const MENTION = new RegExp(`^<[@#&]?(?:!|&)?(${ID})>$`);
const TAG = new RegExp(`^(?:<%(${ID})>|[%@#]<(${ID})>)$`);
const PREFIX = new RegExp(`^[%@#](${ID})$`);

const MENTION_OR_BARE = new RegExp(`^<[@#&%]?(?:!|&)?(${ID})>$`);

/**
 * Normalize a pasted id / mention / sigil-prefixed value down to a bare id.
 * Returns `''` for anything unrecognizable, so callers can `|| null` it or
 * treat the empty string as "not set".
 */
export function cleanId(value: any): string {
  const input = String(value || '').trim();
  const mention = input.match(SIMPLE_MENTION);
  if (mention?.[1]) return mention[1];
  const prefixed = input.match(SIMPLE_PREFIX);
  if (prefixed?.[1]) return prefixed[1];
  return BARE.test(input) ? input : '';
}

/** `cleanId` with a `null` miss instead of an empty string. */
export function normalizeSimpleId(value: any): string | null {
  return cleanId(value) || null;
}

/**
 * The permissive normalizer used by the chat commands: accepts user, channel
 * and role mentions, the `%<id>` / `#<id>` tag forms some clients produce, a
 * sigil-prefixed id, or a bare id.
 */
export function normalizeId(value: any): string | null {
  const input = String(value || '').trim();
  if (!input) return null;

  const mention = input.match(MENTION);
  if (mention?.[1]) return mention[1];
  const tag = input.match(TAG);
  if (tag?.[1] || tag?.[2]) return tag[1] || tag[2];
  const prefixed = input.match(PREFIX);
  if (prefixed?.[1]) return prefixed[1];

  return BARE.test(input) ? input : null;
}

/**
 * Mentions and bare ids only. Used where a bare `#something` would be
 * ambiguous with ordinary argument text rather than an id.
 */
export function normalizeMentionOrId(value: any): string | null {
  const input = String(value || '').trim();
  if (!input) return null;
  const mention = input.match(MENTION_OR_BARE);
  if (mention?.[1]) return mention[1];
  return BARE.test(input) ? input : null;
}

/**
 * True for a Stoat object id: a 26-character ULID. Commands that act on a
 * member check this before doing anything, so `!warn spam` is read as a
 * missing target rather than a case against a user called "spam".
 */
export function isStoatId(value: unknown): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(String(value ?? ''));
}
