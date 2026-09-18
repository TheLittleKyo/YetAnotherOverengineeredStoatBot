import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sleep } from '../async-utils.js';
import { env } from '../config.js';
import { readJson, writeJson } from '../json-store.js';
import { debug } from '../logger.js';

/**
 * The bot keeps its own copy of yt-dlp, downloaded from the official GitHub
 * releases into `bin/`, checksum-verified, and refreshed daily — or right away
 * when YouTube starts rejecting it. YouTube breaks old yt-dlp versions every
 * few weeks, so a system-wide install nobody updates stops working.
 *
 * The "onedir" zip builds are preferred: the single-file builds unpack their
 * Python runtime to a temp folder on every launch, which costs about a second
 * per track (measured 2.1–2.6 s vs 0.8–1.5 s just to start). Each release is
 * installed into its own folder, `bin/yt-dlp-<version>-<kind>/`, so an update
 * never touches files a running download still uses; old folders are removed
 * once nothing runs from them.
 *
 * Setting YTDLP_PATH opts out: that binary is used as-is and never updated.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const RELEASES = 'https://github.com/yt-dlp/yt-dlp/releases';
const USER_AGENT = 'YetAnotherOverengineeredStoatBot-Music/1.0 (yt-dlp updater)';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FORCED_UPDATE_COOLDOWN_MS = 30 * 60 * 1000;
/** Offline hosts would otherwise wait on GitHub timeouts again on every command. */
const FIRST_RUN_RETRY_MS = 10 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 150 * 1024 * 1024;

export const BIN_DIR = process.env.YAOSB_BIN_DIR
  ? resolve(process.env.YAOSB_BIN_DIR)
  : join(__dirname, '..', '..', 'bin');

const IS_WINDOWS = process.platform === 'win32';
const STATE_FILE = join(BIN_DIR, 'yt-dlp.json');
const INSTALL_DIR_PATTERN = /^yt-dlp-[\w.]+-(zip|binary)(-\d+)?$/;

type BinaryState = {
  version?: string;
  asset?: string;
  /** Path of the executable relative to BIN_DIR. */
  executable?: string;
  checkedAt?: number;
  updatedAt?: number;
};

export type ReleaseAsset = { name: string; kind: 'zip' | 'binary' };

function isMusl(): boolean {
  if (process.platform !== 'linux') return false;
  try {
    const report: any = process.report?.getReport?.();
    return !report?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * Release assets for this OS/CPU in order of preference: the onedir zip, then
 * the single-file build as a fallback if the zip will not run. Empty when
 * yt-dlp publishes nothing for the platform.
 */
export function releaseAssets(platform: string = process.platform, arch: string = process.arch, musl = isMusl()): ReleaseAsset[] {
  const pair = (zip: string | null, binary: string | null): ReleaseAsset[] => [
    ...(zip ? [{ name: zip, kind: 'zip' as const }] : []),
    ...(binary ? [{ name: binary, kind: 'binary' as const }] : []),
  ];
  if (platform === 'win32') {
    if (arch === 'x64') return pair('yt-dlp_win.zip', 'yt-dlp.exe');
    if (arch === 'arm64') return pair('yt-dlp_win_arm64.zip', 'yt-dlp_arm64.exe');
    if (arch === 'ia32') return pair('yt-dlp_win_x86.zip', 'yt-dlp_x86.exe');
    return [];
  }
  if (platform === 'linux') {
    const libc = musl ? 'musllinux' : 'linux';
    if (arch === 'x64') return pair(`yt-dlp_${libc}.zip`, `yt-dlp_${libc}`);
    if (arch === 'arm64') return pair(`yt-dlp_${libc}_aarch64.zip`, `yt-dlp_${libc}_aarch64`);
    if (arch === 'arm' && !musl) return pair('yt-dlp_linux_armv7l.zip', null);
    return [];
  }
  if (platform === 'darwin') return pair('yt-dlp_macos.zip', 'yt-dlp_macos');
  return [];
}

/** Find `asset`'s hash in a SHA2-256SUMS file (`<hex>  <name>` per line). */
export function parseChecksum(sums: string, asset: string): string | null {
  for (const line of String(sums || '').split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match && match[2].trim() === asset) return match[1].toLowerCase();
  }
  return null;
}

/** `https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19` → `2026.08.19`. */
export function tagFromReleaseUrl(location: string | null): string | null {
  const match = String(location || '').match(/\/releases\/tag\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

/** The launcher inside an extracted onedir build (`yt-dlp.exe`, `yt-dlp_linux`, `yt-dlp_macos`, …). */
export function findLauncherName(rootEntries: string[]): string | null {
  const candidates = rootEntries.filter((name) => /^yt-dlp[a-z0-9_]*(\.exe)?$/i.test(name));
  return candidates.find((name) => name.toLowerCase().endsWith('.exe')) || candidates[0] || null;
}

export function isManagedYtDlp(): boolean {
  return !env.ytDlpPath && releaseAssets().length > 0;
}

// ── State ──────────────────────────────────────────────────────────────────

let cachedState: BinaryState | null = null;

function readState(): BinaryState {
  if (!cachedState) cachedState = readJson<BinaryState>(STATE_FILE, {});
  return cachedState;
}

function saveState(state: BinaryState) {
  cachedState = state;
  writeJson(STATE_FILE, state);
}

/** Test hook: forget the in-memory copy of `bin/yt-dlp.json` so the next read hits the file. */
export function reloadYtDlpState() {
  cachedState = null;
}

/** Absolute path of the installed managed executable, or null when none is usable. */
function managedExecutable(): string | null {
  const rel = readState().executable;
  if (!rel) return null;
  const absolute = resolve(BIN_DIR, rel);
  return existsSync(absolute) ? absolute : null;
}

/** `yt-dlp-2026.08.19-zip` for anything spawned from inside that install folder. */
function installDirOf(executable: string): string | null {
  const rel = relative(BIN_DIR, executable);
  if (!rel || rel.startsWith('..')) return null;
  const top = rel.split(/[\\/]/)[0];
  return INSTALL_DIR_PATTERN.test(top) ? top : null;
}

/**
 * The yt-dlp command to spawn right now: the YTDLP_PATH override, the managed
 * copy once installed, or `yt-dlp` from PATH as a last resort.
 */
export function getYtDlpCommand(): string {
  if (env.ytDlpPath) return env.ytDlpPath;
  if (isManagedYtDlp()) return managedExecutable() || 'yt-dlp';
  return 'yt-dlp';
}

/** Running yt-dlp processes per install folder; a folder in use is never deleted. */
const activeUses = new Map<string, number>();

/** Spawn yt-dlp, keeping its install folder alive for as long as the process runs. */
export function spawnYtDlp(args: string[]): ChildProcess {
  const command = getYtDlpCommand();
  const installDir = installDirOf(command);
  const child = spawn(command, args, { windowsHide: true });
  if (installDir) {
    activeUses.set(installDir, (activeUses.get(installDir) || 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const left = (activeUses.get(installDir) || 1) - 1;
      if (left > 0) activeUses.set(installDir, left);
      else activeUses.delete(installDir);
    };
    child.once('close', release);
    child.once('error', release);
  }
  return child;
}

// ── Updating ───────────────────────────────────────────────────────────────

let inFlight: Promise<void> | null = null;
let lastForcedAt = 0;
let lastFirstRunFailureAt = 0;

/** Make sure a usable yt-dlp exists, downloading the managed copy on first use. */
export async function ensureYtDlp(): Promise<string> {
  if (isManagedYtDlp() && !managedExecutable() && Date.now() - lastFirstRunFailureAt >= FIRST_RUN_RETRY_MS) {
    try {
      await updateYtDlp({ force: true, reason: 'first run' });
    } catch (error) {
      lastFirstRunFailureAt = Date.now();
      console.warn(`⚠️ Could not download yt-dlp: ${error?.message || error}. Falling back to yt-dlp on PATH.`);
    }
  }
  return getYtDlpCommand();
}

/**
 * Check GitHub for a newer release and install it. Without `force`, does
 * nothing if the last check was under a day ago. Concurrent calls share one run.
 */
export function updateYtDlp(options: { force?: boolean; reason?: string } = {}): Promise<void> {
  if (!isManagedYtDlp()) return Promise.resolve();
  if (inFlight) return inFlight;

  const state = readState();
  const fresh = managedExecutable() && state.checkedAt && Date.now() - state.checkedAt < CHECK_INTERVAL_MS;
  if (!options.force && fresh) return Promise.resolve();

  inFlight = installLatest(options.reason || 'scheduled check').finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * Called when YouTube rejects yt-dlp (403, "sign in to confirm", …): a new
 * release usually fixes it. Rate-limited so a dead video cannot trigger a
 * download loop. Never awaited by playback.
 */
export function requestYtDlpUpdate(reason: string): void {
  if (!isManagedYtDlp() || Date.now() - lastForcedAt < FORCED_UPDATE_COOLDOWN_MS) return;
  lastForcedAt = Date.now();
  updateYtDlp({ force: true, reason }).catch((error) => {
    console.warn(`⚠️ yt-dlp update after "${reason}" failed: ${error?.message || error}`);
  });
}

const updateListeners = new Set<() => void>();

/** Run `listener` whenever a new yt-dlp binary has been installed. */
export function onYtDlpUpdated(listener: () => void) {
  updateListeners.add(listener);
}

async function installLatest(reason: string): Promise<void> {
  mkdirSync(BIN_DIR, { recursive: true });
  removeStaleInstalls();

  const tag = await fetchLatestTag();
  const state = readState();
  if (managedExecutable() && state.version === tag) {
    saveState({ ...state, checkedAt: Date.now() });
    debug('music:ytdlp', () => `yt-dlp ${tag} is current (${reason})`);
    return;
  }

  const sums = await fetchText(`${RELEASES}/download/${encodeURIComponent(tag)}/SHA2-256SUMS`);
  let lastError: unknown = new Error(`no yt-dlp build for ${process.platform}/${process.arch}`);
  for (const asset of releaseAssets()) {
    const expected = parseChecksum(sums, asset.name);
    if (!expected) {
      lastError = new Error(`no checksum for ${asset.name} in release ${tag}`);
      continue;
    }
    try {
      console.log(`🎵 Downloading yt-dlp ${tag} (${asset.name}) — ${reason}…`);
      const { executable, reported } = await installAsset(tag, asset, expected);
      saveState({ version: tag, asset: asset.name, executable, checkedAt: Date.now(), updatedAt: Date.now() });
      console.log(`✅ yt-dlp ${reported} installed in ${join(BIN_DIR, dirname(executable))}`);
      removeStaleInstalls();
      for (const listener of updateListeners) listener();
      return;
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ Installing ${asset.name} failed: ${(error as any)?.message || error}`);
    }
  }
  throw lastError;
}

/** Download, verify, unpack and test one asset. Returns the executable path relative to BIN_DIR. */
async function installAsset(tag: string, asset: ReleaseAsset, expectedHash: string) {
  const stamp = Date.now();
  const staging = join(BIN_DIR, `.staging-${stamp}`);
  const download = join(BIN_DIR, `.download-${stamp}`);
  mkdirSync(staging, { recursive: true });

  try {
    const actual = await downloadFile(`${RELEASES}/download/${encodeURIComponent(tag)}/${asset.name}`, download);
    if (actual !== expectedHash) throw new Error(`checksum mismatch (expected ${expectedHash}, got ${actual})`);

    let launcher: string;
    if (asset.kind === 'zip') {
      await extractZip(download, staging);
      launcher = findLauncherName(readdirSync(staging).filter((name) => statSync(join(staging, name)).isFile()));
      if (!launcher) throw new Error('no yt-dlp executable in the archive');
    } else {
      launcher = IS_WINDOWS ? 'yt-dlp.exe' : 'yt-dlp';
      renameSync(download, join(staging, launcher));
    }
    if (!IS_WINDOWS) chmodSync(join(staging, launcher), 0o755);

    const reported = await runVersion(join(staging, launcher));
    if (!reported) throw new Error('the downloaded yt-dlp does not run on this machine');

    let installName = `yt-dlp-${tag.replace(/[^\w.]/g, '_')}-${asset.kind}`;
    if (existsSync(join(BIN_DIR, installName))) {
      if (activeUses.has(installName) || !tryRemove(installName)) installName = `${installName}-${stamp}`;
    }
    await renameWithRetry(staging, join(BIN_DIR, installName));
    return { executable: `${installName}/${launcher}`, reported };
  } finally {
    rmSync(download, { force: true });
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Unzip in a worker thread: a 40 MB archive inflated on the main thread
 * stalls the event loop long enough to stutter playing music.
 */
function extractZip(zipPath: string, destination: string): Promise<void> {
  const code = `
    const { workerData, parentPort } = require('node:worker_threads');
    const fs = require('node:fs');
    const path = require('node:path');
    const { unzipSync } = require(workerData.fflate);
    const root = path.resolve(workerData.destination);
    const files = unzipSync(fs.readFileSync(workerData.zipPath));
    for (const [name, data] of Object.entries(files)) {
      const clean = name.replace(/\\\\/g, '/').replace(/^(\\.\\/)+/, '');
      if (!clean || clean.endsWith('/')) continue;
      const target = path.resolve(root, clean);
      if (!target.startsWith(root + path.sep)) throw new Error('unsafe path in archive: ' + name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
    parentPort.postMessage('done');
  `;
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(code, {
      eval: true,
      workerData: { zipPath, destination, fflate: require.resolve('fflate') },
    });
    worker.once('message', () => resolvePromise());
    worker.once('error', reject);
    worker.once('exit', (exitCode) => {
      if (exitCode !== 0) reject(new Error(`unzip worker exited with code ${exitCode}`));
    });
  });
}

/** Windows can hold a just-run executable open for a moment (antivirus scans); retry the move briefly. */
async function renameWithRetry(from: string, to: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= 10) throw error;
      await sleep(300);
    }
  }
}

function tryRemove(name: string): boolean {
  try {
    rmSync(join(BIN_DIR, name), { recursive: true, force: true });
    return !existsSync(join(BIN_DIR, name));
  } catch {
    return false;
  }
}

/**
 * Delete install folders nothing runs from any more, plus leftovers from
 * interrupted installs and the old single-file layout.
 */
export function removeStaleInstalls() {
  let entries: string[];
  try {
    entries = readdirSync(BIN_DIR);
  } catch {
    return;
  }
  const current = installDirOf(resolve(BIN_DIR, readState().executable || '__none__'));
  for (const name of entries) {
    const unusedInstall = INSTALL_DIR_PATTERN.test(name) && name !== current && !activeUses.has(name);
    // Staging files of an install that is still running (this process or another) are left alone.
    const abandonedStaging = /^\.(staging|download)-(\d+)$/.test(name) && Date.now() - Number(name.split('-')[1]) > 10 * 60_000;
    const oldSingleFileLayout = /^yt-dlp(\.exe)?(\.old-\d+|\.new(\.exe)?)?$/.test(name);
    if (unusedInstall || abandonedStaging || oldSingleFileLayout) tryRemove(name);
  }
}

/** The `releases/latest` page redirects to `releases/tag/<tag>`; no API rate limit involved. */
async function fetchLatestTag(): Promise<string> {
  const response = await fetch(`${RELEASES}/latest`, {
    redirect: 'manual',
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  await response.body?.cancel().catch(() => {});
  const tag = tagFromReleaseUrl(response.headers.get('location'));
  if (!tag) throw new Error(`could not read the latest yt-dlp release (HTTP ${response.status})`);
  return tag;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

/** Stream to disk while hashing; returns the SHA-256 hex digest. */
async function downloadFile(url: string, destination: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} downloading ${url}`);
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`refusing a ${declared}-byte download`);

  const hash = createHash('sha256');
  let received = 0;
  const hasher = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > MAX_DOWNLOAD_BYTES) return callback(new Error('download exceeded the size limit'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as any), hasher, createWriteStream(destination));
  } catch (error) {
    rmSync(destination, { force: true });
    throw error;
  }
  return hash.digest('hex');
}

function runVersion(binary: string): Promise<string | null> {
  return new Promise((resolvePromise) => {
    let output = '';
    let child: ChildProcess;
    try {
      child = spawn(binary, ['--version'], { windowsHide: true });
    } catch {
      resolvePromise(null);
      return;
    }
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.on('error', () => { clearTimeout(timer); resolvePromise(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise(code === 0 ? output.trim().split(/\r?\n/)[0] || null : null);
    });
  });
}

let maintenanceTimer: NodeJS.Timeout | null = null;

/** Download on first start (in the background) and re-check once a day. */
export function startYtDlpMaintenance() {
  if (!isManagedYtDlp() || maintenanceTimer) return;
  void ensureYtDlp().then(() => updateYtDlp()).catch((error) => {
    console.warn(`⚠️ yt-dlp check failed: ${error?.message || error}`);
  });
  maintenanceTimer = setInterval(() => {
    updateYtDlp().catch((error) => console.warn(`⚠️ yt-dlp daily check failed: ${error?.message || error}`));
    removeStaleInstalls();
  }, 60 * 60 * 1000);
  maintenanceTimer.unref?.();
}

export function stopYtDlpMaintenance() {
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

/**
 * yt-dlp needs a JavaScript runtime to solve YouTube's player challenges. The
 * bot already runs on one, so point yt-dlp at it instead of requiring Deno.
 * `--js-runtimes` exists since yt-dlp 2025.11.12.
 */
export function jsRuntimeArgs(version: string | null): string[] {
  if (version && version < '2025.11.12') return [];
  const runtime = process.versions.bun ? 'bun' : 'node';
  return ['--no-js-runtimes', '--js-runtimes', `${runtime}:${process.execPath}`];
}
