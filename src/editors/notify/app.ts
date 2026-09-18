import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiEdit3, FiPlus, FiRefreshCw, FiTrash2, FiZap } from 'react-icons/fi';
import { API_BASE, getJson, patchJson, postJson } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select, noneOption } from '../shared/select.js';
import { Switch, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;

const DEFAULT_BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

type ProviderInfo = {
  id: string;
  label: string;
  kind: 'live' | 'posts';
  targetLabel: string;
  targetPlaceholder: string;
  extraFields?: Array<{ key: string; label: string; placeholder?: string; required?: boolean }>;
};

type Subscription = {
  id: string;
  platform: string;
  target: string;
  channelId: string;
  serverId: string;
  extra?: Record<string, string>;
  createdAt: string;
  enabled: boolean;
};

function App() {
  const [botName, setBotName] = useState(DEFAULT_BOT_NAME);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState('');

  // New subscription form state.
  const [platform, setPlatform] = useState('');
  const [target, setTarget] = useState('');
  const [channelId, setChannelId] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>({});

  useEffect(() => {
    Promise.all([loadConfig(), refreshSubscriptions()])
      .then(([config]) => {
        setBotName(config.botName || DEFAULT_BOT_NAME);
        setProviders(config.providers || []);
        setChannels(config.channels || []);
        if (config.providers?.length > 0) setPlatform(config.providers[0].id);
      })
      .catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(''), 4000);
    return () => clearTimeout(timer);
  }, [status]);

  const selectedProvider = providers.find((p) => p.id === platform);

  async function refreshSubscriptions() {
    setLoading(true);
    try {
      const subs = await loadSubscriptions();
      setSubscriptions(subs);
      return subs;
    } finally {
      setLoading(false);
    }
  }

  async function addSub() {
    if (!platform || !target || !channelId) {
      setStatus('Platform, target, and channel ID are required.');
      return;
    }
    try {
      const result = await postJson('/api/subscriptions', { platform, target, channelId, extra });
      setStatus(`Added ${result.subscription.platform}/${result.subscription.target}.`);
      setTarget('');
      setExtra({});
      await refreshSubscriptions();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function removeSub(id: string) {
    if (!(await confirmDialog({ title: 'Remove this subscription?', message: 'Pause it instead if you may want it back.', confirmLabel: 'Remove', danger: true }))) return;
    try {
      await deleteJson(`/api/subscriptions/${encodeURIComponent(id)}`);
      setStatus('Subscription removed.');
      await refreshSubscriptions();
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function toggleSub(sub: Subscription) {
    try {
      await patchJson(`/api/subscriptions/${encodeURIComponent(sub.id)}`, { enabled: !sub.enabled });
      await refreshSubscriptions();
      setStatus(`${sub.enabled ? 'Disabled' : 'Enabled'} ${sub.platform}/${sub.target}.`);
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function testSub(sub: Subscription) {
    setStatus(`Testing ${sub.platform}/${sub.target}…`);
    try {
      const result = await postJson('/api/test', { platform: sub.platform, target: sub.target, extra: sub.extra });
      if (result.result?.error) {
        setStatus(`Error: ${result.result.error}`);
      } else if (result.result?.isLive) {
        setStatus(`Live: ${result.result.title || sub.target}`);
      } else if (result.result?.isLive === false) {
        setStatus(`Offline: ${sub.target}`);
      } else if (result.result?.newPosts) {
        setStatus(`${result.result.newPosts.length} new post(s).`);
      } else {
        setStatus('Test complete (no events).');
      }
    } catch (error) {
      setStatus(error.message);
    }
  }

  return h('div', { className: 'app' },
    h('header', { className: 'hero' },
      h('div', null,
        h('h1', null, 'Notifications'),
        h('p', null, `Post to a channel when someone goes live or posts, on 9 platforms. Changes here take effect right away.`),
      ),
      h('div', { className: 'hero-actions' },
        h('button', { className: 'secondary', onClick: refreshSubscriptions }, h(FiRefreshCw), 'Refresh'),
      ),
    ),

    h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'Add subscription'), h('p', null, 'Pick a platform, enter the account to watch, and choose which channel to notify.')),
      ),
      h('div', { className: 'grid2' },
        h(Field, { label: 'Platform', value: platform, onChange: (v: string) => { setPlatform(v); setExtra({}); }, type: 'select', options: providers.map((p) => ({ value: p.id, label: `${p.label} (${p.kind})` })) }),
        h(IdSelect, { label: 'Notify channel', value: channelId, onChange: setChannelId, placeholder: 'Choose a channel…', options: channels.map((c) => ({ value: c.id, label: `#${c.name}` })) }),
      ),
      h(Field, {
        label: selectedProvider?.targetLabel || 'Target',
        value: target,
        onChange: setTarget,
        placeholder: selectedProvider?.targetPlaceholder || '',
      }),
      selectedProvider?.extraFields && selectedProvider.extraFields.length > 0
        ? h('div', { className: 'grid2' },
            selectedProvider.extraFields.map((field) =>
              h(Field, {
                key: field.key,
                label: field.label + (field.required ? ' *' : ''),
                value: extra[field.key] || '',
                onChange: (v: string) => setExtra({ ...extra, [field.key]: v }),
                placeholder: field.placeholder || '',
              }),
            ),
          )
        : null,
      h('div', { className: 'action-row' },
        h('button', { className: 'primary', onClick: addSub }, h(FiPlus), 'Add subscription'),
      ),
    ),

    h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'Subscriptions'), h('p', null, loading ? 'Loading…' : `${subscriptions.length} subscription(s).`)),
      ),
      loading
        ? h('div', { className: 'empty' }, 'Loading…')
        : subscriptions.length === 0
          ? h('div', { className: 'empty' }, 'No subscriptions yet. Add one above.')
          : h('div', { className: 'sub-list' },
              subscriptions.map((sub) => {
                const info = providers.find((p) => p.id === sub.platform);
                const name = `${info?.label || sub.platform} · ${sub.target}`;
                return h('div', { key: sub.id, className: `sub-row ${sub.enabled ? '' : 'disabled'}` },
                  h('div', { className: 'sub-info' },
                    h('strong', null, info?.label || sub.platform),
                    ' · ',
                    h('code', null, sub.target),
                    sub.enabled ? null : h('span', { className: 'row-state' }, 'Paused'),
                    h('br'),
                    h('small', null, `→ #${channels.find((c) => c.id === sub.channelId)?.name || sub.channelId}`),
                  ),
                  h('div', { className: 'sub-actions' },
                    h('button', { className: 'secondary sub-test', onClick: () => testSub(sub), title: 'Check the account now without posting anything' }, h(FiZap), 'Check now'),
                    h(Switch, { checked: !!sub.enabled, label: sub.enabled ? `Pause ${name}` : `Resume ${name}`, onChange: () => toggleSub(sub) }),
                    h('button', { className: 'mini danger', onClick: () => removeSub(sub.id), title: 'Remove', 'aria-label': `Remove ${name}` }, h(FiTrash2)),
                  ),
                );
              }),
            ),
    ),

    h('div', { className: `status ${status ? 'show' : ''}` }, status),
  );
}

// A channel/role/id dropdown with a manual-entry escape hatch. Picking "Enter
// ID manually…" swaps to a text input; a value not in the list shows manual.
function IdSelect({ label, value, onChange, placeholder, options }: any) {
  const known = (options || []).some((o: any) => o.value === value);
  const [manual, setManual] = useState<boolean>(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  return h('label', { className: 'field' },
    h('span', null, label),
    manual
      ? h('div', { className: 'picker-id' },
          h('input', { value: value || '', placeholder: 'Paste ID', autoFocus: focusManual, onChange: (e: any) => onChange(e.target.value) }),
          h('button', { type: 'button', className: 'btn btn-quiet', title: 'Choose from list', onClick: () => { setManual(false); onChange(''); } }, 'List'))
      : h(Select, {
          value: value || '',
          options: [noneOption(placeholder || 'Choose…'), ...(options || []), MANUAL_ID_OPTION],
          onChange: (v: string) => {
            if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
          },
        }),
  );
}

function Field({ label, value, onChange, type = 'text', placeholder = '', options = [] }: any) {
  return h('label', { className: 'field' },
    h('span', null, label),
    type === 'select'
      ? h(Select, { value, options, onChange })
      : h('input', { value, type, placeholder, onChange: (e: any) => onChange(e.target.value) }),
  );
}

async function loadConfig() { return getJson('/api/config'); }
async function loadSubscriptions() { return (await getJson('/api/subscriptions')).subscriptions || []; }

async function deleteJson(url: string) {
  const response = await fetch(API_BASE + url, { method: 'DELETE' });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

createRoot(document.getElementById('root')!).render(h(App));
