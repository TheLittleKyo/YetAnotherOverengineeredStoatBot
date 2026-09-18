import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiShield, FiUserCheck, FiZap, FiSliders, FiMessageSquare, FiAlertTriangle } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, namedOptions, noneOption } from '../shared/select.js';
import { FeatureOffNotice, FeatureSwitch, NumberInput, SaveBar } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const LENGTHS = [4, 5, 6, 7, 8, 9];

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() {
    setLoading(true);
    try { const d = await getJson('/api/config'); setData(d); setForm(d.settings); setDirty(false); }
    catch (e: any) { flash('error', e.message); } finally { setLoading(false); }
  }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }
  function edit(patch: any) { setForm((f: any) => ({ ...f, ...patch })); setDirty(true); }

  async function save() {
    setBusy(true);
    // The on/off switch saves on its own, so a draft never flips it back.
    try { const r = await postJson('/api/settings', { ...form, enabled: data.settings?.enabled }); setData((d: any) => ({ ...d, settings: r.settings, status: r.status })); setForm(r.settings); setDirty(false); flash('ok', 'Settings saved.'); }
    catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  // The on/off switch takes effect at once and leaves other drafts alone.
  async function toggleEnabled(enabled: boolean) {
    setToggling(true);
    try {
      await postJson('/api/settings', { enabled });
      setData((d: any) => ({ ...d, settings: { ...d.settings, enabled } }));
      setForm((f: any) => ({ ...f, enabled }));
      flash('ok', enabled ? 'Captcha is on.' : 'Captcha is off.');
    }
    catch (e: any) { flash('error', e.message); }
    finally { setToggling(false); }
  }
  function discard() { setForm(data.settings); setDirty(false); }

  if (loading || !form) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const roles = data.roles || [];
  const noRole = !form.roleId;

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null, h('h1', null, 'Captcha'), h('p', { className: 'muted' }, `Anti-bot verification for ${BOT_NAME}. New members get a DM'd image challenge before receiving the verified role.`)),
      h(FeatureSwitch, { feature: 'Captcha', enabled: !!data.settings?.enabled, busy: toggling, onChange: toggleEnabled })),

    data.settings?.enabled ? null : h(FeatureOffNotice, { feature: 'Captcha', what: 'New members are not being verified.', busy: toggling, onEnable: () => toggleEnabled(true) }),

    noRole
      ? h('div', { className: 'status-banner warn' },
          h(FiAlertTriangle), h('span', null, 'Pick a verified role below — the captcha grants nothing until one is set.'))
      : h('div', { className: 'status-banner' },
          h(FiShield), h('span', null, `${data.status?.pending ?? 0} pending challenge(s), ${data.status?.activeCooldowns ?? 0} on cooldown.`)),

    h(Section, { icon: FiUserCheck, title: 'Verified role', desc: 'The role granted after a member solves the captcha. The bot role must sit above it.' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Role'),
        h(Select, {
          value: form.roleId || '',
          options: [noneOption('No role'), ...namedOptions(roles)],
          onChange: (v: string) => edit({ roleId: v || null }),
        }))),

    h(Section, { icon: FiZap, title: 'Triggers', desc: 'When the captcha DM is sent.' },
      h(Toggle, { title: 'On join', desc: 'Automatically DM the captcha when a member joins.', checked: !!form.triggerOnJoin, onChange: (v: boolean) => edit({ triggerOnJoin: v }) }),
      h(Toggle, { title: 'On reaction', desc: 'DM the captcha when a member reacts to a specific message.', checked: !!form.triggerOnReaction, onChange: (v: boolean) => edit({ triggerOnReaction: v }) }),
      form.triggerOnReaction
        ? h('div', { className: 'form-grid' },
            h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Reaction message ID'),
              h('input', { className: 'input', value: form.reactionMessageId || '', placeholder: 'e.g. 01J…', onChange: (e: any) => edit({ reactionMessageId: e.target.value || null }) })),
            h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Emoji'),
              h('input', { className: 'input', value: form.reactionEmoji || '', placeholder: '✅ or :customname:', onChange: (e: any) => edit({ reactionEmoji: e.target.value || null }) }),
              h('span', { className: 'field-hint' }, 'Leave blank to accept any reaction on that message.')))
        : null),

    h(Section, { icon: FiSliders, title: 'Challenge', desc: 'Code length, attempts, and timing.' },
      h('div', { className: 'form-grid' },
        h(SelField, { label: 'Min length', value: form.minLength, options: LENGTHS, onChange: (v: number) => edit({ minLength: v }) }),
        h(SelField, { label: 'Max length', value: form.maxLength, options: LENGTHS, onChange: (v: number) => edit({ maxLength: v }) })),
      h('div', { className: 'form-grid' },
        h(NumField, { label: 'Attempts per captcha', value: form.maxAttempts, min: 1, max: 10, onChange: (v: number) => edit({ maxAttempts: v }) }),
        h(NumField, { label: 'Cooldown after failure (minutes)', value: form.cooldownMinutes, min: 1, max: 1440, onChange: (v: number) => edit({ cooldownMinutes: v }) })),
      h(NumField, { label: 'Captcha validity (minutes)', value: form.expiryMinutes, min: 1, max: 120, onChange: (v: number) => edit({ expiryMinutes: v }) })),

    h(Section, { icon: FiMessageSquare, title: 'DM message', desc: 'Sent with the image. {server} and {length} are replaced.' },
      h('label', { className: 'field' },
        h('textarea', { className: 'input', value: form.dmMessage || '', maxLength: 1000, onChange: (e: any) => edit({ dmMessage: e.target.value }) }))),

    h(SaveBar, { dirty, busy, onSave: save, onDiscard: discard }));
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(icon)), h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function Toggle({ title, desc, checked, onChange }: any) {
  return h('div', { className: 'toggle-row' },
    h('div', { className: 'tr-text' }, h('span', { className: 'tr-title' }, title), h('span', { className: 'tr-desc' }, desc)),
    h('input', { type: 'checkbox', className: 'switch', checked: !!checked, onChange: (e: any) => onChange(e.target.checked) }));
}

function NumField({ label, value, min, max, onChange }: any) {
  return h('label', { className: 'field' },
    h('span', { className: 'field-label' }, label),
    h(NumberInput, { value, min: min ?? 0, max: max ?? undefined, onChange }));
}

function SelField({ label, value, options, onChange }: any) {
  return h('label', { className: 'field' },
    h('span', { className: 'field-label' }, label),
    h(Select, {
      value: String(value),
      options: options.map((o: number) => ({ value: String(o), label: String(o) })),
      onChange: (v: string) => onChange(Number(v)),
    }));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
