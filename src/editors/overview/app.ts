import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FiArrowDownRight, FiArrowUpRight, FiBell, FiChevronDown, FiChevronUp, FiEye, FiEyeOff,
  FiFileText, FiHash, FiImage, FiInbox, FiMessageSquare, FiRadio, FiRefreshCw, FiRotateCcw,
  FiShare2, FiSliders, FiSmile, FiUserPlus, FiUsers, FiX, FiZap,
} from 'react-icons/fi';
import { getJson } from '../shared/api.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const CONFIG_KEY = 'yaosb-overview-config';
const DEFAULT_ACCENT = '#fd6671'; // coral — kept as the default on purpose.
const AUTO_REFRESH_MS = 60_000;

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

const DAY_OPTIONS = [7, 14, 30, 90];

type WidgetPref = { id: string; on: boolean };
type OverviewConfig = { widgets: WidgetPref[]; accent: string; days: number };

function defaultConfig(): OverviewConfig {
  return { widgets: WIDGET_DEFS.map((w) => ({ id: w.id, on: true })), accent: DEFAULT_ACCENT, days: 14 };
}

function loadConfig(): OverviewConfig {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return defaultConfig();
    const parsed = JSON.parse(raw);
    return reconcile(parsed);
  } catch {
    return defaultConfig();
  }
}

// Merge a stored config with the current widget catalogue so removed widgets
// drop out while user order/toggles survive. New widgets land at their default
// position (right after the widget that precedes them in the catalogue), so a
// stored layout keeps its grid rows full.
function reconcile(parsed: any): OverviewConfig {
  const base = defaultConfig();
  const storedWidgets: WidgetPref[] = Array.isArray(parsed?.widgets) ? parsed.widgets : [];
  const known = new Set(WIDGET_DEFS.map((w) => w.id));
  const seen = new Set<string>();
  const widgets: WidgetPref[] = [];
  for (const w of storedWidgets) {
    if (w && known.has(w.id) && !seen.has(w.id)) {
      widgets.push({ id: w.id, on: w.on !== false });
      seen.add(w.id);
    }
  }
  WIDGET_DEFS.forEach((def, idx) => {
    if (seen.has(def.id)) return;
    const prevId = WIDGET_DEFS[idx - 1]?.id;
    const at = prevId ? widgets.findIndex((w) => w.id === prevId) + 1 : 0;
    widgets.splice(at, 0, { id: def.id, on: true });
    seen.add(def.id);
  });
  const days = DAY_OPTIONS.includes(Number(parsed?.days)) ? Number(parsed.days) : base.days;
  const accent = isHex(parsed?.accent) ? parsed.accent : base.accent;
  return { widgets, accent, days };
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
  const loadSeq = useRef(0);
  const loadedAt = useRef(0);

  useEffect(() => { saveConfig(cfg); }, [cfg]);
  useEffect(() => { void refresh(cfg.days); /* eslint-disable-line */ }, [cfg.days]);
  // Quiet background refresh keeps the "live" page live without a spinner.
  // The shell keeps this frame loaded behind other tabs, so it only polls
  // while it is the frame on screen, and catches up when brought back.
  useEffect(() => {
    const stale = () => Date.now() - loadedAt.current >= AUTO_REFRESH_MS;
    const timer = setInterval(() => {
      if (isOnScreen() && stale()) void refresh(daysRef.current, true);
    }, AUTO_REFRESH_MS / 4);
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
      const d = await getJson(`/api/overview?days=${days}&top=8`);
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

  return h('div', { className: 'wrap', style: vars as any },
    h(Header, {
      data, loading,
      days: cfg.days,
      onDays: (d: number) => setCfg((c) => ({ ...c, days: d })),
      onRefresh: () => refresh(),
      onSettings: () => setSettingsOpen(true),
    }),
    error ? h('div', { className: 'error-line', role: 'alert' }, h(FiZap), error) : null,
    !data && loading ? h(Skeleton) : null,
    data ? h('div', { className: 'board' },
      orderedOn.map((w) => h(Widget, { key: w.id, id: w.id, data, days: data.days }))
    ) : null,
    data ? h('footer', { className: 'page-foot' },
      h('span', null, `${BOT_NAME} · Overview`),
      h('span', null, `Updated ${new Date(data.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · refreshes every minute`),
    ) : null,
    settingsOpen ? h(SettingsDrawer, {
      cfg, setCfg,
      onClose: () => setSettingsOpen(false),
    }) : null,
  );
}

function Header({ data, loading, days, onDays, onRefresh, onSettings }: any) {
  const serverName = data?.server?.name;
  return h('header', { className: 'page-head' },
    h('div', { className: 'head-left' },
      h('span', { className: 'eyebrow' }, h(FiRadio), 'Live overview'),
      h('h1', null, `${greeting()}.`),
      h('p', { className: 'muted' },
        serverName ? `Here’s what ${BOT_NAME} has been up to in ${serverName}.` : `Here’s what ${BOT_NAME} has been up to.`)),
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

function Widget({ id, data, days }: any) {
  if (id === 'kpis') return h(Kpis, { data, days });
  if (id === 'activity') return h(ActivityCard, { data, days });
  if (id === 'health') return h(HealthCard, { data });
  if (id === 'images-board') return h(Leaderboard, {
    title: 'Top image senders', desc: 'Ranked by images shared',
    rows: data?.activity?.topImages || [], metric: 'images', other: 'messages', empty: 'No images shared yet.',
  });
  if (id === 'active-board') return h(Leaderboard, {
    title: 'Most active members', desc: 'Ranked by messages sent',
    rows: data?.activity?.topMessages || [], metric: 'messages', other: 'images', empty: 'No messages tracked yet.',
  });
  if (id === 'weekday') return h(WeekdayCard, { data });
  if (id === 'features') return h(FeaturesCard, { data });
  return null;
}

// ---- Stat cards ----------------------------------------------------------

function Kpis({ data, days }: any) {
  const a = data?.activity || {};
  const f = data?.features || {};
  const prev = a?.previous || null;
  const windowMsgs = sumDaily(data, 'messages');
  const windowImgs = sumDaily(data, 'images');
  const cards = [
    { icon: FiMessageSquare, label: `Messages · ${days}d`, value: windowMsgs, delta: prev ? [windowMsgs, prev.messages] : null, sub: `${compact(a?.totals?.messages || 0)} all-time` },
    { icon: FiImage, label: `Images · ${days}d`, value: windowImgs, delta: prev ? [windowImgs, prev.images] : null, sub: `${compact(a?.totals?.images || 0)} all-time` },
    { icon: FiUsers, label: 'Members', value: data?.server?.memberCount ?? '—', sub: `${fmt(a?.activeToday || 0)} active today` },
    { icon: FiInbox, label: 'Open tickets', value: f?.tickets?.open || 0, sub: `${fmt(f?.tickets?.total || 0)} all-time` },
    { icon: FiBell, label: 'Notify feeds', value: f?.notify?.total || 0, sub: `${fmt(f?.notify?.live || 0)} live` },
    { icon: FiShare2, label: 'Sync links', value: f?.sync?.total || 0, sub: `${fmt(f?.sync?.twoWay || 0)} two-way` },
  ];
  return h('section', { className: 'block block-kpis' },
    h('div', { className: 'kpi-grid' }, cards.map((c, i) =>
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

function ActivityCard({ data, days }: any) {
  const daily = (data?.activity?.daily || []) as Array<{ day: string; messages: number; images: number }>;
  const totalMsg = sumDaily(data, 'messages');
  const totalImg = sumDaily(data, 'images');
  return h(Card, {
    title: 'Activity', desc: `Messages and images over the last ${days} days`,
    className: 'block-activity',
    right: h('div', { className: 'legend' },
      h('span', { className: 'legend-item' }, h('i', { className: 'dot dot-msg' }), 'Messages', h('b', { className: 'tnum' }, fmt(totalMsg))),
      h('span', { className: 'legend-item' }, h('i', { className: 'dot dot-img' }), 'Images', h('b', { className: 'tnum' }, fmt(totalImg)))),
  },
    daily.length === 0
      ? h('p', { className: 'empty muted' }, 'No activity recorded yet.')
      : h(AreaChart, { daily }),
  );
}

function niceStep(raw: number): number {
  const pow = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1))));
  const unit = raw / pow;
  return (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10) * pow;
}

function AreaChart({ daily }: { daily: Array<{ day: string; messages: number; images: number }> }) {
  const [hover, setHover] = useState<number | null>(null);
  const [wrapRef, measured] = useWidth<HTMLDivElement>();
  // The SVG is drawn 1:1 with the container, so text and strokes keep their
  // CSS size instead of being scaled with a fixed viewBox.
  const W = Math.max(240, measured || 600);
  const H = W < 480 ? 180 : 230;
  const PADL = 36, PADR = 10, PADT = 12, PADB = 26;
  const innerW = W - PADL - PADR, innerH = H - PADT - PADB;
  const n = daily.length;
  // Round the axis top up to four whole, "nice" steps (1/2/5 × 10^k) so the
  // gridline labels never repeat (a raw max of 1 used to print 0,0,1,1,1).
  const rawMax = Math.max(1, ...daily.map((d) => Math.max(d.messages, d.images)));
  const step = niceStep(rawMax / 4);
  const max = step * 4;
  const x = (i: number) => PADL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => PADT + innerH - (v / max) * innerH;

  const line = (key: 'messages' | 'images') =>
    daily.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(' ');
  const area = (key: 'messages' | 'images') =>
    `${line(key)} L ${x(n - 1).toFixed(1)} ${(PADT + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(PADT + innerH).toFixed(1)} Z`;

  const gridVals = [0, 0.25, 0.5, 0.75, 1];
  const ticks = niceTicks(daily, Math.max(2, Math.floor(innerW / 80)));

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
      h('defs', null,
        h('linearGradient', { id: 'msgFill', x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: 'var(--accent)', stopOpacity: '0.22' }),
          h('stop', { offset: '100%', stopColor: 'var(--accent)', stopOpacity: '0' }))),
      gridVals.map((g, i) => {
        const gy = PADT + innerH - g * innerH;
        return h('g', { key: i },
          h('line', { x1: PADL, y1: gy, x2: W - PADR, y2: gy, className: `grid-line${g === 0 ? ' grid-base' : ''}` }),
          h('text', { x: PADL - 8, y: gy + 3, className: 'axis-ty', textAnchor: 'end' }, compact(g * max)));
      }),
      h('path', { d: area('messages'), fill: 'url(#msgFill)', stroke: 'none' }),
      h('path', { d: line('images'), className: 'line line-img', fill: 'none' }),
      h('path', { d: line('messages'), className: 'line line-msg', fill: 'none' }),
      hover != null ? h('line', { x1: x(hover), x2: x(hover), y1: PADT, y2: PADT + innerH, className: 'hover-line' }) : null,
      ticks.map((t, i) => h('text', { key: i, x: x(t.i), y: H - 8, className: 'axis-tx', textAnchor: 'middle' }, t.label)),
    ),
    // Markers live outside the stretched SVG so they stay round.
    point ? h('span', { className: 'marker marker-img', style: { left: `${leftPct}%`, top: `${(y(point.images) / H) * 100}%` } }) : null,
    point ? h('span', { className: 'marker marker-msg', style: { left: `${leftPct}%`, top: `${(y(point.messages) / H) * 100}%` } }) : null,
    point ? h('div', { className: `chart-tip ${leftPct > 70 ? 'tip-left' : ''}`, style: { left: `${leftPct}%` } },
      h('span', { className: 'tip-day' }, longDay(point.day)),
      h('span', { className: 'tip-row' }, h('i', { className: 'dot dot-msg' }), 'Messages', h('b', { className: 'tnum' }, fmt(point.messages))),
      h('span', { className: 'tip-row' }, h('i', { className: 'dot dot-img' }), 'Images', h('b', { className: 'tnum' }, fmt(point.images)))) : null,
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

function HealthCard({ data }: any) {
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

  return h(Card, { title: 'Bot health', desc: 'Gateway and process resources', className: 'block-health', right: status },
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

function WeekdayCard({ data }: any) {
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
    className: 'block-weekday',
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

function Leaderboard({ title, desc, rows, metric, other, empty }: any) {
  const top = ((rows || []) as Array<{ userId: string; name: string; messages: number; images: number; avatar?: string | null }>).slice(0, 5);
  const max = Math.max(1, ...top.map((r) => (r as any)[metric] || 0));
  return h(Card, { title, desc, className: 'block-board', flush: true },
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

function FeaturesCard({ data }: any) {
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
    title: 'Feature status', desc: `What ${BOT_NAME} is running here`, className: 'block-features', flush: true,
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

function Card({ title, desc, right, className, flush, children }: any) {
  return h('section', { className: `block card ${className || ''}` },
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

function SettingsDrawer({ cfg, setCfg, onClose }: any) {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closeBtnRef = useRef<HTMLButtonElement | null>(null);

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

  function toggle(id: string) {
    setCfg((c: OverviewConfig) => ({ ...c, widgets: c.widgets.map((w) => (w.id === id ? { ...w, on: !w.on } : w)) }));
  }
  function move(id: string, dir: -1 | 1) {
    setCfg((c: OverviewConfig) => {
      const arr = [...c.widgets];
      const i = arr.findIndex((w) => w.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return c;
      [arr[i], arr[j]] = [arr[j], arr[i]];
      return { ...c, widgets: arr };
    });
  }
  const defById = (id: string) => WIDGET_DEFS.find((w) => w.id === id)!;

  return h('div', { className: 'drawer-scrim', onClick: onClose },
    h('aside', { className: 'drawer', role: 'dialog', 'aria-modal': true, 'aria-label': 'Customize overview', onClick: (e: any) => e.stopPropagation() },
      h('div', { className: 'drawer-head' },
        h('div', null, h('h2', null, 'Customize'), h('p', { className: 'muted' }, 'Toggle, reorder, and recolor your overview.')),
        h('button', { className: 'icon-btn', title: 'Close', 'aria-label': 'Close', onClick: onClose, ref: closeBtnRef }, h(FiX))),

      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, 'Accent color'),
        h('div', { className: 'swatches' },
          ACCENT_PRESETS.map((p) => h('button', {
            key: p.hex, type: 'button', title: p.name, 'aria-label': p.name,
            className: `swatch ${cfg.accent.toLowerCase() === p.hex.toLowerCase() ? 'is-active' : ''}`,
            style: { background: p.hex },
            onClick: () => setCfg((c: OverviewConfig) => ({ ...c, accent: p.hex })),
          })),
          h('label', {
            className: `swatch swatch-custom ${ACCENT_PRESETS.some((p) => p.hex.toLowerCase() === cfg.accent.toLowerCase()) ? '' : 'is-active'}`,
            title: 'Custom color',
          },
            h('input', {
              type: 'color', value: cfg.accent, 'aria-label': 'Custom accent color',
              onChange: (e: any) => setCfg((c: OverviewConfig) => ({ ...c, accent: e.target.value })),
            }))),
        h('p', { className: 'faint tiny' }, 'Coral is the default. Pick anything, or keep the red.')),

      h('div', { className: 'drawer-section' },
        h('h3', { className: 'drawer-title' }, 'Widgets'),
        h('ul', { className: 'widget-list' }, cfg.widgets.map((w: WidgetPref, idx: number) =>
          h('li', { className: `widget-row ${w.on ? '' : 'is-off'}`, key: w.id },
            h('div', { className: 'wr-move' },
              h('button', { className: 'icon-btn tiny-btn', disabled: idx === 0, title: 'Move up', 'aria-label': 'Move up', onClick: () => move(w.id, -1) }, h(FiChevronUp)),
              h('button', { className: 'icon-btn tiny-btn', disabled: idx === cfg.widgets.length - 1, title: 'Move down', 'aria-label': 'Move down', onClick: () => move(w.id, 1) }, h(FiChevronDown))),
            h('div', { className: 'wr-text' },
              h('span', { className: 'wr-label' }, defById(w.id).label),
              h('span', { className: 'wr-hint faint' }, defById(w.id).hint)),
            h('button', {
              className: `toggle ${w.on ? 'on' : ''}`, title: w.on ? 'Hide' : 'Show',
              'aria-label': `${w.on ? 'Hide' : 'Show'} ${defById(w.id).label}`, 'aria-pressed': w.on,
              onClick: () => toggle(w.id),
            }, h(w.on ? FiEye : FiEyeOff))))),
      ),

      h('div', { className: 'drawer-foot' },
        h('button', { className: 'btn btn-quiet', onClick: () => setCfg(defaultConfig()) }, h(FiRotateCcw), 'Reset to defaults'),
        h('button', { className: 'btn btn-accent', onClick: onClose }, 'Done')),
    ),
  );
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
