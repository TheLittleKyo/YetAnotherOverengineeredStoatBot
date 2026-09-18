import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiDollarSign, FiPlus, FiShoppingBag, FiTrash2, FiUsers } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions, namedOptions, noneOption } from '../shared/select.js';
import { FeatureSwitch, NumberInput, SaveBar, confirmDialog, promptDialog } from '../shared/ui.js';

const h = React.createElement;

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

  async function toggle(enabled: boolean) {
    setBusy(true);
    try {
      const response = await postJson('/api/settings', { enabled });
      setData((current: any) => ({ ...current, settings: response.settings }));
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const settings = data.settings || {};
  const money = (amount: number) => `${settings.currencySymbol || ''}${Number(amount || 0).toLocaleString()}`;

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Economy'),
        h('p', { className: 'muted' }, 'A spendable currency earned from chatting, daily claims and work. Separate from leveling XP on purpose: buying a role should not cost you rank.')),
      h(FeatureSwitch, { feature: 'Economy', enabled: !!settings.enabled, busy, onChange: toggle })),

    h(Section, { icon: FiDollarSign, title: 'At a glance' },
      h('div', { className: 'stat-grid' },
        h(Stat, { value: money(data.summary?.circulating || 0), label: 'In circulation' }),
        h(Stat, { value: data.summary?.holders || 0, label: 'Members with a balance' }),
        h(Stat, { value: data.summary?.shopItems || 0, label: 'Shop items' }))),

    h(SettingsCard, { data, setData, flash }),
    h(ShopCard, { data, setData, flash, money }),
    h(BalancesCard, { data, setData, flash, money }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function Stat({ value, label }: any) {
  return h('div', { className: 'stat' },
    h('span', { className: 'stat-value' }, String(value)),
    h('span', { className: 'stat-label' }, label));
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

  return h(Section, { icon: FiDollarSign, title: 'Currency & earning' },
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Currency name'),
        h('input', { className: 'input', value: draft.currencyName || '', onChange: (e: any) => set({ currencyName: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Symbol'),
        h('input', { className: 'input', value: draft.currencySymbol || '', onChange: (e: any) => set({ currencySymbol: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Starting balance'),
        h(NumberInput, { value: draft.startingBalance, min: 0, max: 1000000, onChange: (value: number) => set({ startingBalance: value }) }))),

    h('div', { className: 'sub-head' }, 'Per message'),
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Minimum'),
        h(NumberInput, { value: draft.messageMin, min: 0, max: 10000, onChange: (value: number) => set({ messageMin: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Maximum'),
        h(NumberInput, { value: draft.messageMax, min: 0, max: 10000, onChange: (value: number) => set({ messageMax: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Cooldown (seconds)'),
        h(NumberInput, { value: draft.messageCooldownSec, min: 0, max: 86400, onChange: (value: number) => set({ messageCooldownSec: value }) }))),

    h('div', { className: 'sub-head' }, 'Daily & work'),
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Daily amount'),
        h(NumberInput, { value: draft.dailyAmount, min: 0, max: 1000000, onChange: (value: number) => set({ dailyAmount: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Streak bonus per day (caps at 7)'),
        h(NumberInput, { value: draft.dailyStreakBonus, min: 0, max: 100000, onChange: (value: number) => set({ dailyStreakBonus: value }) }))),
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Work minimum'),
        h(NumberInput, { value: draft.workMin, min: 0, max: 1000000, onChange: (value: number) => set({ workMin: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Work maximum'),
        h(NumberInput, { value: draft.workMax, min: 0, max: 1000000, onChange: (value: number) => set({ workMax: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Work cooldown (seconds)'),
        h(NumberInput, { value: draft.workCooldownSec, min: 60, max: 604800, onChange: (value: number) => set({ workCooldownSec: value }) }))),

    h('div', { className: 'sub-head' }, 'Transfers & gambling'),
    h('div', { className: 'grid-2' },
      h('label', { className: 'check-row' },
        h('input', { type: 'checkbox', checked: draft.payEnabled !== false, onChange: (e: any) => set({ payEnabled: e.target.checked }) }),
        h('span', null, 'Members can pay each other')),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Transfer tax (%)'),
        h(NumberInput, { value: draft.payTaxPercent, min: 0, max: 50, onChange: (value: number) => set({ payTaxPercent: value }) }))),
    h('div', { className: 'grid-2' },
      h('label', { className: 'check-row' },
        h('input', { type: 'checkbox', checked: !!draft.gamblingEnabled, onChange: (e: any) => set({ gamblingEnabled: e.target.checked }) }),
        h('span', null, 'Allow gambling (47.5% to double the stake)')),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Maximum bet'),
        h(NumberInput, { value: draft.gambleMaxBet, min: 1, max: 1000000, onChange: (value: number) => set({ gambleMaxBet: value }) }))),

    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Add a channel that earns nothing'),
      h(Select, {
        value: '',
        options: [noneOption('Choose a channel…'), ...channelOptions(data.channels)],
        onChange: (value: string) => value && set({ noEarnChannelIds: Array.from(new Set([...(draft.noEarnChannelIds || []), value])) }),
      })),
    (draft.noEarnChannelIds || []).length
      ? h('div', { className: 'rule-top' }, (draft.noEarnChannelIds || []).map((channelId: string) =>
          h('button', {
            key: channelId, type: 'button', className: 'chip', title: 'Remove',
            onClick: () => set({ noEarnChannelIds: (draft.noEarnChannelIds || []).filter((id: string) => id !== channelId) }),
          }, `#${(data.channels || []).find((channel: any) => channel.id === channelId)?.name || channelId} ×`)))
      : null,

    h(SaveBar, { dirty, busy, onSave: save, onDiscard: () => setDraft(data.settings) }));
}

function ShopCard({ data, setData, flash, money }: any) {
  const [form, setForm] = useState<any>({ name: '', description: '', price: 100, roleId: '', stock: '', perUserLimit: 0 });
  const [busy, setBusy] = useState(false);
  const set = (patch: any) => setForm((current: any) => ({ ...current, ...patch }));

  async function add() {
    if (!form.name.trim()) { flash('error', 'An item needs a name.'); return; }
    setBusy(true);
    try {
      const response = await postJson('/api/shop', {
        name: form.name,
        description: form.description,
        price: form.price,
        roleId: form.roleId || null,
        stock: form.stock === '' ? null : Number(form.stock),
        perUserLimit: form.perUserLimit,
      });
      setData((current: any) => ({ ...current, shop: response.shop }));
      set({ name: '', description: '' });
      flash('ok', 'Item added.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function remove(item: any) {
    const ok = await confirmDialog({ title: `Delete "${item.name}"?`, message: 'Members who already bought it keep it in their inventory.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/shop/delete', { id: item.id });
      setData((current: any) => ({ ...current, shop: response.shop }));
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, { icon: FiShoppingBag, title: `Shop (${(data.shop || []).length})`, desc: 'An item can grant a role when bought.' },
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Name'),
        h('input', { className: 'input', value: form.name, onChange: (e: any) => set({ name: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Price'),
        h(NumberInput, { value: form.price, min: 0, max: 10000000, onChange: (value: number) => set({ price: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Grants role (optional)'),
        h(Select, { value: form.roleId, options: [noneOption('No role'), ...namedOptions(data.roles)], onChange: (value: string) => set({ roleId: value }) }))),
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Stock (blank = unlimited)'),
        h('input', { className: 'input', type: 'number', min: 0, value: form.stock, onChange: (e: any) => set({ stock: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Limit per member (0 = none)'),
        h(NumberInput, { value: form.perUserLimit, min: 0, max: 100, onChange: (value: number) => set({ perUserLimit: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Description'),
        h('input', { className: 'input', value: form.description, onChange: (e: any) => set({ description: e.target.value }) }))),
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-accent', disabled: busy, onClick: add }, h(FiPlus), busy ? 'Adding…' : 'Add item')),

    (data.shop || []).length === 0
      ? h('p', { className: 'empty-line muted' }, 'The shop is empty.')
      : h('div', { className: 'rule-list' }, (data.shop || []).map((item: any) =>
          h('div', { className: 'rule-row', key: item.id },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('strong', null, item.name),
                h('span', { className: 'chip' }, money(item.price)),
                item.roleId ? h('span', { className: 'chip' }, (data.roles || []).find((role: any) => role.id === item.roleId)?.name || 'role') : null,
                item.stock == null ? null : h('span', { className: 'chip chip-warn' }, `${item.stock} left`)),
              item.description ? h('div', { className: 'rule-message' }, item.description) : null),
            h('div', { className: 'rule-actions' },
              h('button', { className: 'icon-btn icon-danger', title: 'Delete item', 'aria-label': 'Delete item', onClick: () => remove(item) }, h(FiTrash2)))))));
}

function BalancesCard({ data, setData, flash, money }: any) {
  async function adjust(action: string) {
    const userId = await promptDialog({
      title: `${action === 'set' ? 'Set' : action === 'add' ? 'Add to' : 'Take from'} a balance`,
      message: 'Paste the member id.',
      confirmLabel: 'Next',
      input: { label: 'Member id', placeholder: '01ABC…' },
    });
    if (!userId) return;
    const amount = await promptDialog({
      title: 'Amount',
      confirmLabel: 'Apply',
      input: { label: 'Amount', type: 'number', defaultValue: '100' },
    });
    if (amount == null) return;
    try {
      const response = await postJson('/api/balance', { userId, amount: Number(amount), action });
      setData((current: any) => ({ ...current, leaderboard: response.leaderboard, summary: response.summary }));
      flash('ok', 'Balance updated.');
    } catch (e: any) { flash('error', e.message); }
  }

  async function resetAll() {
    const ok = await confirmDialog({
      title: 'Reset every balance?',
      message: 'Every member in this server goes back to zero, and inventories are cleared. This cannot be undone.',
      confirmLabel: 'Reset everything',
      danger: true,
    });
    if (!ok) return;
    try {
      const response = await postJson('/api/reset', { all: true });
      setData((current: any) => ({ ...current, leaderboard: response.leaderboard, summary: response.summary }));
      flash('ok', 'Economy reset.');
    } catch (e: any) { flash('error', e.message); }
  }

  const rows = data.leaderboard || [];

  return h(Section, { icon: FiUsers, title: 'Balances', desc: 'Top 25 by balance.' },
    h('div', { className: 'rule-top' },
      h('button', { className: 'btn btn-quiet btn-sm', onClick: () => adjust('add') }, 'Add'),
      h('button', { className: 'btn btn-quiet btn-sm', onClick: () => adjust('remove') }, 'Take'),
      h('button', { className: 'btn btn-quiet btn-sm', onClick: () => adjust('set') }, 'Set'),
      h('button', { className: 'btn btn-danger btn-sm', onClick: resetAll }, 'Reset all')),

    rows.length === 0
      ? h('p', { className: 'empty-line muted' }, 'Nobody has earned anything yet.')
      : h('table', { className: 'data-table' },
          h('thead', null, h('tr', null,
            h('th', null, '#'),
            h('th', null, 'Member'),
            h('th', { className: 'num' }, 'Balance'))),
          h('tbody', null, rows.map((row: any) =>
            h('tr', { key: row.userId },
              h('td', null, String(row.rank)),
              h('td', null, row.name),
              h('td', { className: 'num' }, money(row.balance)))))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
