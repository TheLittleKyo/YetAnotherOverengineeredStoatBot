import { config } from '../config.js';
import { normalizeSimpleId } from '../id-utils.js';
import { hasPermission } from '../permissions.js';
import { clampMessage } from '../embed-limits.js';
import {
  addTagAlias,
  createTag,
  deleteTag,
  getTag,
  listTags,
  removeTagAlias,
  updateTag,
} from '../tags.js';

/**
 * `tag` — server-defined canned replies, invoked by name.
 *
 *   tag create <name> <content>
 *   tag edit <name> <content>
 *   tag delete <name>
 *   tag list | tag search <text>
 *   tag info <name> | tag raw <name>
 *   tag alias add <name> <alias> | tag alias remove <alias>
 *   tag restrict <name> <roleId|off>
 *   tag channel <name> <channelId|off>
 *
 * Calling a tag is just `!<name>`; the dispatcher falls through to tags after
 * every built-in command has been ruled out, so a tag can never shadow one.
 */

export async function tagCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();
  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');

  if (!serverId) {
    await message.channel?.send({ content: '❌ Tags only work inside a server.' });
    return;
  }

  switch (sub) {
    case '':
    case 'help':
      return sendHelp(message);

    case 'list':
      return showList(message, serverId);

    case 'search':
      return search(message, serverId, args.join(' '));

    case 'info':
      return showInfo(message, serverId, args.shift());

    case 'raw':
      return showRaw(message, serverId, args.shift());

    case 'create':
    case 'add':
    case 'new':
      return create(message, client, serverId, args);

    case 'edit':
    case 'update':
      return edit(message, client, serverId, args);

    case 'delete':
    case 'remove':
      return remove(message, client, serverId, args.shift());

    case 'rename':
      return rename(message, client, serverId, args);

    case 'alias':
      return alias(message, client, serverId, args);

    case 'restrict':
      return restrict(message, client, serverId, args);

    case 'channel':
      return channelScope(message, client, serverId, args);

    default:
      return sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
  }
}

/**
 * The text after the first `skip` words of the command, line breaks kept. The
 * dispatcher splits arguments on whitespace, which would squash a multi-line
 * tag body (rules, FAQ answers) into one line.
 */
function restAfter(message: any, skip: number, fallback: string[]): string {
  const content = String(message?.content || '');
  if (!content.startsWith(config.prefix)) return fallback.join(' ');
  let rest = content.slice(config.prefix.length).replace(/^\s+/, '');
  for (let index = 0; index < skip; index++) rest = rest.replace(/^\S+\s*/, '');
  return rest.trim();
}

function actorOf(message: any) {
  return {
    source: 'command' as const,
    id: String(message?.authorId || ''),
    name: String(message?.member?.nickname || message?.author?.username || ''),
  };
}

async function requireManage(message: any, client: any): Promise<boolean> {
  const allowed = await hasPermission(message, client, ['ManageMessages', 'ManageServer']);
  if (!allowed) await message.channel?.send({ content: '❌ You need Manage Messages permission to edit tags.' });
  return allowed;
}

async function showList(message: any, serverId: string) {
  const tags = listTags(serverId);
  if (!tags.length) {
    await message.channel?.send({ content: `No tags yet. Create one with \`${config.prefix}tag create rules Be nice.\`` });
    return;
  }
  const names = tags.map((tag) => `\`${tag.name}\`${tag.aliases.length ? ` (${tag.aliases.map((a) => `\`${a}\``).join(', ')})` : ''}`);
  await message.channel?.send({ content: clampMessage(`## 🏷️ Tags (${tags.length})\n${names.join(' · ')}`) });
}

async function search(message: any, serverId: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag search <text>\`` });
    return;
  }
  const hits = listTags(serverId).filter(
    (tag) => tag.name.includes(needle) || tag.aliases.some((a) => a.includes(needle)) || tag.content.toLowerCase().includes(needle),
  );
  await message.channel?.send({
    content: hits.length
      ? clampMessage(`## 🔎 ${hits.length} match(es)\n${hits.map((tag) => `\`${tag.name}\``).join(' · ')}`)
      : `No tag matches \`${needle.slice(0, 100)}\`.`,
  });
}

async function showInfo(message: any, serverId: string, name: any) {
  const tag = getTag(serverId, String(name || ''));
  if (!tag) {
    await message.channel?.send({ content: `❌ No tag called \`${name}\`.` });
    return;
  }
  await message.channel?.send({
    content: [
      `## 🏷️ ${tag.name}`,
      tag.aliases.length ? `**Aliases:** ${tag.aliases.map((a) => `\`${a}\``).join(', ')}` : '',
      `**Created by:** <@${tag.createdBy}> on ${new Date(tag.createdAt).toLocaleDateString()}`,
      `**Uses:** ${tag.uses}`,
      tag.restrictedRoleIds.length ? `**Restricted to:** ${tag.restrictedRoleIds.map((id) => `<%${id}>`).join(' ')}` : '',
      tag.channelIds.length ? `**Only in:** ${tag.channelIds.map((id) => `<#${id}>`).join(' ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function showRaw(message: any, serverId: string, name: any) {
  const tag = getTag(serverId, String(name || ''));
  if (!tag) {
    await message.channel?.send({ content: `❌ No tag called \`${name}\`.` });
    return;
  }
  const body = tag.content.replace(/```/g, '`​``');
  await message.channel?.send({ content: `\`\`\`\n${body.slice(0, 1800) || '(embed only)'}\n\`\`\`` });
}

async function create(message: any, client: any, serverId: string, args: string[]) {
  if (!(await requireManage(message, client))) return;
  const name = args.shift();
  // `tag create <name>` are the three words before the body.
  const content = restAfter(message, 3, args);
  if (!name || !content) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag create <name> <content>\`` });
    return;
  }

  const result = createTag({
    serverId,
    name,
    content,
    createdBy: String(message?.authorId || ''),
    createdByName: String(message?.member?.nickname || message?.author?.username || ''),
  });

  await message.channel?.send({
    content: result.ok ? `✅ Tag \`${result.tag.name}\` created. Call it with \`${config.prefix}${result.tag.name}\`.` : `❌ ${result.error}`,
  });
}

async function edit(message: any, client: any, serverId: string, args: string[]) {
  if (!(await requireManage(message, client))) return;
  const name = args.shift();
  const content = restAfter(message, 3, args);
  if (!name || !content) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag edit <name> <content>\`` });
    return;
  }
  const result = updateTag(serverId, name, { content }, actorOf(message));
  await message.channel?.send({ content: result.ok ? `✏️ Tag \`${result.tag.name}\` updated.` : `❌ ${result.error}` });
}

async function remove(message: any, client: any, serverId: string, name: any) {
  if (!(await requireManage(message, client))) return;
  if (!name) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag delete <name>\`` });
    return;
  }
  const removed = deleteTag(serverId, String(name), actorOf(message));
  await message.channel?.send({ content: removed ? `🗑️ Tag \`${name}\` deleted.` : `❌ No tag called \`${name}\`.` });
}

async function rename(message: any, client: any, serverId: string, args: string[]) {
  if (!(await requireManage(message, client))) return;
  const [from, to] = args;
  if (!from || !to) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag rename <name> <new name>\`` });
    return;
  }
  const result = updateTag(serverId, from, { name: to }, actorOf(message));
  await message.channel?.send({ content: result.ok ? `✏️ Renamed to \`${result.tag.name}\`.` : `❌ ${result.error}` });
}

async function alias(message: any, client: any, serverId: string, args: string[]) {
  if (!(await requireManage(message, client))) return;
  const mode = (args.shift() || '').toLowerCase();

  if (mode === 'add') {
    const [name, aliasName] = args;
    if (!name || !aliasName) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag alias add <name> <alias>\`` });
      return;
    }
    const result = addTagAlias(serverId, name, aliasName, actorOf(message));
    await message.channel?.send({
      content: result.ok ? `✅ \`${aliasName}\` now calls \`${result.tag.name}\`.` : `❌ ${result.error}`,
    });
    return;
  }

  if (mode === 'remove' || mode === 'delete') {
    const aliasName = args.shift();
    if (!aliasName) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag alias remove <alias>\`` });
      return;
    }
    const result = removeTagAlias(serverId, aliasName, actorOf(message));
    await message.channel?.send({ content: result.ok ? `🗑️ Alias \`${aliasName}\` removed.` : `❌ ${result.error}` });
    return;
  }

  await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag alias add|remove …\`` });
}

async function restrict(message: any, client: any, serverId: string, args: string[]) {
  if (!(await requireManage(message, client))) return;
  const name = args.shift();
  const value = String(args.shift() || '');
  if (!name || !value) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag restrict <name> <roleId|off>\`` });
    return;
  }

  if (value.toLowerCase() === 'off' || value.toLowerCase() === 'none') {
    const result = updateTag(serverId, name, { restrictedRoleIds: [] }, actorOf(message));
    await message.channel?.send({ content: result.ok ? `✅ \`${name}\` is open to everyone again.` : `❌ ${result.error}` });
    return;
  }

  const roleId = normalizeSimpleId(value);
  if (!roleId) {
    await message.channel?.send({ content: '❌ That is not a role id.' });
    return;
  }

  const tag = getTag(serverId, name);
  if (!tag) {
    await message.channel?.send({ content: `❌ No tag called \`${name}\`.` });
    return;
  }
  const next = tag.restrictedRoleIds.includes(roleId)
    ? tag.restrictedRoleIds.filter((id) => id !== roleId)
    : [...tag.restrictedRoleIds, roleId];
  const result = updateTag(serverId, name, { restrictedRoleIds: next }, actorOf(message));
  await message.channel?.send({
    content: result.ok
      ? `✅ \`${name}\` is now limited to ${next.length ? next.map((id) => `<%${id}>`).join(' ') : 'everyone'}.`
      : `❌ ${result.error}`,
  });
}

async function channelScope(message: any, client: any, serverId: string, args: string[]) {
  if (!(await requireManage(message, client))) return;
  const name = args.shift();
  const value = String(args.shift() || '');
  if (!name || !value) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}tag channel <name> <channelId|off>\`` });
    return;
  }

  if (value.toLowerCase() === 'off' || value.toLowerCase() === 'none') {
    const result = updateTag(serverId, name, { channelIds: [] }, actorOf(message));
    await message.channel?.send({ content: result.ok ? `✅ \`${name}\` works in every channel again.` : `❌ ${result.error}` });
    return;
  }

  const channelId = normalizeSimpleId(value);
  const tag = getTag(serverId, name);
  if (!channelId || !tag) {
    await message.channel?.send({ content: '❌ Give a valid tag name and channel id.' });
    return;
  }
  const next = tag.channelIds.includes(channelId)
    ? tag.channelIds.filter((id) => id !== channelId)
    : [...tag.channelIds, channelId];
  const result = updateTag(serverId, name, { channelIds: next }, actorOf(message));
  await message.channel?.send({
    content: result.ok
      ? `✅ \`${name}\` now answers in ${next.length ? next.map((id) => `<#${id}>`).join(' ') : 'every channel'}.`
      : `❌ ${result.error}`,
  });
}

async function sendHelp(message: any, prefixLine?: string) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      prefixLine || '## 🏷️ Tags',
      `\`${p}tag create <name> <content>\` · \`${p}tag edit <name> <content>\` · \`${p}tag delete <name>\``,
      `\`${p}tag list\` · \`${p}tag search <text>\` · \`${p}tag info <name>\` · \`${p}tag raw <name>\``,
      `\`${p}tag alias add <name> <alias>\` · \`${p}tag alias remove <alias>\` · \`${p}tag rename <name> <new>\``,
      `\`${p}tag restrict <name> <roleId|off>\` · \`${p}tag channel <name> <channelId|off>\``,
      '',
      `Call a tag with \`${p}<name>\`. Placeholders: \`{user}\` \`{mention}\` \`{server}\` \`{channel}\` \`{count}\` \`{args}\`.`,
    ].join('\n'),
  });
}
