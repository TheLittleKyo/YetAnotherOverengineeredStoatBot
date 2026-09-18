import { dispose } from '@livekit/rtc-node';
import { dataFile, readJson, registerDataFileHooks, updateJson } from '../json-store.js';
import { hasPermissionInServer } from '../permissions.js';
import { resolveBotPermission, runWithBotPermission } from '../bot-permissions.js';
import { normalizeId } from '../id-utils.js';
import { debug } from '../logger.js';
import type { StoatClient } from '../stoat-types.js';
import { escapeLinkText, formatTrackDuration, trackLink } from './format.js';
import { GuildPlayer, type LeaveReason } from './player.js';
import { STREAM_DIRECTORY_URL } from './radio.js';
import type { Track } from './types.js';
import { warmUpYouTube } from './youtube.js';
import { isVoiceStateSeeded, trackedVoiceChannel } from './voice-state.js';
import { startYtDlpMaintenance, stopYtDlpMaintenance } from './ytdlp-binary.js';

// Voice-state tracking runs from boot, before (and without) the music stack.
export { handleVoicePacket, resetVoiceState } from './voice-state.js';

// ── Per-server settings ────────────────────────────────────────────────────

export type MusicSettings = {
  /** 0–2, restored when the bot next joins. */
  volume: number;
  /** Post "Now playing" messages in the command channel. */
  announce: boolean;
};

type MusicStore = { servers: Record<string, Partial<MusicSettings>> };

const MUSIC_FILE = dataFile('music.json');
const DEFAULT_SETTINGS: MusicSettings = { volume: 1, announce: true };

// Read on every join and track change; parsed once, then served from memory
// (this process is the only writer). A backup restore drops the copy.
let settingsCache: MusicStore | null = null;
registerDataFileHooks('music.json', { reload: () => { settingsCache = null; } });

export function getMusicSettings(serverId: string): MusicSettings {
  if (!settingsCache) settingsCache = readJson<MusicStore>(MUSIC_FILE, { servers: {} });
  return { ...DEFAULT_SETTINGS, ...(settingsCache.servers?.[serverId] || {}) };
}

export function updateMusicSettings(serverId: string, patch: Partial<MusicSettings>): MusicSettings {
  const store = updateJson<MusicStore>(MUSIC_FILE, { servers: {} }, (current) => {
    const servers = { ...(current.servers || {}) };
    servers[serverId] = { ...(servers[serverId] || {}), ...patch };
    return { servers };
  });
  settingsCache = store;
  return { ...DEFAULT_SETTINGS, ...store.servers[serverId] };
}

// ── Voice state ────────────────────────────────────────────────────────────

export function isVoiceChannel(channel: any): boolean {
  if (!channel) return false;
  if (typeof channel.isVoice === 'function') {
    try {
      return Boolean(channel.isVoice());
    } catch {
      // fall through
    }
  }
  return channel.type === 'VOICE' || channel.voice instanceof Map;
}

function channelsOf(client: StoatClient): any[] {
  const cache: any = (client as any)?.channels?.cache;
  if (!cache) return [];
  return typeof cache.values === 'function' ? [...cache.values()] : Object.values(cache);
}

export function listVoiceChannels(client: StoatClient, serverId: string): any[] {
  return channelsOf(client).filter((channel) => channel?.serverId === serverId && isVoiceChannel(channel));
}

/** The voice channel in `serverId` the user is sitting in, if any. */
export function findUserVoiceChannel(client: StoatClient, serverId: string, userId: string): string | null {
  const tracked = trackedVoiceChannel(userId);
  // A channel missing from the cache was deleted, or belongs to a server this
  // lookup must not reach into.
  if (tracked && (client as any)?.channels?.cache?.get?.(tracked)?.serverId === serverId) return tracked;

  const player = players.get(serverId);
  if (player?.channelId && player.listenerIds.includes(userId)) return player.channelId;

  // stoatbot.js' snapshot never drops users who left, so only trust it when no Ready was seen.
  if (!isVoiceStateSeeded()) {
    for (const channel of listVoiceChannels(client, serverId)) {
      if (channel.voice instanceof Map && channel.voice.has(userId)) return channel.id;
    }
  }
  return null;
}

/** Channel mention, id, or (case-insensitive) name → voice channel id in the server. */
export function resolveVoiceChannelArg(client: StoatClient, serverId: string, input: string): string | null {
  const voiceChannels = listVoiceChannels(client, serverId);
  const id = normalizeId(input);
  if (id && voiceChannels.some((channel) => channel.id === id)) return id;
  const name = String(input || '').trim().replace(/^#/, '').toLowerCase();
  if (!name) return null;
  const match = voiceChannels.find((channel) => String(channel.name || '').toLowerCase() === name);
  return match?.id ?? null;
}

// ── Players ────────────────────────────────────────────────────────────────

const players = new Map<string, GuildPlayer>();

export function getPlayer(serverId: string): GuildPlayer | null {
  const player = players.get(serverId);
  return player && !player.isDestroyed ? player : null;
}

export function getOrCreatePlayer(client: StoatClient, serverId: string): GuildPlayer {
  const existing = getPlayer(serverId);
  if (existing) return existing;

  const player = new GuildPlayer(serverId, getMusicSettings(serverId).volume);
  players.set(serverId, player);

  player.on('trackStart', (track: Track, repeat: boolean) => {
    refreshPanels(client, serverId);
    // `loop track` would otherwise post the same line every time the song restarts.
    if (repeat || !getMusicSettings(serverId).announce) return;
    const requestedBy = `requested by ${escapeLinkText(track.requester.name)}`;
    void announce(
      client,
      player,
      track.source === 'radio'
        ? `📻 Now streaming ${trackLink(track)}${track.radio?.genre ? ` · ${escapeLinkText(track.radio.genre)}` : ''} · ${requestedBy}`
        : `🎶 Now playing ${trackLink(track)} \`${formatTrackDuration(track)}\` · ${requestedBy}`,
    );
  });
  player.on('trackError', (track: Track, message: string) => {
    const hint =
      track.source === 'radio'
        ? `\nStations list several stream links; another one (MP3 or AAC usually work best) may play. Find them on <${STREAM_DIRECTORY_URL}>.`
        : '';
    void announce(client, player, `⚠️ Skipped ${trackLink(track)}: ${message}${hint}`);
  });
  player.on('queueEnd', () => {
    refreshPanels(client, serverId);
    if (!getMusicSettings(serverId).announce) return;
    void announce(client, player, '✅ Queue finished. Add more with `play`, or I will leave after a while.');
  });
  player.on('leave', (reason: LeaveReason) => {
    if (players.get(serverId) === player) players.delete(serverId);
    closePanels(client, serverId);
    const text = LEAVE_MESSAGES[reason];
    if (text) void announce(client, player, text);
  });

  return player;
}

const LEAVE_MESSAGES: Partial<Record<LeaveReason, string>> = {
  idle: '👋 Left the voice channel because nothing was playing.',
  empty: '👋 Left the voice channel because everyone else left.',
  disconnected: '⚠️ I was disconnected from the voice channel and cleared the queue.',
};

async function announce(client: StoatClient, player: GuildPlayer, content: string) {
  if (!player.textChannelId) return;
  try {
    const channel: any =
      (client as any).channels?.cache?.get?.(player.textChannelId) ||
      (await (client as any).channels?.fetch?.(player.textChannelId).catch(() => null));
    await channel?.send({ content });
  } catch (error) {
    debug('music:announce', () => `announce failed in ${player.textChannelId}: ${error?.message || error}`);
  }
}

/**
 * Who may change playback: anyone in the bot's voice channel, or members with
 * Manage Server / Move Members. When the bot is not in a call there is nothing
 * to protect, so everyone passes.
 *
 * The dashboard's "DJ controls" bot permission overrides this: an allowed role
 * controls from anywhere, a denied role cannot control at all. `queueing`
 * marks the "add a song while the bot is busy" check, which a DJ deny leaves to
 * the voice-channel rule.
 */
export async function canControlPlayer(
  client: StoatClient,
  serverId: string,
  userId: string,
  options: { queueing?: boolean } = {},
): Promise<boolean> {
  const dj = await resolveBotPermission(client, serverId, userId, 'music.dj');
  if (dj === 'allow') return true;
  if (dj === 'deny' && !options.queueing) return false;

  const player = getPlayer(serverId);
  // While a join is in flight the bot already "belongs" to that channel.
  const channelId = player?.targetChannelId;
  if (!channelId) return true;
  if (findUserVoiceChannel(client, serverId, userId) === channelId) return true;
  // Checked as the DJ feature, so allowing the Music feature does not also grant control.
  return runWithBotPermission('music.dj', userId, () =>
    hasPermissionInServer(client, serverId, userId, ['ManageServer', 'MoveMembers']),
  );
}

/** Background setup on startup: fetch/refresh the managed yt-dlp and open a YouTube session. */
export function startMusicBackground() {
  startYtDlpMaintenance();
  warmUpYouTube();
}

export async function shutdownMusic(): Promise<void> {
  stopYtDlpMaintenance();
  const active = [...players.values()];
  players.clear();
  await Promise.allSettled(active.map((player) => player.destroy('shutdown')));
  if (active.length > 0) {
    try {
      await dispose();
    } catch {
      // native side already torn down
    }
  }
}

// ── Search sessions (`search` → reply with a number) ───────────────────────

type SearchSession = { serverId: string; tracks: Track[]; next: boolean; expiresAt: number };

const SEARCH_TTL_MS = 60_000;
const searchSessions = new Map<string, SearchSession>();

function searchKey(channelId: string, userId: string) {
  return `${channelId}:${userId}`;
}

export function startSearchSession(channelId: string, userId: string, session: Omit<SearchSession, 'expiresAt'>) {
  const now = Date.now();
  for (const [key, existing] of searchSessions) {
    if (existing.expiresAt < now) searchSessions.delete(key);
  }
  searchSessions.set(searchKey(channelId, userId), { ...session, expiresAt: now + SEARCH_TTL_MS });
}

/** Pops the session a plain-number reply refers to, if it is still fresh. */
export function takeSearchSession(channelId: string, userId: string): SearchSession | null {
  const key = searchKey(channelId, userId);
  const session = searchSessions.get(key);
  if (!session) return null;
  searchSessions.delete(key);
  return session.expiresAt >= Date.now() ? session : null;
}

export function hasSearchSession(channelId: string, userId: string): boolean {
  const session = searchSessions.get(searchKey(channelId, userId));
  return Boolean(session && session.expiresAt >= Date.now());
}

// ── Reaction control panels ────────────────────────────────────────────────

export const PANEL_CONTROLS = {
  '⏯️': 'toggle',
  '⏭️': 'skip',
  '⏹️': 'stop',
  '🔁': 'loop',
  '🔀': 'shuffle',
  '🔉': 'volumeDown',
  '🔊': 'volumeUp',
} as const;

export type PanelAction = (typeof PANEL_CONTROLS)[keyof typeof PANEL_CONTROLS];

type Panel = { serverId: string; channelId: string; messageId: string; render: () => string };

/** messageId → panel. One live panel per server; a new one replaces the old. */
const panels = new Map<string, Panel>();

export function registerPanel(panel: Panel) {
  for (const [id, existing] of panels) {
    if (existing.serverId === panel.serverId) panels.delete(id);
  }
  panels.set(panel.messageId, panel);
}

export function getPanel(messageId: string): Panel | null {
  return panels.get(messageId) ?? null;
}

export function refreshPanels(client: StoatClient, serverId: string) {
  for (const panel of panels.values()) {
    if (panel.serverId === serverId) void editPanel(client, panel, panel.render());
  }
}

function closePanels(client: StoatClient, serverId: string) {
  for (const [id, panel] of panels) {
    if (panel.serverId !== serverId) continue;
    panels.delete(id);
    void editPanel(client, panel, '⏹️ Player closed. Use `player` again after starting music.');
  }
}

async function editPanel(client: StoatClient, panel: Panel, content: string) {
  try {
    await (client as any).api.patch(`/channels/${panel.channelId}/messages/${panel.messageId}`, { body: { content } });
  } catch (error) {
    debug('music:panel', () => `panel edit failed: ${error?.message || error}`);
  }
}
