import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { File as NodeFile } from 'node:buffer';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';
import { fileURLToPath } from 'url';
import { MessageEmbed } from 'stoatbot.js';
import { config, env, updateTicketRuntimeConfig } from './config.js';
import { Permission } from './permissions.js';
import { refreshStatsChannels } from './stats.js';
import { getApiBaseUrl, DEFAULT_API_URL } from './stoat-api.js';
import { sleep } from './async-utils.js';
import { DATA_DIR, flushDataFiles, readDataFileContent, reloadDataFile, writeDataFileContent } from './json-store.js';
import { redetectModules } from './modules.js';

type PermissionOverride = { a: string; d: string };
type ApiPermissionOverride = { allow: number; deny: number };

type BackupChannel = {
  id: string;
  type?: string;
  name: string;
  description?: string | null;
  mature?: boolean;
  voice?: unknown;
  defaultPermissions?: PermissionOverride | null;
  rolePermissions?: Record<string, PermissionOverride>;
};

type BackupAttachment = {
  filename?: string;
  url?: string;
  contentType?: string;
  size?: number;
};

type BackupMessageReply = {
  id: string;
  mention: boolean;
};

export type BackupChannelMessage = {
  id: string;
  authorId?: string;
  authorName: string;
  avatarUrl?: string;
  content?: string;
  embeds: BackupEmbed[];
  attachments: BackupAttachment[];
  replies: BackupMessageReply[];
  reactions: string[];
  createdAt: string;
  isSystem?: boolean;
  systemContent?: string;
};

type BackupRole = {
  id: string;
  name: string;
  permissions?: PermissionOverride;
  colour?: string | null;
  hoist?: boolean;
  rank?: number;
};

type BackupCategory = {
  id: string;
  title: string;
  channels: string[];
};

type BackupEmbed = {
  title?: string;
  description?: string;
  url?: string;
  colour?: string;
  color?: string;
  // Embedded media (image/video) and icon URLs, captured so images survive copy.
  image?: string;
  icon?: string;
};

type BackupPanelMessage = {
  // Original message ID in the source server (used to match reaction-roles.json entries)
  sourceMessageId: string;
  sourceChannelId: string;
  // Channel name + emoji -> role mapping snapshot at backup time
  channelName: string;
  content?: string;
  embeds: BackupEmbed[];
  reactions: string[];
  mappings: Array<{ emoji: string; roleId: string }>;
};

type BackupTicketMessage = {
  // Original ticket ID (e.g. "0001")
  ticketId: string;
  // Original channel ID in the source server
  sourceChannelId: string;
  channelName: string;
  content?: string;
  embeds: BackupEmbed[];
};

export type ServerBackup = {
  format: 'yaosb.stoat.server-backup';
  version: 1;
  createdAt: string;
  sourceServerId: string;
  sourceServerName?: string;
  server: {
    name?: string;
    description?: string | null;
    categories: BackupCategory[];
    systemMessages?: Record<string, string | null>;
    defaultPermissions?: string;
  };
  channels: BackupChannel[];
  roles: BackupRole[];
  botData: Record<string, unknown>;
  transcripts: Array<{ fileName: string; content: string }>;
  // Captured so they can be recreated with Masquerade during restore.
  panelMessages?: BackupPanelMessage[];
  ticketMessages?: BackupTicketMessage[];
  // Every message from every text channel, captured for full Masquerade replay.
  // Keyed by original channel ID so restore can fan them out to new channels.
  channelMessages?: Record<string, BackupChannelMessage[]>;
};

export type ImportSummary = {
  dryRun: boolean;
  sourceServerId: string;
  targetServerId: string;
  createdChannels: number;
  createdRoles: number;
  appliedPermissionTargets: number;
  botDataFilesWritten: number;
  transcriptFilesWritten: number;
  recreatedPanelMessages: number;
  recreatedTicketMessages: number;
  recreatedChannelMessages: number;
  // ID of the YetAnotherOverengineeredStoatBot role (found or created) that grants the bot elevated
  // permissions on the target server. null if role setup failed.
  botRoleId: string | null;
  // True if the YetAnotherOverengineeredStoatBot role was successfully assigned to the bot member.
  botRoleAssigned: boolean;
  warnings: string[];
  idMap: {
    channels: Record<string, string>;
    roles: Record<string, string>;
    categories: Record<string, string>;
    // Original message ID -> new message ID, for post-restore bot data updates
    messages: Record<string, string>;
  };
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = join(DATA_DIR, 'backups');
const TEMP_DIR = join(__dirname, '..', 'temp');

export const BOT_DATA_FILES = [
  'bot-permissions.json',
  'config.json',
  'counter.json',
  'custom-embeds.json',
  'join-roles.json',
  'log-config.json',
  'reaction-roles.json',
  'stats-channels.json',
  'ticket-cooldowns.json',
  'tickets.json',
  'welcome-images.json',
  'welcome.json',
  // Community / moderation features. Their stores are keyed by server and hold
  // channel and role ids, so they go through the same id remapping as the rest
  // when a backup is restored into a different server.
  'moderation.json',
  'automod.json',
  'tags.json',
  'economy.json',
  'birthdays.json',
  'tempvoice.json',
];

/**
 * Data files that hold every server's data side by side. A restore replaces
 * only the target server's part of these, so restoring one server's backup
 * cannot roll back another server's balances, cases or tags.
 */
export const SERVER_SCOPED_DATA_FILES = new Set([
  'moderation.json',
  'automod.json',
  'tags.json',
  'economy.json',
  'birthdays.json',
  'tempvoice.json',
]);

export async function createServerBackup(client: any, serverId = config.serverId, name?: string) {
  if (!serverId) throw new Error('Missing server ID.');

  backupLog(`Export requested for server ${serverId}${name ? ` with name "${name}"` : ''}.`);
  const server = await resolveServer(client, serverId);
  if (!server) throw new Error(`Server ${serverId} was not found.`);

  backupLog(`Resolved server: ${firstString(server?.name) || serverId}. Fetching raw server data.`);
  const rawServer = await fetchRawServer(client, serverId);
  const channels = await collectChannels(client, server, rawServer, serverId);
  const categories = collectCategories(server, rawServer);
  const roles = collectRoles(server, rawServer);
  backupLog(`Collected structure: channels=${channels.length}, categories=${categories.length}, roles=${roles.length}.`);

  const panelMessages = await collectPanelMessages(client, serverId);
  const ticketMessages = await collectTicketMessages(client);
  backupLog(`Captured messages: panels=${panelMessages.length}, ticketChannels=${ticketMessages.length}.`);

  // Capture every message in every text channel for full Masquerade replay.
  // This is the slow step: 100 messages per batch, up to 5000 per channel.
  const channelMessages = await collectAllChannelMessages(client, serverId, channels);
  const totalChannelMessages = Object.values(channelMessages).reduce((sum: number, msgs: BackupChannelMessage[]) => sum + msgs.length, 0);
  backupLog(`Captured channel messages: ${totalChannelMessages} across ${Object.keys(channelMessages).length} channel(s).`);

  const backup: ServerBackup = {
    format: 'yaosb.stoat.server-backup',
    version: 1,
    createdAt: new Date().toISOString(),
    sourceServerId: serverId,
    sourceServerName: firstString(server?.name, rawServer?.name),
    server: {
      name: firstString(server?.name, rawServer?.name),
      description: firstNullableString(server?.description, rawServer?.description),
      categories,
      systemMessages: rawServer?.system_messages || server?.systemMessages || undefined,
      defaultPermissions: stringifyBigintLike(rawServer?.default_permissions ?? server?.defaultPermissions),
    },
    channels,
    roles,
    botData: readBotDataFilesFlushed(),
    transcripts: readTranscriptFiles(),
    panelMessages,
    ticketMessages,
    channelMessages,
  };
  backupLog(`Collected bot data: files=${Object.keys(backup.botData || {}).length}, transcripts=${backup.transcripts.length}.`);

  ensureDir(BACKUP_DIR);
  const safeName = sanitizeFilePart(name || backup.sourceServerName || serverId);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(BACKUP_DIR, `${stamp}-${safeName}.json`);
  writeJsonFile(filePath, backup);
  backupLog(`Export complete: ${filePath}`);

  return {
    filePath,
    backup,
  };
}

export async function importServerBackup(client: any, backupPath: string, targetServerId = config.serverId, options = { dryRun: false }) {
  if (!targetServerId) throw new Error('Missing target server ID.');

  backupLog(`Import requested: file=${backupPath}, target=${targetServerId}, dryRun=${!!options?.dryRun}.`);
  const backup = readBackupFile(backupPath);
  backupLog(
    `Loaded backup from ${backup.sourceServerName || backup.sourceServerId}: ` +
    `channels=${backup.channels.length}, roles=${backup.roles.length}, botData=${Object.keys(backup.botData || {}).length}, transcripts=${backup.transcripts?.length || 0}.`
  );
  const targetServer = await resolveServer(client, targetServerId);
  if (!targetServer) throw new Error(`Target server ${targetServerId} was not found.`);
  backupLog(`Resolved target server: ${firstString(targetServer?.name) || targetServerId}.`);

  const summary: ImportSummary = {
    dryRun: !!options?.dryRun,
    sourceServerId: backup.sourceServerId,
    targetServerId,
    createdChannels: 0,
    createdRoles: 0,
    appliedPermissionTargets: 0,
    botDataFilesWritten: 0,
    transcriptFilesWritten: 0,
    recreatedPanelMessages: 0,
    recreatedTicketMessages: 0,
    recreatedChannelMessages: 0,
    botRoleId: null,
    botRoleAssigned: false,
    warnings: [],
    idMap: {
      channels: {},
      roles: {},
      categories: {},
      messages: {},
    },
  };

  if (summary.dryRun) {
    summary.createdChannels = backup.channels.length;
    summary.createdRoles = backup.roles.length;
    summary.appliedPermissionTargets = backup.channels.length + backup.roles.length + 1;
    summary.botDataFilesWritten = Object.keys(backup.botData || {}).length;
    summary.transcriptFilesWritten = backup.transcripts?.length || 0;
    summary.recreatedPanelMessages = backup.panelMessages?.length || 0;
    summary.recreatedTicketMessages = backup.ticketMessages?.length || 0;
    const channelMessageCount = Object.values(backup.channelMessages || {}).reduce((sum: number, msgs: any) => sum + (Array.isArray(msgs) ? msgs.length : 0), 0);
    summary.recreatedChannelMessages = channelMessageCount;
    // Dry-run reports what WOULD happen with the YetAnotherOverengineeredStoatBot role.
    summary.botRoleId = '<would find-or-create>';
    summary.botRoleAssigned = true;
    backupLog(
      `Dry run complete: channels=${summary.createdChannels}, roles=${summary.createdRoles}, ` +
      `permissionTargets=${summary.appliedPermissionTargets}, botDataFiles=${summary.botDataFilesWritten}, transcripts=${summary.transcriptFilesWritten}, ` +
      `panelMessages=${summary.recreatedPanelMessages}, ticketMessages=${summary.recreatedTicketMessages}, channelMessages=${channelMessageCount}, botRole=YetAnotherOverengineeredStoatBot (would assign).`
    );
    return summary;
  }

  backupLog('Import stage 1/4: creating channels.');
  const createdChannels = await importChannelsFirst(targetServer, backup, summary);
  backupLog(`Import stage 1/4 complete: createdChannels=${summary.createdChannels}.`);
  backupLog('Import stage 2/4: creating roles.');
  await importRolesSecond(targetServer, backup, summary);
  backupLog(`Import stage 2/4 complete: createdRoles=${summary.createdRoles}.`);
  backupLog('Import stage 3/4: applying permissions + ensuring YetAnotherOverengineeredStoatBot bot role.');
  await applyPermissionsThird(targetServer, backup, summary, createdChannels, client);
  backupLog(`Import stage 3/4 complete: appliedPermissionTargets=${summary.appliedPermissionTargets}, botRoleId=${summary.botRoleId}, botRoleAssigned=${summary.botRoleAssigned}.`);
  backupLog('Import stage 4/4: restoring bot feature data.');
  await restoreBotFeatures(client, backup, summary);
  backupLog(
    `Import complete: channels=${summary.createdChannels}, roles=${summary.createdRoles}, ` +
    `permissionTargets=${summary.appliedPermissionTargets}, botDataFiles=${summary.botDataFilesWritten}, ` +
    `transcripts=${summary.transcriptFilesWritten}, panelMessages=${summary.recreatedPanelMessages}, ` +
    `ticketMessages=${summary.recreatedTicketMessages}, channelMessages=${summary.recreatedChannelMessages}, ` +
    `botRoleId=${summary.botRoleId}, botRoleAssigned=${summary.botRoleAssigned}, warnings=${summary.warnings.length}.`
  );

  return summary;
}

export function listBackupFiles() {
  ensureDir(BACKUP_DIR);
  return readdirSync(BACKUP_DIR)
    .filter((file) => file.toLowerCase().endsWith('.json'))
    .map((file) => join(BACKUP_DIR, file))
    .sort()
    .reverse();
}

export function resolveBackupFile(input: string) {
  const value = String(input || '').trim();
  if (!value) throw new Error('Missing backup file path.');

  // Only ever a plain file name inside BACKUP_DIR. The input reaches here from
  // chat commands and the local editor API, so anything that could escape the
  // directory (absolute paths, `..`, separators, drive letters) is rejected
  // rather than normalized — an escape would turn "import a backup" into
  // "read and apply an arbitrary JSON file from this machine".
  if (value !== basename(value) || /[\\/]|^\.\.?$|^[A-Za-z]:/.test(value)) {
    throw new Error('Backup file must be a file name inside the backups directory.');
  }

  const backupDirResolved = resolve(BACKUP_DIR);
  const candidates = [join(backupDirResolved, value), join(backupDirResolved, `${value}.json`)].map((entry) => resolve(entry));

  const found = candidates.find((candidate) => {
    const relative_ = relative(backupDirResolved, candidate);
    if (relative_.startsWith('..') || isAbsolute(relative_)) return false;
    return existsSync(candidate);
  });
  if (!found) throw new Error(`Backup file not found: ${value}`);

  return found;
}

async function importChannelsFirst(targetServer: any, backup: ServerBackup, summary: ImportSummary) {
  const createdChannels = new Map<string, any>();
  let index = 0;

  for (const channel of backup.channels) {
    index += 1;
    backupLog(`Creating channel ${index}/${backup.channels.length}: ${channel.name} (${channel.type || 'Text'}).`);
    let created: any;
    try {
      created = await createServerChannel(targetServer, {
        type: isVoiceChannelType(channel.type) ? 'Voice' : 'Text',
        name: channel.name || 'imported-channel',
        description: channel.description ?? undefined,
        nsfw: channel.mature ?? undefined,
        voice: channel.voice ?? undefined,
      });
    } catch (error) {
      throwBackupOperationError(`Create channel "${channel.name}"`, error);
    }

    if (created?.id) {
      summary.idMap.channels[channel.id] = created.id;
      createdChannels.set(channel.id, created);
      summary.createdChannels += 1;
      backupLog(`Created channel "${channel.name}": ${channel.id} -> ${created.id}.`);
    } else {
      summary.warnings.push(`Channel ${channel.id} (${channel.name}) did not return a new ID.`);
      backupWarn(`Channel "${channel.name}" did not return a new ID.`);
    }
  }

  backupLog('Restoring server categories.');
  await restoreCategories(targetServer, backup, summary);
  return createdChannels;
}

async function importRolesSecond(targetServer: any, backup: ServerBackup, summary: ImportSummary) {
  const rolesByRank = [...backup.roles].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
  let index = 0;

  for (const role of rolesByRank) {
    index += 1;
    backupLog(`Creating role ${index}/${rolesByRank.length}: ${role.name}.`);
    let created: any;
    try {
      created = await createServerRole(targetServer, role.name || 'Imported Role');
    } catch (error) {
      throwBackupOperationError(`Create role "${role.name}"`, error);
    }
    const newRoleId = created?.id || created?.role?.id;

    if (!newRoleId) {
      summary.warnings.push(`Role ${role.id} (${role.name}) did not return a new ID.`);
      backupWarn(`Role "${role.name}" did not return a new ID.`);
      continue;
    }

    summary.idMap.roles[role.id] = newRoleId;
    summary.createdRoles += 1;
    backupLog(`Created role "${role.name}": ${role.id} -> ${newRoleId}.`);

    await editServerRole(targetServer, newRoleId, {
      name: role.name,
      colour: role.colour ?? undefined,
      hoist: role.hoist ?? undefined,
      rank: role.rank ?? undefined,
    }).catch((error: any) => {
      summary.warnings.push(`Could not edit imported role ${role.name}: ${readableError(error)}`);
      backupWarn(`Could not edit imported role "${role.name}": ${readableError(error)}`);
    });
  }

  const newOrdering = await buildTargetRoleOrdering(targetServer, rolesByRank, summary);
  if (newOrdering.length > 0) {
    backupLog(`Restoring role ordering for ${newOrdering.length} roles.`);
    await setServerRoleOrdering(targetServer, newOrdering).catch((error: any) => {
      const detail = readableError(error);
      summary.warnings.push(
        `Could not restore role ordering: ${detail}. ` +
        'Imported roles were still created; adjust their order manually if Stoat rejected rank editing.'
      );
      backupWarn(`Could not restore role ordering: ${detail}`);
    });
  }
}

async function applyPermissionsThird(
  targetServer: any,
  backup: ServerBackup,
  summary: ImportSummary,
  createdChannels: Map<string, any>,
  client?: any,
) {
  if (backup.server.defaultPermissions) {
    backupLog('Applying default server permissions.');
    await setServerPermissions(targetServer, undefined, Number(backup.server.defaultPermissions)).then(() => {
      summary.appliedPermissionTargets += 1;
    }).catch((error: any) => {
      summary.warnings.push(`Could not restore default server permissions: ${readableError(error)}`);
      backupWarn(`Could not restore default server permissions: ${readableError(error)}`);
    });
  }

  backupLog('Applying role permissions.');
  for (const role of backup.roles) {
    const newRoleId = summary.idMap.roles[role.id];
    if (!newRoleId || !role.permissions) continue;
    const permissions = toApiPermissionOverride(role.permissions);
    if (isEmptyPermissionOverride(permissions)) continue;

    await setServerPermissions(targetServer, newRoleId, permissions).then(() => {
      summary.appliedPermissionTargets += 1;
    }).catch((error: any) => {
      summary.warnings.push(`Could not restore permissions for role ${role.name}: ${readableError(error)}`);
      backupWarn(`Could not restore permissions for role "${role.name}": ${readableError(error)}`);
    });
  }

  backupLog('Applying channel permission overwrites.');
  for (const channelSnapshot of backup.channels) {
    const newChannelId = summary.idMap.channels[channelSnapshot.id];
    if (!newChannelId) continue;

    const channel = createdChannels.get(channelSnapshot.id) || await resolveChannelFromServer(targetServer, newChannelId);
    if (!channel) {
      summary.warnings.push(`Could not find imported channel ${newChannelId} to restore permissions.`);
      backupWarn(`Could not find imported channel ${newChannelId} to restore permissions.`);
      continue;
    }

    if (channelSnapshot.defaultPermissions) {
      const defaultPermissions = toApiPermissionOverride(channelSnapshot.defaultPermissions);
      if (isEmptyPermissionOverride(defaultPermissions)) continue;

      await setChannelPermissions(channel, undefined, defaultPermissions).then(() => {
        summary.appliedPermissionTargets += 1;
      }).catch((error: any) => {
        summary.warnings.push(`Could not restore default permissions for ${channelSnapshot.name}: ${readableError(error)}`);
        backupWarn(`Could not restore default permissions for "${channelSnapshot.name}": ${readableError(error)}`);
      });
    }

    for (const [oldRoleId, override] of Object.entries(channelSnapshot.rolePermissions || {})) {
      const newRoleId = summary.idMap.roles[oldRoleId];
      if (!newRoleId) continue;
      const permissions = toApiPermissionOverride(override);
      if (isEmptyPermissionOverride(permissions)) continue;

      await setChannelPermissions(channel, newRoleId, permissions).then(() => {
        summary.appliedPermissionTargets += 1;
      }).catch((error: any) => {
        const detail = readableError(error);
        const roleName = backup.roles.find((r) => r.id === oldRoleId)?.name || oldRoleId;
        const hint = isAuthOrElevationFailure(detail)
          ? ` The bot lacks Manage Permissions, or its role is below the "${roleName}" role in the target server's role hierarchy. Drag the bot role above it in Server Settings > Roles, then re-run the import.`
          : '';
        summary.warnings.push(`Could not restore channel role permissions for ${channelSnapshot.name} (role "${roleName}"): ${detail}.${hint}`);
        backupWarn(`Could not restore channel role permissions for "${channelSnapshot.name}" (role "${roleName}"): ${detail}${hint}`);
      });
    }
  }

  // After all backup permissions are restored, ensure the bot itself has a
  // YetAnotherOverengineeredStoatBot role with elevated server-level permissions. This role is NOT in
  // the backup, so no channel has a deny override for it — the server-level
  // allow applies everywhere automatically, letting the bot send messages
  // and manage channels during stage 4 (bot feature restore).
  if (client) {
    await ensureYetAnotherOverengineeredStoatBotRole(client, targetServer, backup, summary);
  } else {
    summary.warnings.push('YetAnotherOverengineeredStoatBot bot role setup skipped: client not available to assign role to bot.');
    backupWarn('YetAnotherOverengineeredStoatBot bot role setup skipped: client not available.');
  }
}

async function restoreBotFeatures(client: any, backup: ServerBackup, summary: ImportSummary) {
  backupLog('Remapping bot feature data IDs.');
  const remappedData = remapBotData(backup, summary);

  ensureDir(DATA_DIR);
  // Pending debounced writes land first, so the merge below starts from the
  // current data and the flush cannot overwrite the restore afterwards.
  flushDataFiles();
  for (const [fileName, data] of Object.entries(remappedData)) {
    if (!BOT_DATA_FILES.includes(fileName)) continue;
    const next = SERVER_SCOPED_DATA_FILES.has(fileName)
      ? mergeServerScopedData(fileName, readDataFileOr(fileName, {}), data, summary.targetServerId)
      : data;
    if (next === null) {
      backupLog(`Skipped ${fileName}: the backup holds nothing for this server.`);
      continue;
    }
    // Through json-store: economy and moderation live in SQLite, not in files.
    writeDataFileContent(fileName, next);
    // Modules that keep this file in memory reload it, or their next save
    // would put the pre-restore data back.
    reloadDataFile(fileName);
    summary.botDataFilesWritten += 1;
    backupLog(`Restored bot data file: ${fileName}.`);
  }

  // A restore onto a fresh install brings setup for modules that start off.
  // Switch those on, unless the owner set them by hand.
  const switchedOn = redetectModules();
  if (switchedOn.length) backupLog(`Switched on modules with restored setup: ${switchedOn.join(', ')}.`);

  const runtimeConfig = remappedData['config.json'];
  if (runtimeConfig && typeof runtimeConfig === 'object') {
    updateTicketRuntimeConfig(runtimeConfig as any);
  }

  ensureDir(TEMP_DIR);
  for (const transcript of backup.transcripts || []) {
    if (!transcript?.fileName || typeof transcript.content !== 'string') continue;
    writeFileSync(join(TEMP_DIR, sanitizeFilePart(transcript.fileName, '.html')), transcript.content, 'utf-8');
    summary.transcriptFilesWritten += 1;
  }
  backupLog(`Restored transcript files: ${summary.transcriptFilesWritten}.`);

  // Recreate reaction-role panel messages and ticket channel initial messages
  // using Masquerade so they appear as the bot's own messages (same name/avatar).
  await recreatePanelMessages(client, backup, summary);
  await recreateTicketMessages(client, backup, summary);
  // Replay every captured channel message with per-message Masquerade
  // (copies the original author's name + avatar URL).
  await recreateChannelMessages(client, backup, summary);

  // After recreation, the bot data files we just wrote still reference the OLD
  // message IDs. Re-read them, remap to the new IDs, and write back.
  if (Object.keys(summary.idMap.messages).length > 0) {
    rewriteBotDataWithNewMessageIds(summary);
  }

  await refreshStatsChannels(client, summary.targetServerId).catch((error: any) => {
    summary.warnings.push(`Stats refresh after import failed: ${readableError(error)}`);
    backupWarn(`Stats refresh after import failed: ${readableError(error)}`);
  });
}

async function restoreCategories(targetServer: any, backup: ServerBackup, summary: ImportSummary) {
  const categories = backup.server.categories
    .filter((category) => category.id && category.id !== 'default')
    .map((category) => {
      const nextId = createCategoryId(category.id, summary.idMap.categories);
      return {
        id: nextId,
        title: category.title || 'Imported',
        channels: category.channels.map((id) => summary.idMap.channels[id]).filter(Boolean),
      };
    });

  if (categories.length === 0) return;

  backupLog(`Applying ${categories.length} categories.`);
  const result = await editServerCategories(targetServer, categories);
  if (result.ok) {
    backupLog(`Categories restored with ${result.method}.`);
    return;
  }

  const warning = `Could not restore categories: ${'reason' in result ? result.reason : 'Unknown category restore failure'}`;
  summary.warnings.push(warning);
  backupWarn(warning);
}

async function createServerChannel(targetServer: any, data: any) {
  if (typeof targetServer?.createChannel === 'function') {
    return targetServer.createChannel(data);
  }

  if (typeof targetServer?.channels?.create === 'function') {
    return targetServer.channels.create(data);
  }

  const api = getApi(targetServer);
  const payload = {
    name: data.name,
    type: data.type,
    description: data.description,
    nsfw: data.nsfw,
    voice: data.voice,
  };
  return apiPost(api, `/servers/${targetServer.id}/channels`, payload);
}

async function createServerRole(targetServer: any, name: string) {
  if (typeof targetServer?.createRole === 'function') {
    return targetServer.createRole(name);
  }

  if (typeof targetServer?.roles?.create === 'function') {
    return targetServer.roles.create(name);
  }

  const api = getApi(targetServer);
  const created = await apiPost(api, `/servers/${targetServer.id}/roles`, { name });
  return created?.role ? { id: created.id, ...created.role } : created;
}

async function editServerRole(targetServer: any, roleId: string, data: any) {
  if (typeof targetServer?.editRole === 'function') {
    return targetServer.editRole(roleId, data);
  }

  if (typeof targetServer?.roles?.edit === 'function') {
    return targetServer.roles.edit(roleId, data);
  }

  return apiPatch(getApi(targetServer), `/servers/${targetServer.id}/roles/${roleId}`, data);
}

async function setServerRoleOrdering(targetServer: any, roleIds: string[]) {
  if (typeof targetServer?.setRoleOrdering === 'function') {
    return targetServer.setRoleOrdering(roleIds);
  }

  return apiPatch(getApi(targetServer), `/servers/${targetServer.id}/roles/ranks`, { ranks: roleIds });
}

async function editServer(targetServer: any, data: any) {
  if (typeof targetServer?.edit === 'function') {
    return targetServer.edit(data);
  }

  if (typeof targetServer?.client?.servers?.edit === 'function') {
    return targetServer.client.servers.edit(targetServer.id, data);
  }

  return apiPatch(getApi(targetServer), `/servers/${targetServer.id}`, data);
}

async function editServerCategories(
  targetServer: any,
  categories: Array<{ id: string; title: string; channels: string[] }>,
): Promise<{ ok: true; method: string } | { ok: false; reason: string }> {
  try {
    await editServer(targetServer, { categories });
    return { ok: true, method: 'bot token' };
  } catch (error) {
    const botReason = readableError(error);
    if (!isAuthOrElevationFailure(botReason)) {
      return { ok: false, reason: botReason };
    }

    backupWarn(`Bot-token category edit failed: ${botReason}`);
    const sessionToken = getSessionToken();
    if (!sessionToken) {
      return {
        ok: false,
        reason:
          `${botReason}. Stoat often requires a user session token for category ordering. ` +
          'Set SESSION_TOKEN or STOAT_SESSION_TOKEN in .env, restart the bot, then run the import again.',
      };
    }

    const sessionResult = await editServerCategoriesWithSessionToken(targetServer, categories, sessionToken);
    if (sessionResult.ok) {
      return { ok: true, method: 'session token fallback' };
    }

    return {
      ok: false,
      reason: `${botReason}. Session-token fallback also failed: ${'reason' in sessionResult ? sessionResult.reason : 'Unknown session-token failure'}`,
    };
  }
}

async function editServerCategoriesWithSessionToken(
  targetServer: any,
  categories: Array<{ id: string; title: string; channels: string[] }>,
  sessionToken: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const apiBase = getApiBaseUrl(targetServer?.client || targetServer);

  try {
    const response = await fetch(`${apiBase}/servers/${targetServer.id}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Token': sessionToken,
        'User-Agent': 'YetAnotherOverengineeredStoatBot/1.0.0',
      },
      body: JSON.stringify({ categories }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}${body ? `: ${summarizeText(body)}` : ''}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: readableError(error) };
  }
}

async function setServerPermissions(targetServer: any, roleId: string | undefined, permissions: number | ApiPermissionOverride) {
  if (typeof targetServer?.setPermissions === 'function') {
    return targetServer.setPermissions(roleId, permissions);
  }

  const api = getApi(targetServer);
  if (!roleId) {
    const value = typeof permissions === 'number' ? permissions : permissions.allow;
    return apiPut(api, `/servers/${targetServer.id}/permissions/default`, { permissions: value });
  }

  const override = typeof permissions === 'number'
    ? { allow: permissions, deny: 0 }
    : permissions;
  return apiPut(api, `/servers/${targetServer.id}/permissions/${roleId}`, { permissions: override });
}

async function setChannelPermissions(channel: any, roleId: string | undefined, permissions: ApiPermissionOverride) {
  // Try the SDK method first.
  if (typeof channel?.setPermissions === 'function') {
    try {
      return await channel.setPermissions(roleId, permissions);
    } catch (error: any) {
      const detail = readableError(error);
      // If it's a 403/NotElevated, fall through to the direct-API retry below.
      // Other errors (400 validation, 404 missing channel) should propagate.
      if (!isAuthOrElevationFailure(detail)) throw error;
      backupWarn(`channel.setPermissions returned "${detail}" for role ${roleId || 'default'} on channel ${channel.id}; retrying via direct API with bot token.`);
    }
  }

  // SDK method missing or returned 403 — try the raw REST endpoint via the
  // SDK's api wrapper (uses the bot's authenticated session).
  try {
    const api = getApi(channel);
    const target = roleId || 'default';
    return await apiPut(api, `/channels/${channel.id}/permissions/${target}`, { permissions });
  } catch (sdkApiError: any) {
    const sdkDetail = readableError(sdkApiError);
    if (!isAuthOrElevationFailure(sdkDetail)) throw sdkApiError;
    // Final fallback: direct fetch() with the bot token from env.
    // This works when the SDK's internal api wrapper isn't usable but the
    // bot still has a valid token (e.g. some stoatbot.js versions don't
    // expose channel.setPermissions at all).
    const token = getBotToken(channel);
    if (!token) throw sdkApiError;
    return setChannelPermissionsViaFetch(channel.id, roleId, permissions, token);
  }
}

async function setChannelPermissionsViaFetch(channelId: string, roleId: string | undefined, permissions: ApiPermissionOverride, token: string) {
  const target = roleId || 'default';
  const baseUrl = DEFAULT_API_URL;
  const response = await fetch(
    `${baseUrl}/channels/${encodeURIComponent(channelId)}/permissions/${encodeURIComponent(target)}`,
    {
      method: 'PUT',
      headers: {
        'X-Bot-Token': token,
        'Content-Type': 'application/json',
        'User-Agent': 'YetAnotherOverengineeredStoatBot-backup-restore',
      },
      body: JSON.stringify({ permissions }),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    const detail = `API call failed with status ${response.status}: ${response.statusText}${body ? ` (${summarizeText(body)})` : ''}`;
    throw new Error(detail + getPermissionHint(detail));
  }
}

function getBotToken(source: any): string | null {
  const client = source?.client || source;
  const token = client?.token || client?.api?.authentication?.revolt || client?.api?.authentication?.rauth;
  if (typeof token === 'string' && token) return token;
  if (token && typeof token === 'object' && typeof token.token === 'string') return token.token;
  return null;
}

// ============================================================
// YetAnotherOverengineeredStoatBot bot role setup
// ============================================================

const YAOSB_ROLE_NAME = 'YetAnotherOverengineeredStoatBot';
// Name this role carried before the rename; still honoured on restore.
const LEGACY_ROLE_NAME = 'CrabGod';

// Server-level allow bitmask for the YetAnotherOverengineeredStoatBot role.
// Grants the bot everything it needs to read/write/manage during restore
// without requiring any per-channel overrides.
const YAOSB_ROLE_ALLOW = Number(
  Permission.ViewChannel |
  Permission.ReadMessageHistory |
  Permission.SendMessage |
  Permission.ManageMessages |
  Permission.SendEmbeds |
  Permission.UploadFiles |
  Permission.Masquerade |
  Permission.React
);

/**
 * Find or create a role named "YetAnotherOverengineeredStoatBot" on the target server, set its
 * server-level permissions to allow the bot everything it needs, set its
 * rank high enough to sit above all imported roles, and assign it to the bot.
 *
 * Idempotent: re-importing refreshes perms and re-assigns instead of duplicating.
 */
async function ensureYetAnotherOverengineeredStoatBotRole(client: any, targetServer: any, backup: ServerBackup, summary: ImportSummary) {
  try {
    backupLog('Ensuring YetAnotherOverengineeredStoatBot bot role exists and is assigned to the bot.');

    // 1. Find or create the role.
    const roleId = await findOrCreateBotRole(targetServer);
    if (!roleId) {
      summary.warnings.push('YetAnotherOverengineeredStoatBot bot role: could not find or create the role.');
      backupWarn('YetAnotherOverengineeredStoatBot bot role: could not find or create the role.');
      return;
    }
    summary.botRoleId = roleId;
    backupLog(`YetAnotherOverengineeredStoatBot role ID: ${roleId}.`);

    // 2. Set server-level permissions (allow=YAOSB_ROLE_ALLOW, deny=0).
    await setServerPermissions(targetServer, roleId, { allow: YAOSB_ROLE_ALLOW, deny: 0 }).then(() => {
      backupLog('YetAnotherOverengineeredStoatBot role server-level permissions set.');
    }).catch((error: any) => {
      summary.warnings.push(`YetAnotherOverengineeredStoatBot role permissions: ${readableError(error)}`);
      backupWarn(`YetAnotherOverengineeredStoatBot role permissions: ${readableError(error)}`);
    });

    // 3. Set rank high enough to sit above all imported roles.
    //    Stoat ranks: higher number = higher in hierarchy. We compute a rank
    //    one above the max imported role rank, or a sensible default.
    const targetRank = computeYetAnotherOverengineeredStoatBotRank(backup);
    await editServerRole(targetServer, roleId, { rank: targetRank }).then(() => {
      backupLog(`YetAnotherOverengineeredStoatBot role rank set to ${targetRank}.`);
    }).catch((error: any) => {
      summary.warnings.push(`YetAnotherOverengineeredStoatBot role rank: ${readableError(error)}`);
      backupWarn(`YetAnotherOverengineeredStoatBot role rank: ${readableError(error)}`);
    });

    // 4. Assign the role to the bot.
    const assigned = await assignRoleToBot(client, targetServer, roleId);
    summary.botRoleAssigned = assigned;
    if (assigned) {
      backupLog('YetAnotherOverengineeredStoatBot role assigned to the bot.');
    } else {
      summary.warnings.push('YetAnotherOverengineeredStoatBot role: could not assign to the bot (member fetch or addRole failed).');
      backupWarn('YetAnotherOverengineeredStoatBot role: could not assign to the bot.');
    }
  } catch (error: any) {
    summary.warnings.push(`YetAnotherOverengineeredStoatBot role setup failed: ${readableError(error)}`);
    backupWarn(`YetAnotherOverengineeredStoatBot role setup failed: ${readableError(error)}`);
  }
}

/**
 * Find an existing role named "YetAnotherOverengineeredStoatBot" on the target server, or create one.
 * Returns the role ID, or null on failure.
 */
async function findOrCreateBotRole(targetServer: any): Promise<string | null> {
  // Look in the server's role cache for an existing bot role. 'CrabGod' is the
  // pre-rename name — reuse it rather than leaving a stale duplicate behind.
  for (const name of [YAOSB_ROLE_NAME, LEGACY_ROLE_NAME]) {
    const existing = findRoleByName(targetServer, name);
    if (existing) {
      backupLog(`Found existing "${name}" role: ${existing}. Reusing.`);
      return existing;
    }
  }

  // Create it.
  try {
    const created = await createServerRole(targetServer, YAOSB_ROLE_NAME);
    const newId = created?.id || created?.role?.id || null;
    if (newId) {
      backupLog(`Created "${YAOSB_ROLE_NAME}" role: ${newId}.`);
    }
    return newId;
  } catch (error: any) {
    backupWarn(`Failed to create "${YAOSB_ROLE_NAME}" role: ${readableError(error)}`);
    return null;
  }
}

/**
 * Search the target server's roles for one with the given name.
 * Tries multiple stoatbot.js role-storage shapes.
 */
function findRoleByName(targetServer: any, name: string): string | null {
  const target = String(name || '').toLowerCase();
  if (!target) return null;

  const checkRole = (role: any): string | null => {
    if (!role) return null;
    const id = typeof role === 'string' ? role : (role.id || role._id);
    const roleName = typeof role === 'object' ? String(role.name || '').toLowerCase() : '';
    if (roleName === target && id) return id;
    return null;
  };

  // Map.values()
  for (const role of Array.from(targetServer?.roles?.values?.() || [])) {
    const found = checkRole(role);
    if (found) return found;
  }
  // cache.values()
  for (const role of Array.from(targetServer?.roles?.cache?.values?.() || [])) {
    const found = checkRole(role);
    if (found) return found;
  }
  // orderedRoles array
  if (Array.isArray(targetServer?.orderedRoles)) {
    for (const role of targetServer.orderedRoles) {
      const found = checkRole(role);
      if (found) return found;
    }
  }
  // Raw server roles object (id -> role)
  const rawRoles = targetServer?.roles?.cache ? null : targetServer?._roles;
  if (rawRoles && typeof rawRoles === 'object') {
    for (const [id, role] of Object.entries(rawRoles)) {
      const found = checkRole({ id, ...(role as any) });
      if (found) return found;
    }
  }

  return null;
}

/**
 * Compute a rank for the YetAnotherOverengineeredStoatBot role that sits above all imported roles.
 * Stoat ranks: higher number = higher in hierarchy.
 * Returns max(imported ranks) + 1, or a default of 9999 if no roles have ranks.
 */
function computeYetAnotherOverengineeredStoatBotRank(backup: ServerBackup): number {
  const ranks = backup.roles
    .map((r) => typeof r.rank === 'number' ? r.rank : null)
    .filter((r): r is number => r !== null && Number.isFinite(r));

  if (ranks.length === 0) return 9999;
  return Math.max(...ranks) + 1;
}

/**
 * Assign a role to the bot member on the target server.
 * Uses client.user.id -> server.members.fetch(botId) -> member.addRole(roleId).
 */
async function assignRoleToBot(client: any, targetServer: any, roleId: string): Promise<boolean> {
  try {
    const botId = client?.user?.id;
    if (!botId) {
      backupWarn('Cannot assign YetAnotherOverengineeredStoatBot role: client.user.id is not available.');
      return false;
    }

    let botMember: any = null;
    try {
      botMember = targetServer?.members?.cache?.get?.(botId) || await targetServer?.members?.fetch?.(botId);
    } catch {
      botMember = null;
    }
    if (!botMember) {
      backupWarn(`Cannot assign YetAnotherOverengineeredStoatBot role: could not fetch bot member ${botId}.`);
      return false;
    }

    // Check if the bot already has the role.
    const currentRoleIds = getBotRoleIds(botMember);
    if (currentRoleIds.includes(roleId)) {
      backupLog('Bot already has the YetAnotherOverengineeredStoatBot role.');
      return true;
    }

    // addRole — stoatbot.js ServerMember method (used in ticket-open.ts, reaction-roles.ts).
    if (typeof botMember.addRole === 'function') {
      await botMember.addRole(roleId);
      return true;
    }

    // Fallback: direct API.
    if (client?.api && typeof client.api.put === 'function') {
      await client.api.put(`/servers/${targetServer.id}/members/${botId}/roles/${roleId}`);
      return true;
    }

    backupWarn('Cannot assign YetAnotherOverengineeredStoatBot role: no addRole method or API available.');
    return false;
  } catch (error: any) {
    backupWarn(`Failed to assign YetAnotherOverengineeredStoatBot role to bot: ${readableError(error)}`);
    return false;
  }
}

function getBotRoleIds(member: any): string[] {
  const roles = member?.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles.filter((r: any) => typeof r === 'string');
  if (typeof roles.toArray === 'function') return roles.toArray().map((r: any) => r?.id || r).filter(Boolean);
  if (roles instanceof Set) return Array.from(roles).filter((r: any) => typeof r === 'string');
  if (typeof roles === 'object') return Object.keys(roles);
  return [];
}

type BotDataRemapContext = {
  backup: ServerBackup;
  summary: ImportSummary;
  replacements: Map<string, string>;
  sortedReplacements: Array<[string, string]>;
};

function remapBotData(backup: ServerBackup, summary: ImportSummary) {
  const context = createBotDataRemapContext(backup, summary);
  const result: Record<string, unknown> = {};
  for (const [fileName, data] of Object.entries(backup.botData || {})) {
    result[fileName] = applyFeatureSpecificRemaps(fileName, remapValue(data, context), context);
  }
  return result;
}

function createBotDataRemapContext(backup: ServerBackup, summary: ImportSummary): BotDataRemapContext {
  const replacements = new Map<string, string>([
    [backup.sourceServerId, summary.targetServerId],
    ...Object.entries(summary.idMap.channels),
    ...Object.entries(summary.idMap.roles),
    ...Object.entries(summary.idMap.categories),
  ]);

  for (const category of backup.server.categories || []) {
    const newCategoryId = summary.idMap.categories[category.id];
    if (newCategoryId) replacements.set(`imported-${category.id}`, newCategoryId);
  }

  return {
    backup,
    summary,
    replacements,
    sortedReplacements: Array.from(replacements.entries()).sort((a, b) => b[0].length - a[0].length),
  };
}

function remapValue(value: unknown, context: BotDataRemapContext): unknown {
  if (typeof value === 'string') return remapString(value, context);
  if (Array.isArray(value)) return value.map((entry) => remapValue(entry, context));
  if (!value || typeof value !== 'object') return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    output[remapString(key, context)] = remapValue(child, context);
  }
  return output;
}

function remapString(value: string, context: BotDataRemapContext): string {
  const exact = context.replacements.get(value) || resolveLegacyImportedCategoryId(value, context);
  if (exact) return exact;

  if (!value || value.startsWith('data:') || value.length > 20_000) return value;

  let next = value;
  for (const [oldId, newId] of context.sortedReplacements) {
    if (oldId.length < 8 || !next.includes(oldId)) continue;
    next = next.split(oldId).join(newId);
  }
  return next;
}

function applyFeatureSpecificRemaps(fileName: string, data: unknown, context: BotDataRemapContext): unknown {
  if (!data || typeof data !== 'object') return data;

  if (fileName === 'config.json') {
    return adaptRuntimeConfigData(data as Record<string, unknown>, context);
  }

  if (fileName === 'stats-channels.json') {
    return adaptStatsConfigData(data as Record<string, unknown>, context);
  }

  if (fileName === 'log-config.json') {
    return adaptSingleChannelConfig(data as Record<string, unknown>, context, ['logs', 'log']);
  }

  if (fileName === 'welcome.json') {
    return adaptServerListChannelConfig(data as Record<string, unknown>, context, ['welcome']);
  }

  if (fileName === 'welcome-images.json') {
    return adaptWelcomeImagesData(data as Record<string, unknown>, context);
  }

  if (fileName === 'tickets.json') {
    return adaptTicketsData(data as Record<string, unknown>, context);
  }

  return data;
}

function adaptRuntimeConfigData(data: Record<string, unknown>, context: BotDataRemapContext) {
  return {
    ...data,
    serverId: context.summary.targetServerId,
    openTicketsCategoryId: resolveCategorySetting(data.openTicketsCategoryId, context, ['open tickets', 'open ticket']),
    closedTicketsCategoryId: resolveCategorySetting(data.closedTicketsCategoryId, context, ['closed tickets', 'closed ticket']),
    transcriptChannelId: resolveChannelSetting(data.transcriptChannelId, context, ['transcripts', 'transcript']),
    supportRoleId: resolveRoleSetting(data.supportRoleId, context, ['staff', 'support']),
  };
}

function adaptStatsConfigData(data: Record<string, unknown>, context: BotDataRemapContext) {
  const channels = Array.isArray(data.channels) ? data.channels : [];
  return {
    ...data,
    channels: channels.map((entry: any) => {
      const label = typeof entry?.label === 'string' ? entry.label : undefined;
      return {
        ...entry,
        channelId: resolveChannelSetting(entry?.channelId, context, label ? [label] : []),
        roleId: entry?.mode === 'role' ? resolveRoleSetting(entry?.roleId, context, label ? [label] : []) : entry?.roleId,
      };
    }),
  };
}

function adaptSingleChannelConfig(data: Record<string, unknown>, context: BotDataRemapContext, fallbackNames: string[]) {
  return {
    ...data,
    channelId: resolveChannelSetting(data.channelId, context, fallbackNames),
  };
}

function adaptServerListChannelConfig(data: Record<string, unknown>, context: BotDataRemapContext, fallbackNames: string[]) {
  const servers = Array.isArray(data.servers) ? data.servers : [];
  return {
    ...data,
    servers: servers.map((entry: any) => ({
      ...entry,
      serverId: context.summary.targetServerId,
      channelId: resolveChannelSetting(entry?.channelId, context, fallbackNames),
    })),
  };
}

function adaptWelcomeImagesData(data: Record<string, unknown>, context: BotDataRemapContext) {
  const images = Array.isArray(data.images) ? data.images : [];
  return {
    ...data,
    images: images.map((entry: any) => ({
      ...entry,
      serverId: context.summary.targetServerId,
      config: entry?.config && typeof entry.config === 'object'
        ? {
          ...entry.config,
          serverId: context.summary.targetServerId,
          channelId: resolveChannelSetting(entry.config.channelId, context, ['welcome']),
        }
        : entry?.config,
    })),
  };
}

function adaptTicketsData(data: Record<string, unknown>, context: BotDataRemapContext) {
  const output: Record<string, unknown> = {};

  for (const [ticketId, rawTicket] of Object.entries(data)) {
    if (!rawTicket || typeof rawTicket !== 'object') {
      output[ticketId] = rawTicket;
      continue;
    }

    const ticket = rawTicket as Record<string, unknown>;
    const channelId = resolveTicketChannelSetting(ticket.channelId, ticketId, context);
    const ticketRoleId = resolveTicketRoleSetting(ticket.ticketRoleId, ticketId, context);
    const nextTicket: Record<string, unknown> = {
      ...ticket,
      channelId,
    };

    if (ticketRoleId) {
      nextTicket.ticketRoleId = ticketRoleId;
    } else {
      delete nextTicket.ticketRoleId;
    }

    output[ticketId] = nextTicket;
  }

  return output;
}

function resolveCategorySetting(value: unknown, context: BotDataRemapContext, fallbackTitles: string[]) {
  if (typeof value === 'string') {
    const remapped = remapString(value, context);
    if (isMappedId(remapped, context.summary.idMap.categories)) return remapped;
  }

  const byName = findMappedCategoryByTitle(context, fallbackTitles);
  return byName || (typeof value === 'string' ? remapString(value, context) : value);
}

function resolveChannelSetting(value: unknown, context: BotDataRemapContext, fallbackNames: string[]) {
  if (typeof value === 'string') {
    const remapped = remapString(value, context);
    if (isMappedId(remapped, context.summary.idMap.channels)) return remapped;
  }

  const byName = findMappedChannelByName(context, fallbackNames);
  return byName || (typeof value === 'string' ? remapString(value, context) : value);
}

function resolveRoleSetting(value: unknown, context: BotDataRemapContext, fallbackNames: string[]) {
  if (typeof value === 'string') {
    const remapped = remapString(value, context);
    if (isMappedId(remapped, context.summary.idMap.roles)) return remapped;
  }

  const byName = findMappedRoleByName(context, fallbackNames);
  return byName || (typeof value === 'string' ? remapString(value, context) : value);
}

function resolveTicketChannelSetting(value: unknown, ticketId: string, context: BotDataRemapContext) {
  if (typeof value === 'string') {
    const remapped = remapString(value, context);
    if (isMappedId(remapped, context.summary.idMap.channels)) return remapped;
  }

  const candidates = [`ticket-${ticketId}`, `closed-${ticketId}`];
  return findMappedChannelByName(context, candidates) || (typeof value === 'string' ? remapString(value, context) : value);
}

function resolveTicketRoleSetting(value: unknown, ticketId: string, context: BotDataRemapContext) {
  if (typeof value === 'string') {
    const remapped = remapString(value, context);
    if (isMappedId(remapped, context.summary.idMap.roles)) return remapped;
  }

  const byName = findMappedRoleByName(context, [`ticketrole-${ticketId}`]);
  if (byName) return byName;

  // Per-ticket roles are often temporary and may not exist in older backups. Keeping a stale
  // unmapped role ID can make later ticket cleanup/permission edits target the wrong server.
  return undefined;
}

function resolveLegacyImportedCategoryId(value: string, context: BotDataRemapContext) {
  if (!value.startsWith('imported-')) return undefined;
  const suffix = value.slice('imported-'.length);
  if (!suffix) return undefined;

  const match = (context.backup.server.categories || [])
    .find((category) => category.id !== 'default' && (category.id.startsWith(suffix) || suffix.startsWith(category.id)));
  return match ? context.summary.idMap.categories[match.id] : undefined;
}

function findMappedCategoryByTitle(context: BotDataRemapContext, titles: string[]) {
  return findUniqueMappedId(
    context.backup.server.categories || [],
    (category) => context.summary.idMap.categories[category.id],
    (category) => [category.title],
    titles,
  );
}

function findMappedChannelByName(context: BotDataRemapContext, names: string[]) {
  return findUniqueMappedId(
    context.backup.channels || [],
    (channel) => context.summary.idMap.channels[channel.id],
    (channel) => [channel.name, stripCounterSuffix(channel.name)],
    names,
  );
}

function findMappedRoleByName(context: BotDataRemapContext, names: string[]) {
  return findUniqueMappedId(
    context.backup.roles || [],
    (role) => context.summary.idMap.roles[role.id],
    (role) => [role.name, stripRoleDecorations(role.name)],
    names,
  );
}

function findUniqueMappedId<T>(
  items: T[],
  getMappedId: (item: T) => string | undefined,
  getNames: (item: T) => Array<string | undefined>,
  wantedNames: string[],
) {
  const wanted = new Set(wantedNames.map(normalizeLookupName).filter(Boolean));
  if (wanted.size === 0) return undefined;

  const matches = items
    .filter((item) => getNames(item).some((name) => wanted.has(normalizeLookupName(name))))
    .map(getMappedId)
    .filter((id): id is string => !!id);

  return uniqueIds(matches).length === 1 ? uniqueIds(matches)[0] : undefined;
}

function isMappedId(value: string, idMap: Record<string, string>) {
  return Object.values(idMap).includes(value);
}

function stripCounterSuffix(value?: string) {
  return String(value || '').replace(/:\s*\d+\s*$/, '');
}

function stripRoleDecorations(value?: string) {
  return String(value || '').split(/[|｜]/)[0];
}

function normalizeLookupName(value?: string) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/:\s*\d+\s*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .map((word) => word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word)
    .join(' ');
}

async function fetchRawServerForTarget(targetServer: any) {
  const api = targetServer?.client?.api || targetServer?.api;
  if (!api || !targetServer?.id) return null;

  try {
    return await api.get(`/servers/${targetServer.id}`, { include_channels: true });
  } catch {
    return null;
  }
}

async function resolveServer(client: any, serverId: string) {
  return client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
}

async function resolveChannelFromServer(server: any, channelId: string) {
  return server?.channels?.cache?.get?.(channelId)
    || server?.channels?.find?.((channel: any) => channel?.id === channelId)
    || (await server?.channels?.fetch?.(channelId).catch(() => null))
    || server?.client?.channels?.cache?.get?.(channelId)
    || null;
}

async function fetchRawServer(client: any, serverId: string) {
  try {
    return await client.api.get(`/servers/${serverId}`, { include_channels: true });
  } catch {
    return null;
  }
}

async function collectChannels(client: any, server: any, rawServer: any, serverId: string): Promise<BackupChannel[]> {
  const rawChannels = Array.isArray(rawServer?.channels) ? rawServer.channels : [];
  const serverChannels = Array.isArray(server?.channels) ? server.channels : [];
  const managerChannels = Array.from(server?.channels?.cache?.values?.() || []);
  const cacheChannels = Array.from(client?.channels?.cache?.values?.() || []).filter((channel: any) => channel?.serverId === serverId);
  const byId = new Map<string, any>();

  for (const channel of [...rawChannels, ...serverChannels, ...managerChannels, ...cacheChannels]) {
    const id = channel?._id || channel?.id;
    if (id) byId.set(id, channel);
  }

  return Promise.all(Array.from(byId.entries()).map(async ([id, channel]) => {
    const rawChannel = await fetchRawChannel(client, id);
    const source = rawChannel ? { ...channel, ...rawChannel } : channel;

    return {
      id,
      type: normalizeChannelType(firstString(source?.channel_type, source?.type)),
      name: firstString(source?.name, source?.displayName) || `channel-${id.slice(0, 6)}`,
      description: firstNullableString(source?.description),
      mature: Boolean(source?.nsfw ?? source?.mature),
      voice: source?.voice,
      defaultPermissions: normalizeOverride(source?.default_permissions ?? source?.defaultPermissions),
      rolePermissions: normalizeOverrideMap(source?.role_permissions ?? source?.rolePermissions),
    };
  }));
}

async function fetchRawChannel(client: any, channelId: string) {
  if (!client?.api || !channelId) return null;

  try {
    return await client.api.get(`/channels/${channelId}`);
  } catch (error) {
    backupWarn(`Could not fetch raw channel permissions for ${channelId}; using cached channel data: ${readableError(error)}`);
    return null;
  }
}

function collectCategories(server: any, rawServer: any): BackupCategory[] {
  const categories = Array.isArray(rawServer?.categories) ? rawServer.categories : Array.from(server?.categories?.values?.() || []);
  return categories
    .map((category: any) => ({
      id: String(category?.id || category?._id || ''),
      title: String(category?.title || category?.name || 'Imported'),
      channels: extractCategoryChannelIds(category),
    }))
    .filter((category) => category.id);
}

function collectRoles(server: any, rawServer: any): BackupRole[] {
  const orderedRoles = Array.isArray(server?.orderedRoles) ? server.orderedRoles : [];
  const rawRoles = rawServer?.roles && typeof rawServer.roles === 'object'
    ? Object.entries(rawServer.roles).map(([id, role]) => ({ id, ...(role as Record<string, unknown>) }))
    : [];
  const roleMapValues = [
    ...Array.from(server?.roles?.values?.() || []),
    ...Array.from(server?.roles?.cache?.values?.() || []),
  ];
  const byId = new Map<string, any>();

  for (const role of [...rawRoles, ...orderedRoles, ...roleMapValues]) {
    const id = role?.id || role?._id;
    if (id) byId.set(id, role);
  }

  return Array.from(byId.entries()).map(([id, role]) => ({
    id,
    name: String(role?.name || `Role ${id.slice(0, 6)}`),
    permissions: normalizeOverride(role?.permissions),
    colour: role?.colour ?? role?.color ?? null,
    hoist: Boolean(role?.hoist),
    rank: typeof role?.rank === 'number' ? role.rank : undefined,
  }));
}

// ============================================================
// Message capture (for Masquerade-based recreation during restore)
// ============================================================

/**
 * Capture every reaction-role panel message's content + embeds + reactions.
 * Reads the panel list from data/reaction-roles.json, then fetches each
 * message from the source server to snapshot its current content.
 */
async function collectPanelMessages(client: any, serverId: string): Promise<BackupPanelMessage[]> {
  const panels = readReactionRolePanelsForBackup();
  if (panels.length === 0) return [];

  const results: BackupPanelMessage[] = [];
  for (const panel of panels) {
    try {
      const message = await fetchMessage(client, panel.channelId, panel.messageId);
      if (!message) {
        backupWarn(`Panel message ${panel.messageId} in channel ${panel.channelId} could not be fetched; skipping capture.`);
        continue;
      }
      results.push({
        sourceMessageId: panel.messageId,
        sourceChannelId: panel.channelId,
        channelName: String(message.channel?.name || `channel-${panel.channelId.slice(0, 6)}`),
        content: typeof message.content === 'string' ? message.content : '',
        embeds: snapshotEmbeds(message.embeds),
        reactions: snapshotReactions(message.reactions),
        mappings: panel.mappings,
      });
    } catch (error: any) {
      backupWarn(`Failed to capture panel message ${panel.messageId}: ${readableError(error)}`);
    }
  }
  return results;
}

/**
 * Capture the initial embed message for each open ticket channel.
 * Reads ticket records from data/tickets.json and fetches the first message
 * from each ticket channel.
 */
async function collectTicketMessages(client: any): Promise<BackupTicketMessage[]> {
  const tickets = readOpenTicketsForBackup();
  if (tickets.length === 0) return [];

  const results: BackupTicketMessage[] = [];
  for (const ticket of tickets) {
    if (!ticket.channelId) continue;
    try {
      const channel = await resolveChannelForBackup(client, ticket.channelId);
      if (!channel) continue;

      // Fetch the most recent messages and find the bot's initial embed.
      // Stoat doesn't expose "first message" directly; we fetch a batch and
      // look for the bot's ticket embed.
      const messages = await fetchRecentMessages(channel, 50);
      const initialMessage = messages.reverse().find((msg: any) =>
        msg?.authorId === client?.user?.id && Array.isArray(msg?.embeds) && msg.embeds.length > 0
      );

      if (!initialMessage) continue;

      results.push({
        ticketId: ticket.ticketId,
        sourceChannelId: ticket.channelId,
        channelName: String(channel.name || `ticket-${ticket.ticketId}`),
        content: typeof initialMessage.content === 'string' ? initialMessage.content : '',
        embeds: snapshotEmbeds(initialMessage.embeds),
      });
    } catch (error: any) {
      backupWarn(`Failed to capture ticket message for ticket ${ticket.ticketId}: ${readableError(error)}`);
    }
  }
  return results;
}

function snapshotEmbeds(embeds: any): BackupEmbed[] {
  if (!Array.isArray(embeds)) return [];
  return embeds.map((embed: any) => ({
    title: typeof embed?.title === 'string' ? embed.title : undefined,
    description: typeof embed?.description === 'string' ? embed.description : undefined,
    url: typeof embed?.url === 'string' ? embed.url : undefined,
    colour: typeof embed?.colour === 'string' ? embed.colour : (typeof embed?.color === 'string' ? embed.color : undefined),
    image: extractEmbedMediaUrl(embed),
    icon: extractEmbedIconUrl(embed),
  })).filter((embed: BackupEmbed) => embed.title || embed.description || embed.url || embed.image);
}

function extractEmbedMediaUrl(embed: any): string | undefined {
  // Stoat embeds expose media in a few shapes: an image/media object with a
  // url, an Autumn file with createFileURL(), or a bare string URL.
  const candidates = [
    embed?.image?.url,
    embed?.image,
    embed?.media?.url,
    embed?.thumbnail?.url,
    typeof embed?.media?.createFileURL === 'function' ? safeBackupCreateFileUrl(embed.media) : null,
    typeof embed?.image?.createFileURL === 'function' ? safeBackupCreateFileUrl(embed.image) : null,
    embed?.video?.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return absolutizeBackupUrl(candidate);
  }
  return undefined;
}

function extractEmbedIconUrl(embed: any): string | undefined {
  const candidates = [embed?.iconURL, embed?.icon_url, embed?.icon];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return absolutizeBackupUrl(candidate);
  }
  return undefined;
}

function snapshotReactions(reactions: any): string[] {
  if (!reactions) return [];
  // reactions can be a Map, Set, or plain object depending on stoatbot.js version
  let entries: string[] = [];
  if (typeof reactions.keys === 'function') {
    entries = Array.from(reactions.keys());
  } else if (Array.isArray(reactions)) {
    entries = reactions.map((r: any) => typeof r === 'string' ? r : (r?.emoji || r?.id || '')).filter(Boolean);
  } else if (typeof reactions === 'object') {
    entries = Object.keys(reactions);
  }
  return entries.filter((emoji: string) => typeof emoji === 'string' && emoji.length > 0);
}

async function fetchMessage(client: any, channelId: string, messageId: string): Promise<any> {
  try {
    const channel = client?.channels?.cache?.get(channelId) || await client?.channels?.fetch?.(channelId).catch(() => null);
    if (!channel) return null;
    if (typeof channel.messages?.fetch === 'function') {
      return await channel.messages.fetch(messageId).catch(() => null);
    }
  } catch {
    // fall through
  }
  // Direct API fallback
  try {
    return await client?.api?.get?.(`/channels/${channelId}/messages/${messageId}`).catch(() => null);
  } catch {
    return null;
  }
}

export async function resolveChannelForBackup(client: any, channelId: string): Promise<any> {
  return client?.channels?.cache?.get(channelId)
    || await client?.channels?.fetch?.(channelId).catch(() => null)
    || null;
}

async function fetchRecentMessages(channel: any, limit: number): Promise<any[]> {
  try {
    if (typeof channel?.messages?.fetch === 'function') {
      const result = await channel.messages.fetch({ limit });
      if (result && typeof result.values === 'function') return Array.from(result.values());
      if (Array.isArray(result)) return result;
    }
  } catch {
    // fall through
  }
  return [];
}

function readReactionRolePanelsForBackup(): Array<{ messageId: string; channelId: string; mappings: Array<{ emoji: string; roleId: string }> }> {
  try {
    const filePath = join(DATA_DIR, 'reaction-roles.json');
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    return messages
      .filter((entry: any) => entry?.messageId && entry?.channelId)
      .map((entry: any) => ({
        messageId: String(entry.messageId),
        channelId: String(entry.channelId),
        mappings: Array.isArray(entry.mappings) ? entry.mappings.map((m: any) => ({ emoji: String(m.emoji), roleId: String(m.roleId) })) : [],
      }));
  } catch (error: any) {
    backupWarn(`Failed to read reaction-roles.json for backup: ${readableError(error)}`);
    return [];
  }
}

function readOpenTicketsForBackup(): Array<{ ticketId: string; channelId?: string }> {
  try {
    const filePath = join(DATA_DIR, 'tickets.json');
    if (!existsSync(filePath)) return [];
    const raw = readFileSync(filePath, 'utf-8').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Object.entries(parsed || {})
      .filter(([, ticket]: any) => ticket?.status === 'open' && ticket?.channelId)
      .map(([ticketId, ticket]: any) => ({ ticketId: String(ticketId), channelId: String(ticket.channelId) }));
  } catch (error: any) {
    backupWarn(`Failed to read tickets.json for backup: ${readableError(error)}`);
    return [];
  }
}

// ============================================================
// Message recreation (uses Masquerade to preserve bot attribution)
// ============================================================

// Cache the bot's own avatar URL so we don't re-resolve it for every panel/ticket message.
let cachedBotAvatarUrl: string | null | undefined;

async function getBotAvatarUrl(client: any): Promise<string | null> {
  if (cachedBotAvatarUrl !== undefined) return cachedBotAvatarUrl;
  try {
    const botUser = client?.user;
    cachedBotAvatarUrl = await getBackupAvatarUrl(botUser, client) || null;
  } catch {
    cachedBotAvatarUrl = null;
  }
  return cachedBotAvatarUrl;
}

async function recreatePanelMessages(client: any, backup: ServerBackup, summary: ImportSummary) {
  const panels = backup.panelMessages || [];
  if (panels.length === 0) return;

  backupLog(`Recreating ${panels.length} reaction-role panel message(s) with Masquerade.`);

  for (const panel of panels) {
    const newChannelId = summary.idMap.channels[panel.sourceChannelId];
    if (!newChannelId) {
      summary.warnings.push(`Panel message ${panel.sourceMessageId}: channel ${panel.sourceChannelId} was not recreated; skipping panel.`);
      continue;
    }

    try {
      const channel = await resolveChannelForBackup(client, newChannelId);
      if (!channel) {
        summary.warnings.push(`Panel message ${panel.sourceMessageId}: could not resolve new channel ${newChannelId}.`);
        continue;
      }

      // Rebuild embeds as MessageEmbed instances (stoatbot.js requires these,
      // not plain objects, because channel.send calls embed.toJSONWithMedia).
      const embeds = panel.embeds.map((embed) => {
        const emb = new MessageEmbed();
        if (embed.title) emb.setTitle(embed.title);
        if (embed.description) emb.setDescription(embed.description);
        if (embed.url) emb.setURL(embed.url);
        if (embed.colour || embed.color) emb.setColor(embed.colour || embed.color);
        if (embed.icon) { try { emb.setIcon(embed.icon); } catch { /* ignore */ } }
        if (embed.image) { try { emb.setMedia(embed.image); } catch { /* ignore */ } }
        return emb;
      });

      const botAvatarUrl = await getBotAvatarUrl(client);
      const sendOptions: any = {
        masquerade: {
          name: config.botName,
        },
      };
      if (botAvatarUrl) sendOptions.masquerade.avatar = botAvatarUrl;
      if (panel.content) sendOptions.content = panel.content;
      if (embeds.length > 0) sendOptions.embeds = embeds;

      const sent = await channel.send(sendOptions);
      if (!sent?.id) {
        summary.warnings.push(`Panel message ${panel.sourceMessageId}: sent message did not return an ID.`);
        continue;
      }

      summary.idMap.messages[panel.sourceMessageId] = sent.id;
      summary.recreatedPanelMessages += 1;
      backupLog(`Recreated panel message: ${panel.sourceMessageId} -> ${sent.id} in channel ${newChannelId}.`);

      // Re-attach the original reactions (and any emoji from the mappings).
      const emojis = new Set<string>(panel.reactions);
      for (const mapping of panel.mappings) emojis.add(mapping.emoji);
      for (const emoji of emojis) {
        try {
          await sent.addReaction(emoji).catch((error: any) => {
            backupWarn(`Could not re-add reaction ${emoji} to recreated panel: ${readableError(error)}`);
          });
        } catch (error: any) {
          backupWarn(`Could not re-add reaction ${emoji}: ${readableError(error)}`);
        }
      }
    } catch (error: any) {
      summary.warnings.push(`Failed to recreate panel message ${panel.sourceMessageId}: ${readableError(error)}`);
      backupWarn(`Failed to recreate panel message ${panel.sourceMessageId}: ${readableError(error)}`);
    }
  }
}

async function recreateTicketMessages(client: any, backup: ServerBackup, summary: ImportSummary) {
  const tickets = backup.ticketMessages || [];
  if (tickets.length === 0) return;

  backupLog(`Recreating ${tickets.length} ticket channel message(s) with Masquerade.`);

  for (const ticket of tickets) {
    const newChannelId = summary.idMap.channels[ticket.sourceChannelId];
    if (!newChannelId) {
      summary.warnings.push(`Ticket ${ticket.ticketId}: channel ${ticket.sourceChannelId} was not recreated; skipping ticket message.`);
      continue;
    }

    try {
      const channel = await resolveChannelForBackup(client, newChannelId);
      if (!channel) {
        summary.warnings.push(`Ticket ${ticket.ticketId}: could not resolve new channel ${newChannelId}.`);
        continue;
      }

      const embeds = ticket.embeds.map((embed) => {
        const emb = new MessageEmbed();
        if (embed.title) emb.setTitle(embed.title);
        if (embed.description) emb.setDescription(embed.description);
        if (embed.url) emb.setURL(embed.url);
        if (embed.colour || embed.color) emb.setColor(embed.colour || embed.color);
        if (embed.icon) { try { emb.setIcon(embed.icon); } catch { /* ignore */ } }
        if (embed.image) { try { emb.setMedia(embed.image); } catch { /* ignore */ } }
        return emb;
      });

      const botAvatarUrl = await getBotAvatarUrl(client);
      const sendOptions: any = {
        masquerade: {
          name: config.botName,
        },
      };
      if (botAvatarUrl) sendOptions.masquerade.avatar = botAvatarUrl;
      if (ticket.content) sendOptions.content = ticket.content;
      if (embeds.length > 0) sendOptions.embeds = embeds;

      const sent = await channel.send(sendOptions);
      if (sent?.id) {
        summary.recreatedTicketMessages += 1;
        backupLog(`Recreated ticket message for ticket ${ticket.ticketId} in channel ${newChannelId}.`);
      }
    } catch (error: any) {
      summary.warnings.push(`Failed to recreate ticket message for ticket ${ticket.ticketId}: ${readableError(error)}`);
      backupWarn(`Failed to recreate ticket message for ticket ${ticket.ticketId}: ${readableError(error)}`);
    }
  }
}

/**
 * After message recreation, the bot data files we wrote earlier still
 * reference the OLD message IDs. Re-read them, swap in the new IDs, write back.
 */
function rewriteBotDataWithNewMessageIds(summary: ImportSummary) {
  const messageIdMap = summary.idMap.messages;
  if (Object.keys(messageIdMap).length === 0) return;

  // Update reaction-roles.json: replace messageId fields.
  try {
    const filePath = join(DATA_DIR, 'reaction-roles.json');
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.messages)) {
          let updated = 0;
          for (const entry of parsed.messages) {
            const newId = entry?.messageId ? messageIdMap[entry.messageId] : undefined;
            if (newId) {
              entry.messageId = newId;
              updated += 1;
            }
          }
          if (updated > 0) {
            writeFileSync(filePath, JSON.stringify(parsed, null, 2), 'utf-8');
            backupLog(`Updated ${updated} reaction-role message ID(s) in reaction-roles.json.`);
          }
        }
      }
    }
  } catch (error: any) {
    backupWarn(`Failed to update reaction-roles.json with new message IDs: ${readableError(error)}`);
  }
}

// ============================================================
// Full channel message capture (for Masquerade replay on restore)
// ============================================================

const MESSAGE_FETCH_BATCH_SIZE = 100;
const MESSAGE_FETCH_MAX_PER_CHANNEL = 5000;
const MESSAGE_FETCH_DELAY_MS = 400; // gentle pacing to avoid rate limits

/**
 * For every text channel in the backup, fetch the full message history
 * (paginated, up to MESSAGE_FETCH_MAX_PER_CHANNEL per channel) and snapshot
 * each message with author name + avatar URL + content + embeds + replies +
 * reactions + attachments (URL only).
 *
 * This is the slow part of backup — a busy server with thousands of messages
 * can take minutes. We pace requests with a small delay between batches.
 */
async function collectAllChannelMessages(client: any, serverId: string, channels: BackupChannel[]): Promise<Record<string, BackupChannelMessage[]>> {
  const result: Record<string, BackupChannelMessage[]> = {};
  const textChannels = channels.filter((ch) => !isVoiceChannelType(ch.type));
  backupLog(`Capturing messages from ${textChannels.length} text channel(s).`);

  for (const channel of textChannels) {
    try {
      const messages = await collectChannelMessages(client, channel.id);
      if (messages.length > 0) {
        result[channel.id] = messages;
        backupLog(`Channel "${channel.name}": captured ${messages.length} message(s).`);
      }
    } catch (error: any) {
      backupWarn(`Failed to capture messages from channel "${channel.name}" (${channel.id}): ${readableError(error)}`);
    }
  }
  return result;
}

export async function collectChannelMessages(client: any, channelId: string): Promise<BackupChannelMessage[]> {
  const channel = await resolveChannelForBackup(client, channelId);
  if (!channel || typeof channel.messages?.fetch !== 'function') return [];

  const allMessages: any[] = [];
  let lastMessageId: string | null = null;
  let batchCount = 0;

  while (batchCount * MESSAGE_FETCH_BATCH_SIZE < MESSAGE_FETCH_MAX_PER_CHANNEL) {
    const options: any = { limit: MESSAGE_FETCH_BATCH_SIZE };
    if (lastMessageId) options.before = lastMessageId;

    let result: any;
    try {
      result = await channel.messages.fetch(options);
    } catch (error: any) {
      const detail = readableError(error);
      if (/429|rate limit|too many/i.test(detail)) {
        // Back off and retry this batch once.
        backupWarn(`Rate limited on channel ${channelId}; backing off 2s and retrying.`);
        await sleep(2000);
        try {
          result = await channel.messages.fetch(options);
        } catch (retryError: any) {
          backupWarn(`Retry failed for channel ${channelId}: ${readableError(retryError)}`);
          break;
        }
      } else {
        backupWarn(`Fetch failed on channel ${channelId} batch ${batchCount + 1}: ${detail}`);
        break;
      }
    }

    const messages = result instanceof Map ? Array.from(result.values()) : (Array.isArray(result) ? result : []);
    if (messages.length === 0) break;

    allMessages.push(...messages);
    lastMessageId = messages[messages.length - 1].id;
    batchCount += 1;

    if (messages.length < MESSAGE_FETCH_BATCH_SIZE) break;

    // Pace between batches to avoid hitting rate limits.
    await sleep(MESSAGE_FETCH_DELAY_MS);
  }

  // Stoat returns newest-first; we want chronological (oldest-first) for replay.
  allMessages.reverse();

  // Resolve author + avatar for each message. Doing this in parallel speeds
  // up backup considerably for channels with many messages.
  const snapshot = await Promise.all(allMessages.map((msg) => snapshotChannelMessage(client, msg)));

  // Filter out messages we couldn't snapshot meaningfully (e.g. null author).
  return snapshot.filter((msg): msg is BackupChannelMessage => msg !== null);
}

export async function snapshotChannelMessage(client: any, msg: any): Promise<BackupChannelMessage | null> {
  if (!msg) return null;

  try {
    const author = await resolveBackupMessageAuthor(msg, client);
    const member = await resolveBackupMessageMember(msg, client);
    const authorName = resolveBackupAuthorName(msg, member, author);
    const avatarUrl = await resolveBackupAvatarUrl(msg, member, author, client);

    return {
      id: String(msg.id || ''),
      authorId: msg.authorId ? String(msg.authorId) : (msg.author && typeof msg.author === 'string' ? String(msg.author) : undefined),
      authorName,
      avatarUrl: avatarUrl || undefined,
      content: typeof msg.content === 'string' ? msg.content : '',
      embeds: snapshotEmbeds(msg.embeds),
      attachments: snapshotAttachments(msg.attachments, client),
      replies: snapshotReplies(msg.replies || msg.replyIds),
      reactions: snapshotReactions(msg.reactions),
      createdAt: msg.createdAt ? String(msg.createdAt) : (msg.createdAt instanceof Date ? msg.createdAt.toISOString() : new Date().toISOString()),
      isSystem: !!msg.systemMessage,
      systemContent: msg.systemMessage ? getBackupSystemMessageContent(msg.systemMessage) : undefined,
    };
  } catch (error: any) {
    backupWarn(`Failed to snapshot message ${msg?.id}: ${readableError(error)}`);
    return null;
  }
}

function snapshotAttachments(attachments: any, client?: any): BackupAttachment[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.map((att: any) => {
    const filename = typeof att?.filename === 'string' ? att.filename : (typeof att?.name === 'string' ? att.name : undefined);
    const direct = att?.originalUrl || att?.original_url
      || (typeof att?.createFileURL === 'function' ? safeBackupCreateFileUrl(att) : null)
      || att?.url || att?.previewUrl || att?.preview_url || null;
    // stoatbot.js Attachment objects carry no URL — only id/filename — so build
    // the CDN URL ourselves. Message files live in the `attachments` bucket.
    const url = direct ? absolutizeBackupUrl(direct) : buildBackupAttachmentUrl(att, filename, client);
    return {
      filename,
      url: url || undefined,
      contentType: att?.contentType || att?.content_type || att?.type || att?.metadata?.type || undefined,
      size: typeof att?.size === 'number' ? att.size : undefined,
    };
  }).filter((att: BackupAttachment) => att.url || att.filename);
}

function buildBackupAttachmentUrl(att: any, filename: string | undefined, client: any): string | null {
  const id = String(att?.id || att?._id || '').trim();
  if (!id || !filename || !client) return null;
  const tag = String(att?.tag || 'attachments').trim() || 'attachments';
  return `${getBackupCdnBase(client)}/${encodeURIComponent(tag)}/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
}

function snapshotReplies(replies: any): BackupMessageReply[] {
  if (!Array.isArray(replies)) return [];
  return replies.map((r: any) => ({
    id: String(r?.id || r?._id || r || ''),
    mention: Boolean(r?.mention),
  })).filter((r: BackupMessageReply) => r.id);
}

function getBackupSystemMessageContent(systemMessage: any): string {
  if (!systemMessage) return '';
  const type = systemMessage.type || systemMessage.kind;
  switch (type) {
    case 'user_added': return 'User was added to the channel';
    case 'user_remove': return 'User was removed from the channel';
    case 'user_joined': return 'User joined the server';
    case 'user_left': return 'User left the server';
    case 'user_kicked': return 'User was kicked';
    case 'user_banned': return 'User was banned';
    case 'channel_renamed': return 'Channel was renamed';
    case 'channel_description_changed': return 'Channel description was changed';
    case 'channel_icon_changed': return 'Channel icon was changed';
    default: return `System event: ${type}`;
  }
}

async function resolveBackupMessageAuthor(message: any, client: any) {
  if (message?.author && typeof message.author === 'object' && !message.author.isWebhook) {
    return message.author;
  }
  const authorId = message?.authorId || message?.author;
  if (!authorId) return null;
  const cached = client?.users?.cache?.get?.(authorId);
  if (cached) return cached;
  // Avoid noisy REST fetches during backup; cached data is enough for name/avatar.
  return null;
}

async function resolveBackupMessageMember(message: any, client: any) {
  if (message?.member) return message.member;
  const authorId = message?.authorId || message?.author;
  const server = message?.server || client?.servers?.cache?.get?.(config.serverId);
  if (!authorId || !server) return null;
  const cached = server?.members?.cache?.get?.(authorId);
  return cached || null;
}

function resolveBackupAuthorName(message: any, member: any, author: any): string {
  return String(
    message?.masquerade?.name
    || message?.username
    || member?.nickname
    || author?.username
    || 'Unknown User'
  );
}

async function resolveBackupAvatarUrl(message: any, member: any, author: any, client: any): Promise<string | null> {
  // Prefer masquerade avatar (if the original message was already masqueraded)
  if (message?.masquerade?.avatar) {
    const ma = message.masquerade.avatar;
    if (typeof ma === 'string' && /^https?:\/\//i.test(ma)) return ma;
    const built = buildBackupAvatarUrl(ma, client);
    if (built) return built;
  }

  // Webhook avatar
  if (message?.webhook?.avatar) {
    const built = buildBackupAvatarUrl(message.webhook.avatar, client);
    if (built) return built;
  }

  // Member avatar -> user avatar -> default avatar
  return (
    await getBackupAvatarUrl(member, client)
    || await getBackupAvatarUrl(author, client)
    || buildBackupDefaultAvatarUrl(message?.authorId || message?.author || author?.id, client)
    || null
  );
}

async function getBackupAvatarUrl(entity: any, client: any): Promise<string | null> {
  if (!entity) return null;

  if (typeof entity.avatarURL === 'string' && entity.avatarURL) return entity.avatarURL;
  if (typeof entity.avatarURL === 'function') {
    try { const url = entity.avatarURL(); if (url) return url; } catch { /* ignore */ }
  }
  if (typeof entity.displayAvatarURL === 'function') {
    try { const url = await entity.displayAvatarURL(); if (url) return url; } catch { /* ignore */ }
  }
  if (typeof entity.animatedAvatarURL === 'string' && entity.animatedAvatarURL) return entity.animatedAvatarURL;
  if (typeof entity.masqueradeAvatarURL === 'string' && entity.masqueradeAvatarURL) return entity.masqueradeAvatarURL;
  if (typeof entity.avatar === 'string' && /^https?:\/\//i.test(entity.avatar)) return entity.avatar;
  if (entity.avatar && typeof entity.avatar.createFileURL === 'function') {
    try {
      const url = entity.avatar.createFileURL(true) || entity.avatar.createFileURL();
      if (url) return url;
    } catch { /* ignore */ }
  }

  const avatar = entity.avatar || entity.profile?.avatar || null;
  const direct = buildBackupAvatarUrl(avatar, client);
  if (direct) return direct;

  if (entity.user && entity.user !== entity) {
    const userAvatar = await getBackupAvatarUrl(entity.user, client);
    if (userAvatar) return userAvatar;
  }

  return buildBackupDefaultAvatarUrl(entity.id, client);
}

function buildBackupAvatarUrl(avatar: any, client: any): string | null {
  const avatarId = extractBackupFileId(avatar);
  if (!avatarId) return null;
  if (typeof avatar === 'string' && /^https?:\/\//i.test(avatar)) return avatar;
  const cdnBase = getBackupCdnBase(client);
  return `${cdnBase}/avatars/${encodeURIComponent(avatarId)}`;
}

function buildBackupDefaultAvatarUrl(userId: any, client: any): string | null {
  if (!userId) return null;
  return `${getBackupApiBase(client)}/users/${encodeURIComponent(String(userId))}/default_avatar`;
}

function getBackupCdnBase(client: any): string {
  return String(
    client?.options?.rest?.instanceCDNURL
    || client?.configuration?.features?.autumn?.url
    || 'https://autumn.stoat.chat'
  ).replace(/\/$/, '');
}

function getBackupApiBase(client: any): string {
  return String(
    client?.options?.rest?.instanceURL
    || client?.options?.baseURL
    || 'https://api.stoat.chat'
  ).replace(/\/$/, '');
}

function extractBackupFileId(value: any): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'object') {
    return value.id || value._id || value.file_id || (typeof value.createFileURL === 'function' ? extractBackupFileIdFromUrl(value.createFileURL()) : null) || null;
  }
  return null;
}

function extractBackupFileIdFromUrl(url: any): string | null {
  if (typeof url !== 'string') return null;
  const match = url.match(/\/avatars\/([^/?#]+)/) || url.match(/\/attachments\/([^/?#]+)/);
  return match?.[1] || null;
}

function safeBackupCreateFileUrl(att: any): string | null {
  try { return att.createFileURL() || null; } catch { return null; }
}

function absolutizeBackupUrl(url: string): string {
  const value = String(url || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('cdn.stoatusercontent.com/') || value.startsWith('autumn.stoat.chat/')) return `https://${value}`;
  if (value.startsWith('/attachments/') || value.startsWith('/emojis/')) return `https://cdn.stoatusercontent.com${value}`;
  if (value.startsWith('/avatars/')) return `https://autumn.stoat.chat${value}`;
  return value;
}

// ============================================================
// Full channel message replay (Masquerade copies name + avatar per message)
// ============================================================

const MESSAGE_SEND_DELAY_MS = 350; // gentle pacing to avoid rate limits

async function recreateChannelMessages(client: any, backup: ServerBackup, summary: ImportSummary) {
  const channelMessages = backup.channelMessages || {};
  const channelIds = Object.keys(channelMessages);
  if (channelIds.length === 0) return;

  const totalMessages = Object.values(channelMessages).reduce((sum: number, msgs: BackupChannelMessage[]) => sum + msgs.length, 0);
  backupLog(`Recreating ${totalMessages} message(s) across ${channelIds.length} channel(s) with per-message Masquerade.`);

  for (const sourceChannelId of channelIds) {
    const newChannelId = summary.idMap.channels[sourceChannelId];
    if (!newChannelId) {
      summary.warnings.push(`Channel messages for ${sourceChannelId}: channel was not recreated; skipping ${channelMessages[sourceChannelId].length} message(s).`);
      continue;
    }

    try {
      const channel = await resolveChannelForBackup(client, newChannelId);
      if (!channel) {
        summary.warnings.push(`Channel messages for ${sourceChannelId}: could not resolve new channel ${newChannelId}.`);
        continue;
      }

      // Track old message ID -> new message ID so reply chains survive.
      const localMessageIdMap = new Map<string, string>();
      let sentCount = 0;

      for (const msg of channelMessages[sourceChannelId]) {
        try {
          const newId = await replayMessage(channel, msg, localMessageIdMap, client);
          if (newId) {
            localMessageIdMap.set(msg.id, newId);
            summary.idMap.messages[msg.id] = newId;
            sentCount += 1;
            summary.recreatedChannelMessages += 1;
          }
        } catch (error: any) {
          // Don't fail the whole channel on one bad message.
          backupWarn(`Failed to recreate message ${msg.id} in channel ${newChannelId}: ${readableError(error)}`);
        }
        // Pace sends to avoid rate limits.
        await sleep(MESSAGE_SEND_DELAY_MS);
      }

      backupLog(`Channel ${newChannelId}: recreated ${sentCount}/${channelMessages[sourceChannelId].length} message(s).`);
    } catch (error: any) {
      summary.warnings.push(`Failed to recreate messages for channel ${sourceChannelId}: ${readableError(error)}`);
      backupWarn(`Failed to recreate messages for channel ${sourceChannelId}: ${readableError(error)}`);
    }
  }
}

const ATTACHMENT_DOWNLOAD_MAX_BYTES = 25 * 1024 * 1024; // 25MB cap per file
const ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15000;

export async function replayMessage(channel: any, msg: BackupChannelMessage, localMessageIdMap: Map<string, string>, client: any): Promise<string | null> {
  // Skip pure system messages — Stoat doesn't let bots send system message types
  // via the regular message endpoint. Recreate them as a plain text note instead.
  const sendOptions: any = {
    masquerade: {
      name: msg.authorName || 'Unknown User',
    },
  };

  if (msg.avatarUrl) {
    sendOptions.masquerade.avatar = msg.avatarUrl;
  }

  if (msg.isSystem && msg.systemContent) {
    sendOptions.content = `*${msg.systemContent}*`;
  } else {
    if (msg.content) sendOptions.content = msg.content;

    // Rebuild embeds from snapshot as MessageEmbed instances.
    // stoatbot.js channel.send() calls embed.toJSONWithMedia(client) internally,
    // so plain objects fail with "embed.toJSONWithMedia is not a function".
    if (msg.embeds.length > 0) {
      sendOptions.embeds = msg.embeds.map((embed) => {
        const emb = new MessageEmbed();
        if (embed.title) emb.setTitle(embed.title);
        if (embed.description) emb.setDescription(embed.description);
        if (embed.url) emb.setURL(embed.url);
        if (embed.colour || embed.color) emb.setColor(embed.colour || embed.color);
        if (embed.icon) { try { emb.setIcon(embed.icon); } catch { /* ignore */ } }
        if (embed.image) { try { emb.setMedia(embed.image); } catch { /* ignore */ } }
        return emb;
      }).filter((emb: any) => emb !== null);
    }

    // Attachments: download every file (image or not) and re-upload it as a
    // NodeFile so it transfers for real. Anything that fails to download or is
    // over the size cap falls back to a URL link (Stoat CDN URLs are public).
    const uploadedFiles: any[] = [];
    const linkUrls: string[] = [];

    for (const att of msg.attachments) {
      if (!att.url) continue;
      const downloaded = await downloadAttachment(att).catch((error: any) => {
        backupWarn(`Could not download attachment ${att.filename || att.url}: ${readableError(error)}`);
        return null;
      });
      if (downloaded) {
        uploadedFiles.push(downloaded);
        continue;
      }
      linkUrls.push(att.url);
    }

    if (uploadedFiles.length > 0) {
      sendOptions.attachments = uploadedFiles;
    }

    if (linkUrls.length > 0) {
      sendOptions.content = (sendOptions.content || '') + linkUrls.map((url) => `\n${url}`).join('');
    }

    // Resolve reply targets to new message IDs.
    if (msg.replies.length > 0) {
      const firstReply = msg.replies[0];
      const newReplyId = localMessageIdMap.get(firstReply.id);
      if (newReplyId) {
        sendOptions.replies = [{ id: newReplyId, mention: firstReply.mention }];
      }
    }
  }

  // If the message has no content, no embeds, and no attachments, skip it
  // (Stoat rejects empty messages).
  if (!sendOptions.content && (!sendOptions.embeds || sendOptions.embeds.length === 0) && (!sendOptions.attachments || sendOptions.attachments.length === 0)) {
    return null;
  }

  const sent = await channel.send(sendOptions);
  if (!sent?.id) return null;

  // Re-attach reactions (as the bot — Stoat doesn't let us react as other users).
  for (const emoji of msg.reactions) {
    try {
      await sent.addReaction(emoji).catch((error: any) => {
        backupWarn(`Could not re-add reaction ${emoji} to recreated message ${sent.id}: ${readableError(error)}`);
      });
    } catch (error: any) {
      backupWarn(`Could not re-add reaction ${emoji}: ${readableError(error)}`);
    }
  }

  return sent.id;
}

async function downloadAttachment(att: BackupAttachment): Promise<any | null> {
  if (!att.url) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(att.url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > ATTACHMENT_DOWNLOAD_MAX_BYTES) {
      throw new Error(`File too large (${contentLength} bytes > ${ATTACHMENT_DOWNLOAD_MAX_BYTES} cap)`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.byteLength > ATTACHMENT_DOWNLOAD_MAX_BYTES) {
      throw new Error(`Downloaded body too large (${bytes.byteLength} bytes)`);
    }

    const contentType = att.contentType || 'application/octet-stream';
    const filename = att.filename || `attachment-${Date.now()}`;

    return new NodeFile([bytes], filename, { type: contentType });
  } finally {
    clearTimeout(timer);
  }
}

/** The bot's data files, after every debounced store has written its pending changes. */
function readBotDataFilesFlushed() {
  flushDataFiles();
  return readBotDataFiles();
}

function readDataFileOr(fileName: string, fallback: unknown): any {
  try {
    return readDataFileContent(fileName) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Replace only the target server's part of a file that stores every server.
 * Returns null when the backup holds nothing for the target, so the current
 * file is left as it is.
 *
 * Two shapes exist: `{ servers: { [serverId]: state } }` and the tag list,
 * `{ tags: [{ serverId, ... }] }`. Temporary voice rooms are channels of the
 * moment: the target keeps its live rooms and takes only the settings.
 */
export function mergeServerScopedData(fileName: string, current: any, restored: any, targetServerId: string): any | null {
  if (fileName === 'tags.json') {
    const incoming = (Array.isArray(restored?.tags) ? restored.tags : []).filter((tag: any) => tag?.serverId === targetServerId);
    if (!incoming.length) return null;
    const kept = (Array.isArray(current?.tags) ? current.tags : []).filter((tag: any) => tag?.serverId !== targetServerId);
    return { ...current, tags: [...kept, ...incoming] };
  }

  const incoming = restored?.servers?.[targetServerId];
  if (!incoming || typeof incoming !== 'object') return null;
  const servers = current?.servers && typeof current.servers === 'object' ? { ...current.servers } : {};
  const state = fileName === 'tempvoice.json'
    ? { ...incoming, rooms: Array.isArray(servers[targetServerId]?.rooms) ? servers[targetServerId].rooms : [] }
    : incoming;
  servers[targetServerId] = state;
  return { ...(current && typeof current === 'object' ? current : {}), version: restored?.version ?? current?.version ?? 1, servers };
}

function readBotDataFiles() {
  const result: Record<string, unknown> = {};
  for (const fileName of BOT_DATA_FILES) {
    try {
      const content = readDataFileContent(fileName);
      if (content !== undefined) result[fileName] = content;
    } catch (error) {
      result[fileName] = { __backupReadError: readableError(error) };
    }
  }
  return result;
}

function readTranscriptFiles() {
  if (!existsSync(TEMP_DIR)) return [];
  return readdirSync(TEMP_DIR)
    .filter((fileName) => /^transcript-.*\.html$/i.test(fileName))
    .map((fileName) => ({
      fileName,
      content: readFileSync(join(TEMP_DIR, fileName), 'utf-8'),
    }));
}

function readBackupFile(filePath: string): ServerBackup {
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  // 'crabgod.stoat.server-backup' is the pre-rename id; files written then
  // are still valid and must keep restoring.
  const KNOWN_FORMATS = ['yaosb.stoat.server-backup', 'crabgod.stoat.server-backup'];
  if (!KNOWN_FORMATS.includes(String(parsed?.format || '')) || parsed?.version !== 1) {
    throw new Error('Unsupported backup file format.');
  }
  return parsed;
}

function writeJsonFile(filePath: string, data: unknown) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, JSON.stringify(data, bigintJsonReplacer, 2), 'utf-8');
}

function bigintJsonReplacer(_key: string, value: unknown) {
  return typeof value === 'bigint' ? value.toString() : value;
}

function normalizeOverride(value: any): PermissionOverride | null {
  if (value === undefined || value === null) return null;

  if (typeof value !== 'object') {
    return {
      a: stringifyBigintLike(value),
      d: '0',
    };
  }

  const allow = value.a ?? value.allow;
  const deny = value.d ?? value.deny;
  if (allow === undefined && deny === undefined) return null;
  return {
    a: stringifyBigintLike(allow || 0),
    d: stringifyBigintLike(deny || 0),
  };
}

function normalizeOverrideMap(value: any): Record<string, PermissionOverride> {
  if (!value || typeof value !== 'object') return {};
  const output: Record<string, PermissionOverride> = {};
  for (const [roleId, override] of Object.entries(value)) {
    const normalized = normalizeOverride(override);
    if (normalized) output[roleId] = normalized;
  }
  return output;
}

async function buildTargetRoleOrdering(targetServer: any, rolesByRank: BackupRole[], summary: ImportSummary) {
  const importedRoleIds = uniqueIds(
    rolesByRank
      .map((role) => summary.idMap.roles[role.id])
      .filter((id): id is string => isValidRemoteId(id))
  );
  if (importedRoleIds.length === 0) return [];

  const imported = new Set(importedRoleIds);
  const rawServer = await fetchRawServerForTarget(targetServer);
  const existingRoleIds = uniqueIds(getTargetRoleIds(targetServer, rawServer))
    .filter((roleId) => !imported.has(roleId));
  return uniqueIds([...existingRoleIds, ...importedRoleIds]);
}

function getTargetRoleIds(targetServer: any, rawServer?: any): string[] {
  const ids = new Set<string>();

  const addRole = (role: any) => {
    const id = typeof role === 'string' ? role : role?.id || role?._id;
    if (isValidRemoteId(id) && id !== targetServer?.id) ids.add(id);
  };

  if (rawServer?.roles && typeof rawServer.roles === 'object') {
    for (const id of Object.keys(rawServer.roles)) addRole(id);
  }
  for (const role of Array.isArray(targetServer?.orderedRoles) ? targetServer.orderedRoles : []) addRole(role);
  for (const role of Array.from(targetServer?.roles?.values?.() || [])) addRole(role);
  for (const role of Array.from(targetServer?.roles?.cache?.values?.() || [])) addRole(role);

  return Array.from(ids);
}

function uniqueIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function toApiPermissionOverride(value: PermissionOverride): ApiPermissionOverride {
  return {
    allow: toSafePermissionNumber(value.a),
    deny: toSafePermissionNumber(value.d),
  };
}

function isEmptyPermissionOverride(value: ApiPermissionOverride) {
  return value.allow === 0 && value.deny === 0;
}

function toSafePermissionNumber(value: unknown) {
  if (typeof value === 'bigint') return Number(value);
  const number = Number(value || 0);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function normalizeChannelType(value?: string) {
  return isVoiceChannelType(value) ? 'Voice' : 'Text';
}

function isVoiceChannelType(value?: string) {
  return String(value || '').toLowerCase().includes('voice');
}

function getApi(source: any) {
  const api = source?.api || source?.client?.api;
  if (!api) throw new Error('No Stoat API client is available for this object.');
  return api;
}

async function apiPost(api: any, path: string, body: any) {
  try {
    return await api.post(path, { body });
  } catch (error) {
    if (!isLikelyWrappedBodyError(error)) throw error;
    return api.post(path, body);
  }
}

async function apiPatch(api: any, path: string, body: any) {
  try {
    return await api.patch(path, { body });
  } catch (error) {
    if (!isLikelyWrappedBodyError(error)) throw error;
    return api.patch(path, body);
  }
}

async function apiPut(api: any, path: string, body: any) {
  try {
    return await api.put(path, { body });
  } catch (error) {
    if (!isLikelyWrappedBodyError(error)) throw error;
    return api.put(path, body);
  }
}

function isLikelyWrappedBodyError(error: unknown) {
  const message = readableError(error);
  return /body|invalid|missing|required|bad request|400/i.test(message);
}

function getSessionToken(): string {
  return env.sessionToken;
}

function isAuthOrElevationFailure(detail: string): boolean {
  return /401|403|unauthorized|forbidden|notelevated/i.test(detail);
}

function summarizeText(value: string) {
  const trimmed = String(value || '').trim().replace(/\s+/g, ' ');
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed;
}

function stringifyBigintLike(value: unknown) {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (typeof value === 'string') return value || '0';
  return '0';
}

function extractCategoryChannelIds(category: any): string[] {
  if (Array.isArray(category?.channels)) {
    return category.channels
      .map((entry: any) => (typeof entry === 'string' ? entry : entry?.id || entry?._id))
      .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
  }

  return Array.from(category?.children?.values?.() || [])
    .map((channel: any) => channel?.id)
    .filter((id: any): id is string => typeof id === 'string' && id.length > 0);
}

function createCategoryId(oldId: string, categoryMap: Record<string, string>) {
  const existing = categoryMap[oldId];
  if (isValidCategoryId(existing)) return existing;

  const safeOldId = sanitizeCategoryIdPart(oldId);
  const hash = stableShortHash(oldId);
  const prefix = 'cat-';
  const suffix = `-${hash}`;
  const baseLength = Math.max(1, 32 - prefix.length - suffix.length);
  const base = (safeOldId || 'imported').slice(0, baseLength);
  let next = `${prefix}${base}${suffix}`;
  let counter = 1;

  while (Object.values(categoryMap).some((value) => value === next && categoryMap[oldId] !== next)) {
    const counterSuffix = `-${hash}-${counter.toString(36)}`;
    const counterBaseLength = Math.max(1, 32 - prefix.length - counterSuffix.length);
    next = `${prefix}${base.slice(0, counterBaseLength)}${counterSuffix}`;
    counter += 1;
  }

  categoryMap[oldId] = next;
  return next;
}

function isValidCategoryId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 32 && /^[A-Za-z0-9_-]+$/.test(value);
}

function isValidRemoteId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/.test(value);
}

function sanitizeCategoryIdPart(value: string) {
  return String(value || 'imported').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function stableShortHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).slice(0, 6).padStart(6, '0');
}

function sanitizeFilePart(value: string, fallbackExtension = '') {
  const base = basename(String(value || 'backup')).replace(/[^A-Za-z0-9._-]/g, '-').replace(/-+/g, '-').slice(0, 96);
  return base || `backup${fallbackExtension}`;
}

function ensureDir(path: string) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function firstNullableString(...values: unknown[]) {
  for (const value of values) {
    if (value === null) return null;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function readableError(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function throwBackupOperationError(action: string, error: unknown): never {
  const detail = readableError(error);
  const message = `${action} failed: ${detail}${getPermissionHint(detail)}`;
  backupWarn(message);
  throw new Error(message);
}

function getPermissionHint(detail: string) {
  if (!/403|forbidden|notelevated/i.test(detail)) return '';
  return (
    '\nStoat returned 403 Forbidden. Check that the bot role in the target server has Manage Channels, ' +
    'Manage Roles, Manage Permissions, and Manage Server, and that the bot role is above roles it must create/edit.'
  );
}

function backupLog(message: string) {
  console.log(`[backup] ${message}`);
}

function backupWarn(message: string) {
  console.warn(`[backup] ${message}`);
}
