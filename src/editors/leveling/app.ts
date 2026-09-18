import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiZap, FiBell, FiAward, FiTrendingUp, FiPlus, FiTrash2, FiUser } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions, namedOptions } from '../shared/select.js';
import { FeatureOffNotice, FeatureSwitch, NumberInput, SaveBar, confirmDialog, promptDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
declare const __PREFIX__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';
const PREFIX = typeof __PREFIX__ === 'string' ? __PREFIX__ : '!';

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [form, setForm] = useState<any>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  // Add-reward row state
  const [newLevel, setNewLevel] = useState('');
  const [newRole, setNewRole] = useState('');

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
    try {
      // The on/off switch saves on its own, so a draft never flips it back.
      const r = await postJson('/api/settings', { ...form, enabled: data.settings?.enabled });
      setData((d: any) => ({ ...d, settings: r.settings }));
      setForm(r.settings); setDirty(false); flash('ok', 'Settings saved.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }
  // The on/off switch takes effect at once and leaves other drafts alone.
  async function toggleEnabled(enabled: boolean) {
    setToggling(true);
    try {
      await postJson('/api/settings', { enabled });
      setData((d: any) => ({ ...d, settings: { ...d.settings, enabled } }));
      setForm((f: any) => ({ ...f, enabled }));
      flash('ok', enabled ? 'Leveling is on.' : 'Leveling is off.');
    }
    catch (e: any) { flash('error', e.message); }
    finally { setToggling(false); }
  }
  function discard() { setForm(data.settings); setDirty(false); }

  async function addReward() {
    const level = Math.floor(Number(newLevel));
    if (!(level >= 1) || !newRole) { flash('error', 'Pick a level (≥1) and a role.'); return; }
    try {
      const r = await postJson('/api/reward', { level, roleId: newRole });
      setData((d: any) => ({ ...d, rewards: r.rewards }));
      setNewLevel(''); setNewRole(''); flash('ok', `Role reward set for level ${level}.`);
    } catch (e: any) { flash('error', e.message); }
  }
  async function removeReward(level: number) {
    try { const r = await postJson('/api/reward/delete', { level }); setData((d: any) => ({ ...d, rewards: r.rewards })); flash('ok', `Removed level ${level} reward.`); }
    catch (e: any) { flash('error', e.message); }
  }
  async function clearRewards() {
    if (!(await confirmDialog({ title: 'Remove all role rewards?', message: 'Roles members already earned stay on them.', confirmLabel: 'Remove all', danger: true }))) return;
    try { const r = await postJson('/api/reward/clear', {}); setData((d: any) => ({ ...d, rewards: r.rewards })); flash('ok', 'Cleared role rewards.'); }
    catch (e: any) { flash('error', e.message); }
  }

  async function userAction(userId: string, action: string, value?: number) {
    try {
      const r = await postJson('/api/user', { userId, action, value });
      setData((d: any) => ({ ...d, leaderboard: r.leaderboard, trackedUsers: r.trackedUsers }));
      flash('ok', 'Updated member.');
    } catch (e: any) { flash('error', e.message); }
  }
  async function resetAll() {
    if (!(await confirmDialog({ title: 'Reset all leveling data?', message: 'Every member in this server goes back to level 0 with no XP. This cannot be undone.', confirmLabel: 'Reset everything', danger: true }))) return;
    try { const r = await postJson('/api/reset-all', {}); setData((d: any) => ({ ...d, leaderboard: r.leaderboard, trackedUsers: r.trackedUsers })); flash('ok', 'All leveling data reset.'); }
    catch (e: any) { flash('error', e.message); }
  }

  if (loading || !form) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const roles = data.roles || [];
  const channels = data.channels || [];
  const rewards = data.rewards || [];
  const leaderboard = data.leaderboard || [];
  const roleNameById = (id: string) => (roles.find((r: any) => r.id === id) || {}).name || id;
  const roleColorById = (id: string) => (roles.find((r: any) => r.id === id) || {}).color || null;

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Leveling'),
        h('p', { className: 'muted' }, `XP, ranks, and level-based auto-add roles for ${BOT_NAME}. Members earn XP by chatting.`)),
      h(FeatureSwitch, { feature: 'Leveling', enabled: !!data.settings?.enabled, busy: toggling, onChange: toggleEnabled })),

    data.settings?.enabled ? null : h(FeatureOffNotice, { feature: 'Leveling', what: 'Nobody earns XP right now.', busy: toggling, onEnable: () => toggleEnabled(true) }),

    // --- XP settings ---
    h(Section, { icon: FiZap, title: 'XP rate', desc: 'How much XP each message grants, with an anti-spam cooldown.' },
      h('div', { className: 'form-grid' },
        h(NumField, { label: 'Minimum XP / message', value: form.xpMin, min: 0, onChange: (v: number) => edit({ xpMin: v }) }),
        h(NumField, { label: 'Maximum XP / message', value: form.xpMax, min: 0, onChange: (v: number) => edit({ xpMax: v }) })),
      h(NumField, { label: 'Cooldown between XP gains (seconds)', value: form.cooldownSeconds, min: 0, onChange: (v: number) => edit({ cooldownSeconds: v }) })),

    // --- Announcements ---
    h(Section, { icon: FiBell, title: 'Level-up announcements', desc: 'Post a message when a member levels up.' },
      h(Toggle, { label: 'Announce level-ups', checked: !!form.announce, onChange: (v: boolean) => edit({ announce: v }) }),
      h('label', { className: 'field' },
        h('span', { className: 'field-label' }, 'Announcement channel'),
        h(Select, {
          value: form.announceChannelId || '',
          disabled: !form.announce,
          options: [{ value: '', label: 'Where the level-up happens' }, ...channelOptions(channels)],
          onChange: (v: string) => edit({ announceChannelId: v || null }),
        }))),

    // --- Role rewards (auto-add roles) ---
    h(Section, { icon: FiAward, title: 'Role rewards', desc: 'Grant a role when a member reaches a level. Adding or removing a reward takes effect right away.' },
      h(Toggle, {
        label: 'Stack roles',
        hint: 'On: keep every role earned. Off: keep only the highest earned role.',
        checked: !!form.stackRoles,
        onChange: (v: boolean) => edit({ stackRoles: v }),
      }),
      rewards.length === 0
        ? h('p', { className: 'muted', style: { fontSize: 13 } }, 'No role rewards yet. Add one below.')
        : h('div', { className: 'reward-list' },
            rewards.map((rw: any) => h('div', { key: rw.level, className: 'reward-row' },
              h('span', { className: 'reward-lvl' }, `Lvl ${rw.level}`),
              h('span', { className: 'reward-role' },
                h('span', { className: 'role-dot', style: { background: roleColorById(rw.roleId) || 'var(--text-faint)' } }),
                roleNameById(rw.roleId)),
              h('button', { className: 'icon-btn', title: `Remove level ${rw.level} reward`, 'aria-label': `Remove level ${rw.level} reward`, onClick: () => removeReward(rw.level) }, h(FiTrash2))))),
      h('div', { className: 'reward-add' },
        h('input', { className: 'input reward-add-lvl', type: 'number', min: 1, placeholder: 'Level', 'aria-label': 'Level', value: newLevel, onChange: (e: any) => setNewLevel(e.target.value) }),
        h(Select, {
          className: 'reward-add-role',
          label: 'Role to grant',
          value: newRole,
          placeholder: 'Select a role…',
          options: namedOptions(roles),
          onChange: setNewRole,
        }),
        h('button', { className: 'btn btn-accent', onClick: addReward }, h(FiPlus), 'Add reward')),
      rewards.length > 0 ? h('button', { className: 'btn btn-quiet reward-clear', onClick: clearRewards }, 'Clear all rewards') : null),

    // --- Leaderboard ---
    h(Section, {
      icon: FiTrendingUp,
      title: 'Leaderboard',
      desc: `${data.trackedUsers || 0} tracked member${data.trackedUsers === 1 ? '' : 's'}. Top 25 shown.`,
    },
      leaderboard.length === 0
        ? h('p', { className: 'muted', style: { fontSize: 13 } }, 'No one has earned XP yet.')
        : h('div', { className: 'lb' },
            leaderboard.map((row: any) => h(LeaderRow, { key: row.userId, row, onAction: userAction }))),
      leaderboard.length > 0
        ? h('button', { className: 'btn btn-danger reward-clear', onClick: resetAll }, h(FiTrash2), 'Reset all leveling data')
        : null),

    h('p', { className: 'muted foot-note' }, `Tip: members can check their rank in chat with ${PREFIX}rank and ${PREFIX}leaderboard.`),
    h(SaveBar, { dirty, busy, onSave: save, onDiscard: discard }));
}

function LeaderRow({ row, onAction }: any) {
  const pct = row.neededForNext > 0 ? Math.round((row.currentLevelXp / row.neededForNext) * 100) : 0;
  return h('div', { className: 'lb-row' },
    h('span', { className: 'lb-rank' }, `#${row.rank}`),
    row.avatarUrl
      ? h('img', { className: 'lb-avatar', src: row.avatarUrl, alt: '', loading: 'lazy' })
      : h('span', { className: 'lb-avatar lb-avatar-fallback' }, h(FiUser)),
    h('div', { className: 'lb-main' },
      h('div', { className: 'lb-top' },
        h('span', { className: 'lb-name' }, row.name),
        h('span', { className: 'lb-level' }, `Level ${row.level}`)),
      h('div', { className: 'lb-bar' }, h('span', { className: 'lb-bar-fill', style: { width: `${pct}%` } })),
      h('span', { className: 'lb-xp muted' }, `${row.currentLevelXp} / ${row.neededForNext} XP · ${row.xp} total`)),
    h('div', { className: 'lb-actions' },
      h('button', {
        className: 'icon-btn', title: 'Set level', 'aria-label': `Set level for ${row.name}`,
        onClick: async () => {
          const value = await promptDialog({
            title: `Set level for ${row.name}`,
            message: 'Their XP is set to the start of that level.',
            confirmLabel: 'Set level',
            input: { label: 'Level', type: 'number', min: 0, defaultValue: String(row.level) },
          });
          if (value == null || value.trim() === '' || !Number.isFinite(Number(value))) return;
          onAction(row.userId, 'setlevel', Math.max(0, Math.floor(Number(value))));
        },
      }, h(FiAward)),
      h('button', {
        className: 'icon-btn danger', title: 'Reset member', 'aria-label': `Reset ${row.name}`,
        onClick: async () => {
          if (await confirmDialog({ title: `Reset ${row.name}?`, message: 'Their XP and level go back to 0.', confirmLabel: 'Reset member', danger: true })) onAction(row.userId, 'reset');
        },
      }, h(FiTrash2))));
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

function Toggle({ label, hint, checked, onChange }: any) {
  return h('label', { className: 'toggle-row' },
    h('div', { className: 'toggle-text' },
      h('span', { className: 'field-label' }, label),
      hint ? h('span', { className: 'toggle-hint muted' }, hint) : null),
    h('input', { type: 'checkbox', className: 'switch', checked: !!checked, onChange: (e: any) => onChange(e.target.checked) }));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
