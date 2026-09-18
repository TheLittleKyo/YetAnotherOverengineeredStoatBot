import { config } from '../config.js';
import { canManageServerById, requirePermissionForChannel } from '../permissions.js';
import {
  addSyncLink,
  copyChannelContent,
  emptySyncFilters,
  hasSyncFilters,
  listSyncLinks,
  normalizeFilterEntries,
  removeSyncLink,
  resolveSyncLinks,
  setSyncLinkFilters,
  SYNC_FILTER_KINDS,
  SYNC_FILTER_MAX_ENTRIES,
  type SyncFilterKind,
  type SyncFilters,
  type SyncLink,
} from '../sync.js';
import { normalizeId, normalizeMentionOrId } from '../id-utils.js';
import { sendChunks, syncDebugCommand } from './sync-debug.js';

/**
 * `sync` command — copy channel content and manage live channel-to-channel
 * sync links, within one server or across two servers.
 *
 *   sync copy <source> <target>          One-shot copy of all messages.
 *   sync link <source> <target> [--twoway]  Live-mirror new messages, and
 *                                        follow their later edits/deletes.
 *   sync unlink <linkId|channelId>       Remove a live link.
 *   sync list                            Show active live links.
 *   sync filter <link> ...               Allow / deny lists for a link.
 *   sync debug <subcommand>              Diagnostics — see sync-debug.ts.
 *
 * Channel arguments accept a raw ID or a <#channel> mention.
 */
export async function syncCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  // Diagnostics live in their own module; it runs its own permission check.
  if (sub === 'debug' || sub === 'diag') {
    await syncDebugCommand(message, args, client);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({
      content: 'You need Manage Server permission to copy or sync channels.',
    });
    return;
  }

  if (sub === 'copy' || sub === 'clone') {
    const source = normalizeMentionOrId(args[0]);
    const target = normalizeMentionOrId(args[1]);
    if (!source || !target) {
      await sendHelp(message, 'Usage: `sync copy <sourceChannel> <targetChannel>`');
      return;
    }

    // Both endpoints can live in other servers, so authorize in each channel's
    // own server — Manage Server here would otherwise be enough to siphon a
    // private channel out of any server the bot has joined.
    if (!(await requirePermissionForChannel(message, client, source, ['ManageServer'], 'Manage Server'))) return;
    if (!(await requirePermissionForChannel(message, client, target, ['ManageServer'], 'Manage Server'))) return;

    await message.channel?.send({
      content: `Copying messages from \`${source}\` to \`${target}\`... this can take a while for busy channels.`,
    });

    const summary = await copyChannelContent(client, source, target);
    await message.channel?.send({
      content:
        `# Channel Copy Complete\n\n` +
        `Source: \`${summary.sourceChannelId}\`\n` +
        `Target: \`${summary.targetChannelId}\`\n` +
        `Messages captured: ${summary.captured}\n` +
        `Messages recreated: ${summary.recreated}` +
        formatWarnings(summary.warnings),
    });
    return;
  }

  if (sub === 'link' || sub === 'sync') {
    const source = normalizeMentionOrId(args[0]);
    const target = normalizeMentionOrId(args[1]);
    const twoway = args.some((a) => ['--twoway', '--two-way', '--both'].includes(a.toLowerCase()));
    if (!source || !target) {
      await sendHelp(message, 'Usage: `sync link <sourceChannel> <targetChannel> [--twoway]`');
      return;
    }

    if (!(await requirePermissionForChannel(message, client, source, ['ManageServer'], 'Manage Server'))) return;
    if (!(await requirePermissionForChannel(message, client, target, ['ManageServer'], 'Manage Server'))) return;

    const link = addSyncLink(source, target, twoway ? 'twoway' : 'oneway');
    await message.channel?.send({
      content:
        `# Live Sync Link Created\n\n` +
        `ID: \`${link.id}\`\n` +
        `Source: \`${link.sourceChannelId}\`\n` +
        `Target: \`${link.targetChannelId}\`\n` +
        `Mode: ${link.mode === 'twoway' ? 'two-way (mirror both directions)' : 'one-way (source → target)'}\n\n` +
        `New messages will now be mirrored automatically, and edits or deletes will follow. Use \`${config.prefix}sync copy\` first if you also want existing history copied.`,
    });
    return;
  }

  if (sub === 'unlink' || sub === 'remove' || sub === 'delete') {
    const idOrChannel = normalizeMentionOrId(args[0]) || args[0];
    if (!idOrChannel) {
      await sendHelp(message, 'Usage: `sync unlink <linkId|channelId>`');
      return;
    }
    const removed = removeSyncLink(idOrChannel);
    await message.channel?.send({
      content: removed > 0
        ? `Removed ${removed} sync link(s) matching \`${idOrChannel}\`.`
        : `No sync link found matching \`${idOrChannel}\`.`,
    });
    return;
  }

  if (sub === 'list') {
    const links = listSyncLinks();
    await message.channel?.send({
      content: links.length
        ? `# Active Sync Links\n\n` +
          links
            .map(
              (l) =>
                `- \`${l.id}\` ${l.mode === 'twoway' ? '↔' : '→'} \`${l.sourceChannelId}\` ${l.mode === 'twoway' ? '↔' : '→'} \`${l.targetChannelId}\`` +
                (hasSyncFilters(l.filters) ? ` · filters: ${filterSummary(l.filters!)}` : ''),
            )
            .join('\n')
        : 'No active sync links. Create one with `sync link <source> <target>`.',
    });
    return;
  }

  if (sub === 'filter' || sub === 'filters') {
    await runFilter(message, client, args);
    return;
  }

  // `sync whitelist <link> word hello` is `sync filter <link> allow word hello`.
  const side = FILTER_SIDES[sub];
  if (side) {
    await runFilter(message, client, [args[0], side, ...args.slice(1)]);
    return;
  }

  await sendHelp(message, `Unknown sync subcommand: \`${sub}\`.`);
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# Sync Commands\n\n` +
      `- \`${config.prefix}sync copy <source> <target>\` - Copy every message from one channel into another (same or different server)\n` +
      `- \`${config.prefix}sync link <source> <target> [--twoway]\` - Live-mirror new messages, edits and deletes between two channels\n` +
      `- \`${config.prefix}sync unlink <linkId|channelId>\` - Stop a live link\n` +
      `- \`${config.prefix}sync list\` - Show active live links\n` +
      `- \`${config.prefix}sync filter <linkId>\` - Allow / deny lists (users, roles, words) for a link — run it for details\n` +
      `- \`${config.prefix}sync debug\` - Diagnostics: status, scan for drift, trace, probe, and more\n\n` +
      `Channels accept a raw ID or a #channel mention. For cross-server use, the bot must be a member of both servers with Send Messages + Masquerade permission in the target channel.`,
  });
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}

// ============================================================
// Filters
// ============================================================

const FILTER_SIDES: Record<string, 'allow' | 'deny'> = {
  allow: 'allow',
  allowlist: 'allow',
  whitelist: 'allow',
  wl: 'allow',
  deny: 'deny',
  denylist: 'deny',
  blacklist: 'deny',
  bl: 'deny',
  block: 'deny',
};

const FILTER_KIND_ALIASES: Record<string, SyncFilterKind> = {
  user: 'users',
  users: 'users',
  member: 'users',
  members: 'users',
  role: 'roles',
  roles: 'roles',
  word: 'words',
  words: 'words',
  phrase: 'words',
  phrases: 'words',
};

const KIND_LABELS: Record<SyncFilterKind, string> = { users: 'Users', roles: 'Roles', words: 'Words' };

/**
 *   sync filter <link>                                          show
 *   sync filter <link> allow|deny user|role|word <values…>      add
 *   sync filter <link> remove allow|deny user|role|word <values…>
 *   sync filter <link> clear [allow|deny] [user|role|word]
 */
async function runFilter(message: any, client: any, args: string[]) {
  const needle = normalizeMentionOrId(args[0]) || String(args[0] || '').trim();
  if (!needle) {
    await sendFilterHelp(message);
    return;
  }

  const matches = resolveSyncLinks(needle);
  if (matches.length === 0) {
    await message.channel?.send({ content: `No sync link found matching \`${needle}\`. See \`${config.prefix}sync list\`.` });
    return;
  }
  // A channel id can touch several links; filters are per link, so ask for one.
  if (matches.length > 1) {
    await message.channel?.send({
      content: `\`${needle}\` is part of ${matches.length} links. Use a link ID:\n` +
        matches.map((l) => `- \`${l.id}\`${l.label ? ` (${l.label})` : ''}`).join('\n'),
    });
    return;
  }
  const link = matches[0];

  const action = String(args[1] || '').toLowerCase();
  if (!action || action === 'show' || action === 'list') {
    await sendChunks(message, formatFilters(link));
    return;
  }

  // Filters decide what leaves either channel, so the same rule as creating the
  // link applies: Manage Server in both channels' servers.
  if (!(await requirePermissionForChannel(message, client, link.sourceChannelId, ['ManageServer'], 'Manage Server'))) return;
  if (!(await requirePermissionForChannel(message, client, link.targetChannelId, ['ManageServer'], 'Manage Server'))) return;

  const filters: SyncFilters = link.filters ? structuredClone(link.filters) : emptySyncFilters();

  if (action === 'clear' || action === 'reset') {
    const side = FILTER_SIDES[String(args[2] || '').toLowerCase()];
    const kind = FILTER_KIND_ALIASES[String(args[side ? 3 : 2] || '').toLowerCase()];
    for (const s of side ? [side] : (['allow', 'deny'] as const)) {
      for (const k of kind ? [kind] : SYNC_FILTER_KINDS) filters[s][k] = [];
    }
    const updated = setSyncLinkFilters(link.id, filters);
    await message.channel?.send({
      content: `Cleared ${kind ? KIND_LABELS[kind].toLowerCase() : 'all entries'} on the ${side || 'allow and deny'} list${side ? '' : 's'} of \`${link.id}\`.` +
        (updated && hasSyncFilters(updated.filters) ? '' : ' The link now mirrors everything.'),
    });
    return;
  }

  const removing = action === 'remove' || action === 'rm' || action === 'del';
  const side = FILTER_SIDES[String(args[removing ? 2 : 1] || '').toLowerCase()];
  const kind = FILTER_KIND_ALIASES[String(args[removing ? 3 : 2] || '').toLowerCase()];
  if (!side || !kind) {
    await sendFilterHelp(message, `Unknown filter command. Expected \`allow\`, \`deny\`, \`remove\` or \`clear\`, then \`user\`, \`role\` or \`word\`.`);
    return;
  }

  const { values, invalid } = parseFilterValues(kind, args.slice(removing ? 4 : 3));
  if (values.length === 0) {
    await sendFilterHelp(message, invalid.length
      ? `Not a valid ${kind.slice(0, -1)} ID: ${invalid.map((v) => `\`${v}\``).join(', ')}`
      : `Give at least one ${kind.slice(0, -1)} to ${removing ? 'remove' : 'add'}.`);
    return;
  }

  const current = filters[side][kind];
  let changed: string[];
  if (removing) {
    const drop = new Set(values.map((v) => filterKey(kind, v)));
    changed = current.filter((v) => drop.has(filterKey(kind, v)));
    filters[side][kind] = current.filter((v) => !drop.has(filterKey(kind, v)));
  } else {
    const have = new Set(current.map((v) => filterKey(kind, v)));
    changed = values.filter((v) => !have.has(filterKey(kind, v)));
    filters[side][kind] = normalizeFilterEntries(kind, [...current, ...changed]);
    // Anything past the cap was dropped by the normalizer.
    changed = changed.filter((v) => filters[side][kind].some((kept) => filterKey(kind, kept) === filterKey(kind, v)));
  }

  setSyncLinkFilters(link.id, filters);

  const listName = `${side} list`;
  const lines = [
    removing
      ? `Removed ${changed.length} ${kind} from the ${listName} of \`${link.id}\`.`
      : `Added ${changed.length} ${kind} to the ${listName} of \`${link.id}\`.`,
  ];
  if (changed.length > 0) lines.push(changed.map((v) => formatEntry(kind, v)).join(', '));
  const unchanged = values.length - changed.length;
  if (unchanged > 0) {
    lines.push(removing
      ? `${unchanged} were not on the list.`
      : filters[side][kind].length >= SYNC_FILTER_MAX_ENTRIES
        ? `${unchanged} skipped — already listed, or the list is full (${SYNC_FILTER_MAX_ENTRIES} max).`
        : `${unchanged} were already listed.`);
  }
  if (invalid.length > 0) lines.push(`Ignored (not an ID): ${invalid.map((v) => `\`${v}\``).join(', ')}`);
  lines.push(`Run \`${config.prefix}sync debug scan ${link.id}\` to find copies already posted that the filters now block.`);
  await message.channel?.send({ content: lines.join('\n') });
}

/**
 * Ids come one per argument (mentions welcome, commas tolerated). Words are
 * split on spaces, with quotes keeping a phrase together: `"free nitro" spam`.
 */
function parseFilterValues(kind: SyncFilterKind, args: string[]): { values: string[]; invalid: string[] } {
  const invalid: string[] = [];
  if (kind === 'words') {
    const text = args.join(' ');
    const values: string[] = [];
    for (const match of text.matchAll(/["“”]([^"“”]+)["“”]|'([^']+)'|(\S+)/g)) {
      const value = (match[1] ?? match[2] ?? match[3] ?? '').replace(/^,+|,+$/g, '').trim();
      if (value) values.push(value);
    }
    return { values: normalizeFilterEntries('words', values), invalid };
  }

  const values: string[] = [];
  for (const raw of args.flatMap((arg) => arg.split(','))) {
    if (!raw.trim()) continue;
    const id = normalizeId(raw);
    if (id) values.push(id);
    else invalid.push(raw.trim());
  }
  return { values: normalizeFilterEntries(kind, values), invalid };
}

function filterKey(kind: SyncFilterKind, value: string) {
  return kind === 'words' ? value.toLowerCase() : value;
}

// Ids are shown in code spans rather than as mentions so listing a filter never
// pings the people on it.
function formatEntry(kind: SyncFilterKind, value: string) {
  return kind === 'words' ? `"${value}"` : `\`${value}\``;
}

function filterSummary(filters: SyncFilters) {
  const count = (side: 'allow' | 'deny') => SYNC_FILTER_KINDS.reduce((sum, kind) => sum + filters[side][kind].length, 0);
  return `${count('allow')} allow, ${count('deny')} deny`;
}

function formatFilters(link: SyncLink) {
  const filters = link.filters || emptySyncFilters();
  const lines = [
    `# Filters — \`${link.id}\`${link.label ? ` (${link.label})` : ''}`,
    `\`${link.sourceChannelId}\` ${link.mode === 'twoway' ? '↔' : '→'} \`${link.targetChannelId}\``,
    '',
  ];

  for (const side of ['allow', 'deny'] as const) {
    lines.push(side === 'allow' ? '## Allow list' : '## Deny list');
    for (const kind of SYNC_FILTER_KINDS) {
      const entries = filters[side][kind];
      lines.push(`- ${KIND_LABELS[kind]}: ${entries.length ? entries.map((v) => formatEntry(kind, v)).join(', ') : '*none*'}`);
    }
    lines.push('');
  }

  lines.push(
    hasSyncFilters(link.filters)
      ? 'Deny wins. Allowed users and roles: only they are mirrored. Allowed words: a message must contain one.'
      : 'No filters — every message is mirrored.',
    `Change with \`${config.prefix}sync filter ${link.id} allow|deny|remove|clear ...\` — \`${config.prefix}sync filter\` for help.`,
  );
  return lines.join('\n');
}

async function sendFilterHelp(message: any, error?: string) {
  const p = config.prefix;
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# Sync Filters\n\n` +
      `- \`${p}sync filter <linkId>\` - Show a link's allow and deny lists\n` +
      `- \`${p}sync filter <linkId> allow <user|role|word> <values…>\` - Add to the allow list (whitelist)\n` +
      `- \`${p}sync filter <linkId> deny <user|role|word> <values…>\` - Add to the deny list (blacklist)\n` +
      `- \`${p}sync filter <linkId> remove <allow|deny> <user|role|word> <values…>\` - Take entries off a list\n` +
      `- \`${p}sync filter <linkId> clear [allow|deny] [user|role|word]\` - Empty lists\n` +
      `- \`${p}sync whitelist|blacklist <linkId> <user|role|word> <values…>\` - Shorthand for allow / deny\n\n` +
      `How they combine:\n` +
      `- Deny wins: a denied user, a member with a denied role, or a message containing a denied word is never mirrored.\n` +
      `- Allowed users and roles: when either is set, only those users or members with one of those roles are mirrored.\n` +
      `- Allowed words: when set, a message must contain at least one.\n\n` +
      `Users and roles accept mentions or IDs. Words match whole words, ignore case, and \`*\` is a wildcard (\`spam*\`); quote a phrase: \`"free nitro"\`. ` +
      `Filters apply to both directions of a two-way link. When an edit makes a mirrored message hit a word filter, its copy is deleted.`,
  });
}

function formatWarnings(warnings: string[]) {
  if (!warnings?.length) return '';
  return `\n\nWarnings:\n${warnings.slice(0, 8).map((w) => `- ${w}`).join('\n')}`;
}
