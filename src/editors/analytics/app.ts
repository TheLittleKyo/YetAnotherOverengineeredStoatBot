import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiActivity, FiClock, FiHash, FiRotateCcw, FiTerminal, FiTrendingUp, FiUsers } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select } from '../shared/select.js';
import { confirmDialog } from '../shared/ui.js';

const h = React.createElement;

const RANGES = [['7', 'Last 7 days'], ['14', 'Last 14 days'], ['30', 'Last 30 days'], ['90', 'Last 90 days']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function delta(current: number, previous: number | null | undefined): string | null {
  if (previous == null) return null;
  if (previous === 0) return current > 0 ? '+new' : null;
  const change = Math.round(((current - previous) / previous) * 100);
  return `${change >= 0 ? '+' : ''}${change}% vs previous`;
}

function App() {
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState('30');
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { void load(days); }, [days]);
  async function load(range: string) {
    setLoading(true);
    try { setData(await getJson(`/api/config?days=${encodeURIComponent(range)}`)); }
    catch (e: any) { flash('error', e.message); }
    finally { setLoading(false); }
  }
  function flash(tone: string, text: string) {
    setToast({ tone, text });
    if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600);
  }

  async function reset() {
    const ok = await confirmDialog({
      title: 'Clear analytics for this server?',
      message: 'Joins, leaves, per-channel counts, voice time and command usage go back to zero. The Overview tab keeps its own message totals.',
      confirmLabel: 'Clear counters',
      danger: true,
    });
    if (!ok) return;
    try {
      await postJson('/api/reset', {});
      await load(days);
      flash('ok', 'Analytics cleared.');
    } catch (e: any) { flash('error', e.message); }
  }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const analytics = data.analytics || {};
  const totals = analytics.totals || {};
  const previous = analytics.previous;

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Analytics'),
        h('p', { className: 'muted' }, 'Membership churn, when the server is awake, where the traffic is, and what the bot is actually used for.')),
      h('div', { style: { minWidth: 170 } },
        h(Select, { value: days, options: RANGES.map(([value, label]) => ({ value, label })), onChange: setDays }))),

    h(Section, { icon: FiTrendingUp, title: 'Totals for the period' },
      h('div', { className: 'stat-grid' },
        h(Stat, { value: totals.messages ?? 0, label: 'Messages', hint: delta(totals.messages || 0, previous?.messages) }),
        h(Stat, { value: totals.joins ?? 0, label: 'Joins', hint: delta(totals.joins || 0, previous?.joins) }),
        h(Stat, { value: totals.leaves ?? 0, label: 'Leaves', hint: delta(totals.leaves || 0, previous?.leaves) }),
        h(Stat, { value: (totals.net ?? 0) > 0 ? `+${totals.net}` : String(totals.net ?? 0), label: 'Net members' }),
        h(Stat, { value: formatMinutes(totals.voiceMinutes || 0), label: 'Voice time', hint: delta(totals.voiceMinutes || 0, previous?.voiceMinutes) }),
        h(Stat, { value: totals.commands ?? 0, label: 'Commands run' }))),

    h(MembershipChart, { analytics }),
    h(HoursCard, { analytics }),
    h(ChannelsCard, { analytics }),
    h(CommandsCard, { analytics }),
    h(FeatureCard, { features: data.features, activity: data.activity }),

    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-danger btn-sm', onClick: reset }, h(FiRotateCcw), 'Clear analytics')),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function Stat({ value, label, hint }: any) {
  return h('div', { className: 'stat' },
    h('span', { className: 'stat-value' }, String(value)),
    h('span', { className: 'stat-label' }, label),
    hint ? h('span', { className: 'stat-hint' }, hint) : null);
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 6) / 10;
  return `${hours}h`;
}

function MembershipChart({ analytics }: any) {
  const points = analytics.days || [];
  // The two blocks stack, so the scale is their sum or the tallest day overflows.
  const peak = Math.max(1, ...points.map((point: any) => point.messages + point.joins + point.leaves));

  return h(Section, { icon: FiUsers, title: 'Day by day', desc: 'Bar height is messages; the lighter block on top is joins and leaves combined.' },
    h('div', { className: 'chart' }, points.map((point: any) =>
      h('div', { className: 'chart-col', key: point.day, title: `${point.day}: ${point.messages} messages, +${point.joins} / −${point.leaves}` },
        h('div', { className: 'chart-bar is-secondary', style: { height: `${((point.joins + point.leaves) / peak) * 100}%` } }),
        h('div', { className: 'chart-bar', style: { height: `${(point.messages / peak) * 100}%` } })))),
    points.length
      ? h('div', { className: 'chart-axis' },
          h('span', null, points[0].day),
          h('span', null, points[points.length - 1].day))
      : h('p', { className: 'empty-line muted' }, 'No data yet.'));
}

function HoursCard({ analytics }: any) {
  const hours = analytics.hours || [];
  const peakHour = Math.max(1, ...hours);
  const weekdays = analytics.weekdays || [];
  const peakWeekday = Math.max(1, ...weekdays);

  return h(Section, {
    icon: FiClock,
    title: 'When the server is awake',
    desc: analytics.busiestHour == null
      ? 'Counted in the bot host\'s local time.'
      : `Busiest hour: ${String(analytics.busiestHour).padStart(2, '0')}:00 · busiest day: ${WEEKDAYS[analytics.busiestWeekday] || '—'} (bot host time).`,
  },
    h('div', { className: 'hour-grid' }, hours.map((count: number, hour: number) =>
      h('div', { className: 'hour-bar', key: hour, style: { height: `${Math.max(2, (count / peakHour) * 100)}%` }, title: `${hour}:00 — ${count} messages` }))),
    h('div', { className: 'hour-labels' }, hours.map((_: number, hour: number) =>
      h('span', { key: hour }, hour % 3 === 0 ? String(hour) : ''))),
    h('div', { className: 'sub-head' }, 'By weekday'),
    h('div', { className: 'week-grid' }, weekdays.map((count: number, index: number) =>
      h('div', { className: 'week-cell', key: index },
        h('div', { className: 'num' }, String(count)),
        h('div', { className: 'lbl' }, WEEKDAYS[index]),
        h('div', { className: 'bar-track' }, h('div', { className: 'bar-fill', style: { width: `${(count / peakWeekday) * 100}%` } }))))));
}

function ChannelsCard({ analytics }: any) {
  const channels = analytics.channels || [];
  return h(Section, { icon: FiHash, title: 'Busiest channels', desc: 'Share of every message the bot has seen in this server.' },
    channels.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No channel data yet.')
      : h('table', { className: 'data-table' },
          h('thead', null, h('tr', null,
            h('th', null, 'Channel'),
            h('th', { className: 'num' }, 'Messages'),
            h('th', { className: 'num' }, 'Share'))),
          h('tbody', null, channels.map((row: any) =>
            h('tr', { key: row.channelId },
              h('td', null, `#${row.name}`),
              h('td', { className: 'num' }, row.messages.toLocaleString()),
              h('td', { className: 'num' }, `${row.share}%`))))));
}

function CommandsCard({ analytics }: any) {
  const commands = analytics.commands || [];
  const voice = analytics.voice || {};
  return h(Section, { icon: FiTerminal, title: 'Command usage', desc: `Voice: ${formatMinutes(voice.totalMinutes || 0)} across ${voice.sessions || 0} sessions${voice.liveSessions ? `, ${voice.liveSessions} live now` : ''}.` },
    commands.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No commands recorded yet.')
      : h('div', { className: 'rule-list' }, commands.map((row: any) =>
          h('div', { className: 'rule-row', key: row.name },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' }, h('span', { className: 'tag' }, row.name), h('span', { className: 'chip' }, `${row.count} uses`)))))));
}

function FeatureCard({ features, activity }: any) {
  if (!features) return null;
  const rows: [string, string][] = [
    ['Moderation cases', `${features.moderation?.total ?? 0} total · ${features.moderation?.activePunishments ?? 0} active`],
    ['Automod', features.automod?.enabled ? `${features.automod.enabledRuleCount} rules · ${features.automod.totalHits} hits` : 'off'],
    ['Economy', features.economy?.enabled ? `${features.economy.holders} holders · ${Number(features.economy.circulating || 0).toLocaleString()} in circulation` : 'off'],
    ['Tags', `${features.tags?.total ?? 0} tags · ${features.tags?.uses ?? 0} uses`],
    ['Polls', `${features.polls?.total ?? 0} total · ${features.polls?.open ?? 0} open`],
    ['Giveaways', `${features.giveaways?.total ?? 0} total · ${features.giveaways?.active ?? 0} running`],
    ['Birthdays', features.birthdays?.registered ? `${features.birthdays.registered} saved${features.birthdays.next ? ` · next ${features.birthdays.next.name} in ${features.birthdays.next.inDays}d` : ''}` : 'none saved'],
    ['Tracked members', `${activity?.trackedUsers ?? 0} · ${activity?.activeToday ?? 0} active today`],
  ];

  return h(Section, { icon: FiActivity, title: 'Feature usage' },
    h('table', { className: 'data-table' },
      h('tbody', null, rows.map(([label, value]) =>
        h('tr', { key: label }, h('td', null, label), h('td', { className: 'muted' }, value))))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
