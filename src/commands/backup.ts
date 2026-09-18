import { basename } from 'path';
import { config } from '../config.js';
import { createServerBackup, importServerBackup, listBackupFiles, resolveBackupFile } from '../backup.js';
import { formatBackupPreview, previewServerBackup } from '../backup-preview.js';
import { canManageServerById, requirePermissionInServer } from '../permissions.js';
import { normalizeMentionOrId } from '../id-utils.js';

export async function backupCommand(message, args, client) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({
      content: 'You need Manage Server permission to export or import server backups.',
    });
    return;
  }

  if (sub === 'export' || sub === 'save') {
    const parsed = await parseOptionalServerAndName(client, args, message?.serverId || config.serverId);
    const serverId = parsed.serverId;
    // Authorize against the server actually being exported — `canManageServer`
    // above only proves rights in the server the command was typed in.
    if (!(await requirePermissionInServer(message, client, serverId, ['ManageServer'], 'Manage Server'))) return;
    const name = parsed.name || undefined;
    const result = await createServerBackup(client, serverId, name);

    await message.channel?.send({
      content:
        `# Backup Exported\n\n` +
        `File: \`${basename(result.filePath)}\`\n` +
        `Channels: ${result.backup.channels.length}\n` +
        `Roles: ${result.backup.roles.length}\n` +
        `Bot data files: ${Object.keys(result.backup.botData || {}).length}\n` +
        `Transcript files: ${result.backup.transcripts.length}\n` +
        `Panel messages captured: ${result.backup.panelMessages?.length || 0}\n` +
        `Ticket messages captured: ${result.backup.ticketMessages?.length || 0}\n` +
        `Channel messages captured: ${Object.values(result.backup.channelMessages || {}).reduce((sum: number, msgs: any) => sum + (Array.isArray(msgs) ? msgs.length : 0), 0)}`,
    });
    return;
  }

  if (sub === 'import' || sub === 'restore') {
    const dryRun = args.some((arg) => ['--dry-run', '--preview'].includes(arg.toLowerCase()));
    const positional = args.filter((arg) => !arg.startsWith('--'));
    const fileArg = positional.shift();
    const parsedTarget = await parseOptionalServerAndName(client, positional, message?.serverId || config.serverId);
    const targetServerId = parsedTarget.serverId;

    if (!(await requirePermissionInServer(message, client, targetServerId, ['ManageServer'], 'Manage Server'))) return;

    if (!fileArg) {
      await sendHelp(message, 'Missing backup file. Use `backup list` to see saved backups.');
      return;
    }

    if (!dryRun && !args.some((arg) => ['--confirm', '--yes', '-y'].includes(arg.toLowerCase()))) {
      await message.channel?.send({
        content:
          `This will create channels, roles, permissions, and overwrite local bot feature JSON for server \`${targetServerId}\`.\n` +
          `Run again with \`--confirm\` to restore, or \`--dry-run\` to preview.`,
      });
      return;
    }

    const filePath = resolveBackupFile(fileArg);
    const summary = await importServerBackup(client, filePath, targetServerId, { dryRun });

    await message.channel?.send({
      content:
        `# Backup ${dryRun ? 'Preview' : 'Import'} Complete\n\n` +
        `Source server: \`${summary.sourceServerId}\`\n` +
        `Target server: \`${summary.targetServerId}\`\n` +
        `Channels ${dryRun ? 'to create' : 'created'}: ${summary.createdChannels}\n` +
        `Roles ${dryRun ? 'to create' : 'created'}: ${summary.createdRoles}\n` +
        `Permission targets ${dryRun ? 'to apply' : 'applied'}: ${summary.appliedPermissionTargets}\n` +
        `Bot data files ${dryRun ? 'to write' : 'written'}: ${summary.botDataFilesWritten}\n` +
        `Transcript files ${dryRun ? 'to write' : 'written'}: ${summary.transcriptFilesWritten}\n` +
        `Panel messages ${dryRun ? 'to recreate' : 'recreated'}: ${summary.recreatedPanelMessages}\n` +
        `Ticket messages ${dryRun ? 'to recreate' : 'recreated'}: ${summary.recreatedTicketMessages}\n` +
        `Channel messages ${dryRun ? 'to recreate' : 'recreated'}: ${summary.recreatedChannelMessages}\n` +
        `Bot role: ${summary.botRoleId === '<would find-or-create>' ? 'YetAnotherOverengineeredStoatBot (would be created/assigned)' : `YetAnotherOverengineeredStoatBot (assigned: ${summary.botRoleAssigned ? 'yes' : 'no'})`}` +
        formatWarnings(summary.warnings),
    });
    return;
  }

  // `preview` diffs a backup against the live target, rather than counting what
  // the file holds the way `import --dry-run` does.
  if (sub === 'preview' || sub === 'diff') {
    const positional = args.filter((arg) => !arg.startsWith('--'));
    const fileArg = positional.shift();
    const parsedTarget = await parseOptionalServerAndName(client, positional, message?.serverId || config.serverId);
    const targetServerId = parsedTarget.serverId;

    if (!(await requirePermissionInServer(message, client, targetServerId, ['ManageServer'], 'Manage Server'))) return;
    if (!fileArg) {
      await sendHelp(message, 'Missing backup file. Use `backup list` to see saved backups.');
      return;
    }

    const preview = await previewServerBackup(client, resolveBackupFile(fileArg), targetServerId);
    await message.channel?.send({ content: formatBackupPreview(preview) });
    return;
  }

  if (sub === 'list') {
    const files = listBackupFiles().slice(0, 10);
    await message.channel?.send({
      content: files.length
        ? `# Backup Files\n\n${files.map((file) => `- \`${file}\``).join('\n')}`
        : 'No backup files found in `data/backups`.',
    });
    return;
  }

  await sendHelp(message, `Unknown backup subcommand: \`${sub}\`.`);
}

async function sendHelp(message, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# Backup Commands\n\n` +
      `- \`${config.prefix}backup export [serverId] [name]\` - Save channels, roles, permissions, bot data, and transcripts to \`data/backups\`\n` +
      `- \`${config.prefix}backup import <file> [targetServerId] --confirm\` - Restore into an empty server\n` +
      `- \`${config.prefix}backup import <file> [targetServerId] --dry-run\` - Preview restore counts\n` +
      `- \`${config.prefix}backup preview <file> [targetServerId]\` - Diff a backup against the live server: what already exists, what would be created, which data files get overwritten\n` +
      `- \`${config.prefix}backup list\` - Show recent backup files\n\n` +
      `Import order: channels, then roles, then permissions, then bot feature files, then panel/ticket/channel messages recreated with Masquerade. The import also creates a YetAnotherOverengineeredStoatBot role with elevated permissions and assigns it to the bot — to revoke or adjust the bot's access, delete or edit the YetAnotherOverengineeredStoatBot role in Server Settings → Roles.`,
  });
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}

async function parseOptionalServerAndName(client, args, fallbackServerId) {
  const tokens = [...(args || [])].filter(Boolean);
  const candidate = normalizeMentionOrId(tokens[0]);

  if (candidate && await serverExists(client, candidate)) {
    return {
      serverId: candidate,
      name: tokens.slice(1).join('-'),
    };
  }

  return {
    serverId: fallbackServerId,
    name: tokens.join('-'),
  };
}

async function serverExists(client, serverId) {
  if (!serverId) return false;
  if (client?.servers?.cache?.get?.(serverId)) return true;
  return !!(await client?.servers?.fetch?.(serverId).catch(() => null));
}

function formatWarnings(warnings) {
  if (!warnings?.length) return '';
  return `\n\nWarnings:\n${warnings.slice(0, 8).map((warning) => `- ${warning}`).join('\n')}`;
}
