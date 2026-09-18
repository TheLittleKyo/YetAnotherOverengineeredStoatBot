/**
 * Sync diagnostics card for the Debug tools page — the dashboard counterpart of the
 * `sync debug` chat commands. Every tool here calls `/api/sync/debug/*`.
 *
 * Read-only tools (status, scan, trace, ledger, prune check) run straight away.
 * Anything that posts, edits or deletes messages in a real channel (repair,
 * probe, replay, cursor moves, prune apply) asks for confirmation first.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Select } from '../shared/select.js';
import { confirmDialog, postToShell } from '../shared/ui.js';
import {
  FiActivity,
  FiAlertTriangle,
  FiCheckCircle,
  FiCrosshair,
  FiList,
  FiRadio,
  FiRefreshCw,
  FiRepeat,
  FiRotateCcw,
  FiScissors,
  FiSearch,
  FiTool,
  FiXCircle,
} from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';

const h = React.createElement;

type Tool = 'scan' | 'trace' | 'ledger' | 'probe' | 'maintenance';

const TOOLS: Array<[Tool, string, any]> = [
  ['scan', 'Scan', FiSearch],
  ['trace', 'Trace', FiCrosshair],
  ['ledger', 'Ledger', FiList],
  ['probe', 'Self-test', FiRadio],
  ['maintenance', 'Maintenance', FiTool],
];

const ISSUES: Array<[string, string, string]> = [
  ['missing', 'Added, never mirrored', 'A message in the channel has no copy on the other side.'],
  ['stale', 'Edited, copy stale', 'The copy still shows the text from before an edit.'],
  ['copy-missing', 'Copy deleted', 'The copy was removed from the other channel.'],
  ['orphan', 'Deleted, copy left', 'The original is gone but its copy is still posted.'],
  ['filtered', 'Filtered, copy left', 'The link filters now block the original, but an earlier copy is still posted.'],
  ['untracked', 'Copy found, untracked', 'A matching copy is already in the other channel (for example from a history copy), but it was not on record. Repair only records it — nothing is posted.'],
];
const ISSUE_LABEL: Record<string, string> = Object.fromEntries(ISSUES.map(([key, label]) => [key, label]));

export function SyncDebugSection({ data, flash }: any) {
  const links: any[] = data.syncLinks || [];
  const [linkId, setLinkId] = useState<string>(links[0]?.id || '');
  const [tool, setTool] = useState<Tool>('scan');
  const [status, setStatus] = useState<any>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  const link = links.find((item) => item.id === linkId) || null;
  const names = useMemo(() => channelNameIndex(data), [data]);

  useEffect(() => { loadStatus(); }, []);
  // Keep a valid selection when links are added or removed in the card above.
  useEffect(() => { if (!links.some((item) => item.id === linkId)) setLinkId(links[0]?.id || ''); }, [links]);

  async function loadStatus() {
    setStatusBusy(true);
    try { setStatus(await getJson('/api/sync/debug/status')); }
    catch (e: any) { flash('error', e.message); }
    finally { setStatusBusy(false); }
  }

  return h('section', { className: 'card card-debug' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(FiActivity)),
      h('div', { style: { flex: 1 } },
        h('h2', null, 'Sync diagnostics'),
        h('p', { className: 'muted' }, 'Check whether live links are keeping up, and find messages that were added, edited or deleted without being mirrored.')),
      h('button', { className: 'icon-btn', title: 'Refresh status', disabled: statusBusy, onClick: loadStatus }, h(FiRefreshCw))),
    h('div', { className: 'card-body' },
      h(StatusStrip, { status }),
      links.length === 0
        ? h('p', { className: 'empty-line muted' }, 'No live links on this server yet. ',
            h('button', { type: 'button', className: 'link-btn', onClick: () => postToShell({ type: 'yaosb-open', ns: 'sync' }) }, 'Create one on the Channel sync page'),
            ', then come back here to inspect it.')
        : h(React.Fragment, null,
            h('div', { className: 'debug-toolbar' },
              h('label', { className: 'field debug-link-pick' },
                h('span', { className: 'field-label' }, 'Link'),
                h(Select, { value: linkId, options: links.map((item) => ({ value: item.id, label: linkLabel(item) })), onChange: setLinkId })),
              h('div', { className: 'segmented debug-tabs', role: 'tablist' },
                TOOLS.map(([key, label, icon]) => h('button', {
                  key,
                  role: 'tab',
                  'aria-selected': tool === key,
                  className: `seg ${tool === key ? 'is-active' : ''}`,
                  onClick: () => setTool(key),
                }, h(icon), label)))),
            link && tool === 'scan' ? h(ScanTool, { key: link.id, link, names, flash, onDone: loadStatus }) : null,
            link && tool === 'trace' ? h(TraceTool, { names, flash }) : null,
            link && tool === 'ledger' ? h(LedgerTool, { key: link.id, link, names, flash }) : null,
            link && tool === 'probe' ? h(ProbeTool, { key: link.id, link, names, flash }) : null,
            link && tool === 'maintenance' ? h(MaintenanceTool, { key: link.id, link, flash, onDone: loadStatus }) : null)));
}

// ------------------------------------------------------------
// Status
// ------------------------------------------------------------

function StatusStrip({ status }: any) {
  if (!status) return h('div', { className: 'stat-strip is-loading' }, h('span', { className: 'muted' }, 'Loading status…'));
  const s = status.stats || {};
  const failures = (s.mirrorFailed || 0) + (s.editsFailed || 0) + (s.deletesFailed || 0);

  return h('div', { className: 'debug-status' },
    h('div', { className: 'stat-strip' },
      h(Stat, { label: 'Mirrored', value: s.mirrored, hint: [s.lastMirrorAt ? `Last ${timeAgo(s.lastMirrorAt)}` : 'None yet', s.filtered ? `${s.filtered} filtered` : ''].filter(Boolean).join(' · ') }),
      h(Stat, { label: 'Edits followed', value: s.edits, hint: s.lastEditAt ? `Last ${timeAgo(s.lastEditAt)}` : 'None yet' }),
      h(Stat, { label: 'Deletes followed', value: s.deletes, hint: s.lastDeleteAt ? `Last ${timeAgo(s.lastDeleteAt)}` : 'None yet' }),
      h(Stat, { label: 'Failures', value: failures, tone: failures > 0 ? 'danger' : undefined, hint: `${s.mirrorFailed || 0} send · ${s.editsFailed || 0} edit · ${s.deletesFailed || 0} delete` }),
      h(Stat, { label: 'Ledger rows', value: status.ledger?.rows, hint: `of ${status.ledger?.cap ?? 0} kept` }),
      h(Stat, { label: 'Caught up offline', value: s.catchUpReplayed, hint: `${s.catchUpRuns || 0} catch-up run(s)` })),
    h('p', { className: 'hint muted' },
      `Counts since the bot started ${s.startedAt ? timeAgo(s.startedAt) : ''}. `,
      status.ledger?.orphanedRows ? `${status.ledger.orphanedRows} ledger row(s) belong to deleted links — prune them under Maintenance.` : ''),
    s.lastError ? h('div', { className: 'banner banner-danger' }, h(FiAlertTriangle), h('span', { className: 'wrap-text' }, `Last error: ${s.lastError}`)) : null);
}

function Stat({ label, value, hint, tone }: any) {
  return h('div', { className: `stat ${tone ? `stat-${tone}` : ''}` },
    h('span', { className: 'stat-label' }, label),
    h('span', { className: 'stat-value' }, formatNumber(value)),
    hint ? h('span', { className: 'stat-hint' }, hint) : null);
}

// ------------------------------------------------------------
// Scan
// ------------------------------------------------------------

function ScanTool({ link, names, flash, onDone }: any) {
  const [limit, setLimit] = useState('200');
  const [direction, setDirection] = useState(link.mode === 'twoway' ? 'both' : 'source');
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState<'' | 'scan' | 'repair'>('');

  async function run(apply: boolean) {
    if (apply) {
      const count = report?.findings?.length || 0;
      if (!(await confirmDialog({ title: `Repair ${count} issue(s)?`, message: 'This posts missing messages, edits stale copies and deletes leftover or filtered copies in the linked channels.', confirmLabel: 'Repair', danger: true }))) return;
    }
    setBusy(apply ? 'repair' : 'scan');
    try {
      const r = await postJson('/api/sync/debug/scan', { linkId: link.id, limit: Number(limit), direction, apply });
      setReport(r.report);
      if (apply) {
        const failed = r.report.findings.filter((f: any) => f.error).length;
        flash(failed ? 'error' : 'ok', failed ? `Repaired ${r.report.repaired}, ${failed} failed.` : `Repaired ${r.report.repaired} issue(s). Scan again to confirm.`);
        onDone();
      } else {
        flash('info', r.report.findings.length ? `Found ${r.report.findings.length} issue(s).` : 'Channels match.');
      }
    } catch (e: any) { flash('error', e.message); }
    finally { setBusy(''); }
  }

  const counts: Record<string, number> = { missing: 0, stale: 0, 'copy-missing': 0, orphan: 0, filtered: 0, untracked: 0 };
  for (const finding of report?.findings || []) counts[finding.issue] = (counts[finding.issue] || 0) + 1;
  const hasFindings = (report?.findings?.length || 0) > 0;

  return h('div', { className: 'debug-panel' },
    h('p', { className: 'hint muted' }, 'Compares the newest messages on each side of the link. This is the only way to catch edits and deletes made while the bot was offline. Scanning changes nothing.'),
    h('div', { className: 'debug-controls' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Messages to compare'),
        h(Select, { value: limit, options: ['50', '200', '500', '1000', '2000'].map((n) => ({ value: n, label: `Newest ${n}` })), onChange: setLimit })),
      link.mode === 'twoway'
        ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Direction'),
            h('div', { className: 'segmented' }, [['both', 'Both'], ['source', `From ${channelLabel(names, link.sourceChannelId, link.sourceName)}`], ['target', `From ${channelLabel(names, link.targetChannelId, link.targetName)}`]].map(([key, label]) =>
              h('button', { key, className: `seg ${direction === key ? 'is-active' : ''}`, onClick: () => setDirection(key) }, label))))
        : null,
      h('span', { style: { flex: 1 } }),
      h('button', { className: 'btn', disabled: !!busy, onClick: () => run(false) }, h(FiSearch), busy === 'scan' ? 'Scanning…' : 'Run scan')),
    report ? h(React.Fragment, null,
      h('div', { className: 'issue-summary' },
        ISSUES.map(([key, label, desc]) => h('div', { key, className: `issue-tile ${counts[key] ? 'has-issues' : ''}`, title: desc },
          h('span', { className: 'stat-value' }, counts[key]),
          h('span', { className: 'stat-label' }, label)))),
      h('p', { className: 'hint muted' },
        `Compared ${report.scanned} message(s), ${report.ledgerRows} with a known copy. `,
        report.skippedByFilters ? `${report.skippedByFilters} blocked by the link filters and correctly not mirrored. ` : '',
        report.skippedBeforeLink ? `${report.skippedBeforeLink} posted before the link existed, so not expected to have a copy. ` : '',
        report.apply ? `${report.repaired} repaired.` : ''),
      (report.warnings || []).map((warning: string) => h('div', { key: warning, className: 'banner' }, h(FiAlertTriangle), warning)),
      hasFindings ? h(FindingsTable, { report, names }) : h('div', { className: 'banner banner-ok' }, h(FiCheckCircle), 'Both channels match over that window.'),
      hasFindings && !report.apply
        ? h('div', { className: 'row-end' }, h('button', { className: 'btn btn-accent', disabled: !!busy, onClick: () => run(true) }, h(FiTool), busy === 'repair' ? 'Repairing…' : `Repair ${report.findings.length} issue(s)`))
        : null,
      report.apply && counts['copy-missing'] > 0
        ? h('p', { className: 'hint muted' }, 'Copies deleted on the other side only have their record cleared on the first repair. Scan again and they show as never mirrored, so you can choose to post them again.')
        : null)
      : null);
}

function FindingsTable({ report, names }: any) {
  const rows = report.findings.slice(0, 200);
  return h('div', { className: 'table-scroll' },
    h('table', { className: 'debug-table' },
      h('thead', null, h('tr', null, ['Issue', 'Original', 'Copy', 'Content', report.apply ? 'Result' : null].filter(Boolean).map((col) => h('th', { key: col as string }, col)))),
      h('tbody', null, rows.map((f: any, index: number) => h('tr', { key: `${f.issue}-${f.sourceId}-${f.targetId}-${index}` },
        h('td', null, h('span', { className: `issue-tag issue-${f.issue}` }, ISSUE_LABEL[f.issue] || f.issue)),
        h('td', null, h(IdCell, { id: f.sourceId, channel: channelLabel(names, f.sourceChannelId) })),
        h('td', null, h(IdCell, { id: f.targetId, channel: channelLabel(names, f.targetChannelId) })),
        h('td', { className: 'content-cell' },
          f.preview || h('span', { className: 'muted' }, '—'),
          f.reason ? h('span', { className: 'finding-reason' }, f.reason) : null),
        report.apply ? h('td', null, f.error
          ? h('span', { className: 'result-bad', title: f.error }, h(FiXCircle), 'Failed')
          : f.repaired ? h('span', { className: 'result-ok' }, h(FiCheckCircle), 'Repaired') : h('span', { className: 'muted' }, '—')) : null)))),
    report.findings.length > rows.length ? h('p', { className: 'hint muted' }, `Showing the first ${rows.length} of ${report.findings.length}.`) : null);
}

// ------------------------------------------------------------
// Trace
// ------------------------------------------------------------

function TraceTool({ names, flash }: any) {
  const [messageId, setMessageId] = useState('');
  const [trace, setTrace] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!messageId.trim()) { flash('error', 'Enter a message ID.'); return; }
    setBusy(true);
    try { setTrace((await getJson(`/api/sync/debug/trace?messageId=${encodeURIComponent(messageId.trim())}`)).trace); }
    catch (e: any) { flash('error', e.message); }
    finally { setBusy(false); }
  }

  const empty = trace && trace.asSource.length === 0 && trace.asCopy.length === 0;

  return h('div', { className: 'debug-panel' },
    h('p', { className: 'hint muted' }, 'Paste any message ID — an original or a copy — to see where it was mirrored and whether both sides still exist.'),
    h('div', { className: 'add-row' },
      h('input', { className: 'input', value: messageId, placeholder: 'Message ID', onChange: (e: any) => setMessageId(e.target.value), onKeyDown: (e: any) => { if (e.key === 'Enter') run(); } }),
      h('button', { className: 'btn', disabled: busy, onClick: run }, h(FiCrosshair), busy ? 'Tracing…' : 'Trace')),
    empty ? h('div', { className: 'banner' }, h(FiAlertTriangle), 'Not in the ledger. It was never mirrored, its record aged out, or its channel is not linked.') : null,
    trace && trace.asSource.length > 0 ? h(React.Fragment, null,
      h('div', { className: 'sub-head' }, 'Copies of this message'),
      h('div', { className: 'list' }, trace.asSource.map((row: any) => h(TraceRow, {
        key: row.targetId,
        label: `Copy in ${channelLabel(names, row.targetChannelId)}`,
        id: row.targetId,
        exists: row.targetExists,
        content: row.targetContent,
        at: row.at,
      })))) : null,
    trace && trace.asCopy.length > 0 ? h(React.Fragment, null,
      h('div', { className: 'sub-head' }, 'This message is a copy of'),
      h('div', { className: 'list' }, trace.asCopy.map((row: any) => h(TraceRow, {
        key: row.sourceId,
        label: `Original in ${channelLabel(names, row.sourceChannelId)}`,
        id: row.sourceId,
        exists: row.sourceExists,
        content: row.sourceContent,
        at: row.at,
      })))) : null);
}

function TraceRow({ label, id, exists, content, at }: any) {
  return h('div', { className: 'trace-row' },
    h('div', { className: 'trace-head' },
      h('span', { className: 'trace-label' }, label),
      exists
        ? h('span', { className: 'result-ok' }, h(FiCheckCircle), 'Exists')
        : h('span', { className: 'result-bad' }, h(FiXCircle), 'Gone')),
    h('div', { className: 'trace-meta' }, h(IdText, { id }), h('span', { className: 'muted' }, `mirrored ${timeAgo(at)}`)),
    content ? h('div', { className: 'trace-content' }, content) : null);
}

// ------------------------------------------------------------
// Ledger
// ------------------------------------------------------------

function LedgerTool({ link, names, flash }: any) {
  const [limit, setLimit] = useState('25');
  const [rows, setRows] = useState<any[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(nextLimit = limit) {
    setBusy(true);
    try { setRows((await getJson(`/api/sync/debug/ledger?linkId=${encodeURIComponent(link.id)}&limit=${nextLimit}`)).rows); }
    catch (e: any) { flash('error', e.message); }
    finally { setBusy(false); }
  }

  useEffect(() => { load(); }, [link.id]);

  return h('div', { className: 'debug-panel' },
    h('div', { className: 'debug-controls' },
      h('p', { className: 'hint muted', style: { flex: 1 } }, 'Every mirrored send is recorded as original → copy. Edits and deletes are looked up here.'),
      h(Select, {
        className: 'input-narrow',
        label: 'Rows to show',
        value: limit,
        options: ['25', '50', '100', '200'].map((n) => ({ value: n, label: `Newest ${n}` })),
        onChange: (v: string) => { setLimit(v); load(v); },
      }),
      h('button', { className: 'icon-btn', title: 'Reload', disabled: busy, onClick: () => load() }, h(FiRefreshCw))),
    rows === null ? h('p', { className: 'muted' }, 'Loading…')
      : rows.length === 0 ? h('p', { className: 'empty-line muted' }, 'Nothing mirrored through this link yet.')
        : h('div', { className: 'table-scroll' },
            h('table', { className: 'debug-table' },
              h('thead', null, h('tr', null, ['Original', 'Copy', 'Mirrored'].map((col) => h('th', { key: col }, col)))),
              h('tbody', null, rows.map((row: any) => h('tr', { key: row.targetId },
                h('td', null, h(IdCell, { id: row.sourceId, channel: channelLabel(names, row.sourceChannelId) })),
                h('td', null, h(IdCell, { id: row.targetId, channel: channelLabel(names, row.targetChannelId) })),
                h('td', { className: 'muted', title: row.at }, timeAgo(row.at))))))));
}

// ------------------------------------------------------------
// Self-test
// ------------------------------------------------------------

function ProbeTool({ link, names, flash }: any) {
  const [direction, setDirection] = useState('source');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const probeChannelId = direction === 'target' ? link.sourceChannelId : link.targetChannelId;
  const probeName = channelLabel(names, probeChannelId);

  async function run() {
    if (!(await confirmDialog({ title: 'Run the self-test?', message: `A test message is posted in ${probeName}, edited, then deleted.`, confirmLabel: 'Run self-test' }))) return;
    setBusy(true);
    try {
      const r = await postJson('/api/sync/debug/probe', { linkId: link.id, direction });
      setResult(r.result);
      const ok = r.result.send && r.result.edit && r.result.remove;
      flash(ok ? 'ok' : 'error', ok ? 'Self-test passed.' : 'Self-test found a problem.');
    } catch (e: any) { flash('error', e.message); }
    finally { setBusy(false); }
  }

  return h('div', { className: 'debug-panel' },
    h('p', { className: 'hint muted' }, 'Mirroring edits and deletes needs the bot to send, edit and delete its own masqueraded messages in the destination channel. This tries all three with a message that removes itself.'),
    h('div', { className: 'debug-controls' },
      link.mode === 'twoway'
        ? h('div', { className: 'segmented' }, [['source', `Test ${channelLabel(names, link.targetChannelId, link.targetName)}`], ['target', `Test ${channelLabel(names, link.sourceChannelId, link.sourceName)}`]].map(([key, label]) =>
            h('button', { key, className: `seg ${direction === key ? 'is-active' : ''}`, onClick: () => setDirection(key) }, label)))
        : h('span', { className: 'muted' }, `Tests ${probeName}`),
      h('span', { style: { flex: 1 } }),
      h('button', { className: 'btn', disabled: busy, onClick: run }, h(FiRadio), busy ? 'Testing…' : 'Run self-test')),
    result ? h('div', { className: 'probe-steps' },
      h(ProbeStep, { label: 'Send with author name and avatar', ok: result.send }),
      h(ProbeStep, { label: 'Edit the message', ok: result.edit, skipped: !result.send }),
      h(ProbeStep, { label: 'Delete the message', ok: result.remove, skipped: !result.send })) : null,
    result?.errors?.length ? h('div', { className: 'banner banner-danger' }, h(FiAlertTriangle), h('span', { className: 'wrap-text' }, result.errors.join(' · '))) : null,
    result && result.send && !result.remove ? h('p', { className: 'hint muted' }, `The test message could not be deleted and is still in ${probeName}.`) : null);
}

function ProbeStep({ label, ok, skipped }: any) {
  return h('div', { className: 'probe-step' },
    skipped ? h('span', { className: 'muted' }, h(FiXCircle)) : ok ? h('span', { className: 'result-ok' }, h(FiCheckCircle)) : h('span', { className: 'result-bad' }, h(FiXCircle)),
    h('span', null, label),
    h('span', { className: skipped ? 'muted' : ok ? 'result-ok' : 'result-bad' }, skipped ? 'Skipped' : ok ? 'OK' : 'Failed'));
}

// ------------------------------------------------------------
// Maintenance
// ------------------------------------------------------------

function MaintenanceTool({ link, flash, onDone }: any) {
  const [cursors, setCursors] = useState({ source: link.lastSourceId || '', target: link.lastTargetId || '' });
  const [cursorInput, setCursorInput] = useState({ source: '', target: '' });
  const [replayId, setReplayId] = useState('');
  const [prune, setPrune] = useState<any>(null);
  const [busy, setBusy] = useState('');

  async function cursor(direction: 'source' | 'target', action: 'reset' | 'set') {
    const value = cursorInput[direction].trim();
    if (action === 'set' && !value) { flash('error', 'Enter the message ID to resume after.'); return; }
    const warning = action === 'reset'
      ? 'Clear this catch-up position? The next reconnect records the newest message and replays nothing that was missed.'
      : 'Move the catch-up position? Every message after that ID is mirrored on the next reconnect, which can be a lot.';
    if (!(await confirmDialog({ title: action === 'reset' ? 'Clear the catch-up position?' : 'Move the catch-up position?', message: warning, confirmLabel: action === 'reset' ? 'Clear' : 'Move', danger: true }))) return;
    setBusy(`cursor-${direction}`);
    try {
      const r = await postJson('/api/sync/debug/cursor', { linkId: link.id, direction, action, value });
      setCursors({ source: r.link?.lastSourceId || '', target: r.link?.lastTargetId || '' });
      setCursorInput({ ...cursorInput, [direction]: '' });
      flash('ok', action === 'reset' ? 'Catch-up position cleared.' : 'Catch-up position moved.');
    } catch (e: any) { flash('error', e.message); }
    finally { setBusy(''); }
  }

  async function replay() {
    if (!replayId.trim()) { flash('error', 'Enter a message ID.'); return; }
    if (!(await confirmDialog({ title: 'Mirror this message again?', message: 'Its old copy is deleted and a new one is posted at the bottom of the channel.', confirmLabel: 'Mirror again', danger: true }))) return;
    setBusy('replay');
    try {
      const r = await postJson('/api/sync/debug/replay', { linkId: link.id, messageId: replayId.trim() });
      flash(r.result.targetId ? 'ok' : 'error', r.result.targetId ? 'Message mirrored again.' : 'The message could not be posted (empty or unsupported).');
      setReplayId('');
      onDone();
    } catch (e: any) { flash('error', e.message); }
    finally { setBusy(''); }
  }

  async function runPrune(apply: boolean) {
    if (apply && !(await confirmDialog({ title: `Remove ${prune ? prune.deadLinks + prune.missingCopies : 'the dead'} ledger row(s)?`, message: 'Only records are removed. No messages are touched.', confirmLabel: 'Remove rows', danger: true }))) return;
    setBusy(apply ? 'prune-apply' : 'prune');
    try {
      const r = await postJson('/api/sync/debug/prune', { apply });
      setPrune(r.result);
      if (apply) { flash('ok', `Removed ${r.result.removed} row(s).`); onDone(); }
    } catch (e: any) { flash('error', e.message); }
    finally { setBusy(''); }
  }

  const directions: Array<['source' | 'target', string]> = link.mode === 'twoway'
    ? [['source', 'Source → target'], ['target', 'Target → source']]
    : [['source', 'Source → target']];

  return h('div', { className: 'debug-panel maintenance-grid' },
    h('div', { className: 'maint-block' },
      h('div', { className: 'sub-head' }, h(FiRotateCcw), 'Catch-up position'),
      h('p', { className: 'hint muted' }, 'Where offline catch-up resumes from after a restart. Messages after this ID are mirrored on reconnect.'),
      directions.map(([direction, label]) => h('div', { key: direction, className: 'cursor-row' },
        h('div', { className: 'cursor-head' },
          h('span', { className: 'field-label' }, label),
          cursors[direction] ? h(IdText, { id: cursors[direction] }) : h('span', { className: 'muted' }, 'Not set')),
        h('div', { className: 'add-row' },
          h('input', { className: 'input', value: cursorInput[direction], placeholder: 'Message ID', onChange: (e: any) => setCursorInput({ ...cursorInput, [direction]: e.target.value }) }),
          h('button', { className: 'btn', disabled: !!busy, onClick: () => cursor(direction, 'set') }, 'Set'),
          h('button', { className: 'btn btn-quiet', disabled: !!busy || !cursors[direction], onClick: () => cursor(direction, 'reset') }, 'Clear'))))),
    h('div', { className: 'maint-block' },
      h('div', { className: 'sub-head' }, h(FiRepeat), 'Mirror one message again'),
      h('p', { className: 'hint muted' }, 'Deletes the existing copy and posts a fresh one. Use it when a copy is broken or was never made.'),
      h('div', { className: 'add-row' },
        h('input', { className: 'input', value: replayId, placeholder: 'Message ID', onChange: (e: any) => setReplayId(e.target.value) }),
        h('button', { className: 'btn', disabled: !!busy, onClick: replay }, h(FiRepeat), busy === 'replay' ? 'Mirroring…' : 'Mirror again'))),
    h('div', { className: 'maint-block' },
      h('div', { className: 'sub-head' }, h(FiScissors), 'Clean up the ledger'),
      h('p', { className: 'hint muted' }, 'Finds records for deleted links, and records whose copy no longer exists (newest 200 checked). Covers every link, not only this one.'),
      prune ? h('div', { className: 'prune-result' },
        h('span', null, `${prune.deadLinks} for deleted links`),
        h('span', null, `${prune.missingCopies} with a missing copy`),
        h('span', { className: 'muted' }, `${prune.checked} checked`),
        prune.apply ? h('span', { className: 'result-ok' }, `${prune.removed} removed`) : null) : null,
      h('div', { className: 'row-end' },
        h('button', { className: 'btn', disabled: !!busy, onClick: () => runPrune(false) }, h(FiSearch), busy === 'prune' ? 'Checking…' : 'Check'),
        prune && !prune.apply && (prune.deadLinks + prune.missingCopies) > 0
          ? h('button', { className: 'btn btn-danger', disabled: !!busy, onClick: () => runPrune(true) }, h(FiScissors), `Remove ${prune.deadLinks + prune.missingCopies}`)
          : null)));
}

// ------------------------------------------------------------
// Shared bits
// ------------------------------------------------------------

/** Shortened id that copies the full value on click. */
function IdText({ id }: any) {
  if (!id) return h('span', { className: 'muted' }, '—');
  const short = id.length > 14 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
  async function copy() { try { await navigator.clipboard.writeText(id); } catch { /* clipboard blocked — the title still shows it */ } }
  return h('button', { type: 'button', className: 'id-text', title: `${id} — click to copy`, onClick: copy }, short);
}

function IdCell({ id, channel }: any) {
  return h('div', { className: 'id-cell' }, h(IdText, { id }), channel ? h('span', { className: 'id-channel' }, channel) : null);
}

function channelNameIndex(data: any): Map<string, string> {
  const index = new Map<string, string>();
  for (const server of data.servers || []) for (const channel of server.channels || []) index.set(channel.id, channel.name);
  for (const channel of data.channels || []) index.set(channel.id, channel.name);
  for (const link of data.syncLinks || []) {
    if (link.sourceName) index.set(link.sourceChannelId, link.sourceName);
    if (link.targetName) index.set(link.targetChannelId, link.targetName);
  }
  return index;
}

function channelLabel(names: Map<string, string>, id: string, fallback?: string) {
  if (!id) return '';
  const name = names.get(id) || fallback;
  return name ? `#${name}` : id;
}

function linkLabel(link: any) {
  const arrow = link.mode === 'twoway' ? '↔' : '→';
  const route = `#${link.sourceName || link.sourceChannelId} ${arrow} #${link.targetName || link.targetChannelId}`;
  return link.label ? `${link.label} (${route})` : route;
}

function formatNumber(value: any) {
  const n = Number(value) || 0;
  return n.toLocaleString();
}

function timeAgo(iso: string) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
