import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiAward, FiBarChart2, FiPlus, FiRefreshCw, FiStopCircle, FiTrash2 } from 'react-icons/fi';
import { getJson, postJson } from '../shared/api.js';
import { Select, channelOptions, namedOptions, noneOption } from '../shared/select.js';
import { NumberInput, confirmDialog } from '../shared/ui.js';

const h = React.createElement;

const DURATIONS = [
  ['600000', '10 minutes'],
  ['3600000', '1 hour'],
  ['21600000', '6 hours'],
  ['86400000', '1 day'],
  ['259200000', '3 days'],
  ['604800000', '7 days'],
];

function relative(timestamp: number | null): string {
  if (!timestamp) return 'no end time';
  const delta = timestamp - Date.now();
  if (delta <= 0) return 'ended';
  const minutes = Math.round(delta / 60000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours}h` : `in ${Math.round(hours / 24)}d`;
}

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
        h('h1', null, 'Polls & giveaways'),
        h('p', { className: 'muted' }, 'Both post a message and count reactions. Closing a poll publishes the results; ending a giveaway draws the winners.'))),

    h(NewPoll, { data, setData, flash }),
    h(PollList, { data, setData, flash }),
    h(NewGiveaway, { data, setData, flash }),
    h(GiveawayList, { data, setData, flash }),
  );
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function NewPoll({ data, setData, flash }: any) {
  const [channelId, setChannelId] = useState('');
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState('');
  const [durationMs, setDurationMs] = useState('');
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!channelId) { flash('error', 'Choose a channel.'); return; }
    if (!question.trim()) { flash('error', 'Write a question.'); return; }
    setBusy(true);
    try {
      const response = await postJson('/api/poll', {
        channelId,
        question,
        options: options.split('\n').map((option) => option.trim()).filter(Boolean),
        multi,
        anonymous,
        durationMs: durationMs ? Number(durationMs) : null,
      });
      setData((current: any) => ({ ...current, polls: response.polls }));
      setQuestion('');
      setOptions('');
      flash('ok', 'Poll posted.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  return h(Section, { icon: FiPlus, title: 'New poll', desc: `Leave the options empty for a yes/no poll. Up to ${data.maxOptions} options.` },
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel'),
        h(Select, { value: channelId, placeholder: 'Choose a channel…', options: channelOptions(data.channels), onChange: setChannelId })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Closes after'),
        h(Select, { value: durationMs, options: [noneOption('Close it by hand'), ...DURATIONS.map(([value, label]) => ({ value, label }))], onChange: setDurationMs }))),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Question'),
      h('input', { className: 'input', value: question, placeholder: 'Should we move game night to Friday?', onChange: (e: any) => setQuestion(e.target.value) })),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Options, one per line'),
      h('textarea', { className: 'input textarea', rows: 4, value: options, placeholder: 'Friday\nSaturday\nKeep it on Sunday', onChange: (e: any) => setOptions(e.target.value) })),
    h('div', { className: 'grid-2' },
      h('label', { className: 'check-row' },
        h('input', { type: 'checkbox', checked: multi, onChange: (e: any) => setMulti(e.target.checked) }),
        h('span', null, 'Allow voting for several options')),
      h('label', { className: 'check-row' },
        h('input', { type: 'checkbox', checked: anonymous, onChange: (e: any) => setAnonymous(e.target.checked) }),
        h('span', null, 'Hide who voted in the results'))),
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-accent', disabled: busy, onClick: create }, h(FiPlus), busy ? 'Posting…' : 'Post poll')));
}

function PollList({ data, setData, flash }: any) {
  const polls = data.polls || [];

  async function close(poll: any) {
    const ok = await confirmDialog({ title: 'Close this poll?', message: 'The results are posted to the channel straight away.', confirmLabel: 'Close poll' });
    if (!ok) return;
    try {
      const response = await postJson('/api/poll/close', { id: poll.id });
      setData((current: any) => ({ ...current, polls: response.polls }));
      flash('ok', 'Poll closed.');
    } catch (e: any) { flash('error', e.message); }
  }

  async function remove(poll: any) {
    const ok = await confirmDialog({ title: 'Delete this poll?', message: 'The record is removed; the message stays in the channel.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/poll/delete', { id: poll.id });
      setData((current: any) => ({ ...current, polls: response.polls }));
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, { icon: FiBarChart2, title: `Polls (${polls.length})` },
    polls.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No polls yet.')
      : h('div', { className: 'list-scroll' }, polls.map((poll: any) =>
          h('div', { className: `rule-row ${poll.closed ? 'is-off' : ''}`, key: poll.id },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('span', { className: 'tag' }, poll.closed ? 'closed' : relative(poll.endsAt)),
                h('strong', null, poll.question),
                h('span', { className: 'chip' }, `${poll.totalVotes} votes`)),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 } },
                poll.options.map((option: string, index: number) => {
                  const votes = poll.votes[index] || 0;
                  const share = poll.totalVotes ? Math.round((votes / poll.totalVotes) * 100) : 0;
                  return h('div', { key: index },
                    h('div', { className: 'rule-next muted' }, `${index + 1}. ${option} — ${votes} (${share}%)`),
                    h('div', { className: 'bar-track' }, h('div', { className: 'bar-fill', style: { width: `${share}%` } })));
                }))),
            h('div', { className: 'rule-actions' },
              poll.closed ? null : h('button', { className: 'btn btn-quiet btn-sm', onClick: () => close(poll) }, h(FiStopCircle), 'Close'),
              h('button', { className: 'icon-btn icon-danger', title: 'Delete poll', 'aria-label': 'Delete poll', onClick: () => remove(poll) }, h(FiTrash2)))))));
}

function NewGiveaway({ data, setData, flash }: any) {
  const [form, setForm] = useState<any>({
    channelId: '', prize: '', description: '', winnerCount: 1, durationMs: '3600000',
    minLevel: 0, minAccountAgeDays: 0, requiredRoleId: '', bonusRoleId: '', bonusEntries: 2,
  });
  const [busy, setBusy] = useState(false);
  const set = (patch: any) => setForm((current: any) => ({ ...current, ...patch }));

  async function create() {
    if (!form.channelId) { flash('error', 'Choose a channel.'); return; }
    if (!form.prize.trim()) { flash('error', 'Name the prize.'); return; }
    setBusy(true);
    try {
      const response = await postJson('/api/giveaway', {
        channelId: form.channelId,
        prize: form.prize,
        description: form.description,
        winnerCount: form.winnerCount,
        durationMs: Number(form.durationMs),
        minLevel: form.minLevel,
        minAccountAgeDays: form.minAccountAgeDays,
        requiredRoleIds: form.requiredRoleId ? [form.requiredRoleId] : [],
        bonusRoles: form.bonusRoleId ? [{ roleId: form.bonusRoleId, entries: form.bonusEntries }] : [],
      });
      setData((current: any) => ({ ...current, giveaways: response.giveaways }));
      set({ prize: '', description: '' });
      flash('ok', 'Giveaway posted.');
    } catch (e: any) { flash('error', e.message); } finally { setBusy(false); }
  }

  return h(Section, { icon: FiPlus, title: 'New giveaway', desc: 'Members enter by adding the party-popper reaction the bot places on the post. Requirements are checked the moment they react.' },
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Channel'),
        h(Select, { value: form.channelId, placeholder: 'Choose a channel…', options: channelOptions(data.channels), onChange: (value: string) => set({ channelId: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Runs for'),
        h(Select, { value: form.durationMs, options: DURATIONS.map(([value, label]) => ({ value, label })), onChange: (value: string) => set({ durationMs: value }) }))),
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Prize'),
        h('input', { className: 'input', value: form.prize, placeholder: 'Steam key', onChange: (e: any) => set({ prize: e.target.value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Winners'),
        h(NumberInput, { value: form.winnerCount, min: 1, max: 20, onChange: (value: number) => set({ winnerCount: value }) }))),
    h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Description (optional)'),
      h('textarea', { className: 'input textarea', rows: 2, value: form.description, onChange: (e: any) => set({ description: e.target.value }) })),
    h('div', { className: 'sub-head' }, 'Entry requirements'),
    h('div', { className: 'grid-3' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Minimum level'),
        h(NumberInput, { value: form.minLevel, min: 0, max: 500, onChange: (value: number) => set({ minLevel: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Account age (days)'),
        h(NumberInput, { value: form.minAccountAgeDays, min: 0, max: 3650, onChange: (value: number) => set({ minAccountAgeDays: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Required role'),
        h(Select, { value: form.requiredRoleId, options: [noneOption('Anyone'), ...namedOptions(data.roles)], onChange: (value: string) => set({ requiredRoleId: value }) }))),
    h('div', { className: 'grid-2' },
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Bonus role (extra entries)'),
        h(Select, { value: form.bonusRoleId, options: [noneOption('None'), ...namedOptions(data.roles)], onChange: (value: string) => set({ bonusRoleId: value }) })),
      h('label', { className: 'field' }, h('span', { className: 'field-label' }, 'Entries for that role'),
        h(NumberInput, { value: form.bonusEntries, min: 1, max: 10, onChange: (value: number) => set({ bonusEntries: value }) }))),
    h('div', { className: 'row-end' },
      h('button', { className: 'btn btn-accent', disabled: busy, onClick: create }, h(FiPlus), busy ? 'Posting…' : 'Start giveaway')));
}

function GiveawayList({ data, setData, flash }: any) {
  const giveaways = data.giveaways || [];

  async function end(giveaway: any) {
    const ok = await confirmDialog({ title: `End "${giveaway.prize}" now?`, message: 'Winners are drawn immediately and announced in the channel.', confirmLabel: 'End and draw' });
    if (!ok) return;
    try {
      const response = await postJson('/api/giveaway/end', { id: giveaway.id });
      setData((current: any) => ({ ...current, giveaways: response.giveaways }));
      flash('ok', `Drew ${response.winners?.length || 0} winner(s).`);
    } catch (e: any) { flash('error', e.message); }
  }

  async function reroll(giveaway: any) {
    const ok = await confirmDialog({ title: `Reroll "${giveaway.prize}"?`, message: 'New winners are drawn from the remaining entrants and announced in the channel.', confirmLabel: 'Reroll' });
    if (!ok) return;
    try {
      const response = await postJson('/api/giveaway/reroll', { id: giveaway.id });
      setData((current: any) => ({ ...current, giveaways: response.giveaways }));
      flash('ok', `New winner(s) drawn.`);
    } catch (e: any) { flash('error', e.message); }
  }

  async function remove(giveaway: any) {
    const ok = await confirmDialog({ title: 'Delete this giveaway?', message: 'The record is removed; the message stays in the channel.', confirmLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      const response = await postJson('/api/giveaway/delete', { id: giveaway.id });
      setData((current: any) => ({ ...current, giveaways: response.giveaways }));
    } catch (e: any) { flash('error', e.message); }
  }

  return h(Section, { icon: FiAward, title: `Giveaways (${giveaways.length})` },
    giveaways.length === 0
      ? h('p', { className: 'empty-line muted' }, 'No giveaways yet.')
      : h('div', { className: 'list-scroll' }, giveaways.map((giveaway: any) =>
          h('div', { className: `rule-row ${giveaway.ended ? 'is-off' : ''}`, key: giveaway.id },
            h('div', { className: 'rule-main' },
              h('div', { className: 'rule-top' },
                h('span', { className: 'tag' }, giveaway.ended ? 'ended' : relative(giveaway.endsAt)),
                h('strong', null, giveaway.prize),
                h('span', { className: 'chip' }, `${giveaway.entryCount ?? 0} entries`),
                h('span', { className: 'chip' }, `${giveaway.winnerCount} winner(s)`)),
              giveaway.winnerNames?.length
                ? h('div', { className: 'rule-next muted' }, `Winners: ${giveaway.winnerNames.join(', ')}`)
                : giveaway.ended ? h('div', { className: 'rule-next muted' }, 'No eligible entries.') : null),
            h('div', { className: 'rule-actions' },
              giveaway.ended
                ? h('button', { className: 'btn btn-quiet btn-sm', onClick: () => reroll(giveaway) }, h(FiRefreshCw), 'Reroll')
                : h('button', { className: 'btn btn-quiet btn-sm', onClick: () => end(giveaway) }, h(FiStopCircle), 'End now'),
              h('button', { className: 'icon-btn icon-danger', title: 'Delete giveaway', 'aria-label': 'Delete giveaway', onClick: () => remove(giveaway) }, h(FiTrash2)))))));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
