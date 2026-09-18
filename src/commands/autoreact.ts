import { config } from '../config.js';
import {
  addAutoReact,
  listAutoReacts,
  removeAutoReact,
  toggleAutoReact,
  type ReactMatch,
} from '../autoreact.js';
import { canManageServerById } from '../permissions.js';

/**
 * `autoreact` command — auto-add emoji reactions to matching messages.
 *
 *   autoreact add <trigger> | <emoji> [emoji2 ...] [flags]
 *   autoreact add --all | <emoji> [flags]        (react to every message)
 *   autoreact list
 *   autoreact remove <id>
 *   autoreact toggle <id>
 *
 * Flags: --exact --starts --ends --regex --all --case --channel <id>
 * Emoji: unicode (😀) or a custom emoji id.
 */
export async function autoReactCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({
      content: 'You need Manage Server permission to configure auto-reacts.',
    });
    return;
  }

  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  if (!serverId) {
    await message.channel?.send({ content: 'Auto-reacts only work inside a server.' });
    return;
  }

  if (sub === 'add' || sub === 'create') {
    const rest = args.join(' ');
    const { trigger, emojis, flags } = parseAddArgs(rest);

    if (emojis.length === 0) {
      await sendHelp(message, 'Usage: `autoreact add <trigger> | <emoji> [emoji2 ...]`');
      return;
    }
    if (flags.match !== 'all' && !trigger) {
      await sendHelp(message, 'Provide a trigger, or use `--all` to react to every message.');
      return;
    }

    const reactor = addAutoReact({
      serverId,
      trigger,
      emojis,
      match: flags.match,
      caseSensitive: flags.caseSensitive,
      channelId: flags.channelId,
      enabled: true,
    });

    await message.channel?.send({
      content:
        `# Auto-React Added\n\n` +
        `ID: \`${reactor.id}\`\n` +
        `Match: ${reactor.match}${reactor.caseSensitive ? ' (case-sensitive)' : ''}\n` +
        (reactor.match !== 'all' ? `Trigger: \`${reactor.trigger}\`\n` : '') +
        `Emojis: ${reactor.emojis.join(' ')}\n` +
        (reactor.channelId ? `Channel: <#${reactor.channelId}>\n` : ''),
    });
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const reactors = listAutoReacts(serverId);
    if (reactors.length === 0) {
      await message.channel?.send({
        content: `No auto-reacts configured. Add one with \`${config.prefix}autoreact add <trigger> | <emoji>\`.`,
      });
      return;
    }

    const lines = reactors.map((r) => {
      const state = r.enabled ? '🟢' : '🔴';
      const scope = r.channelId ? ` in <#${r.channelId}>` : '';
      const target = r.match === 'all' ? '*(every message)*' : `\`${r.trigger}\``;
      return `- ${state} \`${r.id}\` [${r.match}] ${target} → ${r.emojis.join(' ')}${scope}`;
    });

    await message.channel?.send({ content: `# Auto-Reacts\n\n${lines.join('\n')}` });
    return;
  }

  if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
    const id = args[0];
    if (!id) {
      await sendHelp(message, 'Usage: `autoreact remove <id>`');
      return;
    }
    const removed = removeAutoReact(id);
    await message.channel?.send({
      content: removed ? `Removed auto-react \`${id}\`.` : `No auto-react found with ID \`${id}\`.`,
    });
    return;
  }

  if (sub === 'toggle' || sub === 'enable' || sub === 'disable') {
    const id = args[0];
    if (!id) {
      await sendHelp(message, 'Usage: `autoreact toggle <id>`');
      return;
    }
    const reactor = toggleAutoReact(id);
    await message.channel?.send({
      content: reactor
        ? `Auto-react \`${id}\` is now ${reactor.enabled ? 'enabled 🟢' : 'disabled 🔴'}.`
        : `No auto-react found with ID \`${id}\`.`,
    });
    return;
  }

  await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
}

function parseAddArgs(rest: string): {
  trigger: string;
  emojis: string[];
  flags: { match: ReactMatch; caseSensitive: boolean; channelId: string | null };
} {
  const flags: { match: ReactMatch; caseSensitive: boolean; channelId: string | null } = {
    match: 'contains',
    caseSensitive: false,
    channelId: null,
  };

  let working = rest;

  let allFlag = false;
  working = working.replace(/--all\b/i, () => { allFlag = true; return ''; });
  working = working.replace(/--exact\b/i, () => { flags.match = 'exact'; return ''; });
  working = working.replace(/--starts(?:with)?\b/i, () => { flags.match = 'starts'; return ''; });
  working = working.replace(/--ends(?:with)?\b/i, () => { flags.match = 'ends'; return ''; });
  working = working.replace(/--regex\b/i, () => { flags.match = 'regex'; return ''; });
  working = working.replace(/--case\b/i, () => { flags.caseSensitive = true; return ''; });
  working = working.replace(/--channel\s+<?#?([A-Za-z0-9_-]+)>?/i, (_m, id) => { flags.channelId = id; return ''; });

  // --all wins over text-match flags.
  if (allFlag) flags.match = 'all';

  const [triggerPart, emojiPart] = working.split('|');
  const trigger = (triggerPart || '').trim();
  const emojis = (emojiPart || '')
    .trim()
    .split(/\s+/)
    .map((e) => normalizeEmojiInput(e))
    .filter(Boolean);

  return { trigger, emojis, flags };
}

function normalizeEmojiInput(raw: string): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  // Accept `<:name:id>` / `<a:name:id>` custom emoji mentions -> id
  const custom = input.match(/^<a?:[^:>]+:([A-Za-z0-9_-]+)>$/);
  return custom?.[1] || input;
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# Auto-React Commands\n\n` +
      `- \`${config.prefix}autoreact add <trigger> | <emoji> [emoji2 ...]\` - React automatically to matching messages\n` +
      `- \`${config.prefix}autoreact add --all | <emoji>\` - React to every message\n` +
      `- \`${config.prefix}autoreact list\` - Show configured auto-reacts\n` +
      `- \`${config.prefix}autoreact remove <id>\` - Delete an auto-react\n` +
      `- \`${config.prefix}autoreact toggle <id>\` - Enable/disable an auto-react\n\n` +
      `**Flags:** \`--exact\` \`--starts\` \`--ends\` \`--regex\` \`--all\` \`--case\` \`--channel <id>\`\n` +
      `Default match is *contains*. Emoji can be unicode or a custom emoji id.\n\n` +
      `Example: \`${config.prefix}autoreact add gg | 🎉 🔥 --contains\``,
  });
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}
