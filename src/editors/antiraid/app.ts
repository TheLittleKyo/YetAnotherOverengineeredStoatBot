import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiShield, FiClock, FiBell, FiZap, FiCrosshair, FiPlus } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions } from '../shared/select.js';
import { FeatureOffNotice, FeatureSwitch, NumberInput, SaveBar, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const RAID_ACTIONS = [['kick', 'Kick'], ['ban', 'Ban'], ['alert', 'Alert only']];
const AGE_ACTIONS = [['off', 'Off'], ['alert', 'Alert only'], ['kick', 'Kick'], ['ban', 'Ban']];

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);
  const [honeypotName, setHoneypotName] = useState('');
  const [creating, setCreating] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    setLoading(true);
    try { const d = await getJson('/api/config'); setData(d); setForm(d.settings); setDirty(false); }
    catch (e: any) { flash('error', e.message); } finally { setLoading(false); }
  }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }
  function edit(patch: any) { setForm((f: any) => ({ ...f, ...patch })); setDirty(true); }

  async function save(extra: any = {}) {
    setBusy(true);
    try {
      // Send only what changed since load, so a setting changed elsewhere (e.g.
      // from chat) isn't overwritten by this page's stale copy.
      const changes = Object.fromEntries(Object.entries(form).filter(([key, value]) => data.settings?.[key] !== value));
      const r = await postJson('/api/settings', { ...changes, ...extra });
      setData((d: any) => ({ ...d, settings: r.settings, raid: r.raid })); setForm(r.settings); setDirty(false); flash('ok', 'Settings saved.');
    }
    catch (e: any) {
      // The server asks before turning a channel people post in into the honeypot.
      if (e.data?.needsConfirm && !extra.confirmHoneypot) {
        const ok = await confirmDialog({ title: 'Use this channel as the honeypot?', message: e.message, confirmLabel: 'Use it anyway', danger: true });
        if (ok) return await save({ ...extra, confirmHoneypot: true });
        setForm((f: any) => ({ ...f, honeypotChannelId: data.settings?.honeypotChannelId ?? null }));
        return;
      }
      flash('error', e.message);
    }
    finally { setBusy(false); }
  }
  // The on/off switch takes effect at once and leaves other drafts alone.
  async function toggleEnabled(enabled: boolean) {
    setToggling(true);
    try {
      await postJson('/api/settings', { enabled });
      setData((d: any) => ({ ...d, settings: { ...d.settings, enabled } }));
      setForm((f: any) => ({ ...f, enabled }));
      flash('ok', enabled ? 'Antiraid is on.' : 'Antiraid is off.');
    }
    catch (e: any) { flash('error', e.message); }
    finally { setToggling(false); }
  }
  function discard() { setForm(data.settings); setDirty(false); }
  async function createHoneypot() {
    setCreating(true);
    try {
      const r = await postJson('/api/honeypot', { name: honeypotName.trim() });
      setData((d: any) => ({ ...d, channels: r.channels, settings: { ...d.settings, honeypotChannelId: r.settings.honeypotChannelId } }));
      setForm((f: any) => ({ ...f, honeypotChannelId: r.settings.honeypotChannelId }));
      setHoneypotName('');
      flash('ok', r.settings.enabled ? 'Honeypot channel created.' : 'Honeypot channel created. Enable antiraid to arm it.');
    }
    catch (e: any) { flash('error', e.message); } finally { setCreating(false); }
  }
  async function setLockdown(active: boolean) {
    if (active && !(await confirmDialog({
      title: 'Force raid mode on?',
      message: `Every member who joins while it lasts is handled with the raid action (${form.action}).`,
      confirmLabel: 'Force lockdown',
      danger: true,
    }))) return;
    try { const r = await postJson('/api/lockdown', { active }); setData((d: any) => ({ ...d, raid: r.raid })); flash(active ? 'info' : 'ok', active ? 'Raid mode forced ON.' : 'Raid mode cleared.'); }
    catch (e: any) { flash('error', e.message); }
  }

  if (loading || !form) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const channels = data.channels || [];
  const raidActive = data.raid?.active;
  const honeypotExists = !!data.settings?.honeypotChannelId && channels.some((c: any) => c.id === data.settings.honeypotChannelId);

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null, h('h1', null, 'Antiraid'), h('p', { className: 'muted' }, `Raid protection for ${BOT_NAME}. Detects join floods and gates new accounts.`)),
      h(FeatureSwitch, { feature: 'Antiraid', enabled: !!data.settings?.enabled, busy: toggling, onChange: toggleEnabled })),

    data.settings?.enabled ? null : h(FeatureOffNotice, { feature: 'Antiraid', what: 'Joins are not being checked.', busy: toggling, onEnable: () => toggleEnabled(true) }),

    raidActive
      ? h('div', { className: 'raid-banner active' },
          h(FiZap), h('span', null, 'Raid mode is ACTIVE — new joiners are being actioned.'),
          h('button', { className: 'btn btn-quiet', onClick: () => setLockdown(false) }, 'Clear'))
      : h('div', { className: 'raid-banner' },
          h(FiShield), h('span', null, 'Idle — no raid in progress.'),
          h('button', { className: 'btn btn-danger', onClick: () => setLockdown(true) }, 'Force lockdown')),

    h(Section, { icon: FiShield, title: 'Join-flood detection', desc: 'Trip raid mode when too many members join too fast.' },
      h('div', { className: 'form-grid' },
        h(NumField, { label: 'Join threshold', value: form.joinThreshold, min: 2, onChange: (v: number) => edit({ joinThreshold: v }) }),
        h(NumField, { label: 'Window (seconds)', value: form.joinWindowSec, min: 2, onChange: (v: number) => edit({ joinWindowSec: v }) })),
      h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Action on raiders'),
        h(Seg, { options: RAID_ACTIONS, value: form.action, onChange: (v: string) => edit({ action: v }) })),
      h(NumField, { label: 'Lockdown duration (minutes)', value: form.lockdownMinutes, min: 0, onChange: (v: number) => edit({ lockdownMinutes: v }) })),

    h(Section, { icon: FiClock, title: 'Account-age gate', desc: 'Act on accounts created too recently. Set minimum age to 0 to disable.' },
      h(NumField, { label: 'Minimum account age (minutes)', value: form.minAccountAgeMin, min: 0, onChange: (v: number) => edit({ minAccountAgeMin: v }) }),
      h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Action for young accounts'),
        h(Seg, { options: AGE_ACTIONS, value: form.accountAgeAction, onChange: (v: string) => edit({ accountAgeAction: v }) }))),

    h(Section, { icon: FiCrosshair, title: 'Honeypot channel', desc: 'A trap channel no real member posts in. Raid bots that spam every channel trip it: the message is deleted and the author actioned. Staff (Manage Server, Manage Channel, Manage Messages, Kick or Ban) are exempt.' },
      h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Create a new honeypot channel'),
        h('div', { className: 'inline-row' },
          h('input', { className: 'input', type: 'text', maxLength: 32, placeholder: 'honeypot', value: honeypotName, disabled: honeypotExists, onChange: (e: any) => setHoneypotName(e.target.value) }),
          h('button', { className: 'btn', disabled: creating || honeypotExists, onClick: createHoneypot }, h(FiPlus), creating ? 'Creating…' : 'Create channel')),
        honeypotExists ? h('span', { className: 'muted field-hint' }, 'A honeypot channel is already set. Set it to Off and save to create a new one.') : h('span', { className: 'muted field-hint' }, 'Creates the channel right away and selects it.')),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Honeypot channel'),
        h(Select, {
          value: form.honeypotChannelId || '',
          options: [{ value: '', label: 'Off' }, ...channelOptions(channels)],
          onChange: (v: string) => edit({ honeypotChannelId: v || null }),
        })),
      h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Action on honeypot posters'),
        h(Seg, { options: RAID_ACTIONS, value: form.honeypotAction, onChange: (v: string) => edit({ honeypotAction: v }) }))),

    h(Section, { icon: FiBell, title: 'Alerts', desc: 'Where raid alerts post. Falls back to the log channel when unset.' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Alert channel'),
        h(Select, {
          value: form.alertChannelId || '',
          options: [{ value: '', label: 'Log channel (fallback)' }, ...channelOptions(channels)],
          onChange: (v: string) => edit({ alertChannelId: v || null }),
        }))),

    h(SaveBar, { dirty, busy, onSave: () => save(), onDiscard: discard }));
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(icon)), h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function NumField({ label, value, min, onChange }: any) {
  return h('label', { className: 'field' },
    h('span', { className: 'field-label' }, label),
    h(NumberInput, { value, min: min ?? 0, onChange }));
}

function Seg({ options, value, onChange }: any) {
  return h('div', { className: 'segmented' },
    options.map(([v, label]: any) => h('button', { key: v, type: 'button', className: `seg ${value === v ? 'is-active' : ''}`, onClick: () => onChange(v) }, label)));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
