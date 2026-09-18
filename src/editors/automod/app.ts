import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiFilter, FiPlus, FiSettings, FiTrash2 } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions, namedOptions, noneOption } from '../shared/select.js';
import { FeatureSwitch, NumberInput, Switch, confirmDialog } from '../shared/ui.js';

const h = React.createElement;

const DURATIONS = [
  ['', 'Permanent'],
  ['600000', '10m'],
  ['3600000', '1h'],
  ['21600000', '6h'],
  ['86400000', '1d'],
  ['604800000', '7d'],
];

/** Which extra fields a rule type actually uses. */
function fieldsFor(type: string) {
  return {
    words: type === 'words',
    domains: type === 'links',
    threshold: ['mentions', 'spam', 'duplicates', 'caps', 'emoji', 'newlines', 'attachments', 'zalgo'].includes(type),
    window: type === 'spam' || type === 'duplicates',
  };
}

function thresholdLabel(type: string) {
  switch (type) {
    case 'caps': return 'Trip above (% capitals)';
    case 'spam': return 'Messages allowed in the window';
    case 'duplicates': return 'Identical messages that trip it (min 2)';
    case 'zalgo': return 'Trip above (% combining marks)';
    default: return 'Trip above';
  }
}

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

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

  async function saveSettings(patch: any) {
    setBusy(true);
    try {
      const response = await postJson('/api/settings', patch);
      setData((current: any) => ({ ...current, settings: response.settings }));
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function updateRule(id: string, patch: any) {
    try {
      const response = await postJson('/api/rule/update', { id, ...patch });
      setData((current: any) => ({ ...current, rules: response.rules }));
    } catch (e: any) { flash('error', e.message); }
  }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const settings = data.settings || {};

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Automod'),
        h('p', { className: 'muted' }, 'Filters run on every message, in order, and the first match wins. Anything harsher than a delete opens a moderation case.')),
      h(FeatureSwitch, { feature: 'Automod', enabled: !!settings.enabled, busy, onChange: (next: boolean) => saveSettings({ enabled: next }) })),

    h(Section, { icon: FiSettings, title: 'Exemptions', desc: 'Checked before any rule runs, so staff never trip their own filters.' },
      h('label', { className: 'check-row' },
        h('input', { type: 'checkbox', checked: settings.exemptStaffPermissions !== false, onChange: (e: any) => saveSettings({ exemptStaffPermissions: e.target.checked }) }),
        h('span', null, 'Exempt members with Manage Messages, Manage Channel, Kick or Ban')),
      h('label', { className: 'check-row' },
        h('input', { type: 'checkbox', checked: settings.notifyChannel !== false, onChange: (e: any) => saveSettings({ notifyChannel: e.target.checked }) }),
        h('span', null, 'Post a short "message removed" notice in the channel (deleted after a few seconds)')),
      h('div', { className: 'grid-2' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Hit log channel (defaults to the server log)'),
          h(Select, {
            value: settings.logChannelId || '',
            options: [noneOption('Use the server log channel'), ...channelOptions(data.channels)],
            onChange: (value: string) => saveSettings({ logChannelId: value || null }),
          })),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Add an exempt role'),
          h(Select, {
            value: '',
            options: [noneOption('Choose a role…'), ...namedOptions(data.roles)],
            onChange: (value: string) => value && saveSettings({ exemptRoleIds: Array.from(new Set([...(settings.exemptRoleIds || []), value])) }),
          }))),
      (settings.exemptRoleIds || []).length
        ? h('div', { className: 'rule-top' }, (settings.exemptRoleIds || []).map((roleId: string) =>
            h('button', {
              key: roleId, type: 'button', className: 'chip',
              title: 'Remove exemption',
              onClick: () => saveSettings({ exemptRoleIds: (settings.exemptRoleIds || []).filter((id: string) => id !== roleId) }),
            }, (data.roles || []).find((role: any) => role.id === roleId)?.name || roleId, ' ×')))
        : h('p', { className: 'empty-line muted' }, 'No exempt roles beyond the permission check above.'),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Add an exempt channel'),
        h(Select, {
          value: '',
          options: [noneOption('Choose a channel…'), ...channelOptions(data.channels)],
          onChange: (value: string) => value && saveSettings({ exemptChannelIds: Array.from(new Set([...(settings.exemptChannelIds || []), value])) }),
        })),
      (settings.exemptChannelIds || []).length
        ? h('div', { className: 'rule-top' }, (settings.exemptChannelIds || []).map((channelId: string) =>
            h('button', {
              key: channelId, type: 'button', className: 'chip',
              title: 'Remove exemption',
              onClick: () => saveSettings({ exemptChannelIds: (settings.exemptChannelIds || []).filter((id: string) => id !== channelId) }),
            }, `#${(data.channels || []).find((channel: any) => channel.id === channelId)?.name || channelId}`, ' ×')))
        : null),

    h(RulesCard, { data, setData, flash, updateRule }),
    h(AddRuleCard, { data, setData, flash }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function RulesCard({ data, setData, flash, updateRule }: any) {
  const rules = data.rules || [];
  const [openId, setOpenId] = useState<string | null>(null);

  async function remove(rule: any) {
    const ok = await confirmDialog({ title: `Delete "${rule.name}"?`, message: 'The rule and its hit count are removed.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/rule/delete', { id: rule.id });
      setData((current: any) => ({ ...current, rules: response.rules }));
      flash('ok', 'Rule deleted.');
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, { icon: FiFilter, title: `Rules (${rules.length})`, desc: 'Click a rule to open its settings.' },
    rules.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No rules yet. Add one below.')
      : h('div', { className: 'rule-list' }, rules.map((rule: any) => {
          const shows = fieldsFor(rule.type);
          const open = openId === rule.id;
          return h('div', { className: `rule-row ${rule.enabled ? '' : 'is-off'}`, key: rule.id },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('button', {
                  type: 'button', className: 'btn btn-quiet btn-sm',
                  onClick: () => setOpenId(open ? null : rule.id),
                }, open ? 'Hide' : 'Edit'),
                h('span', { className: 'tag' }, rule.type),
                h('strong', null, rule.name),
                h('span', { className: 'chip' }, rule.action),
                rule.hits ? h('span', { className: 'chip' }, `${rule.hits} hits`) : null),

              open ? h('div', { style: { marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 } },
                h('div', { className: 'grid-3' },
                  h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Name'),
                    h('input', { className: 'input', defaultValue: rule.name, onBlur: (e: any) => updateRule(rule.id, { name: e.target.value }) })),
                  h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Action'),
                    h(Select, {
                      value: rule.action,
                      options: (data.actions || []).map((action: string) => ({ value: action, label: action })),
                      onChange: (value: string) => updateRule(rule.id, { action: value }),
                    })),
                  rule.action === 'mute' || rule.action === 'ban'
                    ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Length'),
                        h(Select, {
                          value: rule.durationMs == null ? '' : String(rule.durationMs),
                          // A mute rule without a length uses the server's default mute length.
                          options: DURATIONS.map(([value, label]) => ({ value, label: !value && rule.action === 'mute' ? 'Server default length' : label })),
                          onChange: (value: string) => updateRule(rule.id, { durationMs: value ? Number(value) : null }),
                        }))
                    : null),

                shows.threshold || shows.window
                  ? h('div', { className: 'grid-2' },
                      shows.threshold ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, thresholdLabel(rule.type)),
                        h(NumberInput, { value: rule.threshold, min: 0, max: 1000, onChange: (value: number) => updateRule(rule.id, { threshold: value }) })) : null,
                      shows.window ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Window (seconds)'),
                        h(NumberInput, { value: rule.windowSec, min: 1, max: 120, onChange: (value: number) => updateRule(rule.id, { windowSec: value }) })) : null)
                  : null,

                shows.words ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Blocked words, one per line — `*` is a wildcard'),
                  h('textarea', {
                    className: 'input textarea', rows: 5, defaultValue: (rule.words || []).join('\n'),
                    onBlur: (e: any) => updateRule(rule.id, { words: String(e.target.value).split('\n').map((word: string) => word.trim()).filter(Boolean) }),
                  })) : null,

                shows.words ? h('label', { className: 'check-row' },
                  h('input', { type: 'checkbox', checked: rule.wholeWord !== false, onChange: (e: any) => updateRule(rule.id, { wholeWord: e.target.checked }) }),
                  h('span', null, 'Whole words only — "ass" will not match "class"')) : null,

                shows.domains ? h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Allowed domains, one per line'),
                  h('textarea', {
                    className: 'input textarea', rows: 4, defaultValue: (rule.allowedDomains || []).join('\n'),
                    onBlur: (e: any) => updateRule(rule.id, { allowedDomains: String(e.target.value).split('\n').map((domain: string) => domain.trim()).filter(Boolean) }),
                  })) : null,

                h('div', { className: 'grid-2' },
                  h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Only in this channel (optional)'),
                    h(Select, {
                      value: (rule.channelIds || [])[0] || '',
                      options: [noneOption('Every channel'), ...channelOptions(data.channels)],
                      onChange: (value: string) => updateRule(rule.id, { channelIds: value ? [value] : [] }),
                    })),
                  h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Skip this channel (optional)'),
                    h(Select, {
                      value: (rule.exemptChannelIds || [])[0] || '',
                      options: [noneOption('None'), ...channelOptions(data.channels)],
                      onChange: (value: string) => updateRule(rule.id, { exemptChannelIds: value ? [value] : [] }),
                    }))),

                h('label', { className: 'check-row' },
                  h('input', { type: 'checkbox', checked: rule.deleteMessage !== false, onChange: (e: any) => updateRule(rule.id, { deleteMessage: e.target.checked }) }),
                  h('span', null, 'Delete the offending message'))) : null),

            h('div', { className: 'rule-actions' },
              h(Switch, {
                checked: !!rule.enabled,
                label: rule.enabled ? 'Disable rule' : 'Enable rule',
                onChange: (next: boolean) => updateRule(rule.id, { enabled: next }),
              }),
              h('button', { className: 'icon-btn icon-danger', title: 'Delete rule', 'aria-label': 'Delete rule', onClick: () => remove(rule) }, h(FiTrash2))));
        })));
}

function AddRuleCard({ data, setData, flash }: any) {
  const [type, setType] = useState('words');
  const [action, setAction] = useState('delete');
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      const response = await postJson('/api/rule', { type, action });
      setData((current: any) => ({ ...current, rules: response.rules }));
      flash('ok', `Added ${response.rule?.name}.`);
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  const selected = (data.ruleTypes || []).find((entry: any) => entry.type === type);

  return h(Section, { icon: FiPlus, title: 'New rule', desc: 'Pick what to watch for; the details are editable right after.' },
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Watch for'),
        h(Select, {
          value: type,
          options: (data.ruleTypes || []).map((entry: any) => ({ value: entry.type, label: entry.label })),
          onChange: setType,
        })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Then'),
        h(Select, {
          value: action,
          options: (data.actions || []).map((entry: string) => ({ value: entry, label: entry })),
          onChange: setAction,
        }))),
    selected?.defaultThreshold ? h('p', { className: 'muted' }, `Starts at a threshold of ${selected.defaultThreshold}; change it after adding.`) : null,
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-accent', disabled: busy, onClick: add }, h(FiPlus), busy ? 'Adding…' : 'Add rule')));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
