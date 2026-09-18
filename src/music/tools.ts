import { spawn, type ChildProcess } from 'node:child_process';
import { env } from '../config.js';
import { debug } from '../logger.js';
import {
  ensureYtDlp,
  getYtDlpCommand,
  isManagedYtDlp,
  jsRuntimeArgs,
  onYtDlpUpdated,
  requestYtDlpUpdate,
  spawnYtDlp,
} from './ytdlp-binary.js';

/**
 * yt-dlp and ffmpeg are external binaries. yt-dlp is managed by the bot (see
 * ytdlp-binary.ts) unless YTDLP_PATH points elsewhere; ffmpeg comes from
 * FFMPEG_PATH or PATH.
 */

export type ToolStatus = {
  ytDlp: string | null;
  ffmpeg: string | null;
};

let cachedStatus: Promise<ToolStatus> | null = null;
let ytDlpVersion: string | null = null;
let ffmpegVersion: string | null = null;

/**
 * `ffmpeg version 8.1.1-full_build…` → 8.1, `n7.1` → 7.1. Git snapshots
 * (`N-12345-g…`) are newer than any release. Null until probed or unparseable.
 */
export function parseFfmpegVersion(line: string | null | undefined): number | null {
  const text = String(line || '');
  if (/ffmpeg version N-\d+/i.test(text)) return Number.POSITIVE_INFINITY;
  const match = text.match(/ffmpeg version n?(\d+)\.(\d+)/i);
  return match ? Number(match[1]) + Number(match[2]) / 10 : null;
}

export function ffmpegMajorMinor(): number | null {
  return parseFfmpegVersion(ffmpegVersion);
}

/** Version probe for both binaries, cached until something is missing or yt-dlp is replaced. */
export function checkMusicTools(): Promise<ToolStatus> {
  if (!cachedStatus) {
    cachedStatus = Promise.all([
      ensureYtDlp().then(() => probeVersion(() => spawnYtDlp(['--version']))),
      probeVersion(() => spawn(env.ffmpegPath, ['-version'], { windowsHide: true })),
    ]).then(([ytDlp, ffmpeg]) => {
      ytDlpVersion = ytDlp;
      ffmpegVersion = ffmpeg;
      // A missing tool may be installed while the bot runs; probe again next time.
      if (!ytDlp || !ffmpeg) cachedStatus = null;
      return { ytDlp, ffmpeg };
    });
  }
  return cachedStatus;
}

/** Forget the cached versions (after yt-dlp updated itself). */
export function invalidateToolStatus() {
  cachedStatus = null;
}

onYtDlpUpdated(invalidateToolStatus);

/** A readable explanation when a tool is missing, or null when both are present. */
export async function describeMissingTools(): Promise<string | null> {
  const status = await checkMusicTools();
  const missing: string[] = [];
  if (!status.ytDlp) {
    missing.push(
      isManagedYtDlp()
        ? '`yt-dlp` (automatic download failed — check the host\'s internet access, or set `YTDLP_PATH`)'
        : '`yt-dlp` (set `YTDLP_PATH` to a working binary)',
    );
  }
  if (!status.ffmpeg) missing.push('`ffmpeg` (set `FFMPEG_PATH` or add it to PATH)');
  if (missing.length === 0) return null;
  return `Music needs these programs on the bot host: ${missing.join(', ')}.`;
}

/** Flags every yt-dlp invocation shares. */
export function ytDlpBaseArgs(): string[] {
  // yt-dlp shells out to ffmpeg for live streams and some formats; point it at
  // the same binary when FFMPEG_PATH moved it off PATH.
  const ffmpeg = process.env.FFMPEG_PATH ? ['--ffmpeg-location', env.ffmpegPath] : [];
  return ['--no-update', '--no-warnings', '--ignore-config', ...jsRuntimeArgs(ytDlpVersion), ...ffmpeg];
}

/**
 * Stop a child process and everything it started. yt-dlp's standalone
 * Windows build is a launcher plus a second process doing the actual work;
 * `child.kill()` only ends the launcher, and the worker keeps downloading.
 */
export function killProcessTree(child: ChildProcess | null | undefined) {
  if (!child) return;
  const running = child.exitCode === null && child.signalCode === null;
  if (running) {
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => {
        try {
          child.kill();
        } catch {
          // already gone
        }
      });
    } else {
      try {
        child.kill();
      } catch {
        // already gone
      }
    }
  }
  // An orphaned worker that still holds the pipe exits on its next write.
  child.stdout?.destroy();
  child.stdin?.destroy();
}

/**
 * Errors a newer yt-dlp release typically fixes: YouTube rejecting media URLs
 * or demanding a bot check after it changed something on its side.
 */
export function isOutdatedYtDlpError(message: string): boolean {
  return /HTTP Error 403|Sign in to confirm|page needs to be reloaded|nsig|n challenge|signature extraction|Precondition check failed|Requested format is not available/i.test(
    String(message || ''),
  );
}

function probeVersion(start: () => ChildProcess): Promise<string | null> {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = start();
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => killProcessTree(child), 60_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      resolve(output.split(/\r?\n/)[0].trim() || 'unknown');
    });
  });
}

/**
 * Run yt-dlp and parse its single JSON document (`-J`). Rejects with the last
 * `ERROR:` line yt-dlp printed so the user sees why a link failed.
 */
export function runYtDlpJson(args: string[], timeoutMs = 45_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const fullArgs = [...ytDlpBaseArgs(), '-J', ...args];
    debug('music:ytdlp', () => `${getYtDlpCommand()} ${fullArgs.join(' ')}`);
    const child = spawnYtDlp(fullArgs);
    const out: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      killProcessTree(child);
      reject(new Error('yt-dlp took too long to answer.'));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start yt-dlp: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(out).toString('utf8').trim();
      if (code !== 0 || !text) {
        const message = extractYtDlpError(stderr) || `yt-dlp exited with code ${code}.`;
        if (isOutdatedYtDlpError(message)) requestYtDlpUpdate(message);
        reject(new Error(message));
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('yt-dlp returned unreadable output.'));
      }
    });
  });
}

/** The most useful line of yt-dlp stderr, without the `ERROR: [extractor] id:` prefix. */
export function extractYtDlpError(stderr: string): string {
  const lines = String(stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((line) => line.startsWith('ERROR:'));
  if (!errorLine) return '';
  return errorLine
    .replace(/^ERROR:\s*/, '')
    .replace(/^\[[^\]]+\]\s*[\w-]+:\s*/, '')
    .slice(0, 300);
}
