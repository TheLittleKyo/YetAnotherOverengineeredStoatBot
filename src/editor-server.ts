/**
 * Shared HTTP plumbing for the dashboard editor servers.
 *
 * Every editor namespace (`/welcome`, `/roles`, `/embed`, `/captcha`, …) used
 * to carry its own byte-identical copy of the same six helpers — `sendJson`,
 * `sendHtml`, `sendAsset`, `readJsonBody`, `escapeHtml` and the esbuild
 * bundle-with-mtime-cache — roughly 60 duplicated lines per editor. This
 * centralizes them so response headers, body limits and cache semantics are
 * identical everywhere and fixed in one place.
 *
 * The bundler cache is per editor (`createEditorBundler` closes over its own
 * cache slot), matching the previous per-module `editorAppBundleCache` — an
 * editor's bundle is rebuilt only when its `app.ts` mtime, the bot name or the
 * command prefix changes (the latter two are compiled into the bundle, and the
 * dashboard can change both at runtime).
 */
import { readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { StringDecoder } from 'string_decoder';
import { buildSync } from 'esbuild';
import type { IncomingMessage, ServerResponse } from 'http';
import { config } from './config.js';

/** `Cache-Control` used by every editor response: these are live config UIs. */
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escape the five HTML-significant characters. The entity table is hoisted to
 * module scope so it is not re-allocated on every replaced character.
 */
export function escapeHtml(text: unknown): string {
  return String(text || '').replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] || char);
}

export function sendJson(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...NO_STORE_HEADERS });
  response.end(JSON.stringify(data));
}

/**
 * Pages may only be framed by the dashboard itself. Without this any website
 * the operator visits could load `http://localhost:3030/` in a hidden frame and
 * trick clicks onto it (the loopback Host check passes for framed loads).
 */
export const NO_FRAMING_HEADERS = {
  'X-Frame-Options': 'SAMEORIGIN',
  'Content-Security-Policy': "frame-ancestors 'self'",
} as const;

export function sendHtml(response: ServerResponse, html: string): void {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE_HEADERS, ...NO_FRAMING_HEADERS });
  response.end(html);
}

/** Send a text asset (CSS/JS) with an explicit content type. */
export function sendText(response: ServerResponse, contentType: string, content: string): void {
  response.writeHead(200, { 'Content-Type': contentType, ...NO_STORE_HEADERS });
  response.end(content);
}

/**
 * Serve a static file from an editor's asset directory. A missing file is a
 * 404 rather than a crash — the dashboard keeps working with an unstyled page.
 */
export function sendAsset(response: ServerResponse, assetDir: string, contentType: string, fileName: string): void {
  try {
    sendText(response, contentType, readFileSync(join(assetDir, fileName), 'utf-8'));
  } catch {
    sendJson(response, 404, { ok: false, error: 'Editor asset not found.' });
  }
}

/**
 * Whether a parsed request body carries `key` at all. Editors use it to tell
 * "field omitted" (leave the stored value alone) apart from "field sent as
 * null/false" (write that value), so a partial save never wipes settings the
 * form did not include.
 */
export function hasField(body: any, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

export type ReadJsonBodyOptions = {
  /** Hard cap on the buffered request body. */
  maxBytes: number;
  /** Include the cap in the rejection message (`… Limit is 2MB.`). */
  reportLimit?: boolean;
};

/**
 * Buffer and parse a JSON request body, rejecting once `maxBytes` is exceeded
 * so a large upload cannot pin memory. The socket is destroyed on overflow
 * rather than drained.
 *
 * Chunks go through a `StringDecoder` rather than `raw += chunk`: a multi-byte
 * character (an emoji in a welcome message, an accented channel name) can land
 * astride a chunk boundary, and concatenating the halves independently
 * replaces both with U+FFFD — silently corrupting the saved text, or breaking
 * the parse outright when the split falls inside a JSON string escape.
 */
export function readJsonBody(request: IncomingMessage, options: ReadJsonBodyOptions): Promise<any> {
  const { promise, resolve, reject } = Promise.withResolvers<any>();
  const { maxBytes, reportLimit } = options;
  const decoder = new StringDecoder('utf8');
  let raw = '';
  request.on('data', (chunk) => {
    raw += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    if (raw.length > maxBytes) {
      reject(new Error(
        reportLimit
          ? `Request body too large. Limit is ${Math.round(maxBytes / 1024 / 1024)}MB.`
          : 'Request body too large.'
      ));
      request.destroy();
    }
  });
  request.on('end', () => {
    const body = raw + decoder.end();
    try {
      resolve(body ? JSON.parse(body) : {});
    } catch {
      reject(new Error('Invalid JSON body.'));
    }
  });
  request.on('error', reject);
  return promise;
}

/** Shell page every editor serves: a root div plus its bundled app module. */
export function renderEditorPage(title: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(config.botName)} ${escapeHtml(title)}</title>
  <link rel="stylesheet" href="/editor.css">
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/editor-app.js"></script>
</body>
</html>`;
}

// A missing file stamps as -1, so a deleted import also forces a rebuild.
function mtimeStamp(files: string[]): string {
  return files.map((file) => {
    try {
      return statSync(file).mtimeMs;
    } catch {
      return -1;
    }
  }).join(',');
}

export type EditorBundlerOptions = {
  /** Directory holding the editor's `app.ts` entry point. */
  assetDir: string;
  /** Value compiled in as `__API_BASE__`, e.g. `/roles`. */
  apiBase: string;
  /** Human label used in bundle-failure logs, e.g. `Role`. */
  label: string;
  /** Compile `__PREFIX__` (the command prefix) into the bundle. */
  withPrefix?: boolean;
  /** Extra esbuild `define` entries, already JSON-stringified. */
  define?: Record<string, string>;
};

export type EditorBundler = {
  /** Build (or reuse) the bundle, throwing if esbuild produced nothing. */
  build: () => string;
  /** Build and respond, turning a build failure into a logged 500. */
  send: (response: ServerResponse) => void;
};

/**
 * Create an mtime-keyed bundler for one editor's browser app. The cache is
 * keyed on the mtimes of every project file in the bundle (the entry point and
 * the shared modules it imports, not node_modules), and on the bot name and
 * prefix because they are compiled in as `__BOT_NAME__` / `__PREFIX__`.
 */
export function createEditorBundler(options: EditorBundlerOptions): EditorBundler {
  const entryPoint = join(options.assetDir, 'app.ts');
  let cache: { inputs: string[]; stamp: string; botName: string; prefix: string; content: string } | null = null;

  function build(): string {
    if (cache && cache.botName === config.botName && cache.prefix === config.prefix
      && mtimeStamp(cache.inputs) === cache.stamp) return cache.content;

    const define: Record<string, string> = {
      __BOT_NAME__: JSON.stringify(config.botName),
      __API_BASE__: JSON.stringify(options.apiBase),
      ...(options.withPrefix ? { __PREFIX__: JSON.stringify(config.prefix) } : {}),
      ...options.define,
    };
    const result = buildSync({
      entryPoints: [entryPoint],
      bundle: true,
      write: false,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      logLevel: 'silent',
      define,
      metafile: true,
    });
    const content = result.outputFiles[0]?.text || '';
    if (!content) throw new Error(`${options.label} editor app bundle output was empty.`);

    // Metafile paths are relative to the working directory.
    const inputs = Object.keys(result.metafile?.inputs || {})
      .filter((file) => !file.includes('node_modules'))
      .map((file) => resolve(file));
    if (!inputs.length) inputs.push(entryPoint);
    cache = { inputs, stamp: mtimeStamp(inputs), botName: config.botName, prefix: config.prefix, content };
    return content;
  }

  function send(response: ServerResponse): void {
    try {
      sendText(response, 'application/javascript; charset=utf-8', build());
    } catch (error) {
      console.error(`${options.label} editor app bundle failed:`, error instanceof Error ? error.message : error);
      sendJson(response, 500, { ok: false, error: 'Editor app bundle failed.' });
    }
  }

  return { build, send };
}
