import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { withTimeout } from '../async-utils.js';
import { env } from '../config.js';
import { debug } from '../logger.js';
import { extractYtDlpError, ffmpegMajorMinor, isOutdatedYtDlpError, killProcessTree, ytDlpBaseArgs } from './tools.js';
import { BROWSER_UA, RADIO_USER_AGENT } from './radio.js';
import type { Track } from './types.js';
import { requestYtDlpUpdate, spawnYtDlp } from './ytdlp-binary.js';
import {
  openAudioStream,
  parseYouTubeUrl,
  streamBreaker,
  YouTubeLiveError,
  YouTubeRestrictedError,
  YouTubeUnavailableError,
} from './youtube.js';

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;

/**
 * Encoded audio kept ahead of the decoder. Downloading a whole song up front
 * (16 MB is ~17 minutes at 128 kbps) means a long pause or a network blip
 * does not leave an idle HTTP connection for YouTube to drop mid-track.
 */
const READ_AHEAD_BYTES = 16 * 1024 * 1024;
/** Upper bound for youtubei.js to hand over a stream before yt-dlp takes over. */
const FAST_PATH_OPEN_TIMEOUT_MS = 20_000;

/**
 * yt-dlp's default YouTube client sometimes gets its media URLs rejected
 * until yt-dlp itself is updated. Retrying with these clients keeps playback
 * working in the meantime.
 */
const YOUTUBE_CLIENT_FALLBACKS: string[][] = [
  [],
  ['--extractor-args', 'youtube:player_client=web_safari'],
  ['--extractor-args', 'youtube:player_client=mweb'],
];

/**
 * The client that last produced audio is tried first next time, so only the
 * first track after a YouTube-side change pays for the failed attempts
 * (each costs a full 2-4 s extraction).
 */
let preferredYouTubeClient = 0;

export function youTubeAttemptOrder(preferred = preferredYouTubeClient): number[] {
  const order = YOUTUBE_CLIENT_FALLBACKS.map((_, index) => index);
  return [preferred, ...order.filter((index) => index !== preferred)];
}

export type AudioPipeline = {
  /** Raw PCM: signed 16-bit little-endian, 48 kHz, stereo. */
  pcm: Readable;
  stop: () => void;
  /** Why the source failed, if it did. Read after `pcm` ends. */
  error: () => string | null;
};

export type FfmpegInputOptions = {
  /** ffmpeg fetches `input` over HTTP itself. */
  network?: boolean;
  /** An endless radio stream: reconnect whenever the server drops us, even at "end of file". */
  radio?: boolean;
  /** HLS/DASH manifest; its segments end normally, so no reconnect-at-EOF. */
  manifest?: 'hls' | 'dash';
  /** ffmpeg `major.minor`, to use options only newer releases understand. */
  ffmpegVersion?: number | null;
};

/** A stalled socket errors after 20 s (and HTTP reconnects) instead of hanging silently. */
const RW_TIMEOUT = ['-rw_timeout', '20000000'];

/**
 * Input options for one source. Protocol options are only valid for their own
 * protocol (`-reconnect` on an RTSP input is a fatal "Option not found"), so
 * they are chosen per URL scheme.
 */
function inputOptions(input: string, options: FfmpegInputOptions): string[] {
  const scheme = (input.match(/^([a-z][a-z0-9+.-]*):/i)?.[1] || '').toLowerCase();
  const http = scheme === 'http' || scheme === 'https';

  if (!options.radio) {
    return options.network && http ? ['-user_agent', BROWSER_UA, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : [];
  }
  if (scheme === 'rtsp' || scheme === 'rtsps') return ['-rtsp_transport', 'tcp', ...RW_TIMEOUT];
  if (!http) return RW_TIMEOUT; // RTMP, MMS

  const args = ['-user_agent', RADIO_USER_AGENT, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10', '-reconnect_on_network_error', '1', ...RW_TIMEOUT];
  if (!options.manifest) args.push('-reconnect_at_eof', '1');
  if (options.manifest === 'hls') {
    // Stations serve HLS segments from scripts (`segment.php?s=…`) that ffmpeg's
    // extension allow-list would silently skip, producing no audio at all.
    args.push('-allowed_extensions', 'ALL');
    if ((options.ffmpegVersion ?? 0) >= 8) args.push('-allowed_segment_extensions', 'ALL', '-extension_picky', '0');
  }
  return args;
}

export function ffmpegArgs(input: string, options: FfmpegInputOptions = {}): string[] {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    ...inputOptions(input, options),
    '-i', input,
    '-vn',
    '-f', 's16le',
    '-ar', String(SAMPLE_RATE),
    '-ac', String(CHANNELS),
    'pipe:1',
  ];
}

export function ytDlpStreamArgs(url: string, extra: string[]): string[] {
  return [...ytDlpBaseArgs(), '--no-playlist', '--quiet', '-f', 'bestaudio/best', ...extra, '-o', '-', url];
}

/** An opened source of encoded audio bytes. `finished` resolves to an error message, or null on success. */
type OpenedSource = { stream: Readable; finished: Promise<string | null>; kill: () => void };

/**
 * One way of getting the track's bytes. Attempts run in order; the next one
 * only starts if the previous failed before delivering any audio.
 */
export type SourceAttempt = {
  label: string;
  open: () => Promise<OpenedSource>;
  /** Called with the failure; return true to stop trying further attempts. */
  onFailure?: (message: string, error?: unknown) => boolean | void;
  onSuccess?: () => void;
};

export function createAudioPipeline(track: Track): AudioPipeline {
  const url = track.playbackUrl;
  if (!url) throw new Error('Track has no playable URL.');
  if (track.source === 'radio') {
    return directPipeline(url, { radio: true, manifest: track.radio?.manifest, ffmpegVersion: ffmpegMajorMinor() });
  }
  if (track.source === 'direct') return directPipeline(url, { network: true });
  return sourcePipeline(buildAttempts(track, url));
}

/** Radio streams and plain audio files: ffmpeg fetches the URL itself. */
function directPipeline(url: string, options: FfmpegInputOptions): AudioPipeline {
  let failure: string | null = null;
  const ffmpeg = spawn(env.ffmpegPath, ffmpegArgs(url, options), { windowsHide: true });
  let stderr = '';
  ffmpeg.stderr.on('data', (chunk) => { stderr += chunk; });
  ffmpeg.on('error', (error) => { failure = `Could not start ffmpeg: ${error.message}`; });
  ffmpeg.on('close', (code) => {
    if (code && !failure) failure = lastLine(stderr) || `ffmpeg exited with code ${code}.`;
  });
  return {
    pcm: ffmpeg.stdout,
    stop: () => kill(ffmpeg),
    error: () => failure,
  };
}

function buildAttempts(track: Track, url: string): SourceAttempt[] {
  const youtube = parseYouTubeUrl(url);
  const attempts: SourceAttempt[] = [];

  if (youtube?.videoId && !track.isLive && streamBreaker.available) {
    const videoId = youtube.videoId;
    attempts.push({
      label: 'youtubei.js',
      open: async () => {
        const stream = await withTimeout(openAudioStream(videoId), FAST_PATH_OPEN_TIMEOUT_MS, 'youtubei.js took too long to open the stream', (late) =>
          late.destroy(),
        );
        return { stream, finished: streamOutcome(stream), kill: () => stream.destroy() };
      },
      onSuccess: () => streamBreaker.success(),
      onFailure: (_message, error) => {
        // Dead videos end the search; live streams and SABR-only videos are yt-dlp's job.
        // None of the three means youtubei.js is broken, so the breaker ignores them.
        if (error instanceof YouTubeUnavailableError) return true;
        if (error instanceof YouTubeLiveError || error instanceof YouTubeRestrictedError) return false;
        streamBreaker.failure(error);
        return false;
      },
    });
  }

  const order = youtube ? youTubeAttemptOrder() : [0];
  for (const client of order) {
    attempts.push({
      label: `yt-dlp${client ? ` (${YOUTUBE_CLIENT_FALLBACKS[client][1]})` : ''}`,
      open: async () => openYtDlp(url, YOUTUBE_CLIENT_FALLBACKS[client]),
      onSuccess: () => {
        if (youtube) preferredYouTubeClient = client;
      },
    });
  }
  return attempts;
}

function openYtDlp(url: string, extra: string[]): OpenedSource {
  const child = spawnYtDlp(ytDlpStreamArgs(url, extra));
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const finished = new Promise<string | null>((resolve) => {
    child.on('error', (error) => resolve(`Could not start yt-dlp: ${error.message}`));
    child.on('close', (code) => resolve(code === 0 ? null : extractYtDlpError(stderr) || `yt-dlp exited with code ${code}.`));
  });
  return { stream: child.stdout, finished, kill: () => killProcessTree(child) };
}

function streamOutcome(stream: Readable): Promise<string | null> {
  return new Promise((resolve) => {
    stream.once('end', () => resolve(null));
    stream.once('error', (error) => resolve(error?.message || String(error)));
    stream.once('close', () => resolve(null));
  });
}

/** Feed attempts into one ffmpeg decoder, moving to the next attempt while nothing has played yet. */
export function sourcePipeline(attempts: SourceAttempt[]): AudioPipeline {
  let failure: string | null = null;
  let stopped = false;
  let current: OpenedSource | null = null;

  const ffmpeg = spawn(env.ffmpegPath, ffmpegArgs('pipe:0'), { windowsHide: true });
  let ffmpegStderr = '';
  ffmpeg.stderr.on('data', (chunk) => { ffmpegStderr += chunk; });
  ffmpeg.stdin.on('error', () => {}); // EPIPE when ffmpeg exits first
  ffmpeg.on('error', (error) => { failure = `Could not start ffmpeg: ${error.message}`; });
  ffmpeg.on('close', (code) => {
    if (code && !failure && !stopped) failure = lastLine(ffmpegStderr) || `ffmpeg exited with code ${code}.`;
  });

  const run = async () => {
    let lastError = 'no audio source worked';
    let succeeded = false;
    const ytDlpErrors: string[] = [];

    for (const attempt of attempts) {
      if (stopped) return;
      let opened: OpenedSource;
      try {
        opened = await attempt.open();
      } catch (error) {
        lastError = (error as any)?.message || String(error);
        debug('music:stream', () => `${attempt.label} failed to open: ${lastError}`);
        if (attempt.onFailure?.(lastError, error)) break;
        continue;
      }
      if (stopped) {
        opened.kill();
        return;
      }

      current = opened;
      const bytes = await copyInto(opened.stream, ffmpeg.stdin, () => stopped);
      const outcome = await opened.finished;
      current = null;
      if (stopped) return;

      if (bytes > 0) {
        succeeded = true;
        attempt.onSuccess?.();
        break;
      }
      lastError = outcome || 'the source sent no audio';
      if (attempt.label.startsWith('yt-dlp')) ytDlpErrors.push(lastError);
      debug('music:stream', () => `${attempt.label} produced no audio: ${lastError}`);
      if (attempt.onFailure?.(lastError)) break;
    }

    if (!succeeded) {
      failure ||= lastError;
      // Every yt-dlp attempt hit the kind of error a new yt-dlp release fixes.
      if (ytDlpErrors.length > 0 && ytDlpErrors.every(isOutdatedYtDlpError)) requestYtDlpUpdate(ytDlpErrors[0]);
    }
    ffmpeg.stdin.end();
  };

  run().catch((error) => {
    failure = (error as any)?.message || String(error);
    ffmpeg.stdin.end();
  });

  return {
    pcm: ffmpeg.stdout,
    stop: () => {
      stopped = true;
      current?.kill();
      kill(ffmpeg);
    },
    error: () => failure,
  };
}

/**
 * Copy into the decoder, buffering up to READ_AHEAD_BYTES before applying
 * backpressure; returns the number of bytes written. Never throws.
 */
async function copyInto(source: Readable, target: Writable, isStopped: () => boolean): Promise<number> {
  let bytes = 0;
  try {
    for await (const chunk of source) {
      if (isStopped() || target.destroyed) break;
      bytes += chunk.length;
      if (!target.write(chunk) && target.writableLength >= READ_AHEAD_BYTES) await drained(target);
    }
  } catch {
    // reported through the source's `finished`
  }
  return bytes;
}

function drained(target: Writable): Promise<void> {
  if (target.destroyed || !target.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      target.off('drain', done);
      target.off('close', done);
      target.off('error', done);
      resolve();
    };
    target.on('drain', done);
    target.on('close', done);
    target.on('error', done);
  });
}

function kill(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
}

function lastLine(text: string): string {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return (lines[lines.length - 1] || '').slice(0, 300);
}
