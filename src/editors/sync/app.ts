/**
 * Channel sync page: the live links between channels (in any server the bot
 * is in), their filters, and one-off channel copies.
 *
 * Links are listed as "from → to" rows with their server, direction, filters
 * and last activity; creating or editing one happens in a side panel that
 * asks for the channels first, then direction, name, and optional filters.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FiActivity, FiAlertTriangle, FiArrowRight, FiClock, FiCopy, FiFilter, FiLink, FiPlus, FiRepeat, FiTrash2, FiUsers, FiX,
} from 'react-icons/fi';
import { delJson, getJson, patchJson, postJson } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select, type SelectOption } from '../shared/select.js';
import { confirmDialog, postToShell, useUnsavedChanges } from '../shared/ui.js';

const h = React.createElement;

type Channel = { id: string; name: string };
type Server = { id: string; name: string; channels: Channel[] };
type Mode = 'oneway' | 'twoway';
type FilterKind = 'users' | 'roles' | 'words';
type FilterSide = 'allow' | 'deny';
type Filters = Record<FilterSide, Record<FilterKind, string[]>>;
type Link = {
  id: string;
  label?: string;
  sourceChannelId: string;
  targetChannelId: string;
  sourceName?: string | null;
  targetName?: string | null;
  mode: Mode;
  filters?: Partial<Filters>;
  copies: number;
  lastCopyAt: string | null;
};
type Config = { serverId: string; links: Link[]; servers: Server[] };
type Flash = (tone: string, text: string) => void;

const FILTER_MAX = 100;
const KINDS: Array<[FilterKind, string, string]> = [
  ['users', 'from these members', 'Member ID, then Enter'],
  ['roles', 'from members with these roles', 'Role ID, then Enter'],
  ['words', 'containing these words', 'Word or phrase, then Enter'],
];

// ---- Channel lookups ----------------------------------------------------------

type ChannelInfo = { name: string; serverId: string; serverName: string };

function indexChannels(servers: Server[]): Map<string, ChannelInfo> {
  const map = new Map<string, ChannelInfo>();
  for (const server of servers) {
    for (const channel of server.channels) map.set(channel.id, { name: channel.name, serverId: server.id, serverName: server.name });
  }
  return map;
}

// Every channel the bot can see, the current server's first; the server name
// rides along as the option's second line, and search matches it too.
function channelChoices(servers: Server[], currentServerId: string): SelectOption[] {
  const ordered = [...servers].sort((a, b) => (a.id === currentServerId ? -1 : b.id === currentServerId ? 1 : 0));
  return ordered.flatMap((server) => server.channels.map((c) => ({ value: c.id, label: `#${c.name}`, hint: server.name })));
}

function describeChannel(index: Map<string, ChannelInfo>, id: string, fallbackName?: string | null) {
  const info = index.get(id);
  return {
    channel: info ? `#${info.name}` : fallbackName ? `#${fallbackName}` : id || '—',
    server: info ? info.serverName : 'Unknown server',
    known: !!info,
  };
}

function emptyFilters(): Filters {
  return { allow: { users: [], roles: [], words: [] }, deny: { users: [], roles: [], words: [] } };
}

function toFilters(raw: any): Filters {
  const out = emptyFilters();
  for (const side of ['allow', 'deny'] as FilterSide[]) {
    for (const [kind] of KINDS) out[side][kind] = Array.isArray(raw?.[side]?.[kind]) ? raw[side][kind].map(String) : [];
  }
  return out;
}

function countLabel(n: number, one: string, many: string) {
  return `${n} ${n === 1 ? one : many}`;
}

function filterSummary(raw: any): { only: string; skips: string } {
  const f = toFilters(raw);
  const part = (side: FilterSide) => [
    f[side].users.length ? countLabel(f[side].users.length, 'member', 'members') : '',
    f[side].roles.length ? countLabel(f[side].roles.length, 'role', 'roles') : '',
    f[side].words.length ? countLabel(f[side].words.length, 'word', 'words') : '',
  ].filter(Boolean).join(', ');
  return { only: part('allow'), skips: part('deny') };
}

function timeAgo(iso: string | null): string {
  if (!iso) return '';
  const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

// Mentions pasted from the client (<@id>, <%id>) or sigil-prefixed ids down to the bare id.
function bareId(value: string): string {
  const match = value.trim().match(/^<?[@#%&]?!?([A-Za-z0-9_-]+)>?$/);
  return match ? match[1] : '';
}

// ---- Page ---------------------------------------------------------------------

function App() {
  const [data, setData] = useState<Config | null>(null);
  const [loadError, setLoadError] = useState('');
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);
  const [editor, setEditor] = useState<{ link: Link | null } | null>(null);

  useEffect(() => { void load(); }, []);
  async function load() {
    try {
      const d = await getJson('/api/config');
      setData({ serverId: d.serverId, links: d.links || [], servers: d.servers || [] });
      setLoadError('');
    } catch (e: any) { setLoadError(e.message); }
  }
  const flash: Flash = (tone, text) => {
    setToast({ tone, text });
    if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600);
  };

  if (!data) {
    return h('div', { className: 'wrap' },
      h('div', { className: 'muted', style: { padding: 40 } }, loadError || 'Loading…'));
  }

  const index = indexChannels(data.servers);
  const setLinks = (links: Link[]) => setData((d) => (d ? { ...d, links } : d));

  async function removeLink(link: Link) {
    const from = describeChannel(index, link.sourceChannelId, link.sourceName).channel;
    const to = describeChannel(index, link.targetChannelId, link.targetName).channel;
    const ok = await confirmDialog({
      title: `Delete the link ${from} → ${to}?`,
      message: 'Copying stops right away. Messages already copied stay where they are.',
      confirmLabel: 'Delete link',
      danger: true,
    });
    if (!ok) return false;
    try {
      const r = await delJson(`/api/link/${encodeURIComponent(link.id)}`);
      setLinks(r.links);
      flash('info', 'Link deleted.');
      return true;
    } catch (e: any) { flash('error', e.message); return false; }
  }

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}`, role: 'status' }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Channel sync'),
        h('p', { className: 'muted' }, 'Copy messages from one channel to another, even in a different server. Edits and deletes follow the original.')),
      h('button', { className: 'btn btn-accent', onClick: () => setEditor({ link: null }) }, h(FiPlus), 'New link')),

    h('p', { className: 'sync-note' }, h(FiUsers, { 'aria-hidden': true }),
      'Copies are posted with each author’s name and avatar, so the bot needs the Masquerade permission in every channel it posts to.'),

    h(LinksCard, { data, index, onNew: () => setEditor({ link: null }), onEdit: (link: Link) => setEditor({ link }), onDelete: removeLink }),
    h(CopyCard, { data, index, flash }),

    h('p', { className: 'sync-help muted' }, h(FiActivity, { 'aria-hidden': true }),
      'A link not keeping up? ',
      h('button', { type: 'button', className: 'link-btn', onClick: () => postToShell({ type: 'yaosb-open', ns: 'debug' }) }, 'Check it in Debug tools'),
      '.'),

    editor ? h(LinkEditor, {
      key: editor.link?.id || 'new',
      link: editor.link,
      data,
      index,
      flash,
      onSaved: setLinks,
      onDelete: removeLink,
      onClose: () => setEditor(null),
    }) : null,
  );
}

// ---- Live links ----------------------------------------------------------------

function LinksCard({ data, index, onNew, onEdit, onDelete }: any) {
  const links: Link[] = data.links;
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(FiLink)),
      h('div', { className: 'card-head-text' },
        h('h2', null, 'Live links', links.length ? h('span', { className: 'count' }, links.length) : null),
        h('p', { className: 'muted' }, 'New messages, edits and deletes are copied as they happen. Links that touch this server are listed.'))),
    links.length === 0
      ? h('div', { className: 'empty-state' },
          h('p', { className: 'empty-title' }, 'No links yet'),
          h('p', { className: 'muted' }, 'Pick two channels and the bot keeps them in step.'),
          h('button', { className: 'btn btn-accent', onClick: onNew }, h(FiPlus), 'New link'))
      : h('ul', { className: 'link-list' }, links.map((link) => h(LinkRow, { key: link.id, link, index, onEdit, onDelete }))));
}

function Endpoint({ info }: { info: { channel: string; server: string; known: boolean } }) {
  return h('span', { className: `endpoint${info.known ? '' : ' is-unknown'}` },
    h('span', { className: 'endpoint-channel' }, info.channel),
    h('span', { className: 'endpoint-server' }, info.server));
}

function Direction({ mode }: { mode: Mode }) {
  return h('span', { className: `direction direction-${mode}`, title: mode === 'twoway' ? 'Both ways' : 'One way' },
    h(mode === 'twoway' ? FiRepeat : FiArrowRight, { 'aria-hidden': true }),
    h('span', null, mode === 'twoway' ? 'Both ways' : 'One way'));
}

function LinkRow({ link, index, onEdit, onDelete }: any) {
  const from = describeChannel(index, link.sourceChannelId, link.sourceName);
  const to = describeChannel(index, link.targetChannelId, link.targetName);
  const { only, skips } = filterSummary(link.filters);
  const title = link.label || `${from.channel} ${link.mode === 'twoway' ? '⇄' : '→'} ${to.channel}`;
  return h('li', { className: 'link-row' },
    h('div', { className: 'link-main' },
      h('div', { className: 'link-title' }, title),
      h('div', { className: 'link-route' }, h(Endpoint, { info: from }), h(Direction, { mode: link.mode }), h(Endpoint, { info: to })),
      h('div', { className: 'link-meta' },
        only || skips
          ? h('span', { className: 'meta-item' }, h(FiFilter, { 'aria-hidden': true }),
              [only ? `Only: ${only}` : '', skips ? `Skips: ${skips}` : ''].filter(Boolean).join(' · '))
          : h('span', { className: 'meta-item faint' }, 'Copies every message'),
        h('span', { className: 'meta-item' }, h(FiClock, { 'aria-hidden': true }),
          link.lastCopyAt ? `Last copy ${timeAgo(link.lastCopyAt)}` : 'No copies yet'))),
    h('div', { className: 'link-actions' },
      h('button', { type: 'button', className: 'btn btn-sm', onClick: () => onEdit(link) }, 'Edit'),
      h('button', { type: 'button', className: 'icon-btn icon-danger', title: 'Delete link', 'aria-label': `Delete ${title}`, onClick: () => onDelete(link) }, h(FiTrash2))));
}

// ---- Channel field -------------------------------------------------------------

function ChannelField({ label, hint, value, onChange, options, error, id }: any) {
  const known = options.some((o: SelectOption) => o.value === value);
  const [manual, setManual] = useState<boolean>(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  // Named with aria-label rather than <label for>: a label click would toggle
  // the dropdown behind the menu's own outside-click handling.
  return h('div', { className: 'field' },
    h('span', { className: 'field-label', 'aria-hidden': true }, label),
    manual
      ? h('div', { className: 'picker-id' },
          h('input', { id, className: 'input', value, placeholder: 'Paste a channel ID', 'aria-label': `${label} (channel ID)`, autoFocus: focusManual, onChange: (e: any) => onChange(bareId(e.target.value) || e.target.value.trim()) }),
          h('button', { type: 'button', className: 'btn btn-quiet', onClick: () => { setManual(false); onChange(''); } }, 'List'))
      : h(Select, {
          id,
          label,
          value,
          placeholder: 'Choose a channel…',
          options: [...options, MANUAL_ID_OPTION],
          onChange: (v: string) => {
            if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
          },
        }),
    error ? h('span', { className: 'field-error' }, error) : hint ? h('span', { className: 'field-hint faint' }, hint) : null);
}

// ---- Link editor (side panel) ----------------------------------------------------

function LinkEditor({ link, data, index, flash, onSaved, onDelete, onClose }: any) {
  const isNew = !link;
  const initial = useMemo(() => ({
    source: link?.sourceChannelId || '',
    target: link?.targetChannelId || '',
    mode: (link?.mode || 'oneway') as Mode,
    label: link?.label || '',
    filters: toFilters(link?.filters),
  }), [link]);
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [triedSave, setTriedSave] = useState(false);
  const [roles, setRoles] = useState<Array<{ id: string; name: string; serverId: string; serverName: string }>>([]);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<() => void>(() => {});

  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  useUnsavedChanges(dirty);
  const options = useMemo(() => channelChoices(data.servers, data.serverId), [data]);
  const from = form.source ? describeChannel(index, form.source) : null;
  const to = form.target ? describeChannel(index, form.target) : null;

  // ---- validation ----
  const others: Link[] = data.links.filter((l: Link) => l.id !== link?.id);
  const duplicate = others.find((l) => l.sourceChannelId === form.source && l.targetChannelId === form.target);
  const reverse = others.find((l) => l.sourceChannelId === form.target && l.targetChannelId === form.source);
  const errors: Record<string, string> = {};
  if (!form.source) errors.source = 'Choose the channel to copy from.';
  if (!form.target) errors.target = 'Choose the channel to copy into.';
  else if (form.target === form.source) errors.target = 'Pick a different channel from the one above.';
  else if (duplicate) errors.target = 'These two channels are already linked. Edit that link instead.';
  const canSave = Object.keys(errors).length === 0;
  const shown = (key: string) => (triedSave || (key === 'target' && !!form.target) ? errors[key] : '');

  async function requestClose() {
    if (dirty && !(await confirmDialog({
      title: isNew ? 'Discard this link?' : 'Discard your changes?',
      message: isNew ? 'The link has not been created yet.' : 'The link keeps its saved settings.',
      confirmLabel: 'Discard',
      danger: true,
    }))) return;
    onClose();
  }
  closeRef.current = requestClose;

  // Modal behaviour: dim the dashboard around the frame, close on Escape or a
  // click on the dimmed area, and put focus back where it was.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>('.select-trigger, input')?.focus();
    postToShell({ type: 'yaosb-modal', open: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.dialog-scrim')) closeRef.current(); };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === location.origin && e.data?.type === 'yaosb-modal-dismiss' && !document.querySelector('.dialog-scrim')) closeRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
      postToShell({ type: 'yaosb-modal', open: false });
      opener?.focus?.();
    };
  }, []);

  // Role names for the filters, from the servers the two channels are in.
  const serverIds = [...new Set([from?.known && index.get(form.source)?.serverId, to?.known && index.get(form.target)?.serverId].filter(Boolean))] as string[];
  const serverKey = serverIds.join(',');
  useEffect(() => {
    if (!serverKey) { setRoles([]); return undefined; }
    let live = true;
    const query = serverKey.split(',').map((id) => `serverId=${encodeURIComponent(id)}`).join('&');
    getJson(`/api/roles?${query}`).then((r: any) => { if (live) setRoles(r.roles || []); }).catch(() => { if (live) setRoles([]); });
    return () => { live = false; };
  }, [serverKey]);
  const multiServer = new Set(roles.map((r) => r.serverId)).size > 1;
  const roleOptions: SelectOption[] = roles.map((r) => ({ value: r.id, label: r.name, hint: multiServer ? r.serverName : undefined }));
  const roleLabel = (id: string) => {
    const role = roles.find((r) => r.id === id);
    return role ? (multiServer ? `${role.name} · ${role.serverName}` : role.name) : id;
  };

  function setFilter(side: FilterSide, kind: FilterKind, list: string[]) {
    setForm((f) => ({ ...f, filters: { ...f.filters, [side]: { ...f.filters[side], [kind]: list } } }));
  }

  async function save() {
    setTriedSave(true);
    if (!canSave) return;
    setSaving(true);
    try {
      const body = { source: form.source, target: form.target, mode: form.mode, label: form.label.trim(), filters: form.filters };
      const r = isNew
        ? await postJson('/api/link', body)
        : await patchJson(`/api/link/${encodeURIComponent(link.id)}`, body);
      onSaved(r.links);
      flash('ok', isNew ? 'Link created. New messages will be copied from now on.' : 'Link saved.');
      onClose();
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (await onDelete(link)) onClose();
  }

  const autoName = from && to ? `${from.channel} ${form.mode === 'twoway' ? '⇄' : '→'} ${to.channel}` : 'e.g. Announcements to hub';
  const sentence = from && to && form.source !== form.target
    ? form.mode === 'twoway'
      ? `Messages in ${from.channel} (${from.server}) and ${to.channel} (${to.server}) are copied to each other.`
      : `Messages in ${from.channel} (${from.server}) are copied to ${to.channel} (${to.server}). Nothing goes back.`
    : '';

  return h('div', { className: 'drawer-scrim', onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) void requestClose(); } },
    h('aside', { ref: panelRef, className: 'drawer', role: 'dialog', 'aria-modal': true, 'aria-labelledby': 'link-editor-title' },
      h('div', { className: 'drawer-head' },
        h('div', null,
          h('h2', { id: 'link-editor-title' }, isNew ? 'New link' : 'Edit link'),
          h('p', { className: 'muted' }, isNew ? 'Choose where messages come from and where they go.' : 'Changes apply to new messages.')),
        h('button', { type: 'button', className: 'icon-btn', 'aria-label': 'Close', title: 'Close', onClick: requestClose }, h(FiX))),

      h('div', { className: 'drawer-body' },
        h('section', { className: 'drawer-section' },
          h('h3', { className: 'drawer-title' }, h('span', { className: 'step' }, '1'), 'Channels'),
          h(ChannelField, {
            id: 'link-from', label: 'Copy from', hint: 'Where members write.', value: form.source, options,
            error: shown('source'), onChange: (source: string) => setForm((f) => ({ ...f, source })),
          }),
          h('div', { className: 'direction-choice', role: 'radiogroup', 'aria-label': 'Direction' },
            ([['oneway', 'One way', 'Only into the second channel', FiArrowRight], ['twoway', 'Both ways', 'Each channel copies the other', FiRepeat]] as const)
              .map(([value, title, desc, Icon]) => h('button', {
                key: value, type: 'button', role: 'radio', 'aria-checked': form.mode === value,
                className: `direction-card${form.mode === value ? ' is-active' : ''}`,
                onClick: () => setForm((f) => ({ ...f, mode: value })),
              },
                h(Icon, { 'aria-hidden': true }),
                h('span', { className: 'direction-text' }, h('strong', null, title), h('span', null, desc))))),
          h(ChannelField, {
            id: 'link-to', label: form.mode === 'twoway' ? 'And' : 'Copy into', hint: 'Copies are posted here.', value: form.target, options,
            error: shown('target'), onChange: (target: string) => setForm((f) => ({ ...f, target })),
          }),
          sentence ? h('p', { className: 'route-sentence' }, sentence) : null,
          !errors.target && reverse
            ? h('p', { className: 'route-warn' }, h(FiAlertTriangle, { 'aria-hidden': true }),
                reverse.mode === 'twoway' || form.mode === 'twoway'
                  ? 'Another link already copies between these channels, so messages would be posted twice. Edit that link instead.'
                  : 'A link already copies the other way. One link set to Both ways does the same with less to manage.')
            : null),

        h('section', { className: 'drawer-section' },
          h('h3', { className: 'drawer-title' }, h('span', { className: 'step' }, '2'), 'Name ', h('span', { className: 'optional' }, 'optional')),
          h('input', {
            className: 'input', value: form.label, maxLength: 60, placeholder: autoName, 'aria-label': 'Link name',
            onChange: (e: any) => setForm((f) => ({ ...f, label: e.target.value })),
          }),
          h('span', { className: 'field-hint faint' }, 'Shown in the list. Leave empty to use the channel names.')),

        h('section', { className: 'drawer-section' },
          h('h3', { className: 'drawer-title' }, h('span', { className: 'step' }, '3'), 'Filters ', h('span', { className: 'optional' }, 'optional')),
          h('p', { className: 'field-hint faint' }, 'Leave these empty to copy every message. Filters apply to new messages; copies already posted stay.'),
          h(FilterGroup, {
            title: 'Only copy messages…', desc: 'When anything is listed here, all other messages are skipped.',
            side: 'allow', filters: form.filters, roleOptions, roleLabel, onChange: setFilter,
          }),
          h(FilterGroup, {
            title: 'Never copy messages…', desc: 'Wins over the list above.',
            side: 'deny', filters: form.filters, roleOptions, roleLabel, onChange: setFilter,
          }),
          h('p', { className: 'field-hint faint' }, 'Words match whole words and ignore case. Use * as a wildcard, like spam*.'))),

      h('div', { className: 'drawer-foot' },
        isNew ? h('span') : h('button', { type: 'button', className: 'btn btn-quiet btn-danger', onClick: remove }, h(FiTrash2), 'Delete link'),
        h('div', { className: 'drawer-foot-actions' },
          h('button', { type: 'button', className: 'btn btn-quiet', onClick: requestClose }, 'Cancel'),
          h('button', { type: 'button', className: 'btn btn-accent', disabled: saving || (!isNew && !dirty), onClick: save },
            isNew ? h(FiPlus) : null, saving ? 'Saving…' : isNew ? 'Create link' : 'Save changes')))));
}

function FilterGroup({ title, desc, side, filters, roleOptions, roleLabel, onChange }: any) {
  const total = KINDS.reduce((n, [kind]) => n + filters[side][kind].length, 0);
  return h('div', { className: `filter-group filter-${side}` },
    h('div', { className: 'filter-group-head' },
      h('strong', null, title),
      total ? h('span', { className: 'count' }, total) : null,
      h('span', { className: 'faint' }, desc)),
    KINDS.map(([kind, label, placeholder]) => h('div', { key: kind, className: 'filter-row' },
      h('span', { className: 'filter-label' }, label),
      h(ChipInput, {
        values: filters[side][kind],
        placeholder,
        words: kind === 'words',
        label: `${title.replace('…', '')} ${label}`,
        labelFor: kind === 'roles' ? roleLabel : undefined,
        options: kind === 'roles' && roleOptions.length ? roleOptions : undefined,
        onChange: (list: string[]) => onChange(side, kind, list),
      }))));
}

// A list of removable chips plus an input that adds on Enter. Ids split on
// spaces and commas so a pasted batch lands as separate entries; words split on
// new lines only, so a phrase with a comma stays whole. Roles are picked from a
// list when one is available.
function ChipInput({ values, onChange, placeholder, words, labelFor, options, label }: any) {
  const [draft, setDraft] = useState('');
  const [manual, setManual] = useState(false);
  const keyOf = (v: string) => (words ? v.toLowerCase() : v);

  function add(raw: string) {
    const parts = raw.split(words ? /\n/ : /[\s,]+/).map((part) => part.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const cleaned = words ? parts.filter((p) => p.replace(/\*/g, '').trim()).map((p) => p.slice(0, 100)) : parts.map(bareId).filter(Boolean);
    const seen = new Set(values.map(keyOf));
    const next = [...values];
    for (const entry of cleaned) {
      if (seen.has(keyOf(entry)) || next.length >= FILTER_MAX) continue;
      seen.add(keyOf(entry));
      next.push(entry);
    }
    if (next.length !== values.length) onChange(next);
    setDraft('');
  }

  const showSelect = options && !manual;
  return h('div', { className: 'chip-input' },
    values.length > 0
      ? h('div', { className: 'chips' }, values.map((v: string) => {
          const text = labelFor ? labelFor(v) : v;
          return h('span', { key: v, className: 'data-chip', title: v },
            h('span', { className: words ? 'chip-text' : 'chip-text chip-id' }, text),
            h('button', { type: 'button', className: 'chip-x', 'aria-label': `Remove ${text}`, onClick: () => onChange(values.filter((x: string) => x !== v)) }, h(FiX)));
        }))
      : null,
    showSelect
      ? h(Select, {
          value: '',
          label,
          placeholder: 'Add a role…',
          options: [...options.filter((o: SelectOption) => !values.includes(o.value)), MANUAL_ID_OPTION],
          onChange: (v: string) => { if (v === MANUAL_ID_OPTION.value) setManual(true); else if (v) add(v); },
        })
      : h('div', { className: 'chip-add' },
          h('input', {
            className: 'input',
            value: draft,
            placeholder,
            'aria-label': label,
            onChange: (e: any) => setDraft(e.target.value),
            onPaste: (e: any) => {
              const text = e.clipboardData?.getData('text') || '';
              if ((words ? /\n/ : /[\s,]/).test(text.trim())) { e.preventDefault(); add(`${draft}${text}`); }
            },
            onKeyDown: (e: any) => {
              if (e.key === 'Enter') { e.preventDefault(); add(draft); }
              else if (e.key === 'Backspace' && !draft && values.length) onChange(values.slice(0, -1));
            },
            onBlur: () => { if (draft.trim()) add(draft); },
          }),
          options ? h('button', { type: 'button', className: 'btn btn-quiet', onClick: () => { setManual(false); setDraft(''); } }, 'List') : null));
}

// ---- One-off copy -----------------------------------------------------------------

function CopyCard({ data, index, flash }: any) {
  const options = useMemo(() => channelChoices(data.servers, data.serverId), [data]);
  const [source, setSource] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const same = !!source && source === target;
  const ready = !!source && !!target && !same;

  async function run() {
    if (!ready) return;
    const from = describeChannel(index, source);
    const to = describeChannel(index, target);
    const ok = await confirmDialog({
      title: `Copy ${from.channel} into ${to.channel}?`,
      message: `Every message already in ${from.channel} (${from.server}) is posted into ${to.channel} (${to.server}). This can't be undone.`,
      confirmLabel: 'Copy messages',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await postJson('/api/copy', { source, target });
      const s = r.summary || {};
      flash('ok', `Copied ${s.recreated ?? 0} of ${s.captured ?? 0} messages.${s.warnings?.length ? ` ${s.warnings.length} warning(s).` : ''}`);
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(FiCopy)),
      h('div', { className: 'card-head-text' },
        h('h2', null, 'Copy a channel once'),
        h('p', { className: 'muted' }, 'Posts the messages already in a channel into another one, one time. New messages are not followed; use a live link for that.'))),
    h('div', { className: 'card-body' },
      h('div', { className: 'copy-grid' },
        h(ChannelField, { id: 'copy-from', label: 'Copy from', value: source, options, onChange: setSource }),
        h('span', { className: 'copy-arrow', 'aria-hidden': true }, h(FiArrowRight)),
        h(ChannelField, { id: 'copy-to', label: 'Into', value: target, options, onChange: setTarget, error: same ? 'Pick a different channel.' : '' })),
      h('div', { className: 'row-end' },
        h('button', { type: 'button', className: 'btn', disabled: !ready || busy, onClick: run }, h(FiCopy), busy ? 'Copying… this can take a while' : 'Copy messages'))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
