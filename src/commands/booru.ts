import { MessageEmbed } from 'stoatbot.js';
import { config } from '../config.js';
import { debug } from '../logger.js';
import { requirePermission } from '../permissions.js';
import { escapeLinkText, escapeLinkUrl, neutralizeMentions } from '../music/format.js';
import {
  BOORU_SITES,
  BOORU_SITE_COMMAND_NAMES,
  BooruError,
  MAX_BLACKLIST_TAGS,
  RATING_LABELS,
  downloadPostMedia,
  findBooruSite,
  getBooruSettings,
  isSiteConfigured,
  normalizeBlacklist,
  parseQuery,
  searchBooru,
  updateBooruSettings,
} from '../booru/index.js';
import type { BooruPost, BooruRating, BooruServerSettings, BooruSite } from '../booru/index.js';

/**
 * Booru image search — random posts by tag, like the Danbooru bots on Discord,
 * across a dozen sites.
 *
 * !booru <site> [tags…] [-n 1-5]   — random post(s) from a site
 * !<site> [tags…]                  — shortcut, e.g. !danbooru cat_ears solo
 * !booru sites                     — list sites and their shortcuts
 * !booru settings                  — this server's filters
 * !booru blacklist [add|remove|clear] <tags…>   (Manage Server)
 * !booru enable|disable <site>                  (Manage Server)
 * !booru nsfw on|off                             (Manage Server)
 *
 * Adult results only ever appear in channels marked NSFW; see booru/safety.ts
 * for the channel and file-type filters.
 */

export const BOORU_COMMAND_NAMES = ['booru', 'boorus', ...BOORU_SITE_COMMAND_NAMES];

const MAX_COUNT = 5;
const COOLDOWN_MS = 4_000;
const TAGS_SHOWN = 25;
const DESCRIPTION_LIMIT = 1900;
/** Stoat refuses message content over 2000 characters; this leaves headroom. */
const MESSAGE_LIMIT = 1900;

const RATING_COLORS: Record<BooruRating, string> = {
  general: '#22c55e',
  sensitive: '#eab308',
  questionable: '#f97316',
  explicit: '#ef4444',
};

const p = () => config.prefix;

export const BOORU_HELP_LINES = [
  '`{p}booru <site> [tags…]` - Post a random image from a booru matching the tags',
  '`{p}<site> [tags…]` - Shortcut, e.g. `{p}danbooru cat_ears solo` or `{p}e926 fox`',
  'Add `-n 3` to post up to 5 results. Tags use the site’s own syntax (`-tag` excludes, underscores for spaces).',
  '`{p}booru sites` - Every site and its shortcuts',
  '`{p}booru settings` - This server’s NSFW setting, blacklist and disabled sites',
  '`{p}booru blacklist add|remove <tags…>` / `{p}booru blacklist clear` - Tags never shown in this server (Manage Server)',
  '`{p}booru disable|enable <site>` - Turn a site off or on in this server (Manage Server)',
  '`{p}booru nsfw on|off` - Allow adult results in channels marked NSFW (Manage Server)',
  'Outside NSFW channels only general-rated posts are shown.',
];

const cooldowns = new Map<string, number>();

export async function booruCommand(message, args: string[], client) {
  const [invokedAs, ...rest] = args;
  const name = String(invokedAs || '').toLowerCase();
  if (name !== 'booru' && name !== 'boorus') {
    const direct = findBooruSite(name);
    if (direct) return search(message, direct, rest);
  }

  const sub = String(rest.shift() || '').toLowerCase();
  switch (sub) {
    case '':
    case 'help':
      return send(message, renderHelp());
    case 'sites':
    case 'list':
      for (const part of renderSites(getBooruSettings(serverIdOf(message)))) await send(message, part);
      return;
    case 'settings':
    case 'status':
    case 'config':
      return send(message, renderSettings(message));
    case 'blacklist':
    case 'bl':
      return handleBlacklist(message, rest, client);
    case 'enable':
    case 'disable':
      return handleSiteToggle(message, sub === 'enable', rest, client);
    case 'nsfw':
      return handleNsfw(message, rest, client);
    default: {
      const site = findBooruSite(sub);
      if (site) return search(message, site, rest);
      return send(message, `❌ Unknown site \`${neutralizeMentions(sub.slice(0, 40))}\`. See \`${p()}booru sites\`.`);
    }
  }
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

async function search(message, site: BooruSite, words: string[]) {
  const channel = message.channel;
  if (!channel) return;
  const serverId = serverIdOf(message);
  const settings = getBooruSettings(serverId);

  if (settings.disabledSites.includes(site.id)) {
    return send(message, `❌ ${site.name} is turned off in this server.`);
  }
  if (!isSiteConfigured(site)) {
    return send(message, `❌ ${site.name} only answers with an API account. The bot owner can add one in the dashboard Booru tab.`);
  }

  const nsfwChannel = channel.nsfw === true;
  const safe = site.safeOnly || !(nsfwChannel && settings.nsfw);
  if (site.nsfwOnly && safe) {
    return send(
      message,
      nsfwChannel
        ? `❌ Adult results are turned off in this server, and ${site.name} only hosts adult content.`
        : `❌ ${site.name} only hosts adult content. Use it in a channel marked NSFW.`,
    );
  }

  const { count, rest } = extractCount(words);
  const query = parseQuery(rest, { safe });
  if (query.blockedTag) {
    const where = query.blockedEverywhere ? '' : ' in NSFW channels';
    return send(message, `❌ \`${neutralizeMentions(query.blockedTag)}\` can't be searched${where}.`);
  }

  const userId = String(message.authorId || '');
  const waitMs = (cooldowns.get(userId) ?? 0) - Date.now();
  if (waitMs > 0) {
    return send(message, `⏳ Slow down — try again in ${Math.ceil(waitMs / 1000)}s.`);
  }
  cooldowns.set(userId, Date.now() + COOLDOWN_MS);
  if (cooldowns.size > 500) {
    for (const [id, until] of cooldowns) if (until < Date.now()) cooldowns.delete(id);
  }

  let result;
  try {
    result = await searchBooru(site, { tags: query.tags, safe, count, blacklist: settings.blacklist });
  } catch (error) {
    if (error instanceof BooruError) return send(message, `❌ ${neutralizeMentions(error.message)}`);
    throw error;
  }

  const label = query.tags.length ? `\`${neutralizeMentions(query.tags.join(' '))}\`` : 'anything';
  if (!result.posts.length) {
    const notes = [
      result.hidden ? `${result.hidden} result${result.hidden === 1 ? ' was' : 's were'} hidden by filters.` : '',
      safe && !nsfwChannel && !site.safeOnly ? 'Only general-rated posts are shown outside NSFW channels.' : '',
    ].filter(Boolean);
    return send(message, [`🔍 No results for ${label} on ${site.name}.`, ...notes].join(' '));
  }

  if (query.droppedRating) {
    await send(
      message,
      `ℹ️ Rating tags were ignored: ${site.safeOnly ? `${site.name} only has` : 'this channel only shows'} general-rated posts.`,
    );
  }
  for (const post of result.posts) {
    await sendPost(channel, site, post);
  }
}

/** Pull `-n 3`, `-n=3`, `--count 3` or `--count=3` out of the words. */
export function extractCount(words: string[]): { count: number; rest: string[] } {
  const rest: string[] = [];
  let count = 1;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const inline = word.match(/^(?:-n|--count)=(\d+)$/i);
    if (inline) {
      count = Number(inline[1]);
      continue;
    }
    if (/^(?:-n|--count)$/i.test(word) && /^\d+$/.test(words[i + 1] || '')) {
      count = Number(words[++i]);
      continue;
    }
    rest.push(word);
  }
  return { count: Math.max(1, Math.min(MAX_COUNT, count || 1)), rest };
}

async function sendPost(channel, site: BooruSite, post: BooruPost) {
  const build = (fileNote: string) =>
    new MessageEmbed()
      .setTitle(`${site.name} #${post.id}`.slice(0, 100))
      .setURL(post.postUrl)
      .setColor(RATING_COLORS[post.rating])
      .setDescription(describePost(post, fileNote));

  const media = await downloadPostMedia(site, post).catch((error) => {
    debug('booru:media', () => `${site.id} #${post.id}: ${error?.message || error}`);
    return null;
  });

  if (media) {
    try {
      if (media.isVideo) {
        await channel.send({ embeds: [build('')], attachments: [media.file] });
      } else {
        await channel.send({ embeds: [build('').setMedia(media.file)] });
      }
      return;
    } catch (error) {
      debug('booru:upload', () => `${site.id} #${post.id}: ${error?.message || error}`);
    }
  }

  await channel.send({ embeds: [build('The file could not be uploaded here; use the Original file link.')] });
}

/** Tag or name as readable text: `hatsune_miku` → `hatsune miku`, no markdown or mentions. */
function plain(value: string): string {
  return escapeLinkText(value.replace(/_/g, ' ').replace(/[*~`|\\$]/g, ''));
}

function nameList(values: string[], max: number): string {
  const shown = values.slice(0, max).map(plain).join(', ');
  return values.length > max ? `${shown} +${values.length - max} more` : shown;
}

export function describePost(post: BooruPost, fileNote = ''): string {
  const lines: string[] = [];
  if (post.artists.length) lines.push(`**Artist:** ${nameList(post.artists, 3)}`);
  if (post.characters.length) lines.push(`**Characters:** ${nameList(post.characters, 4)}`);
  if (post.copyrights.length) lines.push(`**Series:** ${nameList(post.copyrights, 3)}`);
  lines.push(
    `**Rating:** ${RATING_LABELS[post.rating]}${post.score === null ? '' : ` · **Score:** ${post.score}`}`,
  );

  const links = [
    post.source ? `[Source](${escapeLinkUrl(post.source)})` : '',
    `[Original file](${escapeLinkUrl(post.fileUrl)})`,
  ].filter(Boolean);
  const footer = [links.join(' · '), fileNote].filter(Boolean).join('\n');

  // Tags fill whatever room the rest leaves.
  const named = new Set([...post.artists, ...post.characters, ...post.copyrights]);
  const general = post.tags.filter((tag) => !named.has(tag));
  let budget = DESCRIPTION_LIMIT - lines.join('\n').length - footer.length - 40;
  const shown: string[] = [];
  for (const tag of general.slice(0, TAGS_SHOWN)) {
    const chip = `\`${neutralizeMentions(tag)}\``;
    if (chip.length + 1 > budget) break;
    budget -= chip.length + 1;
    shown.push(chip);
  }
  if (shown.length) {
    const more = general.length - shown.length;
    lines.push(`**Tags:** ${shown.join(' ')}${more > 0 ? ` +${more} more` : ''}`);
  }

  return [lines.join('\n'), footer].join('\n\n').slice(0, 2000);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function requireManage(message, client): Promise<string | null> {
  const serverId = serverIdOf(message);
  if (!serverId) {
    await send(message, '❌ Booru settings can only be changed in a server.');
    return null;
  }
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return null;
  return serverId;
}

async function handleBlacklist(message, args: string[], client) {
  const action = String(args.shift() || 'list').toLowerCase();
  const serverId = serverIdOf(message);

  if (action === 'list' || action === 'show') {
    const { blacklist } = getBooruSettings(serverId);
    return send(
      message,
      blacklist.length
        ? `# Booru blacklist (${blacklist.length})\n${renderTagChips(blacklist)}`
        : `The blacklist is empty. Add tags with \`${p()}booru blacklist add <tags…>\`.`,
    );
  }

  if (!['add', 'remove', 'rm', 'delete', 'clear'].includes(action)) {
    return send(message, `Usage: \`${p()}booru blacklist [add|remove|clear] <tags…>\``);
  }

  const managedServerId = await requireManage(message, client);
  if (!managedServerId) return;

  if (action === 'clear') {
    updateBooruSettings(managedServerId, () => ({ blacklist: [] }));
    return send(message, '✅ Cleared the booru blacklist.');
  }

  const tags = normalizeBlacklist(args);
  if (!tags.length) {
    return send(message, `Usage: \`${p()}booru blacklist ${action} <tags…>\``);
  }

  if (action === 'add') {
    const before = getBooruSettings(managedServerId).blacklist;
    const next = updateBooruSettings(managedServerId, (current) => ({ blacklist: [...current.blacklist, ...tags] }));
    const added = next.blacklist.length - before.length;
    const capped = added < tags.filter((tag) => !before.includes(tag)).length;
    return send(
      message,
      `✅ Blacklisted ${added} tag${added === 1 ? '' : 's'} (${next.blacklist.length} total).` +
        (capped ? ` The blacklist holds at most ${MAX_BLACKLIST_TAGS} tags.` : ''),
    );
  }

  const next = updateBooruSettings(managedServerId, (current) => ({
    blacklist: current.blacklist.filter((tag) => !tags.includes(tag)),
  }));
  return send(message, `✅ Removed from the blacklist. ${next.blacklist.length} tag${next.blacklist.length === 1 ? '' : 's'} left.`);
}

async function handleSiteToggle(message, enable: boolean, args: string[], client) {
  const site = findBooruSite(args[0] || '');
  if (!site) {
    return send(message, `Usage: \`${p()}booru ${enable ? 'enable' : 'disable'} <site>\`. See \`${p()}booru sites\`.`);
  }
  const serverId = await requireManage(message, client);
  if (!serverId) return;
  updateBooruSettings(serverId, (current) => ({
    disabledSites: enable
      ? current.disabledSites.filter((id) => id !== site.id)
      : [...current.disabledSites, site.id],
  }));
  return send(message, `✅ ${site.name} is now ${enable ? 'on' : 'off'} in this server.`);
}

async function handleNsfw(message, args: string[], client) {
  const value = String(args[0] || '').toLowerCase();
  if (!['on', 'off', 'enable', 'disable', 'true', 'false'].includes(value)) {
    return send(message, `Usage: \`${p()}booru nsfw on|off\``);
  }
  const serverId = await requireManage(message, client);
  if (!serverId) return;
  const nsfw = value === 'on' || value === 'enable' || value === 'true';
  updateBooruSettings(serverId, () => ({ nsfw }));
  return send(
    message,
    nsfw
      ? '✅ Adult results are allowed again, in channels marked NSFW only.'
      : '✅ Adult results are off. Every channel now gets general-rated posts only.',
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHelp(): string {
  return `# 🖼️ Booru image search\n\n${BOORU_HELP_LINES.map((line) => `• ${line.replaceAll('{p}', p())}`).join('\n')}`;
}

/** The site list, split into messages under Stoat's 2000-character limit. */
export function renderSites(settings: BooruServerSettings): string[] {
  const lines = BOORU_SITES.map((site) => {
    const names = [site.id, ...site.aliases].map((name) => `\`${name}\``).join(' ');
    const flags = [
      site.nsfwOnly ? 'NSFW channels only' : '',
      isSiteConfigured(site) ? '' : 'needs an account in the dashboard Booru tab',
      settings.disabledSites.includes(site.id) ? 'off in this server' : '',
    ].filter(Boolean);
    return `• **${site.name}** ${names} - ${site.description}${flags.length ? ` *(${flags.join(', ')})*` : ''}`;
  });
  const all = [
    '# 🖼️ Booru sites\n',
    ...lines,
    `\nUse \`${p()}booru <site> [tags…]\` or the shortcut directly, e.g. \`${p()}danbooru cat_ears\`.`,
  ];
  const parts: string[] = [];
  let current = '';
  for (const line of all) {
    if (current && current.length + 1 + line.length > MESSAGE_LIMIT) {
      parts.push(current);
      current = line;
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) parts.push(current);
  return parts;
}

function renderSettings(message): string {
  const serverId = serverIdOf(message);
  const settings = getBooruSettings(serverId);
  const nsfwChannel = message.channel?.nsfw === true;
  const disabled = settings.disabledSites.map((id) => findBooruSite(id)?.name || id);
  return [
    '# 🖼️ Booru settings',
    `**Adult results:** ${settings.nsfw ? 'allowed in channels marked NSFW' : 'off in every channel'}`,
    `**This channel:** ${nsfwChannel && settings.nsfw ? 'NSFW, all ratings' : 'general-rated posts only'}`,
    `**Blacklist:** ${settings.blacklist.length ? `${settings.blacklist.length} tag(s)\n${renderTagChips(settings.blacklist)}` : 'empty'}`,
    `**Disabled sites:** ${disabled.length ? disabled.join(', ') : 'none'}`,
  ].join('\n');
}

function renderTagChips(tags: string[]): string {
  const chips: string[] = [];
  let length = 0;
  for (const tag of tags) {
    const chip = `\`${neutralizeMentions(tag)}\``;
    if (length + chip.length > 1500) {
      chips.push(`+${tags.length - chips.length} more`);
      break;
    }
    length += chip.length + 1;
    chips.push(chip);
  }
  return chips.join(' ');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The server a message was sent in, or '' for DMs and groups. */
function serverIdOf(message): string {
  try {
    return String(message?.channel?.serverId || '');
  } catch {
    return '';
  }
}

function send(message, content: string) {
  return message.channel?.send({ content });
}
