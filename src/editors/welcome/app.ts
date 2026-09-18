import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FiArrowLeft,
  FiCheck,
  FiChevronDown,
  FiChevronUp,
  FiCopy,
  FiDroplet,
  FiEdit3,
  FiEye,
  FiEyeOff,
  FiImage,
  FiLayers,
  FiMaximize,
  FiMinus,
  FiPlus,
  FiRefreshCw,
  FiSquare,
  FiStar,
  FiTrash2,
  FiType,
  FiUploadCloud,
  FiUser,
  FiX,
  FiCommand,
  FiCornerUpLeft,
  FiCornerUpRight,
  FiLock,
  FiUnlock,
} from 'react-icons/fi';
import { API_BASE } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select, channelOptions, noneOption } from '../shared/select.js';

const h = React.createElement;

declare const __WELCOME_EDITOR_MAX_IMAGE_BYTES__: number;

const MAX_IMAGE_BYTES = typeof __WELCOME_EDITOR_MAX_IMAGE_BYTES__ === 'number' ? __WELCOME_EDITOR_MAX_IMAGE_BYTES__ : 10 * 1024 * 1024;

const W = 1200;
const H_CLASSIC = 620;
const H_COMPACT = 420;

const sample = { user: 'Stoaty', username: 'stoaty', display: 'Stoaty', mention: '@Stoaty', server: 'Your Server', count: '42' };
const placeholders = ['{mention}', '{user}', '{username}', '{display}', '{server}', '{count}'];
const systemFonts = ['Segoe UI', 'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Impact', 'Comic Sans MS'];
const defaultFonts = systemFonts.concat(['Inter', 'Roboto', 'Open Sans', 'Montserrat', 'Poppins', 'Lato', 'Oswald', 'Raleway', 'Bebas Neue', 'Lobster', 'Pacifico', 'Anton']);

const gradientPresets: Array<[string, string]> = [
  ['Coral rose', 'linear-gradient(135deg, #16181d, #fd6671)'],
  ['Dusk', 'linear-gradient(135deg, #202329, #8f7cff)'],
  ['Ember', 'linear-gradient(135deg, #16181d, #ff8a5c)'],
  ['Ocean', 'linear-gradient(135deg, #0f172a, #45c4ff)'],
  ['Midnight', 'linear-gradient(160deg, #111827, #1d4ed8)'],
  ['Slate', 'linear-gradient(180deg, #1f2937, #0b1220)'],
];

const shapes: Array<[string, string]> = [
  ['rect', 'Rectangle'],
  ['round', 'Rounded'],
  ['circle', 'Circle'],
  ['line', 'Line'],
];

const defaultConfig: any = {
  enabled: false,
  channelId: '',
  message: 'Welcome {mention} to **{server}**!',
  imageEnabled: true,
  background: 'linear-gradient(135deg, #16181d, #fd6671)',
  backgroundImageDataUri: '',
  textColor: '#f3f4f6',
  accentColor: '#fd6671',
  layout: 'classic',
  cardTemplate: 'modern',
  showAvatar: true,
  titleText: 'Welcome, {user}!',
  subtitleText: 'to {server}',
  footerText: 'Member #{count}',
  outputWidth: W,
  outputHeight: H_CLASSIC,
  textLayers: [],
  imageLayers: [],
  avatarLayer: null,
  customFonts: [],
  layerOrder: [],
};

// A fresh design starts April-style: member avatar centered up top with a
// welcome headline and subtitle beneath, all editable.
function starterConfig(): any {
  const avatar = makeAvatarLayer({ x: (W - 220) / 2, y: 70, size: 220 });
  const title = makeTextLayer({ text: 'Welcome, {user}!', x: W / 2, y: 360, fontSize: 68, fontWeight: 900, width: 900 });
  const subtitle = makeTextLayer({ text: 'to {server}', x: W / 2, y: 440, fontSize: 40, fontWeight: 700, color: '#fd6671', shadowEnabled: false });
  const footer = makeTextLayer({ text: 'Member #{count}', x: W / 2, y: 512, fontSize: 30, fontWeight: 600, color: '#e5e7eb', shadowEnabled: false });
  return {
    ...defaultConfig,
    avatarLayer: avatar,
    textLayers: [title, subtitle, footer],
    imageLayers: [],
    layerOrder: [
      { kind: 'avatar', id: avatar.id },
      { kind: 'text', id: title.id },
      { kind: 'text', id: subtitle.id },
      { kind: 'text', id: footer.id },
    ],
  };
}

// Older / "template-mode" configs (and the default live welcome) carry no
// layers — just titleText/subtitleText/footerText + a card template. Opening
// those in the layered editor used to show a blank canvas. Convert them to
// real, editable layers positioned to match the template so nothing is lost.
function ensureLayers(cfg: any): any {
  const hasLayers = (cfg?.textLayers?.length || 0) > 0 || (cfg?.imageLayers?.length || 0) > 0 || !!cfg?.avatarLayer;
  if (hasLayers) return cfg;

  const height = cfg?.layout === 'compact' ? H_COMPACT : H_CLASSIC;
  const showAvatar = cfg?.showAvatar !== false;
  const L = getTemplateLayout(cfg?.cardTemplate || 'modern', W, height, showAvatar);
  const textColor = cfg?.textColor || '#f3f4f6';
  const accent = cfg?.accentColor || '#fd6671';

  const layers: any[] = [];
  const order: any[] = [];
  let avatarLayer: any = null;
  if (showAvatar) {
    avatarLayer = makeAvatarLayer({ x: Math.round(L.avatarX), y: Math.round(L.avatarY), size: Math.round(L.avatarSize) || 200, ringColor: accent });
    order.push({ kind: 'avatar', id: AVATAR_ID });
  }
  const mkText = (text: string, baselineY: number, size: number, weight: number, color: string) => {
    const layer = makeTextLayer({
      text, x: Math.round(L.textX), y: Math.round(baselineY - size * 0.35),
      fontSize: size, fontWeight: weight, color, anchor: L.textAnchor === 'start' ? 'start' : 'middle', width: 980,
      shadowEnabled: false,
    });
    layers.push(layer);
    order.push({ kind: 'text', id: layer.id });
    return layer;
  };
  mkText(cfg?.titleText || 'Welcome, {user}!', L.titleY, L.titleSize, 900, textColor);
  mkText(cfg?.subtitleText || 'to {server}', L.subtitleY, L.subtitleSize, 700, accent);
  mkText(cfg?.footerText || 'Member #{count}', L.footerY, L.footerSize, 600, '#e5e7eb');

  return { ...cfg, avatarLayer, textLayers: layers, imageLayers: cfg?.imageLayers || [], layerOrder: order };
}

let layerSeq = 0;
function newId(prefix: string) {
  layerSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${layerSeq}`;
}

function makeTextLayer(overrides: any = {}) {
  return {
    id: newId('text'), enabled: true, text: 'New text', x: W / 2, y: 200, fontSize: 64, width: 480,
    fontFamily: 'Inter', color: '#ffffff', fontWeight: 800, fontStyle: 'normal', anchor: 'middle', rotation: 0,
    shadowEnabled: true, shadowColor: '#000000', shadowBlur: 10, shadowOffsetX: 0, shadowOffsetY: 3,
    highlightEnabled: false, highlightColor: '#fd6671', highlightOpacity: 0.35, highlightPadding: 10,
    outlineEnabled: false, outlineColor: '#000000', outlineWidth: 2,
    ...overrides,
  };
}
function makeImageLayer(overrides: any = {}) {
  return { id: newId('image'), enabled: true, imageDataUri: '', x: 440, y: 190, width: 320, height: 240, opacity: 1, rotation: 0, ...overrides };
}
const AVATAR_ID = 'avatar';
function makeAvatarLayer(overrides: any = {}) {
  return { id: AVATAR_ID, enabled: true, x: 100, y: 160, size: 220, shape: 'circle', ringEnabled: true, ringColor: '#fd6671', ringWidth: 12, rotation: 0, ...overrides };
}
// The member avatar shown in the editor is a stand-in; the bot swaps in the
// real join avatar at send time. Initials on an accent disc reads clearly.
function sampleAvatarDataUri(color: string) {
  const safe = String(color || '#fd6671').replace(/[<>"']/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240"><defs><linearGradient id="a" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${safe}"/><stop offset="100%" stop-color="#2a2f3a"/></linearGradient></defs><rect width="240" height="240" fill="url(#a)"/><text x="120" y="120" dy="0.35em" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="96" font-weight="800" fill="#ffffff">${getInitials(sample.display)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ============================================================
// Root
// ============================================================
function App() {
  const [view, setView] = useState<'home' | 'editor'>('home');
  const [config, setConfig] = useState<any>(defaultConfig);
  const [images, setImages] = useState<any[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [status, setStatus] = useState<{ tone: 'info' | 'ok' | 'error'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [designName, setDesignName] = useState('');
  const [selection, setSelection] = useState<{ kind: 'text' | 'image'; id: string } | null>(null);
  const [panel, setPanel] = useState<'inspect' | 'background' | 'layers'>('layers');
  const [fonts, setFonts] = useState<string[]>(defaultFonts);


  useEffect(() => {
    (async () => {
      try { setConfig({ ...defaultConfig, ...(await loadConfig()) }); } catch {}
      try { setFonts(mergeFonts(await loadFonts())); } catch {}
      await refreshImages();
    })();
  }, []);

  async function refreshImages() {
    setLoadingLibrary(true);
    try { setImages(await loadImages()); } catch { setImages([]); } finally { setLoadingLibrary(false); }
  }
  function flash(tone: 'info' | 'ok' | 'error', text: string) {
    setStatus({ tone, text });
    if (tone !== 'error') setTimeout(() => setStatus((s) => (s && s.text === text ? null : s)), 3800);
  }
  const setField = (key: string, value: any) => setConfig((c: any) => ({ ...c, [key]: value }));

  async function saveLiveConfig() {
    setSaving(true);
    try { const next = await saveConfig(config); if (next) setConfig({ ...defaultConfig, ...next }); flash('ok', 'Welcome saved — new members will see this.'); }
    catch (e: any) { flash('error', e?.message || 'Could not save.'); } finally { setSaving(false); }
  }
  async function saveDesign() {
    setSaving(true);
    try {
      if (editingId) { const u = await updateImage(editingId, { name: designName || undefined, config }); flash('ok', `Design "${u.name}" updated.`); }
      else { const c = await createImage(designName || `Welcome ${new Date().toLocaleDateString()}`, config); setEditingId(c.id); setDesignName(c.name); flash('ok', `Saved "${c.name}" to your library.`); }
      await refreshImages();
    } catch (e: any) { flash('error', e?.message || 'Could not save this design.'); } finally { setSaving(false); }
  }

  function openEditor(cfg: any, id: string | null, name: string) {
    setConfig(ensureLayers({ ...defaultConfig, ...cfg })); setEditingId(id); setDesignName(name); setSelection(null); setPanel('layers'); setView('editor');
  }
  const openNew = () => openEditor(starterConfig(), null, '');
  const openLive = () => openEditor(config, null, designName);
  const editDesign = (image: any) => openEditor(image.config, image.id, image.name || '');

  async function duplicateDesign(image: any) {
    try { const c = await createImage(`${image.name || 'Welcome'} copy`, { ...defaultConfig, ...image.config }); flash('ok', `Duplicated as "${c.name}".`); await refreshImages(); }
    catch (e: any) { flash('error', e?.message || 'Could not duplicate.'); }
  }
  async function deleteDesign(image: any) {
    try { await deleteImage(image.id); if (editingId === image.id) { setEditingId(null); setDesignName(''); } flash('info', `Deleted "${image.name}".`); await refreshImages(); }
    catch (e: any) { flash('error', e?.message || 'Could not delete.'); }
  }
  async function toggleRotation(image: any) {
    try { const u = await updateImage(image.id, { selected: !image.selected }); flash('info', u.selected ? `"${u.name}" added to rotation.` : `"${u.name}" removed.`); await refreshImages(); }
    catch (e: any) { flash('error', e?.message || 'Could not update rotation.'); }
  }
  async function activateDesign(image: any) {
    try { const d = await activateImage(image.id); if (d?.config) setConfig({ ...defaultConfig, ...d.config }); flash('ok', `"${image.name}" is now active.`); }
    catch (e: any) { flash('error', e?.message || 'Could not activate.'); }
  }

  return h('div', { className: 'app' },
    h(TopBar, { view, onBack: () => setView('home'), designName, setDesignName, editingId, saving, onSaveDesign: saveDesign, onSaveLive: saveLiveConfig }),
    status ? h('div', { className: `toast toast-${status.tone}` }, status.text) : null,
    view === 'home'
      ? h(HomeView, { images, loading: loadingLibrary, onNew: openNew, onEditLive: openLive, onEdit: editDesign, onDuplicate: duplicateDesign, onDelete: deleteDesign, onToggleRotation: toggleRotation, onActivate: activateDesign, onRefresh: refreshImages })
      : h(EditorView, { config, setConfig, setField, selection, setSelection, panel, setPanel, fonts, flash, onSaveDesign: saveDesign }),
  );
}

// ============================================================
// Top bar
// ============================================================
// Only the design editor needs a bar (back, name, save). The dashboard shell
// already carries the brand and the theme switch, so the library view has none.
function TopBar({ view, onBack, designName, setDesignName, editingId, saving, onSaveDesign, onSaveLive }: any) {
  if (view !== 'editor') return null;
  return h('header', { className: 'topbar' },
    h('div', { className: 'topbar-left' },
      h('button', { className: 'btn btn-ghost', onClick: onBack }, h(FiArrowLeft), 'Library'),
      h('input', { className: 'name-input', value: designName, placeholder: editingId ? 'Design name' : 'Untitled design', onChange: (e: any) => setDesignName(e.target.value) }),
    ),
    h('div', { className: 'topbar-right' },
      h('button', { className: 'btn btn-ghost', disabled: saving, onClick: onSaveDesign }, h(FiStar), editingId ? 'Update design' : 'Save design'),
      h('button', { className: 'btn btn-accent', disabled: saving, onClick: onSaveLive }, h(FiCheck), 'Save & apply'),
    ),
  );
}

// ============================================================
// Home / library
// ============================================================
function HomeView({ images, loading, onNew, onEditLive, onEdit, onDuplicate, onDelete, onToggleRotation, onActivate, onRefresh }: any) {
  const inRotation = images.filter((i: any) => i.selected).length;
  return h('main', { className: 'home' },
    h('section', { className: 'home-hero' },
      h('div', null, h('h1', null, 'Welcome images'), h('p', null, `Compose the image new members see when they join. ${inRotation > 0 ? `${inRotation} in the send rotation.` : 'Star designs to add them to the random send rotation.'}`)),
      h('div', { className: 'home-hero-actions' },
        h('button', { className: 'btn btn-ghost', onClick: onEditLive }, h(FiEdit3), 'Edit active welcome'),
        h('button', { className: 'btn btn-accent', onClick: onNew }, h(FiPlus), 'New design')),
    ),
    h('div', { className: 'home-toolbar' },
      h('span', { className: 'muted' }, loading ? 'Loading library…' : `${images.length} saved design${images.length === 1 ? '' : 's'}`),
      h('button', { className: 'btn btn-quiet', onClick: onRefresh }, h(FiRefreshCw), 'Refresh')),
    loading ? h('div', { className: 'empty' }, 'Loading…')
      : images.length === 0 ? h('div', { className: 'empty' }, h(FiImage, { size: 28 }), h('p', null, 'No saved designs yet.'), h('button', { className: 'btn btn-accent', onClick: onNew }, h(FiPlus), 'Create your first design'))
        : h('div', { className: 'card-grid' }, images.map((image: any) => h(DesignCard, { key: image.id, image, onEdit, onDuplicate, onDelete, onToggleRotation, onActivate }))),
  );
}
function DesignCard({ image, onEdit, onDuplicate, onDelete, onToggleRotation, onActivate }: any) {
  const cfg = { ...defaultConfig, ...image.config };
  return h('article', { className: `design-card ${image.selected ? 'is-selected' : ''}` },
    h('div', { className: 'design-thumb', onClick: () => onEdit(image), dangerouslySetInnerHTML: { __html: buildDesignSvg(cfg) } }),
    h('div', { className: 'design-meta' }, h('div', { className: 'design-title' }, image.name || 'Untitled'), image.selected ? h('span', { className: 'pill' }, 'In rotation') : null),
    h('div', { className: 'design-actions' },
      h('button', { className: 'icon-btn', title: 'Edit', onClick: () => onEdit(image) }, h(FiEdit3)),
      h('button', { className: 'icon-btn', title: 'Duplicate', onClick: () => onDuplicate(image) }, h(FiCopy)),
      h('button', { className: `icon-btn ${image.selected ? 'is-on' : ''}`, title: image.selected ? 'Remove from rotation' : 'Add to rotation', onClick: () => onToggleRotation(image) }, h(FiStar)),
      h('button', { className: 'icon-btn', title: 'Set as active', onClick: () => onActivate(image) }, h(FiCheck)),
      h('button', { className: 'icon-btn icon-danger', title: 'Delete', onClick: () => onDelete(image) }, h(FiTrash2)),
    ),
  );
}

// ============================================================
// Editor (Canva-style)
// ============================================================
function EditorView({ config, setConfig, setField, selection, setSelection, panel, setPanel, fonts, flash, onSaveDesign }: any) {
  const [zoom, setZoom] = useState(1);
  const [clipboard, setClipboard] = useState<{ kind: 'text' | 'image'; layer: any } | null>(null);
  const height = config.layout === 'compact' ? H_COMPACT : H_CLASSIC;

  // ---- Undo / redo ----
  // Snapshots of past configs; rapid edits (a drag) coalesce into one entry.
  const histRef = useRef<{ past: any[]; future: any[] }>({ past: [], future: [] });
  const lastConfigRef = useRef<any>(config);
  const skipHistoryRef = useRef(false);
  const lastEditAtRef = useRef(0);
  const [, setHistTick] = useState(0);

  useEffect(() => {
    if (skipHistoryRef.current) { skipHistoryRef.current = false; lastConfigRef.current = config; return; }
    const prev = lastConfigRef.current;
    if (prev === config) return;
    const now = Date.now();
    const hist = histRef.current;
    if (!(now - lastEditAtRef.current < 500 && hist.past.length)) {
      hist.past.push(prev);
      if (hist.past.length > 80) hist.past.shift();
      hist.future = [];
      setHistTick((t) => t + 1);
    }
    lastEditAtRef.current = now;
    lastConfigRef.current = config;
  }, [config]);

  const undo = useCallback(() => {
    const hist = histRef.current;
    if (!hist.past.length) return;
    const prev = hist.past.pop();
    hist.future.push(lastConfigRef.current);
    skipHistoryRef.current = true;
    lastConfigRef.current = prev;
    setConfig(prev);
    setHistTick((t) => t + 1);
  }, [setConfig]);

  const redo = useCallback(() => {
    const hist = histRef.current;
    if (!hist.future.length) return;
    const next = hist.future.pop();
    hist.past.push(lastConfigRef.current);
    skipHistoryRef.current = true;
    lastConfigRef.current = next;
    setConfig(next);
    setHistTick((t) => t + 1);
  }, [setConfig]);

  const canUndo = histRef.current.past.length > 0;
  const canRedo = histRef.current.future.length > 0;

  // ---- Multi-select ----
  // `selection` (from App) stays the primary/last-clicked layer that the
  // inspector targets. `multi` holds the full set when more than one layer is
  // selected; when it has 0/1 items we fall back to the single `selection`.
  const [multi, setMulti] = useState<Array<{ kind: LayerKind; id: string }>>([]);
  const selKeys = multi.length ? multi : (selection ? [selection] : []);
  const selectedIds = useMemo(() => new Set(selKeys.map((s: any) => s.id)), [multi, selection]);

  const selectSingle = useCallback((kind: LayerKind, id: string) => { setMulti([]); setSelection({ kind, id }); setPanel('inspect'); }, [setSelection, setPanel]);
  const toggleSelect = useCallback((kind: LayerKind, id: string) => {
    const cur = multi.length ? multi : (selection ? [selection] : []);
    const exists = cur.some((s: any) => s.id === id);
    const next = exists ? cur.filter((s: any) => s.id !== id) : [...cur, { kind, id }];
    if (next.length <= 1) { setMulti([]); setSelection(next[0] || null); } else { setMulti(next); setSelection({ kind, id }); }
    setPanel('inspect');
  }, [multi, selection, setSelection, setPanel]);
  const selectMany = useCallback((keys: Array<{ kind: LayerKind; id: string }>) => {
    if (keys.length <= 1) { setMulti([]); setSelection(keys[0] || null); } else { setMulti(keys); setSelection(keys[keys.length - 1]); setPanel('inspect'); }
  }, [setSelection, setPanel]);
  const clearSel = useCallback(() => { setMulti([]); setSelection(null); }, [setSelection]);

  const deleteSelected = useCallback(() => {
    const keys = multi.length ? multi : (selection ? [selection] : []);
    if (!keys.length) return;
    setConfig((c: any) => keys.reduce((acc: any, k: any) => removeLayer(acc, k.kind, k.id), c));
    clearSel();
  }, [multi, selection, setConfig, clearSel]);
  const alignSelected = useCallback((axis: 'h' | 'v') => {
    const keys = multi.length ? multi : (selection ? [selection] : []);
    setConfig((c: any) => keys.reduce((acc: any, k: any) => {
      const l = findLayer(acc, k); if (!l) return acc;
      if (axis === 'h') {
        const x = k.kind === 'text' ? Math.round(W / 2) : k.kind === 'avatar' ? Math.round((W - (l.size || 0)) / 2) : Math.round((W - (l.width || 0)) / 2);
        const patch: any = { x }; if (k.kind === 'text') patch.anchor = 'middle';
        return updateLayerIn(acc, k.kind, k.id, patch);
      }
      const y = k.kind === 'text' ? Math.round(height / 2) : k.kind === 'avatar' ? Math.round((height - (l.size || 0)) / 2) : Math.round((height - (l.height || 0)) / 2);
      return updateLayerIn(acc, k.kind, k.id, { y });
    }, c));
  }, [multi, selection, setConfig, height]);

  // Depend on the whole config: avatar edits only change config.avatarLayer,
  // which the previous narrower dependency list ignored — so dragging or
  // restyling the avatar never updated the canvas.
  const ordered = useMemo(() => getOrderedLayers(config), [config]);
  const selectedLayer = useMemo(() => (selection ? findLayer(config, selection) : null), [config, selection]);

  // Cloning helper used by duplicate + paste — offsets the copy and selects it.
  const cloneInto = useCallback((kind: 'text' | 'image', layer: any) => {
    const copy = { ...layer, id: newId(kind), x: Math.round((layer.x || 0) + 24), y: Math.round((layer.y || 0) + 24) };
    setConfig((c: any) => addLayer(c, kind, copy));
    setSelection({ kind, id: copy.id });
    setPanel('inspect');
  }, [setConfig, setSelection, setPanel]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;

      // Save works everywhere.
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); onSaveDesign?.(); return; }
      // Don't hijack keys while typing in a field.
      if (typing) return;

      if (e.key === 'Escape') { clearSel(); return; }

      if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); undo(); return; }
      if (mod && ((e.shiftKey && (e.key === 'z' || e.key === 'Z')) || e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }

      if (mod && (e.key === 'v' || e.key === 'V')) { if (clipboard) { e.preventDefault(); cloneInto(clipboard.kind, clipboard.layer); } return; }

      if (!selection) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        deleteSelected();
        return;
      }
      if (mod && (e.key === 'c' || e.key === 'C')) {
        const layer = findLayer(config, selection);
        if (layer) setClipboard({ kind: selection.kind, layer: { ...layer } });
        return;
      }
      if (mod && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault();
        const layer = findLayer(config, selection);
        if (layer) cloneInto(selection.kind, layer);
        return;
      }
      if (mod && (e.key === ']' || e.key === '[')) {
        e.preventDefault();
        setConfig((c: any) => reorderLayer(c, selection.id, e.key === ']' ? 1 : -1));
        return;
      }
      if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        const keys = multi.length ? multi : (selection ? [selection] : []);
        setConfig((c: any) => keys.reduce((acc: any, k: any) => {
          const l = findLayer(acc, k);
          if (!l) return acc;
          return updateLayerIn(acc, k.kind, k.id, { x: Math.round((l.x || 0) + dx), y: Math.round((l.y || 0) + dy) });
        }, c));
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, multi, clipboard, config, cloneInto, onSaveDesign, setConfig, setSelection, undo, redo, deleteSelected, clearSel]);

  function addTextLayer() {
    const layer = makeTextLayer({ y: height / 2 });
    setConfig((c: any) => addLayer(c, 'text', layer));
    setSelection({ kind: 'text', id: layer.id }); setPanel('inspect');
  }
  function addAvatar() {
    if (config.avatarLayer) { setSelection({ kind: 'avatar', id: AVATAR_ID }); setPanel('inspect'); return; }
    const layer = makeAvatarLayer({ x: Math.round((W - 220) / 2), y: Math.round((height - 220) / 2), ringColor: config.accentColor || '#fd6671' });
    setConfig((c: any) => addLayer(c, 'avatar', layer));
    setSelection({ kind: 'avatar', id: AVATAR_ID }); setPanel('inspect');
  }
  function addShapeLayer(type: string) {
    const uri = `data:image/svg+xml;utf8,${encodeURIComponent(shapeSvg(type, config.accentColor))}`;
    const dims = type === 'line' ? { width: 600, height: 40 } : type === 'circle' ? { width: 300, height: 300 } : { width: 400, height: 260 };
    const layer = makeImageLayer({ imageDataUri: uri, x: (W - dims.width) / 2, y: (height - dims.height) / 2, ...dims });
    setConfig((c: any) => addLayer(c, 'image', layer));
    setSelection({ kind: 'image', id: layer.id }); setPanel('inspect');
  }
  async function addImageLayer(file: File | null) {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) { flash('error', `Image too large (limit ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`); return; }
    try {
      const uri = await readFileAsDataUri(file);
      const size = await imageSize(uri).catch(() => ({ width: 320, height: 240 }));
      const scale = Math.min(1, 420 / Math.max(size.width, size.height));
      const width = Math.round(size.width * scale), imgH = Math.round(size.height * scale);
      const layer = makeImageLayer({ imageDataUri: uri, x: (W - width) / 2, y: (height - imgH) / 2, width, height: imgH });
      setConfig((c: any) => addLayer(c, 'image', layer));
      setSelection({ kind: 'image', id: layer.id }); setPanel('inspect');
    } catch { flash('error', 'Could not read that image.'); }
  }

  return h('main', { className: 'editor' },
    h(LeftRail, { onAddText: addTextLayer, onAddAvatar: addAvatar, onAddShape: addShapeLayer, onAddImage: addImageLayer, hasAvatar: !!config.avatarLayer, panel, setPanel }),
    h(CanvasStage, { config, setConfig, height, zoom, setZoom, ordered, selection, selectedIds, setSelection, setPanel, onSelectSingle: selectSingle, onToggleSelect: toggleSelect, onSelectMany: selectMany, onClear: clearSel, onUndo: undo, onRedo: redo, canUndo, canRedo }),
    h(RightPanel, { panel, setPanel, config, setConfig, setField, ordered, selection, selectedIds, setSelection, selectedLayer, fonts, flash, canvasHeight: height, multiCount: selKeys.length, onDeleteSelected: deleteSelected, onAlignSelected: alignSelected, onClearSel: clearSel, onSelectSingle: selectSingle, onToggleSelect: toggleSelect }),
  );
}

function LeftRail({ onAddText, onAddAvatar, onAddShape, onAddImage, hasAvatar, panel, setPanel }: any) {
  const [shapeOpen, setShapeOpen] = useState(false);
  return h('aside', { className: 'rail' },
    h('button', { className: 'rail-btn', title: 'Add text', onClick: onAddText }, h(FiType), h('span', null, 'Text')),
    h('button', { className: `rail-btn ${hasAvatar ? 'is-on' : ''}`, title: hasAvatar ? 'Select member avatar' : 'Add member avatar', onClick: onAddAvatar }, h(FiUser), h('span', null, 'Avatar')),
    h('div', { className: 'rail-group' },
      h('button', { className: 'rail-btn', title: 'Shapes', onClick: () => setShapeOpen((v) => !v) }, h(FiSquare), h('span', null, 'Shapes')),
      shapeOpen ? h('div', { className: 'rail-pop' }, shapes.map(([id, label]) => h('button', { key: id, className: 'rail-pop-item', onClick: () => { onAddShape(id); setShapeOpen(false); } }, label))) : null,
    ),
    h('label', { className: 'rail-btn', title: 'Upload image' }, h(FiUploadCloud), h('span', null, 'Upload'),
      h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', onChange: (e: any) => onAddImage(e.target.files?.[0] || null) })),
    h('button', { className: `rail-btn ${panel === 'background' ? 'is-active' : ''}`, title: 'Background', onClick: () => setPanel('background') }, h(FiDroplet), h('span', null, 'Background')),
    h('button', { className: `rail-btn ${panel === 'layers' ? 'is-active' : ''}`, title: 'Layers', onClick: () => setPanel('layers') }, h(FiLayers), h('span', null, 'Layers')),
  );
}

// ============================================================
// Canvas stage
// ============================================================
const shortcutList: Array<[string, string]> = [
  ['Delete / Backspace', 'Delete layer'],
  ['Arrows', 'Nudge 1px (Shift = 10px)'],
  ['Ctrl/⌘ + Z', 'Undo'],
  ['Ctrl/⌘ + Shift + Z', 'Redo'],
  ['Ctrl/⌘ + D', 'Duplicate'],
  ['Ctrl/⌘ + C / V', 'Copy / paste'],
  ['Ctrl/⌘ + ] / [', 'Forward / back'],
  ['Ctrl/⌘ + S', 'Save design'],
  ['Esc', 'Deselect'],
];

function CanvasStage({ config, setConfig, height, zoom, setZoom, ordered, selection, selectedIds, setSelection, setPanel, onSelectSingle, onToggleSelect, onSelectMany, onClear, onUndo, onRedo, canUndo, canRedo }: any) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(0.5);
  const [showHelp, setShowHelp] = useState(false);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const groupRef = useRef<Record<string, { kind: LayerKind; x: number; y: number }> | null>(null);
  const marqueeRef = useRef<{ startX: number; startY: number; moved: boolean } | null>(null);

  useLayoutEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const measure = () => {
      const pad = 56;
      const s = Math.min((el.clientWidth - pad) / W, (el.clientHeight - pad) / height);
      setFit(Math.max(0.1, s || 0.5));
    };
    measure();
    const ro = new ResizeObserver(measure); ro.observe(el); return () => ro.disconnect();
  }, [height]);

  const scale = fit * zoom;
  const multiActive = selectedIds && selectedIds.size > 1;

  const updateLayer = useCallback((kind: 'text' | 'image', id: string, patch: any) => {
    setConfig((c: any) => updateLayerIn(c, kind, id, patch));
  }, [setConfig]);

  // Group drag: snapshot every selected layer's start position, then translate
  // all of them by the same delta.
  function selectedKeysNow() { return ordered.filter((o: any) => selectedIds?.has(o.layer.id)).map((o: any) => ({ kind: o.kind, id: o.layer.id })); }
  function beginGroupDrag() {
    const map: Record<string, any> = {};
    for (const k of selectedKeysNow()) { const l = findLayer(config, k); if (l) map[k.id] = { kind: k.kind, x: l.x, y: l.y }; }
    groupRef.current = map;
  }
  function groupMoveBy(dx: number, dy: number) {
    const map = groupRef.current; if (!map) return;
    setConfig((c: any) => { let n = c; for (const id in map) { const s = map[id]; n = updateLayerIn(n, s.kind, id, { x: Math.round(s.x + dx), y: Math.round(s.y + dy) }); } return n; });
  }
  function endGroupDrag() { groupRef.current = null; }

  // Marquee selection on the empty artboard.
  function pointFromEvent(e: any) {
    const board = wrapRef.current?.querySelector('.artboard'); if (!board) return null;
    const r = (board as HTMLElement).getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  }
  function onWrapDown(e: any) {
    const isEmpty = e.target === e.currentTarget || (e.target as HTMLElement).classList.contains('artboard');
    if (!isEmpty) return;
    const p = pointFromEvent(e);
    if (!p) { onClear && onClear(); return; }
    marqueeRef.current = { startX: p.x, startY: p.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onWrapMove(e: any) {
    const m = marqueeRef.current; if (!m) return;
    const p = pointFromEvent(e); if (!p) return;
    const x = Math.min(m.startX, p.x), y = Math.min(m.startY, p.y);
    const w = Math.abs(p.x - m.startX), hh = Math.abs(p.y - m.startY);
    if (w > 4 || hh > 4) m.moved = true;
    setMarquee({ x, y, w, h: hh });
  }
  function onWrapUp(e: any) {
    const m = marqueeRef.current; marqueeRef.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    const rect = marquee; setMarquee(null);
    if (!m) return;
    if (!m.moved || !rect) { onClear && onClear(); return; }
    const hits = ordered.filter((o: any) => o.layer.enabled && layerIntersects(o, rect)).map((o: any) => ({ kind: o.kind, id: o.layer.id }));
    onSelectMany && onSelectMany(hits);
  }

  const bg = getBackgroundCss(config);

  return h('section', { className: 'stage' },
    h('div', { className: 'stage-wrap', ref: wrapRef, onPointerDown: onWrapDown, onPointerMove: onWrapMove, onPointerUp: onWrapUp },
      h('div', { className: 'artboard', style: { width: W * scale, height: height * scale, background: bg } },
        ordered.filter((o: any) => o.layer.enabled).map((o: any) =>
          h(LayerNode, {
            key: o.layer.id, kind: o.kind, layer: o.layer, scale,
            canvasW: W, canvasH: height, onGuides: setGuides,
            selected: selectedIds ? selectedIds.has(o.layer.id) : selection?.id === o.layer.id,
            groupActive: !!(multiActive && selectedIds?.has(o.layer.id)),
            onSelect: () => { onSelectSingle ? onSelectSingle(o.kind, o.layer.id) : setSelection({ kind: o.kind, id: o.layer.id }); },
            onShiftSelect: () => onToggleSelect && onToggleSelect(o.kind, o.layer.id),
            onGroupBegin: beginGroupDrag, onGroupMove: groupMoveBy, onGroupEnd: endGroupDrag,
            onChange: (patch: any) => updateLayer(o.kind, o.layer.id, patch),
          })),
        guides.x.map((gx: number, i: number) => h('span', { key: `gx${i}`, className: 'snap-guide snap-guide-v', style: { left: gx * scale } })),
        guides.y.map((gy: number, i: number) => h('span', { key: `gy${i}`, className: 'snap-guide snap-guide-h', style: { top: gy * scale } })),
        marquee ? h('span', { className: 'marquee', style: { left: marquee.x * scale, top: marquee.y * scale, width: marquee.w * scale, height: marquee.h * scale } }) : null,
      ),
    ),
    h('div', { className: 'stage-bar' },
      h('button', { className: 'icon-btn', title: 'Undo (Ctrl+Z)', disabled: !canUndo, onClick: onUndo }, h(FiCornerUpLeft)),
      h('button', { className: 'icon-btn', title: 'Redo (Ctrl+Shift+Z)', disabled: !canRedo, onClick: onRedo }, h(FiCornerUpRight)),
      h('span', { className: 'stage-bar-sep' }),
      h('button', { className: 'icon-btn', title: 'Zoom out', onClick: () => setZoom((z: number) => clamp(Number((z - 0.1).toFixed(2)), 0.2, 3)) }, h(FiMinus)),
      h('span', { className: 'zoom-val' }, `${Math.round(scale * 100)}%`),
      h('button', { className: 'icon-btn', title: 'Zoom in', onClick: () => setZoom((z: number) => clamp(Number((z + 0.1).toFixed(2)), 0.2, 3)) }, h(FiPlus)),
      h('button', { className: 'icon-btn', title: 'Fit', onClick: () => setZoom(1) }, h(FiMaximize)),
      h('span', { className: 'stage-bar-sep' }),
      h('div', { className: 'help-wrap' },
        h('button', { className: `icon-btn ${showHelp ? 'is-on' : ''}`, title: 'Keyboard shortcuts', onClick: () => setShowHelp((v) => !v) }, h(FiCommand)),
        showHelp ? h('div', { className: 'help-pop' },
          h('div', { className: 'help-title' }, 'Shortcuts'),
          shortcutList.map(([k, v]) => h('div', { key: k, className: 'help-row' }, h('kbd', null, k), h('span', null, v))),
        ) : null,
      ),
    ),
  );
}

function LayerNode({ kind, layer, scale, selected, onSelect, onShiftSelect, onChange, canvasW, canvasH, onGuides, groupActive, onGroupBegin, onGroupMove, onGroupEnd }: any) {
  const drag = useRef<any>(null);

  function onPointerDown(e: any, mode: string, handle?: string) {
    e.stopPropagation();
    // Shift-click toggles this layer in the multi-selection (no drag).
    if (mode === 'move' && e.shiftKey) { onShiftSelect && onShiftSelect(); return; }
    if (!selected) onSelect();
    if (layer.locked) return; // locked layers select but don't move or resize
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    if (mode === 'move' && groupActive) {
      // Dragging any layer in a multi-selection moves the whole group.
      onGroupBegin && onGroupBegin();
      drag.current = { mode: 'group', startX: e.clientX, startY: e.clientY };
    } else {
      drag.current = { mode, handle, startX: e.clientX, startY: e.clientY, layer: { ...layer } };
    }
  }
  function onPointerMove(e: any) {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.startX) / scale;
    const dy = (e.clientY - d.startY) / scale;
    if (d.mode === 'group') { onGroupMove && onGroupMove(dx, dy); return; }
    if (d.mode === 'move') {
      const s = computeSnap(kind, d.layer, snap(d.layer.x + dx), snap(d.layer.y + dy), canvasW || W, canvasH || H_CLASSIC);
      onGuides && onGuides({ x: s.gx, y: s.gy });
      onChange({ x: s.x, y: s.y });
    } else if (d.mode === 'resize' && kind === 'image') {
      let { x, y, width, height } = d.layer;
      if (d.handle.includes('e')) width = Math.max(16, d.layer.width + dx);
      if (d.handle.includes('s')) height = Math.max(16, d.layer.height + dy);
      if (d.handle.includes('w')) { width = Math.max(16, d.layer.width - dx); x = d.layer.x + dx; }
      if (d.handle.includes('n')) { height = Math.max(16, d.layer.height - dy); y = d.layer.y + dy; }
      onChange({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    } else if (d.mode === 'resize' && kind === 'avatar') {
      // Keep the avatar square; grow from the dragged corner.
      const delta = d.handle.includes('e') || d.handle.includes('s') ? Math.max(dx, dy) : Math.max(-dx, -dy);
      const size = Math.max(32, Math.round(d.layer.size + delta));
      const x = d.handle.includes('w') ? d.layer.x + (d.layer.size - size) : d.layer.x;
      const y = d.handle.includes('n') ? d.layer.y + (d.layer.size - size) : d.layer.y;
      onChange({ x: Math.round(x), y: Math.round(y), size });
    }
  }
  function onPointerUp(e: any) { if (drag.current?.mode === 'group') onGroupEnd && onGroupEnd(); drag.current = null; onGuides && onGuides({ x: [], y: [] }); (e.target as HTMLElement).releasePointerCapture?.(e.pointerId); }

  const common = { onPointerDown: (e: any) => onPointerDown(e, 'move'), onPointerMove, onPointerUp };

  if (kind === 'text') {
    const anchorShift = layer.anchor === 'start' ? '0' : layer.anchor === 'end' ? '-100%' : '-50%';
    const style: any = {
      position: 'absolute', left: layer.x * scale, top: layer.y * scale,
      transform: `translate(${anchorShift}, -50%) rotate(${layer.rotation || 0}deg)`,
      fontSize: (layer.fontSize || 48) * scale, fontFamily: `'${layer.fontFamily}', 'Segoe UI', Arial, sans-serif`,
      color: layer.color, fontWeight: layer.fontWeight, fontStyle: layer.fontStyle, whiteSpace: 'nowrap', lineHeight: 1.15,
      textShadow: layer.shadowEnabled ? `${(layer.shadowOffsetX || 0) * scale}px ${(layer.shadowOffsetY || 0) * scale}px ${(layer.shadowBlur || 0) * scale}px ${hexToRgba(layer.shadowColor, 0.85)}` : 'none',
      WebkitTextStroke: layer.outlineEnabled && layer.outlineWidth > 0 ? `${layer.outlineWidth * scale}px ${layer.outlineColor}` : undefined,
      background: layer.highlightEnabled ? hexToRgba(layer.highlightColor, layer.highlightOpacity) : undefined,
      padding: layer.highlightEnabled ? (layer.highlightPadding || 0) * scale : undefined,
      borderRadius: layer.highlightEnabled ? 10 * scale : undefined,
    };
    return h('div', { className: `layer text-layer ${selected ? 'is-selected' : ''}`, style, ...common }, renderPlain(layer.text) || 'Text');
  }

  if (kind === 'avatar') {
    const radius = layer.shape === 'circle' ? '50%' : layer.shape === 'rounded' ? `${Math.min(60, layer.size * 0.18) * scale}px` : '0';
    const ring = layer.ringEnabled && layer.ringWidth > 0 ? `0 0 0 ${layer.ringWidth * scale}px ${layer.ringColor}` : 'none';
    const style: any = {
      position: 'absolute', left: layer.x * scale, top: layer.y * scale, width: layer.size * scale, height: layer.size * scale,
      transform: `rotate(${layer.rotation || 0}deg)`, borderRadius: radius, boxShadow: ring,
    };
    return h('div', { className: `layer avatar-layer ${selected ? 'is-selected' : ''}`, style, ...common },
      h('img', { src: sampleAvatarDataUri(layer.ringColor), draggable: false, alt: '', style: { borderRadius: radius } }),
      (selected && !groupActive) ? ['nw', 'ne', 'sw', 'se'].map((hd) => h('span', { key: hd, className: `handle handle-${hd}`, onPointerDown: (e: any) => onPointerDown(e, 'resize', hd), onPointerMove, onPointerUp })) : null,
    );
  }

  const style: any = {
    position: 'absolute', left: layer.x * scale, top: layer.y * scale, width: layer.width * scale, height: layer.height * scale,
    transform: `rotate(${layer.rotation || 0}deg)`, opacity: layer.opacity,
  };
  return h('div', { className: `layer image-layer ${selected ? 'is-selected' : ''}`, style, ...common },
    h('img', { src: layer.imageDataUri, draggable: false, alt: '' }),
    (selected && !groupActive) ? ['nw', 'ne', 'sw', 'se'].map((hd) => h('span', { key: hd, className: `handle handle-${hd}`, onPointerDown: (e: any) => onPointerDown(e, 'resize', hd), onPointerMove, onPointerUp })) : null,
  );
}

// ============================================================
// Right panel: inspector / background / layers
// ============================================================
function RightPanel({ panel, setPanel, config, setConfig, setField, ordered, selection, selectedIds, setSelection, selectedLayer, fonts, flash, canvasHeight, multiCount, onDeleteSelected, onAlignSelected, onClearSel, onSelectSingle, onToggleSelect }: any) {
  return h('aside', { className: 'inspector' },
    panel === 'background' ? h(BackgroundPanel, { config, setConfig, setField, flash })
      : multiCount > 1 && panel === 'inspect'
        ? h(MultiSelectPanel, { count: multiCount, onAlign: onAlignSelected, onDelete: onDeleteSelected, onClear: onClearSel })
        : panel === 'inspect' && selectedLayer
          ? h(LayerInspector, { kind: selection.kind, layer: selectedLayer, fonts, canvasHeight, onChange: (patch: any) => setConfig((c: any) => updateLayerIn(c, selection.kind, selection.id, patch)) })
          : h(LayersPanel, { config, setConfig, ordered, selection, selectedIds, setSelection, setPanel, onSelectSingle, onToggleSelect }),
  );
}

function MultiSelectPanel({ count, onAlign, onDelete, onClear }: any) {
  return h('div', { className: 'panel' },
    h('div', { className: 'panel-head' }, h('h2', null, `${count} layers selected`)),
    h('div', { className: 'panel-body' },
      h('p', { className: 'hint' }, 'Drag any selected layer to move them together, or nudge with the arrow keys. Shift-click a layer to add or remove it.'),
      h('div', { className: 'align-row' },
        h('button', { className: 'btn btn-quiet', title: 'Center each horizontally', onClick: () => onAlign('h') }, 'Center H'),
        h('button', { className: 'btn btn-quiet', title: 'Center each vertically', onClick: () => onAlign('v') }, 'Center V'),
      ),
      h('button', { className: 'btn btn-danger btn-block', onClick: onDelete }, h(FiTrash2), 'Delete selected'),
      h('button', { className: 'btn btn-quiet btn-block', onClick: onClear }, 'Clear selection'),
    ),
  );
}

function LayersPanel({ config, setConfig, ordered, selection, selectedIds, setSelection, setPanel, onSelectSingle, onToggleSelect }: any) {
  const top = [...ordered].reverse();
  return h('div', { className: 'panel' },
    h('div', { className: 'panel-head' }, h('h2', null, 'Layers'), h('span', { className: 'muted' }, `${ordered.length}`)),
    ordered.length === 0 ? h('p', { className: 'hint' }, 'Add text, shapes, or images from the left rail.') : null,
    h('div', { className: 'layer-list' }, top.map((o: any, idx: number) => {
      const realIndex = ordered.length - 1 - idx;
      const rowSelected = selectedIds ? selectedIds.has(o.layer.id) : selection?.id === o.layer.id;
      return h('div', { key: o.layer.id, className: `layer-row ${rowSelected ? 'is-selected' : ''}`, onClick: (e: any) => { if (e.shiftKey && onToggleSelect) onToggleSelect(o.kind, o.layer.id); else if (onSelectSingle) onSelectSingle(o.kind, o.layer.id); else { setSelection({ kind: o.kind, id: o.layer.id }); setPanel && setPanel('inspect'); } } },
        h('span', { className: 'layer-kind' }, o.kind === 'text' ? h(FiType) : o.kind === 'avatar' ? h(FiUser) : h(FiImage)),
        h('span', { className: 'layer-name' }, o.kind === 'text' ? (renderPlain(o.layer.text) || 'Text').slice(0, 24) : o.kind === 'avatar' ? 'Member avatar' : 'Image'),
        h('button', { className: 'icon-btn sm', title: o.layer.enabled ? 'Hide' : 'Show', onClick: (e: any) => { e.stopPropagation(); setConfig((c: any) => updateLayerIn(c, o.kind, o.layer.id, { enabled: !o.layer.enabled })); } }, o.layer.enabled ? h(FiEye) : h(FiEyeOff)),
        h('button', { className: 'icon-btn sm', title: 'Bring forward', disabled: realIndex >= ordered.length - 1, onClick: (e: any) => { e.stopPropagation(); setConfig((c: any) => reorderLayer(c, o.layer.id, 1)); } }, h(FiChevronUp)),
        h('button', { className: 'icon-btn sm', title: 'Send back', disabled: realIndex <= 0, onClick: (e: any) => { e.stopPropagation(); setConfig((c: any) => reorderLayer(c, o.layer.id, -1)); } }, h(FiChevronDown)),
        o.kind === 'avatar' ? null : h('button', { className: 'icon-btn sm', title: 'Duplicate', onClick: (e: any) => { e.stopPropagation(); setConfig((c: any) => duplicateLayer(c, o.kind, o.layer.id)); } }, h(FiCopy)),
        h('button', { className: `icon-btn sm ${o.layer.locked ? 'is-on' : ''}`, title: o.layer.locked ? 'Unlock' : 'Lock', onClick: (e: any) => { e.stopPropagation(); setConfig((c: any) => updateLayerIn(c, o.kind, o.layer.id, { locked: !o.layer.locked })); } }, h(o.layer.locked ? FiLock : FiUnlock)),
        h('button', { className: 'icon-btn sm icon-danger', title: 'Delete', onClick: (e: any) => { e.stopPropagation(); setConfig((c: any) => removeLayer(c, o.kind, o.layer.id)); if (selection?.id === o.layer.id) setSelection(null); } }, h(FiTrash2)),
      );
    })),
  );
}

function LayerInspector({ kind, layer, fonts, onChange, canvasHeight }: any) {
  useEffect(() => { if (kind === 'text') loadGoogleFont(layer.fontFamily); }, [kind, layer.fontFamily]);
  const ch = canvasHeight || H_CLASSIC;
  function alignH() {
    if (kind === 'text') onChange({ x: Math.round(W / 2), anchor: 'middle' });
    else if (kind === 'avatar') onChange({ x: Math.round((W - (layer.size || 0)) / 2) });
    else onChange({ x: Math.round((W - (layer.width || 0)) / 2) });
  }
  function alignV() {
    if (kind === 'text') onChange({ y: Math.round(ch / 2) });
    else if (kind === 'avatar') onChange({ y: Math.round((ch - (layer.size || 0)) / 2) });
    else onChange({ y: Math.round((ch - (layer.height || 0)) / 2) });
  }
  return h('div', { className: 'panel' },
    h('div', { className: 'panel-head' }, h('h2', null, kind === 'text' ? 'Text layer' : kind === 'avatar' ? 'Member avatar' : 'Image layer')),
    h('div', { className: 'panel-body' },
      h('div', { className: 'align-row' },
        h('button', { className: 'btn btn-quiet', title: 'Center on canvas horizontally', onClick: alignH }, 'Center H'),
        h('button', { className: 'btn btn-quiet', title: 'Center on canvas vertically', onClick: alignV }, 'Center V'),
        h('button', { className: `btn btn-quiet ${layer.locked ? 'is-on' : ''}`, title: layer.locked ? 'Unlock layer' : 'Lock position', onClick: () => onChange({ locked: !layer.locked }) }, h(layer.locked ? FiLock : FiUnlock), layer.locked ? 'Locked' : 'Lock'),
      ),
      kind === 'avatar' ? h(React.Fragment, null,
        h('p', { className: 'hint' }, 'The real member avatar replaces this at send time.'),
        h(NumberField, { label: 'Size', value: layer.size, min: 32, max: 800, onChange: (v: number) => onChange({ size: v }) }),
        h(Segmented, { label: 'Shape', value: layer.shape, options: [['circle', 'Circle'], ['rounded', 'Rounded'], ['square', 'Square']], onChange: (v: string) => onChange({ shape: v }) }),
        h('div', { className: 'field-row' },
          h(NumberField, { label: 'X', value: layer.x, min: -2400, max: 2400, onChange: (v: number) => onChange({ x: v }) }),
          h(NumberField, { label: 'Y', value: layer.y, min: -2400, max: 2400, onChange: (v: number) => onChange({ y: v }) }),
        ),
        h(Toggle, { label: 'Ring', checked: layer.ringEnabled, onChange: (v: boolean) => onChange({ ringEnabled: v }) }),
        layer.ringEnabled ? h('div', { className: 'field-row' },
          h(ColorField, { label: 'Ring color', value: layer.ringColor, onChange: (v: string) => onChange({ ringColor: v }) }),
          h(NumberField, { label: 'Ring width', value: layer.ringWidth, min: 0, max: 60, onChange: (v: number) => onChange({ ringWidth: v }) }),
        ) : null,
        h(RangeField, { label: `Rotation · ${layer.rotation || 0}°`, min: -180, max: 180, value: layer.rotation || 0, onChange: (v: number) => onChange({ rotation: v }) }),
      ) : kind === 'text' ? h(React.Fragment, null,
        h(TextArea, { label: 'Text', value: layer.text, onChange: (v: string) => onChange({ text: v }) }),
        h(PlaceholderRow, { onInsert: (t: string) => onChange({ text: `${layer.text || ''}${layer.text && !/\s$/.test(layer.text) ? ' ' : ''}${t}` }) }),
        h(SelectField, { label: 'Font', value: layer.fontFamily, options: fonts, fontPreview: true, onChange: (v: string) => onChange({ fontFamily: v }) }),
        h('div', { className: 'field-row' },
          h(NumberField, { label: 'Size', value: layer.fontSize, min: 8, max: 200, onChange: (v: number) => onChange({ fontSize: v }) }),
          h(NumberField, { label: 'Weight', value: layer.fontWeight, min: 100, max: 900, step: 100, onChange: (v: number) => onChange({ fontWeight: v }) }),
        ),
        h(Segmented, { label: 'Align', value: layer.anchor, options: [['start', 'Left'], ['middle', 'Center'], ['end', 'Right']], onChange: (v: string) => onChange({ anchor: v }) }),
        h('div', { className: 'field-row' },
          h(ColorField, { label: 'Color', value: layer.color, onChange: (v: string) => onChange({ color: v }) }),
          h(Toggle, { label: 'Italic', checked: layer.fontStyle === 'italic', onChange: (v: boolean) => onChange({ fontStyle: v ? 'italic' : 'normal' }) }),
        ),
        h(RangeField, { label: `Rotation · ${layer.rotation || 0}°`, min: -180, max: 180, value: layer.rotation || 0, onChange: (v: number) => onChange({ rotation: v }) }),
        h(Toggle, { label: 'Shadow', checked: layer.shadowEnabled, onChange: (v: boolean) => onChange({ shadowEnabled: v }) }),
        h(Toggle, { label: 'Outline', checked: layer.outlineEnabled, onChange: (v: boolean) => onChange({ outlineEnabled: v }) }),
        layer.outlineEnabled ? h('div', { className: 'field-row' }, h(ColorField, { label: 'Outline color', value: layer.outlineColor, onChange: (v: string) => onChange({ outlineColor: v }) }), h(NumberField, { label: 'Width', value: layer.outlineWidth, min: 0, max: 24, onChange: (v: number) => onChange({ outlineWidth: v }) })) : null,
        h(Toggle, { label: 'Highlight', checked: layer.highlightEnabled, onChange: (v: boolean) => onChange({ highlightEnabled: v }) }),
        layer.highlightEnabled ? h(ColorField, { label: 'Highlight color', value: layer.highlightColor, onChange: (v: string) => onChange({ highlightColor: v }) }) : null,
      ) : h(React.Fragment, null,
        h('div', { className: 'field-row' },
          h(NumberField, { label: 'Width', value: layer.width, min: 16, max: 2400, onChange: (v: number) => onChange({ width: v }) }),
          h(NumberField, { label: 'Height', value: layer.height, min: 16, max: 2400, onChange: (v: number) => onChange({ height: v }) }),
        ),
        h('div', { className: 'field-row' },
          h(NumberField, { label: 'X', value: layer.x, min: -2400, max: 2400, onChange: (v: number) => onChange({ x: v }) }),
          h(NumberField, { label: 'Y', value: layer.y, min: -2400, max: 2400, onChange: (v: number) => onChange({ y: v }) }),
        ),
        h(RangeField, { label: `Opacity · ${Math.round((layer.opacity ?? 1) * 100)}%`, min: 0, max: 100, value: Math.round((layer.opacity ?? 1) * 100), onChange: (v: number) => onChange({ opacity: v / 100 }) }),
        h(RangeField, { label: `Rotation · ${layer.rotation || 0}°`, min: -180, max: 180, value: layer.rotation || 0, onChange: (v: number) => onChange({ rotation: v }) }),
      ),
    ),
  );
}

function BackgroundPanel({ config, setConfig, setField, flash }: any) {
  // The selected tab is real UI state, not derived from the config — otherwise
  // an empty "Image URL" or a not-yet-chosen "Upload" would fall back to the
  // gradient tab, making those two tabs impossible to open.
  const [mode, setModeState] = useState<string>(() => getBackgroundMode(config));
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    fetch(`${API_BASE}/api/config`).then((r) => r.json()).then((d) => { if (d.ok) setChannels(d.channels || []); }).catch(() => {});
  }, []);
  const gradient = parseGradient(config.background) || { angle: 135, from: '#16181d', to: '#fd6671' };
  function setMode(next: string) {
    setModeState(next);
    if (next === 'solid') setConfig((c: any) => ({ ...c, background: toHex(c.background, '#16181d'), backgroundImageDataUri: '' }));
    else if (next === 'gradient') setConfig((c: any) => ({ ...c, background: buildGradient(gradient.angle, gradient.from, gradient.to), backgroundImageDataUri: '' }));
    else if (next === 'url') setConfig((c: any) => ({ ...c, background: /^https?:/i.test(c.background || '') ? c.background : '', backgroundImageDataUri: '' }));
    // 'upload' keeps the current background until an image is actually chosen.
  }
  async function onUpload(file: File | null) {
    if (!file) return;
    if (file.size > MAX_IMAGE_BYTES) { flash('error', `Image too large (limit ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB).`); return; }
    try { setField('backgroundImageDataUri', await readFileAsDataUri(file)); flash('ok', 'Background image set.'); } catch { flash('error', 'Could not read that image.'); }
  }
  return h('div', { className: 'panel' },
    h('div', { className: 'panel-head' }, h('h2', null, 'Background')),
    h('div', { className: 'panel-body' },
      h(Segmented, { label: 'Type', value: mode, options: [['solid', 'Solid'], ['gradient', 'Gradient'], ['url', 'Image URL'], ['upload', 'Upload']], onChange: setMode }),
      mode === 'solid' ? h(ColorField, { label: 'Color', value: toHex(config.background, '#16181d'), onChange: (v: string) => setField('background', v) }) : null,
      mode === 'gradient' ? h(React.Fragment, null,
        h('div', { className: 'field-row' },
          h(ColorField, { label: 'From', value: gradient.from, onChange: (v: string) => setField('background', buildGradient(gradient.angle, v, gradient.to)) }),
          h(ColorField, { label: 'To', value: gradient.to, onChange: (v: string) => setField('background', buildGradient(gradient.angle, gradient.from, v)) }),
        ),
        h(RangeField, { label: `Angle · ${gradient.angle}°`, min: 0, max: 360, value: gradient.angle, onChange: (v: number) => setField('background', buildGradient(v, gradient.from, gradient.to)) }),
        h('div', { className: 'swatch-row' }, gradientPresets.map(([name, value]) => h('button', { key: name, className: 'swatch', title: name, style: { background: value }, onClick: () => setField('background', value) }))),
      ) : null,
      mode === 'url' ? h(TextField, { label: 'Image URL', value: config.background || '', placeholder: 'https://…/image.png', onChange: (v: string) => setField('background', v) }) : null,
      mode === 'upload' ? h(React.Fragment, null,
        h('label', { className: 'upload' }, h(FiUploadCloud), h('span', null, config.backgroundImageDataUri ? 'Replace image' : 'Choose image'), h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', onChange: (e: any) => onUpload(e.target.files?.[0] || null) })),
        config.backgroundImageDataUri ? h('button', { className: 'btn btn-quiet', onClick: () => setField('backgroundImageDataUri', '') }, h(FiX), 'Remove image') : null,
      ) : null,
      h('div', { className: 'divider' }),
      h(Toggle, { label: 'Compact height', checked: config.layout === 'compact', onChange: (v: boolean) => setField('layout', v ? 'compact' : 'classic') }),
      h(ChannelField, { label: 'Welcome channel', value: config.channelId || '', channels, onChange: (v: string) => setField('channelId', v) }),
      h(Toggle, { label: 'Welcome enabled', checked: !!config.enabled, onChange: (v: boolean) => setField('enabled', v) }),
      h(Toggle, { label: 'Attach image to message', checked: !!config.imageEnabled, onChange: (v: boolean) => setField('imageEnabled', v) }),
      h(TextArea, { label: 'Message text', value: config.message || '', onChange: (v: string) => setField('message', v) }),
    ),
  );
}

// ============================================================
// Form primitives
// ============================================================
function TextField({ label, value, placeholder, onChange }: any) {
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label), h('input', { className: 'input', value: value ?? '', placeholder, onChange: (e: any) => onChange(e.target.value) }));
}
function TextArea({ label, value, placeholder, onChange }: any) {
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label), h('textarea', { className: 'input textarea', value: value ?? '', placeholder, rows: 3, onChange: (e: any) => onChange(e.target.value) }));
}
function NumberField({ label, value, min, max, step, onChange }: any) {
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label), h('input', { type: 'number', className: 'input', value: value ?? 0, min, max, step: step || 1, onChange: (e: any) => onChange(clamp(Number(e.target.value), min ?? -1e9, max ?? 1e9)) }));
}
function SelectField({ label, value, options, onChange, fontPreview }: any) {
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label),
    h(Select, {
      value,
      options: options.map((o: string) => ({ value: o, label: o, style: fontPreview ? { fontFamily: o } : undefined })),
      onChange,
    }));
}
function ChannelField({ label, value, channels, onChange }: any) {
  const known = (channels || []).some((c: any) => c.id === value);
  const [manual, setManual] = useState<boolean>(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label),
    manual
      ? h('div', { className: 'picker-id' },
          h('input', { className: 'input', value: value ?? '', placeholder: 'Paste channel ID', autoFocus: focusManual, onChange: (e: any) => onChange(e.target.value) }),
          h('button', { type: 'button', className: 'btn btn-quiet', title: 'Choose from list', onClick: () => { setManual(false); onChange(''); } }, 'List'))
      : h(Select, {
          value: value ?? '',
          options: [noneOption('Choose a channel…'), ...channelOptions(channels), MANUAL_ID_OPTION],
          onChange: (v: string) => {
            if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
          },
        }));
}
function ColorField({ label, value, onChange }: any) {
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label),
    h('div', { className: 'color-field' }, h('input', { type: 'color', className: 'color-swatch', value: toHex(value, '#000000'), onChange: (e: any) => onChange(e.target.value) }), h('input', { className: 'input color-text', value: value ?? '', onChange: (e: any) => onChange(e.target.value) })));
}
function RangeField({ label, min, max, value, onChange }: any) {
  return h('label', { className: 'field' }, h('span', { className: 'field-label' }, label), h('input', { type: 'range', className: 'range', min, max, value, onChange: (e: any) => onChange(Number(e.target.value)) }));
}
function Toggle({ label, checked, onChange }: any) {
  return h('label', { className: 'toggle' }, h('span', { className: 'toggle-label' }, label),
    h('button', { type: 'button', className: `switch ${checked ? 'is-on' : ''}`, role: 'switch', 'aria-checked': checked, onClick: () => onChange(!checked) }, h('span', { className: 'switch-knob' })));
}
function Segmented({ label, value, options, onChange }: any) {
  return h('div', { className: 'field' }, label ? h('span', { className: 'field-label' }, label) : null,
    h('div', { className: 'segmented' }, options.map(([id, text]: [string, string]) => h('button', { key: id, type: 'button', className: `seg ${value === id ? 'is-active' : ''}`, onClick: () => onChange(id) }, text))));
}
function PlaceholderRow({ onInsert }: any) {
  return h('div', { className: 'placeholder-row' }, placeholders.map((t) => h('button', { key: t, type: 'button', className: 'chip', onClick: () => onInsert(t) }, t)));
}

// ============================================================
// Layer operations (immutable helpers on config)
// ============================================================
type LayerKind = 'text' | 'image' | 'avatar';
function getOrderedLayers(config: any): Array<{ kind: LayerKind; layer: any }> {
  const order = Array.isArray(config.layerOrder) ? config.layerOrder : [];
  const out: Array<{ kind: LayerKind; layer: any }> = [];
  const seen = new Set<string>();
  const push = (kind: LayerKind, layer: any) => {
    if (layer && !seen.has(`${kind}:${layer.id}`)) { out.push({ kind, layer }); seen.add(`${kind}:${layer.id}`); }
  };
  for (const ref of order) {
    const kind: LayerKind | null = ref?.kind === 'image' ? 'image' : ref?.kind === 'text' ? 'text' : ref?.kind === 'avatar' ? 'avatar' : null;
    if (!kind) continue;
    if (kind === 'avatar') { push('avatar', config.avatarLayer); continue; }
    const list = kind === 'text' ? config.textLayers : config.imageLayers;
    push(kind, (list || []).find((l: any) => l.id === ref.id));
  }
  // Append any layers missing from layerOrder (defensive).
  for (const l of config.imageLayers || []) push('image', l);
  if (config.avatarLayer) push('avatar', config.avatarLayer);
  for (const l of config.textLayers || []) push('text', l);
  return out;
}
function findLayer(config: any, sel: { kind: LayerKind; id: string }) {
  if (sel.kind === 'avatar') return config.avatarLayer || null;
  const list = sel.kind === 'text' ? config.textLayers : config.imageLayers;
  return (list || []).find((l: any) => l.id === sel.id) || null;
}
function addLayer(config: any, kind: LayerKind, layer: any) {
  if (kind === 'avatar') {
    const layerOrder = (config.layerOrder || []).some((r: any) => r.kind === 'avatar')
      ? config.layerOrder
      : [...(config.layerOrder || []), { kind: 'avatar', id: AVATAR_ID }];
    return { ...config, avatarLayer: layer, layerOrder };
  }
  const key = kind === 'text' ? 'textLayers' : 'imageLayers';
  return { ...config, [key]: [...(config[key] || []), layer], layerOrder: [...(config.layerOrder || []), { kind, id: layer.id }] };
}
function updateLayerIn(config: any, kind: LayerKind, id: string, patch: any) {
  if (kind === 'avatar') return { ...config, avatarLayer: { ...(config.avatarLayer || makeAvatarLayer()), ...patch } };
  const key = kind === 'text' ? 'textLayers' : 'imageLayers';
  return { ...config, [key]: (config[key] || []).map((l: any) => (l.id === id ? { ...l, ...patch } : l)) };
}
function removeLayer(config: any, kind: LayerKind, id: string) {
  if (kind === 'avatar') return { ...config, avatarLayer: null, layerOrder: (config.layerOrder || []).filter((r: any) => r.kind !== 'avatar') };
  const key = kind === 'text' ? 'textLayers' : 'imageLayers';
  return { ...config, [key]: (config[key] || []).filter((l: any) => l.id !== id), layerOrder: (config.layerOrder || []).filter((r: any) => !(r.kind === kind && r.id === id)) };
}
function duplicateLayer(config: any, kind: LayerKind, id: string) {
  if (kind === 'avatar') return config; // single instance
  const src = findLayer(config, { kind, id }); if (!src) return config;
  const copy = { ...src, id: newId(kind), x: (src.x || 0) + 24, y: (src.y || 0) + 24 };
  return addLayer(config, kind, copy);
}
function reorderLayer(config: any, id: string, dir: number) {
  const order = [...(config.layerOrder || [])];
  const idx = order.findIndex((r: any) => r.id === id);
  if (idx < 0) return config;
  const target = idx + dir;
  if (target < 0 || target >= order.length) return config;
  [order[idx], order[target]] = [order[target], order[idx]];
  return { ...config, layerOrder: order };
}

// ============================================================
// Server-mirroring SVG (thumbnails) — matches welcome.ts render.
// ============================================================
function buildDesignSvg(config: any): string {
  const width = W;
  const height = config.layout === 'compact' ? H_COMPACT : H_CLASSIC;
  const bg = buildBackgroundSvg(config, width, height);
  const layers = getOrderedLayers(config).filter((o) => o.layer.enabled);

  if (layers.length > 0) {
    const body = layers.map((o) => (o.kind === 'image' ? imageLayerSvg(o.layer) : o.kind === 'avatar' ? avatarLayerSvg(o.layer, config) : textLayerSvg(o.layer))).join('\n');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet"><defs>${defaultBgDef()}${bg.defs}</defs>${bg.body}${body}</svg>`;
  }

  const L = getTemplateLayout(config.cardTemplate, width, height, !!config.showAvatar);
  const textColor = escapeXml(config.textColor || '#fff');
  const accent = escapeXml(config.accentColor || '#fd6671');
  const cx = L.avatarX + L.avatarSize / 2, cy = L.avatarY + L.avatarSize / 2;
  const panel = config.cardTemplate === 'minimal'
    ? `<rect width="${width}" height="${height}" fill="rgba(0,0,0,0.18)"/>`
    : config.cardTemplate === 'banner'
      ? `<rect x="40" y="120" width="${width - 80}" height="${height - 240}" rx="42" fill="rgba(0,0,0,0.32)" stroke="rgba(255,255,255,0.2)"/>`
      : `<rect x="40" y="40" width="${width - 80}" height="${height - 80}" rx="42" fill="rgba(0,0,0,0.24)" stroke="rgba(255,255,255,0.2)"/>`;
  const avatar = config.showAvatar
    ? `<circle cx="${cx}" cy="${cy}" r="${L.avatarSize / 2 + 10}" fill="${accent}"/><circle cx="${cx}" cy="${cy}" r="${L.avatarSize / 2}" fill="rgba(255,255,255,0.14)"/><text x="${cx}" y="${cy + L.avatarSize * 0.16}" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${Math.round(L.avatarSize * 0.42)}" font-weight="800" fill="${textColor}">${escapeXml(getInitials(sample.display))}</text>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="xMidYMid meet"><defs>${defaultBgDef()}${bg.defs}</defs>${bg.body}${panel}${avatar}<text x="${L.textX}" y="${L.titleY}" text-anchor="${L.textAnchor}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${L.titleSize}" font-weight="900" fill="${textColor}">${escapeXml(truncate(renderPlain(config.titleText), 40))}</text><text x="${L.textX}" y="${L.subtitleY}" text-anchor="${L.textAnchor}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${L.subtitleSize}" font-weight="700" fill="${accent}">${escapeXml(truncate(renderPlain(config.subtitleText), 50))}</text><text x="${L.textX}" y="${L.footerY}" text-anchor="${L.textAnchor}" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${L.footerSize}" fill="rgba(255,255,255,0.82)">${escapeXml(truncate(renderPlain(config.footerText), 50))}</text></svg>`;
}
function defaultBgDef() {
  return `<linearGradient id="wdefault" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#16181d"/><stop offset="100%" stop-color="#fd6671"/></linearGradient>`;
}
function textLayerSvg(layer: any) {
  const text = escapeXml(truncate(renderPlain(layer.text), 96));
  const baselineY = layer.y + layer.fontSize * 0.35;
  const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${layer.x} ${layer.y})"` : '';
  const outline = layer.outlineEnabled && layer.outlineWidth > 0 ? ` stroke="${escapeXml(layer.outlineColor)}" stroke-width="${layer.outlineWidth}" paint-order="stroke fill" stroke-linejoin="round"` : '';
  return `<g${transform}><text x="${layer.x}" y="${baselineY}" text-anchor="${layer.anchor}" font-family="${escapeXml(layer.fontFamily)}, Segoe UI, Arial, sans-serif" font-size="${layer.fontSize}" font-weight="${layer.fontWeight}" font-style="${layer.fontStyle}" fill="${escapeXml(layer.color)}"${outline}>${text}</text></g>`;
}
function imageLayerSvg(layer: any) {
  const cx = layer.x + layer.width / 2, cy = layer.y + layer.height / 2;
  const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${cx} ${cy})"` : '';
  return `<image href="${escapeXml(layer.imageDataUri)}" x="${layer.x}" y="${layer.y}" width="${layer.width}" height="${layer.height}" opacity="${layer.opacity}" preserveAspectRatio="none"${transform}/>`;
}
let avatarClipSeq = 0;
function avatarLayerSvg(layer: any, config: any) {
  const size = Math.max(24, layer.size || 200);
  const cx = layer.x + size / 2, cy = layer.y + size / 2, r = size / 2;
  const transform = layer.rotation ? ` transform="rotate(${layer.rotation} ${cx} ${cy})"` : '';
  const ringW = layer.ringEnabled && layer.ringWidth > 0 ? layer.ringWidth : 0;
  const clipId = `avthumb-${avatarClipSeq++}`;
  let clip: string, ring = '';
  if (layer.shape === 'circle') {
    clip = `<circle cx="${cx}" cy="${cy}" r="${r}"/>`;
    if (ringW) ring = `<circle cx="${cx}" cy="${cy}" r="${r + ringW / 2}" fill="none" stroke="${escapeXml(layer.ringColor)}" stroke-width="${ringW}"/>`;
  } else {
    const rx = layer.shape === 'rounded' ? Math.min(60, size * 0.18) : 0;
    clip = `<rect x="${layer.x}" y="${layer.y}" width="${size}" height="${size}" rx="${rx}"/>`;
    if (ringW) ring = `<rect x="${layer.x - ringW / 2}" y="${layer.y - ringW / 2}" width="${size + ringW}" height="${size + ringW}" rx="${rx ? rx + ringW / 2 : 0}" fill="none" stroke="${escapeXml(layer.ringColor)}" stroke-width="${ringW}"/>`;
  }
  const accent = escapeXml(config.accentColor || '#fd6671');
  const inner = `<g clip-path="url(#${clipId})"><rect x="${layer.x}" y="${layer.y}" width="${size}" height="${size}" fill="${accent}"/><text x="${cx}" y="${cy + size * 0.16}" text-anchor="middle" font-family="Inter, Segoe UI, Arial, sans-serif" font-size="${Math.round(size * 0.4)}" font-weight="800" fill="#ffffff">${escapeXml(getInitials(sample.display))}</text></g>`;
  return `<g${transform}><defs><clipPath id="${clipId}">${clip}</clipPath></defs>${inner}${ring}</g>`;
}
function buildBackgroundSvg(config: any, width: number, height: number): { defs: string; body: string } {
  if (config.backgroundImageDataUri) return { defs: '', body: `<rect width="${width}" height="${height}" fill="url(#wdefault)"/><image href="${escapeXml(config.backgroundImageDataUri)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>` };
  const value = String(config.background || '').trim();
  if (/^https?:\/\//i.test(value)) return { defs: '', body: `<rect width="${width}" height="${height}" fill="url(#wdefault)"/><image href="${escapeXml(value)}" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice" opacity="0.88"/>` };
  const g = parseGradient(value);
  if (g) { const e = gradientEndPoint(g.angle); return { defs: `<linearGradient id="wc" x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}"><stop offset="0%" stop-color="${escapeXml(g.from)}"/><stop offset="100%" stop-color="${escapeXml(g.to)}"/></linearGradient>`, body: `<rect width="${width}" height="${height}" fill="url(#wc)"/>` }; }
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) || /^[a-z]+$/i.test(value)) return { defs: '', body: `<rect width="${width}" height="${height}" fill="${escapeXml(value)}"/>` };
  return { defs: '', body: `<rect width="${width}" height="${height}" fill="url(#wdefault)"/>` };
}
function getTemplateLayout(template: string, width: number, height: number, showAvatar: boolean): any {
  if (template === 'banner') return { avatarSize: showAvatar ? 170 : 0, avatarX: 96, avatarY: 225, textX: showAvatar ? 330 : width / 2, textAnchor: showAvatar ? 'start' : 'middle', titleY: 270, subtitleY: 332, footerY: 382, titleSize: 54, subtitleSize: 32, footerSize: 24 };
  if (template === 'profile') return { avatarSize: showAvatar ? 220 : 0, avatarX: (width - 220) / 2, avatarY: 74, textX: width / 2, textAnchor: 'middle', titleY: showAvatar ? 365 : 260, subtitleY: showAvatar ? 430 : 325, footerY: showAvatar ? 484 : 380, titleSize: 56, subtitleSize: 32, footerSize: 24 };
  if (template === 'minimal') return { avatarSize: showAvatar ? 140 : 0, avatarX: (width - 140) / 2, avatarY: 115, textX: width / 2, textAnchor: 'middle', titleY: showAvatar ? 315 : 265, subtitleY: showAvatar ? 374 : 326, footerY: showAvatar ? 424 : 378, titleSize: 50, subtitleSize: 30, footerSize: 22 };
  return { avatarSize: showAvatar ? 190 : 0, avatarX: (width - 190) / 2, avatarY: 92, textX: width / 2, textAnchor: 'middle', titleY: showAvatar ? 350 : 260, subtitleY: showAvatar ? 424 : 334, footerY: showAvatar ? 482 : 392, titleSize: 58, subtitleSize: 34, footerSize: 25 };
}
function gradientEndPoint(angle: number) {
  const r = ((angle - 90) * Math.PI) / 180, x = Math.cos(r), y = Math.sin(r);
  return { x1: ((1 - x) / 2).toFixed(3), y1: ((1 - y) / 2).toFixed(3), x2: ((1 + x) / 2).toFixed(3), y2: ((1 + y) / 2).toFixed(3) };
}

// ============================================================
// Helpers
// ============================================================
function getBackgroundCss(config: any) {
  if (config.backgroundImageDataUri) return `center / cover no-repeat url("${String(config.backgroundImageDataUri).replaceAll('"', '%22')}")`;
  const value = String(config.background || '').trim();
  if (/^https?:\/\//i.test(value)) return `center / cover no-repeat url("${value.replaceAll('"', '%22')}")`;
  return value || '#16181d';
}
function getBackgroundMode(config: any): string {
  if (config.backgroundImageDataUri) return 'upload';
  const value = String(config.background || '').trim();
  if (/^https?:\/\//i.test(value)) return 'url';
  if (parseGradient(value)) return 'gradient';
  if (/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value) || /^[a-z]+$/i.test(value)) return 'solid';
  return 'gradient';
}
function parseGradient(value: string): { angle: number; from: string; to: string } | null {
  const angled = String(value || '').trim().match(/^linear-gradient\(\s*([\d.]+)deg\s*,\s*(#[0-9a-f]{3,8})[^,]*,\s*(#[0-9a-f]{3,8})/i);
  if (angled) return { angle: Math.round(Number(angled[1]) || 0), from: toHex(angled[2], '#16181d'), to: toHex(angled[3], '#fd6671') };
  const plain = String(value || '').trim().match(/^linear-gradient\(\s*(#[0-9a-f]{3,8})[^,]*,\s*(#[0-9a-f]{3,8})/i);
  if (plain) return { angle: 135, from: toHex(plain[1], '#16181d'), to: toHex(plain[2], '#fd6671') };
  return null;
}
function buildGradient(angle: number, from: string, to: string) { return `linear-gradient(${Math.round(angle)}deg, ${toHex(from, '#16181d')}, ${toHex(to, '#fd6671')})`; }
function toHex(value: any, fallback: string): string {
  const t = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(t)) return t;
  if (/^#[0-9a-f]{3}$/i.test(t)) return `#${t.slice(1).split('').map((c) => c + c).join('')}`;
  return fallback;
}
function hexToRgba(value: any, opacity = 1) {
  const hex = toHex(value, '#000000').slice(1);
  const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${clamp(Number(opacity), 0, 1)})`;
}
function renderPlain(text: any) {
  return String(text || '').replaceAll('{user}', sample.user).replaceAll('{username}', sample.username).replaceAll('{display}', sample.display).replaceAll('{mention}', sample.mention).replaceAll('{server}', sample.server).replaceAll('{count}', sample.count);
}
function truncate(text: string, max: number) { const v = String(text || ''); return v.length > max ? `${v.slice(0, max - 1)}…` : v; }
function getInitials(name: string) { const p = String(name || '').trim().split(/[\s_-]+/).filter(Boolean); return (p.length >= 2 ? p[0][0] + p[1][0] : String(name || '?').slice(0, 2)).toUpperCase(); }
function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, Number.isFinite(v) ? v : min)); }
function snap(v: number) { const grid = 0; return grid ? Math.round(v / grid) * grid : v; }
// Snap a layer's center (and, for boxes, its edges) to the canvas center and
// edges while dragging. Returns the adjusted x/y plus the guide lines to draw.
function computeSnap(kind: string, layer: any, nx: number, ny: number, cw: number, ch: number) {
  const T = 9; // snap threshold in canvas pixels
  const gx: number[] = [], gy: number[] = [];
  let x = nx, y = ny;
  const w = kind === 'avatar' ? (layer.size || 0) : kind === 'image' ? (layer.width || 0) : 0;
  const hgt = kind === 'avatar' ? (layer.size || 0) : kind === 'image' ? (layer.height || 0) : 0;
  const cx = kind === 'text' ? nx : nx + w / 2;
  const cy = kind === 'text' ? ny : ny + hgt / 2;

  if (Math.abs(cx - cw / 2) <= T) { x = nx + (cw / 2 - cx); gx.push(cw / 2); }
  else if (kind !== 'text' && Math.abs(nx) <= T) { x = 0; gx.push(0); }
  else if (kind !== 'text' && Math.abs(nx + w - cw) <= T) { x = cw - w; gx.push(cw); }

  if (Math.abs(cy - ch / 2) <= T) { y = ny + (ch / 2 - cy); gy.push(ch / 2); }
  else if (kind !== 'text' && Math.abs(ny) <= T) { y = 0; gy.push(0); }
  else if (kind !== 'text' && Math.abs(ny + hgt - ch) <= T) { y = ch - hgt; gy.push(ch); }

  return { x: Math.round(x), y: Math.round(y), gx, gy };
}
// Does a layer fall inside the marquee rectangle (canvas coordinates)? Text is
// hit-tested by its anchor point; boxes by bounding-box intersection.
function layerIntersects(o: any, rect: { x: number; y: number; w: number; h: number }): boolean {
  const l = o.layer;
  if (o.kind === 'text') {
    return l.x >= rect.x && l.x <= rect.x + rect.w && l.y >= rect.y && l.y <= rect.y + rect.h;
  }
  const w = o.kind === 'avatar' ? (l.size || 0) : (l.width || 0);
  const hgt = o.kind === 'avatar' ? (l.size || 0) : (l.height || 0);
  return !(l.x > rect.x + rect.w || l.x + w < rect.x || l.y > rect.y + rect.h || l.y + hgt < rect.y);
}
function escapeXml(text: any) { return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] || c)); }
function readFileAsDataUri(file: File): Promise<string> {
  return new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result || '')); r.onerror = reject; r.readAsDataURL(file); });
}
function imageSize(src: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve({ width: i.naturalWidth || i.width, height: i.naturalHeight || i.height }); i.onerror = reject; i.src = src; });
}
function shapeSvg(type: string, color: string) {
  const safe = String(color || '#fd6671').replace(/[<>"']/g, '');
  if (type === 'circle') return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><circle cx="200" cy="200" r="190" fill="${safe}"/></svg>`;
  if (type === 'line') return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="40"><rect x="0" y="12" width="600" height="16" rx="8" fill="${safe}"/></svg>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="320"><rect width="500" height="320" rx="${type === 'round' ? 48 : 0}" fill="${safe}"/></svg>`;
}
const loadedFonts = new Set<string>();
function loadGoogleFont(family: string) {
  const f = String(family || '').trim();
  if (!f || systemFonts.includes(f) || loadedFonts.has(f) || typeof document === 'undefined') return;
  loadedFonts.add(f);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;600;700;800;900&display=swap`;
  document.head.appendChild(link);
}
function mergeFonts(fonts: string[]) { return Array.from(new Set(defaultFonts.concat(fonts || []).map((f) => String(f || '').trim()).filter(Boolean))); }

// ============================================================
// API
// ============================================================
async function loadConfig() { const r = await fetch(`${API_BASE}/api/config`); const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Load failed'); return d.config || defaultConfig; }
async function loadFonts() { const r = await fetch(`${API_BASE}/api/fonts`); const d = await r.json(); if (!d.ok || !Array.isArray(d.fonts)) return []; return d.fonts.map((f: any) => String(f || '').trim()).filter(Boolean); }
async function saveConfig(config: any) { const r = await fetch(`${API_BASE}/api/config`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) }); const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Save failed'); return d.config; }
async function loadImages() { const r = await fetch(`${API_BASE}/api/images`); const d = await r.json(); if (!d.ok || !Array.isArray(d.images)) throw new Error(d.error || 'Could not load designs.'); return d.images; }
async function createImage(name: string, config: any, selected = false) { const r = await fetch(`${API_BASE}/api/images`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config, selected }) }); const d = await r.json(); if (!d.ok || !d.image) throw new Error(d.error || 'Could not save.'); return d.image; }
async function updateImage(id: string, updates: any) { const r = await fetch(`${API_BASE}/api/images/${encodeURIComponent(id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) }); const d = await r.json(); if (!d.ok || !d.image) throw new Error(d.error || 'Could not update.'); return d.image; }
async function deleteImage(id: string) { const r = await fetch(`${API_BASE}/api/images/${encodeURIComponent(id)}`, { method: 'DELETE' }); const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Could not delete.'); return d; }
async function activateImage(id: string) { const r = await fetch(`${API_BASE}/api/images/${encodeURIComponent(id)}/activate`, { method: 'POST' }); const d = await r.json(); if (!d.ok) throw new Error(d.error || 'Could not activate.'); return d; }

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
