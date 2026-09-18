/**
 * Regression tests for the helpers that were extracted out of per-module
 * copies. These are the pieces the whole codebase now shares, so a change here
 * changes behavior in a dozen commands and editors at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { cleanId, normalizeId, normalizeMentionOrId, normalizeSimpleId } from '../src/id-utils.js';
import { getMemberIds, getRoleIds } from '../src/member-utils.js';
import { readJsonBody, escapeHtml, sendHtml } from '../src/editor-server.js';
import { getApiBaseUrl, getClientToken } from '../src/stoat-api.js';

const ID = '01ABCDEFGHJKMNPQRSTVWXYZ00';

test('cleanId unwraps mentions, sigil prefixes and bare ids', () => {
  assert.equal(cleanId(ID), ID);
  assert.equal(cleanId(`<@${ID}>`), ID);
  assert.equal(cleanId(`<#${ID}>`), ID);
  assert.equal(cleanId(`<@!${ID}>`), ID);
  assert.equal(cleanId(`#${ID}`), ID);
  assert.equal(cleanId(`  ${ID}  `), ID);
  assert.equal(cleanId('not an id'), '');
  assert.equal(cleanId(null), '');
});

test('normalizeSimpleId is cleanId with a null miss', () => {
  assert.equal(normalizeSimpleId(`%${ID}`), ID);
  assert.equal(normalizeSimpleId('not an id'), null);
  assert.equal(normalizeSimpleId(''), null);
});

test('normalizeId also accepts role mentions and the tag forms', () => {
  assert.equal(normalizeId(`<@&${ID}>`), ID);
  assert.equal(normalizeId(`<%${ID}>`), ID);
  assert.equal(normalizeId(`%<${ID}>`), ID);
  assert.equal(normalizeId(`#${ID}`), ID);
  assert.equal(normalizeId('nope!'), null);
});

test('normalizeMentionOrId rejects a bare sigil prefix', () => {
  assert.equal(normalizeMentionOrId(`<%${ID}>`), ID);
  assert.equal(normalizeMentionOrId(ID), ID);
  // `#name` is ordinary argument text here, not an id.
  assert.equal(normalizeMentionOrId(`#${ID}`), null);
});

test('getMemberIds reads every member payload shape', () => {
  assert.deepEqual(getMemberIds({ id: { server: 'S', user: 'U' } }), { serverId: 'S', userId: 'U' });
  assert.deepEqual(getMemberIds({ _id: { server: 'S', user: 'U' } }), { serverId: 'S', userId: 'U' });
  assert.deepEqual(getMemberIds({ server_id: 'S', user_id: 'U' }), { serverId: 'S', userId: 'U' });
  assert.deepEqual(getMemberIds({ userId: 'U' }, 'FALLBACK'), { serverId: 'FALLBACK', userId: 'U' });
  assert.equal(getMemberIds({ serverId: 'S' }), null);
  assert.equal(getMemberIds(null), null);
});

test('getMemberIds ignores a non-string id rather than passing an object along', () => {
  // `user` is an object on some payloads; returning it would produce
  // "[object Object]" inside an API path.
  assert.equal(getMemberIds({ serverId: 'S', user: { id: 'U' } }), null);
});

test('getRoleIds flattens arrays, objects, Sets and Maps', () => {
  assert.deepEqual(getRoleIds(['a', 'b']), ['a', 'b']);
  assert.deepEqual(getRoleIds([{ id: 'a' }, { _id: 'b' }, null]), ['a', 'b']);
  assert.deepEqual(getRoleIds(new Set(['a', 'b'])), ['a', 'b']);
  assert.deepEqual(getRoleIds(new Map([['a', 1], ['b', 2]])), ['a', 'b']);
  assert.deepEqual(getRoleIds(undefined), []);
});

function bodyStream(chunks: Buffer[]): IncomingMessage {
  const stream = Readable.from(chunks) as any;
  stream.destroy = () => {};
  return stream as IncomingMessage;
}

test('readJsonBody parses a body split anywhere, including mid-character', async () => {
  const payload = JSON.stringify({ text: 'héllo 🎉 — naïve café 日本語' });
  const bytes = Buffer.from(payload, 'utf8');

  for (let cut = 1; cut < bytes.length; cut++) {
    const body = await readJsonBody(bodyStream([bytes.subarray(0, cut), bytes.subarray(cut)]), {
      maxBytes: 1024 * 1024,
    });
    assert.equal(JSON.stringify(body), payload, `corrupted when split at byte ${cut}`);
  }
});

test('readJsonBody yields an empty object for an empty body', async () => {
  assert.deepEqual(await readJsonBody(bodyStream([]), { maxBytes: 1024 }), {});
});

test('readJsonBody rejects a body over the cap', async () => {
  const big = Buffer.from(JSON.stringify({ pad: 'x'.repeat(500) }), 'utf8');
  await assert.rejects(
    () => readJsonBody(bodyStream([big]), { maxBytes: 64 }),
    /Request body too large\.$/,
  );
  const oversized = Buffer.alloc(2 * 1024 * 1024, 0x20);
  await assert.rejects(
    () => readJsonBody(bodyStream([oversized]), { maxBytes: 1024 * 1024, reportLimit: true }),
    /Limit is 1MB\./,
    'reportLimit spells the cap out in the message',
  );
});

test('readJsonBody rejects malformed JSON', async () => {
  await assert.rejects(
    () => readJsonBody(bodyStream([Buffer.from('{not json')]), { maxBytes: 1024 }),
    /Invalid JSON body\./,
  );
});

test('escapeHtml escapes the five HTML-significant characters', () => {
  assert.equal(escapeHtml(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(escapeHtml(null), '');
});

test('sendHtml forbids framing by other sites', () => {
  let head: Record<string, string> = {};
  const response = { writeHead: (_status: number, headers: Record<string, string>) => { head = headers; }, end: () => {} };
  sendHtml(response as any, '<p>hi</p>');
  assert.equal(head['X-Frame-Options'], 'SAMEORIGIN');
  assert.equal(head['Content-Security-Policy'], "frame-ancestors 'self'");
});

test('getClientToken reads every token shape the client library has used', () => {
  assert.equal(getClientToken({ token: 'T' }), 'T');
  assert.equal(getClientToken({ api: { authentication: { revolt: 'T' } } }), 'T');
  assert.equal(getClientToken({ api: { authentication: { rauth: { token: 'T' } } } }), 'T');
  assert.equal(getClientToken({}), null);
});

test('getApiBaseUrl prefers the client instance and drops trailing slashes', () => {
  assert.equal(getApiBaseUrl({ options: { rest: { instanceURL: 'https://x.test/' } } }), 'https://x.test');
  assert.equal(getApiBaseUrl({ api: { baseURL: 'https://y.test///' } }), 'https://y.test');
  assert.equal(getApiBaseUrl(null), 'https://api.stoat.chat');
});

test('limitConcurrency never runs more than the limit, and runs everything in order', async () => {
  const { limitConcurrency, sleep } = await import('../src/async-utils.js');
  let active = 0;
  let peak = 0;
  const order: number[] = [];
  const task = limitConcurrency(2, async (n: number) => {
    active += 1;
    peak = Math.max(peak, active);
    await sleep(5);
    order.push(n);
    active -= 1;
    if (n === 3) throw new Error('boom');
    return n * 10;
  });

  const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map((n) => task(n)));
  assert.equal(peak, 2);
  assert.deepEqual(order.slice().sort(), [1, 2, 3, 4, 5, 6]);
  assert.equal(results[2].status, 'rejected', 'a failed call still frees its slot');
  assert.deepEqual(results.filter((r) => r.status === 'fulfilled').map((r: any) => r.value), [10, 20, 40, 50, 60]);
});

test('async SVG rendering produces a PNG', async () => {
  const { renderSvgToPngAsync } = await import('../src/svg-render.js');
  const png = await renderSvgToPngAsync('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#f00"/></svg>', {
    font: { loadSystemFonts: false },
  });
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
});
