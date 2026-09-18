import { createArrayFileStore, dataFile } from './json-store.js';

export type ResponderMatch = 'contains' | 'exact' | 'starts' | 'ends' | 'regex';

export type AutoResponder = {
  id: string;
  serverId: string;
  trigger: string;
  response: string;
  match: ResponderMatch;
  caseSensitive: boolean;
  channelId: string | null; // restrict to one channel, null = whole server
  cooldownMs: number; // per-channel cooldown, 0 = none
  enabled: boolean;
  createdAt: number;
};

const store = createArrayFileStore<AutoResponder>(dataFile('autoresponders.json'), 'responders', 'autoresponders');

// Cooldown tracking: `${responderId}:${channelId}` -> last fire timestamp
const lastFiredAt = new Map<string, number>();

function generateId(): string {
  return `ar_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function listAutoResponders(serverId?: string): AutoResponder[] {
  const all = store.read();
  if (!serverId) return all;
  return all.filter((r) => r.serverId === serverId);
}

export function addAutoResponder(entry: Omit<AutoResponder, 'id' | 'createdAt'>): AutoResponder {
  const responders = store.read();
  const responder: AutoResponder = {
    ...entry,
    id: generateId(),
    createdAt: Date.now(),
  };
  store.write([...responders, responder]);
  return responder;
}

export function removeAutoResponder(id: string): boolean {
  const responders = store.read();
  const next = responders.filter((r) => r.id !== id);
  if (next.length === responders.length) return false;
  store.write(next);
  return true;
}

export function toggleAutoResponder(id: string): AutoResponder | null {
  const responders = store.read();
  const responder = responders.find((r) => r.id === id);
  if (!responder) return null;
  responder.enabled = !responder.enabled;
  store.write(responders);
  return responder;
}

function matches(responder: AutoResponder, content: string): boolean {
  const trigger = responder.trigger;
  const hay = responder.caseSensitive ? content : content.toLowerCase();
  const needle = responder.caseSensitive ? trigger : trigger.toLowerCase();

  switch (responder.match) {
    case 'exact':
      return hay.trim() === needle.trim();
    case 'starts':
      return hay.trimStart().startsWith(needle);
    case 'ends':
      return hay.trimEnd().endsWith(needle);
    case 'regex':
      try {
        return new RegExp(trigger, responder.caseSensitive ? '' : 'i').test(content);
      } catch {
        return false;
      }
    case 'contains':
    default:
      return hay.includes(needle);
  }
}

function renderResponse(template: string, message: any): string {
  const author = message?.author;
  const username = author?.username || author?.displayName || 'user';
  const mention = message?.authorId ? `<@${message.authorId}>` : username;
  return template
    .replace(/\{user\}/g, username)
    .replace(/\{mention\}/g, mention)
    .replace(/\{channel\}/g, message?.channelId ? `<#${message.channelId}>` : 'channel');
}

/**
 * Check an incoming message against configured auto-responders and reply to the
 * first enabled match. Best-effort: never throws into the message pipeline.
 */
export async function handleAutoResponder(client: any, message: any): Promise<boolean> {
  try {
    if (!message || message.author?.bot) return false;
    if (message.authorId && message.authorId === client?.user?.id) return false;

    const content = String(message.content || '');
    if (!content) return false;

    const serverId = message.serverId || message.channel?.serverId;
    if (!serverId) return false;

    const responders = listAutoResponders(serverId).filter((r) => r.enabled);
    if (responders.length === 0) return false;

    for (const responder of responders) {
      if (responder.channelId && responder.channelId !== message.channelId) continue;
      if (!matches(responder, content)) continue;

      // Cooldown guard (per responder + channel)
      if (responder.cooldownMs > 0) {
        const key = `${responder.id}:${message.channelId}`;
        const now = Date.now();
        const last = lastFiredAt.get(key) || 0;
        if (now - last < responder.cooldownMs) return false;
        lastFiredAt.set(key, now);
      }

      await message.channel?.send({ content: renderResponse(responder.response, message) });
      return true;
    }
  } catch (error) {
    console.error('Auto-responder error:', error?.message || error);
  }

  return false;
}
