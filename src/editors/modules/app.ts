/**
 * Modules page: one switch per feature, for the whole bot. A switched-off
 * module runs nothing at all (see src/modules.ts); each feature's own page
 * still holds its per-server settings.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiAward, FiBarChart2, FiCpu, FiMusic, FiShield, FiUsers, FiZap } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Switch } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const GROUP_ICONS: Record<string, any> = {
  Community: FiUsers,
  Automation: FiZap,
  Safety: FiShield,
  Engagement: FiAward,
  Media: FiMusic,
  Insights: FiBarChart2,
};

function App() {
  const [data, setData] = useState<any>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    try { setData(await getJson('/api/config')); }
    catch (e: any) { flash('error', e.message); }
  }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }

  // Each switch takes effect at once: the bot starts or stops the module's
  // work as soon as the request lands.
  async function toggle(mod: any, enabled: boolean) {
    setPending(mod.key);
    try {
      setData(await postJson('/api/module', { key: mod.key, enabled }));
      flash('ok', `${mod.label} is ${enabled ? 'on' : 'off'}.`);
    } catch (e: any) { flash('error', e.message); }
    finally { setPending(null); }
  }

  if (!data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const modules: any[] = data.modules || [];
  const onCount = modules.filter((m) => m.enabled).length;
  const music = modules.find((m) => m.key === 'music');

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}`, role: 'status' }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Modules'),
        h('p', { className: 'muted' }, `Switch whole features on or off for ${BOT_NAME}, in every server at once. A module that is off runs nothing: no event handling, no timers, and its commands say it is off. Its settings are kept.`))),

    h('div', { className: 'summary' },
      h('div', { className: 'summary-stat' }, h('span', { className: 'summary-value' }, `${onCount} / ${modules.length}`), h('span', { className: 'summary-label' }, 'modules on')),
      h('div', { className: 'summary-stat' }, h('span', { className: 'summary-value' }, `${data.memory?.rssMb ?? '–'} MB`), h('span', { className: 'summary-label' }, 'bot memory (RSS)')),
      h('div', { className: 'summary-note' }, h(FiCpu, { 'aria-hidden': true }),
        h('span', null, 'Core features (tickets, embeds, roles, purge, permissions, backups, dashboard) are always on.'))),

    music && !music.enabled && data.musicLoaded
      ? h('div', { className: 'status-banner' },
          h(FiMusic, { 'aria-hidden': true }),
          h('span', null, 'Music is off, but its code was already loaded in this session. The memory comes back after the next restart.'))
      : null,

    (data.groups || []).map((group: string) => {
      const items = modules.filter((m) => m.group === group);
      if (!items.length) return null;
      return h('section', { className: 'card', key: group },
        h('div', { className: 'card-head' },
          h('span', { className: 'card-icon' }, h(GROUP_ICONS[group] || FiZap, { 'aria-hidden': true })),
          h('div', null, h('h2', null, group), h('p', { className: 'muted' }, `${items.filter((m) => m.enabled).length} of ${items.length} on`))),
        h('div', { className: 'module-list' }, items.map((mod) =>
          h('div', { className: `module-row${mod.enabled ? ' is-on' : ''}`, key: mod.key },
            h('div', { className: 'module-text' },
              h('span', { className: 'module-title' }, mod.label),
              h('span', { className: 'module-desc' }, mod.description),
              h('span', { className: 'module-cost' }, mod.cost)),
            h('div', { className: 'module-control' },
              h('span', { className: 'module-state' }, mod.enabled ? 'On' : 'Off'),
              h(Switch, {
                checked: !!mod.enabled,
                disabled: pending === mod.key,
                label: `${mod.enabled ? 'Turn off' : 'Turn on'} ${mod.label}`,
                onChange: (next: boolean) => toggle(mod, next),
              }))))));
    }));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
