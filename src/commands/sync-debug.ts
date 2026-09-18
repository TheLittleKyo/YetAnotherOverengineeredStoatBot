import { config } from '../config.js';
import { canManageServerById, requirePermissionForChannel } from '../permissions.js';
import { normalizeMentionOrId } from '../id-utils.js';
import {
  getSyncDiagnostics,
  getSyncLink,
  listMirrorRows,
  listSyncLinks,
  probeSyncLink,
  pruneSyncLedger,
  remirrorMessage,
  resolveSyncLinks,
  scanSyncLink,
  setSyncCursor,
  traceSyncMessage,
  type SyncScanFinding,
  type SyncScanReport,
} from '../sync.js';

/**
 * `sync debug` — diagnostics for channel sync.
 *
 *   status                     Counters since boot, link and ledger summary.
 *   links                      Every link with its ledger and cursor state.
 *   link <id>                  One link in detail.
 *   ledger [linkId] [--limit]  Recent source -> copy rows.
 *   trace <messageId>          Follow one message through the ledger.
 *   scan <link|channel>        Compare both channels: added, edited, deleted.
 *   prune [--apply]            Drop ledger rows that can never be used again.
 *   cursor <linkId> [...]      Show, move, or clear the catch-up cursors.
 *   replay <linkId> <msgId>    Re-mirror one message, replacing its copy.
 *   probe <linkId>             Send/edit/delete a probe in the far channel.
 *   channel <channelId>        Which links touch a channel.
 *
 * `scan` is the one that answers "did anything drift?" — edits and deletes made
 * while the bot was offline produce no event, so comparing the two channels
 * after the fact is the only way to find them. Add `--apply` to repair.
 */
export async function syncDebugCommand(message: any, args: string[], client: any) {
  const sub = (args.shift() || '').toLowerCase();

  if (!sub || sub === 'help') {
    await sendHelp(message);
    return;
  }

  if (!(await canManageServer(message, client))) {
    await message.channel?.send({ content: 'You need Manage Server permission to use sync diagnostics.' });
    return;
  }

  const flags = parseFlags(args);

  switch (sub) {
    case 'status':
    case 'stats':
      await runStatus(message);
      return;
    case 'links':
    case 'list':
      await runLinks(message);
      return;
    case 'link':
      await runLink(message, args[0]);
      return;
    case 'ledger':
    case 'rows':
      await runLedger(message, args[0], flags.limit);
      return;
    case 'trace':
      await runTrace(message, client, args[0]);
      return;
    case 'scan':
    case 'check':
    case 'diff':
      await runScan(message, client, args[0], flags);
      return;
    case 'prune':
      await runPrune(message, client, flags);
      return;
    case 'cursor':
    case 'cursors':
      await runCursor(message, args, flags);
      return;
    case 'replay':
    case 'remirror':
      await runReplay(message, client, args[0], args[1]);
      return;
    case 'probe':
    case 'selftest':
      await runProbe(message, client, args[0], flags);
      return;
    case 'channel':
      await runChannel(message, args[0]);
      return;
    default:
      await sendHelp(message, `Unknown debug subcommand: \`${sub}\`.`);
  }
}

// ============================================================
// Subcommands
// ============================================================

async function runStatus(message: any) {
  const diag = getSyncDiagnostics();
  const s = diag.stats;

  const lines = [
    '# Sync Debug — Status',
    '',
    '## Since boot',
    `- Started: \`${s.startedAt}\``,
    `- Mirrored: ${s.mirrored} (skipped ${s.mirrorSkipped}, failed ${s.mirrorFailed}, blocked by filters ${s.filtered})`,
    `- Edits applied: ${s.edits} (ignored ${s.editsIgnored}, failed ${s.editsFailed})`,
    `- Deletes applied: ${s.deletes} (bulk batches ${s.bulkDeletes}, failed ${s.deletesFailed})`,
    `- Catch-up runs: ${s.catchUpRuns} (replayed ${s.catchUpReplayed})`,
    `- Last mirror: ${s.lastMirrorAt || 'never'}`,
    `- Last edit: ${s.lastEditAt || 'never'}`,
    `- Last delete: ${s.lastDeleteAt || 'never'}`,
    `- Last error: ${s.lastError || 'none'}`,
    '',
    '## Ledger',
    `- File: \`${diag.ledger.file}\``,
    `- Rows: ${diag.ledger.rows} / ${diag.ledger.cap}`,
    `- Distinct source messages: ${diag.ledger.distinctSources}`,
    `- Oldest row: ${diag.ledger.oldestAt || 'n/a'}`,
    `- Newest row: ${diag.ledger.newestAt || 'n/a'}`,
    `- Rows for deleted links: ${diag.ledger.orphanedRows}`,
    '',
    '## Links',
    `- File: \`${diag.linkFile}\``,
    `- Active: ${diag.links.length}`,
  ];

  for (const link of diag.links) {
    lines.push(
      `  - \`${link.id}\`${link.label ? ` (${link.label})` : ''} ${arrow(link.mode)} ` +
        `\`${link.sourceChannelId}\` ${arrow(link.mode)} \`${link.targetChannelId}\` — ${link.ledgerRows} row(s)`,
    );
  }

  if (s.mirrored > 0 && s.edits === 0 && s.deletes === 0) {
    lines.push('', 'No edits or deletes seen yet this session. If you expected some, run `probe` to check the destination channel, then `scan` to find drift.');
  }

  await sendChunks(message, lines.join('\n'));
}

async function runLinks(message: any) {
  const links = listSyncLinks();
  if (links.length === 0) {
    await message.channel?.send({ content: 'No sync links configured.' });
    return;
  }

  const diag = getSyncDiagnostics();
  const lines = ['# Sync Debug — Links', ''];
  for (const link of diag.links) {
    lines.push(
      `## \`${link.id}\`${link.label ? ` — ${link.label}` : ''}`,
      `- Mode: ${link.mode === 'twoway' ? 'two-way' : 'one-way'}`,
      `- Source: \`${link.sourceChannelId}\``,
      `- Target: \`${link.targetChannelId}\``,
      `- Created: ${link.createdAt}`,
      `- Catch-up cursor (source): \`${link.lastSourceId || 'unset'}\``,
      `- Catch-up cursor (target): \`${link.lastTargetId || 'unset'}\``,
      `- Ledger rows: ${link.ledgerRows}`,
      '',
    );
  }

  await sendChunks(message, lines.join('\n'));
}

async function runLink(message: any, idArg: string) {
  const id = (idArg || '').trim();
  if (!id) {
    await sendHelp(message, 'Usage: `sync debug link <linkId>`');
    return;
  }

  const link = getSyncLink(id);
  if (!link) {
    await message.channel?.send({ content: `No sync link with id \`${id}\`.` });
    return;
  }

  const rows = listMirrorRows({ linkId: link.id, limit: 5 });
  const total = getSyncDiagnostics().links.find((item) => item.id === link.id)?.ledgerRows ?? 0;

  const lines = [
    `# Sync Link \`${link.id}\`${link.label ? ` — ${link.label}` : ''}`,
    '',
    `- Mode: ${link.mode === 'twoway' ? 'two-way' : 'one-way'}`,
    `- Source: \`${link.sourceChannelId}\``,
    `- Target: \`${link.targetChannelId}\``,
    `- Created: ${link.createdAt}`,
    `- Catch-up cursor (source): \`${link.lastSourceId || 'unset'}\``,
    `- Catch-up cursor (target): \`${link.lastTargetId || 'unset'}\``,
    `- Ledger rows: ${total}`,
    '',
    '## Newest mirrored messages',
  ];

  if (rows.length === 0) lines.push('- none yet');
  for (const row of rows) lines.push(`- \`${row.sourceId}\` → \`${row.targetId}\` at ${row.at}`);

  lines.push('', `Run \`${config.prefix}sync debug scan ${link.id}\` to compare the channels for drift.`);
  await sendChunks(message, lines.join('\n'));
}

async function runLedger(message: any, linkArg: string, limit?: number) {
  const linkId = (linkArg || '').trim() || undefined;
  const rows = listMirrorRows({ linkId, limit: limit || 20 });

  if (rows.length === 0) {
    await message.channel?.send({ content: linkId ? `No ledger rows for \`${linkId}\`.` : 'The mirror ledger is empty.' });
    return;
  }

  const lines = [`# Sync Ledger${linkId ? ` — \`${linkId}\`` : ''}`, '', `Newest ${rows.length} row(s):`, ''];
  for (const row of rows) {
    lines.push(
      `- \`${row.sourceId}\` (\`${row.sourceChannelId}\`) → \`${row.targetId}\` (\`${row.targetChannelId}\`)` +
        ` · link \`${row.linkId}\` · ${row.at}`,
    );
  }

  await sendChunks(message, lines.join('\n'));
}

async function runTrace(message: any, client: any, messageArg: string) {
  const id = (messageArg || '').trim();
  if (!id) {
    await sendHelp(message, 'Usage: `sync debug trace <messageId>`');
    return;
  }

  const trace = await traceSyncMessage(client, id);
  const lines = [`# Trace \`${id}\``, ''];

  if (trace.asSource.length === 0 && trace.asCopy.length === 0) {
    lines.push('This message is not in the mirror ledger. It was never mirrored, its row aged out, or it belongs to an unlinked channel.');
    await sendChunks(message, lines.join('\n'));
    return;
  }

  if (trace.asSource.length > 0) {
    lines.push('## Copies made of this message', '');
    for (const row of trace.asSource) {
      lines.push(
        `- link \`${row.linkId}\` → \`${row.targetId}\` in \`${row.targetChannelId}\``,
        `  - copy still exists: ${row.targetExists ? 'yes' : 'no'}`,
        `  - copy content: ${row.targetContent ? `\`${truncate(row.targetContent)}\`` : '(none)'}`,
      );
    }
    lines.push('');
  }

  if (trace.asCopy.length > 0) {
    lines.push('## This message is itself a copy', '');
    for (const row of trace.asCopy) {
      lines.push(
        `- copied from \`${row.sourceId}\` in \`${row.sourceChannelId}\` via link \`${row.linkId}\``,
        `  - source still exists: ${row.sourceExists ? 'yes' : 'no'}`,
        `  - source content: ${row.sourceContent ? `\`${truncate(row.sourceContent)}\`` : '(none)'}`,
      );
    }
  }

  await sendChunks(message, lines.join('\n'));
}

async function runScan(message: any, client: any, target: string, flags: Flags) {
  const needle = normalizeMentionOrId(target) || (target || '').trim();
  if (!needle) {
    await sendHelp(message, 'Usage: `sync debug scan <linkId|channelId> [--limit 200] [--apply] [--direction source|target|both]`');
    return;
  }

  const links = resolveSyncLinks(needle);
  if (links.length === 0) {
    await message.channel?.send({ content: `No sync link matches \`${needle}\`.` });
    return;
  }

  // Repairs write into both channels, so authorize in each one's own server.
  if (flags.apply) {
    for (const link of links) {
      if (!(await requirePermissionForChannel(message, client, link.sourceChannelId, ['ManageServer'], 'Manage Server'))) return;
      if (!(await requirePermissionForChannel(message, client, link.targetChannelId, ['ManageServer'], 'Manage Server'))) return;
    }
  }

  await message.channel?.send({
    content:
      `Scanning ${links.length} link(s), last ${flags.limit || 200} message(s) per channel` +
      `${flags.apply ? ', repairing what drifted' : ' (read-only — add `--apply` to repair)'}...`,
  });

  for (const link of links) {
    let report: SyncScanReport;
    try {
      report = await scanSyncLink(client, link.id, {
        limit: flags.limit,
        apply: flags.apply,
        direction: flags.direction,
      });
    } catch (error: any) {
      await message.channel?.send({ content: `Scan of \`${link.id}\` failed: ${error?.message || error}` });
      continue;
    }
    await sendChunks(message, formatScanReport(report));
  }
}

async function runPrune(message: any, client: any, flags: Flags) {
  const result = await pruneSyncLedger(client, { apply: flags.apply, limit: flags.limit });
  const lines = [
    '# Sync Debug — Ledger Prune',
    '',
    `- Rows checked against the API: ${result.checked}`,
    `- Rows for deleted links: ${result.deadLinks}`,
    `- Rows whose copy is gone: ${result.missingCopies}`,
    `- Rows removed: ${result.removed}`,
  ];
  if (!result.apply) lines.push('', 'Read-only. Add `--apply` to remove those rows.');
  await sendChunks(message, lines.join('\n'));
}

async function runCursor(message: any, args: string[], flags: Flags) {
  const linkId = (args[0] || '').trim();
  const action = (args[1] || 'show').toLowerCase();

  if (!linkId) {
    await sendHelp(message, 'Usage: `sync debug cursor <linkId> [show|reset|set <messageId>] [--direction source|target]`');
    return;
  }

  const link = getSyncLink(linkId);
  if (!link) {
    await message.channel?.send({ content: `No sync link with id \`${linkId}\`.` });
    return;
  }

  if (action === 'show') {
    await message.channel?.send({
      content:
        `# Catch-up cursors for \`${link.id}\`\n\n` +
        `- source → target: \`${link.lastSourceId || 'unset'}\`\n` +
        `- target → source: \`${link.lastTargetId || 'unset'}\`\n\n` +
        'An unset cursor means the next catch-up records the channel tip and replays nothing.',
    });
    return;
  }

  const direction = flags.direction === 'target' ? 'target' : 'source';

  if (action === 'reset' || action === 'clear') {
    const updated = setSyncCursor(link.id, direction, null);
    await message.channel?.send({
      content: `Cleared the ${direction} cursor on \`${updated?.id}\`. The next catch-up will record the tip and replay nothing.`,
    });
    return;
  }

  if (action === 'set') {
    const value = (args[2] || '').trim();
    if (!value) {
      await sendHelp(message, 'Usage: `sync debug cursor <linkId> set <messageId> [--direction source|target]`');
      return;
    }
    const updated = setSyncCursor(link.id, direction, value);
    await message.channel?.send({
      content:
        `Set the ${direction} cursor on \`${updated?.id}\` to \`${value}\`.\n\n` +
        'Everything posted after that message will be replayed on the next catch-up — a cursor moved far back can mirror a lot of messages.',
    });
    return;
  }

  await sendHelp(message, `Unknown cursor action: \`${action}\`.`);
}

async function runReplay(message: any, client: any, linkArg: string, messageArg: string) {
  const linkId = (linkArg || '').trim();
  const messageId = (messageArg || '').trim();
  if (!linkId || !messageId) {
    await sendHelp(message, 'Usage: `sync debug replay <linkId> <messageId>`');
    return;
  }

  const link = getSyncLink(linkId);
  if (!link) {
    await message.channel?.send({ content: `No sync link with id \`${linkId}\`.` });
    return;
  }

  if (!(await requirePermissionForChannel(message, client, link.sourceChannelId, ['ManageServer'], 'Manage Server'))) return;
  if (!(await requirePermissionForChannel(message, client, link.targetChannelId, ['ManageServer'], 'Manage Server'))) return;

  const result = await remirrorMessage(client, link.id, messageId);
  await message.channel?.send({
    content:
      `# Replayed \`${messageId}\`\n\n` +
      `- New copy: ${result.targetId ? `\`${result.targetId}\`` : 'none (Stoat rejected the message)'}\n` +
      `- Previous copy removed: ${result.replacedCopy ? `\`${result.replacedCopy}\`` : 'none'}\n\n` +
      'The copy is posted at the bottom of the channel, not in its original position.',
  });
}

async function runProbe(message: any, client: any, linkArg: string, flags: Flags) {
  const linkId = (linkArg || '').trim();
  if (!linkId) {
    await sendHelp(message, 'Usage: `sync debug probe <linkId> [--direction source|target]`');
    return;
  }

  const link = getSyncLink(linkId);
  if (!link) {
    await message.channel?.send({ content: `No sync link with id \`${linkId}\`.` });
    return;
  }

  const probeChannel = flags.direction === 'target' ? link.sourceChannelId : link.targetChannelId;
  if (!(await requirePermissionForChannel(message, client, probeChannel, ['ManageServer'], 'Manage Server'))) return;

  const result = await probeSyncLink(client, link.id, flags.direction === 'target' ? 'target' : 'source');
  const lines = [
    `# Sync Self-Test — \`${link.id}\``,
    '',
    `Channel: \`${result.channelId}\``,
    `- Send (masqueraded): ${mark(result.send)}`,
    `- Edit: ${mark(result.edit)}`,
    `- Delete: ${mark(result.remove)}`,
  ];
  if (result.errors.length > 0) lines.push('', '## Errors', ...result.errors.map((error) => `- ${error}`));
  if (result.send && !result.remove) lines.push('', 'The probe message could not be deleted — it is still in that channel.');
  await sendChunks(message, lines.join('\n'));
}

async function runChannel(message: any, channelArg: string) {
  const channelId = normalizeMentionOrId(channelArg) || (channelArg || '').trim();
  if (!channelId) {
    await sendHelp(message, 'Usage: `sync debug channel <channelId>`');
    return;
  }

  const links = resolveSyncLinks(channelId).filter(
    (link) => link.sourceChannelId === channelId || link.targetChannelId === channelId,
  );

  if (links.length === 0) {
    await message.channel?.send({ content: `No sync link touches \`${channelId}\`. Messages there are not mirrored anywhere.` });
    return;
  }

  const lines = [`# Links touching \`${channelId}\``, ''];
  for (const link of links) {
    const isSource = link.sourceChannelId === channelId;
    const role = isSource
      ? 'source — messages here are mirrored out'
      : link.mode === 'twoway'
        ? 'target of a two-way link — messages here are mirrored back'
        : 'target of a one-way link — messages posted here are not mirrored anywhere';
    lines.push(
      `## \`${link.id}\`${link.label ? ` — ${link.label}` : ''}`,
      `- Role: ${role}`,
      `- Other side: \`${isSource ? link.targetChannelId : link.sourceChannelId}\``,
      `- Mode: ${link.mode === 'twoway' ? 'two-way' : 'one-way'}`,
      '',
    );
  }

  await sendChunks(message, lines.join('\n'));
}

// ============================================================
// Formatting
// ============================================================

const ISSUE_LABELS: Record<SyncScanFinding['issue'], string> = {
  missing: 'Added but never mirrored',
  stale: 'Edited at the source, copy is stale',
  'copy-missing': 'Copy was deleted in the destination',
  orphan: 'Deleted at the source, copy still there',
  filtered: 'Blocked by the link filters, copy still there',
  untracked: 'Copy already there, not tracked',
};

function formatScanReport(report: SyncScanReport): string {
  const counts: Record<string, number> = { missing: 0, stale: 0, 'copy-missing': 0, orphan: 0, filtered: 0, untracked: 0 };
  for (const finding of report.findings) counts[finding.issue] += 1;

  const lines = [
    `# Scan — \`${report.linkId}\`${report.label ? ` (${report.label})` : ''}`,
    '',
    `- Mode: ${report.mode === 'twoway' ? 'two-way' : 'one-way'}`,
    `- Messages compared: ${report.scanned} (window: last ${report.limit})`,
    `- Ledger rows matched: ${report.ledgerRows}`,
    `- Skipped by filters: ${report.skippedByFilters}`,
    `- Posted before the link existed: ${report.skippedBeforeLink}`,
    `- Mode: ${report.apply ? 'repairing' : 'read-only'}`,
    '',
    '## Drift',
    `- Added but never mirrored: ${counts.missing}`,
    `- Edited, copy stale: ${counts.stale}`,
    `- Copy deleted in destination: ${counts['copy-missing']}`,
    `- Deleted at source, copy still there: ${counts.orphan}`,
    `- Blocked by filters, copy still there: ${counts.filtered}`,
    `- Copy already there, not tracked: ${counts.untracked} (repair only records it, posts nothing)`,
  ];

  if (report.apply) lines.push(`- Repaired: ${report.repaired}`);

  if (report.findings.length === 0) {
    lines.push('', 'Both channels match over that window.');
  } else {
    lines.push('', '## Details', '');
    for (const finding of report.findings.slice(0, 40)) {
      const ids = `${finding.sourceId ? `\`${finding.sourceId}\`` : '?'} → ${finding.targetId ? `\`${finding.targetId}\`` : '—'}`;
      const suffix = finding.error
        ? ` — failed: ${finding.error}`
        : finding.repaired
          ? ' — repaired'
          : '';
      const reason = finding.reason ? ` (${finding.reason})` : '';
      lines.push(`- **${ISSUE_LABELS[finding.issue]}**${reason} ${ids}${finding.preview ? ` · ${finding.preview}` : ''}${suffix}`);
    }
    if (report.findings.length > 40) lines.push(`- ...and ${report.findings.length - 40} more.`);
  }

  if (report.warnings.length > 0) {
    lines.push('', '## Warnings', ...report.warnings.map((warning) => `- ${warning}`));
  }

  if (!report.apply && report.findings.length > 0) {
    lines.push('', `Re-run with \`--apply\` to fix: \`${config.prefix}sync debug scan ${report.linkId} --apply\``);
  }

  return lines.join('\n');
}

async function sendHelp(message: any, error?: string) {
  await message.channel?.send({
    content:
      (error ? `${error}\n\n` : '') +
      `# Sync Debug Commands\n\n` +
      `- \`${config.prefix}sync debug status\` - Counters since boot, ledger and link summary\n` +
      `- \`${config.prefix}sync debug links\` - Every link with its cursors and row counts\n` +
      `- \`${config.prefix}sync debug link <linkId>\` - One link in detail\n` +
      `- \`${config.prefix}sync debug ledger [linkId] [--limit N]\` - Recent source → copy rows\n` +
      `- \`${config.prefix}sync debug trace <messageId>\` - Follow one message through the ledger\n` +
      `- \`${config.prefix}sync debug scan <linkId|channelId> [--limit N] [--apply] [--direction source|target|both]\` - Compare both channels for added, edited and deleted messages\n` +
      `- \`${config.prefix}sync debug prune [--apply] [--limit N]\` - Drop ledger rows that can never be used again\n` +
      `- \`${config.prefix}sync debug cursor <linkId> [show|reset|set <messageId>]\` - Inspect or move the catch-up cursors\n` +
      `- \`${config.prefix}sync debug replay <linkId> <messageId>\` - Re-mirror one message, replacing its copy\n` +
      `- \`${config.prefix}sync debug probe <linkId>\` - Send, edit and delete a probe message in the far channel\n` +
      `- \`${config.prefix}sync debug channel <channelId>\` - Which links touch a channel\n\n` +
      `\`scan\` is the one that finds edits and deletes made while the bot was offline — those produce no event, so the channels have to be compared after the fact. It is read-only until you add \`--apply\`.`,
  });
}

// ============================================================
// Helpers
// ============================================================

type Flags = {
  apply: boolean;
  limit?: number;
  direction?: 'source' | 'target' | 'both';
};

/** Pull `--apply`, `--limit N|--limit=N` and `--direction X` out of `args`. */
function parseFlags(args: string[]): Flags {
  const flags: Flags = { apply: false };

  for (let i = args.length - 1; i >= 0; i -= 1) {
    const arg = String(args[i] || '');
    const lower = arg.toLowerCase();

    if (lower === '--apply' || lower === '--fix' || lower === '--repair') {
      flags.apply = true;
      args.splice(i, 1);
      continue;
    }

    const limitInline = lower.match(/^--limit=(\d+)$/);
    if (limitInline) {
      flags.limit = Number(limitInline[1]);
      args.splice(i, 1);
      continue;
    }
    if (lower === '--limit' && args[i + 1]) {
      flags.limit = Number(args[i + 1]) || undefined;
      args.splice(i, 2);
      continue;
    }

    const dirInline = lower.match(/^--direction=(source|target|both)$/);
    if (dirInline) {
      flags.direction = dirInline[1] as Flags['direction'];
      args.splice(i, 1);
      continue;
    }
    if (lower === '--direction' && args[i + 1]) {
      const value = String(args[i + 1]).toLowerCase();
      if (value === 'source' || value === 'target' || value === 'both') flags.direction = value;
      args.splice(i, 2);
    }
  }

  return flags;
}

async function canManageServer(message: any, client: any) {
  const serverId = message?.serverId || config.serverId;
  return canManageServerById(client, serverId, message.authorId);
}

function arrow(mode: string) {
  return mode === 'twoway' ? '↔' : '→';
}

function mark(ok: boolean) {
  return ok ? 'OK' : 'FAILED';
}

function truncate(value: string, max = 80) {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/** Split a long report across messages, breaking on line boundaries. */
export async function sendChunks(message: any, text: string, max = 1900) {
  const lines = text.split('\n');
  let buffer = '';

  for (const line of lines) {
    if (buffer.length + line.length + 1 > max) {
      if (buffer) await message.channel?.send({ content: buffer });
      buffer = line;
      continue;
    }
    buffer = buffer ? `${buffer}\n${line}` : line;
  }

  if (buffer) await message.channel?.send({ content: buffer });
}
