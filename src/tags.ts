/**
 * Tags — custom, server-defined commands. `!rules`, `!ip`, `!faq`: canned
 * answers a moderator writes once and anyone can call.
 *
 * The auto-responder already reacts to keywords *inside* messages; a tag is the
 * opposite shape — it is invoked deliberately, by name, with the command
 * prefix. That is why tags resolve in the command dispatcher (after every
 * built-in command has had its chance, so a tag can never shadow `!ban`) rather
 * than on the message hot path.
 *
 * A tag can be plain text or an embed, and both support the same placeholders
 * as the welcome and auto-responder templates, plus `{args}` for whatever was
 * typed after the tag name.
 *
 * Storage: `data/tags.json`.
 */

import { config } from './config.js';
import { createArrayFileStore, dataFile } from './json-store.js';
import { getRoleIds } from './member-utils.js';
import { recordAudit, type AuditSource } from './audit.js';
import { MESSAGE_CONTENT_MAX, clampText, neutraliseMentions, safeEmbed } from './embed-limits.js';
import type { CustomEmbedConfig } from './embed-editor.js';

export type Tag = {
  id: string;
  serverId: string;
  /** Lower-case invocation name, without the prefix. */
  name: string;
  aliases: string[];
  content: string;
  /** Optional embed; when set it is sent alongside `content`. */
  embed: CustomEmbedConfig | null;
  createdBy: string;
  createdByName: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
  /** When set, only members holding one of these roles may call the tag. */
  restrictedRoleIds: string[];
  /** When set, the tag only answers in these channels. */
  channelIds: string[];
};

const store = createArrayFileStore<Tag>(dataFile('tags.json'), 'tags', 'tags');

/** Names that would shadow something the bot already answers to. */
const RESERVED_NAMES = new Set(['tag', 'tags', 'help', 'ping', 'dashboard']);

/**
 * Every built-in command name and alias, filled in by the command dispatcher
 * at start-up. A tag called `ban` would be created fine and then never answer,
 * because built-ins always win — so such names are refused up front.
 */
const builtinNames = new Set<string>();

export function setBuiltinCommandNames(names: Iterable<string>): void {
  builtinNames.clear();
  for (const name of names) builtinNames.add(String(name).toLowerCase());
}

function reservedReason(name: string): string | null {
  if (RESERVED_NAMES.has(name)) return `\`${name}\` is reserved by the bot.`;
  if (builtinNames.has(name)) return `\`${name}\` is already a bot command.`;
  return null;
}

/** The tag a name or alias points at, from a given list. */
function findTag(all: Tag[], serverId: string, name: string): Tag | undefined {
  const wanted = normalizeTagName(name);
  if (!wanted) return undefined;
  return all.find((entry) => entry.serverId === serverId && (entry.name === wanted || entry.aliases.includes(wanted)));
}

export const MAX_TAG_NAME = 32;
export const MAX_TAG_CONTENT = 2000;

function generateId(): string {
  return `tg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

/** Tag names are lower-case, single-token, and free of markdown punctuation. */
export function normalizeTagName(value: any): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, MAX_TAG_NAME);
}

export function listTags(serverId = config.serverId || ''): Tag[] {
  return store
    .read()
    .filter((tag) => tag.serverId === serverId)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve a tag by its name or one of its aliases. */
export function getTag(serverId: string, name: string): Tag | null {
  const wanted = normalizeTagName(name);
  if (!wanted) return null;
  return (
    store.read().find((tag) => tag.serverId === serverId && (tag.name === wanted || tag.aliases.includes(wanted))) || null
  );
}

/** Every name a server's tags answer to, for the dispatcher's quick check. */
export function tagNamesFor(serverId: string): Set<string> {
  const names = new Set<string>();
  for (const tag of store.read()) {
    if (tag.serverId !== serverId) continue;
    names.add(tag.name);
    for (const alias of tag.aliases) names.add(alias);
  }
  return names;
}

export type TagResult = { ok: boolean; tag?: Tag; error?: string };

export function createTag(input: {
  serverId: string;
  name: string;
  content: string;
  embed?: CustomEmbedConfig | null;
  createdBy: string;
  createdByName?: string;
  /** Where the change came from, for the audit log. */
  source?: AuditSource;
}): TagResult {
  const name = normalizeTagName(input.name);
  if (!name) return { ok: false, error: 'A tag name may only use letters, numbers, `-` and `_`.' };
  const reserved = reservedReason(name);
  if (reserved) return { ok: false, error: reserved };
  if (getTag(input.serverId, name)) return { ok: false, error: `A tag called \`${name}\` already exists.` };

  const content = text(input.content, MAX_TAG_CONTENT);
  if (!content && !input.embed) return { ok: false, error: 'A tag needs content or an embed.' };

  const now = Date.now();
  const tag: Tag = {
    id: generateId(),
    serverId: String(input.serverId || ''),
    name,
    aliases: [],
    content,
    embed: input.embed || null,
    createdBy: String(input.createdBy || ''),
    createdByName: text(input.createdByName, 80) || 'Unknown',
    createdAt: now,
    updatedAt: now,
    uses: 0,
    restrictedRoleIds: [],
    channelIds: [],
  };

  store.write([...store.read(), tag]);
  recordAudit({
    serverId: tag.serverId,
    actorId: tag.createdBy,
    actorName: tag.createdByName,
    source: input.source || 'command',
    area: 'tags',
    action: 'create',
    detail: name,
  });
  return { ok: true, tag };
}

/** Who changed a tag, for the audit log: a bare source, or a named member. */
export type TagActor = AuditSource | { source: AuditSource; id?: string; name?: string };

function auditTag(serverId: string, actor: TagActor, action: string, detail: string) {
  const who = typeof actor === 'string' ? { source: actor } : actor;
  recordAudit({
    serverId,
    actorId: who.id || '',
    actorName: who.name || (who.source === 'dashboard' ? 'Dashboard' : 'Unknown'),
    source: who.source,
    area: 'tags',
    action,
    detail,
  });
}

export function updateTag(serverId: string, name: string, patch: Partial<Tag>, actor: TagActor = 'command'): TagResult {
  const all = store.read();
  const tag = findTag(all, serverId, name);
  if (!tag) return { ok: false, error: `No tag called \`${name}\`.` };

  // Work on a copy: a rejected edit must leave the stored tag untouched.
  const next: Tag = { ...tag };
  if (patch.content !== undefined) next.content = text(patch.content, MAX_TAG_CONTENT);
  if (patch.embed !== undefined) next.embed = patch.embed || null;
  if (patch.restrictedRoleIds !== undefined) {
    next.restrictedRoleIds = Array.from(new Set((patch.restrictedRoleIds || []).map((id) => text(id, 64)).filter(Boolean))).slice(0, 20);
  }
  if (patch.channelIds !== undefined) {
    next.channelIds = Array.from(new Set((patch.channelIds || []).map((id) => text(id, 64)).filter(Boolean))).slice(0, 20);
  }
  if (patch.name !== undefined) {
    const nextName = normalizeTagName(patch.name);
    if (!nextName) return { ok: false, error: 'That name cannot be used.' };
    if (nextName !== tag.name) {
      const reserved = reservedReason(nextName);
      if (reserved) return { ok: false, error: reserved };
      const taken = findTag(all, serverId, nextName);
      if (taken && taken.id !== tag.id) return { ok: false, error: `A tag called \`${nextName}\` already exists.` };
    }
    next.name = nextName;
    // An alias equal to the new name would be redundant.
    next.aliases = tag.aliases.filter((alias) => alias !== nextName);
  }
  if (!next.content && !next.embed) return { ok: false, error: 'A tag needs content or an embed.' };

  next.updatedAt = Date.now();
  Object.assign(tag, next);
  store.write(all);
  auditTag(serverId, actor, patch.name !== undefined ? 'rename' : 'edit', tag.name);
  return { ok: true, tag };
}

export function addTagAlias(serverId: string, name: string, alias: string, actor: TagActor = 'command'): TagResult {
  const aliasName = normalizeTagName(alias);
  if (!aliasName) return { ok: false, error: 'That alias cannot be used.' };
  const reserved = reservedReason(aliasName);
  if (reserved) return { ok: false, error: reserved };
  if (getTag(serverId, aliasName)) return { ok: false, error: `\`${aliasName}\` is already taken.` };

  const all = store.read();
  const tag = findTag(all, serverId, name);
  if (!tag) return { ok: false, error: `No tag called \`${name}\`.` };
  if (tag.aliases.length >= 10) return { ok: false, error: 'A tag can have at most 10 aliases.' };

  tag.aliases = [...tag.aliases, aliasName];
  tag.updatedAt = Date.now();
  store.write(all);
  auditTag(serverId, actor, 'alias.add', `${tag.name} ← ${aliasName}`);
  return { ok: true, tag };
}

export function removeTagAlias(serverId: string, alias: string, actor: TagActor = 'command'): TagResult {
  const aliasName = normalizeTagName(alias);
  const all = store.read();
  const tag = all.find((entry) => entry.serverId === serverId && entry.aliases.includes(aliasName));
  if (!tag) return { ok: false, error: `No alias called \`${alias}\`.` };
  tag.aliases = tag.aliases.filter((entry) => entry !== aliasName);
  tag.updatedAt = Date.now();
  store.write(all);
  auditTag(serverId, actor, 'alias.remove', `${tag.name} ← ${aliasName}`);
  return { ok: true, tag };
}

/** Delete a tag by its name or one of its aliases. */
export function deleteTag(serverId: string, name: string, actor: TagActor = 'command'): boolean {
  const all = store.read();
  const tag = findTag(all, serverId, name);
  if (!tag) return false;
  store.write(all.filter((entry) => entry.id !== tag.id));
  auditTag(serverId, actor, 'delete', tag.name);
  return true;
}

function bumpUses(tag: Tag) {
  const all = store.read();
  const stored = all.find((entry) => entry.id === tag.id);
  if (!stored) return;
  stored.uses++;
  store.write(all);
}

// ---- Rendering -------------------------------------------------------------

export type TagContext = {
  userName: string;
  userId: string;
  serverName: string;
  channelId: string;
  memberCount?: number;
  /** Everything typed after the tag name. */
  args: string;
};

/** Fill the placeholders a tag body may use. */
export function renderTag(template: string, ctx: TagContext): string {
  return String(template || '')
    .replace(/\{user\}/g, ctx.userName)
    .replace(/\{mention\}/g, `<@${ctx.userId}>`)
    .replace(/\{server\}/g, ctx.serverName)
    .replace(/\{channel\}/g, `<#${ctx.channelId}>`)
    .replace(/\{count\}/g, String(ctx.memberCount ?? ''))
    .replace(/\{args\}/g, ctx.args)
    .slice(0, MAX_TAG_CONTENT);
}

/**
 * The text typed after the tag name, with its line breaks kept. The dispatcher
 * splits arguments on whitespace, which would flatten a multi-line `{args}`.
 */
function rawArgs(message: any, commandName: string, args: string[]): string {
  const content = String(message?.content || '');
  const prefix = String(config.prefix || '');
  if (!content.startsWith(prefix)) return args.join(' ');
  const rest = content.slice(prefix.length).replace(/^\s+/, '');
  if (!rest.toLowerCase().startsWith(commandName.toLowerCase())) return args.join(' ');
  return rest.slice(commandName.length).trim();
}

export type TagInvocation =
  | { status: 'sent' }
  | { status: 'miss' }
  | { status: 'denied'; reason: string };

/**
 * Try to answer a message with a tag. Called by the command dispatcher only
 * after every built-in command has been ruled out.
 */
export async function runTag(message: any, commandName: string, args: string[], client: any): Promise<TagInvocation> {
  const serverId = String(message?.channel?.serverId || message?.serverId || '');
  if (!serverId) return { status: 'miss' };

  const tag = getTag(serverId, commandName);
  if (!tag) return { status: 'miss' };

  const channelId = String(message?.channelId || message?.channel?.id || '');
  if (tag.channelIds.length && !tag.channelIds.includes(channelId)) {
    return { status: 'denied', reason: 'That tag is not available in this channel.' };
  }

  if (tag.restrictedRoleIds.length) {
    const server = client?.servers?.cache?.get?.(serverId);
    const member =
      message?.member || server?.members?.cache?.get?.(message?.authorId) ||
      (await server?.members?.fetch?.(message?.authorId).catch(() => null));
    const roleIds = new Set(getRoleIds(member?.roles ?? member?.roleIds));
    if (!tag.restrictedRoleIds.some((roleId) => roleIds.has(roleId))) {
      return { status: 'denied', reason: 'Your roles cannot use that tag.' };
    }
  }

  const server = client?.servers?.cache?.get?.(serverId);
  const authorName = message?.member?.nickname || message?.author?.username || 'there';
  // What a member typed (their name, the words after the tag) is inserted with
  // mass mentions defused: `!say {args}` must not become a way to ping everyone
  // with the bot's permissions.
  const ctx: TagContext = {
    userName: neutraliseMentions(authorName),
    userId: String(message?.authorId || ''),
    serverName: String(server?.name || 'this server'),
    channelId,
    memberCount: server?.members?.cache?.size,
    args: neutraliseMentions(rawArgs(message, commandName, args)).slice(0, 500),
  };

  const payload: any = {};
  if (tag.content) payload.content = clampText(renderTag(tag.content, ctx), MESSAGE_CONTENT_MAX);
  if (tag.embed && (tag.embed.title || tag.embed.description)) {
    payload.embeds = [
      safeEmbed({
        title: tag.embed.title ? renderTag(tag.embed.title, ctx) : '',
        description: tag.embed.description ? renderTag(tag.embed.description, ctx) : '',
        color: tag.embed.color,
        url: tag.embed.url,
      }),
    ];
  }
  if (!payload.content && !payload.embeds) return { status: 'miss' };

  await message.channel?.send(payload);
  bumpUses(tag);
  return { status: 'sent' };
}

export function getTagSummary(serverId = config.serverId || '') {
  const tags = listTags(serverId);
  return {
    total: tags.length,
    uses: tags.reduce((sum, tag) => sum + tag.uses, 0),
    top: [...tags].sort((a, b) => b.uses - a.uses).slice(0, 5).map((tag) => ({ name: tag.name, uses: tag.uses })),
  };
}
