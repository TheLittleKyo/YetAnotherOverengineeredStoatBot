import { config } from '../config.js';
import { addJoinRole, clearJoinRoles, getJoinRoleIds, removeJoinRole } from '../join-roles.js';
import { requirePermission } from '../permissions.js';
import { normalizeId } from '../id-utils.js';

export async function joinRoleCommand(message, args, client) {
  const sub = String(args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  // `list` and `help` are safe for everyone; mutating subcommands need ManageRoles.
  if (sub !== 'list') {
    if (!(await requirePermission(message, client, ['ManageRoles', 'ManageRole'], 'Manage Roles'))) return;
  }

  if (sub === 'add' || sub === 'set') {
    const roleId = normalizeId(args[0]);
    if (!roleId) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}joinrole add <roleId>\`` });
      return;
    }

    const roleIds = addJoinRole(roleId, config.serverId);
    await message.channel?.send({
      content: `✅ Added join role <%${roleId}>. New members will receive: ${formatRoles(roleIds)}.`,
    });
    return;
  }

  if (sub === 'remove' || sub === 'delete') {
    const roleId = normalizeId(args[0]);
    if (!roleId) {
      await message.channel?.send({ content: `❌ Usage: \`${config.prefix}joinrole remove <roleId>\`` });
      return;
    }

    const roleIds = removeJoinRole(roleId, config.serverId);
    await message.channel?.send({
      content: `✅ Removed join role <%${roleId}>.` + (roleIds.length ? ` Remaining: ${formatRoles(roleIds)}.` : ''),
    });
    return;
  }

  if (sub === 'clear') {
    clearJoinRoles(config.serverId);
    await message.channel?.send({ content: '✅ Cleared all join roles.' });
    return;
  }

  if (sub === 'list') {
    const roleIds = getJoinRoleIds(config.serverId);
    await message.channel?.send({
      content: roleIds.length ? `# 👋 Join Roles\n\n${formatRoles(roleIds)}` : 'ℹ️ No join roles configured.',
    });
    return;
  }

  await sendHelp(message);
}

async function sendHelp(message) {
  await message.channel?.send({
    content:
      `# 👋 Join Role Help\n\n` +
      `\`${config.prefix}joinrole add <roleId>\` - Give this role to every new server member.\n` +
      `\`${config.prefix}joinrole remove <roleId>\` - Stop auto-assigning a role.\n` +
      `\`${config.prefix}joinrole list\` - List configured join roles.\n` +
      `\`${config.prefix}joinrole clear\` - Remove all configured join roles.`,
  });
}

function formatRoles(roleIds: string[]) {
  return roleIds.map((roleId) => `<%${roleId}>`).join(', ');
}
