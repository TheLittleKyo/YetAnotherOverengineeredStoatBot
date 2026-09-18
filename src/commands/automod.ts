import { config } from '../config.js';
import { normalizeSimpleId } from '../id-utils.js';
import { canManageServerById } from '../permissions.js';
import { parseDuration } from '../duration.js';
import { joinLinesWithin } from '../embed-limits.js';
import {
  addAutomodRule,
  defaultThreshold,
  describeRuleType,
  getAutomodConfig,
  getAutomodSummary,
  listAutomodRules,
  removeAutomodRule,
  setAutomodConfig,
  updateAutomodRule,
  type AutomodAction,
  type AutomodRuleType,
} from '../automod.js';

/**
 * `automod` — content filtering rules.
 *
 *   automod on | off | status
 *   automod list
 *   automod add <type> [action] [duration]
 *   automod remove <id> | automod toggle <id>
 *   automod words <id> add|remove <word...>
 *   automod set <id> threshold|action|window <value>
 *   automod exempt role|channel <id>   (server-wide exemptions)
 *
 * Rule ids are short; `automod list` prints them next to each rule.
 */

const RULE_TYPES: AutomodRuleType[] = [
  'words', 'invites', 'links', 'mentions', 'spam', 'duplicates', 'caps', 'emoji', 'newlines', 'zalgo', 'attachments',
];
const ACTIONS: AutomodAction[] = ['delete', 'warn', 'mute', 'kick', 'ban'];

export async function automodCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  const serverId = String(message?.channel?.serverId || message?.serverId || config.serverId || '');
  if (!serverId) {
    await message.channel?.send({ content: '❌ Automod only works inside a server.' });
    return;
  }

  if (!(await canManageServerById(client, serverId, message?.authorId))) {
    await message.channel?.send({ content: '❌ You need Manage Server permission to configure automod.' });
    return;
  }

  switch (sub) {
    case 'on':
    case 'enable':
      setAutomodConfig({ enabled: true }, serverId);
      await message.channel?.send({
        content: listAutomodRules(serverId).length
          ? '🛡️ Automod **enabled**.'
          : `🛡️ Automod **enabled**, but it has no rules yet — add one with \`${config.prefix}automod add words warn\`.`,
      });
      return;

    case 'off':
    case 'disable':
      setAutomodConfig({ enabled: false }, serverId);
      await message.channel?.send({ content: 'Automod **disabled**. Rules are kept.' });
      return;

    case 'status':
      await message.channel?.send({ content: renderStatus(serverId) });
      return;

    case 'list':
      await message.channel?.send({ content: renderList(serverId) });
      return;

    case 'add':
      return addRule(message, serverId, args);

    case 'remove':
    case 'delete': {
      const id = String(args.shift() || '');
      const removed = removeAutomodRule(id, serverId);
      await message.channel?.send({ content: removed ? `🗑️ Rule \`${id}\` removed.` : `❌ No rule \`${id}\`.` });
      return;
    }

    case 'toggle': {
      const id = String(args.shift() || '');
      const rule = listAutomodRules(serverId).find((entry) => entry.id === id);
      if (!rule) {
        await message.channel?.send({ content: `❌ No rule \`${id}\`.` });
        return;
      }
      const updated = updateAutomodRule(id, { enabled: !rule.enabled }, serverId);
      await message.channel?.send({ content: `Rule **${updated?.name}** is now ${updated?.enabled ? 'on' : 'off'}.` });
      return;
    }

    case 'words':
      return editWords(message, serverId, args);

    case 'set':
      return setRuleField(message, serverId, args);

    case 'exempt':
      return setExemption(message, serverId, args);

    default:
      await sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
  }
}

function renderStatus(serverId: string): string {
  const cfg = getAutomodConfig(serverId);
  const summary = getAutomodSummary(serverId);
  return [
    '## 🛡️ Automod',
    `**State:** ${cfg.enabled ? 'on' : 'off'}`,
    `**Rules:** ${summary.enabledRuleCount} enabled of ${summary.ruleCount}`,
    `**Total hits:** ${summary.totalHits}`,
    `**Channel notice:** ${cfg.notifyChannel ? 'on' : 'off'}`,
    `**Staff exempt:** ${cfg.exemptStaffPermissions ? 'yes (Manage Messages and friends)' : 'no'}`,
    `**Exempt roles:** ${cfg.exemptRoleIds.length ? cfg.exemptRoleIds.map((id) => `<%${id}>`).join(' ') : 'none'}`,
    `**Exempt channels:** ${cfg.exemptChannelIds.length ? cfg.exemptChannelIds.map((id) => `<#${id}>`).join(' ') : 'none'}`,
  ].join('\n');
}

function renderList(serverId: string): string {
  const rules = listAutomodRules(serverId);
  if (!rules.length) return `No automod rules yet. Add one with \`${config.prefix}automod add words warn\`.`;

  const lines = rules.map((rule) => {
    const bits = [`\`${rule.id}\``, `**${rule.name}**`, `(${describeRuleType(rule.type)})`, `→ ${rule.action}`];
    if (!rule.enabled) bits.push('· *off*');
    if (rule.threshold) bits.push(`· threshold ${rule.threshold}`);
    if (rule.type === 'spam' || rule.type === 'duplicates') bits.push(`· window ${rule.windowSec}s`);
    if (rule.type === 'words') bits.push(`· ${rule.words.length} word(s)`);
    if (rule.hits) bits.push(`· ${rule.hits} hit(s)`);
    return `- ${bits.join(' ')}`;
  });
  return joinLinesWithin('## 🛡️ Automod rules', lines);
}

async function addRule(message: any, serverId: string, args: string[]) {
  const type = String(args.shift() || '').toLowerCase() as AutomodRuleType;
  if (!RULE_TYPES.includes(type)) {
    await message.channel?.send({ content: `❌ Unknown rule type. One of: ${RULE_TYPES.map((entry) => `\`${entry}\``).join(', ')}` });
    return;
  }

  const actionArg = String(args.shift() || 'delete').toLowerCase() as AutomodAction;
  const action = ACTIONS.includes(actionArg) ? actionArg : 'delete';
  const durationMs = parseDuration(args.shift());

  const rule = addAutomodRule(
    {
      type,
      action,
      durationMs: typeof durationMs === 'number' ? durationMs : null,
      threshold: defaultThreshold(type),
    },
    serverId,
  );

  const extra = type === 'words'
    ? `\nAdd words with \`${config.prefix}automod words ${rule.id} add <word> <word…>\`.`
    : '';
  await message.channel?.send({
    content: `✅ Added **${rule.name}** (\`${rule.id}\`) — action **${rule.action}**${rule.threshold ? `, threshold ${rule.threshold}` : ''}.${extra}`,
  });
}

async function editWords(message: any, serverId: string, args: string[]) {
  const id = String(args.shift() || '');
  const mode = String(args.shift() || '').toLowerCase();
  const words = args.map((word) => word.trim().toLowerCase()).filter(Boolean);

  const rule = listAutomodRules(serverId).find((entry) => entry.id === id);
  if (!rule) {
    await message.channel?.send({ content: `❌ No rule \`${id}\`.` });
    return;
  }
  if (rule.type !== 'words') {
    await message.channel?.send({ content: `❌ Rule \`${id}\` is a ${describeRuleType(rule.type)} rule, not a word list.` });
    return;
  }
  if (!words.length || (mode !== 'add' && mode !== 'remove')) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}automod words ${id} add|remove <word…>\`` });
    return;
  }

  const next = mode === 'add'
    ? Array.from(new Set([...rule.words, ...words]))
    : rule.words.filter((word) => !words.includes(word));

  const updated = updateAutomodRule(id, { words: next }, serverId);
  await message.channel?.send({
    content: `✅ **${updated?.name}** now blocks ${updated?.words.length} word(s). Wildcards: \`scam*\` matches anything starting with "scam".`,
  });
}

async function setRuleField(message: any, serverId: string, args: string[]) {
  const id = String(args.shift() || '');
  const field = String(args.shift() || '').toLowerCase();
  const value = String(args.shift() || '');

  const rule = listAutomodRules(serverId).find((entry) => entry.id === id);
  if (!rule) {
    await message.channel?.send({ content: `❌ No rule \`${id}\`.` });
    return;
  }

  if (field === 'threshold') {
    const threshold = Number(value);
    if (!Number.isFinite(threshold) || threshold < 0) {
      await message.channel?.send({ content: '❌ The threshold must be a number.' });
      return;
    }
    updateAutomodRule(id, { threshold }, serverId);
    await message.channel?.send({ content: `✅ **${rule.name}** threshold set to ${threshold}.` });
    return;
  }

  if (field === 'action') {
    if (!ACTIONS.includes(value as AutomodAction)) {
      await message.channel?.send({ content: `❌ Action must be one of: ${ACTIONS.join(', ')}.` });
      return;
    }
    const durationMs = parseDuration(args.shift());
    updateAutomodRule(id, { action: value as AutomodAction, durationMs: typeof durationMs === 'number' ? durationMs : rule.durationMs }, serverId);
    await message.channel?.send({ content: `✅ **${rule.name}** now applies **${value}**.` });
    return;
  }

  if (field === 'window') {
    const windowSec = Number(value);
    if (!Number.isFinite(windowSec) || windowSec < 1) {
      await message.channel?.send({ content: '❌ The window must be a number of seconds.' });
      return;
    }
    updateAutomodRule(id, { windowSec }, serverId);
    await message.channel?.send({ content: `✅ **${rule.name}** window set to ${windowSec}s.` });
    return;
  }

  if (field === 'name') {
    const name = [value, ...args].join(' ').trim();
    if (!name) {
      await message.channel?.send({ content: '❌ Give the rule a name.' });
      return;
    }
    updateAutomodRule(id, { name }, serverId);
    await message.channel?.send({ content: `✅ Renamed to **${name}**.` });
    return;
  }

  await message.channel?.send({
    content: `❌ Usage: \`${config.prefix}automod set <id> <threshold|action|window|name> <value>\``,
  });
}

async function setExemption(message: any, serverId: string, args: string[]) {
  const kind = String(args.shift() || '').toLowerCase();
  const id = normalizeSimpleId(args.shift());
  if ((kind !== 'role' && kind !== 'channel') || !id) {
    await message.channel?.send({ content: `❌ Usage: \`${config.prefix}automod exempt role|channel <id>\`` });
    return;
  }

  const cfg = getAutomodConfig(serverId);
  if (kind === 'role') {
    const next = cfg.exemptRoleIds.includes(id)
      ? cfg.exemptRoleIds.filter((entry) => entry !== id)
      : [...cfg.exemptRoleIds, id];
    setAutomodConfig({ exemptRoleIds: next }, serverId);
    await message.channel?.send({ content: `✅ <%${id}> is ${next.includes(id) ? 'now exempt from' : 'no longer exempt from'} automod.` });
    return;
  }

  const next = cfg.exemptChannelIds.includes(id)
    ? cfg.exemptChannelIds.filter((entry) => entry !== id)
    : [...cfg.exemptChannelIds, id];
  setAutomodConfig({ exemptChannelIds: next }, serverId);
  await message.channel?.send({ content: `✅ <#${id}> is ${next.includes(id) ? 'now exempt from' : 'no longer exempt from'} automod.` });
}

async function sendHelp(message: any, prefixLine?: string) {
  const p = config.prefix;
  await message.channel?.send({
    content: [
      prefixLine || '## 🛡️ Automod',
      `\`${p}automod on|off|status|list\``,
      `\`${p}automod add <type> [action] [duration]\` — types: ${RULE_TYPES.join(', ')}`,
      `\`${p}automod remove <id>\` · \`${p}automod toggle <id>\``,
      `\`${p}automod words <id> add|remove <word…>\` — \`*\` is a wildcard`,
      `\`${p}automod set <id> threshold|action|window|name <value>\``,
      `\`${p}automod exempt role|channel <id>\` — toggles a server-wide exemption`,
      '',
      'Actions: `delete` (remove the message only), `warn`, `mute`, `kick`, `ban` — all of which also delete it and open a moderation case.',
      'The dashboard **Automod** tab has the same settings plus per-rule channel scoping.',
    ].join('\n'),
  });
}
