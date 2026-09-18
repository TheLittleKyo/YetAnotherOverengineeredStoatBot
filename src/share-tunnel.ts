/**
 * Cloudflare quick-tunnel manager for the dashboard share-link feature.
 *
 * A "quick tunnel" (`cloudflared tunnel --url ...`) exposes the local dashboard
 * at a random `https://<sub>.trycloudflare.com` URL with no Cloudflare account
 * and no inbound port opened — cloudflared dials out to Cloudflare. One tunnel
 * is shared by every share link (it exposes the whole dashboard; links differ
 * only by their token), started lazily on the first mint.
 *
 * The only "setup" is the cloudflared binary. We detect one already on PATH,
 * else download the official release once into the data dir and reuse it — so
 * the operator does nothing.
 */
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { get } from 'https';
import { createWriteStream, existsSync, mkdirSync, chmodSync, renameSync } from 'fs';
import { dirname } from 'path';
import { dataFile } from './json-store.js';
import { debug, info, warn, error as logError } from './logger.js';

const IS_WIN = process.platform === 'win32';

function binPath(): string {
  return dataFile(IS_WIN ? 'bin/cloudflared.exe' : 'bin/cloudflared');
}

/** Official cloudflared release asset for this platform/arch. */
function downloadUrl(): string {
  const base = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
  const arm = process.arch === 'arm64';
  if (IS_WIN) return base + (arm ? 'cloudflared-windows-arm64.exe' : 'cloudflared-windows-amd64.exe');
  if (process.platform === 'linux') return base + (arm ? 'cloudflared-linux-arm64' : 'cloudflared-linux-amd64');
  // macOS ships a .tgz that needs extraction — handled as an explicit error below.
  return '';
}

let cachedBin: string | null = null;

function findOnPath(): string | null {
  try {
    const r = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
    if (r.status === 0) return 'cloudflared';
  } catch {
    /* not on PATH */
  }
  return null;
}

function httpsGetFollow(
  url: string,
  onResponse: (res: import('http').IncomingMessage) => void,
  onError: (err: Error) => void,
  redirects = 0,
): void {
  const req = get(url, (res) => {
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location && redirects < 5) {
      res.resume();
      httpsGetFollow(new URL(res.headers.location, url).toString(), onResponse, onError, redirects + 1);
      return;
    }
    onResponse(res);
  });
  req.on('error', onError);
  // Abort a stalled connection instead of hanging the Create-link request.
  req.setTimeout(60_000, () => req.destroy(new Error('cloudflared download timed out')));
}

async function download(url: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = dest + '.download';
  await new Promise<void>((resolve, reject) => {
    httpsGetFollow(
      url,
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error('cloudflared download HTTP ' + res.statusCode));
          return;
        }
        const file = createWriteStream(tmp);
        res.pipe(file);
        file.on('error', reject);
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
      },
      reject,
    );
  });
  renameSync(tmp, dest);
  if (!IS_WIN) chmodSync(dest, 0o755);
}

/** Resolve a usable cloudflared path: PATH copy, cached download, or fetch once. */
export async function ensureCloudflared(): Promise<string> {
  if (cachedBin) return cachedBin;

  const onPath = findOnPath();
  if (onPath) {
    cachedBin = onPath;
    return onPath;
  }

  const bin = binPath();
  if (existsSync(bin)) {
    cachedBin = bin;
    return bin;
  }

  const url = downloadUrl();
  if (!url) {
    throw new Error(
      'Auto-download of cloudflared is not supported on this platform. Install it manually (e.g. `brew install cloudflared`) so it is on PATH.',
    );
  }
  info('[share] downloading cloudflared (one-time, ~35MB)…');
  await download(url, bin);
  info('[share] cloudflared ready.');
  cachedBin = bin;
  return bin;
}

let child: ChildProcess | null = null;
let tunnelUrl: string | null = null;
let startPromise: Promise<string> | null = null;

export function getTunnelUrl(): string | null {
  return tunnelUrl;
}

/** Start the tunnel if needed and return its public URL. Reuses a live tunnel. */
export async function ensureTunnel(port: number): Promise<string> {
  if (tunnelUrl && child && !child.killed) return tunnelUrl;
  if (startPromise) return startPromise;
  startPromise = startTunnel(port).finally(() => {
    startPromise = null;
  });
  return startPromise;
}

async function startTunnel(port: number): Promise<string> {
  const bin = await ensureCloudflared();
  return new Promise<string>((resolve, reject) => {
    const proc = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('cloudflared did not produce a URL within 25s'));
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
    }, 25_000);

    // cloudflared prints the trycloudflare URL to stderr; watch both streams.
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      debug('share:tunnel', () => text.trim());
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        tunnelUrl = match[0];
        info('[share] tunnel live: ' + tunnelUrl);
        resolve(tunnelUrl);
      }
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);

    proc.on('exit', (code) => {
      child = null;
      tunnelUrl = null;
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('cloudflared exited (code ' + code + ') before a URL appeared'));
      } else {
        warn('[share] cloudflared tunnel exited (code ' + code + '). Existing share links are offline until re-created.');
      }
    });
    proc.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        logError('[share] failed to launch cloudflared: ' + (err?.message || err));
        reject(err);
      }
    });
  });
}

export function stopTunnel(): void {
  tunnelUrl = null;
  if (child) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    child = null;
  }
}
