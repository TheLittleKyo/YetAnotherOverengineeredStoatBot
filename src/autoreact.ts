import { createArrayFileStore, dataFile } from './json-store.js';

export type ReactMatch = 'contains' | 'exact' | 'starts' | 'ends' | 'regex' | 'all';

export type AutoReact = {
  id: string;
  serverId: string;
  trigger: string; // ignored when match === 'all'
  emojis: string[]; // unicode emoji or custom emoji id
  match: ReactMatch;
  caseSensitive: boolean;
  channelId: string | null; // restrict to one channel, null = whole server
  enabled: boolean;
  createdAt: number;
};

const store = createArrayFileStore<AutoReact>(dataFile('autoreacts.json'), 'reactors', 'autoreacts');

function generateId(): string {
  return `re_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function listAutoReacts(serverId?: string): AutoReact[] {
  const all = store.read();
  if (!serverId) return all;
  return all.filter((r) => r.serverId === serverId);
}

export function addAutoReact(entry: Omit<AutoReact, 'id' | 'createdAt'>): AutoReact {
  const reactors = store.read();
  const reactor: AutoReact = {
    ...entry,
    id: generateId(),
    createdAt: Date.now(),
  };
  store.write([...reactors, reactor]);
  return reactor;
}

export function removeAutoReact(id: string): boolean {
  const reactors = store.read();
  const next = reactors.filter((r) => r.id !== id);
  if (next.length === reactors.length) return false;
  store.write(next);
  return true;
}

export function toggleAutoReact(id: string): AutoReact | null {
  const reactors = store.read();
  const reactor = reactors.find((r) => r.id === id);
  if (!reactor) return null;
  reactor.enabled = !reactor.enabled;
  store.write(reactors);
  return reactor;
}

function matches(reactor: AutoReact, content: string): boolean {
  if (reactor.match === 'all') return true;

  const hay = reactor.caseSensitive ? content : content.toLowerCase();
  const needle = reactor.caseSensitive ? reactor.trigger : reactor.trigger.toLowerCase();

  switch (reactor.match) {
    case 'exact':
      return hay.trim() === needle.trim();
    case 'starts':
      return hay.trimStart().startsWith(needle);
    case 'ends':
      return hay.trimEnd().endsWith(needle);
    case 'regex':
      try {
        return new RegExp(reactor.trigger, reactor.caseSensitive ? '' : 'i').test(content);
      } catch {
        return false;
      }
    case 'contains':
    default:
      return hay.includes(needle);
  }
}

/**
 * Check an incoming message against configured auto-reacts and add every emoji
 * from each matching rule. Best-effort: never throws into the message pipeline.
 */
export async function handleAutoReact(client: any, message: any): Promise<boolean> {
  try {
    if (!message || message.author?.bot) return false;
    if (message.authorId && message.authorId === client?.user?.id) return false;

    const content = String(message.content || '');
    const serverId = message.serverId || message.channel?.serverId;
    if (!serverId) return false;

    const reactors = listAutoReacts(serverId).filter((r) => r.enabled);
    if (reactors.length === 0) return false;

    // 'all' rules match empty content too; other rules need text.
    let reacted = false;

    for (const reactor of reactors) {
      if (reactor.channelId && reactor.channelId !== message.channelId) continue;
      if (reactor.match !== 'all' && !content) continue;
      if (!matches(reactor, content)) continue;

      for (const emoji of reactor.emojis) {
        try {
          await message.addReaction(emoji);
          reacted = true;
        } catch (error) {
          console.warn(`Auto-react failed for emoji ${emoji}:`, error?.message || error);
        }
      }
    }

    return reacted;
  } catch (error) {
    console.error('Auto-react error:', error?.message || error);
    return false;
  }
}
