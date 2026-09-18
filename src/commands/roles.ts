import { config } from '../config.js';
import { deleteReactionRoleMessage, getReactionRoleMessages, saveReactionRoleMessage } from '../reaction-roles.js';
import { requirePermission } from '../permissions.js';
import { currentBotPermission } from '../bot-permissions.js';
import { getClientToken, getApiBaseUrl } from '../stoat-api.js';
import { normalizeId } from '../id-utils.js';
import { getReadableError } from '../error-utils.js';

/**
 * Reaction role commands
 *
 * Usage:
 * !roles add <messageId> <emoji> <roleId> [emoji roleId ...]
 * !roles remove <messageId> [emoji ...]
 * !roles list
 * !roles gradient <roleId> <col1> <col2> [col3] [col4] [--angle 90]
 */
export async function rolesCommand(message, args, client) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (sub === 'add' || sub === 'set' || sub === 'attach') {
    if (!(await requirePermission(message, client, ['ManageRoles', 'ManageRole'], 'Manage Roles'))) return;
    await addReactionRoles(message, args, client);
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    if (!(await requirePermission(message, client, ['ManageRoles', 'ManageRole'], 'Manage Roles'))) return;
    await removeReactionRoles(message, args);
    return;
  }

  if (sub === 'list') {
    await listReactionRoleMessages(message);
    return;
  }

  if (sub === 'editor' || sub === 'edit' || sub === 'builder' || sub === 'web' || sub === 'dashboard') {
    await message.channel?.send({
      content:
        `ℹ️ The role editor now lives in the dashboard. Run \`${config.prefix}dashboard\` and open the **Roles** tab.`,
    });
    return;
  }

  if (['gradient', 'gradientcolor', 'gradient-colour', 'gradient-color', 'rolegradient'].includes(sub)) {
    await setRoleGradientColor(message, args, client);
    return;
  }

  await sendHelp(message);
}

async function setRoleGradientColor(message, args, client) {
  if (!(await canManageRoles(message, client))) {
    await message.channel?.send({
      content: '❌ You need Manage Role or Manage Server permission to edit role colors.',
    });
    return;
  }

  const parsed = parseGradientArgs(args);
  if (parsed.ok === false) {
    await message.channel?.send({ content: parsed.error });
    return;
  }

  const serverId = config.serverId;
  if (!serverId) {
    await message.channel?.send({ content: '❌ SERVER_ID is not configured.' });
    return;
  }

  const payload = {
    type: 'ServerRoleUpdate',
    id: serverId,
    role_id: parsed.roleId,
    data: {
      color: parsed.gradient,
    },
    clear: [],
  };

  try {
    const result = await updateRoleGradientColor(client, serverId, parsed.roleId, parsed.gradient, payload);

    await message.channel?.send({
      content:
        `# ✅ Role Gradient Updated\n\n` +
        `**Role:** <%${parsed.roleId}> (\`${parsed.roleId}\`)\n` +
        `**Gradient:** \`${parsed.gradient}\`\n` +
        `**Method:** ${result.method}\n\n` +
        `Raw event payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
    });
  } catch (error) {
    await message.channel?.send({
      content:
        `❌ Failed to update role gradient for \`${parsed.roleId}\`.\n` +
        `Reason: ${getReadableError(error)}\n\n` +
        `Expected raw payload:\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
    });
  }
}

function parseGradientArgs(args: string[]):
  | { ok: true; roleId: string; gradient: string }
  | { ok: false; error: string } {
  const tokens = [...(args || [])].filter(Boolean);
  const roleId = normalizeId(tokens.shift());

  if (!roleId || tokens.length === 0) {
    return {
      ok: false,
      error:
        `❌ Usage: \`${config.prefix}roles gradient <roleId> <col1> <col2> [col3] [col4] [--angle 90]\`\n` +
        `Or: \`${config.prefix}roles gradient <roleId> linear-gradient(90deg, #ff0000, #00ff00, #0000ff, #ffffff)\``,
    };
  }

  const joined = tokens.join(' ').trim();
  if (/^linear-gradient\(/i.test(joined)) {
    if (!isSafeLinearGradient(joined)) {
      return { ok: false, error: '❌ Invalid linear-gradient value.' };
    }
    return { ok: true, roleId, gradient: joined };
  }

  let angle = '90deg';
  const colors: string[] = [];

  for (let i = 0; i < tokens.length; i += 1) {
    const token = String(tokens[i] || '').trim();
    const lower = token.toLowerCase();

    if (lower === '--angle' || lower === '-a') {
      const value = tokens[i + 1];
      if (!isAngle(value)) {
        return { ok: false, error: '❌ Invalid angle. Use a number or CSS angle like `90deg`.' };
      }
      angle = normalizeAngle(value);
      i += 1;
      continue;
    }

    if (lower.startsWith('--angle=')) {
      const value = token.slice(token.indexOf('=') + 1);
      if (!isAngle(value)) {
        return { ok: false, error: '❌ Invalid angle. Use a number or CSS angle like `90deg`.' };
      }
      angle = normalizeAngle(value);
      continue;
    }

    const color = normalizeCssColorToken(token);
    if (!color || !isSafeCssColor(color)) {
      return { ok: false, error: `❌ Invalid color stop: \`${token}\`.` };
    }
    colors.push(color);
  }

  if (colors.length < 2) {
    return { ok: false, error: '❌ Provide at least two color stops for the gradient.' };
  }

  if (colors.length > 8) {
    return { ok: false, error: '❌ Use 8 or fewer color stops.' };
  }

  const gradient = `linear-gradient(${angle}, ${colors.join(', ')})`;
  return { ok: true, roleId, gradient };
}

async function updateRoleGradientColor(client, serverId: string, roleId: string, gradient: string, rawPayload: any) {
  const errors: string[] = [];

  try {
    await patchRoleColorViaFetch(client, serverId, roleId, { colour: gradient });
    return { method: 'role edit API (`colour`)' };
  } catch (error) {
    errors.push(`direct API colour patch: ${getReadableError(error)}`);
  }

  try {
    await patchRoleColorViaFetch(client, serverId, roleId, { color: gradient });
    return { method: 'role edit API (`color`)' };
  } catch (error) {
    errors.push(`direct API color patch: ${getReadableError(error)}`);
  }

  if (typeof client?.api?.patch === 'function') {
    try {
      await client.api.patch(`/servers/${serverId}/roles/${roleId}`, { colour: gradient });
      return { method: 'client API patch (`colour`)' };
    } catch (error) {
      errors.push(`client API colour patch: ${getReadableError(error)}`);
    }

    try {
      await client.api.patch(`/servers/${serverId}/roles/${roleId}`, { color: gradient });
      return { method: 'client API patch (`color`)' };
    } catch (error) {
      errors.push(`client API color patch: ${getReadableError(error)}`);
    }
  }

  if (typeof client?.events?.send === 'function') {
    try {
      client.events.send(rawPayload);
      return { method: 'raw websocket `ServerRoleUpdate` payload fallback' };
    } catch (error) {
      errors.push(`raw websocket send: ${getReadableError(error)}`);
    }
  }

  throw new Error(errors.join(' | ') || 'no supported role color update method found');
}

async function patchRoleColorViaFetch(client, serverId: string, roleId: string, body: Record<string, string>) {
  const token = getClientToken(client);
  if (!token) {
    throw new Error('missing bot token for direct role color API call');
  }

  const baseUrl = getApiBaseUrl(client);
  const response = await fetch(
    `${baseUrl}/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`,
    {
      method: 'PATCH',
      headers: {
        [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
        'Content-Type': 'application/json',
        'User-Agent': 'YetAnotherOverengineeredStoatBot role-gradient-color',
      },
      body: JSON.stringify(body),
    }
  );

  if (response.ok) {
    return;
  }

  const responseText = await response.text().catch(() => '');
  throw new Error(
    `API call failed with status ${response.status}: ${response.statusText}` +
      (responseText ? ` (${responseText})` : '')
  );
}

async function canManageRoles(message, client): Promise<boolean> {
  const decision = await currentBotPermission(client, config.serverId, message.authorId);
  if (decision) return decision === 'allow';

  let server = null;
  try {
    server = await client.servers.fetch(config.serverId);
  } catch {
    server = client.servers.cache.get(config.serverId);
  }

  const member = await server?.members?.fetch(message.authorId).catch(() => server?.members?.cache?.get?.(message.authorId) || null);
  if (!member || typeof member.hasPermission !== 'function') return false;

  for (const permission of ['ManageRole', 'ManageRoles', 'MANAGE_ROLE', 'MANAGE_ROLES', 'ManageServer', 'MANAGE_SERVER']) {
    try {
      if (member.hasPermission(permission)) return true;
    } catch {
      // try next spelling
    }
  }

  return false;
}

function isSafeLinearGradient(value: string): boolean {
  const gradient = String(value || '').trim();
  if (gradient.length > 320 || !/^linear-gradient\(.+\)$/i.test(gradient)) return false;
  if (/[;{}<>"']/.test(gradient)) return false;

  const inside = gradient.slice(gradient.indexOf('(') + 1, -1);
  const parts = splitCssArgs(inside);
  if (parts.length < 2) return false;

  const first = parts[0];
  const colorStops = isGradientDirection(first) ? parts.slice(1) : parts;
  return colorStops.length >= 2 && colorStops.length <= 8 && colorStops.every((part) => isSafeCssColorStop(part));
}

function splitCssArgs(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;

  for (const char of value) {
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;

    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

function isGradientDirection(value: string): boolean {
  const input = String(value || '').trim().toLowerCase();
  return isAngle(input) || /^to\s+(left|right|top|bottom)(\s+(left|right|top|bottom))?$/.test(input);
}

function isSafeCssColorStop(value: string): boolean {
  const input = String(value || '').trim();
  if (!input || /[;{}<>"']/.test(input)) return false;

  const parts = input.split(/\s+/);
  const color = parts.slice(0, Math.max(1, parts.length - 1)).join(' ');
  const maybePosition = parts.length > 1 ? parts[parts.length - 1] : null;
  return isSafeCssColor(color) && (!maybePosition || /^-?\d+(?:\.\d+)?(?:%|px|em|rem|vh|vw)?$/i.test(maybePosition));
}

function isSafeCssColor(value: string): boolean {
  const color = String(value || '').trim();
  if (!color || color.length > 80 || /[;{}<>"']/.test(color)) return false;
  return (
    /^#[0-9a-f]{3,8}$/i.test(color) ||
    /^[a-z][a-z0-9_-]*$/i.test(color) ||
    /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch)\([^()]+\)$/i.test(color) ||
    /^var\(--[a-z0-9_-]+\)$/i.test(color)
  );
}

function normalizeCssColorToken(value: string): string | null {
  const color = String(value || '').trim().replace(/,+$/, '');
  return color || null;
}

function isAngle(value: any): boolean {
  const input = String(value || '').trim();
  return /^-?\d+(?:\.\d+)?(?:deg|grad|rad|turn)?$/i.test(input);
}

function normalizeAngle(value: any): string {
  const input = String(value || '').trim();
  return /^-?\d+(?:\.\d+)?$/i.test(input) ? `${input}deg` : input;
}

async function addReactionRoles(message, args, client) {
  const parsed = parseAddArgs(message, args);
  if (parsed.ok === false) {
    await message.channel?.send({
      content: parsed.error,
    });
    return;
  }

  const targetMessage = await fetchMessage(client, parsed.channelId, parsed.messageId);
  if (!targetMessage) {
    await message.channel?.send({
      content: `❌ Could not find message \`${parsed.messageId}\` in <#${parsed.channelId}>.`,
    });
    return;
  }

  const warnings: string[] = [];
  for (const mapping of parsed.mappings) {
    try {
      await addReactionToMessage(client, targetMessage, parsed.channelId, parsed.messageId, mapping.emoji);
    } catch (error) {
      warnings.push(
        `⚠️ Saved mapping for ${mapping.emoji}, but could not pre-add the bot reaction: ${getReadableError(error)}`
      );
    }
  }

  saveReactionRoleMessage({
    messageId: parsed.messageId,
    channelId: parsed.channelId,
    serverId: config.serverId,
    mappings: parsed.mappings,
  });

  const lines = parsed.mappings.map((map) => `${map.emoji} → <%${map.roleId}>`).join('\n');

  await message.channel?.send({
    content:
      `✅ Added ${parsed.mappings.length} reaction role mapping(s) to message \`${parsed.messageId}\`.\n` +
      `${lines}` +
      (warnings.length > 0 ? `\n\n${warnings.join('\n')}` : ''),
  });
}

function parseAddArgs(message, args):
  | { ok: true; channelId: string; messageId: string; mappings: Array<{ emoji: string; roleId: string }> }
  | { ok: false; error: string } {
  if (args.length < 3 || args.length % 2 === 0) {
    return { ok: false, error: `❌ Usage: \`${config.prefix}roles add <messageId> <emoji> <roleId> [emoji roleId ...]\`` };
  }

  const channelId = normalizeId(message.channelId);
  const messageId = normalizeId(args.shift());

  if (!channelId || !messageId || args.length < 2 || args.length % 2 !== 0) {
    return {
      ok: false,
      error: `❌ Usage: \`${config.prefix}roles add <messageId> <emoji> <roleId> [emoji roleId ...]\``,
    };
  }

  const mappings: Array<{ emoji: string; roleId: string }> = [];

  for (let i = 0; i < args.length; i += 2) {
    const emoji = String(args[i] || '').trim();
    const roleId = normalizeId(args[i + 1]);

    if (!emoji || !roleId) {
      return { ok: false, error: `❌ Invalid pair at position ${i + 1}. Use emoji + role ID.` };
    }

    mappings.push({ emoji, roleId });
  }

  return { ok: true, channelId, messageId, mappings };
}

async function removeReactionRoles(message, args) {
  const messageId = normalizeId(args.shift());
  const emojis = args.map((arg) => String(arg || '').trim()).filter(Boolean);

  if (!messageId) {
    await message.channel?.send({
      content: `❌ Usage: \`${config.prefix}roles remove <messageId> [emoji ...]\``,
    });
    return;
  }

  const removed = deleteReactionRoleMessage(messageId, emojis);
  await message.channel?.send({
    content: removed
      ? emojis.length > 0
        ? `✅ Removed ${emojis.length} mapping(s) from message \`${messageId}\`.`
        : `✅ Removed all reaction role mappings from message \`${messageId}\`.`
      : `⚠️ No reaction role mappings found for message \`${messageId}\`.`,
  });
}

async function listReactionRoleMessages(message) {
  const entries = getReactionRoleMessages();
  if (entries.length === 0) {
    await message.channel?.send({
      content: 'ℹ️ No reaction role messages configured.',
    });
    return;
  }

  const lines = entries.map((entry, index) => {
    const mapping = entry.mappings.map((item) => `${item.emoji}=<%${item.roleId}>`).join(', ');
    return `${index + 1}. message=\`${entry.messageId}\` ${mapping}`;
  });

  await message.channel?.send({
    content: `# 🎭 Reaction Role Messages\n\n${lines.join('\n')}`,
  });
}

async function sendHelp(message) {
  await message.channel?.send({
    content:
      `# 🎭 Reaction Roles Help\n\n` +
      `\`${config.prefix}dashboard\` - Open the dashboard and use the **Roles** tab to create, edit, recolor, and set permissions.\n\n` +
      `\`${config.prefix}roles gradient <roleId> <col1> <col2> [col3] [col4] [--angle 90]\`\n` +
      `Set a role CSS linear-gradient color.\n\n` +
      `\`${config.prefix}roles add <messageId> <emoji> <roleId> [emoji roleId ...]\`\n` +
      `Add reaction role mappings to a message in the current channel.\n\n` +
      `\`${config.prefix}roles remove <messageId> [emoji ...]\`\n` +
      `Remove mappings for one message. If no emoji is provided, removes all mappings for that message.\n\n` +
      `\`${config.prefix}roles list\`\n` +
      `List saved reaction role messages.`,
  });
}

async function fetchMessage(client, channelId: string, messageId: string) {
  const channel = client.channels.cache.get(channelId) || (await client.channels.fetch(channelId).catch(() => null));
  if (!channel || typeof channel.isText !== 'function' || !channel.isText()) {
    return null;
  }

  return channel.messages?.cache?.get?.(messageId) || (await channel.messages.fetch(messageId).catch(() => null));
}

async function addReactionToMessage(client, message, channelId: string, messageId: string, emoji: string) {
  const errors: string[] = [];
  const reactionEmoji = normalizeReactionEmoji(emoji);

  if (hasReaction(message, reactionEmoji)) {
    return;
  }

  try {
    await addReactionViaFetch(client, channelId, messageId, reactionEmoji);
    return;
  } catch (error) {
    errors.push(getReadableError(error));
  }

  if (typeof message?.addReaction === 'function') {
    try {
      await message.addReaction(reactionEmoji);
      return;
    } catch (error) {
      errors.push(getReadableError(error));
    }
  }

  if (typeof message?.react === 'function') {
    try {
      await message.react(reactionEmoji);
      return;
    } catch (error) {
      errors.push(getReadableError(error));
    }
  }

  try {
    await client.api.put(`/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(reactionEmoji)}`);
    return;
  } catch (error) {
    errors.push(getReadableError(error));
  }

  throw new Error(Array.from(new Set(errors.filter(Boolean))).join(' | ') || 'unknown API error');
}

async function addReactionViaFetch(client, channelId: string, messageId: string, emoji: string) {
  const token = getClientToken(client);
  if (!token) {
    throw new Error('missing bot token for direct reaction API call');
  }

  const baseUrl = getApiBaseUrl(client);
  const url =
    `${baseUrl}/channels/${encodeURIComponent(channelId)}` +
    `/messages/${encodeURIComponent(messageId)}` +
    `/reactions/${encodeURIComponent(emoji)}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
      'User-Agent': 'YetAnotherOverengineeredStoatBot reaction-role setup',
    },
  });

  if (response.ok) {
    return;
  }

  const responseText = await response.text().catch(() => '');
  throw new Error(
    `API call failed with status ${response.status}: ${response.statusText}` +
      (responseText ? ` (${responseText})` : '')
  );
}

function hasReaction(message, emoji: string): boolean {
  const reactions = message?.reactions;
  if (!reactions) return false;

  if (typeof reactions.has === 'function' && reactions.has(emoji)) {
    return true;
  }

  if (typeof reactions.get === 'function' && reactions.get(emoji)) {
    return true;
  }

  return Object.prototype.hasOwnProperty.call(reactions, emoji);
}

function normalizeReactionEmoji(emoji: string): string {
  const input = String(emoji || '').trim();
  const customEmojiMatch = input.match(/^<a?:[^:>]+:([A-Za-z0-9_-]+)>$/);
  return customEmojiMatch?.[1] || input;
}
