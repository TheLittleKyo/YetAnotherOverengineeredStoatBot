import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FiCheck, FiCopy, FiEdit3, FiRefreshCw, FiSave, FiSend, FiTrash2 } from 'react-icons/fi';
import { API_BASE, getJson, postJson } from '../shared/api.js';
import { MANUAL_ID_OPTION, Select, channelOptions, noneOption } from '../shared/select.js';
import { confirmDialog } from '../shared/ui.js';

const h = React.createElement;
declare const __BOT_NAME__: string;

const DEFAULT_BOT_NAME = typeof __BOT_NAME__ === 'string' && __BOT_NAME__.trim() ? __BOT_NAME__.trim() : 'YetAnotherOverengineeredStoatBot';

function createDefaultEmbed(botName = DEFAULT_BOT_NAME) {
  return {
    content: '',
    title: `${botName} Embed`,
    description: 'Write your custom embed description here.',
    color: '#fd6671',
    url: '',
  };
}

const defaultEmbed = createDefaultEmbed();

function App() {
  const [embed, setEmbed] = useState(defaultEmbed);
  const [botName, setBotName] = useState(DEFAULT_BOT_NAME);
  const [name, setName] = useState('New embed');
  const [currentId, setCurrentId] = useState(null);
  const [channelId, setChannelId] = useState('');
  const [channels, setChannels] = useState([]);
  const [savedEmbeds, setSavedEmbeds] = useState([]);
  const [mentionLabels, setMentionLabels] = useState({ users: {}, channels: {}, roles: {} });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');

  useEffect(() => {
    Promise.all([loadConfig(), refreshEmbeds()])
      .then(([config]) => {
        const nextBotName = normalizeBotName(config.botName);
        setBotName(nextBotName);
        setChannels(config.channels || []);
        setEmbed(normalizeEmbed(config.defaults || createDefaultEmbed(nextBotName)));
      })
      .catch((error) => setStatus(error.message));
  }, []);

  useEffect(() => {
    if (!status) return undefined;
    const timer = setTimeout(() => setStatus(''), 3600);
    return () => clearTimeout(timer);
  }, [status]);

  useEffect(() => {
    const mentions = extractMentionIds(`${embed.content}\n${embed.description}`);
    if (!mentions.users.length && !mentions.channels.length && !mentions.roles.length) {
      setMentionLabels({ users: {}, channels: {}, roles: {} });
      return undefined;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      resolveMentions(mentions, controller.signal)
        .then((labels) => setMentionLabels(labels))
        .catch((error) => {
          if (error.name !== 'AbortError') setStatus(`Mention sync failed: ${error.message}`);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [embed.content, embed.description]);

  const stats = useMemo(() => ({
    content: `${embed.content.length}/1800`,
    title: `${embed.title.length}/256`,
    description: `${embed.description.length}/4000`,
  }), [embed]);

  async function refreshEmbeds() {
    setLoading(true);
    try {
      const embeds = await loadEmbeds();
      setSavedEmbeds(embeds);
      return embeds;
    } finally {
      setLoading(false);
    }
  }

  function setField(key, value) {
    setEmbed((current) => normalizeEmbed({ ...current, [key]: value }));
  }

  function createNew() {
    setEmbed(createDefaultEmbed(botName));
    setName(`Embed ${savedEmbeds.length + 1}`);
    setCurrentId(null);
    setStatus('New embed draft created.');
  }

  function editSaved(saved) {
    setEmbed(normalizeEmbed(saved.embed));
    setName(saved.name);
    setCurrentId(saved.id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setStatus(`Editing "${saved.name}".`);
  }

  async function duplicateSaved(saved) {
    setEmbed(normalizeEmbed(saved.embed));
    setName(`${saved.name} copy`);
    setCurrentId(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    setStatus('Loaded a copy as a new draft.');
  }

  async function saveEmbed() {
    setSaving(true);
    try {
      const saved = currentId
        ? await updateEmbed(currentId, { name, embed })
        : await createEmbed(name, embed);
      setCurrentId(saved.id);
      setName(saved.name);
      await refreshEmbeds();
      setStatus('Embed saved to library.');
    } catch (error) {
      setStatus(error.message);
    } finally {
      setSaving(false);
    }
  }

  async function deleteSaved(saved) {
    if (!(await confirmDialog({ title: `Delete "${saved.name}"?`, message: 'Messages already sent with it stay in their channels.', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await deleteEmbed(saved.id);
      if (currentId === saved.id) setCurrentId(null);
      await refreshEmbeds();
      setStatus('Embed deleted.');
    } catch (error) {
      setStatus(error.message);
    }
  }

  async function sendCurrent() {
    try {
      const result = await sendEmbed(channelId, embed);
      setStatus(`Embed sent to ${channelId}.`);
    } catch (error) {
      setStatus(error.message);
    }
  }

  return h('div', { className: 'app' },
    h('header', { className: 'hero' },
      h('div', null,
        h('div', { className: 'eyebrow' }, `${botName} custom embeds`),
        h('h1', null, 'Embeds'),
        h('p', null, 'Build custom Stoat embeds with a live preview, save reusable versions, then send them to a channel.'),
      ),
      h('div', { className: 'hero-actions' },
        h('button', { className: 'secondary', onClick: createNew }, h(FiEdit3), 'New'),
        h('button', { className: 'secondary', onClick: refreshEmbeds }, h(FiRefreshCw), 'Refresh'),
        h('button', { className: 'primary', disabled: saving, onClick: saveEmbed }, h(FiSave), currentId ? 'Save changes' : 'Save embed'),
      ),
    ),

    h('main', { className: 'workspace' },
      h('section', { className: 'panel editor-panel' },
        h('div', { className: 'panel-head' },
          h('div', null,
            h('h2', null, currentId ? 'Editing saved embed' : 'Draft embed'),
            h('p', null, 'Stoat currently supports message content, title, description, color, and title URL for custom embeds.'),
          ),
        ),
        h(Field, { label: 'Library name', value: name, onChange: setName, max: 80 }),
        h(Field, { label: `Message content (${stats.content})`, value: embed.content, onChange: (value) => setField('content', value), textarea: true, max: 1800, placeholder: 'Optional text above the embed' }),
        h(Field, { label: `Embed title (${stats.title})`, value: embed.title, onChange: (value) => setField('title', value), max: 256 }),
        h(Field, { label: `Description (${stats.description})`, value: embed.description, onChange: (value) => setField('description', value), textarea: true, max: 4000 }),
        h('div', { className: 'grid2' },
          h(Field, { label: 'Color', value: embed.color, onChange: (value) => setField('color', value), type: 'color' }),
          h(Field, { label: 'Title URL', value: embed.url, onChange: (value) => setField('url', value), placeholder: 'https://example.com' }),
        ),
        h('div', { className: 'send-box' },
          h(SelectField, { label: 'Send to channel', value: channelId, onChange: setChannelId, placeholder: 'Choose a channel…', options: channels }),
          h('button', { className: 'primary send', onClick: sendCurrent }, h(FiSend), 'Send embed'),
        ),
      ),

      h('section', { className: 'preview-wrap' },
        h('div', { className: 'panel preview-panel' },
          h('div', { className: 'panel-head compact' },
            h('div', null, h('h2', null, 'Live preview'), h('p', null, 'This approximates how the embed will appear in chat.')),
          ),
          h(EmbedPreview, { embed, mentionLabels }),
        ),
      ),
    ),

    h('section', { className: 'library panel' },
      h('div', { className: 'panel-head' },
        h('div', null, h('h2', null, 'Saved embeds'), h('p', null, loading ? 'Loading saved embeds…' : `${savedEmbeds.length} saved embed${savedEmbeds.length === 1 ? '' : 's'}.`)),
      ),
      loading
        ? h('div', { className: 'empty' }, 'Loading…')
        : savedEmbeds.length
          ? h('div', { className: 'cards' }, savedEmbeds.map((saved) => h(SavedCard, { key: saved.id, saved, editSaved, duplicateSaved, deleteSaved, setChannelId, sendSaved: async () => { try { await sendEmbed(channelId, saved.embed); setStatus(`"${saved.name}" sent.`); } catch (error) { setStatus(error.message); } } })))
          : h('div', { className: 'empty' }, 'No saved embeds yet. Build one above and click Save embed.'),
    ),
    h('div', { className: `status ${status ? 'show' : ''}` }, status),
  );
}

function Field({ label, value, onChange, textarea = false, type = 'text', max, placeholder = '' }) {
  return h('label', { className: `field ${type === 'color' ? 'color-field' : ''}` },
    h('span', null, label),
    textarea
      ? h('textarea', { value, maxLength: max, placeholder, onChange: (event) => onChange(event.target.value) })
      : h('input', { value, type, maxLength: max, placeholder, onChange: (event) => onChange(event.target.value) }),
  );
}

function SelectField({ label, value, onChange, placeholder, options }) {
  const known = (options || []).some((o) => o.id === value);
  const [manual, setManual] = useState(!!value && !known);
  const [focusManual, setFocusManual] = useState(false);
  return h('label', { className: 'field' },
    h('span', null, label),
    manual
      ? h('div', { className: 'picker-id' },
          h('input', { value: value || '', placeholder: 'Paste channel ID', autoFocus: focusManual, onChange: (event) => onChange(event.target.value) }),
          h('button', { type: 'button', className: 'btn btn-quiet', title: 'Choose from list', onClick: () => { setManual(false); onChange(''); } }, 'List'))
      : h(Select, {
          value: value || '',
          options: [noneOption(placeholder || 'Choose…'), ...channelOptions(options), MANUAL_ID_OPTION],
          onChange: (v) => {
            if (v === MANUAL_ID_OPTION.value) { setManual(true); setFocusManual(true); onChange(''); } else onChange(v);
          },
        }),
  );
}

function EmbedPreview({ embed, mentionLabels, compact = false }) {
  const visible = embed.title || embed.description || embed.url;

  return h('div', { className: `chat-preview ${compact ? 'compact' : ''}` },
    h('div', { className: 'stoat-message-main' },
      embed.content && h(MarkdownPreview, { className: 'message-content markdown', text: embed.content, mentionLabels }),
      visible
        ? h('article', { className: 'embed-card', style: { borderLeftColor: embed.color || '#fd6671' } },
            h('div', { className: 'embed-main' },
              h('div', { className: 'embed-body' },
                embed.title && h(embed.url ? 'a' : 'h3', { className: 'embed-title', href: embed.url || undefined, target: '_blank', rel: 'noreferrer' }, embed.title),
                embed.description && h(MarkdownPreview, { className: 'embed-description markdown', text: embed.description, mentionLabels }),
              ),
            ),
          )
        : h('div', { className: 'empty-preview' }, 'Add content, title, or description to preview.'),
    ),
  );
}

function MarkdownPreview({ text, className = '', mentionLabels = { users: {}, channels: {}, roles: {} } }) {
  return h('div', { className }, renderMarkdownBlocks(String(text || ''), mentionLabels));
}

function renderMarkdownBlocks(text, mentionLabels) {
  const blocks = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```\s*([\w-]+)?\s*$/);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(h('pre', { key: `code-${blocks.length}` }, h('code', null, code.join('\n'))));
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }
      blocks.push(h('blockquote', { key: `quote-${blocks.length}` }, renderInlineWithBreaks(quoteLines.join('\n'), mentionLabels)));
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(h('ul', { key: `ul-${blocks.length}` }, items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item, mentionLabels)))));
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) {
        items.push(lines[index].replace(/^\s*\d+[.)]\s+/, ''));
        index += 1;
      }
      blocks.push(h('ol', { key: `ol-${blocks.length}` }, items.map((item, itemIndex) => h('li', { key: itemIndex }, renderInline(item, mentionLabels)))));
      continue;
    }

    const paragraph = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^```/.test(lines[index]) &&
      !/^>\s?/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    blocks.push(h('p', { key: `p-${blocks.length}` }, renderInlineWithBreaks(paragraph.join('\n'), mentionLabels)));
  }

  return blocks;
}

function renderInlineWithBreaks(text, mentionLabels) {
  const lines = String(text || '').split('\n');
  return lines.flatMap((line, index) => index === 0 ? renderInline(line, mentionLabels) : [h('br', { key: `br-${index}` }), ...renderInline(line, mentionLabels)]);
}

function renderInline(text, mentionLabels) {
  const nodes = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|\*[^*]+\*|_[^_]+_|<[@#%]!?[A-Za-z0-9_-]+>|@(everyone|here)\b|\[[^\]]+\]\(https?:\/\/[^\s)]+\)|https?:\/\/[^\s<>()]+)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(text))) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    nodes.push(renderInlineToken(match[0], nodes.length, mentionLabels));
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

function renderInlineToken(token, key, mentionLabels) {
  if (token.startsWith('`') && token.endsWith('`')) return h('code', { key }, token.slice(1, -1));
  if (token.startsWith('**') && token.endsWith('**')) return h('strong', { key }, renderInline(token.slice(2, -2), mentionLabels));
  if (token.startsWith('__') && token.endsWith('__')) return h('strong', { key }, renderInline(token.slice(2, -2), mentionLabels));
  if (token.startsWith('~~') && token.endsWith('~~')) return h('s', { key }, renderInline(token.slice(2, -2), mentionLabels));
  if (token.startsWith('*') && token.endsWith('*')) return h('em', { key }, renderInline(token.slice(1, -1), mentionLabels));
  if (token.startsWith('_') && token.endsWith('_')) return h('em', { key }, renderInline(token.slice(1, -1), mentionLabels));

  const mention = formatMentionToken(token, mentionLabels);
  if (mention) return h('span', { key, className: `mention ${mention.kind}` }, mention.label);

  const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
  if (link) return h('a', { key, href: link[2], target: '_blank', rel: 'noreferrer' }, link[1]);
  if (/^https?:\/\//.test(token)) return h('a', { key, href: token, target: '_blank', rel: 'noreferrer' }, token);

  return token;
}

function formatMentionToken(token, mentionLabels = { users: {}, channels: {}, roles: {} }) {
  if (token === '@everyone' || token === '@here') return { kind: 'broadcast', label: token };

  const match = token.match(/^<([@#%])(!?)([A-Za-z0-9_-]+)>$/);
  if (!match) return null;

  const [, prefix, modifier, id] = match;
  const shortId = id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;

  if (prefix === '#') return { kind: 'channel', label: `#${mentionLabels.channels?.[id] || shortId}` };
  if (prefix === '%') return { kind: 'role', label: `%${mentionLabels.roles?.[id] || shortId}` };
  return { kind: 'user', label: `@${mentionLabels.users?.[id] || shortId}` };
}

function SavedCard({ saved, editSaved, duplicateSaved, deleteSaved, sendSaved }) {
  return h('article', { className: 'saved-card' },
    h(EmbedPreview, { embed: saved.embed, compact: true }),
    h('div', { className: 'saved-body' },
      h('h3', { title: saved.name }, saved.name),
      h('p', null, `Updated ${formatDate(saved.updatedAt)}`),
      h('div', { className: 'card-actions' },
        h('button', { className: 'secondary', onClick: () => editSaved(saved) }, h(FiEdit3), 'Edit'),
        h('button', { className: 'secondary', onClick: () => duplicateSaved(saved) }, h(FiCopy), 'Copy'),
        h('button', { className: 'primary', onClick: sendSaved }, h(FiSend), 'Send'),
        h('button', { className: 'danger', onClick: () => deleteSaved(saved) }, h(FiTrash2), 'Delete'),
      ),
    ),
  );
}

function normalizeEmbed(value) {
  return {
    content: String(value?.content || '').slice(0, 1800),
    title: String(value?.title || '').slice(0, 256),
    description: String(value?.description || '').slice(0, 4000),
    color: /^#[0-9a-f]{6}$/i.test(String(value?.color || '')) ? value.color : '#fd6671',
    url: String(value?.url || ''),
  };
}

function normalizeBotName(value) {
  const text = String(value || '').trim();
  return text || DEFAULT_BOT_NAME;
}

async function loadConfig() { return getJson('/api/config'); }
async function loadEmbeds() { return (await getJson('/api/embeds')).embeds || []; }
async function createEmbed(name, embed) { return (await postJson('/api/embeds', { name, embed })).embed; }
async function updateEmbed(id, body) { return (await putJson(`/api/embeds/${encodeURIComponent(id)}`, body)).embed; }
async function deleteEmbed(id) { return deleteJson(`/api/embeds/${encodeURIComponent(id)}`); }
async function sendEmbed(channelId, embed) { return postJson('/api/embeds/send', { channelId, embed }); }
async function resolveMentions(mentions, signal) { return (await postJson('/api/mentions/resolve', { mentions }, signal)).labels || { users: {}, channels: {}, roles: {} }; }

function extractMentionIds(text) {
  const users = new Set();
  const channels = new Set();
  const roles = new Set();
  const regex = /<([@#%])(!?)([A-Za-z0-9_-]+)>/g;
  let match;

  while ((match = regex.exec(String(text || '')))) {
    const [, prefix, modifier, id] = match;
    if (prefix === '#') channels.add(id);
    else if (prefix === '%') roles.add(id);
    else users.add(id);
  }

  return {
    users: Array.from(users),
    channels: Array.from(channels),
    roles: Array.from(roles),
  };
}

async function putJson(url, body) {
  const response = await fetch(API_BASE + url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

async function deleteJson(url) {
  const response = await fetch(API_BASE + url, { method: 'DELETE' });
  const data = await response.json();
  if (!data.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : 'unknown';
}

createRoot(document.getElementById('root')!).render(h(App));