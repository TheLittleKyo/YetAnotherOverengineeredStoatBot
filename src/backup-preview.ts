/**
 * Backup preview — what a restore would actually change, before it changes it.
 *
 * `importServerBackup(..., { dryRun: true })` answers "how big is this backup";
 * it counts what the file contains. That is not the question someone asks with
 * their finger over the enter key, which is "what will this do to *my* server":
 * which channels already exist under that name and will end up duplicated,
 * which roles are genuinely new, and which local data files are about to be
 * overwritten.
 *
 * So this reads the backup and the live target side by side and reports a diff.
 * It never writes anything — the only file access is reading the backup and
 * stat-ing the data files it would replace.
 */

import { readFileSync } from 'fs';
import { basename } from 'path';
import { config } from './config.js';
import { dataFileSize } from './json-store.js';
import { BOT_DATA_FILES, SERVER_SCOPED_DATA_FILES } from './backup.js';

export type PreviewRow = {
  name: string;
  /** `new` will be created; `existing` already has that name in the target. */
  status: 'new' | 'existing';
  detail?: string;
};

export type DataFilePreview = {
  file: string;
  /** Bytes currently on disk, or null when the file does not exist yet. */
  currentBytes: number | null;
  /**
   * `merge` replaces only the target server's part of a file shared by every
   * server; `overwrite` replaces the whole file.
   */
  action: 'overwrite' | 'create' | 'merge';
};

export type BackupPreview = {
  file: string;
  sourceServerId: string;
  sourceServerName: string;
  createdAt: string | null;
  targetServerId: string;
  targetServerName: string;
  sameServer: boolean;
  channels: PreviewRow[];
  roles: PreviewRow[];
  categories: PreviewRow[];
  dataFiles: DataFilePreview[];
  counts: {
    channelsNew: number;
    channelsExisting: number;
    rolesNew: number;
    rolesExisting: number;
    categoriesNew: number;
    categoriesExisting: number;
    transcripts: number;
    messages: number;
  };
  warnings: string[];
};

const KNOWN_FORMATS = ['yaosb.stoat.server-backup', 'crabgod.stoat.server-backup'];

function readBackup(filePath: string): any {
  const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  if (!KNOWN_FORMATS.includes(String(parsed?.format || '')) || parsed?.version !== 1) {
    throw new Error('Unsupported backup file format.');
  }
  return parsed;
}

/** Names are compared case-insensitively and trimmed, the way people read them. */
function normalizeName(value: any): string {
  return String(value || '').trim().toLowerCase();
}

async function liveNames(client: any, serverId: string) {
  const channels = new Set<string>();
  const roles = new Set<string>();
  const categories = new Set<string>();

  try {
    const data: any = await client?.api?.get?.(`/servers/${serverId}`, { include_channels: true });
    for (const channel of Array.isArray(data?.channels) ? data.channels : []) {
      const name = normalizeName(channel?.name);
      if (name) channels.add(name);
    }
    for (const [, role] of Object.entries<any>(data?.roles || {})) {
      const name = normalizeName(role?.name);
      if (name) roles.add(name);
    }
    for (const category of Array.isArray(data?.categories) ? data.categories : []) {
      const name = normalizeName(category?.title || category?.name);
      if (name) categories.add(name);
    }
  } catch {
    // Fall back to the cache below; a preview must never fail on a cold API.
  }

  const server = client?.servers?.cache?.get?.(serverId);
  for (const channel of client?.channels?.cache?.values?.() || []) {
    if (String((channel as any)?.serverId || '') !== serverId) continue;
    const name = normalizeName((channel as any)?.name);
    if (name) channels.add(name);
  }
  for (const role of server?.roles?.cache?.values?.() || []) {
    const name = normalizeName((role as any)?.name);
    if (name) roles.add(name);
  }

  return { channels, roles, categories, serverName: String(server?.name || serverId) };
}

function toRows(items: { name: string; detail?: string }[], existing: Set<string>): PreviewRow[] {
  return items.map((item) => ({
    name: item.name,
    detail: item.detail,
    status: existing.has(normalizeName(item.name)) ? ('existing' as const) : ('new' as const),
  }));
}

/**
 * Compare a backup file against a live server. `backupPath` must already be
 * resolved (see `resolveBackupFile` in backup.ts).
 */
export async function previewServerBackup(
  client: any,
  backupPath: string,
  targetServerId = config.serverId || '',
): Promise<BackupPreview> {
  if (!targetServerId) throw new Error('Missing target server ID.');
  const backup = readBackup(backupPath);
  const live = await liveNames(client, targetServerId);

  const channelItems = (Array.isArray(backup.channels) ? backup.channels : []).map((channel: any) => ({
    name: String(channel?.name || channel?.id || 'unnamed'),
    detail: String(channel?.type || channel?.channelType || channel?.channel_type || 'Text'),
  }));
  const roleItems = (Array.isArray(backup.roles) ? backup.roles : []).map((role: any) => ({
    name: String(role?.name || role?.id || 'unnamed'),
    detail: role?.colour || role?.color || undefined,
  }));
  // Categories live under `server` in the backup format, next to the server's
  // own name and description; older hand-made files may carry them top-level.
  const rawCategories = Array.isArray(backup.server?.categories)
    ? backup.server.categories
    : Array.isArray(backup.categories)
      ? backup.categories
      : [];
  const categoryItems = rawCategories.map((category: any) => ({
    name: String(category?.title || category?.name || 'unnamed'),
    detail: Array.isArray(category?.channels) ? `${category.channels.length} channels` : undefined,
  }));

  const channels = toRows(channelItems, live.channels);
  const roles = toRows(roleItems, live.roles);
  const categories = toRows(categoryItems, live.categories);

  const dataFiles: DataFilePreview[] = Object.keys(backup.botData || {})
    .filter((file) => BOT_DATA_FILES.includes(file))
    .map((file) => {
      // Sized through json-store, which also covers the stores kept in SQLite.
      const currentBytes = dataFileSize(file);
      const action: DataFilePreview['action'] = currentBytes == null ? 'create' : SERVER_SCOPED_DATA_FILES.has(file) ? 'merge' : 'overwrite';
      return { file, currentBytes, action };
    });

  const messages = Object.values(backup.channelMessages || {}).reduce<number>(
    (sum, list: any) => sum + (Array.isArray(list) ? list.length : 0),
    0,
  );

  const sameServer = String(backup.sourceServerId || '') === targetServerId;
  const warnings: string[] = [];
  const duplicateChannels = channels.filter((row) => row.status === 'existing').length;
  const duplicateRoles = roles.filter((row) => row.status === 'existing').length;

  if (sameServer) {
    warnings.push('This backup came from the target server. A restore adds copies rather than replacing what is there.');
  }
  if (duplicateChannels) {
    warnings.push(`${duplicateChannels} channel name(s) already exist in the target; the restore creates a second channel with the same name.`);
  }
  if (duplicateRoles) {
    warnings.push(`${duplicateRoles} role name(s) already exist in the target; the restore creates a second role with the same name.`);
  }
  if (dataFiles.some((entry) => entry.action === 'overwrite')) {
    warnings.push(`${dataFiles.filter((entry) => entry.action === 'overwrite').length} local data file(s) will be overwritten with the backup's copy.`);
  }

  return {
    file: basename(backupPath),
    sourceServerId: String(backup.sourceServerId || ''),
    sourceServerName: String(backup.sourceServerName || backup.sourceServerId || 'unknown'),
    createdAt: typeof backup.createdAt === 'string' ? backup.createdAt : null,
    targetServerId,
    targetServerName: live.serverName,
    sameServer,
    channels,
    roles,
    categories,
    dataFiles,
    counts: {
      channelsNew: channels.filter((row) => row.status === 'new').length,
      channelsExisting: duplicateChannels,
      rolesNew: roles.filter((row) => row.status === 'new').length,
      rolesExisting: duplicateRoles,
      categoriesNew: categories.filter((row) => row.status === 'new').length,
      categoriesExisting: categories.filter((row) => row.status === 'existing').length,
      transcripts: Array.isArray(backup.transcripts) ? backup.transcripts.length : 0,
      messages,
    },
    warnings,
  };
}

/** Chat-friendly rendering of a preview, used by `!backup preview`. */
export function formatBackupPreview(preview: BackupPreview): string {
  const lines: string[] = [];
  lines.push(`## 🔍 Restore preview`);
  lines.push(`**Backup:** ${preview.sourceServerName} (\`${preview.sourceServerId}\`)${preview.createdAt ? ` · created ${new Date(preview.createdAt).toLocaleString()}` : ''}`);
  lines.push(`**Target:** ${preview.targetServerName} (\`${preview.targetServerId}\`)`);
  lines.push('');
  lines.push(`**Channels:** ${preview.counts.channelsNew} new, ${preview.counts.channelsExisting} name already in use`);
  lines.push(`**Roles:** ${preview.counts.rolesNew} new, ${preview.counts.rolesExisting} name already in use`);
  lines.push(`**Categories:** ${preview.counts.categoriesNew} new, ${preview.counts.categoriesExisting} name already in use`);
  const fileCount = (action: DataFilePreview['action']) => preview.dataFiles.filter((entry) => entry.action === action).length;
  lines.push(`**Bot data files:** ${fileCount('overwrite')} overwritten, ${fileCount('merge')} updated for this server only, ${fileCount('create')} created`);
  lines.push(`**Messages replayed:** ${preview.counts.messages} · **Transcripts:** ${preview.counts.transcripts}`);

  const existingChannels = preview.channels.filter((row) => row.status === 'existing').slice(0, 10);
  if (existingChannels.length) {
    lines.push('', `**Duplicate channel names:** ${existingChannels.map((row) => `\`${row.name}\``).join(', ')}`);
  }

  if (preview.warnings.length) {
    lines.push('', '**Warnings**');
    for (const warning of preview.warnings) lines.push(`- ⚠️ ${warning}`);
  }

  lines.push('', '_Nothing has been changed. Run the restore itself to apply it._');
  return lines.join('\n');
}
