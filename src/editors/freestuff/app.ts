import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiRefreshCw, FiZap, FiExternalLink } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select as Dropdown, noneOption } from '../shared/select.js';
import { FeatureOffNotice, FeatureSwitch, SaveBar, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const DEFAULT_BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

type Sources = { gamerpower: boolean; cheapshark: boolean };
type Cfg = {
  serverId: string;
  channelId: string;
  enabled: boolean;
  sources: Sources;
  platforms: string[];
  types: string[];
  minSavings: number;
  onlyFreeDeals: boolean;
  stores: string[];
  mentionRole?: string;
};
type Store = { id: string; name: string };
type Offer = {
  guid: string; source: string; title: string; url: string;
  worth?: string; salePrice?: string; savings?: number;
  platforms?: string; type?: string; image?: string; thumbnail?: string;
};

function App() {
  const [botName, setBotName] = useState(DEFAULT_BOT_NAME);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  // Last saved config: what Discard goes back to.
  const [saved, setSaved] = useState<Cfg | null>(null);
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>([]);
  const [roles, setRoles] = useState<Array<{ id: string; name: string }>>([]);
  const [gpPlatforms, setGpPlatforms] = useState<string[]>([]);
  const [gpTypes, setGpTypes] = useState<string[]>([]);
  const [preview, setPreview] = useState<Offer[]>([]);
  const [status, setStatus] = useState('');
  const [dirty, setDirty] = useState(false);

  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!status) return undefined;
    const t = setTimeout(() => setStatus(''), 4000);
    return () => clearTimeout(t);
  }, [status]);

  async function load() {
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', message: 'Reloading replaces your edits with the saved settings.', confirmLabel: 'Discard and reload', danger: true }))) return;
    try {
      const data = await getJson('/api/config');
      setBotName(data.botName || DEFAULT_BOT_NAME);
      setCfg(data.config);
      setSaved(data.config);
      setStores(data.stores || []);
      setChannels(data.channels || []);
      setRoles(data.roles || []);
      setGpPlatforms(data.gamerpowerPlatforms || []);
      setGpTypes(data.gamerpowerTypes || []);
      setDirty(false);
    } catch (e: any) { setStatus(e.message); }
  }

  function patch(p: Partial<Cfg>) {
    setCfg((c) => (c ? { ...c, ...p } : c));
    setDirty(true);
  }
  function patchSource(k: keyof Sources, v: boolean) {
    setCfg((c) => (c ? { ...c, sources: { ...c.sources, [k]: v } } : c));
    setDirty(true);
  }
  function toggleIn(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((x) => x !== value) : [...list, value];
  }

  async function save() {
    if (!cfg || !saved) return;
    setBusy(true);
    try {
      // The on/off switch saves on its own, so a draft never flips it back.
      const data = await postJson('/api/config', { ...cfg, enabled: saved.enabled });
      setCfg(data.config);
      setSaved(data.config);
      setDirty(false);
      setStatus('Settings saved.');
    } catch (e: any) { setStatus(e.message); } finally { setBusy(false); }
  }

  function discard() {
    setCfg(saved);
    setDirty(false);
  }

  // Takes effect at once and leaves other drafts alone.
  async function toggleEnabled(enabled: boolean) {
    setToggling(true);
    try {
      await postJson('/api/config', { enabled });
      setCfg((c) => (c ? { ...c, enabled } : c));
      setSaved((s) => (s ? { ...s, enabled } : s));
      setStatus(enabled ? 'Free Stuff feed is on.' : 'Free Stuff feed is off.');
    } catch (e: any) { setStatus(e.message); } finally { setToggling(false); }
  }

  async function runTest() {
    if (!cfg) return;
    setStatus('Fetching preview…');
    try {
      const data = await postJson('/api/test', cfg);
      setPreview(data.offers || []);
      const errs = data.errors?.length ? ` (${data.errors.length} source error(s))` : '';
      setStatus(`${(data.offers || []).length} matching offer(s)${errs}.`);
    } catch (e: any) { setStatus(e.message); }
  }

  if (!cfg || !saved) return h('div', { className: 'app' }, h('div', { className: 'empty' }, 'Loading…'));

  return h('div', { className: 'app' },
    h('header', { className: 'hero' },
      h('div', null,
        h('h1', null, 'Free Stuff'),
        h('p', null, `${botName} — auto-post free game giveaways (GamerPower) and big discounts (CheapShark) to a channel.`),
      ),
      h('div', { className: 'hero-actions' },
        h('button', { className: 'secondary', onClick: load }, h(FiRefreshCw), 'Reload'),
        h(FeatureSwitch, { feature: 'the Free Stuff feed', enabled: !!saved.enabled, busy: toggling, onChange: toggleEnabled }),
      ),
    ),

    saved.enabled ? null : h(FeatureOffNotice, { feature: 'The feed', what: 'No offers are being posted.', busy: toggling, onEnable: () => toggleEnabled(true) }),

    // ---- Feed channel ----
    h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'Feed'), h('p', null, 'Where offers post, and who gets pinged.')),
      ),
      h('div', { className: 'grid2' },
        h(Select, { label: 'Post to channel', value: cfg.channelId, onChange: (v: string) => patch({ channelId: v }), placeholder: 'Choose a channel…', options: channels.map((c) => ({ value: c.id, label: `#${c.name}` })) }),
        h(Select, { label: 'Ping role (optional)', value: cfg.mentionRole || '', onChange: (v: string) => patch({ mentionRole: v }), placeholder: 'No role', options: roles.map((r) => ({ value: r.id, label: `@${r.name}` })) }),
      ),
    ),

    // ---- Sources ----
    h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'Sources'), h('p', null, 'Pick where offers come from.')),
      ),
      h('div', { className: 'source-row' },
        h(SourceCard, {
          title: 'GamerPower', desc: 'Free game / DLC / loot giveaways.',
          checked: cfg.sources.gamerpower, onChange: (v: boolean) => patchSource('gamerpower', v),
        }),
        h(SourceCard, {
          title: 'CheapShark', desc: 'Discounted paid games across stores.',
          checked: cfg.sources.cheapshark, onChange: (v: boolean) => patchSource('cheapshark', v),
        }),
      ),
    ),

    // ---- GamerPower filters ----
    cfg.sources.gamerpower ? h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'GamerPower filters'), h('p', null, 'Empty = everything. Platform matches the offer\'s platform text.')),
      ),
      h('div', { className: 'field' }, h('span', null, 'Platforms'),
        h('div', { className: 'chips' },
          gpPlatforms.map((p) => {
            const key = p.toLowerCase();
            const on = cfg.platforms.includes(key);
            return h('button', { key, className: `chip ${on ? 'on' : ''}`, onClick: () => patch({ platforms: toggleIn(cfg.platforms, key) }) }, p);
          }),
        ),
      ),
      h('div', { className: 'field' }, h('span', null, 'Offer types'),
        h('div', { className: 'chips' },
          gpTypes.map((t) => {
            const on = cfg.types.includes(t);
            return h('button', { key: t, className: `chip ${on ? 'on' : ''}`, onClick: () => patch({ types: toggleIn(cfg.types, t) }) }, t);
          }),
        ),
      ),
    ) : null,

    // ---- CheapShark filters ----
    cfg.sources.cheapshark ? h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'CheapShark filters'), h('p', null, 'Discount threshold and which stores to watch.')),
      ),
      h('div', { className: 'grid2' },
        h(Field, {
          label: `Minimum discount: ${cfg.onlyFreeDeals ? '100 (free only)' : cfg.minSavings}%`,
          type: 'range', min: 0, max: 100, disabled: cfg.onlyFreeDeals,
          value: String(cfg.minSavings), onChange: (v: string) => patch({ minSavings: Number(v) }),
        }),
        h('label', { className: 'field toggle-field' }, h('span', null, 'Only 100%-off (free) deals'),
          h(Toggle, { checked: cfg.onlyFreeDeals, onChange: (v: boolean) => patch({ onlyFreeDeals: v }), label: cfg.onlyFreeDeals ? 'On' : 'Off' }),
        ),
      ),
      h('div', { className: 'field' }, h('span', null, `Stores ${cfg.stores.length ? `(${cfg.stores.length} selected)` : '(all)'}`),
        h('div', { className: 'chips' },
          stores.map((s) => {
            const on = cfg.stores.includes(s.id);
            return h('button', { key: s.id, className: `chip ${on ? 'on' : ''}`, onClick: () => patch({ stores: toggleIn(cfg.stores, s.id) }) }, s.name);
          }),
        ),
        h('small', { className: 'hint' }, 'No store selected = every store. Up to 8 stores are queried per check.'),
      ),
    ) : null,

    // ---- Preview ----
    h('section', { className: 'panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'Preview'), h('p', null, 'Fetch offers matching the current (unsaved) filters — nothing is posted.')),
        h('button', { className: 'secondary', onClick: runTest }, h(FiZap), 'Fetch preview'),
      ),
      preview.length === 0
        ? h('div', { className: 'empty' }, 'No preview yet. Click "Fetch preview".')
        : h('div', { className: 'offer-grid' },
            preview.map((o) => h('a', { key: o.guid, className: 'offer-card', href: o.url, target: '_blank', rel: 'noreferrer' },
              o.image ? h('div', { className: 'offer-img', style: { backgroundImage: `url("${o.image}")` } }) : null,
              h('div', { className: 'offer-body' },
                h('div', { className: `offer-tag ${o.source}` }, o.source === 'gamerpower' ? 'FREE' : `-${o.savings}%`),
                h('strong', { className: 'offer-title' }, o.title),
                h('div', { className: 'offer-meta' },
                  o.salePrice ? h('span', { className: 'price' }, o.salePrice) : null,
                  o.worth && o.worth !== o.salePrice ? h('span', { className: 'strike' }, o.worth) : null,
                  o.platforms ? h('span', { className: 'plat' }, o.platforms) : null,
                ),
                h('span', { className: 'offer-link' }, h(FiExternalLink), 'Open'),
              ),
            )),
          ),
    ),

    h('div', { className: `status ${status ? 'show' : ''}` }, status),
    h(SaveBar, { dirty, busy, onSave: save, onDiscard: discard }),
  );
}

function Toggle({ checked, onChange, label }: any) {
  const control = h('button', { type: 'button', className: `switch ${checked ? 'on' : ''}`, onClick: () => onChange(!checked), 'aria-pressed': checked },
    h('span', { className: 'knob' }),
  );
  // The state label sits beside the switch in normal flow so it can never
  // spill past the edge of a right-aligned panel header.
  return label ? h('span', { className: 'switch-wrap' }, control, h('span', { className: 'switch-label' }, label)) : control;
}

function SourceCard({ title, desc, checked, onChange }: any) {
  return h('div', { className: `source-card ${checked ? 'on' : ''}` },
    h('div', { className: 'source-text' }, h('strong', null, title), h('span', null, desc)),
    h(Toggle, { checked, onChange }),
  );
}

function Field({ label, value, onChange, type = 'text', placeholder = '', min, max, disabled }: any) {
  return h('label', { className: 'field' },
    h('span', null, label),
    h('input', { value, type, placeholder, min, max, disabled, onChange: (e: any) => onChange(e.target.value) }),
  );
}

function Select({ label, value, onChange, placeholder, options }: any) {
  const known = (options || []).some((o: any) => o.value === value);
  const [manual, setManual] = useState<boolean>(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  return h('label', { className: 'field' },
    h('span', null, label),
    manual
      ? h('div', { className: 'picker-id' },
          h('input', { value: value || '', placeholder: 'Paste ID', autoFocus: focusManual, onChange: (e: any) => onChange(e.target.value) }),
          h('button', { type: 'button', className: 'btn btn-quiet', title: 'Choose from list', onClick: () => { setManual(false); onChange(''); } }, 'List'))
      : h(Dropdown, {
          value: value || '',
          options: [noneOption(placeholder || 'Choose…'), ...options, MANUAL_ID_OPTION],
          onChange: (v: string) => {
            if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
          },
        }),
  );
}

createRoot(document.getElementById('root')!).render(h(App));
