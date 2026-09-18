import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiClock, FiPlus, FiTrash2, FiSend, FiHash } from 'react-icons/fi';
import { delJson, getJson, patchJson, postJson } from '../shared/api.js';
import { Select, channelOptions } from '../shared/select.js';
import { Switch, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;
const BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

const TYPES = [
  ['interval', 'Every N'],
  ['weekly', 'Weekly'],
  ['monthly', 'Monthly'],
  ['once', 'On a date'],
];
const UNITS = [['second', 'seconds'], ['minute', 'minutes'], ['hour', 'hours'], ['day', 'days'], ['week', 'weeks'], ['month', 'months']];
const WEEKDAYS = [['0', 'Sun'], ['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat']];

function App() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => { refresh(); }, []);
  async function refresh() { setLoading(true); try { setData(await getJson('/api/config')); } catch (e: any) { flash('error', e.message); } finally { setLoading(false); } }
  function flash(tone: string, text: string) { setToast({ tone, text }); if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600); }

  if (loading || !data) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const channels = data.channels || [];
  const reminders = data.reminders || [];

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null, h('h1', null, 'Reminders'), h('p', { className: 'muted' }, `Scheduled and recurring messages for ${BOT_NAME}. Times use the bot host's local time, and changes take effect right away.`))),

    h(Section, { title: 'Scheduled messages', desc: 'Pause, post now, or delete a reminder.' },
      reminders.length === 0
        ? h('p', { className: 'empty-line muted' }, 'No reminders yet.')
        : h('div', { className: 'rule-list' }, reminders.map((r: any) => h(ReminderRow, {
            key: r.id, reminder: r, channels,
            onToggle: () => toggle(r.id), onRemove: () => remove(r.id), onTest: () => test(r.id),
          })))),

    h(AddForm, { channels, flash, onAdd: (list: any[]) => setData((d: any) => ({ ...d, reminders: list })) }),
  );

  async function toggle(id: string) { try { const r = await patchJson(`/api/reminder/${encodeURIComponent(id)}/toggle`, {}); setData((d: any) => ({ ...d, reminders: r.reminders })); } catch (e: any) { flash('error', e.message); } }
  async function remove(id: string) { if (!(await confirmDialog({ title: 'Delete this reminder?', message: 'Pause it instead if you may want it back.', confirmLabel: 'Delete', danger: true }))) return; try { const r = await delJson(`/api/reminder/${encodeURIComponent(id)}`); setData((d: any) => ({ ...d, reminders: r.reminders })); flash('info', 'Reminder removed.'); } catch (e: any) { flash('error', e.message); } }
  async function test(id: string) {
    const reminder = reminders.find((r: any) => r.id === id);
    const where = channels.find((c: any) => c.id === reminder?.channelId)?.name;
    if (!(await confirmDialog({ title: 'Post this reminder now?', message: `It is sent to ${where ? '#' + where : 'its channel'} straight away. The schedule is not changed.`, confirmLabel: 'Post now' }))) return;
    try { await postJson(`/api/reminder/${encodeURIComponent(id)}/test`, {}); flash('ok', 'Sent now.'); } catch (e: any) { flash('error', e.message); } }
}

function Section({ title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(FiClock)), h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function ReminderRow({ reminder, channels, onToggle, onRemove, onTest }: any) {
  const channelName = channels.find((c: any) => c.id === reminder.channelId)?.name || reminder.channelId;
  const next = reminder.enabled && reminder.nextRunAt ? new Date(reminder.nextRunAt).toLocaleString() : null;
  return h('div', { className: `rule-row ${reminder.enabled ? '' : 'is-off'}` },
    h('div', { className: 'rule-main' },
      h('div', { className: 'rule-top' },
        reminder.enabled ? null : h('span', { className: 'row-state' }, 'Paused'),
        h('span', { className: 'tag' }, reminder.describe || reminder.schedule?.type),
        reminder.embed ? h('span', { className: 'tag' }, 'embed') : null,
        h('span', { className: 'rule-scope' }, h(FiHash), channelName)),
      h('div', { className: 'rule-message' }, reminder.message || reminder.embed?.title || reminder.embed?.description || ''),
      next ? h('div', { className: 'rule-next muted' }, `Next: ${next}`) : null),
    h('div', { className: 'rule-actions' },
      h('button', { type: 'button', className: 'btn btn-quiet btn-sm', onClick: onTest }, h(FiSend), 'Post now'),
      h(Switch, { checked: !!reminder.enabled, label: reminder.enabled ? 'Pause reminder' : 'Resume reminder', onChange: onToggle }),
      h('button', { className: 'icon-btn icon-danger', title: 'Delete', 'aria-label': 'Delete reminder', onClick: onRemove }, h(FiTrash2))));
}

function AddForm({ channels, flash, onAdd }: any) {
  const [channelId, setChannelId] = useState('');
  const [message, setMessage] = useState('');
  const [type, setType] = useState('interval');
  const [every, setEvery] = useState('1');
  const [unit, setUnit] = useState('hour');
  const [days, setDays] = useState<string[]>(['1']);
  const [time, setTime] = useState('09:00');
  const [day, setDay] = useState('1');
  const [date, setDate] = useState('');
  const [busy, setBusy] = useState(false);
  // Optional embed. Off by default so the common case stays one text field.
  const [useEmbed, setUseEmbed] = useState(false);
  const [embedTitle, setEmbedTitle] = useState('');
  const [embedDescription, setEmbedDescription] = useState('');
  const [embedColor, setEmbedColor] = useState('#f2596b');

  function buildSchedule(): any {
    if (type === 'interval') return { type, every: Number(every), unit };
    if (type === 'weekly') return { type, days: days.map(Number), time };
    if (type === 'monthly') return { type, day: Number(day), time };
    if (type === 'once') return { type, date, time };
    return { type };
  }

  function toggleDay(d: string) {
    setDays((cur) => cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]);
  }

  function buildEmbed() {
    if (!useEmbed) return null;
    if (!embedTitle.trim() && !embedDescription.trim()) return null;
    return { title: embedTitle, description: embedDescription, color: embedColor };
  }

  async function add() {
    if (!channelId) { flash('error', 'Choose a channel.'); return; }
    const embed = buildEmbed();
    if (!message.trim() && !embed) { flash('error', 'Add a message, or an embed title or description.'); return; }
    setBusy(true);
    try {
      const r = await postJson('/api/reminder', { channelId, message, embed, schedule: buildSchedule() });
      onAdd(r.reminders);
      setMessage('');
      setEmbedTitle('');
      setEmbedDescription('');
      flash('ok', 'Reminder added.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  return h('section', { className: 'card' },
    h('div', { className: 'card-head' }, h('span', { className: 'card-icon' }, h(FiPlus)), h('div', null, h('h2', null, 'New reminder'), h('p', { className: 'muted' }, 'Recurring by interval or weekday, monthly, or a one-off calendar date.'))),
    h('div', { className: 'card-body' },
      h('div', { className: 'form-grid' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel'),
          h(Select, { value: channelId, placeholder: 'Choose a channel…', options: channelOptions(channels), onChange: setChannelId })),
        h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Schedule type'),
          h('div', { className: 'segmented' }, TYPES.map(([v, label]) => h('button', { key: v, type: 'button', className: `seg ${type === v ? 'is-active' : ''}`, onClick: () => setType(v) }, label))))),

      type === 'interval' ? h('div', { className: 'form-grid' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Every'),
          h('input', { className: 'input', type: 'number', min: 1, value: every, onChange: (e: any) => setEvery(e.target.value) })),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Unit'),
          h(Select, { value: unit, options: UNITS.map(([v, label]) => ({ value: v, label })), onChange: setUnit }))) : null,

      type === 'weekly' ? h(React.Fragment, null,
        h('div', { className: 'field' }, h('span', { className: 'field-label' }, 'Days'),
          h('div', { className: 'day-picker' }, WEEKDAYS.map(([v, label]) => h('button', { key: v, type: 'button', className: `day-chip ${days.includes(v) ? 'is-active' : ''}`, onClick: () => toggleDay(v) }, label)))),
        h('label', { className: 'field field-narrow' }, h('span', { className: 'field-label' }, 'Time (HH:MM)'),
          h('input', { className: 'input', type: 'time', value: time, onChange: (e: any) => setTime(e.target.value) }))) : null,

      type === 'monthly' ? h('div', { className: 'form-grid' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Day of month (1–31)'),
          h('input', { className: 'input', type: 'number', min: 1, max: 31, value: day, onChange: (e: any) => setDay(e.target.value) })),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Time (HH:MM)'),
          h('input', { className: 'input', type: 'time', value: time, onChange: (e: any) => setTime(e.target.value) }))) : null,

      type === 'once' ? h('div', { className: 'form-grid' },
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Date'),
          h('input', { className: 'input', type: 'date', value: date, onChange: (e: any) => setDate(e.target.value) })),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Time (HH:MM)'),
          h('input', { className: 'input', type: 'time', value: time, onChange: (e: any) => setTime(e.target.value) }))) : null,

      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Message'),
        h('textarea', { className: 'input textarea', rows: 3, value: message, placeholder: 'The message to post. Placeholders: {time} {date}', onChange: (e: any) => setMessage(e.target.value) })),

      h('label', { className: 'embed-toggle' },
        h('input', { type: 'checkbox', checked: useEmbed, onChange: (e: any) => setUseEmbed(e.target.checked) }),
        h('span', null, 'Post an embed as well (or instead — the message can be left empty)')),

      useEmbed ? h(React.Fragment, null,
        h('div', { className: 'form-grid' },
          h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Embed title'),
            h('input', { className: 'input', value: embedTitle, placeholder: 'Weekly reset', onChange: (e: any) => setEmbedTitle(e.target.value) })),
          h('label', { className: 'field field-narrow' }, h('span', { className: 'field-label' }, 'Colour'),
            h('input', { className: 'input', type: 'color', value: embedColor, onChange: (e: any) => setEmbedColor(e.target.value) }))),
        h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Embed description'),
          h('textarea', {
            className: 'input textarea', rows: 3, value: embedDescription,
            placeholder: 'Supports the same {time} and {date} placeholders.',
            onChange: (e: any) => setEmbedDescription(e.target.value),
          }))) : null,

      h('div', { className: 'row-end' }, h('button', { className: 'btn btn-accent', disabled: busy, onClick: add }, h(FiPlus), busy ? 'Adding…' : 'Add reminder'))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
