import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, parseFeed } from '../src/notifications/http.js';

test('isPrivateAddress blocks loopback / private / link-local IPv4', () => {
  for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.4.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress allows public IPv4', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test('isPrivateAddress blocks IPv6 loopback / ULA / link-local and mapped v4', () => {
  for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12::34', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
});

test('isPrivateAddress treats non-IP input as unsafe', () => {
  assert.equal(isPrivateAddress(''), true);
  assert.equal(isPrivateAddress('example.com'), true);
});

test('parseFeed extracts RSS 2.0 items', () => {
  const xml = `<rss><channel>
    <item><guid>g1</guid><title>First</title><link>https://e.com/1</link></item>
    <item><guid>g2</guid><title>Second</title><link>https://e.com/2</link></item>
  </channel></rss>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].guid, 'g1');
  assert.equal(entries[0].title, 'First');
});

test('parseFeed extracts Atom entries', () => {
  const xml = `<feed>
    <entry><id>a1</id><title>Post</title><link href="https://e.com/a1"/><updated>2024-01-01T00:00:00Z</updated></entry>
  </feed>`;
  const entries = parseFeed(xml);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].guid, 'a1');
  assert.equal(entries[0].url, 'https://e.com/a1');
});
