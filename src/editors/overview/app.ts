import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FiArrowDownRight, FiArrowUpRight, FiBell, FiCheck, FiChevronDown, FiChevronUp, FiClock,
  FiColumns, FiCopy, FiEye, FiEyeOff, FiFileText, FiHash, FiImage, FiInbox, FiList,
  FiMaximize2, FiMessageSquare, FiRadio, FiRefreshCw, FiRotateCcw, FiShare2, FiSliders,
  FiSmile, FiType, FiUpload, FiUserPlus, FiUsers, FiX, FiZap,
} from 'react-icons/fi';
import { getJson } from '../shared/api.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const CONFIG_KEY = 'yaosb-overview-config';
const CONFIG_VERSION = 2;
const DEFAULT_ACCENT = '#fd6671'; // coral — kept as the default on purpose.

const ACCENT_PRESETS: Array<{ name: string; hex: string }> = [
  { name: 'Coral', hex: '#fd6671' },
  { name: 'Ember', hex: '#ff5a3c' },
  { name: 'Rose', hex: '#f2596b' },
  { name: 'Amber', hex: '#f0b34a' },
  { name: 'Emerald', hex: '#2fbf8f' },
  { name: 'Azure', hex: '#4c8dff' },
  { name: 'Violet', hex: '#8b7bff' },
];

// Order matters: paired so each grid row fills completely (activity+health,
// then weekday and the two boards), leaving no empty columns.
const WIDGET_DEFS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'kpis', label: 'Stat cards', hint: 'Headline numbers across the top' },
  { id: 'activity', label: 'Activity graph', hint: 'Messages & images over time' },
  { id: 'health', label: 'Bot health', hint: 'Gateway, uptime, CPU and memory' },
  { id: 'weekday', label: 'Messages by weekday', hint: 'Which days the server is busiest' },
  { id: 'images-board', label: 'Top image senders', hint: 'Leaderboard of most images shared' },
  { id: 'active-board', label: 'Most active members', hint: 'Leaderboard of most messages sent' },
  { id: 'features', label: 'Feature status', hint: 'Tickets, notify, sync, logs, roles…' },
];

// Every widget's default column span on the 6-column board. Users override this
// per widget; the value is clamped to one of SPAN_OPTIONS on load.
const DEFAULT_SPAN: Record<string, number> = {
  kpis: 6, activity: 4, health: 2, weekday: 2, 'images-board': 2, 'active-board': 2, features: 6,
};
const SPAN_OPTIONS: Array<{ n: number; label: string; title: string }> = [
  { n: 2, label: 'S', title: 'One third width' },
  { n: 3, label: 'M', title: 'Half width' },
  { n: 4, label: 'L', title: 'Two thirds width' },
  { n: 6, label: 'Full', title: 'Full width' },
];

// The stat-card row is its own reorderable, toggleable catalogue.
const KPI_DEFS: Array<{ id: string; label: string; hint: string }> = [
  { id: 'messages', label: 'Messages', hint: 'Window total and trend' },
  { id: 'images', label: 'Images', hint: 'Window total and trend' },
  { id: 'members', label: 'Members', hint: 'Server member count' },
  { id: 'active-today', label: 'Active today', hint: 'Members who spoke today' },
  { id: 'tickets', label: 'Open tickets', hint: 'Open plus all-time' },
  { id: 'notify', label: 'Notify feeds', hint: 'Total plus live' },
  { id: 'sync', label: 'Sync links', hint: 'Total plus two-way' },
];
// Which stat cards show by default (matches the original six-card row).
const KPI_DEFAULT_ON = new Set(['messages', 'images', 'members', 'tickets', 'notify', 'sync']);

const DAY_OPTIONS = [7, 14, 30, 90];
const DENSITY_OPTIONS: Array<{ id: Density; label: string }> = [
  { id: 'compact', label: 'Compact' },
  { id: 'cozy', label: 'Cozy' },
  { id: 'roomy', label: 'Roomy' },
];
const REFRESH_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 0, label: 'Off' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 300_000, label: '5m' },
];
const TOPN_OPTIONS = [5, 8, 10];
const POLL_TICK_MS = 15_000; // how often the timer checks whether a refresh is due

type Density = 'compact' | 'cozy' | 'roomy';
type WidgetPref = { id: string; on: boolean; span: number };
type KpiPref = { id: string; on: boolean };
type HeaderPref = { title: string; subtitle: string; showEyebrow: boolean };
type SeriesKey = 'messages' | 'images' | 'attachments' | 'total';
type ChartStyle = 'area' | 'line' | 'bars';
type ActivityPref = { series: SeriesKey[]; style: ChartStyle };
type OverviewConfig = {
  v: number;
  widgets: WidgetPref[];
  kpis: KpiPref[];
  accent: string;
  days: number;
  density: Density;
  refreshMs: number;
  topN: number;
  fullWidth: boolean;
  header: HeaderPref;
  activity: ActivityPref;
};

// Every series the activity chart can draw. `total` is derived per day
// (messages + images); the other two come straight from the daily buckets.
const SERIES_ORDER: SeriesKey[] = ['messages', 'images', 'attachments', 'total'];
const SERIES_META: Record<SeriesKey, { label: string; color: string }> = {
  messages: { label: 'Messages', color: 'var(--accent)' },
  images: { label: 'Images', color: 'var(--info)' },
  attachments: { label: 'Attachments', color: 'var(--ok)' },
  total: { label: 'Total', color: 'var(--accent-strong)' },
};
const CHART_STYLES: Array<{ id: ChartStyle; label: string }> = [
  { id: 'area', label: 'Area' },
  { id: 'line', label: 'Line' },
  { id: 'bars', label: 'Bars' },
];
const seriesValue = (d: { messages: number; images: number; attachments?: number }, key: SeriesKey): number =>
  key === 'total' ? (d.messages || 0) + (d.images || 0) : (d as any)[key] || 0;

function defaultConfig(): OverviewConfig {
  return {
    v: CONFIG_VERSION,
    widgets: WIDGET_DEFS.map((w) => ({ id: w.id, on: true, span: DEFAULT_SPAN[w.id] ?? 2 })),
    kpis: KPI_DEFS.map((k) => ({ id: k.id, on: KPI_DEFAULT_ON.has(k.id) })),
    accent: DEFAULT_ACCENT,
    days: 14,
    density: 'cozy',
    refreshMs: 60_000,
    topN: 5,
    fullWidth: false,
    header: { title: '', subtitle: '', showEyebrow: true },
    activity: { series: ['messages', 'images'], style: 'area' },
  };
}

function loadConfig(): OverviewConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfig();
    return reconcile(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

function clampSpan(n: any): number {
  const v = Number(n);
  return SPAN_OPTIONS.some((s) => s.n === v) ? v : 2;
}

// Merge a stored config with the current catalogues so removed items drop out
// while user order / toggles / widths survive. New items land at their default
// position (right after the item that precedes them in the catalogue), so a
// stored layout keeps its grid rows full.
function reconcile(parsed: any): OverviewConfig {
  const base = defaultConfig();

  const knownW = new Set(WIDGET_DEFS.map((w) => w.id));
  const seenW = new Set<string>();
  const widgets: WidgetPref[] = [];
  for (const w of Array.isArray(parsed?.widgets) ? parsed.widgets : []) {
    if (w && knownW.has(w.id) && !seenW.has(w.id)) {
      widgets.push({ id: w.id, on: w.on !== false, span: w.span == null ? (DEFAULT_SPAN[w.id] ?? 2) : clampSpan(w.span) });
      seenW.add(w.id);
    }
  }
  WIDGET_DEFS.forEach((def, idx) => {
    if (seenW.has(def.id)) return;
    const prevId = WIDGET_DEFS[idx - 1]?.id;
    const at = prevId ? widgets.findIndex((w) => w.id === prevId) + 1 : 0;
    widgets.splice(at, 0, { id: def.id, on: true, span: DEFAULT_SPAN[def.id] ?? 2 });
    seenW.add(def.id);
  });

  const knownK = new Set(KPI_DEFS.map((k) => k.id));
  const seenK = new Set<string>();
  const kpis: KpiPref[] = [];
  for (const k of Array.isArray(parsed?.kpis) ? parsed.kpis : []) {
    if (k && knownK.has(k.id) && !seenK.has(k.id)) { kpis.push({ id: k.id, on: k.on !== false }); seenK.add(k.id); }
  }
  KPI_DEFS.forEach((def, idx) => {
    if (seenK.has(def.id)) return;
    const prevId = KPI_DEFS[idx - 1]?.id;
    const at = prevId ? kpis.findIndex((k) => k.id === prevId) + 1 : 0;
    kpis.splice(at, 0, { id: def.id, on: KPI_DEFAULT_ON.has(def.id) });
    seenK.add(def.id);
  });

  const ph = parsed?.header || {};
  const pa = parsed?.activity || {};
  const series = (Array.isArray(pa.series) ? pa.series : []).filter((s: any) => SERIES_ORDER.includes(s));
  return {
    v: CONFIG_VERSION,
    widgets,
    kpis,
    accent: isHex(parsed?.accent) ? parsed.accent : base.accent,
    days: DAY_OPTIONS.includes(Number(parsed?.days)) ? Number(parsed.days) : base.days,
    density: DENSITY_OPTIONS.some((d) => d.id === parsed?.density) ? parsed.density : base.density,
    refreshMs: REFRESH_OPTIONS.some((r) => r.ms === Number(parsed?.refreshMs)) ? Number(parsed.refreshMs) : base.refreshMs,
    topN: TOPN_OPTIONS.includes(Number(parsed?.topN)) ? Number(parsed.topN) : base.topN,
    fullWidth: parsed?.fullWidth === true,
    header: {
      title: typeof ph.title === 'string' ? ph.title.slice(0, 80) : '',
      subtitle: typeof ph.subtitle === 'string' ? ph.subtitle.slice(0, 160) : '',
      showEyebrow: ph.showEyebrow !== false,
    },
    activity: {
      // Keep at least one series so the chart is never blank.
      series: series.length ? Array.from(new Set(series)) : base.activity.series,
      style: CHART_STYLES.some((c) => c.id === pa.style) ? pa.style : base.activity.style,
    },
  };
}

function saveConfig(cfg: OverviewConfig) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch { /* ignore */ }
}

function isHex(v: any): boolean { return typeof v === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(v); }

function rgba(hex: string, alpha: number): string {
  let c = (hex || DEFAULT_ACCENT).replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const n = parseInt(c, 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function lighten(hex: string, amt: number): string {
  let c = (hex || DEFAULT_ACCENT).replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const n = parseInt(c, 16);
  const mix = (ch: number) => Math.round(ch + (255 - ch) * amt);
  const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function luminance(hex: string): number {
  let c = (hex || DEFAULT_ACCENT).replace('#', '');
  if (c.length === 3) c = c.split('').map((x) => x + x).join('');
  const n = parseInt(c, 16);
  const lin = (v: number) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

// Text on an accent fill: the dark ink unless a custom accent is so dark that
// white reads better (compared by WCAG contrast against each).
function onAccent(hex: string): string {
  const l = luminance(hex);
  const vsDark = (l + 0.05) / (luminance('#1a0d0f') + 0.05);
  const vsWhite = 1.05 / (l + 0.05);
  return vsDark >= vsWhite ? '#1a0d0f' : '#ffffff';
}

function accentVars(accent: string): Record<string, string> {
  return {
    '--accent': accent,
    '--accent-strong': lighten(accent, 0.18),
    '--accent-quiet': rgba(accent, 0.12),
    '--accent-line': rgba(accent, 0.4),
    '--on-accent': onAccent(accent),
  } as Record<string, string>;
}

const fmt = (n: number) => (Number(n) || 0).toLocaleString('en-US');
function compact(n: number): string {
  const v = Number(n) || 0;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(v % 1_000_000 === 0 ? 0 : 1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v % 1_000 === 0 ? 0 : 1)}k`;
  return String(v);
}

function fmtBytes(bytes: number): string {
  const mb = (Number(bytes) || 0) / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${Math.round(mb)} MB`;
}

function fmtDuration(ms: number): string {
  const mins = Math.floor((Number(ms) || 0) / 60_000);
  const days = Math.floor(mins / 1440);
  const hours = Math.floor((mins % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins % 60}m`;
  return `${Math.max(1, mins)}m`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function refreshLabel(ms: number): string {
  if (ms <= 0) return 'auto-refresh off';
  const opt = REFRESH_OPTIONS.find((r) => r.ms === ms);
  return `refreshes every ${opt ? opt.label : `${Math.round(ms / 1000)}s`}`;
}

function isOnScreen(): boolean {
  if (document.hidden) return false;
  try {
    const frame = window.frameElement;
    return !frame || frame.classList.contains('is-active');
  } catch {
    return true;
  }
}

// Width of an element, tracked across resizes.
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const ro = new ResizeObserver((entries) => setWidth(Math.round(entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

function sumDaily(data: any, key: 'messages' | 'images'): number {
  return ((data?.activity?.daily || []) as Array<Record<string, number>>).reduce((s, d) => s + (d[key] || 0), 0);
}

function App() {
  const [cfg, setCfg] = useState<OverviewConfig>(loadConfig);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const daysRef = useRef(cfg.days);
  daysRef.current = cfg.days;
  const topNRef = useRef(cfg.topN);
  topNRef.current = cfg.topN;
  const refreshMsRef = useRef(cfg.refreshMs);
  refreshMsRef.current = cfg.refreshMs;
  const loadSeq = useRef(0);
  const loadedAt = useRef(0);

  useEffect(() => { saveConfig(cfg); }, [cfg]);
  // Re-fetch when the range or the requested leaderboard depth changes.
  useEffect(() => { void refresh(cfg.days); /* eslint-disable-line */ }, [cfg.days, cfg.topN]);
  // Quiet background refresh keeps the "live" page live without a spinner. The
  // shell keeps this frame loaded behind other tabs, so it only polls while it
  // is the frame on screen, and catches up when brought back. The interval is
  // user-configurable (and can be turned off) via refreshMsRef.
  useEffect(() => {
    const stale = () => refreshMsRef.current > 0 && Date.now() - loadedAt.current >= refreshMsRef.current;
    const timer = setInterval(() => {
      if (isOnScreen() && stale()) void refresh(daysRef.current, true);
    }, POLL_TICK_MS);
    const onMessage = (e: MessageEvent) => {
      if (e.origin === location.origin && e.data?.type === 'yaosb-shown' && stale()) void refresh(daysRef.current, true);
    };
    window.addEventListener('message', onMessage);
    return () => { clearInterval(timer); window.removeEventListener('message', onMessage); };
  }, []);

  async function refresh(days = cfg.days, quiet = false) {
    // A manual load supersedes older manual loads, so only the latest one may
    // clear the spinner or report an error.
    const seq = quiet ? loadSeq.current : ++loadSeq.current;
    if (!quiet) { setLoading(true); setError(null); }
    try {
      const top = Math.max(8, topNRef.current); // fetch enough rows for the largest board
      const d = await getJson(`/api/overview?days=${days}&top=${top}`);
      if (d.days === daysRef.current) {
        setData(d);
        loadedAt.current = Date.now();
        if (seq === loadSeq.current) setError(null);
      }
    } catch (e: any) {
      if (!quiet && seq === loadSeq.current) setError(e?.message || 'Failed to load.');
    } finally {
      if (!quiet && seq === loadSeq.current) setLoading(false);
    }
  }

  const vars = useMemo(() => accentVars(cfg.accent), [cfg.accent]);
  const orderedOn = cfg.widgets.filter((w) => w.on);

  return h('div', { className: `wrap${cfg.fullWidth ? ' is-wide' : ''}`, 'data-density': cfg.density, style: vars as any },
    h(Header, {
      data, loading,
      header: cfg.header,
      days: cfg.days,
      onDays: (d: number) => setCfg((c) => ({ ...c, days: d })),
      onRefresh: () => refresh(),
      onSettings: () => setSettingsOpen(true),
    }),
    error ? h('div', { className: 'error-line', role: 'alert' }, h(FiZap), error) : null,
    !data && loading ? h(Skeleton) : null,
    data ? h('div', { className: 'board' },
      orderedOn.map((w) => h(Widget, {
        key: w.id, id: w.id, span: w.span, data, days: data.days,
        kpis: cfg.kpis, topN: cfg.topN,
        activity: cfg.activity,
        onActivity: (patch: Partial<ActivityPref>) => setCfg((c) => ({ ...c, activity: { ...c.activity, ...patch } })),
      }))
    ) : null,
    data ? h('footer', { className: 'page-foot' },
      h('span', null, `${BOT_NAME} · Overview`),
      h('span', null, `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${refreshLabel(cfg.refreshMs)}`),
    ) : null,
    settingsOpen ? h(SettingsDrawer, {
      cfg, setCfg,
      onClose: () => setSettingsOpen(false),
    }) : null,
  );
}

function Header({ data, loading, header, days, onDays, onRefresh, onSettings }: any) {
  const serverName = data?.server?.name;
  const title = header?.title?.trim() ? header.title.trim() : `${greeting()}.`;
  const subtitle = header?.subtitle?.trim()
    ? header.subtitle.trim()
    : (serverName ? `Here’s what ${BOT_NAME} has been up to in ${serverName}.` : `Here’s what ${BOT_NAME} has been up to.`);
  return h('header', { className: 'page-head' },
    h('div', { className: 'head-left' },
      header?.showEyebrow !== false ? h('span', { className: 'eyebrow' }, h(FiRadio), 'Live overview') : null,
      h('h1', null, title),
      h('p', { className: 'muted' }, subtitle)),
    h('div', { className: 'head-right' },
      h('div', { className: 'segmented', role: 'group', 'aria-label': 'Time range' },
        DAY_OPTIONS.map((d) => h('button', {
          key: d, type: 'button',
          className: `seg ${days === d ? 'is-active' : ''}`,
          'aria-pressed': days === d,
          onClick: () => onDays(d),
        }, `${d}d`))),
      h('button', { className: 'btn btn-quiet icon-only', title: 'Refresh', 'aria-label': 'Refresh', onClick: onRefresh },
        h(FiRefreshCw, { className: loading ? 'spin' : '' })),
      h('button', { className: 'btn', onClick: onSettings }, h(FiSliders), 'Customize')),
  );
}

function Skeleton() {
  return h('div', { className: 'board', 'aria-busy': true, 'aria-label': 'Loading dashboard' },
    h('div', { className: 'block block-kpis kpi-grid' },
      [0, 1, 2, 3, 4, 5].map((i) => h('div', { className: 'kpi skel', key: i }))),
    h('div', { className: 'block block-activity card skel skel-tall' }),
    h('div', { className: 'block block-health card skel skel-tall' }),
  );
}

function Widget({ id, span, data, days, kpis, topN, activity, onActivity }: any) {
  const style = { gridColumn: `span ${span}` };
  if (id === 'kpis') return h(Kpis, { data, days, kpis, style });
  if (id === 'activity') return h(ActivityCard, { data, days, style, activity, onActivity });
  if (id === 'health') return h(HealthCard, { data, style });
  if (id === 'images-board') return h(Leaderboard, {
    title: 'Top image senders', desc: 'Ranked by images shared', style, topN,
    rows: data?.activity?.topImages || [], metric: 'images', other: 'messages', empty: 'No images shared yet.',
  });
  if (id === 'active-board') return h(Leaderboard, {
    title: 'Most active members', desc: 'Ranked by messages sent', style, topN,
    rows: data?.activity?.topMessages || [], metric: 'messages', other: 'images', empty: 'No messages tracked yet.',
  });
  if (id === 'weekday') return h(WeekdayCard, { data, style });
  if (id === 'features') return h(FeaturesCard, { data, style });
  return null;
}

// ---- Stat cards ----------------------------------------------------------

function buildKpi(id: string, data: any, days: number): { icon: any; label: string; value: any; delta?: [number, number] | null; sub: string } | null {
  const a = data?.activity || {};
  const f = data?.features || {};
  const prev = a?.previous || null;
  const windowMsgs = sumDaily(data, 'messages');
  const windowImgs = sumDaily(data, 'images');
  switch (id) {
    case 'messages': return { icon: FiMessageSquare, label: `Messages · ${days}d`, value: windowMsgs, delta: prev ? [windowMsgs, prev.messages] : null, sub: `${compact(a?.totals?.messages || 0)} all-time` };
    case 'images': return { icon: FiImage, label: `Images · ${days}d`, value: windowImgs, delta: prev ? [windowImgs, prev.images] : null, sub: `${compact(a?.totals?.images || 0)} all-time` };
    case 'members': return { icon: FiUsers, label: 'Members', value: data?.server?.memberCount ?? '—', sub: `${fmt(a?.activeToday || 0)} active today` };
    case 'active-today': return { icon: FiZap, label: 'Active today', value: a?.activeToday ?? 0, sub: 'members spoke today' };
    case 'tickets': return { icon: FiInbox, label: 'Open tickets', value: f?.tickets?.open || 0, sub: `${fmt(f?.tickets?.total || 0)} all-time` };
    case 'notify': return { icon: FiBell, label: 'Notify feeds', value: f?.notify?.total || 0, sub: `${fmt(f?.notify?.live || 0)} live` };
    case 'sync': return { icon: FiShare2, label: 'Sync links', value: f?.sync?.total || 0, sub: `${fmt(f?.sync?.twoWay || 0)} two-way` };
    default: return null;
  }
}

function Kpis({ data, days, kpis, style }: any) {
  const cards = (kpis as KpiPref[]).filter((k) => k.on).map((k) => buildKpi(k.id, data, days)).filter(Boolean) as Array<ReturnType<typeof buildKpi> & object>;
  if (cards.length === 0) return null;
  return h('section', { className: 'block block-kpis', style },
    h('div', { className: 'kpi-grid' }, cards.map((c: any, i) =>
      h('article', { className: 'kpi', key: i },
        h('div', { className: 'kpi-top' },
          h('span', { className: 'kpi-label' }, c.label),
          h('span', { className: 'kpi-icon', 'aria-hidden': true }, h(c.icon))),
        h('span', { className: 'kpi-value tnum' }, typeof c.value === 'number' ? fmt(c.value) : c.value),
        h('div', { className: 'kpi-foot' },
          c.delta ? h(Delta, { cur: c.delta[0], prev: c.delta[1], days }) : null,
          h('span', { className: 'faint' }, c.sub))))),
  );
}

function Delta({ cur, prev, days }: { cur: number; prev: number; days: number }) {
  if (!prev) return null;
  const pct = ((cur - prev) / prev) * 100;
  const abs = Math.abs(pct);
  const text = `${pct > 0 ? '+' : pct < 0 ? '−' : ''}${abs < 10 ? abs.toFixed(1) : Math.round(abs)}%`;
  const tone = abs < 0.5 ? 'flat' : pct > 0 ? 'up' : 'down';
  return h('span', { className: `delta delta-${tone}`, title: `${fmt(prev)} in the previous ${days} days` },
    tone === 'up' ? h(FiArrowUpRight) : tone === 'down' ? h(FiArrowDownRight) : null,
    text);
}

// ---- Activity chart ------------------------------------------------------

function ActivityCard({ data, days, style, activity, onActivity }: any) {
  const daily = (data?.activity?.daily || []) as Array<{ day: string; messages: number; images: number }>;
  const pref: ActivityPref = activity || { series: ['messages', 'images'], style: 'area' };
  const activeKeys = SERIES_ORDER.filter((k) => pref.series.includes(k));

  // Clicking a legend chip toggles that series; the last active one can't be
  // turned off, so the chart never goes blank.
  function toggleSeries(key: SeriesKey) {
    const on = activeKeys.includes(key);
    if (on && activeKeys.length === 1) return;
    const next = on ? activeKeys.filter((k) => k !== key) : SERIES_ORDER.filter((k) => k === key || activeKeys.includes(k));
    onActivity?.({ series: next });
  }

  const labels = activeKeys.map((k) => SERIES_META[k].label);
  const shown = labels.length <= 1 ? (labels[0] || 'Activity')
    : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const right = h('div', { className: 'chart-controls' },
    h('div', { className: 'legend' }, SERIES_ORDER.map((key) => {
      const on = activeKeys.includes(key);
      return h('button', {
        key, type: 'button', className: `legend-item legend-toggle ${on ? 'is-on' : 'is-off'}`,
        'aria-pressed': on, title: on ? `Hide ${SERIES_META[key].label}` : `Show ${SERIES_META[key].label}`,
        onClick: () => toggleSeries(key),
      },
        h('i', { className: 'dot', style: { background: SERIES_META[key].color } }),
        SERIES_META[key].label,
        on ? h('b', { className: 'tnum' }, fmt(daily.reduce((s, d) => s + seriesValue(d, key), 0))) : null);
    })),
    h('div', { className: 'segmented seg-sm', role: 'group', 'aria-label': 'Chart style' },
      CHART_STYLES.map((c) => h('button', {
        key: c.id, type: 'button', className: `seg ${pref.style === c.id ? 'is-active' : ''}`,
        'aria-pressed': pref.style === c.id, onClick: () => onActivity?.({ style: c.id }),
      }, c.label))));

  return h(Card, {
    title: 'Activity', desc: `${shown} over the last ${days} days`,
    className: 'block-activity', style, right,
  },
    daily.length === 0
      ? h('p', { className: 'empty muted' }, 'No activity recorded yet.')
      : h(SeriesChart, { daily, activeKeys, style: pref.style }),
  );
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const unit = raw / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}

// One chart for every combination of selected series and style (area / line /
// bars). The SVG is drawn 1:1 with the container so text and strokes keep their
// CSS size instead of being scaled with a fixed viewBox.
function SeriesChart({ daily, activeKeys, style }: { daily: Array<{ day: string; messages: number; images: number }>; activeKeys: SeriesKey[]; style: ChartStyle }) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, measured] = useWidth<HTMLDivElement>();
  const W = Math.max(240, measured || 600);
  const H = W < 480 ? 180 : 230;
  const PADL = 36, PADR = 10, PADT = 12, PADB = 26;
  const innerW = W - PADL - PADR, innerH = H - PADT - PADB;
  const n = daily.length;
  const keys = activeKeys.length ? activeKeys : (['messages'] as SeriesKey[]);
  // Round the axis top up to four whole, "nice" steps (1/2/5 × 10^k) so the
  // gridline labels never repeat (a raw max of 1 used to print 0,0,1,1,1).
  const rawMax = Math.max(1, ...daily.map((d) => Math.max(...keys.map((k) => seriesValue(d, k)))));
  const step = niceStep(rawMax / 4);
  const max = step * 4;
  const x = (i: number) => PADL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PADT + innerH - (v / max) * innerH;

  const linePath = (key: SeriesKey) =>
    daily.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(seriesValue(d, key)).toFixed(1)}`).join(' ');
  const areaPath = (key: SeriesKey) =>
    `${linePath(key)} L ${x(n - 1).toFixed(1)} ${(PADT + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(PADT + innerH).toFixed(1)} Z`;

  const gridVals = [0, 0.25, 0.5, 0.75, 1];
  const ticks = niceTicks(daily, Math.max(2, Math.floor(innerW / 80)));

  // Grouped-bar geometry: a slot per day, split evenly between active series.
  const slot = innerW / Math.max(1, n);
  const groupW = Math.min(slot * 0.72, 30);
  const barW = groupW / keys.length;

  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * W;
    const i = n <= 1 ? 0 : Math.round(((svgX - PADL) / innerW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  }

  const point = hover != null ? daily[hover] : null;
  const leftPct = hover != null ? (x(hover) / W) * 100 : 0;

  return h('div', { className: 'chart-wrap', ref: wrapRef, onPointerMove: onMove, onPointerLeave: () => setHover(null) },
    h('svg', { className: 'chart', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Activity chart' },
      style === 'area' ? h('defs', null, keys.map((k) =>
        h('linearGradient', { id: `fill-${k}`, key: k, x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: SERIES_META[k].color, stopOpacity: '0.22' }),
          h('stop', { offset: '100%', stopColor: SERIES_META[k].color, stopOpacity: '0' })))) : null,
      gridVals.map((g, i) => {
        const gy = PADT + innerH - g * innerH;
        return h('g', { key: i },
          h('line', { x1: PADL, y1: gy, x2: W - PADR, y2: gy, className: `grid-line${g === 0 ? ' grid-base' : ''}` }),
          h('text', { x: PADL - 8, y: gy + 3, className: 'axis-ty', textAnchor: 'end' }, compact(g * max)));
      }),
      // Bars: one group of rectangles per day.
      style === 'bars' ? daily.map((d, i) =>
        h('g', { key: i }, keys.map((k, j) => {
          const v = seriesValue(d, k);
          const bx = x(i) - groupW / 2 + j * barW;
          const by = y(v);
          return h('rect', {
            key: k, x: bx + 0.5, y: by, width: Math.max(1, barW - 1), height: Math.max(0, PADT + innerH - by),
            rx: Math.min(2, barW / 3), fill: SERIES_META[k].color, opacity: hover == null || hover === i ? 1 : 0.5,
          });
        }))) : null,
      // Area fills (only in area style), drawn under the lines.
      style === 'area' ? keys.map((k) => h('path', { key: `a-${k}`, d: areaPath(k), fill: `url(#fill-${k})`, stroke: 'none' })) : null,
      // Lines for area + line styles.
      style !== 'bars' ? keys.map((k) => h('path', {
        key: `l-${k}`, d: linePath(k), fill: 'none', stroke: SERIES_META[k].color,
        className: 'line', strokeWidth: k === 'images' ? 1.5 : 2,
      })) : null,
      hover != null ? h('line', { x1: x(hover), x2: x(hover), y1: PADT, y2: PADT + innerH, className: 'hover-line' }) : null,
      ticks.map((t, i) => h('text', { key: i, x: x(t.i), y: H - 8, className: 'axis-tx', textAnchor: 'middle' }, t.label)),
    ),
    // Markers live outside the stretched SVG so they stay round (line/area only).
    point && style !== 'bars' ? keys.map((k) => h('span', {
      key: k, className: 'marker', style: { background: SERIES_META[k].color, left: `${leftPct}%`, top: `${(y(seriesValue(point, k)) / H) * 100}%` },
    })) : null,
    point ? h('div', { className: `chart-tip ${leftPct > 70 ? 'tip-left' : ''}`, style: { left: `${leftPct}%` } },
      h('span', { className: 'tip-day' }, longDay(point.day)),
      keys.map((k) => h('span', { key: k, className: 'tip-row' },
        h('i', { className: 'dot', style: { background: SERIES_META[k].color } }), SERIES_META[k].label,
        h('b', { className: 'tnum' }, fmt(seriesValue(point, k)))))) : null,
  );
}

function niceTicks(daily: Array<{ day: string }>, maxTicks = 6): Array<{ i: number; label: string }> {
  const n = daily.length;
  if (n === 0) return [];
  const want = Math.min(6, maxTicks, n);
  const step = Math.max(1, Math.round((n - 1) / (want - 1 || 1)));
  const out: Array<{ i: number; label: string }> = [];
  for (let i = 0; i < n; i += step) out.push({ i, label: shortDay(daily[i].day) });
  const last = n - 1;
  if (out[out.length - 1]?.i !== last) {
    // Always label the final day, but drop the previous tick if the two labels
    // would sit on top of each other.
    if (out.length > 1 && last - out[out.length - 1].i < step * 0.6) out.pop();
    out.push({ i: last, label: shortDay(daily[last].day) });
  }
  return out;
}

function shortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso.slice(5);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function longDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// ---- Bot health ----------------------------------------------------------

function featureStates(data: any): boolean[] {
  const f = data?.features || {};
  return [
    (f?.tickets?.total || 0) > 0,
    (f?.notify?.total || 0) > 0,
    (f?.sync?.total || 0) > 0,
    (f?.statsChannels || 0) > 0,
    !!f?.welcome?.enabled,
    !!f?.logs?.enabled,
    (f?.joinRoles || 0) > 0,
    (f?.reactionRoles || 0) > 0,
  ];
}

function HealthCard({ data, style }: any) {
  const hl = data?.health;
  const states = featureStates(data);
  const onCount = states.filter(Boolean).length;
  const ringPct = Math.round((onCount / states.length) * 100);
  const status = !hl ? null : hl.connected
    ? h('span', { className: 'badge badge-ok' }, 'Healthy')
    : h('span', { className: 'badge badge-danger' }, 'Offline');

  const meters: Array<{ label: string; value: string; pct: number }> = [];
  if (hl) {
    meters.push({ label: 'CPU', value: `${hl.cpuPercent.toFixed(1)}%`, pct: hl.cpuPercent });
    if (hl.heapLimit) meters.push({ label: 'JS heap', value: `${fmtBytes(hl.heapUsed)} / ${fmtBytes(hl.heapLimit)}`, pct: (hl.heapUsed / hl.heapLimit) * 100 });
    if (hl.systemMemory) meters.push({ label: 'Process memory', value: `${fmtBytes(hl.rss)} of ${fmtBytes(hl.systemMemory)}`, pct: (hl.rss / hl.systemMemory) * 100 });
    else meters.push({ label: 'Process memory', value: fmtBytes(hl.rss), pct: -1 });
  }

  return h(Card, { title: 'Bot health', desc: 'Gateway and process resources', className: 'block-health', style, right: status },
    h('div', { className: 'health-top' },
      h('div', {
        className: 'ring',
        style: { background: `conic-gradient(var(--accent) 0 ${ringPct}%, var(--surface-3) ${ringPct}% 100%)` },
        role: 'img', 'aria-label': `${onCount} of ${states.length} features active`,
      },
        h('div', { className: 'ring-inner' },
          h('span', { className: 'ring-value tnum' }, `${onCount}/${states.length}`),
          h('span', { className: 'ring-label' }, 'Features'))),
      h('dl', { className: 'health-facts' },
        h('div', null,
          h('dt', null, 'Gateway'),
          h('dd', { className: hl?.connected ? 'ok' : 'down' },
            !hl ? '—' : hl.connected ? (hl.ping ? `Connected · ${hl.ping} ms` : 'Connected') : 'Disconnected')),
        h('div', null,
          h('dt', null, 'Uptime'),
          h('dd', null, hl ? fmtDuration(hl.uptimeMs) : '—')),
        hl?.servers != null ? h('div', null,
          h('dt', null, 'Servers'),
          h('dd', { className: 'tnum' }, fmt(hl.servers))) : null)),
    meters.length === 0
      ? h('p', { className: 'empty muted' }, 'Health data unavailable.')
      : h('div', { className: 'meters' }, meters.map((m) =>
          h('div', { className: 'meter', key: m.label },
            h('div', { className: 'meter-top' },
              h('span', { className: 'muted' }, m.label),
              h('span', { className: 'meter-val tnum' }, m.value)),
            m.pct >= 0 ? h('div', { className: 'meter-track' },
              h('div', { className: 'meter-fill', style: { width: `${Math.max(1.5, Math.min(100, m.pct))}%` } })) : null))),
  );
}

// ---- Weekday bars --------------------------------------------------------

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function WeekdayCard({ data, style }: any) {
  const daily = (data?.activity?.daily || []) as Array<{ day: string; messages: number }>;
  const sums = [0, 0, 0, 0, 0, 0, 0];
  for (const d of daily) {
    const dt = new Date(`${d.day}T00:00:00`);
    if (!Number.isNaN(dt.getTime())) sums[dt.getDay()] += d.messages || 0;
  }
  const max = Math.max(1, ...sums);
  const peak = sums.indexOf(Math.max(...sums));
  return h(Card, {
    title: 'Busiest days', desc: 'Messages by day of week',
    className: 'block-weekday', style,
    right: sums[peak] > 0 ? h('span', { className: 'badge badge-accent' }, `Peak · ${WEEKDAYS[peak]}`) : null,
  },
    daily.length === 0
      ? h('p', { className: 'empty muted' }, 'No activity yet.')
      : h('div', { className: 'bars' }, sums.map((v, i) =>
          h('div', { className: 'bar-col', key: i, title: `${WEEKDAYS[i]}: ${fmt(v)}` },
            h('span', { className: 'bar-num tnum' }, compact(v)),
            h('div', { className: 'bar-track' },
              h('div', { className: `bar-fill ${i === peak && v > 0 ? 'is-peak' : ''}`, style: { height: `${(v / max) * 100}%` } })),
            h('span', { className: 'bar-label' }, WEEKDAYS[i].slice(0, 2))))),
  );
}

// ---- Leaderboards --------------------------------------------------------

function Leaderboard({ title, desc, rows, metric, other, empty, style, topN }: any) {
  const top = ((rows || []) as Array<{ userId: string; name: string; messages: number; images: number; avatar?: string | null }>).slice(0, topN || 5);
  const max = Math.max(1, ...top.map((r) => (r as any)[metric] || 0));
  return h(Card, { title, desc, className: 'block-board', flush: true, style },
    top.length === 0
      ? h('p', { className: 'empty muted' }, empty)
      : h('ol', { className: 'ranks' }, top.map((r, i) =>
          h('li', { className: 'rank', key: r.userId || i },
            h('span', { className: 'rank-no tnum' }, String(i + 1).padStart(2, '0')),
            h(Avatar, { name: r.name, src: r.avatar }),
            h('div', { className: 'rank-body' },
              h('span', { className: 'rank-name', title: r.name }, r.name),
              h('span', { className: 'rank-sub faint' }, `${fmt((r as any)[other] || 0)} ${other}`)),
            h('div', { className: 'rank-track', 'aria-hidden': true },
              h('div', { className: 'rank-bar', style: { width: `${(((r as any)[metric] || 0) / max) * 100}%` } })),
            h('span', { className: 'rank-val tnum' }, fmt((r as any)[metric] || 0))))),
  );
}

// Real profile picture when we have one; falls back to a neutral initial chip
// if the user has no avatar or the image fails to load.
function Avatar({ name, src }: { name: string; src?: string | null }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return h('img', {
      className: 'avatar avatar-img', src, alt: '', loading: 'lazy', decoding: 'async',
      referrerPolicy: 'no-referrer', onError: () => setFailed(true),
    });
  }
  return h('span', { className: 'avatar avatar-initial', 'aria-hidden': true }, initial(name));
}

function initial(name: string): string {
  const t = String(name || '?').trim();
  return (t[0] || '?').toUpperCase();
}

// ---- Feature status ------------------------------------------------------

function FeaturesCard({ data, style }: any) {
  const f = data?.features || {};
  const on = featureStates(data);
  const items = [
    { icon: FiInbox, label: 'Tickets', value: `${fmt(f?.tickets?.open || 0)} open`, sub: `${fmt(f?.tickets?.total || 0)} total` },
    { icon: FiBell, label: 'Notifications', value: `${fmt(f?.notify?.live || 0)} live`, sub: `${fmt(f?.notify?.total || 0)} feeds` },
    { icon: FiShare2, label: 'Channel sync', value: `${fmt(f?.sync?.total || 0)} links`, sub: `${fmt(f?.sync?.twoWay || 0)} two-way` },
    { icon: FiHash, label: 'Stats channels', value: fmt(f?.statsChannels || 0), sub: 'counters' },
    { icon: FiUsers, label: 'Welcome', value: f?.welcome?.enabled ? 'On' : 'Off', sub: `${fmt(f?.welcome?.images || 0)} images` },
    { icon: FiFileText, label: 'Server logs', value: f?.logs?.enabled ? 'On' : 'Off', sub: f?.logs?.enabled ? 'active' : 'disabled' },
    { icon: FiUserPlus, label: 'Join roles', value: fmt(f?.joinRoles || 0), sub: 'auto-assign' },
    { icon: FiSmile, label: 'Reaction roles', value: fmt(f?.reactionRoles || 0), sub: 'messages' },
  ];
  return h(Card, {
    title: 'Feature status', desc: `What ${BOT_NAME} is running here`, className: 'block-features', flush: true, style,
    right: h('span', { className: 'badge' }, `${on.filter(Boolean).length} of ${on.length} active`),
  },
    h('div', { className: 'feat-grid' }, items.map((it, i) =>
      h('div', { className: `feat ${on[i] ? 'is-on' : 'is-off'}`, key: i },
        h('span', { className: 'feat-icon', 'aria-hidden': true }, h(it.icon)),
        h('div', { className: 'feat-body' },
          h('span', { className: 'feat-label' }, it.label),
          h('span', { className: 'feat-value' }, it.value),
          h('span', { className: 'feat-sub faint' }, it.sub)),
        h('span', { className: `status-dot ${on[i] ? 'on' : 'off'}`, title: on[i] ? 'Active' : 'Not set up' })))),
  );
}

// ---- Card shell ----------------------------------------------------------

function Card({ title, desc, right, className, flush, style, children }: any) {
  return h('section', { className: `block card ${className || ''}`, style },
    h('div', { className: `card-head${flush ? ' card-head-rule' : ''}` },
      h('div', { className: 'card-head-text' },
        h('h2', null, title),
        desc ? h('p', { className: 'muted' }, desc) : null),
      right ? h('div', { className: 'card-head-right' }, right) : null),
    h('div', { className: `card-body${flush ? ' card-body-flush' : ''}` }, children));
}

// ---- Settings drawer -----------------------------------------------------

// Tells the dashboard shell a modal is open so it dims its own sidebar and top
// bar too; a click there comes back as `yaosb-modal-dismiss`.
function notifyShellModal(open: boolean) {
  try {
    if (window.parent !== window) window.parent.postMessage({ type: 'yaosb-modal', open }, location.origin);
  } catch { /* not embedded */ }
}

// A labelled row of segmented buttons — reused for density / refresh / rows.
function SegRow({ label, options, value, onPick }: { label: string; options: Array<{ v: any; label: string }>; value: any; onPick: (v: any) => void }) {
  return h('div', { className: 'seg-row' },
    h('span', { className: 'seg-row-label' }, label),
    h('div', { className: 'segmented', role: 'group', 'aria-label': label },
      options.map((o) => h('button', {
        key: String(o.v), type: 'button',
        className: `seg ${value === o.v ? 'is-active' : ''}`,
        'aria-pressed': value === o.v,
        onClick: () => onPick(o.v),
      }, o.label))));
}

function SettingsDrawer({ cfg, setCfg, onClose }: any) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);
  const [ioText, setIoText] = useState('');
  const [ioNote, setIoNote] = useState<string | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    notifyShellModal(true);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    const onMessage = (e: MessageEvent) => {
      if (e.origin === location.origin && e.data?.type === 'yaosb-modal-dismiss') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('message', onMessage);
      notifyShellModal(false);
      opener?.focus?.();
    };
  }, []);

  function patch(p: Partial<OverviewConfig>) { setCfg((c: OverviewConfig) => ({ ...c, ...p })); }
  function patchHeader(p: Partial<HeaderPref>) { setCfg((c: OverviewConfig) => ({ ...c, header: { ...c.header, ...p } })); }

  function toggleWidget(id: string) {
    setCfg((c: OverviewConfig) => ({ ...c, widgets: c.widgets.map((w) => (w.id === id ? { ...w, on: !w.on } : w)) }));
  }
  function setSpan(id: string, span: number) {
    setCfg((c: OverviewConfig) => ({ ...c, widgets: c.widgets.map((w) => (w.id === id ? { ...w, span } : w)) }));
  }
  function moveWidget(id: string, dir: -1 | 1) {
    setCfg((c: OverviewConfig) => {
      const arr = [...c.widgets];
      const i = arr.findIndex((w) => w.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return c;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...c, widgets: arr };
    });
  }
  function toggleKpi(id: string) {
    setCfg((c: OverviewConfig) => ({ ...c, kpis: c.kpis.map((k) => (k.id === id ? { ...k, on: !k.on } : k)) }));
  }
  function moveKpi(id: string, dir: -1 | 1) {
    setCfg((c: OverviewConfig) => {
      const arr = [...c.kpis];
      const i = arr.findIndex((k) => k.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return c;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...c, kpis: arr };
    });
  }

  const wDef = (id: string) => WIDGET_DEFS.find((w) => w.id === id)!;
  const kDef = (id: string) => KPI_DEFS.find((k) => k.id === id)!;

  async function copyConfig() {
    const json = JSON.stringify(cfg, null, 2);
    setIoText(json);
    try {
      await navigator.clipboard.writeText(json);
      setIoNote('Copied to clipboard.');
    } catch {
      setIoNote('Layout below — select and copy.');
    }
  }
  function importConfig() {
    try {
      const next = reconcile(JSON.parse(ioText));
      setCfg(next);
      setIoNote('Layout applied.');
    } catch {
      setIoNote('Could not read that — paste an exported layout.');
    }
  }

  return h('div', { className: 'drawer-scrim', onClick: onClose },
    h('aside', { className: 'drawer', role: 'dialog', 'aria-modal': true, 'aria-label': 'Customize overview', onClick: (e: any) => e.stopPropagation() },
      h('div', { className: 'drawer-head' },
        h('div', null, h('h2', null, 'Customize'), h('p', { className: 'muted' }, 'Reorder, resize, recolor and retitle your overview.')),
        h('button', { className: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: onClose, ref: closeBtnRef }, h(FiX))),

      // ---- Layout ----
      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, h(FiColumns), 'Layout'),
        h(SegRow, {
          label: 'Density', value: cfg.density,
          options: DENSITY_OPTIONS.map((d) => ({ v: d.id, label: d.label })),
          onPick: (v: Density) => patch({ density: v }),
        }),
        h(SegRow, {
          label: 'Auto-refresh', value: cfg.refreshMs,
          options: REFRESH_OPTIONS.map((r) => ({ v: r.ms, label: r.label })),
          onPick: (v: number) => patch({ refreshMs: v }),
        }),
        h(SegRow, {
          label: 'Leaderboard rows', value: cfg.topN,
          options: TOPN_OPTIONS.map((n) => ({ v: n, label: String(n) })),
          onPick: (v: number) => patch({ topN: v }),
        }),
        h('label', { className: 'switch-row' },
          h('span', null, h(FiMaximize2), 'Full-width board'),
          h('button', {
            type: 'button', className: `toggle ${cfg.fullWidth ? 'on' : ''}`,
            'aria-pressed': cfg.fullWidth, title: cfg.fullWidth ? 'On' : 'Off',
            onClick: () => patch({ fullWidth: !cfg.fullWidth }),
          }, h(cfg.fullWidth ? FiEye : FiEyeOff)))),

      // ---- Header ----
      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, h(FiType), 'Header'),
        h('div', { className: 'field' },
          h('label', { htmlFor: 'ov-title' }, 'Title'),
          h('input', {
            id: 'ov-title', type: 'text', maxLength: 80,
            value: cfg.header.title, placeholder: `${greeting()}. (default)`,
            onChange: (e: any) => patchHeader({ title: e.target.value }),
          })),
        h('div', { className: 'field' },
          h('label', { htmlFor: 'ov-sub' }, 'Subtitle'),
          h('input', {
            id: 'ov-sub', type: 'text', maxLength: 160,
            value: cfg.header.subtitle, placeholder: 'Default greeting line',
            onChange: (e: any) => patchHeader({ subtitle: e.target.value }),
          })),
        h('label', { className: 'switch-row' },
          h('span', null, h(FiRadio), '“Live overview” label'),
          h('button', {
            type: 'button', className: `toggle ${cfg.header.showEyebrow ? 'on' : ''}`,
            'aria-pressed': cfg.header.showEyebrow, title: cfg.header.showEyebrow ? 'Shown' : 'Hidden',
            onClick: () => patchHeader({ showEyebrow: !cfg.header.showEyebrow }),
          }, h(cfg.header.showEyebrow ? FiEye : FiEyeOff)))),

      // ---- Accent ----
      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, 'Accent color'),
        h('div', { className: 'swatches' },
          ACCENT_PRESETS.map((p) => h('button', {
            key: p.hex, type: 'button', title: p.name, 'aria-label': p.name,
            className: `swatch ${cfg.accent.toLowerCase() === p.hex.toLowerCase() ? 'is-active' : ''}`,
            style: { background: p.hex },
            onClick: () => patch({ accent: p.hex }),
          })),
          h('label', {
            className: `swatch swatch-custom ${ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === cfg.accent.toLowerCase()) ? '' : 'is-active'}`,
            title: 'Custom color',
          },
            h('input', {
              type: 'color', value: cfg.accent, 'aria-label': 'Custom accent color',
              onChange: (e: any) => patch({ accent: e.target.value }),
            }))),
        h('p', { className: 'faint tiny' }, 'Coral is the default. Pick anything, or keep the red.')),

      // ---- Stat cards ----
      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, 'Stat cards'),
        h('ul', { className: 'widget-list' }, cfg.kpis.map((k: KpiPref, idx: number) =>
          h('li', { className: `widget-row compact-row ${k.on ? '' : 'is-off'}`, key: k.id },
            h('div', { className: 'wr-main' },
              h('div', { className: 'wr-move' },
                h('button', { className: 'icon-btn tiny-btn', disabled: idx === 0, title: 'Move up', 'aria-label': 'Move up', onClick: () => moveKpi(k.id, -1) }, h(FiChevronUp)),
                h('button', { className: 'icon-btn tiny-btn', disabled: idx === cfg.kpis.length - 1, title: 'Move down', 'aria-label': 'Move down', onClick: () => moveKpi(k.id, 1) }, h(FiChevronDown))),
              h('div', { className: 'wr-text' },
                h('span', { className: 'wr-label' }, kDef(k.id).label),
                h('span', { className: 'wr-hint faint' }, kDef(k.id).hint)),
              h('button', {
                className: `toggle ${k.on ? 'on' : ''}`, title: k.on ? 'Hide' : 'Show',
                'aria-label': `${k.on ? 'Hide' : 'Show'} ${kDef(k.id).label}`, 'aria-pressed': k.on,
                onClick: () => toggleKpi(k.id),
              }, h(k.on ? FiEye : FiEyeOff)))))),
      ),

      // ---- Widgets ----
      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, 'Widgets & width'),
        h('ul', { className: 'widget-list' }, cfg.widgets.map((w: WidgetPref, idx: number) =>
          h('li', { className: `widget-row ${w.on ? '' : 'is-off'}`, key: w.id },
            h('div', { className: 'wr-main' },
              h('div', { className: 'wr-move' },
                h('button', { className: 'icon-btn tiny-btn', disabled: idx === 0, title: 'Move up', 'aria-label': 'Move up', onClick: () => moveWidget(w.id, -1) }, h(FiChevronUp)),
                h('button', { className: 'icon-btn tiny-btn', disabled: idx === cfg.widgets.length - 1, title: 'Move down', 'aria-label': 'Move down', onClick: () => moveWidget(w.id, 1) }, h(FiChevronDown))),
              h('div', { className: 'wr-text' },
                h('span', { className: 'wr-label' }, wDef(w.id).label),
                h('span', { className: 'wr-hint faint' }, wDef(w.id).hint)),
              h('button', {
                className: `toggle ${w.on ? 'on' : ''}`, title: w.on ? 'Hide' : 'Show',
                'aria-label': `${w.on ? 'Hide' : 'Show'} ${wDef(w.id).label}`, 'aria-pressed': w.on,
                onClick: () => toggleWidget(w.id),
              }, h(w.on ? FiEye : FiEyeOff))),
            h('div', { className: 'wr-span', role: 'group', 'aria-label': `${wDef(w.id).label} width` },
              SPAN_OPTIONS.map((s) => h('button', {
                key: s.n, type: 'button', title: s.title,
                className: `span-btn ${w.span === s.n ? 'is-active' : ''}`,
                'aria-pressed': w.span === s.n,
                onClick: () => setSpan(w.id, s.n),
              }, s.label)))))),
        h('p', { className: 'faint tiny' }, 'Widths apply on wide screens; narrow screens stack every widget.')),

      // ---- Share / backup ----
      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, h(FiCopy), 'Share layout'),
        h('div', { className: 'io-actions' },
          h('button', { className: 'btn btn-quiet', onClick: copyConfig }, h(FiCopy), 'Copy layout'),
          h('button', { className: 'btn btn-quiet', onClick: importConfig, disabled: !ioText.trim() }, h(FiUpload), 'Apply pasted')),
        h('textarea', {
          className: 'io-text', spellCheck: false, rows: 4,
          placeholder: 'Paste an exported layout here, then Apply pasted.',
          value: ioText, onChange: (e: any) => { setIoText(e.target.value); setIoNote(null); },
        }),
        ioNote ? h('p', { className: 'faint tiny io-note' }, h(FiCheck), ioNote) : null),

      h('div', { className: 'drawer-foot' },
        h('button', { className: 'btn btn-quiet', onClick: () => setCfg(defaultConfig()) }, h(FiRotateCcw), 'Reset to defaults'),
        h('button', { className: 'btn btn-accent', onClick: onClose }, 'Done')),
    ),
  );
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
