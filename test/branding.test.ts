/**
 * Dashboard branding: the name falls back environment → default, a stored name
 * wins and can be cleared, `config.botName` follows the store at runtime, and
 * the logo only accepts image data URIs within the size limit (falling back to
 * the bundled default).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'yaosb-branding-'));
process.env.YAOSB_DATA_DIR = dataDir;
process.env.BOT_NAME = 'EnvName';

// `config` is imported for the runtime-rename check; it also runs dotenv, so
// every later `process.env.BOT_NAME` change has to happen after this import.
const { config } = await import('../src/config.js');
const branding = await import('../src/branding.js');
const {
  DEFAULT_BOT_NAME, MAX_LOGO_BYTES, brandingView, clearLogo, fallbackBotName,
  readLogo, resolveBotName, setBrandName, setLogoFromDataUri, resetBrandingForTests,
} = branding;

const storePath = join(dataDir, 'branding.json');
// A 1x1 transparent GIF: the smallest valid image to round-trip.
const GIF_BASE64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const GIF_URI = `data:image/gif;base64,${GIF_BASE64}`;

function reset() {
  setBrandName('');
  clearLogo();
  process.env.BOT_NAME = 'EnvName';
  resetBrandingForTests();
}

test('the name falls back to BOT_NAME, then the project default', () => {
  reset();
  assert.equal(resolveBotName(), 'EnvName');

  delete process.env.BOT_NAME;
  assert.equal(fallbackBotName(), DEFAULT_BOT_NAME);
  assert.equal(resolveBotName(), DEFAULT_BOT_NAME);
});

test('a stored name wins, survives a reload, and clears back to the fallback', () => {
  reset();
  assert.equal(setBrandName('  Stoaty   McBot  '), 'Stoaty McBot');

  // A fresh process reads the same value back off disk.
  resetBrandingForTests();
  assert.equal(resolveBotName(), 'Stoaty McBot');
  assert.equal(brandingView().nameCustom, true);
  assert.equal(brandingView().fallbackName, 'EnvName');

  assert.equal(setBrandName(''), 'EnvName');
  assert.equal(brandingView().nameCustom, false);
});

test('names are sanitized and capped', () => {
  reset();
  assert.equal(setBrandName('Line\nBreak\tBot'), 'Line Break Bot');
  assert.equal(setBrandName('x'.repeat(500)).length, branding.MAX_NAME_LENGTH);
  // A name that is only whitespace is no name at all.
  assert.equal(setBrandName('   '), 'EnvName');
});

test('config.botName reflects a rename without a restart', () => {
  reset();
  assert.equal(config.botName, 'EnvName');
  setBrandName('Renamed Bot');
  assert.equal(config.botName, 'Renamed Bot');
  setBrandName('');
  assert.equal(config.botName, 'EnvName');
});

test('the default logo is the bundled SVG', () => {
  reset();
  const logo = readLogo();
  assert.equal(logo.mime, 'image/svg+xml');
  assert.match(logo.body.toString('utf-8'), /<svg/);
  assert.equal(brandingView().logoCustom, false);
});

test('an uploaded logo round-trips and can be reset', () => {
  reset();
  assert.equal(setLogoFromDataUri(GIF_URI), null);

  resetBrandingForTests();
  const logo = readLogo();
  assert.equal(logo.mime, 'image/gif');
  assert.equal(logo.body.toString('base64'), GIF_BASE64);
  assert.equal(brandingView().logoCustom, true);
  // The stamp changes with the logo so a cached copy is not reused.
  const custom = brandingView().logoStamp;
  assert.notEqual(custom, (clearLogo(), brandingView().logoStamp));
  assert.equal(readLogo().mime, 'image/svg+xml');
});

test('non-images, unsupported types and oversized files are rejected', () => {
  reset();
  for (const bad of ['', 'not a data uri', 'https://example.com/logo.png', 'data:text/html;base64,PGh0bWw+']) {
    assert.match(String(setLogoFromDataUri(bad)), /PNG|Unsupported/);
  }
  // An HTML payload dressed as a data URI must not be stored under any type.
  assert.equal(brandingView().logoCustom, false);

  const oversized = `data:image/png;base64,${Buffer.alloc(MAX_LOGO_BYTES + 1024).toString('base64')}`;
  assert.match(String(setLogoFromDataUri(oversized)), /too large/);
  assert.equal(brandingView().logoCustom, false);
});

test('the store holds only the branding fields', () => {
  reset();
  setBrandName('Filed Bot');
  setLogoFromDataUri(GIF_URI);
  assert.ok(existsSync(storePath));
  const stored = JSON.parse(readFileSync(storePath, 'utf-8'));
  assert.deepEqual(Object.keys(stored).sort(), ['logo', 'name']);
  assert.equal(stored.name, 'Filed Bot');
  assert.equal(stored.logo.mime, 'image/gif');
});
