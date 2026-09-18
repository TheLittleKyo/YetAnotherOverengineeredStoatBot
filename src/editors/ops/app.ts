import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiActivity, FiCopy, FiDownload, FiFileText, FiSearch, FiShield, FiTrash2, FiUploadCloud, FiAlertTriangle } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select, noneOption } from '../shared/select.js';
import { confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
declare const __PREFIX__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';
const PREFIX = typeof __PREFIX__ === 'string' ? __PREFIX__ : '!';

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() { setLoading(true); try { setData(await getJson('/api/config')); } catch (e: any) { flash('error', e.message); } finally { setLoading(false); } }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null, h('h1', null, 'Moderation & ops'), h('p', { className: 'muted' }, `Server backups, plus builders for ${BOT_NAME}'s purge and permission commands. Channel sync has its own page.`))),
    h(BackupSection, { data, flash, onChange: (b: string[]) => setData((d: any) => ({ ...d, backups: b })) }),
    h(HealthSection, { flash }),
    h(AuditSection, { flash }),
    h(PurgeBuilder, { data, flash }),
    h(PermsBuilder, { data, flash }),
  );
}

function Section({ icon, title, desc, className, children }: any) {
  return h('section', { className: `card ${className || ''}` },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(icon)), h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

// A dropdown styled like the text inputs around it, plus an escape hatch:
// picking "Enter ID manually…" swaps to a text field so an id that isn't in
// the list (or a channel the cache missed) can still be typed. A value that is
// not among the options is shown in manual mode automatically.
function Picker({ value, onChange, options, placeholder, disabled }: any) {
  const known = (options || []).some((o: any) => o.value === value);
  const [manual, setManual] = useState<boolean>(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  if (manual) {
    return h('div', { className: 'picker-id' },
      h('input', { className: 'input', value: value || '', placeholder: 'Paste ID', disabled, autoFocus: focusManual, onChange: (e: any) => onChange(e.target.value) }),
      h('button', { type: 'button', className: 'btn btn-quiet', title: 'Choose from list', disabled, onClick: () => { setManual(false); onChange(''); } }, 'List'));
  }
  return h(Select, {
    value: value || '',
    disabled,
    options: [noneOption(placeholder || 'Choose…'), ...(options || []), MANUAL_ID_OPTION],
    onChange: (v: string) => {
      if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
    },
  });
}
const chanOpts = (list: any[]) => (list || []).map((c: any) => ({ value: c.id, label: `#${c.name}` }));
const catOpts = (list: any[]) => (list || []).map((c: any) => ({ value: c.id, label: c.name }));

function BackupSection({ data, flash, onChange }: any) {
  const [name, setName] = useState('');
  const [file, setFile] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  async function exportBackup() {
    setBusy(true);
    try { const r = await postJson('/api/backup/export', { name }); onChange(r.backups); setName(''); flash('ok', `Saved ${r.file} (${r.counts.channels} channels, ${r.counts.roles} roles).`); }
    catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  async function importBackup() {
    if (!file) { flash('error', 'Choose a backup file.'); return; }
    if (!dryRun && !(await confirmDialog({ title: `Import ${file}?`, message: 'This creates channels, roles and permissions in this server for real.', confirmLabel: 'Import for real', danger: true }))) return;
    setBusy(true);
    try { const r = await postJson('/api/backup/import', { file, dryRun }); const s = r.summary || {}; flash('ok', `${dryRun ? 'Dry-run' : 'Import'}: ${s.channelsCreated ?? s.channels ?? 0} channels, ${s.rolesCreated ?? s.roles ?? 0} roles.`); }
    catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  // A diff answers what an import would do to THIS server — which names already
  // exist, which local data files get overwritten — rather than counting what
  // the backup file happens to contain.
  async function diffBackup() {
    if (!file) { flash('error', 'Choose a backup file.'); return; }
    setBusy(true);
    try { const r = await postJson('/api/backup/preview', { file }); setPreview(r.preview); }
    catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  return h(Section, { icon: FiDownload, className: 'card-backup', title: 'Server backups', desc: 'Export this server, or restore a backup into an empty one.' },
    h('div', { className: 'add-row' },
      h('input', { className: 'input', value: name, placeholder: 'Backup name (optional)', onChange: (e: any) => setName(e.target.value) }),
      h('button', { className: 'btn btn-accent', disabled: busy, onClick: exportBackup }, h(FiDownload), 'Export now')),
    h('div', { className: 'sub-head' }, 'Restore'),
    (data.backups || []).length === 0 ? h('p', { className: 'empty-line muted' }, 'No backup files in data/backups.')
      : h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Backup file'),
          h(Select, { value: file, placeholder: 'Choose a file…', options: data.backups.map((b: string) => ({ value: b, label: b })), onChange: setFile })),
    h('label', { className: 'check-row' },
      h('input', { type: 'checkbox', checked: dryRun, onChange: (e: any) => setDryRun(e.target.checked) }),
      h('span', null, 'Dry run — preview counts without changing the server')),
    h('div', { className: `banner ${dryRun ? '' : 'banner-danger'}` }, h(FiAlertTriangle),
      dryRun ? 'Safe: nothing will be created.' : 'Live import will create channels, roles, and permissions in this server.'),
    preview ? h(PreviewReport, { preview }) : null,
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-quiet', disabled: busy || !file, onClick: diffBackup }, h(FiSearch), 'Diff against this server'),
      h('button', { className: `btn ${dryRun ? '' : 'btn-danger'}`, disabled: busy, onClick: importBackup }, h(FiUploadCloud), dryRun ? 'Preview import' : 'Import for real')));
}

/** What a restore would change here, rather than what the file contains. */
function PreviewReport({ preview }: any) {
  const counts = preview.counts || {};
  const files = preview.dataFiles || [];
  return h('div', { className: 'preview-report' },
    h('div', { className: 'sub-head' }, `Restore diff — ${preview.sourceServerName} → ${preview.targetServerName}`),
    h('ul', { className: 'preview-list' },
      h('li', null, `Channels: ${counts.channelsNew} new, ${counts.channelsExisting} name already used`),
      h('li', null, `Roles: ${counts.rolesNew} new, ${counts.rolesExisting} name already used`),
      h('li', null, `Categories: ${counts.categoriesNew} new, ${counts.categoriesExisting} name already used`),
      h('li', null, `Data files: ${files.filter((f: any) => f.action === 'overwrite').length} overwritten, ${files.filter((f: any) => f.action === 'merge').length} updated for this server only, ${files.filter((f: any) => f.action === 'create').length} created`),
      h('li', null, `Messages replayed: ${counts.messages} · transcripts: ${counts.transcripts}`)),
    (preview.warnings || []).map((warning: string, index: number) =>
      h('div', { className: 'banner banner-danger', key: index }, h(FiAlertTriangle), warning)));
}

function HealthSection({ flash }: any) {
  const [health, setHealth] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(); }, []);
  async function load() {
    setBusy(true);
    try { const r = await getJson('/api/health'); setHealth(r.health); }
    catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  if (!health) return h(Section, { icon: FiActivity, title: 'Runtime health', desc: 'Loading…' }, null);

  const uptimeHours = Math.floor(health.uptimeMs / 3600000);
  const uptimeMinutes = Math.floor((health.uptimeMs % 3600000) / 60000);

  return h(Section, { icon: FiActivity, title: 'Runtime health', desc: 'Counters since the bot started. Deliberately not persisted — a restart clears them.' },
    h('div', { className: 'stat-grid' },
      h(Stat, { value: `${uptimeHours}h ${uptimeMinutes}m`, label: 'Uptime' }),
      h(Stat, { value: `${health.memory.rssMb} MB`, label: 'Memory (RSS)', hint: `heap ${health.memory.heapUsedMb} MB` }),
      h(Stat, { value: health.events.perMinute, label: 'Events / min', hint: `${health.events.total} total` }),
      h(Stat, { value: health.commands.total, label: 'Commands run', hint: `${health.commands.perMinute}/min` }),
      h(Stat, { value: health.errors.total, label: 'Client errors' }),
      h(Stat, { value: health.reconnects.count, label: 'Reconnects', hint: `${health.rateLimits.hits} rate limits` })),

    h('div', { className: 'sub-head' }, 'Schedulers'),
    h('div', { className: 'chip-row' }, (health.schedulers || []).map((entry: any) =>
      // A switched-off module's loop is stopped on purpose: shown as off, not as a failure.
      entry.enabled === false
        ? h('span', { key: entry.name, className: 'chip' }, `${entry.name}: module off`)
        : h('span', { key: entry.name, className: `chip ${entry.running ? 'chip-ok' : 'chip-danger'}` }, `${entry.name}: ${entry.running ? 'running' : 'stopped'}`))),

    (health.errors.recent || []).length
      ? h(React.Fragment, null,
          h('div', { className: 'sub-head' }, 'Recent errors'),
          h('div', { className: 'list-scroll' }, health.errors.recent.map((entry: any, index: number) =>
            h('div', { className: 'log-row', key: index },
              h('div', { className: 'chip-row' },
                h('span', { className: 'chip chip-danger' }, `×${entry.count}`),
                h('span', { className: 'muted' }, new Date(entry.at).toLocaleTimeString())),
              h('div', { className: 'log-message' }, entry.message)))))
      : null,

    h('div', { className: 'row-end' }, h('button', { className: 'btn btn-quiet', disabled: busy, onClick: load }, 'Refresh')));
}

function Stat({ value, label, hint }: any) {
  return h('div', { className: 'stat' },
    h('span', { className: 'stat-value' }, String(value)),
    h('span', { className: 'stat-label' }, label),
    hint ? h('span', { className: 'stat-hint' }, hint) : null);
}

function AuditSection({ flash }: any) {
  const [state, setState] = useState<any>({ entries: [], areas: [] });
  const [area, setArea] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void load(area); }, [area]);
  async function load(filterArea: string) {
    setBusy(true);
    try { setState(await getJson(`/api/audit?limit=100${filterArea ? `&area=${encodeURIComponent(filterArea)}` : ''}`)); }
    catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function clear() {
    const ok = await confirmDialog({
      title: 'Clear the audit log?',
      message: 'Every recorded change for this server is removed. This cannot be undone.',
      confirmLabel: 'Clear log',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await postJson('/api/audit/clear', {});
      setState({ entries: r.entries, areas: r.areas });
      flash('ok', `${r.cleared} entries removed.`);
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, { icon: FiFileText, title: 'Bot audit log', desc: "Who changed the bot's own configuration, from the dashboard or from chat." },
    h('div', { className: 'segmented' },
      ([['', 'All'], ...(state.areas || []).map((entry: string) => [entry, entry])] as [string, string][]).map(([value, label]) =>
        h('button', { key: value || 'all', type: 'button', className: `seg ${area === value ? 'is-active' : ''}`, onClick: () => setArea(value) }, label))),

    (state.entries || []).length === 0
      ? h('p', { className: 'empty-line muted' }, 'Nothing recorded yet.')
      : h('div', { className: 'list-scroll' }, state.entries.map((entry: any) =>
          h('div', { className: 'log-row', key: entry.id },
            h('div', { className: 'chip-row' },
              h('span', { className: 'chip' }, entry.area),
              h('span', { className: 'chip' }, entry.action),
              h('span', { className: 'muted' }, `${entry.actorName || 'Unknown'} · ${entry.source}`),
              h('span', { className: 'muted' }, new Date(entry.at).toLocaleString())),
            entry.detail ? h('div', { className: 'log-message' }, entry.detail) : null))),

    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-quiet', disabled: busy, onClick: () => load(area) }, 'Refresh'),
      h('button', { className: 'btn btn-danger', onClick: clear }, h(FiTrash2), 'Clear log')));
}

function PurgeBuilder({ data, flash }: any) {
  const [f, setF] = useState({ mode: 'count', count: '50', user: '', channel: '' });
  let command = '';
  if (f.mode === 'count') command = `${PREFIX}purge ${f.count || '50'}`;
  else if (f.mode === 'countUser') command = `${PREFIX}purge count ${f.user ? '@' + f.user : '@user'}${f.channel ? ' #' + f.channel : ''}`;
  else if (f.mode === 'lastUser') command = `${PREFIX}purge last ${f.count || '50'} ${f.user ? '@' + f.user : '@user'}${f.channel ? ' #' + f.channel : ''}`;
  else command = `${PREFIX}purge all ${f.user ? '@' + f.user : ''}${f.channel ? ' #' + f.channel : ''} --confirm`.replace(/\s+/g, ' ').trim();
  return h('section', { className: 'card card-purge' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(FiTrash2)), h('div', null, h('h2', null, 'Purge builder'), h('p', { className: 'muted' }, 'Compose a purge command to run in the target channel.'))),
    h('div', { className: 'card-body' },
      h('div', { className: 'segmented' }, [['count', 'Recent'], ['countUser', 'Count user'], ['lastUser', 'Last from user'], ['all', 'All matching']].map(([m, label]) => h('button', { key: m, className: `seg ${f.mode === m ? 'is-active' : ''}`, onClick: () => setF({ ...f, mode: m }) }, label))),
      h('div', { className: 'grid-2' },
        (f.mode === 'count' || f.mode === 'lastUser') ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Count'), h('input', { className: 'input', value: f.count, onChange: (e: any) => setF({ ...f, count: e.target.value }) })) : null,
        f.mode !== 'count' ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'User ID'), h('input', { className: 'input', value: f.user, onChange: (e: any) => setF({ ...f, user: e.target.value }) })) : null,
        f.mode !== 'count' ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel (optional)'), h(Picker, { value: f.channel, placeholder: 'This channel', options: chanOpts(data.channels), onChange: (v: string) => setF({ ...f, channel: v }) })) : null),
      h(CmdRow, { command, flash })));
}

function PermsBuilder({ data, flash }: any) {
  const [mode, setMode] = useState('clone');
  const [f, setF] = useState({ source: '', target: '', category: '', noDefault: false });
  const [n, setN] = useState({ state: 'on', target: '', category: '', all: false });

  const cloneTarget = f.category ? `category ${f.category}` : (f.target || '<target>');
  const cloneCommand = `${PREFIX}perms clone ${f.source || '<source>'} ${cloneTarget}${f.noDefault ? ' --no-default' : ''} --confirm`;

  const nsfwTarget = n.all ? 'all' : (n.category ? `category ${n.category}` : (n.target || '<target>'));
  const nsfwCommand = `${PREFIX}perms nsfw ${n.state} ${nsfwTarget} --confirm`;

  const command = mode === 'clone' ? cloneCommand : nsfwCommand;

  return h('section', { className: 'card card-perms' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(FiShield)), h('div', null, h('h2', null, 'Channel permission manager'), h('p', { className: 'muted' }, 'Clone permission overwrites, or mass-toggle NSFW across channels.'))),
    h('div', { className: 'card-body' },
      h('div', { className: 'segmented' }, [['clone', 'Permission clone'], ['nsfw', 'Mass NSFW']].map(([m, label]) => h('button', { key: m, className: `seg ${mode === m ? 'is-active' : ''}`, onClick: () => setMode(m) }, label))),
      mode === 'clone'
        ? h('div', null,
            h('div', { className: 'grid-2' },
              h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Source channel'), h(Picker, { value: f.source, placeholder: 'Source channel…', options: chanOpts(data.channels), onChange: (v: string) => setF({ ...f, source: v }) })),
              h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Target channel'), h(Picker, { value: f.target, placeholder: 'Target channel…', disabled: !!f.category, options: chanOpts(data.channels), onChange: (v: string) => setF({ ...f, target: v }) })),
              h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Or category'), h(Picker, { value: f.category, placeholder: 'Category…', options: catOpts(data.categories), onChange: (v: string) => setF({ ...f, category: v }) }))),
            h('label', { className: 'check-row' }, h('input', { type: 'checkbox', checked: f.noDefault, onChange: (e: any) => setF({ ...f, noDefault: e.target.checked }) }), h('span', null, 'Skip default permissions (role overwrites only)')))
        : h('div', null,
            h('div', { className: 'segmented mode-seg' }, [['on', 'NSFW on'], ['off', 'NSFW off']].map(([s, label]) => h('button', { key: s, className: `seg ${n.state === s ? 'is-active' : ''}`, onClick: () => setN({ ...n, state: s }) }, label))),
            h('div', { className: 'grid-2' },
              h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Target channel'), h(Picker, { value: n.target, placeholder: 'Target channel…', disabled: n.all || !!n.category, options: chanOpts(data.channels), onChange: (v: string) => setN({ ...n, target: v }) })),
              h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Or category'), h(Picker, { value: n.category, placeholder: 'Category…', disabled: n.all, options: catOpts(data.categories), onChange: (v: string) => setN({ ...n, category: v }) }))),
            h('label', { className: 'check-row' }, h('input', { type: 'checkbox', checked: n.all, onChange: (e: any) => setN({ ...n, all: e.target.checked }) }), h('span', null, 'Apply to every channel in the server')),
            h('div', { className: 'banner banner-danger' }, h(FiAlertTriangle), 'Mass NSFW marks the selected channels as age-restricted for all members.')),
      h(CmdRow, { command, flash })));
}

function CmdRow({ command, flash }: any) {
  async function copy() { try { await navigator.clipboard.writeText(command); flash('ok', 'Command copied.'); } catch { flash('error', 'Copy failed.'); } }
  return h('div', { className: 'cmd-preview' }, h('code', null, command), h('button', { className: 'btn btn-quiet', onClick: copy }, h(FiCopy), 'Copy'));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
