import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  FiAlertTriangle,
  FiExternalLink,
  FiImage,
  FiKey,
  FiLock,
  FiPlus,
  FiShield,
  FiSlash,
  FiTrash2,
  FiX,
} from 'react-icons/fi';
import { delJson, getJson, postJson } from '../shared/api.js';
import { SaveBar, confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __PREFIX__: string;
const PREFIX = typeof __PREFIX__ === 'string' && __PREFIX__ ? __PREFIX__ : '!';
const MAX_BLACKLIST = 200;

type Settings = { nsfw: boolean; blacklist: string[]; disabledSites: string[] };
type Site = {
  id: string;
  name: string;
  aliases: string[];
  description: string;
  nsfwOnly: boolean;
  safeOnly: boolean;
  requiresCredentials: boolean;
  configured: boolean;
};
type Account = {
  id: string;
  name: string;
  userLabel: string | null;
  keyLabel: string;
  required: boolean;
  helpUrl: string;
  help: string;
  state: 'missing' | 'stored' | 'unreadable';
  user: string;
  sites: string[];
};

function App() {
  const [loading, setLoading] = useState(true);
  const [sites, setSites] = useState<Site[]>([]);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [form, setForm] = useState<Settings | null>(null);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [toast, setToast] = useState<{ tone: string; text: string } | null>(null);

  useEffect(() => {
    refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const data = await getJson('/api/config');
      setSites(data.sites);
      setAccounts(data.accounts);
      setForm(data.settings);
      setSaved(data.settings);
      setDirty(false);
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setLoading(false);
    }
  }

  function flash(tone: string, text: string) {
    setToast({ tone, text });
    if (tone !== 'error') setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), 3600);
  }

  function edit(patch: Partial<Settings>) {
    setForm((f) => (f ? { ...f, ...patch } : f));
    setDirty(true);
  }

  function addTags() {
    if (!form) return;
    const incoming = draft
      .split(/[\s,]+/)
      // Same cleanup as the server's normalizeBlacklist, so chips match what gets saved.
      .map((tag) => tag.toLowerCase().replace(/[`\x00-\x1f\x7f]/g, '').trim().slice(0, 80).replace(/^[-~]/, ''))
      .filter(Boolean);
    const next = [...form.blacklist];
    for (const tag of incoming) if (!next.includes(tag) && next.length < MAX_BLACKLIST) next.push(tag);
    if (next.length !== form.blacklist.length) edit({ blacklist: next });
    setDraft('');
  }

  function toggleSite(id: string, enabled: boolean) {
    if (!form) return;
    const disabled = form.disabledSites.filter((siteId) => siteId !== id);
    edit({ disabledSites: enabled ? disabled : [...disabled, id] });
  }

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      const result = await postJson('/api/settings', form);
      setForm(result.settings);
      setSaved(result.settings);
      setDirty(false);
      flash('ok', 'Settings saved.');
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  function discard() {
    setForm(saved);
    setDraft('');
    setDirty(false);
  }

  function accountChanged(result: any) {
    setAccounts((list) => (list ? list.map((a) => (a.id === result.account.id ? result.account : a)) : list));
    setSites(result.sites);
  }

  if (loading || !form) return h('div', { className: 'wrap' }, h('div', { className: 'muted', style: { padding: 40 } }, 'Loading…'));

  const missingRequired = (accounts || []).filter((a) => a.required && a.state !== 'stored');

  return h('div', { className: 'wrap' },
    toast ? h('div', { className: `toast toast-${toast.tone}` }, toast.text) : null,
    h('header', { className: 'page-head' },
      h('div', null,
        h('h1', null, 'Booru'),
        h('p', { className: 'muted' },
          'Random images by tag with ', h('code', null, `${PREFIX}booru <site> [tags]`), ' or a site shortcut such as ',
          h('code', null, `${PREFIX}danbooru cat_ears`), '.'))),

    missingRequired.length
      ? h('div', { className: 'status-banner warn' },
          h(FiAlertTriangle),
          h('span', null, `${missingRequired.map((a) => a.name).join(' and ')} ${missingRequired.length === 1 ? 'needs' : 'need'} an account before ${missingRequired.length === 1 ? 'it' : 'they'} can be searched.`))
      : null,

    h(Section, { icon: FiShield, title: 'Content', desc: 'Applies to this server.' },
      h(Toggle, {
        title: 'Adult results in NSFW channels',
        desc: 'When off, every channel only gets general-rated posts and adult-only sites are refused.',
        checked: form.nsfw,
        onChange: (value: boolean) => edit({ nsfw: value }),
      }),
      h('p', { className: 'note' },
        h(FiLock),
        h('span', null, 'Always on, in every server: channels not marked NSFW only get general-rated posts.'))),

    h(Section, { icon: FiImage, title: 'Sites', desc: 'Turn sites off for this server. Shortcuts work as commands on their own.' },
      h('div', { className: 'site-list' },
        sites.map((site) => {
          const enabled = !form.disabledSites.includes(site.id);
          return h('div', { key: site.id, className: `site-row ${enabled ? '' : 'off'}` },
            h('div', { className: 'site-text' },
              h('div', { className: 'site-title' },
                h('span', { className: 'site-name' }, site.name),
                site.nsfwOnly ? h('span', { className: 'badge' }, 'NSFW only') : null,
                site.safeOnly ? h('span', { className: 'badge' }, 'Safe only') : null,
                site.requiresCredentials && !site.configured ? h('span', { className: 'badge warn' }, 'Needs account') : null),
              h('span', { className: 'site-desc' }, site.description),
              h('span', { className: 'site-names' },
                [site.id, ...site.aliases].map((name) => h('code', { key: name }, `${PREFIX}${name}`)))),
            h('input', {
              type: 'checkbox',
              className: 'switch',
              checked: enabled,
              'aria-label': `${site.name} enabled`,
              onChange: (e: any) => toggleSite(site.id, e.target.checked),
            }));
        }))),

    h(Section, { icon: FiSlash, title: 'Blacklist', desc: 'Posts with any of these tags are never shown in this server. Matches whole words, so "spider" also hides "giant_spider".' },
      h('div', { className: 'tag-add' },
        h('input', {
          className: 'input',
          value: draft,
          placeholder: 'Tags, separated by spaces',
          'aria-label': 'Tags to blacklist',
          onChange: (e: any) => setDraft(e.target.value),
          onKeyDown: (e: any) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addTags();
            }
          },
        }),
        h('button', { className: 'btn', onClick: addTags, disabled: !draft.trim() }, h(FiPlus), 'Add')),
      form.blacklist.length
        ? h('div', { className: 'chips' },
            form.blacklist.map((tag) =>
              h('span', { key: tag, className: 'chip' },
                h('span', null, tag),
                h('button', {
                  className: 'chip-x',
                  'aria-label': `Remove ${tag}`,
                  onClick: () => edit({ blacklist: form.blacklist.filter((t) => t !== tag) }),
                }, h(FiX)))))
        : h('p', { className: 'faint small' }, 'No tags blacklisted.'),
      h('span', { className: 'field-hint' }, `${form.blacklist.length} / ${MAX_BLACKLIST} tags`)),

    accounts
      ? h(Section, {
          icon: FiKey,
          title: 'Site accounts',
          desc: 'Shared by every server the bot is in. Keys are encrypted before they are written to disk and are never shown again after saving.',
        },
          accounts.map((account) => h(AccountRow, { key: account.id, account, onChanged: accountChanged, flash })))
      : h('p', { className: 'faint small' }, 'Site accounts are managed by the bot owner.'),

    // Accounts save on their own ("Verify and save"); the bar is only for the
    // server settings above them.
    h(SaveBar, { dirty, busy, onSave: save, onDiscard: discard, message: 'Unsaved server settings' }));
}

function AccountRow({ account, onChanged, flash }: { account: Account; onChanged: (result: any) => void; flash: (tone: string, text: string) => void }) {
  const stored = account.state === 'stored';
  const [editing, setEditing] = useState(!stored);
  const [user, setUser] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; canForce: boolean } | null>(null);

  useEffect(() => {
    if (!stored) setEditing(true);
  }, [stored]);

  function reset() {
    setUser('');
    setKey('');
    setError(null);
  }

  async function submit(force: boolean) {
    setBusy(true);
    setError(null);
    try {
      const result = await postJson(`/api/accounts/${account.id}`, { user, key, force });
      onChanged(result);
      reset();
      setEditing(false);
      flash('ok', force ? `${account.name} account saved without a check.` : `${account.name} account verified and saved.`);
    } catch (e: any) {
      setError({ text: e.message, canForce: Boolean(e.data?.canForce) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await confirmDialog({
      title: `Remove the ${account.name} account?`,
      message: 'The key is deleted from disk. Sites that need it stop working until you add it again.',
      confirmLabel: 'Remove account',
      danger: true,
    }))) return;
    setBusy(true);
    try {
      const result = await delJson(`/api/accounts/${account.id}`);
      onChanged(result);
      reset();
      setEditing(true);
      flash('ok', `${account.name} account removed.`);
    } catch (e: any) {
      flash('error', e.message);
    } finally {
      setBusy(false);
    }
  }

  const status = stored
    ? h('span', { className: 'badge ok' }, 'Saved')
    : account.state === 'unreadable'
      ? h('span', { className: 'badge warn' }, 'Unreadable, enter again')
      : h('span', { className: `badge ${account.required ? 'warn' : ''}` }, account.required ? 'Required' : 'Optional');

  const ready = key.trim() && (!account.userLabel || user.trim());

  return h('div', { className: 'account' },
    h('div', { className: 'account-head' },
      h('div', { className: 'account-title' },
        h('span', { className: 'site-name' }, account.name),
        status),
      h('a', { className: 'btn btn-quiet', href: account.helpUrl, target: '_blank', rel: 'noopener noreferrer' }, h(FiExternalLink), 'Get a key')),
    h('p', { className: 'faint small' }, account.help),

    stored && !editing
      ? h('div', { className: 'account-saved' },
          h('span', { className: 'muted' }, account.userLabel ? `${account.userLabel}: ` : 'Key saved', account.userLabel ? h('strong', null, account.user) : null),
          h('div', { className: 'account-actions' },
            h('button', { className: 'btn', disabled: busy, onClick: () => setEditing(true) }, 'Replace'),
            h('button', { className: 'btn btn-danger', disabled: busy, onClick: remove }, h(FiTrash2), 'Remove')))
      : h('form', {
          className: 'account-form',
          autoComplete: 'off',
          onSubmit: (e: any) => {
            e.preventDefault();
            if (ready && !busy) submit(false);
          },
        },
          h('div', { className: account.userLabel ? 'form-grid' : '' },
            account.userLabel
              ? h('label', { className: 'field' },
                  h('span', { className: 'field-label' }, account.userLabel),
                  h('input', {
                    className: 'input',
                    value: user,
                    'aria-label': `${account.name} ${account.userLabel}`,
                    inputMode: account.userLabel === 'User ID' ? 'numeric' : undefined,
                    autoComplete: 'off',
                    spellCheck: false,
                    onChange: (e: any) => setUser(e.target.value),
                  }))
              : null,
            h('label', { className: 'field' },
              h('span', { className: 'field-label' }, account.keyLabel),
              h('input', {
                className: 'input',
                type: 'password',
                'aria-label': `${account.name} ${account.keyLabel}`,
                value: key,
                autoComplete: 'new-password',
                spellCheck: false,
                onChange: (e: any) => setKey(e.target.value),
              }))),
          error
            ? h('div', { className: 'account-error' },
                h(FiAlertTriangle),
                h('span', null, error.text),
                error.canForce
                  ? h('button', { type: 'button', className: 'btn btn-quiet', disabled: busy, onClick: () => submit(true) }, 'Save anyway')
                  : null)
            : null,
          h('div', { className: 'account-actions' },
            stored
              ? h('button', { type: 'button', className: 'btn btn-ghost', disabled: busy, onClick: () => { reset(); setEditing(false); } }, 'Cancel')
              : null,
            h('button', { type: 'submit', className: 'btn btn-accent', disabled: busy || !ready }, h(FiKey), busy ? 'Checking…' : 'Verify and save'))));
}

function Section({ icon, title, desc, children }: any) {
  return h('section', { className: 'card' },
    h('div', { className: 'card-head' },
      h('span', { className: 'card-icon' }, h(icon)),
      h('div', null, h('h2', null, title), desc ? h('p', { className: 'muted' }, desc) : null)),
    h('div', { className: 'card-body' }, children));
}

function Toggle({ title, desc, checked, onChange }: any) {
  return h('label', { className: 'toggle-row' },
    h('div', { className: 'tr-text' }, h('span', { className: 'tr-title' }, title), h('span', { className: 'tr-desc' }, desc)),
    h('input', { type: 'checkbox', className: 'switch', 'aria-label': title, checked: !!checked, onChange: (e: any) => onChange(e.target.checked) }));
}

const rootElement = document.getElementById('root');
if (rootElement) createRoot(rootElement).render(h(App));
