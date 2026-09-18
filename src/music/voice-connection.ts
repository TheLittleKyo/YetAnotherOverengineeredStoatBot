import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  AudioFrame,
  AudioSource,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
} from '@livekit/rtc-node';
import type { StoatClient } from '../stoat-types.js';
import { withTimeout } from '../async-utils.js';
import { debug } from '../logger.js';
import { CHANNELS, SAMPLE_RATE } from './audio-stream.js';

/** 20 ms frames: 960 samples per channel. */
const SAMPLES_PER_FRAME = SAMPLE_RATE / 50;
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * CHANNELS * 2;
/**
 * How much audio LiveKit buffers ahead. Larger survives event-loop stalls
 * (transcripts, backups) better; smaller makes pause and skip feel instant.
 */
const QUEUE_MS = 500;
const CONNECT_TIMEOUT_MS = 30_000;

export type PlayOutcome = {
  /** Samples per channel handed to LiveKit. */
  samples: number;
  aborted: boolean;
  timedOut: boolean;
};

/**
 * One bot seat in one Stoat voice channel. Stoat voice is LiveKit: the REST
 * `join_call` endpoint hands out a room URL + token, and the bot publishes a
 * single audio track for as long as it stays connected. Tracks are fed frame
 * by frame so pause, volume and skip take effect immediately — stoatbot.js'
 * own AudioPlayer decodes a whole file into memory first and supports neither.
 *
 * Events: `disconnected`, `participants` (remote participant count changed).
 */
export class VoiceConnection extends EventEmitter {
  readonly channelId: string;
  readonly serverId: string;
  private room: Room | null = null;
  private source: AudioSource | null = null;
  private track: LocalAudioTrack | null = null;
  private resumeWaiters: Array<() => void> = [];
  private closing = false;
  volume = 1;
  paused = false;

  private constructor(channelId: string, serverId: string) {
    super();
    this.channelId = channelId;
    this.serverId = serverId;
  }

  static async open(client: StoatClient, channelId: string, serverId: string): Promise<VoiceConnection> {
    const connection = new VoiceConnection(channelId, serverId);
    try {
      await withTimeout(connection.connect(client), CONNECT_TIMEOUT_MS, 'Timed out joining the voice channel.');
    } catch (error) {
      // A room that connected but failed to publish (or timed out) would
      // otherwise leave the bot sitting silently in the call.
      await connection.disconnect().catch(() => {});
      throw error;
    }
    return connection;
  }

  get connected(): boolean {
    return Boolean(this.room?.isConnected) && !this.closing;
  }

  /** Identities of everyone else in the call (Stoat user ids). */
  get participantIds(): string[] {
    return this.room ? [...this.room.remoteParticipants.values()].map((p) => p.identity) : [];
  }

  private async connect(client: StoatClient) {
    const { url, token } = await requestCallToken(client, this.channelId);
    if (this.closing) throw new Error('Voice connection was cancelled.');
    const room = new Room();
    this.room = room;
    room.on(RoomEvent.Disconnected, (reason) => {
      debug('music:voice', () => `room ${this.channelId} disconnected: ${reason}`);
      this.handleClosed();
    });
    room.on(RoomEvent.ParticipantConnected, () => this.emit('participants', room.remoteParticipants.size));
    room.on(RoomEvent.ParticipantDisconnected, () => this.emit('participants', room.remoteParticipants.size));

    await room.connect(url, token, { autoSubscribe: false, dynacast: false });
    if (this.closing) {
      // Timed out or cancelled while connecting: do not publish into a call nobody owns.
      await room.disconnect().catch(() => {});
      throw new Error('Voice connection was cancelled.');
    }

    this.source = new AudioSource(SAMPLE_RATE, CHANNELS, QUEUE_MS);
    this.track = LocalAudioTrack.createAudioTrack('music', this.source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await room.localParticipant?.publishTrack(this.track, options);
    debug('music:voice', () => `joined ${this.channelId} (room ${room.name})`);
  }

  /**
   * Feed PCM to the call until the stream ends, `signal` aborts, or no audio
   * arrives within `startTimeoutMs`. Resolves once the last frame is queued.
   */
  async play(
    pcm: Readable,
    signal: AbortSignal,
    options: { startTimeoutMs?: number; onStart?: () => void; onProgress?: (samples: number) => void } = {},
  ): Promise<PlayOutcome> {
    const outcome: PlayOutcome = { samples: 0, aborted: false, timedOut: false };
    if (!this.source) return { ...outcome, aborted: true };

    let startTimer: NodeJS.Timeout | null = null;
    const abortRead = () => {
      pcm.destroy();
      // Also releases a captureFrame waiting for queue space, so a skip is immediate.
      this.clearBuffered();
    };
    signal.addEventListener('abort', abortRead, { once: true });
    if (options.startTimeoutMs) {
      startTimer = setTimeout(() => {
        outcome.timedOut = true;
        pcm.destroy();
      }, options.startTimeoutMs);
    }

    let pending = Buffer.alloc(0);
    try {
      for await (const chunk of pcm) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        while (pending.length >= BYTES_PER_FRAME) {
          if (signal.aborted || !this.connected) break;
          await this.waitWhilePaused(signal);
          if (signal.aborted) break;

          const frame = pending.subarray(0, BYTES_PER_FRAME);
          pending = pending.subarray(BYTES_PER_FRAME);
          await this.source.captureFrame(this.toFrame(frame));

          if (outcome.samples === 0) {
            if (startTimer) clearTimeout(startTimer);
            startTimer = null;
            options.onStart?.();
          }
          outcome.samples += SAMPLES_PER_FRAME;
          options.onProgress?.(outcome.samples);
        }
        if (signal.aborted || !this.connected) break;
      }
    } catch (error) {
      // Destroying the stream on abort / timeout rejects the iterator; anything
      // else is a real decode failure and is reported through the pipeline.
      if (!signal.aborted && !outcome.timedOut) debug('music:voice', () => `pcm read ended: ${error?.message || error}`);
    } finally {
      if (startTimer) clearTimeout(startTimer);
      signal.removeEventListener('abort', abortRead);
    }

    outcome.aborted = signal.aborted;
    if (signal.aborted) this.clearBuffered();
    return outcome;
  }

  private toFrame(bytes: Buffer): AudioFrame {
    const samples = new Int16Array(SAMPLES_PER_FRAME * CHANNELS);
    const volume = this.volume;
    for (let i = 0; i < samples.length; i++) {
      const value = bytes.readInt16LE(i * 2) * volume;
      samples[i] = value > 32767 ? 32767 : value < -32768 ? -32768 : value;
    }
    return new AudioFrame(samples, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME);
  }

  private waitWhilePaused(signal: AbortSignal): Promise<void> {
    if (!this.paused || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.resumeWaiters.push(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    const waiters = this.resumeWaiters.splice(0);
    for (const wake of waiters) wake();
  }

  /** Drop audio already handed to LiveKit so a skip cuts off immediately. */
  clearBuffered() {
    try {
      this.source?.clearQueue();
    } catch {
      // source already closed
    }
  }

  async disconnect() {
    if (this.closing) return;
    this.closing = true;
    this.resume();
    this.clearBuffered();
    try {
      await this.track?.close(false);
      await this.source?.close();
    } catch (error) {
      debug('music:voice', () => `track close failed: ${error?.message || error}`);
    }
    try {
      await this.room?.disconnect();
    } catch (error) {
      debug('music:voice', () => `room disconnect failed: ${error?.message || error}`);
    }
    this.handleClosed();
  }

  private handleClosed() {
    const wasOpen = this.room !== null;
    this.closing = true;
    this.room = null;
    this.source = null;
    this.track = null;
    this.resume();
    if (wasOpen) this.emit('disconnected');
  }
}

/**
 * Ask Stoat for a LiveKit room token. A bot that crashed while in a call is
 * still registered as connected, so an AlreadyConnected-style rejection is
 * retried after clearing the stale session (the same recovery stoatbot.js uses).
 */
async function requestCallToken(client: StoatClient, channelId: string): Promise<{ url: string; token: string }> {
  const api: any = (client as any).api;
  const node = (client as any).voiceOptions?.nodes?.[0]?.name || 'worldwide';
  const path = `/channels/${channelId}/join_call`;

  const attempts: Array<() => Promise<any>> = [
    () => api.post(path, { body: { node } }),
    async () => {
      await api.delete(path).catch(() => {});
      return api.post(path, { body: { node } });
    },
    () => api.post(path, { body: { node, force: true } }),
  ];

  let lastError: any = null;
  for (const attempt of attempts) {
    try {
      const response = await attempt();
      if (response?.url && response?.token) return { url: response.url, token: response.token };
      lastError = new Error('Stoat did not return voice credentials.');
    } catch (error) {
      lastError = error;
      const text = String(error?.message || error);
      if (/\b403\b/.test(text)) throw new Error('I am not allowed to join that voice channel (missing Connect/Speak permission).');
      if (/\b404\b/.test(text)) throw new Error('That voice channel does not exist anymore.');
    }
  }
  throw new Error(`Could not join the voice channel: ${lastError?.message || lastError}`);
}
