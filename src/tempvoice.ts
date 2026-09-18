/**
 * Temporary voice channels — a "join to create" hub plus per-room owner
 * controls, with rooms cleaned up once they empty out.
 *
 * One platform constraint shapes the design: Stoat has no API for moving a
 * member between voice channels, so the bot cannot drag someone from the hub
 * into their new room. Instead it creates the room and posts a one-line notice
 * linking it, which the owner clicks. The hub therefore acts as a trigger, not
 * as a waiting room, and `!vc create` does the same thing without needing the
 * hub at all.
 *
 * Lifecycle:
 *   created → (owner joins) → live → empty for `emptyGraceSec` → deleted
 *   created → nobody joins within `claimGraceSec` → deleted
 *
 * Occupancy comes from the gateway's voice packets, tracked here rather than
 * read back from the API so the sweeper never has to poll. The `Ready` packet
 * reseeds it after a reconnect.
 *
 * Storage: `data/tempvoice.json`, keyed by server.
 */

import { config } from './config.js';
import { dataFile, readJson, registerDataFileHooks, writeJson } from './json-store.js';
import { Permission } from './permissions.js';
import { recordAudit } from './audit.js';
import { debug } from './logger.js';
import type { RawPacket } from './stoat-types.js';

export type TempVoiceConfig = {
  enabled: boolean;
  /** Joining this voice channel creates a room. Optional: `!vc create` also works. */
  hubChannelId: string | null;
  /** Where the "your room is ready" notice is posted. */
  noticeChannelId: string | null;
  /** `{user}` is replaced with the owner's name. */
  nameTemplate: string;
  /** 0 = no limit. */
  userLimit: number;
  /** Seconds a room may stay empty before it is deleted. */
  emptyGraceSec: number;
  /** Seconds a brand-new room waits for its owner before it is deleted. */
  claimGraceSec: number;
  /** Rooms one member may own at a time. */
  maxRoomsPerUser: number;
};

export type TempRoom = {
  channelId: string;
  serverId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  createdAt: number;
  /** When the room last had someone in it; null until first joined. */
  lastOccupiedAt: number | null;
  locked: boolean;
};

type ServerState = {
  config: TempVoiceConfig;
  rooms: TempRoom[];
};

type TempVoiceStore = {
  version: 1;
  servers: Record<string, ServerState>;
};

const TEMPVOICE_FILE = dataFile('tempvoice.json');
const SWEEP_MS = 20_000;

let store: TempVoiceStore | null = null;
let sweepTimer: NodeJS.Timeout | null = null;
let clientRef: any = null;
let sweeping = false;

// channelId → occupant user ids, maintained from the gateway voice packets.
const occupants = new Map<string, Set<string>>();

export function defaultTempVoiceConfig(): TempVoiceConfig {
  return {
    enabled: false,
    hubChannelId: null,
    noticeChannelId: null,
    nameTemplate: "{user}'s room",
    userLimit: 0,
    emptyGraceSec: 60,
    claimGraceSec: 180,
    maxRoomsPerUser: 1,
  };
}

function emptyStore(): TempVoiceStore {
  return { version: 1, servers: {} };
}

function num(value: any, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function text(value: any, max: number): string {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeConfig(value: any): TempVoiceConfig {
  const base = defaultTempVoiceConfig();
  if (!value || typeof value !== 'object') return base;
  return {
    enabled: value.enabled === true,
    hubChannelId: text(value.hubChannelId, 64) || null,
    noticeChannelId: text(value.noticeChannelId, 64) || null,
    nameTemplate: text(value.nameTemplate, 60) || base.nameTemplate,
    userLimit: Math.min(99, Math.max(0, Math.floor(num(value.userLimit, 0)))),
    emptyGraceSec: Math.min(3600, Math.max(10, Math.floor(num(value.emptyGraceSec, base.emptyGraceSec)))),
    claimGraceSec: Math.min(3600, Math.max(30, Math.floor(num(value.claimGraceSec, base.claimGraceSec)))),
    maxRoomsPerUser: Math.min(5, Math.max(1, Math.floor(num(value.maxRoomsPerUser, 1)))),
  };
}

function normalizeRoom(value: any, serverId: string): TempRoom | null {
  const channelId = text(value?.channelId, 64);
  if (!channelId) return null;
  return {
    channelId,
    serverId,
    ownerId: text(value?.ownerId, 64),
    ownerName: text(value?.ownerName, 80) || 'Unknown',
    name: text(value?.name, 80) || 'Temporary room',
    createdAt: num(value?.createdAt, Date.now()),
    lastOccupiedAt: value?.lastOccupiedAt == null ? null : num(value.lastOccupiedAt, null as any) || null,
    locked: value?.locked === true,
  };
}

function load(): TempVoiceStore {
  if (store) return store;
  const raw = readJson<any>(TEMPVOICE_FILE, emptyStore());
  const next = emptyStore();
  const servers = raw?.servers && typeof raw.servers === 'object' ? raw.servers : {};
  for (const [serverId, state] of Object.entries<any>(servers)) {
    next.servers[serverId] = {
      config: normalizeConfig(state?.config),
      rooms: Array.isArray(state?.rooms)
        ? (state.rooms.map((room: any) => normalizeRoom(room, serverId)).filter(Boolean) as TempRoom[])
        : [],
    };
  }
  store = next;
  return store;
}

function save() {
  if (store) writeJson(TEMPVOICE_FILE, store);
}

// A backup restore rewrites the file (keeping the live rooms, see backup.ts);
// start again from disk afterwards.
registerDataFileHooks('tempvoice.json', { reload: () => { store = null; } });

function serverState(serverId: string): ServerState {
  const loaded = load();
  return (loaded.servers[serverId] ||= { config: defaultTempVoiceConfig(), rooms: [] });
}

/** Test hook. */
export function resetTempVoiceCache() {
  store = null;
  occupants.clear();
}

// ---- Config / room queries -------------------------------------------------

export function getTempVoiceConfig(serverId = config.serverId || ''): TempVoiceConfig {
  return { ...serverState(serverId).config };
}

export function setTempVoiceConfig(patch: Partial<TempVoiceConfig>, serverId = config.serverId || ''): TempVoiceConfig {
  const state = serverState(serverId);
  state.config = normalizeConfig({ ...state.config, ...patch });
  save();
  return { ...state.config };
}

export function listTempRooms(serverId = config.serverId || ''): (TempRoom & { occupants: number })[] {
  return serverState(serverId).rooms.map((room) => ({ ...room, occupants: occupants.get(room.channelId)?.size || 0 }));
}

export function getRoomByChannel(channelId: string): TempRoom | null {
  const loaded = load();
  for (const state of Object.values(loaded.servers)) {
    const room = state.rooms.find((entry) => entry.channelId === channelId);
    if (room) return room;
  }
  return null;
}

/**
 * The room a member owns in this server, if any. With several rooms, the one
 * they are sitting in wins, so `vc lock` acts on the room they mean.
 */
export function getRoomByOwner(serverId: string, userId: string): TempRoom | null {
  const owned = serverState(serverId).rooms.filter((room) => room.ownerId === userId);
  return owned.find((room) => occupants.get(room.channelId)?.has(userId)) || owned[0] || null;
}

/** The temporary room a member is sitting in, if any. */
export function getRoomForOccupant(serverId: string, userId: string): TempRoom | null {
  return serverState(serverId).rooms.find((room) => occupants.get(room.channelId)?.has(userId)) || null;
}

export function countOccupants(channelId: string): number {
  return occupants.get(channelId)?.size || 0;
}

/** Whether a specific member is currently sitting in a channel. */
export function isOccupant(channelId: string, userId: string): boolean {
  return occupants.get(channelId)?.has(userId) === true;
}

// ---- Voice state -----------------------------------------------------------

function addOccupant(channelId: string, userId: string) {
  if (!channelId || !userId) return;
  const set = occupants.get(channelId) || new Set<string>();
  set.add(userId);
  occupants.set(channelId, set);
  const room = getRoomByChannel(channelId);
  if (room) {
    room.lastOccupiedAt = Date.now();
    save();
  }
}

function removeOccupant(channelId: string, userId: string) {
  const set = occupants.get(channelId);
  if (!set) return;
  set.delete(userId);
  if (set.size === 0) occupants.delete(channelId);
  const room = getRoomByChannel(channelId);
  if (room) {
    room.lastOccupiedAt = Date.now();
    save();
  }
}

/**
 * Track voice membership and run the hub trigger. Wired into the raw packet
 * handler next to the music module's own voice tracking.
 */
export function handleTempVoicePacket(client: any, packet: RawPacket): void {
  const raw: any = packet;
  try {
    switch (raw?.type) {
      case 'Ready': {
        occupants.clear();
        for (const state of raw.voice_states || []) {
          for (const participant of state?.participants || []) {
            if (participant?.id && state?.id) addOccupant(String(state.id), String(participant.id));
          }
        }
        break;
      }
      case 'VoiceChannelJoin': {
        const channelId = String(raw.id || '');
        const userId = String(raw.state?.id || raw.user || '');
        addOccupant(channelId, userId);
        void onVoiceJoin(client, channelId, userId);
        break;
      }
      case 'VoiceChannelLeave':
        removeOccupant(String(raw.id || ''), String(raw.user || ''));
        break;
      case 'VoiceChannelMove': {
        const userId = String(raw.user || '');
        if (raw.from) removeOccupant(String(raw.from), userId);
        if (raw.to) {
          addOccupant(String(raw.to), userId);
          void onVoiceJoin(client, String(raw.to), userId);
        }
        break;
      }
    }
  } catch (error) {
    debug('tempvoice', () => `voice packet handling failed: ${(error as Error)?.message || error}`);
  }
}

async function onVoiceJoin(client: any, channelId: string, userId: string): Promise<void> {
  if (!channelId || !userId || userId === client?.user?.id) return;
  const serverId = resolveChannelServer(client, channelId);
  if (!serverId) return;
  const cfg = serverState(serverId).config;
  if (!cfg.enabled || !cfg.hubChannelId || cfg.hubChannelId !== channelId) return;

  const existing = getRoomByOwner(serverId, userId);
  if (existing) {
    await notify(client, serverId, cfg, `<@${userId}> your room is already open: <#${existing.channelId}>`);
    return;
  }

  const result = await createRoom(client, { serverId, ownerId: userId });
  if (!result.ok) {
    await notify(client, serverId, cfg, `<@${userId}> could not create your room: ${result.error}`);
    return;
  }
  await notify(client, serverId, cfg, `🔊 <@${userId}> your room is ready: <#${result.room.channelId}> — hop in, it closes on its own once empty.`);
}

function resolveChannelServer(client: any, channelId: string): string {
  const channel = client?.channels?.cache?.get?.(channelId);
  return String(channel?.serverId || channel?.server_id || '');
}

async function notify(client: any, serverId: string, cfg: TempVoiceConfig, content: string): Promise<void> {
  if (!cfg.noticeChannelId) return;
  try {
    const channel =
      client?.channels?.cache?.get?.(cfg.noticeChannelId) ||
      (await client?.channels?.fetch?.(cfg.noticeChannelId).catch(() => null));
    if (channel?.send) await channel.send({ content });
  } catch (error) {
    debug('tempvoice', () => `notice send failed: ${(error as Error)?.message || error}`);
  }
}

// ---- Room lifecycle --------------------------------------------------------

export type CreateRoomResult = { ok: boolean; room?: TempRoom; error?: string };

/** Owners whose room is being created right now: two quick hub joins make one room. */
const creating = new Set<string>();
/** Last successful create per `${serverId}:${ownerId}`, for the cooldown. */
const lastCreatedAt = new Map<string, number>();
const CREATE_COOLDOWN_MS = 15_000;

export async function createRoom(
  client: any,
  input: { serverId: string; ownerId: string; ownerName?: string; name?: string; userLimit?: number },
): Promise<CreateRoomResult> {
  const serverId = String(input.serverId || '');
  const ownerId = String(input.ownerId || '');
  const state = serverState(serverId);
  const cfg = state.config;

  // The feature is opt-in: nobody may create channels in a server whose
  // admins never switched it on.
  if (!cfg.enabled) return { ok: false, error: 'Temporary voice rooms are switched off in this server.' };

  const key = `${serverId}:${ownerId}`;
  if (creating.has(key)) return { ok: false, error: 'Your room is already being created.' };
  const since = Date.now() - (lastCreatedAt.get(key) || 0);
  if (since < CREATE_COOLDOWN_MS) {
    return { ok: false, error: `Wait ${Math.ceil((CREATE_COOLDOWN_MS - since) / 1000)}s before opening another room.` };
  }

  const owned = state.rooms.filter((room) => room.ownerId === ownerId).length;
  if (owned >= cfg.maxRoomsPerUser) {
    return { ok: false, error: `You already have ${owned} room${owned === 1 ? '' : 's'} open.` };
  }

  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  if (!server?.channels?.create) return { ok: false, error: 'I cannot create channels in this server.' };

  creating.add(key);
  try {
    const ownerName = text(input.ownerName, 60) || (await resolveMemberName(client, serverId, ownerId));
    // Stoat channel names stop at 32 characters.
    const name = (text(input.name, 32) || cfg.nameTemplate.replace(/\{user\}/g, ownerName)).slice(0, 32).trim() || 'Voice room';
    const userLimit = Math.min(99, Math.max(0, Math.floor(num(input.userLimit, cfg.userLimit))));

    let channel: any;
    try {
      channel = await server.channels.create({
        name,
        type: 'Voice',
        description: `Temporary room created for ${ownerName}.`,
      });
    } catch (error: any) {
      return { ok: false, error: error?.message || String(error) };
    }

    const room: TempRoom = {
      channelId: String(channel?.id || channel?._id || ''),
      serverId,
      ownerId,
      ownerName,
      name,
      createdAt: Date.now(),
      lastOccupiedAt: null,
      locked: false,
    };
    if (!room.channelId) return { ok: false, error: 'Stoat did not return a channel id.' };

    state.rooms.push(room);
    save();
    lastCreatedAt.set(key, Date.now());

    // stoatbot.js's channel create does not pass a user limit through, so it
    // is applied with an edit once the room exists. A failure here leaves a
    // working room without a cap, which is better than no room.
    if (userLimit > 0) {
      const limited = await setRoomLimit(client, room.channelId, userLimit);
      if (!limited.ok) debug('tempvoice', () => `user limit not applied: ${limited.error}`);
    }

    recordAudit({
      serverId,
      actorId: room.ownerId,
      actorName: ownerName,
      source: 'command',
      area: 'tempvoice',
      action: 'create',
      detail: name,
    });

    return { ok: true, room };
  } finally {
    creating.delete(key);
  }
}

async function resolveMemberName(client: any, serverId: string, userId: string): Promise<string> {
  const server = client?.servers?.cache?.get?.(serverId);
  const member = server?.members?.cache?.get?.(userId) || (await server?.members?.fetch?.(userId).catch(() => null));
  const name = member?.nickname || member?.username || member?.user?.username;
  if (name) return String(name).slice(0, 60);
  const user = client?.users?.cache?.get?.(userId) || (await client?.users?.fetch?.(userId).catch(() => null));
  return String(user?.displayName || user?.username || 'Someone').slice(0, 60);
}

export async function deleteRoom(client: any, channelId: string, reason = 'closed'): Promise<boolean> {
  const room = getRoomByChannel(channelId);
  if (!room) return false;
  const state = serverState(room.serverId);
  state.rooms = state.rooms.filter((entry) => entry.channelId !== channelId);
  save();
  occupants.delete(channelId);

  try {
    const channel =
      client?.channels?.cache?.get?.(channelId) || (await client?.channels?.fetch?.(channelId).catch(() => null));
    if (channel?.delete) await channel.delete();
  } catch (error) {
    debug('tempvoice', () => `room delete failed: ${(error as Error)?.message || error}`);
  }

  recordAudit({
    serverId: room.serverId,
    actorId: room.ownerId,
    actorName: room.ownerName,
    source: 'automation',
    area: 'tempvoice',
    action: 'delete',
    detail: `${room.name} (${reason})`,
  });
  return true;
}

export async function renameRoom(client: any, channelId: string, name: string): Promise<{ ok: boolean; name?: string; error?: string }> {
  const room = getRoomByChannel(channelId);
  if (!room) return { ok: false, error: 'That is not a temporary room.' };
  const next = text(name, 32);
  if (!next) return { ok: false, error: 'Give the room a name.' };
  try {
    const channel =
      client?.channels?.cache?.get?.(channelId) || (await client?.channels?.fetch?.(channelId).catch(() => null));
    if (!channel?.edit) return { ok: false, error: 'I cannot edit that channel.' };
    await channel.edit({ name: next });
    room.name = next;
    save();
    return { ok: true, name: next };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export async function setRoomLimit(client: any, channelId: string, limit: number): Promise<{ ok: boolean; error?: string }> {
  const room = getRoomByChannel(channelId);
  if (!room) return { ok: false, error: 'That is not a temporary room.' };
  const value = Math.min(99, Math.max(0, Math.floor(num(limit, 0))));
  try {
    const channel =
      client?.channels?.cache?.get?.(channelId) || (await client?.channels?.fetch?.(channelId).catch(() => null));
    if (!channel?.edit) return { ok: false, error: 'I cannot edit that channel.' };
    await channel.edit({ voice: { max_users: value } });
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Lock or unlock a room by denying `Connect` to everyone. The owner keeps
 * access through the room's own role-free default — a locked room is meant for
 * whoever is already inside.
 */
export async function setRoomLocked(client: any, channelId: string, locked: boolean): Promise<{ ok: boolean; error?: string }> {
  const room = getRoomByChannel(channelId);
  if (!room) return { ok: false, error: 'That is not a temporary room.' };
  try {
    const channel =
      client?.channels?.cache?.get?.(channelId) || (await client?.channels?.fetch?.(channelId).catch(() => null));
    if (!channel?.setDefaultPermissions) return { ok: false, error: 'I cannot edit permissions on that channel.' };
    await channel.setDefaultPermissions({
      allow: 0,
      deny: locked ? Number(Permission.Connect) : 0,
    });
    room.locked = locked;
    save();
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Hand a room to someone else — used when the owner leaves but others stay. */
export function transferRoom(channelId: string, userId: string, userName: string): boolean {
  const room = getRoomByChannel(channelId);
  if (!room) return false;
  room.ownerId = userId;
  room.ownerName = text(userName, 80) || room.ownerName;
  save();
  return true;
}

// ---- Sweeper ---------------------------------------------------------------

export function startTempVoiceSweeper(client: any) {
  clientRef = client;
  if (sweepTimer) return;
  console.log(`[tempvoice] Sweeper started (tick ${SWEEP_MS / 1000}s).`);
  sweepTimer = setInterval(() => {
    void sweepRooms().catch((error) => console.error('[tempvoice] sweep failed:', error));
  }, SWEEP_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}

/** Whether the sweep is armed, for the ops health panel. */
export function isTempVoiceSweeperRunning(): boolean {
  return sweepTimer !== null;
}

export function stopTempVoiceSweeper() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  clientRef = null;
}

/** Delete rooms that emptied out, or that nobody ever joined. */
export async function sweepRooms(now = Date.now()): Promise<number> {
  if (sweeping || !clientRef) return 0;
  sweeping = true;
  let removed = 0;
  try {
    const loaded = load();
    for (const [serverId, state] of Object.entries(loaded.servers)) {
      const cfg = state.config;
      for (const room of [...state.rooms]) {
        const count = occupants.get(room.channelId)?.size || 0;
        if (count > 0) continue;

        const neverJoined = room.lastOccupiedAt == null;
        const idleSince = room.lastOccupiedAt ?? room.createdAt;
        const graceMs = (neverJoined ? cfg.claimGraceSec : cfg.emptyGraceSec) * 1000;
        if (now - idleSince < graceMs) continue;

        if (await deleteRoom(clientRef, room.channelId, neverJoined ? 'never joined' : 'empty')) removed++;
      }
      // A server with the feature switched off keeps its rooms until they empty,
      // which the loop above already handles — nothing extra to do here.
      void serverId;
    }
  } finally {
    sweeping = false;
  }
  return removed;
}
