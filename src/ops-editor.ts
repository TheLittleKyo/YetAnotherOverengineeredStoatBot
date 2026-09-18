/**
 * Ops editor — request handler for the dashboard `/ops` namespace.
 * Wraps server backups (export/import, import gated behind an explicit
 * confirm + dry-run). Channel sync has its own page (sync-editor.ts).
 * Purge and permission-clone are destructive and message-bound, so the UI
 * builds the exact chat command to run rather than executing it here.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { basename } from 'path';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { listTextChannels, listCategories } from './editor-lists.js';
import { createServerBackup, importServerBackup, listBackupFiles, resolveBackupFile } from './backup.js';
import { previewServerBackup } from './backup-preview.js';
import { clearAudit, listAudit, listAuditAreas, recordAudit, type AuditSource } from './audit.js';
import { getHealthSnapshot } from './health.js';

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'ops');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/ops',
  label: 'Ops',
  withPrefix: true,
});

export async function handleOpsEditorRequest(request: IncomingMessage, response: ServerResponse, ctx: { client: any; serverId: string }) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) { sendJson(response, 403, { ok: false, error: 'Forbidden.' }); return; }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) { sendHtml(response, renderEditorPage('Ops')); return; }
  if (method === 'GET' && pathname === '/editor.css') { sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css'); return; }
  if (method === 'GET' && pathname === '/editor-app.js') { editorApp.send(response); return; }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, { ok: true, botName: config.botName, prefix: config.prefix, serverId: ctx.serverId, backups: listBackups(), channels: await listTextChannels(ctx.client, ctx.serverId), categories: await listCategories(ctx.client, ctx.serverId) });
    return;
  }

  if (method === 'POST' && pathname === '/api/backup/export') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    try {
      const { filePath, backup } = await createServerBackup(ctx.client, ctx.serverId, String(body?.name || '').trim() || undefined);
      sendJson(response, 200, { ok: true, file: basename(filePath), counts: { channels: backup.channels?.length || 0, roles: backup.roles?.length || 0 }, backups: listBackups() });
    } catch (e: any) { sendJson(response, 400, { ok: false, error: e?.message || 'Export failed.' }); }
    return;
  }
  if (method === 'POST' && pathname === '/api/backup/import') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const file = String(body?.file || '').trim();
    if (!file) { sendJson(response, 400, { ok: false, error: 'Choose a backup file.' }); return; }
    try {
      const path = resolveBackupFile(file);
      const summary = await importServerBackup(ctx.client, path, ctx.serverId, { dryRun: body?.dryRun !== false });
      sendJson(response, 200, { ok: true, summary });
    } catch (e: any) { sendJson(response, 400, { ok: false, error: e?.message || 'Import failed.' }); }
    return;
  }

  // Diff a backup against the live server: what already exists under the same
  // name, and which local data files a restore would overwrite.
  if (method === 'POST' && pathname === '/api/backup/preview') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const file = String(body?.file || '').trim();
    if (!file) { sendJson(response, 400, { ok: false, error: 'Choose a backup file.' }); return; }
    try {
      const preview = await previewServerBackup(ctx.client, resolveBackupFile(file), ctx.serverId);
      sendJson(response, 200, { ok: true, preview });
    } catch (e: any) { sendJson(response, 400, { ok: false, error: e?.message || 'Preview failed.' }); }
    return;
  }

  if (method === 'GET' && pathname === '/api/health') {
    sendJson(response, 200, { ok: true, health: getHealthSnapshot() });
    return;
  }

  if (method === 'GET' && pathname === '/api/audit') {
    const area = String(url.searchParams.get('area') || '').trim();
    const source = String(url.searchParams.get('source') || '').trim();
    const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
    sendJson(response, 200, {
      ok: true,
      entries: listAudit(ctx.serverId, {
        area: area || undefined,
        source: (source || undefined) as AuditSource | undefined,
        limit,
      }),
      areas: listAuditAreas(ctx.serverId),
    });
    return;
  }

  if (method === 'POST' && pathname === '/api/audit/clear') {
    await readJsonBody(request, { maxBytes: MAX_BODY_BYTES }).catch(() => ({}));
    const cleared = clearAudit(ctx.serverId);
    // The clear is itself a configuration change, so it opens the fresh log.
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'ops', action: 'audit.clear', detail: `${cleared} entries removed` });
    sendJson(response, 200, { ok: true, cleared, entries: listAudit(ctx.serverId, { limit: 100 }), areas: listAuditAreas(ctx.serverId) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

function listBackups() {
  return listBackupFiles().map((path) => basename(path));
}
