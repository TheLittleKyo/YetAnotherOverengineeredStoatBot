import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiAlertTriangle, FiEdit2, FiLayers, FiPlus, FiShield, FiTrash2, FiUnlock } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions, namedOptions, noneOption } from '../shared/select.js';
import { NumberInput, SaveBar, Switch, confirmDialog, promptDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __PREFIX__: string;
const PREFIX = typeof __PREFIX__ === 'string' ? __PREFIX__ : '!';

const ACTION_LABEL: Record<string, string> = {
  warn: 'Warn', mute: 'Mute', unmute: 'Unmute', kick: 'Kick', ban: 'Ban', unban: 'Unban', note: 'Note',
};

const MUTE_PRESETS = [
  ['10m', 10 * 60_000],
  ['1h', 60 * 60_000],
  ['6h', 6 * 60 * 60_000],
  ['1d', 24 * 60 * 60_000],
  ['7d', 7 * 24 * 60 * 60_000],
  ['28d', 28 * 24 * 60 * 60_000],
] as const;

/** The presets, plus the stored value when chat set something else. */
function durationOptions(current: number | null | undefined) {
  const options: { value: string; label: string }[] = MUTE_PRESETS.map(([label, ms]) => ({ value: String(ms), label }));
  if (current && !options.some((option) => option.value === String(current))) {
    options.push({ value: String(current), label: `${Math.round(current / 60_000)} min (custom)` });
  }
  return options;
}

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    setLoading(true);
    try { setData(await getJson('/api/config')); }
    catch (e: any) { flash('error', e.message); }
    finally { setLoading(false); }
  }
  function flash(tone: string, text: string) {
    setToast({ tone, text });
    if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600);
  }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Moderation'),
        h('p', { className: 'muted' },
          `Case history and the rules behind it. Punishments are issued from chat (\`${PREFIX}warn\`, \`${PREFIX}mute\`, \`${PREFIX}ban\`); this page reviews them, lifts them, and sets what happens automatically.`))),

    h(SummaryCard, { summary: data.summary }),
    h(SettingsCard, { data, setData, flash }),
    h(CasesCard, { data, setData, flash }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function SummaryCard({ summary }: any) {
  const actions = Object.entries(summary?.byAction || {}).filter(([, count]) => (count as number) > 0);
  return h(Section, { icon: FiShield, title: 'At a glance' },
    h('div', { className: 'stat-grid' },
      h(Stat, { value: summary?.total ?? 0, label: 'Cases' }),
      h(Stat, { value: summary?.last30Days ?? 0, label: 'Last 30 days' }),
      h(Stat, { value: summary?.activePunishments ?? 0, label: 'Active now' }),
      h(Stat, {
        value: actions.length ? actions.map(([name, count]) => `${count}`).join(' / ') : '0',
        label: actions.length ? actions.map(([name]) => ACTION_LABEL[name] || name).join(' / ') : 'By action',
      })));
}

function Stat({ value, label, hint }: any) {
  return h('div', { className: 'stat' },
    h('span', { className: 'stat-value' }, String(value)),
    h('span', { className: 'stat-label' }, label),
    hint ? h('span', { className: 'stat-hint' }, hint) : null);
}

function SettingsCard({ data, setData, flash }: any) {
  const [draft, setDraft] = useState<any>(data.settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(data.settings); }, [data.settings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings);
  const set = (patch: any) => setDraft((current: any) => ({ ...current, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const response = await postJson('/api/settings', draft);
      setData((current: any) => ({ ...current, settings: response.settings }));
      flash('ok', 'Settings saved.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  function addRule() {
    set({ escalation: [...(draft.escalation || []), { warns: (draft.escalation?.length || 0) + 3, action: 'mute', durationMs: 3600000 }] });
  }
  function updateRule(index: number, patch: any) {
    const next = [...(draft.escalation || [])];
    next[index] = { ...next[index], ...patch };
    set({ escalation: next });
  }
  function removeRule(index: number) {
    set({ escalation: (draft.escalation || []).filter((_: any, i: number) => i !== index) });
  }

  return h(React.Fragment, null,
    h(Section, { icon: FiShield, title: 'How punishments are applied', desc: 'These apply to commands, automod hits, and the escalation ladder alike.' },
      h('div', { className: 'grid-2' },
        h('label', { className: 'check-row' },
          h('input', { type: 'checkbox', checked: !!draft.dmOnAction, onChange: (e: any) => set({ dmOnAction: e.target.checked }) }),
          h('span', null, 'DM the member what happened and why')),
        h('label', { className: 'check-row' },
          h('input', { type: 'checkbox', checked: !!draft.preferTimeout, onChange: (e: any) => set({ preferTimeout: e.target.checked }) }),
          h('span', null, "Use Stoat's own timeout for mutes (falls back to the role below)"))),

      h('div', { className: 'grid-2' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Mute role (fallback, and for permanent mutes)'),
          h(Select, {
            value: draft.muteRoleId || '',
            options: [noneOption('No mute role'), ...namedOptions(data.roles)],
            onChange: (value: string) => set({ muteRoleId: value || null }),
          })),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Case channel (defaults to the server log)'),
          h(Select, {
            value: draft.caseChannelId || '',
            options: [noneOption('Use the server log channel'), ...channelOptions(data.channels)],
            onChange: (value: string) => set({ caseChannelId: value || null }),
          }))),

      h('div', { className: 'grid-2' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Default mute length'),
          h(Select, {
            value: String(draft.defaultMuteMs),
            options: durationOptions(draft.defaultMuteMs),
            onChange: (value: string) => set({ defaultMuteMs: Number(value) }),
          })),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Warnings expire after (days, 0 = never)'),
          h(NumberInput, { value: draft.warnExpiryDays, min: 0, max: 3650, onChange: (value: number) => set({ warnExpiryDays: value }) })))),

    h(Section, { icon: FiLayers, title: 'Escalation ladder', desc: 'What happens when a member reaches a warning count. Only the rule matching that exact count fires.' },
      (draft.escalation || []).length === 0
        ? h('p', { className: 'empty-line muted' }, 'No escalation rules — warnings only accumulate.')
        : h('div', { className: 'rule-list' }, (draft.escalation || []).map((rule: any, index: number) =>
            h('div', { className: 'rule-row', key: index },
              h('div', { className: 'rule-main' },
                h('div', { className: 'grid-3' },
                  h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'At warnings'),
                    h(NumberInput, { value: rule.warns, min: 1, max: 100, onChange: (value: number) => updateRule(index, { warns: value }) })),
                  h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Action'),
                    h(Select, {
                      value: rule.action,
                      options: [{ value: 'mute', label: 'Mute' }, { value: 'kick', label: 'Kick' }, { value: 'ban', label: 'Ban' }],
                      onChange: (value: string) => updateRule(index, { action: value, durationMs: value === 'kick' ? null : rule.durationMs }),
                    })),
                  rule.action === 'kick' ? null : h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Length'),
                    h(Select, {
                      value: rule.durationMs == null ? '' : String(rule.durationMs),
                      options: [noneOption(rule.action === 'mute' ? 'Permanent (needs a mute role)' : 'Permanent'), ...durationOptions(rule.durationMs)],
                      onChange: (value: string) => updateRule(index, { durationMs: value ? Number(value) : null }),
                    })))),
              h('div', { className: 'rule-actions' },
                h('button', { className: 'icon-btn icon-danger', title: 'Remove rule', 'aria-label': 'Remove rule', onClick: () => removeRule(index) }, h(FiTrash2)))))),
      h('div', { className: 'row-end' },
        h('button', { type: 'button', className: 'btn', onClick: addRule }, h(FiPlus), 'Add rule')),
      h(SaveBar, { dirty, busy, onSave: save, onDiscard: () => setDraft(data.settings) })));
}

function CasesCard({ data, setData, flash }: any) {
  const [filter, setFilter] = useState('all');
  const cases = (data.cases || []).filter((entry: any) => {
    if (filter === 'all') return true;
    if (filter === 'active') return entry.active;
    return entry.action === filter;
  });

  async function editReason(entry: any) {
    const reason = await promptDialog({
      title: `Case #${entry.id}`,
      message: 'Rewrite the reason recorded for this case.',
      confirmLabel: 'Save reason',
      input: { label: 'Reason', defaultValue: entry.reason },
    });
    if (reason == null || !reason.trim()) return;
    try {
      const response = await postJson('/api/case/reason', { id: entry.id, reason });
      setData((current: any) => ({ ...current, cases: response.cases }));
      flash('ok', 'Reason updated.');
    } catch (e: any) { flash('error', e.message); }
  }

  async function remove(entry: any) {
    const ok = await confirmDialog({
      title: `Delete case #${entry.id}?`,
      message: 'The record disappears from the member\'s history. Any punishment already applied stays in force.',
      confirmLabel: 'Delete case',
      danger: true,
    });
    if (!ok) return;
    try {
      const response = await postJson('/api/case/delete', { id: entry.id });
      setData((current: any) => ({ ...current, cases: response.cases, summary: response.summary }));
      flash('ok', 'Case deleted.');
    } catch (e: any) { flash('error', e.message); }
  }

  async function lift(entry: any) {
    const action = entry.action === 'ban' ? 'unban' : 'unmute';
    const ok = await confirmDialog({
      title: `${action === 'unban' ? 'Unban' : 'Unmute'} ${entry.userName}?`,
      message: 'This takes effect immediately and is recorded as its own case.',
      confirmLabel: action === 'unban' ? 'Unban' : 'Unmute',
    });
    if (!ok) return;
    try {
      const response = await postJson('/api/lift', { userId: entry.userId, action });
      setData((current: any) => ({ ...current, cases: response.cases, summary: response.summary }));
      flash('ok', `${entry.userName} was ${action === 'unban' ? 'unbanned' : 'unmuted'}.`);
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, { icon: FiAlertTriangle, title: `Cases (${cases.length})`, desc: 'Newest first. Editing a reason keeps the case; deleting it removes the record only.' },
    h('div', { className: 'segmented' },
      [['all', 'All'], ['active', 'Active'], ['warn', 'Warns'], ['mute', 'Mutes'], ['kick', 'Kicks'], ['ban', 'Bans'], ['note', 'Notes']].map(([value, label]) =>
        h('button', { key: value, type: 'button', className: `seg ${filter === value ? 'is-active' : ''}`, onClick: () => setFilter(value) }, label))),

    cases.length === 0
      ? h('p', { className: 'empty-line muted' }, 'Nothing here yet.')
      : h('div', { className: 'list-scroll' }, cases.map((entry: any) =>
          h('div', { className: 'rule-row', key: entry.id },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('span', { className: 'tag' }, `#${entry.id} ${ACTION_LABEL[entry.action] || entry.action}`),
                entry.active ? h('span', { className: 'chip chip-warn' }, 'active') : null,
                entry.failed ? h('span', { className: 'chip chip-danger' }, 'failed') : null,
                entry.automated ? h('span', { className: 'chip' }, 'automatic') : null,
                h('span', { className: 'rule-scope' }, entry.userName)),
              h('div', { className: 'rule-message' }, entry.reason),
              h('div', { className: 'rule-next muted' },
                `${new Date(entry.createdAt).toLocaleString()} · by ${entry.automated ? 'the bot' : entry.moderatorName}`
                + (entry.expiresAt ? ` · expires ${new Date(entry.expiresAt).toLocaleString()}` : ''))),
            h('div', { className: 'rule-actions' },
              entry.active
                ? h('button', { type: 'button', className: 'btn btn-quiet btn-sm', onClick: () => lift(entry) }, h(FiUnlock), entry.action === 'ban' ? 'Unban' : 'Unmute')
                : null,
              h('button', { className: 'icon-btn', title: 'Edit reason', 'aria-label': 'Edit reason', onClick: () => editReason(entry) }, h(FiEdit2)),
              h('button', { className: 'icon-btn icon-danger', title: 'Delete case', 'aria-label': 'Delete case', onClick: () => remove(entry) }, h(FiTrash2)))))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
