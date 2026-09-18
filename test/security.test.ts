/**
 * Regression tests for the local-editor request guard and the backup-file
 * resolver. Both sit on an untrusted boundary: the guard is the only thing
 * standing between a web page in the operator's browser and the dashboard API,
 * and the resolver turns a chat/API string into a path this process reads.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { isEditorRequestAllowed } from '../src/editor-guard.js';
import { resolveBackupFile } from '../src/backup.js';

function request(method: string, headers: Record<string, string | undefined>): IncomingMessage {
  return { method, headers, url: '/api/config' } as unknown as IncomingMessage;
}

test('editor guard allows a same-origin loopback POST', () => {
  const result = isEditorRequestAllowed(
    request('POST', { host: '127.0.0.1:3030', 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:3030' })
  );
  assert.equal(result.ok, true);
});

test('editor guard rejects a non-loopback Host (DNS rebinding)', () => {
  const result = isEditorRequestAllowed(request('GET', { host: 'evil.example.com' }));
  assert.equal(result.ok, false);
});

test('editor guard rejects a request with no Host header', () => {
  const result = isEditorRequestAllowed(request('POST', {}));
  assert.equal(result.ok, false);
});

test('editor guard rejects cross-site and cross-origin mutations', () => {
  const crossSite = isEditorRequestAllowed(
    request('POST', { host: '127.0.0.1:3030', 'sec-fetch-site': 'cross-site' })
  );
  assert.equal(crossSite.ok, false);

  const crossOrigin = isEditorRequestAllowed(
    request('DELETE', { host: '127.0.0.1:3030', origin: 'https://evil.example.com' })
  );
  assert.equal(crossOrigin.ok, false);
});

test('resolveBackupFile refuses paths that escape the backups directory', () => {
  for (const value of [
    '../../.env',
    '..\\..\\.env',
    '/etc/passwd',
    'C:\\Windows\\win.ini',
    'subdir/backup.json',
    '..',
  ]) {
    assert.throws(() => resolveBackupFile(value), /file name inside the backups directory/, `${value} should be rejected`);
  }
});

test('resolveBackupFile reports a plain missing name as not found', () => {
  assert.throws(() => resolveBackupFile('definitely-not-a-real-backup'), /Backup file not found/);
});
