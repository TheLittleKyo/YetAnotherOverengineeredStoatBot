import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiMessageSquare, FiSmile, FiPlus, FiTrash2, FiHash } from 'react-icons/fi';
import { delJson, getJson, patchJson, postJson } from '../shared/api.js';
import { Select, channelOptions } from '../shared/select.js';
import { Switch, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
declare const __PREFIX__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const RESPONDER_MATCHES = [
  ['contains', 'Contains'],
  ['exact', 'Exact'],
  ['starts', 'Starts with'],
  ['ends', 'Ends with'],
  ['regex', 'Regex'],
];
const REACT_MATCHES = [...RESPONDER_MATCHES, ['all', 'Every message']];

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() { setLoading(true); try { setData(await getJson('/api/config')); } catch (e: any) { flash('error', e.message); } finally { setLoading(false); } }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const channels = data.channels || [];

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Auto responses'),
        h('p', { className: 'muted' }, `Automatic replies and reactions from ${BOT_NAME}. Rules check every new message, and changes here take effect right away.`))),
    h(ResponderSection, { data, channels, flash, onChange: (r: any[]) => setData((d: any) => ({ ...d, responders: r })) }),
    h(ReactSection, { data, channels, flash, onChange: (r: any[]) => setData((d: any) => ({ ...d, reactors: r })) }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(icon)), h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function ChannelPicker({ value, channels, onChange }: any) {
  return h(Select, { value: value || '', options: [{ value: '', label: 'All channels' }, ...channelOptions(channels)], onChange });
}

function MatchSeg({ options, value, onChange }: any) {
  return h('div', { className: 'segmented match-seg' },
    options.map(([m, label]: any) => h('button', { key: m, type: 'button', className: `seg ${value === m ? 'is-active' : ''}`, onClick: () => onChange(m) }, label)));
}

function ResponderSection({ data, channels, flash, onChange }: any) {
  const empty = { trigger: '', response: '', match: 'contains', caseSensitive: false, channelId: '', cooldownSec: '' };
  const [form, setForm] = useState<any>(empty);
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!form.trigger.trim() || !form.response.trim()) { flash('error', 'Trigger and response are required.'); return; }
    setBusy(true);
    try {
      const r = await postJson('/api/responder', { ...form, cooldownSec: Number(form.cooldownSec) || 0 });
      onChange(r.responders); setForm(empty); flash('ok', 'Auto-responder added.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  async function toggle(id: string) {
    try { const r = await patchJson(`/api/responder/${encodeURIComponent(id)}/toggle`, {}); onChange(r.responders); }
    catch (e: any) { flash('error', e.message); }
  }
  async function remove(id: string) {
    if (!(await confirmDialog({ title: 'Delete this auto-responder?', message: 'Pause it instead if you may want it back.', confirmLabel: 'Delete', danger: true }))) return;
    try { const r = await delJson(`/api/responder/${encodeURIComponent(id)}`); onChange(r.responders); flash('info', 'Responder removed.'); }
    catch (e: any) { flash('error', e.message); }
  }

  const responders = data.responders || [];
  return h(Section, { icon: FiMessageSquare, title: 'Auto-responders', desc: 'Reply automatically when a message matches a trigger.' },
    responders.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No auto-responders yet.')
      : h('div', { className: 'rule-list' }, responders.map((r: any) => h(RuleRow, {
          key: r.id, rule: r, channels,
          badges: [r.match, r.caseSensitive ? 'case' : null, r.cooldownMs ? `${Math.round(r.cooldownMs / 1000)}s cd` : null],
          primary: r.trigger, secondary: r.response,
          onToggle: () => toggle(r.id), onRemove: () => remove(r.id),
        }))),
    h('div', { className: 'sub-head' }, 'New auto-responder'),
    h('div', { className: 'form-grid' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Trigger'),
        h('input', { className: 'input', value: form.trigger, placeholder: 'e.g. hello', onChange: (e: any) => setForm({ ...form, trigger: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel'),
        h(ChannelPicker, { value: form.channelId, channels, onChange: (v: string) => setForm({ ...form, channelId: v }) }))),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Response'),
      h('textarea', { className: 'input textarea', rows: 2, value: form.response, placeholder: 'Hi {mention}! 👋   (placeholders: {user} {mention} {channel})', onChange: (e: any) => setForm({ ...form, response: e.target.value }) })),
    h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Match'),
      h(MatchSeg, { options: RESPONDER_MATCHES, value: form.match, onChange: (m: string) => setForm({ ...form, match: m }) })),
    h('div', { className: 'form-grid' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Cooldown (seconds)'),
        h('input', { className: 'input', type: 'number', min: 0, value: form.cooldownSec, placeholder: '0', onChange: (e: any) => setForm({ ...form, cooldownSec: e.target.value }) })),
      h('label', { className: 'check-row check-field' },
        h('input', { type: 'checkbox', checked: form.caseSensitive, onChange: (e: any) => setForm({ ...form, caseSensitive: e.target.checked }) }),
        h('span', null, 'Case-sensitive'))),
    h('div', { className: 'row-end' }, h('button', { className: 'btn btn-accent', disabled: busy, onClick: add }, h(FiPlus), busy ? 'Adding…' : 'Add responder')));
}

function ReactSection({ data, channels, flash, onChange }: any) {
  const empty = { trigger: '', emojis: '', match: 'contains', caseSensitive: false, channelId: '' };
  const [form, setForm] = useState<any>(empty);
  const [busy, setBusy] = useState(false);
  const isAll = form.match === 'all';

  async function add() {
    if (!form.emojis.trim()) { flash('error', 'At least one emoji is required.'); return; }
    if (!isAll && !form.trigger.trim()) { flash('error', 'Provide a trigger, or choose "Every message".'); return; }
    setBusy(true);
    try {
      const r = await postJson('/api/react', { ...form, emojis: form.emojis.trim().split(/\s+/) });
      onChange(r.reactors); setForm(empty); flash('ok', 'Auto-react added.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  async function toggle(id: string) {
    try { const r = await patchJson(`/api/react/${encodeURIComponent(id)}/toggle`, {}); onChange(r.reactors); }
    catch (e: any) { flash('error', e.message); }
  }
  async function remove(id: string) {
    if (!(await confirmDialog({ title: 'Delete this auto-react?', message: 'Pause it instead if you may want it back.', confirmLabel: 'Delete', danger: true }))) return;
    try { const r = await delJson(`/api/react/${encodeURIComponent(id)}`); onChange(r.reactors); flash('info', 'Auto-react removed.'); }
    catch (e: any) { flash('error', e.message); }
  }

  const reactors = data.reactors || [];
  return h(Section, { icon: FiSmile, title: 'Auto-reacts', desc: 'Add emoji reactions automatically to matching messages.' },
    reactors.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No auto-reacts yet.')
      : h('div', { className: 'rule-list' }, reactors.map((r: any) => h(RuleRow, {
          key: r.id, rule: r, channels,
          badges: [r.match, r.caseSensitive ? 'case' : null],
          primary: r.match === 'all' ? '(every message)' : r.trigger, secondary: (r.emojis || []).join(' '),
          onToggle: () => toggle(r.id), onRemove: () => remove(r.id),
        }))),
    h('div', { className: 'sub-head' }, 'New auto-react'),
    h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Match'),
      h(MatchSeg, { options: REACT_MATCHES, value: form.match, onChange: (m: string) => setForm({ ...form, match: m }) })),
    h('div', { className: 'form-grid' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, isAll ? 'Trigger (ignored)' : 'Trigger'),
        h('input', { className: 'input', value: form.trigger, disabled: isAll, placeholder: isAll ? 'Reacts to everything' : 'e.g. gg', onChange: (e: any) => setForm({ ...form, trigger: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel'),
        h(ChannelPicker, { value: form.channelId, channels, onChange: (v: string) => setForm({ ...form, channelId: v }) }))),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Emojis (space-separated)'),
      h('input', { className: 'input', value: form.emojis, placeholder: '🎉 🔥   or a custom emoji id', onChange: (e: any) => setForm({ ...form, emojis: e.target.value }) })),
    h('label', { className: 'check-row check-field' },
      h('input', { type: 'checkbox', checked: form.caseSensitive, disabled: isAll, onChange: (e: any) => setForm({ ...form, caseSensitive: e.target.checked }) }),
      h('span', null, 'Case-sensitive')),
    h('div', { className: 'row-end' }, h('button', { className: 'btn btn-accent', disabled: busy, onClick: add }, h(FiPlus), busy ? 'Adding…' : 'Add auto-react')));
}

function RuleRow({ rule, channels, badges, primary, secondary, onToggle, onRemove }: any) {
  const channelName = rule.channelId ? (channels.find((c: any) => c.id === rule.channelId)?.name || rule.channelId) : null;
  return h('div', { className: `rule-row ${rule.enabled ? '' : 'is-off'}` },
    h('div', { className: 'rule-main' },
      h('div', { className: 'rule-top' },
        h('code', { className: 'rule-trigger' }, primary || '—'),
        rule.enabled ? null : h('span', { className: 'row-state' }, 'Paused'),
        (badges || []).filter(Boolean).map((b: string, i: number) => h('span', { key: i, className: 'tag' }, b))),
      h('div', { className: 'rule-response' }, secondary || ''),
      channelName ? h('div', { className: 'rule-scope' }, h(FiHash), channelName) : null),
    h('div', { className: 'rule-actions' },
      h(Switch, { checked: !!rule.enabled, label: rule.enabled ? `Pause "${primary}"` : `Resume "${primary}"`, onChange: onToggle }),
      h('button', { className: 'icon-btn icon-danger', title: 'Delete', 'aria-label': `Delete "${primary}"`, onClick: onRemove }, h(FiTrash2))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
