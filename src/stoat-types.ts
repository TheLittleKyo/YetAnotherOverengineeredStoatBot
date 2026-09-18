/**
 * Shared type aliases for stoatbot.js entities.
 *
 * stoatbot.js ships full `.d.ts` types, but most of this codebase predates
 * using them and types the client / events / entities as `any`. That hides
 * shape drift (a renamed field, a changed event signature) until runtime.
 *
 * Import from here to type new code — `StoatClient` for the client, and the
 * entity aliases for event payloads — instead of reaching for `any`. Existing
 * `any` sites can be migrated incrementally; anything genuinely off-type stays
 * behind an explicit `as any` with a comment rather than untyped by default.
 */
export type {
  client as StoatClient,
  Server,
  ServerMember,
  User,
  Role,
  Channel,
  TextChannel,
  ServerChannel,
  MessageStruct as Message,
} from 'stoatbot.js';

/**
 * A raw gateway packet as delivered to `client.on('raw', ...)`. stoatbot.js
 * types this loosely; the fields we read (type, ids, emoji, data/clear) vary by
 * event, so this stays an index signature rather than a false-precise union.
 */
export type RawPacket = {
  type?: string;
  id?: any;
  channel_id?: string;
  user_id?: string;
  emoji_id?: string;
  data?: Record<string, unknown>;
  clear?: string[];
  [key: string]: unknown;
};
