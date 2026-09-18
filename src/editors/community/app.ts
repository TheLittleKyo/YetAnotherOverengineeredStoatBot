import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiGift, FiHash, FiMic, FiPlus, FiSend, FiTag, FiTrash2 } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions, namedOptions, noneOption } from '../shared/select.js';
import { NumberInput, SaveBar, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __PREFIX__: string;
const PREFIX = typeof __PREFIX__ === 'string' ? __PREFIX__ : '!';

const OFFSETS = [
  ['-720', 'UTC−12'], ['-660', 'UTC−11'], ['-600', 'UTC−10'], ['-570', 'UTC−9:30'], ['-540', 'UTC−9'], ['-480', 'UTC−8'],
  ['-420', 'UTC−7'], ['-360', 'UTC−6'], ['-300', 'UTC−5'], ['-240', 'UTC−4'], ['-210', 'UTC−3:30'], ['-180', 'UTC−3'],
  ['-120', 'UTC−2'], ['-60', 'UTC−1'], ['0', 'UTC'], ['60', 'UTC+1'], ['120', 'UTC+2'], ['180', 'UTC+3'],
  ['210', 'UTC+3:30'], ['240', 'UTC+4'], ['270', 'UTC+4:30'], ['300', 'UTC+5'], ['330', 'UTC+5:30'], ['345', 'UTC+5:45'],
  ['360', 'UTC+6'], ['390', 'UTC+6:30'], ['420', 'UTC+7'], ['480', 'UTC+8'], ['525', 'UTC+8:45'], ['540', 'UTC+9'],
  ['570', 'UTC+9:30'], ['600', 'UTC+10'], ['630', 'UTC+10:30'], ['660', 'UTC+11'], ['720', 'UTC+12'], ['765', 'UTC+12:45'],
  ['780', 'UTC+13'], ['840', 'UTC+14'],
];

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

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

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Community'),
        h('p', { className: 'muted' }, 'Custom commands, birthday announcements, and temporary voice rooms.'))),

    h(TagsCard, { data, setData, flash }),
    h(BirthdayCard, { data, setData, flash }),
    h(VoiceCard, { data, setData, flash }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function TagsCard({ data, setData, flash }: any) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const tags = data.tags || [];

  async function create() {
    if (!name.trim() || !content.trim()) { flash('error', 'A tag needs a name and content.'); return; }
    setBusy(true);
    try {
      const response = await postJson('/api/tag', { name, content });
      setData((current: any) => ({ ...current, tags: response.tags }));
      setName('');
      setContent('');
      flash('ok', 'Tag created.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function remove(tag: any) {
    const ok = await confirmDialog({ title: `Delete "${tag.name}"?`, message: 'The command stops working immediately.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/tag/delete', { name: tag.name });
      setData((current: any) => ({ ...current, tags: response.tags }));
    } catch (e: any) { flash('error', e.message); }
  }

  async function saveContent(tag: any, next: string) {
    if (next === tag.content) return;
    try {
      const response = await postJson('/api/tag/update', { name: tag.name, content: next });
      setData((current: any) => ({ ...current, tags: response.tags }));
      flash('ok', `${tag.name} updated.`);
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, {
    icon: FiTag,
    title: `Tags (${tags.length})`,
    desc: `Canned replies anyone can call with ${PREFIX}<name>. Placeholders: {user} {mention} {server} {channel} {count} {args}.`,
  },
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Name'),
        h('input', { className: 'input', value: name, placeholder: 'rules', onChange: (e: any) => setName(e.target.value) })),
      h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Called as'),
        h('code', { className: 'muted' }, `${PREFIX}${name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'name'}`))),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Content'),
      h('textarea', { className: 'input textarea', rows: 3, value: content, placeholder: 'Read the pinned post in {channel}, {mention}.', onChange: (e: any) => setContent(e.target.value) })),
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-accent', disabled: busy, onClick: create }, h(FiPlus), busy ? 'Creating…' : 'Create tag')),

    tags.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No tags yet.')
      : h('div', { className: 'list-scroll' }, tags.map((tag: any) =>
          h('div', { className: 'rule-row', key: tag.id },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('span', { className: 'tag' }, `${PREFIX}${tag.name}`),
                tag.aliases?.length ? h('span', { className: 'chip' }, `aliases: ${tag.aliases.join(', ')}`) : null,
                h('span', { className: 'chip' }, `${tag.uses} uses`)),
              h('textarea', {
                className: 'input textarea', rows: 2, defaultValue: tag.content,
                onBlur: (e: any) => saveContent(tag, e.target.value),
              })),
            h('div', { className: 'rule-actions' },
              h('button', { className: 'icon-btn icon-danger', title: 'Delete tag', 'aria-label': 'Delete tag', onClick: () => remove(tag) }, h(FiTrash2)))))));
}

function BirthdayCard({ data, setData, flash }: any) {
  const [draft, setDraft] = useState<any>(data.birthdaySettings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(data.birthdaySettings); }, [data.birthdaySettings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.birthdaySettings);
  const set = (patch: any) => setDraft((current: any) => ({ ...current, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const response = await postJson('/api/birthday/settings', draft);
      setData((current: any) => ({ ...current, birthdaySettings: response.birthdaySettings }));
      flash('ok', 'Birthday settings saved.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function test() {
    try {
      const response = await postJson('/api/birthday/test', {});
      flash('ok', response.announced ? `Announced ${response.announced} birthday(s).` : 'Nobody has a birthday today.');
    } catch (e: any) { flash('error', e.message); }
  }

  async function remove(entry: any) {
    const ok = await confirmDialog({ title: `Remove ${entry.name}'s birthday?`, confirmLabel: 'Remove', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/birthday/delete', { userId: entry.userId });
      setData((current: any) => ({ ...current, birthdays: response.birthdays, birthdayCount: response.birthdayCount }));
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, {
    icon: FiGift,
    title: `Birthdays (${data.birthdayCount || 0} saved)`,
    desc: `Members register their own with ${PREFIX}birthday set. Announcements go out once a day, in the timezone you pick here.`,
  },
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Announcement channel'),
        h(Select, {
          value: draft.channelId || '',
          options: [noneOption('Not set'), ...channelOptions(data.channels)],
          onChange: (value: string) => set({ channelId: value || null, enabled: value ? true : draft.enabled }),
        })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Role for the day (optional)'),
        h(Select, {
          value: draft.roleId || '',
          options: [noneOption('No role'), ...namedOptions(data.roles)],
          onChange: (value: string) => set({ roleId: value || null }),
        }))),
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Announce at (hour)'),
        h(NumberInput, { value: draft.announceHour, min: 0, max: 23, onChange: (value: number) => set({ announceHour: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Server timezone'),
        h(Select, {
          value: String(draft.utcOffsetMinutes ?? 0),
          // An offset set from chat (any whole minute) still shows, even when
          // it is not one of the common zones listed.
          options: OFFSETS.some(([value]) => value === String(draft.utcOffsetMinutes ?? 0))
            ? OFFSETS.map(([value, label]) => ({ value, label }))
            : [...OFFSETS.map(([value, label]) => ({ value, label })), { value: String(draft.utcOffsetMinutes), label: `UTC offset ${draft.utcOffsetMinutes} min` }],
          onChange: (value: string) => set({ utcOffsetMinutes: Number(value) }),
        })),
      h('label', { className: 'check-row', style: { alignSelf: 'end' } },
        h('input', { type: 'checkbox', checked: draft.allowYear !== false, onChange: (e: any) => set({ allowYear: e.target.checked }) }),
        h('span', null, 'Store birth years (shows ages)'))),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Message — {mention} {user} {age} {server}'),
      h('input', { className: 'input', value: draft.message || '', onChange: (e: any) => set({ message: e.target.value }) })),
    h('label', { className: 'check-row' },
      h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e: any) => set({ enabled: e.target.checked }) }),
      h('span', null, 'Announce birthdays')),
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-quiet', onClick: test }, h(FiSend), "Announce today's now")),

    h('div', { className: 'sub-head' }, 'Upcoming'),
    (data.birthdays || []).length === 0
      ? h('p', { className: 'empty-line muted' }, 'Nobody has saved a birthday yet.')
      : h('div', { className: 'list-scroll' }, (data.birthdays || []).map((entry: any) =>
          h('div', { className: 'rule-row', key: entry.userId },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('strong', null, entry.name),
                h('span', { className: 'chip' }, entry.date),
                h('span', { className: 'chip' }, entry.inDays === 0 ? 'today' : `in ${entry.inDays}d`))),
            h('div', { className: 'rule-actions' },
              h('button', { className: 'icon-btn icon-danger', title: 'Remove', 'aria-label': 'Remove birthday', onClick: () => remove(entry) }, h(FiTrash2)))))),

    h(SaveBar, { dirty, busy, onSave: save, onDiscard: () => setDraft(data.birthdaySettings) }));
}

function VoiceCard({ data, setData, flash }: any) {
  const [draft, setDraft] = useState<any>(data.voiceSettings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setDraft(data.voiceSettings); }, [data.voiceSettings]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(data.voiceSettings);
  const set = (patch: any) => setDraft((current: any) => ({ ...current, ...patch }));

  async function save() {
    setBusy(true);
    try {
      const response = await postJson('/api/voice/settings', draft);
      setData((current: any) => ({ ...current, voiceSettings: response.voiceSettings }));
      flash('ok', 'Voice room settings saved.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  async function close(room: any) {
    const ok = await confirmDialog({ title: `Close ${room.name}?`, message: 'The channel is deleted.', confirmLabel: 'Close room', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/voice/close', { channelId: room.channelId });
      setData((current: any) => ({ ...current, rooms: response.rooms }));
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, {
    icon: FiMic,
    title: 'Temporary voice rooms',
    desc: 'Joining the hub creates a personal room. Stoat cannot move people between voice channels, so the bot posts a link to the new room instead.',
  },
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Hub voice channel'),
        h(Select, {
          value: draft.hubChannelId || '',
          options: [noneOption('Not set'), ...channelOptions(data.voiceChannels)],
          onChange: (value: string) => set({ hubChannelId: value || null }),
        })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Where the link is posted'),
        h(Select, {
          value: draft.noticeChannelId || '',
          options: [noneOption('Not set'), ...channelOptions(data.channels)],
          onChange: (value: string) => set({ noticeChannelId: value || null }),
        }))),
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Room name — {user}'),
        h('input', { className: 'input', value: draft.nameTemplate || '', onChange: (e: any) => set({ nameTemplate: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Default user limit (0 = none)'),
        h(NumberInput, { value: draft.userLimit, min: 0, max: 99, onChange: (value: number) => set({ userLimit: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Rooms per member'),
        h(NumberInput, { value: draft.maxRoomsPerUser, min: 1, max: 5, onChange: (value: number) => set({ maxRoomsPerUser: value }) }))),
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Close after empty for (seconds)'),
        h(NumberInput, { value: draft.emptyGraceSec, min: 10, max: 3600, onChange: (value: number) => set({ emptyGraceSec: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Close if never joined within (seconds)'),
        h(NumberInput, { value: draft.claimGraceSec, min: 30, max: 3600, onChange: (value: number) => set({ claimGraceSec: value }) }))),
    h('label', { className: 'check-row' },
      h('input', { type: 'checkbox', checked: !!draft.enabled, onChange: (e: any) => set({ enabled: e.target.checked }) }),
      h('span', null, 'Create a room when someone joins the hub')),

    h('div', { className: 'sub-head' }, `Open rooms (${(data.rooms || []).length})`),
    (data.rooms || []).length === 0
      ? h('p', { className: 'empty-line muted' }, 'No rooms are open.')
      : h('div', { className: 'rule-list' }, (data.rooms || []).map((room: any) =>
          h('div', { className: 'rule-row', key: room.channelId },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('span', { className: 'rule-scope' }, h(FiHash), room.name),
                h('span', { className: 'chip' }, `${room.occupants} in`),
                room.locked ? h('span', { className: 'chip chip-warn' }, 'locked') : null),
              h('div', { className: 'rule-next muted' }, `Owner: ${room.ownerName}`)),
            h('div', { className: 'rule-actions' },
              h('button', { className: 'icon-btn icon-danger', title: 'Close room', 'aria-label': 'Close room', onClick: () => close(room) }, h(FiTrash2)))))),

    h(SaveBar, { dirty, busy, onSave: save, onDiscard: () => setDraft(data.voiceSettings) }));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
