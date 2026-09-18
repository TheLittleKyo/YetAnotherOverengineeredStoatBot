import { config } from '../config.js';
import {
  addAutoResponder,
  listAutoResponders,
  removeAutoResponder,
  toggleAutoResponder,
  type ResponderMatch,
} from '../autoresponder.js';
import { canManageServerById } from '../permissions.js';

/**
 * `autoresponder` command — configure keyword-triggered auto replies.
 *
 *   autoresponder add <trigger> | <response> [flags]
 *   autoresponder list
 *   autoresponder remove <id>
 *   autoresponder toggle <id>
 *
 * Flags: --exact --starts --ends --regex --case --channel <id> --cooldown <sec>
 * Response placeholders: {user} {mention} {channel}
 */
export async function autoResponderCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({
      content: 'You need Manage Server permission to configure auto-responders.',
    });
    return;
  }

  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  if (!serverId) {
    await message.channel?.send({ content: 'Auto-responders only work inside a server.' });
    return;
  }

  if (sub === 'add' || sub === 'create') {
    const rest = args.join(' ');
    const { trigger, response, flags } = parseAddArgs(rest);

    if (!trigger || !response) {
      await sendHelp(message, 'Usage: `autoresponder add <trigger> | <response> [flags]`');
      return;
    }

    const responder = addAutoResponder({
      serverId,
      trigger,
      response,
      match: flags.match,
      caseSensitive: flags.caseSensitive,
      channelId: flags.channelId,
      cooldownMs: flags.cooldownMs,
      enabled: true,
    });

    await message.channel?.send({
      content:
        `# Auto-Responder Added\n\n` +
        `ID: \`${responder.id}\`\n` +
        `Match: ${responder.match}${responder.caseSensitive ? ' (case-sensitive)' : ''}\n` +
        `Trigger: \`${responder.trigger}\`\n` +
        `Response: ${responder.response}\n` +
        (responder.channelId ? `Channel: <#${responder.channelId}>\n` : '') +
        (responder.cooldownMs > 0 ? `Cooldown: ${Math.round(responder.cooldownMs / 1000)}s\n` : ''),
    });
    return;
  }

  if (sub === 'list' || sub === 'ls') {
    const responders = listAutoResponders(serverId);
    if (responders.length === 0) {
      await message.channel?.send({
        content: `No auto-responders configured. Add one with \`${config.prefix}autoresponder add <trigger> | <response>\`.`,
      });
      return;
    }

    const lines = responders.map((r) => {
      const state = r.enabled ? '🟢' : '🔴';
      const scope = r.channelId ? ` in <#${r.channelId}>` : '';
      const cd = r.cooldownMs > 0 ? ` (${Math.round(r.cooldownMs / 1000)}s cd)` : '';
      return `- ${state} \`${r.id}\` [${r.match}] \`${r.trigger}\` → ${truncate(r.response, 60)}${scope}${cd}`;
    });

    await message.channel?.send({ content: `# Auto-Responders\n\n${lines.join('\n')}` });
    return;
  }

  if (sub === 'remove' || sub === 'delete' || sub === 'rm') {
    const id = args[0];
    if (!id) {
      await sendHelp(message, 'Usage: `autoresponder remove <id>`');
      return;
    }
    const removed = removeAutoResponder(id);
    await message.channel?.send({
      content: removed ? `Removed auto-responder \`${id}\`.` : `No auto-responder found with ID \`${id}\`.`,
    });
    return;
  }

  if (sub === 'toggle' || sub === 'enable' || sub === 'disable') {
    const id = args[0];
    if (!id) {
      await sendHelp(message, 'Usage: `autoresponder toggle <id>`');
      return;
    }
    const responder = toggleAutoResponder(id);
    await message.channel?.send({
      content: responder
        ? `Auto-responder \`${id}\` is now ${responder.enabled ? 'enabled 🟢' : 'disabled 🔴'}.`
        : `No auto-responder found with ID \`${id}\`.`,
    });
    return;
  }

  await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
}

function parseAddArgs(rest: string): {
  trigger: string;
  response: string;
  flags: { match: ResponderMatch; caseSensitive: boolean; channelId: string | null; cooldownMs: number };
} {
  const flags: { match: ResponderMatch; caseSensitive: boolean; channelId: string | null; cooldownMs: number } = {
    match: 'contains',
    caseSensitive: false,
    channelId: null,
    cooldownMs: 0,
  };

  // Pull flags off the end first so they don't leak into the response text.
  let working = rest;

  working = working.replace(/--exact\b/i, () => { flags.match = 'exact'; return ''; });
  working = working.replace(/--starts(?:with)?\b/i, () => { flags.match = 'starts'; return ''; });
  working = working.replace(/--ends(?:with)?\b/i, () => { flags.match = 'ends'; return ''; });
  working = working.replace(/--regex\b/i, () => { flags.match = 'regex'; return ''; });
  working = working.replace(/--case\b/i, () => { flags.caseSensitive = true; return ''; });
  working = working.replace(/--channel\s+<?#?([A-Za-z0-9_-]+)>?/i, (_m, id) => { flags.channelId = id; return ''; });
  working = working.replace(/--cooldown\s+(\d+)/i, (_m, sec) => { flags.cooldownMs = Number(sec) * 1000; return ''; });

  const [triggerPart, ...responseParts] = working.split('|');
  return {
    trigger: (triggerPart || '').trim(),
    response: responseParts.join('|').trim(),
    flags,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# Auto-Responder Commands\n\n` +
      `- \`${config.prefix}autoresponder add <trigger> | <response> [flags]\` - Reply automatically when a message matches\n` +
      `- \`${config.prefix}autoresponder list\` - Show configured responders\n` +
      `- \`${config.prefix}autoresponder remove <id>\` - Delete a responder\n` +
      `- \`${config.prefix}autoresponder toggle <id>\` - Enable/disable a responder\n\n` +
      `**Flags:** \`--exact\` \`--starts\` \`--ends\` \`--regex\` \`--case\` \`--channel <id>\` \`--cooldown <sec>\`\n` +
      `Default match is *contains*.\n\n` +
      `**Response placeholders:** \`{user}\` \`{mention}\` \`{channel}\`\n\n` +
      `Example: \`${config.prefix}autoresponder add hello | Hi {mention}! 👋 --starts --cooldown 10\``,
  });
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || message.channel?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}
