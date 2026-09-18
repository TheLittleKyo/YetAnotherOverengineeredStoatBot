/**
 * Automod — content filtering on every message, with the punishment handed to
 * the moderation case system so an automatic mute looks the same in a member's
 * history as one a moderator typed.
 *
 * Antiraid already guards the *door* (join floods, young accounts, honeypot);
 * this guards what gets *said*. The two are deliberately separate: a raid is a
 * burst of accounts, a filter hit is one message.
 *
 * Each rule is one check with its own action, scope, and exemptions:
 *
 *   words       banned words / phrases, with `*` wildcards
 *   invites     server invite links
 *   links       any URL, minus an allow-list of domains
 *   mentions    more than N mentions in one message
 *   spam        more than N messages from one member within a window
 *   duplicates  the same message repeated N times within a window
 *   caps        more than N% capital letters (ignores short messages)
 *   emoji       more than N emoji in one message
 *   newlines    more than N line breaks in one message
 *   zalgo       stacked combining marks
 *   attachments more than N attachments in one message
 *
 * Rules are evaluated in order and the first hit wins, so a message is never
 * punished twice for one send. Staff exemptions apply to every rule — a
 * moderator pasting a link must not trip their own filter — while a rule's own
 * exempt roles skip only that rule, so later rules still see the message.
 *
 * Storage: `data/automod.json`, keyed by server.
 */

import { config } from './config.js';
import { dataFile, readJson, registerDataFileHooks, writeJson } from './json-store.js';
import { getRoleIds } from './member-utils.js';
import { sendServerLog } from './log-system.js';
import { runModAction, type ModActionType } from './moderation.js';
import { recordAudit } from './audit.js';
import { debug } from './logger.js';

export type AutomodRuleType =
  | 'words'
  | 'invites'
  | 'links'
  | 'mentions'
  | 'spam'
  | 'duplicates'
  | 'caps'
  | 'emoji'
  | 'newlines'
  | 'zalgo'
  | 'attachments';

/** `delete` only removes the message; the rest also raise a moderation case. */
export type AutomodAction = 'delete' | 'warn' | 'mute' | 'kick' | 'ban';

export type AutomodRule = {
  id: string;
  name: string;
  type: AutomodRuleType;
  enabled: boolean;
  action: AutomodAction;
  /** Remove the offending message. On by default for every action. */
  deleteMessage: boolean;
  /** Mute / ban length in milliseconds; null for permanent. */
  durationMs: number | null;
  /** `words`: banned terms, `*` matches any run of characters. */
  words: string[];
  /** `words`: match whole words only, so "ass" does not hit "class". */
  wholeWord: boolean;
  /** `links`: domains that are always allowed. */
  allowedDomains: string[];
  /** Count / percentage the rule trips at (per type). */
  threshold: number;
  /** `spam` and `duplicates`: the window the threshold is counted over. */
  windowSec: number;
  /** Empty means every channel. */
  channelIds: string[];
  exemptChannelIds: string[];
  exemptRoleIds: string[];
  /** Times this rule has fired, for the dashboard. */
  hits: number;
};

export type AutomodConfig = {
  enabled: boolean;
  /** Tell the member in the channel why their message went (auto-deleted note). */
  notifyChannel: boolean;
  /** Where hits are reported; null falls back to the server log channel. */
  logChannelId: string | null;
  /** Roles exempt from every rule (staff). */
  exemptRoleIds: string[];
  /** Channels exempt from every rule. */
  exemptChannelIds: string[];
  /** Members holding any of these Stoat permissions are never filtered. */
  exemptStaffPermissions: boolean;
};

type ServerState = {
  config: AutomodConfig;
  rules: AutomodRule[];
};

type AutomodStore = {
  version: 1;
  servers: Record<string, ServerState>;
};

const AUTOMOD_FILE = dataFile('automod.json');

// Members holding any of these are treated as staff when the option is on.
const STAFF_PERMISSIONS = ['ManageServer', 'ManageMessages', 'ManageChannel', 'KickMembers', 'BanMembers'];

// How long the channel notice ("message removed") stays before it is deleted.
const NOTICE_LIFETIME_MS = 8000;

let store: AutomodStore | null = null;

// Rolling per-member message history for the spam / duplicate rules. Keyed
// `${serverId}:${userId}`; entries older than the widest window are dropped on
// each look, so this cannot grow without bound.
const recentMessages = new Map<string, { at: number; text: string }[]>();
const MAX_HISTORY_MS = 120_000;

export function defaultAutomodConfig(): AutomodConfig {
  return {
    enabled: false,
    notifyChannel: true,
    logChannelId: null,
    exemptRoleIds: [],
    exemptChannelIds: [],
    exemptStaffPermissions: true,
  };
}

function emptyStore(): AutomodStore {
  return { version: 1, servers: {} };
}

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function idList(value: any, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((entry: any) => text(entry, 64)).filter(Boolean))).slice(0, max);
}

const RULE_TYPES: AutomodRuleType[] = [
  'words', 'invites', 'links', 'mentions', 'spam', 'duplicates', 'caps', 'emoji', 'newlines', 'zalgo', 'attachments',
];

const ACTIONS: AutomodAction[] = ['delete', 'warn', 'mute', 'kick', 'ban'];

/** Sensible starting threshold per rule type, used by new rules and the UI. */
export function defaultThreshold(type: AutomodRuleType): number {
  switch (type) {
    case 'mentions': return 5;
    case 'spam': return 5;
    case 'duplicates': return 3;
    case 'caps': return 70;
    case 'emoji': return 10;
    case 'newlines': return 15;
    case 'attachments': return 5;
    case 'zalgo': return 30;
    default: return 0;
  }
}

function normalizeRule(value: any): AutomodRule | null {
  const type: AutomodRuleType = RULE_TYPES.includes(value?.type) ? value.type : 'words';
  const id = text(value?.id, 40) || `am_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const action: AutomodAction = ACTIONS.includes(value?.action) ? value.action : 'delete';
  return {
    id,
    name: text(value?.name, 60) || describeRuleType(type),
    type,
    enabled: value?.enabled !== false,
    action,
    deleteMessage: value?.deleteMessage !== false,
    durationMs: value?.durationMs == null ? null : Math.max(0, Math.floor(num(value.durationMs, 0))) || null,
    words: Array.isArray(value?.words)
      ? Array.from(new Set(value.words.map((word: any) => text(word, 80).toLowerCase()).filter(Boolean) as string[])).slice(0, 500)
      : [],
    wholeWord: value?.wholeWord !== false,
    allowedDomains: Array.isArray(value?.allowedDomains)
      ? Array.from(new Set(value.allowedDomains.map((domain: any) => text(domain, 120).toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean) as string[])).slice(0, 200)
      : [],
    threshold: Math.max(0, Math.floor(num(value?.threshold, defaultThreshold(type)))),
    windowSec: Math.min(120, Math.max(1, Math.floor(num(value?.windowSec, 10)))),
    channelIds: idList(value?.channelIds),
    exemptChannelIds: idList(value?.exemptChannelIds),
    exemptRoleIds: idList(value?.exemptRoleIds),
    hits: Math.max(0, Math.floor(num(value?.hits, 0))),
  };
}

function normalizeConfig(value: any): AutomodConfig {
  const base = defaultAutomodConfig();
  if (!value || typeof value !== 'object') return base;
  return {
    enabled: value.enabled === true,
    notifyChannel: value.notifyChannel !== false,
    logChannelId: text(value.logChannelId, 64) || null,
    exemptRoleIds: idList(value.exemptRoleIds),
    exemptChannelIds: idList(value.exemptChannelIds),
    exemptStaffPermissions: value.exemptStaffPermissions !== false,
  };
}

function load(): AutomodStore {
  if (store) return store;
  const raw = readJson<any>(AUTOMOD_FILE, emptyStore());
  const next = emptyStore();
  const servers = raw?.servers && typeof raw.servers === 'object' ? raw.servers : {};
  for (const [serverId, state] of Object.entries<any>(servers)) {
    next.servers[serverId] = {
      config: normalizeConfig(state?.config),
      rules: Array.isArray(state?.rules) ? (state.rules.map(normalizeRule).filter(Boolean) as AutomodRule[]) : [],
    };
  }
  store = next;
  return store;
}

function save() {
  if (store) writeJson(AUTOMOD_FILE, store);
}

registerDataFileHooks('automod.json', { reload: () => { store = null; } });

function serverState(serverId: string): ServerState {
  const loaded = load();
  return (loaded.servers[serverId] ||= { config: defaultAutomodConfig(), rules: [] });
}

/** Test hook: drop the in-memory copy so the next read comes from disk. */
export function resetAutomodCache() {
  store = null;
  recentMessages.clear();
}

export function describeRuleType(type: AutomodRuleType): string {
  switch (type) {
    case 'words': return 'Banned words';
    case 'invites': return 'Invite links';
    case 'links': return 'Links';
    case 'mentions': return 'Mass mentions';
    case 'spam': return 'Message spam';
    case 'duplicates': return 'Repeated messages';
    case 'caps': return 'Excessive caps';
    case 'emoji': return 'Emoji spam';
    case 'newlines': return 'Wall of text';
    case 'zalgo': return 'Zalgo text';
    case 'attachments': return 'Attachment spam';
    default: return type;
  }
}

// ---- Config / rule CRUD ----------------------------------------------------

export function getAutomodConfig(serverId = config.serverId || ''): AutomodConfig {
  return { ...serverState(serverId).config };
}

export function setAutomodConfig(patch: Partial<AutomodConfig>, serverId = config.serverId || ''): AutomodConfig {
  const state = serverState(serverId);
  state.config = normalizeConfig({ ...state.config, ...patch });
  save();
  return { ...state.config };
}

export function listAutomodRules(serverId = config.serverId || ''): AutomodRule[] {
  return serverState(serverId).rules.map((rule) => ({ ...rule }));
}

export function addAutomodRule(input: Partial<AutomodRule>, serverId = config.serverId || ''): AutomodRule {
  const state = serverState(serverId);
  const rule = normalizeRule({ ...input, id: undefined }) as AutomodRule;
  state.rules.push(rule);
  save();
  return { ...rule };
}

export function updateAutomodRule(id: string, patch: Partial<AutomodRule>, serverId = config.serverId || ''): AutomodRule | null {
  const state = serverState(serverId);
  const index = state.rules.findIndex((rule) => rule.id === id);
  if (index < 0) return null;
  // The hit counter belongs to the rule, not to whoever edits it: a whole rule
  // sent back from the dashboard must not reset it.
  const { hits: _ignoredHits, ...editable } = patch;
  const merged = normalizeRule({ ...state.rules[index], ...editable, id }) as AutomodRule;
  state.rules[index] = merged;
  save();
  return { ...merged };
}

export function removeAutomodRule(id: string, serverId = config.serverId || ''): boolean {
  const state = serverState(serverId);
  const next = state.rules.filter((rule) => rule.id !== id);
  if (next.length === state.rules.length) return false;
  state.rules = next;
  save();
  return true;
}

// ---- Detection -------------------------------------------------------------

// Stoat's own invite forms (and the Revolt ones it inherited), plus Discord's.
const INVITE_PATTERN =
  /\b(?:(?:app\.|beta\.)?(?:stoat\.chat|revolt\.chat)\/invite|stt\.gg|rvlt\.gg|discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/i;
const URL_PATTERN = /\bhttps?:\/\/([^\s<>]+)/gi;
// User mentions, role mentions, and the two mass mentions.
const MENTION_PATTERN = /<@[A-Za-z0-9_-]+>|<%[A-Za-z0-9_-]+>|@(?:everyone|online)\b/g;
// Combining marks stacked on one base character — the "zalgo" look.
const COMBINING_PATTERN = /[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]/g;
const EMOJI_PATTERN = /(\p{Extended_Pictographic}|:[a-z0-9_]{2,32}:|<[a-z]?:[^:]+:[A-Za-z0-9_-]+>)/giu;

/** Turn a `*`-wildcard term into an anchored regular expression. */
export function wordPatternToRegExp(term: string, wholeWord: boolean): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, (char) => (char === '*' ? '\u0000' : `\\${char}`));
  const body = escaped.split('\u0000').join('[\\s\\S]*');
  return new RegExp(wholeWord ? `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])` : body, 'iu');
}

/** The first banned term a message contains, or null. */
export function matchBannedWord(content: string, words: string[], wholeWord: boolean): string | null {
  // Strip zero-width characters so "b‌a‌d" cannot smuggle a term past the filter.
  const haystack = String(content || '').replace(/[\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g, '');
  for (const word of words) {
    if (!word) continue;
    try {
      if (wordPatternToRegExp(word, wholeWord).test(haystack)) return word;
    } catch {
      // A term that cannot compile is skipped rather than breaking the rule.
    }
  }
  return null;
}

export function capsRatio(content: string): number {
  const letters = String(content || '').replace(/[^\p{L}]/gu, '');
  if (letters.length < 8) return 0; // too short to judge
  const upper = letters.replace(/[^\p{Lu}]/gu, '').length;
  return Math.round((upper / letters.length) * 100);
}

export function countEmoji(content: string): number {
  return (String(content || '').match(EMOJI_PATTERN) || []).length;
}

export function zalgoScore(content: string): number {
  const base = String(content || '').replace(COMBINING_PATTERN, '').length || 1;
  const marks = (String(content || '').match(COMBINING_PATTERN) || []).length;
  return Math.round((marks / base) * 100);
}

/**
 * Host names of every http(s) link in a message. The authority is cut at the
 * first `/`, `?` or `#`; a `user@` prefix is dropped (so `youtube.com@evil.com`
 * reports `evil.com`, not the allow-listed decoy); the port and any trailing
 * punctuation a sentence wrapped around the link are removed.
 */
export function extractDomains(content: string): string[] {
  const out: string[] = [];
  for (const match of String(content || '').matchAll(URL_PATTERN)) {
    let host = String(match[1] || '').toLowerCase().split(/[/?#]/)[0];
    host = host.slice(host.lastIndexOf('@') + 1);
    host = host.replace(/[^a-z0-9-]+$/, '').replace(/:\d*$/, '').replace(/[^a-z0-9-]+$/, '').replace(/^www\./, '');
    if (host.includes('.')) out.push(host);
  }
  return out;
}

function isDomainAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function historyKey(serverId: string, userId: string): string {
  return `${serverId}:${userId}`;
}

let lastHistorySweep = 0;

function pushHistory(serverId: string, userId: string, content: string, now: number) {
  const key = historyKey(serverId, userId);
  const list = recentMessages.get(key) || [];
  list.push({ at: now, text: content.trim().toLowerCase() });
  const cutoff = now - MAX_HISTORY_MS;
  const trimmed = list.filter((entry) => entry.at >= cutoff);
  recentMessages.set(key, trimmed.slice(-40));

  // Members who stopped talking leave an empty-in-effect entry behind; sweep
  // those once a minute so the map tracks only recent authors.
  if (now - lastHistorySweep > 60_000) {
    lastHistorySweep = now;
    for (const [otherKey, entries] of recentMessages) {
      if (!entries.length || entries[entries.length - 1].at < cutoff) recentMessages.delete(otherKey);
    }
  }
}

/**
 * Forget a member's recent messages once a spam or repeat rule has fired, so
 * the burst is punished once rather than again on every message still inside
 * the window.
 */
function clearHistory(serverId: string, userId: string) {
  recentMessages.delete(historyKey(serverId, userId));
}

function historyWithin(serverId: string, userId: string, windowSec: number, now: number) {
  const cutoff = now - windowSec * 1000;
  return (recentMessages.get(historyKey(serverId, userId)) || []).filter((entry) => entry.at >= cutoff);
}

export type RuleHit = { rule: AutomodRule; reason: string };

/**
 * Evaluate one rule against a message. Pure apart from the spam/duplicate
 * history, which the caller has already updated.
 */
function evaluateRule(rule: AutomodRule, ctx: {
  serverId: string;
  userId: string;
  channelId: string;
  content: string;
  attachments: number;
  now: number;
}): string | null {
  switch (rule.type) {
    case 'words': {
      const hit = matchBannedWord(ctx.content, rule.words, rule.wholeWord);
      return hit ? `banned word "${hit}"` : null;
    }
    case 'invites':
      return INVITE_PATTERN.test(ctx.content) ? 'server invite link' : null;
    case 'links': {
      const domains = extractDomains(ctx.content);
      const blocked = domains.find((host) => !isDomainAllowed(host, rule.allowedDomains));
      return blocked ? `link to ${blocked}` : null;
    }
    case 'mentions': {
      const count = (ctx.content.match(MENTION_PATTERN) || []).length;
      return count > rule.threshold ? `${count} mentions (limit ${rule.threshold})` : null;
    }
    case 'spam': {
      const count = historyWithin(ctx.serverId, ctx.userId, rule.windowSec, ctx.now).length;
      return count > rule.threshold ? `${count} messages in ${rule.windowSec}s (limit ${rule.threshold})` : null;
    }
    case 'duplicates': {
      const recent = historyWithin(ctx.serverId, ctx.userId, rule.windowSec, ctx.now);
      const current = ctx.content.trim().toLowerCase();
      if (!current) return null;
      const count = recent.filter((entry) => entry.text === current).length;
      // A threshold below 2 would flag every message as a repeat of itself.
      const limit = Math.max(2, rule.threshold);
      return count >= limit ? `same message ${count}× in ${rule.windowSec}s` : null;
    }
    case 'caps': {
      const ratio = capsRatio(ctx.content);
      return ratio > rule.threshold ? `${ratio}% caps (limit ${rule.threshold}%)` : null;
    }
    case 'emoji': {
      const count = countEmoji(ctx.content);
      return count > rule.threshold ? `${count} emoji (limit ${rule.threshold})` : null;
    }
    case 'newlines': {
      const count = (ctx.content.match(/\n/g) || []).length;
      return count > rule.threshold ? `${count} line breaks (limit ${rule.threshold})` : null;
    }
    case 'zalgo': {
      const score = zalgoScore(ctx.content);
      // A threshold of 0 (rules saved before zalgo had a default) means 30%.
      const limit = rule.threshold > 0 ? rule.threshold : 30;
      return score > limit ? `zalgo text (${score}% combining marks)` : null;
    }
    case 'attachments':
      return ctx.attachments > rule.threshold ? `${ctx.attachments} attachments (limit ${rule.threshold})` : null;
    default:
      return null;
  }
}

// ---- Message handling ------------------------------------------------------

async function resolveAuthorMember(client: any, serverId: string, message: any): Promise<any | null> {
  if (message?.member) return message.member;
  const server = client?.servers?.cache?.get?.(serverId);
  const cached = server?.members?.cache?.get?.(message?.authorId);
  if (cached) return cached;
  if (server?.members?.fetch) return server.members.fetch(message.authorId).catch(() => null);
  return null;
}

/** Server-wide exemptions: the exempt roles and, when on, staff permissions. */
function isGloballyExempt(cfg: AutomodConfig, member: any): boolean {
  if (!member) return false;
  if (cfg.exemptRoleIds.length) {
    const roleIds = getRoleIds(member.roles ?? member.roleIds);
    if (roleIds.some((roleId) => cfg.exemptRoleIds.includes(roleId))) return true;
  }
  if (cfg.exemptStaffPermissions && typeof member.hasPermission === 'function') {
    for (const permission of STAFF_PERMISSIONS) {
      try {
        if (member.hasPermission(permission)) return true;
      } catch {
        // try the next spelling
      }
    }
  }
  return false;
}

/** A rule's own exempt roles: they skip that rule only, not the ones after it. */
function isRuleExempt(rule: AutomodRule, member: any): boolean {
  if (!member || !rule.exemptRoleIds.length) return false;
  const roleIds = getRoleIds(member.roles ?? member.roleIds);
  return roleIds.some((roleId) => rule.exemptRoleIds.includes(roleId));
}

/**
 * Run every enabled rule against a message. Returns true when the message was
 * removed, so the caller can stop processing it.
 */
export async function handleAutomodMessage(client: any, message: any): Promise<boolean> {
  try {
    if (!message || message.author?.bot) return false;
    const serverId = String(message?.channel?.serverId || message?.serverId || '');
    if (!serverId) return false;

    const state = serverState(serverId);
    const cfg = state.config;
    if (!cfg.enabled || state.rules.length === 0) return false;

    const authorId = String(message.authorId || message.author?.id || '');
    if (!authorId || authorId === client?.user?.id) return false;

    const channelId = String(message.channelId || message.channel?.id || '');
    if (cfg.exemptChannelIds.includes(channelId)) return false;

    const content = String(message.content || '');
    const attachments = Array.isArray(message.attachments) ? message.attachments.length : 0;
    const now = Date.now();

    // History is recorded before evaluation so the current message counts
    // toward its own spam/duplicate window.
    pushHistory(serverId, authorId, content, now);

    // The member is looked up only once a rule has actually matched: most
    // messages trip nothing, and they must not cost a member fetch.
    let member: any = undefined;
    const author = async () => {
      if (member === undefined) member = await resolveAuthorMember(client, serverId, message);
      return member;
    };

    for (const rule of state.rules) {
      if (!rule.enabled) continue;
      if (rule.channelIds.length && !rule.channelIds.includes(channelId)) continue;
      if (rule.exemptChannelIds.includes(channelId)) continue;

      const reason = evaluateRule(rule, { serverId, userId: authorId, channelId, content, attachments, now });
      if (!reason) continue;

      const who = await author();
      if (isGloballyExempt(cfg, who)) return false;
      if (isRuleExempt(rule, who)) continue;

      if (rule.type === 'spam' || rule.type === 'duplicates') clearHistory(serverId, authorId);
      await applyRuleHit(client, serverId, message, rule, reason, authorId);
      return rule.deleteMessage;
    }
  } catch (error) {
    debug('automod', () => `message handling failed: ${(error as Error)?.message || error}`);
  }
  return false;
}

async function applyRuleHit(client: any, serverId: string, message: any, rule: AutomodRule, reason: string, authorId: string): Promise<void> {
  const state = serverState(serverId);
  const stored = state.rules.find((entry) => entry.id === rule.id);
  if (stored) {
    stored.hits++;
    save();
  }

  if (rule.deleteMessage) {
    try {
      await message.delete?.();
    } catch (error) {
      debug('automod', () => `delete failed: ${(error as Error)?.message || error}`);
    }
  }

  if (state.config.notifyChannel && message.channel?.send) {
    try {
      const what = rule.deleteMessage ? 'message removed by automod' : 'automod flagged that message';
      const notice = await message.channel.send({
        content: `🛡️ <@${authorId}> — ${what} (${rule.name}).`,
      });
      // The notice is itself noise; clear it shortly after.
      setTimeout(() => {
        void notice?.delete?.().catch(() => {});
      }, NOTICE_LIFETIME_MS).unref?.();
    } catch {
      // A channel the bot cannot post in is not worth failing the action over.
    }
  }

  if (rule.action !== 'delete') {
    await runModAction(client, {
      serverId,
      action: rule.action as ModActionType,
      userId: authorId,
      moderatorId: '',
      reason: `Automod: ${rule.name} — ${reason}`,
      // A mute rule without a length uses the server's default mute length. A
      // permanent automatic mute would need a mute role and is almost never
      // what "mute spammers" means; a ban rule without a length is permanent.
      durationMs: rule.action === 'mute' ? rule.durationMs ?? undefined : rule.durationMs,
      automated: true,
    }).catch((error) => debug('automod', () => `mod action failed: ${error?.message || error}`));
  }

  recordAudit({
    serverId,
    actorId: 'automod',
    actorName: 'Automod',
    source: 'automation',
    area: 'automod',
    action: rule.action,
    detail: `${rule.name}: ${reason}`,
  });

  const description = [
    `**Member:** <@${authorId}>`,
    `**Rule:** ${rule.name} (${describeRuleType(rule.type)})`,
    `**Trigger:** ${reason}`,
    `**Action:** ${rule.action}${rule.deleteMessage ? ' + delete' : ''}`,
    `**Channel:** <#${String(message.channelId || message.channel?.id || '')}>`,
  ].join('\n');

  const logChannelId = state.config.logChannelId;
  if (logChannelId) {
    try {
      const channel = client?.channels?.cache?.get?.(logChannelId) || (await client?.channels?.fetch?.(logChannelId).catch(() => null));
      if (channel?.send) {
        await channel.send({ content: `## 🛡️ Automod\n${description}` });
        return;
      }
    } catch {
      // fall through to the server log
    }
  }
  await sendServerLog(client, { title: 'Automod', description, colour: '#f59e0b' }, serverId).catch(() => {});
}

// ---- Summary ---------------------------------------------------------------

export function getAutomodSummary(serverId = config.serverId || '') {
  const state = serverState(serverId);
  return {
    enabled: state.config.enabled,
    ruleCount: state.rules.length,
    enabledRuleCount: state.rules.filter((rule) => rule.enabled).length,
    totalHits: state.rules.reduce((sum, rule) => sum + rule.hits, 0),
  };
}
