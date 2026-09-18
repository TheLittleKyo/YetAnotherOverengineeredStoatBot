import { EventEmitter } from 'node:events';
import type { StoatClient } from '../stoat-types.js';
import { env } from '../config.js';
import { debug } from '../logger.js';
import { createAudioPipeline, SAMPLE_RATE, type AudioPipeline } from './audio-stream.js';
import { ensurePlaybackUrl } from './resolver.js';
import { VoiceConnection } from './voice-connection.js';
import type { LoopMode, Track } from './types.js';

/** A track that produced no audio this long after starting is treated as failed. */
const START_TIMEOUT_MS = 60_000;

/**
 * Start fetching the next track this long before the current one ends, so it
 * is already buffered when its turn comes (yt-dlp needs 2–3 s to start).
 */
const PRELOAD_LEAD_SECONDS = 45;

/** A preload that waited longer than this gets one fresh retry if it turns out broken. */
const PRELOAD_STALE_MS = 60_000;

/**
 * Radio reconnects. ffmpeg already reconnects plain HTTP streams, but HLS,
 * DASH, RTSP, RTMP and MMS end the stream on a drop; the player starts it again.
 * A connection that lasted this long counts as healthy and resets the tally.
 */
const RADIO_STABLE_MS = 30_000;
const RADIO_MAX_QUICK_DROPS = 5;
const RADIO_RECONNECT_DELAY_MS = 2_000;

function waitUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** `jumped`: skipped by `skipTo`, which already re-queued it for `loop queue`. */
type TrackOutcome = 'finished' | 'skipped' | 'jumped' | 'failed' | 'stopped';

export type LeaveReason = 'command' | 'idle' | 'empty' | 'disconnected' | 'shutdown';

type Preload = {
  track: Track;
  pipeline: AudioPipeline | null;
  ready: Promise<void>;
  startedAt: number;
  cancelled: boolean;
};

/**
 * Queue + playback state for one server. Stoat allows a bot one voice seat per
 * server, so the player is keyed by server, not channel.
 *
 * The next track is preloaded — its download started ahead of time — shortly
 * before the current track ends, and immediately when nothing is playing (so
 * the first track downloads while the bot is still joining the channel).
 *
 * Events:
 *   trackStart(track, repeat)    first audio of a track reached the call; `repeat` when `loop track` replays it
 *   trackError(track, message)   a track could not be played and was skipped
 *   queueEnd()                   the queue ran dry
 *   leave(reason)                the player disconnected and is finished
 */
export class GuildPlayer extends EventEmitter {
  readonly serverId: string;
  /** Text channel that receives announcements (the last one a command came from). */
  textChannelId: string | null = null;
  current: Track | null = null;

  private tracks: Track[] = [];
  private loopMode: LoopMode = 'off';
  private connection: VoiceConnection | null = null;
  private joining: Promise<void> | null = null;
  private joiningChannel: string | null = null;
  private lastStarted: Track | null = null;
  private preload: Preload | null = null;
  private volumeLevel = 1;
  private abort: AbortController | null = null;
  private abortReason: TrackOutcome = 'skipped';
  private running = false;
  private destroyed = false;
  private playedSamples = 0;
  private nextPreloadCheck = 0;
  private idleTimer: NodeJS.Timeout | null = null;
  private emptyTimer: NodeJS.Timeout | null = null;

  constructor(serverId: string, volume = 1) {
    super();
    this.serverId = serverId;
    this.volumeLevel = clampVolume(volume);
  }

  /** Upcoming tracks. Assigning replaces the whole queue. */
  get queue(): Track[] {
    return this.tracks;
  }

  set queue(tracks: Track[]) {
    this.tracks = tracks;
    this.refreshPreload();
  }

  get loop(): LoopMode {
    return this.loopMode;
  }

  set loop(mode: LoopMode) {
    this.loopMode = mode;
    this.refreshPreload();
  }

  get channelId(): string | null {
    return this.connection?.channelId ?? null;
  }

  /** The channel the player is in, or on its way into. */
  get targetChannelId(): string | null {
    return this.connection?.channelId ?? this.joiningChannel;
  }

  get connected(): boolean {
    return Boolean(this.connection?.connected);
  }

  get paused(): boolean {
    return Boolean(this.connection?.paused);
  }

  get volume(): number {
    return this.volumeLevel;
  }

  get isDestroyed(): boolean {
    return this.destroyed;
  }

  /** Seconds of the current track already sent to the call. */
  get position(): number {
    return this.playedSamples / SAMPLE_RATE;
  }

  get listenerIds(): string[] {
    return this.connection?.participantIds ?? [];
  }

  /** The track currently being preloaded, if any (for status output and tests). */
  get preloadingTrack(): Track | null {
    return this.preload?.track ?? null;
  }

  async join(client: StoatClient, channelId: string) {
    // Two commands racing to connect must share one call, not open two.
    while (this.joining) await this.joining.catch(() => {});
    this.joiningChannel = channelId;
    this.joining = this.connect(client, channelId);
    try {
      await this.joining;
    } catch (error) {
      if (!this.connection) {
        // Nothing can play without a call: stop any download started for it and let the player expire.
        this.dropPreload();
        this.scheduleIdle();
      }
      throw error;
    } finally {
      this.joining = null;
      this.joiningChannel = null;
    }
  }

  private async connect(client: StoatClient, channelId: string) {
    if (this.destroyed) throw new Error('This player was closed.');
    if (this.connection?.connected && this.connection.channelId === channelId) return;

    const previous = this.connection;
    if (previous) {
      // Moving channels: keep the queue and restart the current track in the new call.
      previous.removeAllListeners();
      this.connection = null;
      if (this.current) this.tracks.unshift(this.current);
      this.abortCurrent('stopped');
      await previous.disconnect();
    }

    const connection = await VoiceConnection.open(client, channelId, this.serverId);
    if (this.destroyed) {
      await connection.disconnect();
      return;
    }
    connection.volume = this.volumeLevel;
    connection.on('disconnected', () => {
      if (this.connection === connection) void this.destroy('disconnected');
    });
    connection.on('participants', (count: number) => this.onParticipants(count));
    this.connection = connection;
    this.onParticipants(connection.participantIds.length);
    this.scheduleIdle();
    this.kick();
  }

  /** Append (or insert at the front) and start playback if idle. Returns how many were added. */
  enqueue(tracks: Track[], options: { next?: boolean } = {}): number {
    const room = Math.max(0, env.musicMaxQueue - this.tracks.length);
    const accepted = tracks.slice(0, room);
    if (options.next) this.tracks.unshift(...accepted);
    else this.tracks.push(...accepted);
    this.refreshPreload();
    this.kick();
    return accepted.length;
  }

  /** Start the playback loop if it is not already running. */
  kick() {
    if (this.running || this.destroyed || !this.connection?.connected || this.tracks.length === 0) return;
    void this.run();
  }

  private async run() {
    this.running = true;
    this.clearIdle();
    let drained = false;
    try {
      while (!this.destroyed && this.connection?.connected) {
        const track = this.tracks.shift();
        if (!track) {
          drained = true;
          break;
        }
        this.current = track;
        const outcome = await this.playTrack(track);
        this.current = null;
        if (outcome === 'stopped' || this.destroyed) break;

        if (this.loopMode === 'track' && outcome === 'finished') this.tracks.unshift(track);
        else if (this.loopMode === 'queue' && (outcome === 'finished' || outcome === 'skipped')) this.tracks.push(track);
      }
    } catch (error) {
      console.error(`[music] playback loop crashed in server ${this.serverId}:`, error);
    } finally {
      this.running = false;
      this.current = null;
      this.playedSamples = 0;
      if (!this.destroyed) {
        if (drained) this.emit('queueEnd');
        this.scheduleIdle();
        // A channel move stops the loop with tracks still queued; pick them up
        // if the new call finished connecting before this loop wound down.
        this.kick();
      }
    }
  }

  private async playTrack(track: Track): Promise<TrackOutcome> {
    const controller = new AbortController();
    this.abort = controller;
    this.abortReason = 'skipped';
    this.playedSamples = 0;
    this.nextPreloadCheck = 0;

    try {
      const preload = await this.takePreload(track);
      let pipeline = preload?.pipeline ?? null;
      if (controller.signal.aborted) {
        pipeline?.stop();
        return this.abortReason;
      }

      if (!pipeline) {
        try {
          await ensurePlaybackUrl(track);
        } catch (error) {
          if (controller.signal.aborted) return this.abortReason;
          this.emit('trackError', track, error?.message || String(error));
          return 'failed';
        }
        if (controller.signal.aborted) return this.abortReason;
      }

      const connection = this.connection;
      if (!connection?.connected) {
        pipeline?.stop();
        return 'stopped';
      }

      // A preload that sat for a while may have lost its connection; give it one fresh try.
      let preloadRetry = Boolean(pipeline && preload && Date.now() - preload.startedAt > PRELOAD_STALE_MS);
      let started = false;
      let quickDrops = 0;
      let sampleOffset = 0;
      while (true) {
        if (!pipeline) {
          try {
            pipeline = createAudioPipeline(track);
          } catch (error) {
            this.emit('trackError', track, error?.message || String(error));
            return 'failed';
          }
        }
        const active: AudioPipeline = pipeline;
        const playStartedAt = Date.now();
        try {
          const result = await connection.play(active.pcm, controller.signal, {
            startTimeoutMs: START_TIMEOUT_MS,
            onStart: () => {
              // A reconnected station is the same track: announce it once.
              if (started) return;
              started = true;
              const repeat = this.lastStarted === track && this.loopMode === 'track';
              this.lastStarted = track;
              this.emit('trackStart', track, repeat);
            },
            onProgress: (samples) => this.onProgress(sampleOffset + samples),
          });
          if (result.aborted) return this.abortReason;

          if (result.samples > 0) {
            if (track.source !== 'radio') return 'finished';
            // A radio stream has no end: the station (or the network) dropped us.
            // Reconnect, unless it keeps dropping within seconds of connecting.
            sampleOffset += result.samples;
            quickDrops = Date.now() - playStartedAt >= RADIO_STABLE_MS ? 0 : quickDrops + 1;
            if (quickDrops > RADIO_MAX_QUICK_DROPS || !connection.connected || this.destroyed) {
              if (quickDrops > RADIO_MAX_QUICK_DROPS) this.emit('trackError', track, 'the station keeps dropping the connection');
              return quickDrops > RADIO_MAX_QUICK_DROPS ? 'failed' : 'finished';
            }
            debug('music:player', () => `"${track.title}" dropped; reconnecting (${quickDrops}/${RADIO_MAX_QUICK_DROPS})`);
            await waitUnlessAborted(RADIO_RECONNECT_DELAY_MS * Math.max(1, quickDrops), controller.signal);
            if (controller.signal.aborted) return this.abortReason;
            continue;
          }

          if (preloadRetry && !result.timedOut && connection.connected) {
            preloadRetry = false;
            debug('music:player', () => `preloaded stream for "${track.title}" produced nothing, retrying fresh`);
            continue;
          }
          const reason = result.timedOut ? 'the source did not send any audio in time' : active.error() || 'no audio was produced';
          this.emit('trackError', track, reason);
          return 'failed';
        } finally {
          active.stop();
          pipeline = null;
        }
      }
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }

  private onProgress(samples: number) {
    this.playedSamples = samples;
    // Checking once a second is plenty to catch the preload window.
    if (samples < this.nextPreloadCheck) return;
    this.nextPreloadCheck = samples + SAMPLE_RATE;
    if (!this.preload) this.refreshPreload();
  }

  // ── Preloading ───────────────────────────────────────────────────────────

  /** The track that plays after the current one, following the loop mode. */
  private upcomingTrack(): Track | null {
    if (this.current && this.loopMode === 'track') return this.current;
    if (this.tracks[0]) return this.tracks[0];
    if (this.current && this.loopMode === 'queue') return this.current;
    return null;
  }

  private shouldPreloadNow(): boolean {
    // Only a player that is in, or joining, a call will ever play what it fetches.
    if (this.destroyed || !this.targetChannelId) return false;
    const current = this.current;
    if (!current) return true;
    if (current.isLive || !current.duration) return false;
    return current.duration - this.position <= PRELOAD_LEAD_SECONDS;
  }

  /** Re-align the preload with whatever is next after any queue, loop or playback change. */
  private refreshPreload() {
    const next = this.upcomingTrack();
    if (this.preload && this.preload.track !== next) this.dropPreload();
    // Live streams are never fetched early: the buffer would start out of date.
    if (!next || next.isLive || this.preload || !this.shouldPreloadNow()) return;

    const entry: Preload = { track: next, pipeline: null, ready: Promise.resolve(), startedAt: Date.now(), cancelled: false };
    entry.ready = (async () => {
      try {
        await ensurePlaybackUrl(next);
        if (entry.cancelled) return;
        entry.pipeline = createAudioPipeline(next);
        debug('music:player', () => `preloading "${next.title}" in server ${this.serverId}`);
      } catch (error) {
        // The same failure is reported when the track actually comes up.
        debug('music:player', () => `preload of "${next.title}" failed: ${error?.message || error}`);
      }
    })();
    this.preload = entry;
  }

  /** Hand the preload to playback if it is for `track`; otherwise discard it. */
  private async takePreload(track: Track): Promise<Preload | null> {
    const entry = this.preload;
    if (!entry) return null;
    this.preload = null;
    if (entry.track !== track) {
      entry.cancelled = true;
      entry.pipeline?.stop();
      void entry.ready.then(() => entry.pipeline?.stop());
      return null;
    }
    await entry.ready;
    return entry;
  }

  private dropPreload() {
    const entry = this.preload;
    if (!entry) return;
    this.preload = null;
    entry.cancelled = true;
    entry.pipeline?.stop();
  }

  // ── Controls ─────────────────────────────────────────────────────────────

  private abortCurrent(reason: TrackOutcome) {
    if (!this.abort) return;
    this.abortReason = reason;
    this.abort.abort();
  }

  /** Skip the current track. With `loop track` the skipped track is not repeated. */
  skip(): Track | null {
    const skipped = this.current;
    if (!skipped) return null;
    if (this.connection?.paused) this.connection.resume();
    this.abortCurrent('skipped');
    return skipped;
  }

  /** Clear the queue and stop playback, staying in the channel. */
  stop() {
    this.tracks = [];
    this.dropPreload();
    if (this.connection?.paused) this.connection.resume();
    this.abortCurrent('stopped');
  }

  pause(): boolean {
    if (!this.current || !this.connection || this.connection.paused) return false;
    this.connection.pause();
    return true;
  }

  resume(): boolean {
    if (!this.connection?.paused) return false;
    this.connection.resume();
    return true;
  }

  setVolume(level: number): number {
    this.volumeLevel = clampVolume(level);
    if (this.connection) this.connection.volume = this.volumeLevel;
    return this.volumeLevel;
  }

  shuffle(): number {
    const q = this.tracks;
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    this.refreshPreload();
    return q.length;
  }

  /** Remove by 1-based queue position. */
  remove(position: number): Track | null {
    const index = Math.floor(position) - 1;
    if (index < 0 || index >= this.tracks.length) return null;
    const [removed] = this.tracks.splice(index, 1);
    this.refreshPreload();
    return removed;
  }

  /** Move a track between 1-based positions. */
  move(from: number, to: number): Track | null {
    const source = Math.floor(from) - 1;
    if (source < 0 || source >= this.tracks.length) return null;
    const target = Math.min(Math.max(Math.floor(to) - 1, 0), this.tracks.length - 1);
    const [track] = this.tracks.splice(source, 1);
    this.tracks.splice(target, 0, track);
    this.refreshPreload();
    return track;
  }

  /** Drop the tracks before `position` and play the one there. */
  skipTo(position: number): Track | null {
    const index = Math.floor(position) - 1;
    if (index < 0 || index >= this.tracks.length) return null;
    const dropped = this.tracks.splice(0, index);
    if (this.loopMode === 'queue') {
      // Keep the loop's order: the current track comes before the ones jumped over.
      if (this.current) this.tracks.push(this.current);
      this.tracks.push(...dropped);
    }
    if (this.current) {
      if (this.connection?.paused) this.connection.resume();
      this.abortCurrent('jumped');
    } else {
      this.refreshPreload();
      this.kick();
    }
    return this.tracks[0] ?? null;
  }

  // ── Leaving ──────────────────────────────────────────────────────────────

  private onParticipants(count: number) {
    if (this.destroyed) return;
    if (count > 0) {
      if (this.emptyTimer) clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
      return;
    }
    if (this.emptyTimer) return;
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if ((this.connection?.participantIds.length ?? 0) === 0) void this.destroy('empty');
    }, env.musicIdleTimeoutMs);
    this.emptyTimer.unref?.();
  }

  private scheduleIdle() {
    this.clearIdle();
    if (this.destroyed || this.running) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (!this.running && !this.current) void this.destroy('idle');
    }, env.musicIdleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  async destroy(reason: LeaveReason) {
    if (this.destroyed) return;
    this.destroyed = true;
    debug('music:player', () => `leaving server ${this.serverId}: ${reason}`);
    this.clearIdle();
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = null;
    this.tracks = [];
    this.dropPreload();
    this.abortCurrent('stopped');
    const connection = this.connection;
    this.connection = null;
    if (connection) {
      connection.removeAllListeners();
      await connection.disconnect().catch(() => {});
    }
    this.emit('leave', reason);
    this.removeAllListeners();
  }
}

function clampVolume(level: number): number {
  const value = Number(level);
  if (!Number.isFinite(value)) return 1;
  return Math.min(2, Math.max(0, value));
}
