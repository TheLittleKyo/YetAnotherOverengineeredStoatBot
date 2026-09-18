/**
 * Debug tools page. Diagnostics live here rather than next to the settings
 * they inspect, so the everyday pages stay about configuration. New tools are
 * added as another card in `App`.
 */
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getJson } from '../shared/api.js';
import { SyncDebugSection } from './sync-debug.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

function App() {
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() { try { setData(await getJson('/api/config')); } catch (e: any) { flash('error', e.message); } }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Debug tools'),
        h('p', { className: 'muted' }, `Diagnostics for ${BOT_NAME}. Read-only checks run straight away; anything that changes a channel asks first.`))),
    data
      ? h(SyncDebugSection, { data, flash })
      : h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
