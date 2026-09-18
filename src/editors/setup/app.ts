import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiAward, FiHash, FiPlus, FiRefreshCw, FiRotateCcw, FiTag, FiTerminal, FiTrash2, FiUploadCloud, FiUsers, FiFileText } from 'react-icons/fi';
import { delJson, getJson, postJson } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select, noneOption } from '../shared/select.js';
import { SaveBar, Switch, confirmDialog, postToShell } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

type Stats = { channelId: string; mode: 'all' | 'role'; roleId?: string; label?: string };
type Tickets = Record<string, string>;
type LogsDraft = { enabled: boolean; channelId: string };
type Branding = {
  name: string;
  fallbackName: string;
  nameCustom: boolean;
  logoCustom: boolean;
  logoStamp: string;
  maxLogoBytes: number;
  maxNameLength: number;
};

const TICKET_KEYS = ['openTicketsCategoryId', 'closedTicketsCategoryId', 'transcriptChannelId', 'supportRoleId'];
const logsDraft = (logs: any): LogsDraft => ({ enabled: !!logs?.enabled, channelId: logs?.channelId || '' });
// The field is left empty while the name comes from BOT_NAME / the default, so
// the placeholder can show what clearing it falls back to.
const brandDraft = (branding: any): string => (branding?.nameCustom ? String(branding.name || '') : '');
const logoSrc = (branding: any) => `/brand/logo?v=${encodeURIComponent(branding?.logoStamp || '')}`;
// Same idea for the prefix: empty field means "use PREFIX / the default".
const prefixDraft = (data: any): string => (data?.prefixCustom ? String(data.prefix || '') : '');

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);
  // Tickets and logs are settings: edited as a draft, saved with the save bar.
  // Join roles and stats channels are lists: adding or removing acts at once.
  const [tickets, setTickets] = useState<Tickets>({});
  const [logs, setLogs] = useState<LogsDraft>({ enabled: false, channelId: '' });
  // The display name is a draft; the logo is a file action and applies at once.
  const [brandName, setBrandName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try {
      const d = await getJson('/api/config');
      setData(d);
      setTickets({ ...d.tickets });
      setLogs(logsDraft(d.logs));
      setBrandName(brandDraft(d.branding));
      setPrefix(prefixDraft(d));
    } catch (e: any) { flash('error', e.message); } finally { setLoading(false); }
  }
  function flash(tone: string, text: string) {
    setToast({ tone, text });
    if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600);
  }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const savedLogs = logsDraft(data.logs);
  const savedBrandName = brandDraft(data.branding);
  const savedPrefix = prefixDraft(data);
  const ticketsDirty = TICKET_KEYS.some((key) => (tickets[key] || '') !== (data.tickets?.[key] || ''));
  const logsDirty = logs.enabled !== savedLogs.enabled || (logs.enabled && logs.channelId !== savedLogs.channelId);
  const brandDirty = !data.guest && brandName.trim() !== savedBrandName;
  const prefixDirty = !data.guest && prefix.trim() !== savedPrefix;
  const dirty = ticketsDirty || logsDirty || brandDirty || prefixDirty;

  async function reload() {
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', message: 'Reloading replaces your edits with the saved settings.', confirmLabel: 'Discard and reload', danger: true }))) return;
    load();
  }

  // Branding is bot-wide: fold the new values back into the page and tell the
  // dashboard shell, so the sidebar and tab title change without a reload.
  function applyBranding(branding: Branding) {
    setData((d: any) => ({ ...d, branding, botName: branding.name }));
    setBrandName(brandDraft(branding));
    postToShell({ type: 'yaosb-brand', name: branding.name, logoStamp: branding.logoStamp });
  }

  async function save() {
    if (logs.enabled && !logs.channelId) { flash('error', 'Choose a channel for server logs, or turn logging off.'); return; }
    setBusy(true);
    try {
      if (brandDirty) {
        const r = await postJson('/api/brand', { name: brandName.trim() });
        applyBranding(r.branding);
      }
      if (prefixDirty) {
        const r = await postJson('/api/prefix', { prefix: prefix.trim() });
        setData((d: any) => ({ ...d, ...r }));
        setPrefix(prefixDraft(r));
        // Every editor compiles the prefix into its bundle, so the other
        // frames are now stale; the shell rebuilds the ones it safely can.
        postToShell({ type: 'yaosb-prefix', prefix: r.prefix });
      }
      if (ticketsDirty) {
        const r = await postJson('/api/tickets', tickets);
        setData((d: any) => ({ ...d, tickets: r.tickets }));
        setTickets({ ...r.tickets });
      }
      if (logsDirty) {
        const r = logs.enabled ? await postJson('/api/logs', { channelId: logs.channelId }) : await postJson('/api/logs/disable', {});
        setData((d: any) => ({ ...d, logs: r.logs }));
        setLogs(logsDraft(r.logs));
      }
      flash('ok', 'Settings saved.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  function discard() {
    setTickets({ ...data.tickets });
    setLogs(savedLogs);
    setBrandName(savedBrandName);
    setPrefix(savedPrefix);
  }

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null, h('h1', null, 'Server setup'), h('p', { className: 'muted' }, `Tickets, join roles, stats channels and logs for ${data.branding?.name || BOT_NAME}.`)),
      h('button', { className: 'btn btn-quiet', onClick: reload }, h(FiRefreshCw), 'Reload')),
    data.guest ? null : h(BrandingSection, { branding: data.branding, name: brandName, onName: setBrandName, onApply: applyBranding, flash }),
    data.guest ? null : h(CommandsSection, { data, prefix, onPrefix: setPrefix }),
    h(TicketsSection, { data, form: tickets, onChange: setTickets }),
    h(JoinRolesSection, { data, flash, onChange: (j: string[]) => setData((d: any) => ({ ...d, joinRoles: j })) }),
    h(StatsSection, { data, flash, onChange: (s: Stats[]) => setData((d: any) => ({ ...d, stats: s })) }),
    h(LogsSection, { data, draft: logs, onChange: setLogs }),
    h(SaveBar, { dirty, busy, onSave: save, onDiscard: discard }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(icon)), h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

// A dropdown styled like the text inputs around it, plus an escape hatch:
// picking "Enter ID manually…" swaps to a text field so an id that isn't in
// the list (or a channel the cache missed) can still be typed. A value that is
// not among the options is shown in manual mode automatically.
function Picker({ value, onChange, options, placeholder, disabled, label }: any) {
  const known = (options || []).some((o: any) => o.value === value);
  const [manual, setManual] = useState<boolean>(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  if (manual) {
    return h('div', { className: 'picker-id' },
      h('input', { className: 'input', value: value || '', placeholder: 'Paste ID', disabled, autoFocus: focusManual, 'aria-label': label, onChange: (e: any) => onChange(e.target.value) }),
      h('button', { type: 'button', className: 'btn btn-quiet', title: 'Choose from list', disabled, onClick: () => { setManual(false); onChange(''); } }, 'List'));
  }
  return h(Select, {
    value: value || '',
    disabled,
    label,
    options: [noneOption(placeholder || 'Choose…'), ...(options || []), MANUAL_ID_OPTION],
    onChange: (v: string) => {
      if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
    },
  });
}
const chanOpts = (list: any[]) => (list || []).map((c: any) => ({ value: c.id, label: `#${c.name}` }));
const roleOpts = (list: any[]) => (list || []).map((r: any) => ({ value: r.id, label: `@${r.name}` }));
const catOpts = (list: any[]) => (list || []).map((c: any) => ({ value: c.id, label: c.name }));
// Resolve an id back to a readable name for display, falling back to the id.
const nameFrom = (list: any[], id: string, prefix = '') => {
  const match = (list || []).find((x: any) => x.id === id);
  return match ? `${prefix}${match.name}` : id;
};

/** Read a picked file the way the branding API expects it: a `data:` URI. */
function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Name and logo. The name is a draft like the other settings, but a picked
 * file uploads at once — there is nothing to review in a pending file, and the
 * preview beside it is the confirmation.
 */
function BrandingSection({ branding, name, onName, onApply, flash }: any) {
  const [busy, setBusy] = useState(false);
  const maxBytes = Number(branding?.maxLogoBytes) || 512 * 1024;
  const fallbackName = branding?.fallbackName || 'YetAnotherOverengineeredStoatBot';

  async function upload(file: File | null) {
    if (!file) return;
    if (file.size > maxBytes) {
      flash('error', `That image is ${Math.round(file.size / 1024)}KB. The limit is ${Math.round(maxBytes / 1024)}KB.`);
      return;
    }
    setBusy(true);
    try {
      const r = await postJson('/api/brand', { logo: await readFileAsDataUri(file) });
      onApply(r.branding);
      flash('ok', 'Logo updated.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function useDefault() {
    if (!(await confirmDialog({
      title: 'Go back to the default logo?',
      message: 'The uploaded logo is deleted and the one shipped with the bot takes over.',
      confirmLabel: 'Use default logo',
      danger: true,
    }))) return;
    setBusy(true);
    try {
      const r = await postJson('/api/brand', { logo: '' });
      onApply(r.branding);
      flash('info', 'Default logo restored.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  return h(Section, { icon: FiAward, title: 'Branding', desc: 'The name and logo the dashboard, transcripts and bot replies use. Bot-wide, not per server.' },
    h('div', { className: 'brand-row' },
      h('img', { className: 'brand-preview', src: logoSrc(branding), alt: '', width: 48, height: 48 }),
      h('div', { className: 'brand-row-text' },
        h('span', { className: 'brand-row-name' }, name.trim() || fallbackName),
        h('span', { className: 'muted' }, branding?.logoCustom ? 'Custom logo' : 'Default logo · PNG, JPEG, GIF, WebP or SVG')),
      h('div', { className: 'brand-row-actions' },
        h('label', { className: 'upload' }, h(FiUploadCloud),
          h('span', null, branding?.logoCustom ? 'Replace logo' : 'Upload logo'),
          h('input', {
            type: 'file',
            accept: 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml',
            disabled: busy,
            onChange: (e: any) => { const file = e.target.files?.[0] || null; e.target.value = ''; upload(file); },
          })),
        branding?.logoCustom
          ? h('button', { type: 'button', className: 'btn btn-quiet', disabled: busy, onClick: useDefault }, h(FiRotateCcw), 'Default')
          : null)),
    h('label', { className: 'field' },
      h('span', { className: 'field-label' }, 'Display name'),
      h('input', {
        className: 'input',
        value: name,
        maxLength: branding?.maxNameLength || 80,
        placeholder: fallbackName,
        'aria-label': 'Bot display name',
        onChange: (e: any) => onName(e.target.value),
      }),
      h('span', { className: 'field-hint' }, `Leave empty to fall back to ${fallbackName} (BOT_NAME in the environment).`)));
}

/**
 * The command prefix. A draft like the other settings, but it reaches further:
 * it decides what the bot answers to in chat, so the field shows the resulting
 * command as you type.
 */
function CommandsSection({ data, prefix, onPrefix }: any) {
  const effective = prefix.trim() || data.fallbackPrefix || '!';
  return h(Section, { icon: FiTerminal, title: 'Commands', desc: 'What every chat command starts with. Bot-wide, not per server.' },
    h('label', { className: 'field' },
      h('span', { className: 'field-label' }, 'Command prefix'),
      h('div', { className: 'prefix-row' },
        h('input', {
          className: 'input prefix-input',
          value: prefix,
          maxLength: data.maxPrefixLength || 8,
          placeholder: data.fallbackPrefix || '!',
          spellCheck: false,
          'aria-label': 'Command prefix',
          onChange: (e: any) => onPrefix(e.target.value),
        }),
        h('code', { className: 'prefix-preview' }, `${effective}help`)),
      h('span', { className: 'field-hint' }, `Up to ${data.maxPrefixLength || 8} characters, no spaces. Leave empty to fall back to ${data.fallbackPrefix || '!'} (PREFIX in the environment).`)));
}

function TicketsSection({ data, form, onChange }: any) {
  const field = (key: string, label: string, options: any[]) => h('label', { className: 'field' },
    h('span', { className: 'field-label' }, label),
    h(Picker, { value: form[key] || '', placeholder: 'Not set', options, onChange: (v: string) => onChange({ ...form, [key]: v }) }));
  return h(Section, { icon: FiTag, title: 'Tickets', desc: 'Where tickets open and close, where transcripts go, and who handles them.' },
    h('div', { className: 'grid-2' },
      field('openTicketsCategoryId', 'Open tickets category', catOpts(data.categories)),
      field('closedTicketsCategoryId', 'Closed tickets category', catOpts(data.categories)),
      field('transcriptChannelId', 'Transcript channel', chanOpts(data.channels)),
      field('supportRoleId', 'Support role', roleOpts(data.roles))));
}

function JoinRolesSection({ data, flash, onChange }: any) {
  const [roleId, setRoleId] = useState('');
  async function add() {
    if (!roleId.trim()) { flash('error', 'Choose a role to add.'); return; }
    try { const r = await postJson('/api/joinroles', { roleId }); onChange(r.joinRoles); setRoleId(''); flash('ok', 'Join role added.'); }
    catch (e: any) { flash('error', e.message); }
  }
  async function remove(id: string) {
    try { const r = await delJson(`/api/joinroles/${encodeURIComponent(id)}`); onChange(r.joinRoles); flash('info', 'Join role removed.'); }
    catch (e: any) { flash('error', e.message); }
  }
  return h(Section, { icon: FiUsers, title: 'Join roles', desc: 'Roles given to every new member. Adding or removing one takes effect right away.' },
    (data.joinRoles || []).length === 0 ? h('p', { className: 'empty-line muted' }, 'No join roles yet.')
      : h('div', { className: 'chips' }, data.joinRoles.map((id: string) => {
          const name = nameFrom(data.roles, id, '@');
          return h('span', { key: id, className: 'data-chip' },
            h('code', null, name),
            h('button', { className: 'chip-x', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onClick: () => remove(id) }, h(FiTrash2)));
        })),
    h('div', { className: 'add-row' },
      h(Picker, { value: roleId, placeholder: 'Choose a role…', label: 'Role to add', options: roleOpts(data.roles), onChange: setRoleId }),
      h('button', { className: 'btn', onClick: add }, h(FiPlus), 'Add role')));
}

function StatsSection({ data, flash, onChange }: any) {
  const [form, setForm] = useState<Stats>({ channelId: '', mode: 'all', roleId: '', label: '' });
  async function add() {
    try { const r = await postJson('/api/stats', form); onChange(r.stats); setForm({ channelId: '', mode: 'all', roleId: '', label: '' }); flash('ok', 'Stats channel added.'); }
    catch (e: any) { flash('error', e.message); }
  }
  async function remove(id: string) {
    try { const r = await delJson(`/api/stats/${encodeURIComponent(id)}`); onChange(r.stats); flash('info', 'Stats channel removed.'); }
    catch (e: any) { flash('error', e.message); }
  }
  async function refresh() {
    try { const r = await postJson('/api/stats/refresh', {}); onChange(r.stats); flash('ok', `Refreshed ${r.result?.updated ?? 0} channel(s).`); }
    catch (e: any) { flash('error', e.message); }
  }
  const stats = data.stats || [];
  return h(Section, { icon: FiHash, title: 'Stats channels', desc: 'Channels whose name shows a live member count. Adding or removing one takes effect right away.' },
    stats.length === 0 ? h('p', { className: 'empty-line muted' }, 'No stats channels yet.')
      : h(React.Fragment, null,
          h('div', { className: 'list' }, stats.map((s: Stats) => {
            const name = `#${nameFrom(data.allChannels, s.channelId)}`;
            return h('div', { key: s.channelId, className: 'list-row' },
              h('span', { className: 'tag' }, s.mode === 'role' ? 'By role' : 'All members'),
              h('code', null, name),
              s.roleId ? h('code', { className: 'muted' }, nameFrom(data.roles, s.roleId, '@')) : null,
              s.label ? h('span', { className: 'muted' }, s.label) : null,
              h('button', { className: 'icon-btn', title: `Remove ${name}`, 'aria-label': `Remove ${name}`, onClick: () => remove(s.channelId) }, h(FiTrash2)));
          })),
          h('div', { className: 'row-start' }, h('button', { className: 'btn btn-quiet', onClick: refresh }, h(FiRefreshCw), 'Update counts now'))),
    h('div', { className: 'stats-form' },
      h('span', { className: 'sub-head' }, 'Add a stats channel'),
      h('div', { className: 'field' },
        h('span', { className: 'field-label' }, 'Count'),
        h('div', { className: 'segmented mode-seg' }, (['all', 'role'] as const).map((m) => h('button', { key: m, type: 'button', className: `seg ${form.mode === m ? 'is-active' : ''}`, onClick: () => setForm({ ...form, mode: m }) }, m === 'all' ? 'All members' : 'Members with a role')))),
      h('div', { className: 'grid-2' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel'),
          h(Picker, { value: form.channelId, placeholder: 'Choose a channel…', options: chanOpts(data.allChannels), onChange: (v: string) => setForm({ ...form, channelId: v }) })),
        form.mode === 'role'
          ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Role'),
              h(Picker, { value: form.roleId, placeholder: 'Choose a role…', options: roleOpts(data.roles), onChange: (v: string) => setForm({ ...form, roleId: v }) }))
          : null),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Name (optional)'),
        h('input', { className: 'input', value: form.label, placeholder: 'e.g. "Members: {count}"', onChange: (e: any) => setForm({ ...form, label: e.target.value }) })),
      h('div', { className: 'row-end' },
        h('button', { className: 'btn btn-accent', onClick: add }, h(FiPlus), 'Add stats channel'))));
}

function LogsSection({ data, draft, onChange }: any) {
  const live = data.logs?.enabled ? `Logging to #${nameFrom(data.channels, data.logs.channelId)}` : 'Not logging';
  return h(Section, { icon: FiFileText, title: 'Server logs', desc: 'Post channel, role, member and message changes to a channel.' },
    h('div', { className: 'toggle-line' },
      h('div', { className: 'toggle-text' },
        h('span', { className: 'toggle-title' }, 'Log server events'),
        h('span', { className: 'status-line' }, h('span', { className: `dot ${data.logs?.enabled ? 'dot-on' : ''}`, 'aria-hidden': true }), live)),
      h(Switch, { checked: draft.enabled, label: 'Log server events', onChange: (enabled: boolean) => onChange({ ...draft, enabled }) })),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Log channel'),
      h(Picker, { value: draft.channelId, disabled: !draft.enabled, placeholder: 'Choose a channel…', options: chanOpts(data.channels), onChange: (channelId: string) => onChange({ ...draft, channelId }) })));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
