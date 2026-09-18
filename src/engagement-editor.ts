/**
 * Engagement editor — request handler for the dashboard `/engagement`
 * namespace: polls and hosted giveaways, which share one tab because they are
 * the same shape of thing (post a message, collect reactions, close it) and are
 * usually run by the same person in the same sitting.
 *
 * Backed by src/polls.ts and src/hosted-giveaways.ts.
 */

import { type IncomingMessage, type ServerResponse } from 'http';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { isEditorRequestAllowed } from './editor-guard.js';
import { createEditorBundler, readJsonBody, renderEditorPage, sendAsset, sendHtml, sendJson } from './editor-server.js';
import { channelInServer, listRoles, listTextChannels } from './editor-lists.js';
import { recordAudit } from './audit.js';
import { MAX_DURATION_MS } from './duration.js';
import { cleanId } from './id-utils.js';
import { closePoll, countVotes, createPoll, deletePoll, getPoll, listPolls, MAX_OPTIONS } from './polls.js';
import {
  createGiveaway,
  deleteGiveaway,
  endGiveaway,
  getGiveaway,
  listGiveaways,
  rerollGiveaway,
  type BonusRole,
  type Giveaway,
} from './hosted-giveaways.js';

const DASHBOARD = { source: 'dashboard' as const, name: 'Dashboard' };

/** A poll or giveaway id from the request body, only when it belongs to this server. */
function ownPoll(id: unknown, serverId: string) {
  const poll = getPoll(String(id || ''));
  return poll && poll.serverId === serverId ? poll : null;
}

function ownGiveaway(id: unknown, serverId: string) {
  const giveaway = getGiveaway(String(id || ''));
  return giveaway && giveaway.serverId === serverId ? giveaway : null;
}

/** A positive duration no longer than the shared ceiling, or null. */
function durationFrom(value: unknown): number | null {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_DURATION_MS) : null;
}

const MAX_BODY_BYTES = 1 * 1024 * 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const EDITOR_ASSET_DIR = join(__dirname, 'editors', 'engagement');
const editorApp = createEditorBundler({
  assetDir: EDITOR_ASSET_DIR,
  apiBase: '/engagement',
  label: 'Engagement',
  withPrefix: true,
});

export async function handleEngagementEditorRequest(
  request: IncomingMessage,
  response: ServerResponse,
  ctx: { client: any; serverId: string },
) {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`);
  const guard = isEditorRequestAllowed(request);
  if (!guard.ok) {
    sendJson(response, 403, { ok: false, error: 'Forbidden.' });
    return;
  }
  const pathname = url.pathname;
  const method = request.method || 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/editor')) {
    sendHtml(response, renderEditorPage('Polls & giveaways'));
    return;
  }
  if (method === 'GET' && pathname === '/editor.css') {
    sendAsset(response, EDITOR_ASSET_DIR, 'text/css; charset=utf-8', 'style.css');
    return;
  }
  if (method === 'GET' && pathname === '/editor-app.js') {
    editorApp.send(response);
    return;
  }

  if (method === 'GET' && pathname === '/api/config') {
    sendJson(response, 200, {
      ok: true,
      botName: config.botName,
      serverId: ctx.serverId,
      maxOptions: MAX_OPTIONS,
      polls: listPolls(ctx.serverId).slice(0, 50).map(summarizePoll),
      giveaways: listGiveaways(ctx.serverId).slice(0, 50).map((giveaway) => summarizeGiveaway(ctx.client, giveaway)),
      channels: await listTextChannels(ctx.client, ctx.serverId),
      roles: await listRoles(ctx.client, ctx.serverId),
    });
    return;
  }

  // ---- Polls ----
  if (method === 'POST' && pathname === '/api/poll') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const channelId = cleanId(body?.channelId);
    if (!(await channelInServer(ctx.client, ctx.serverId, channelId))) {
      sendJson(response, 400, { ok: false, error: 'Choose a channel in this server.' });
      return;
    }
    const result = await createPoll(ctx.client, {
      serverId: ctx.serverId,
      channelId,
      question: String(body?.question || ''),
      options: Array.isArray(body?.options) ? body.options.map((option: any) => String(option || '')) : [],
      multi: Boolean(body?.multi),
      anonymous: Boolean(body?.anonymous),
      durationMs: durationFrom(body?.durationMs),
      createdBy: '',
      createdByName: 'Dashboard',
      source: 'dashboard',
    });
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, polls: listPolls(ctx.serverId).slice(0, 50).map(summarizePoll) });
    return;
  }

  if (method === 'POST' && pathname === '/api/poll/close') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const poll = ownPoll(body?.id, ctx.serverId);
    if (!poll) {
      sendJson(response, 404, { ok: false, error: 'That poll no longer exists.' });
      return;
    }
    const result = await closePoll(ctx.client, poll.id, '', { source: 'dashboard', actorName: 'Dashboard' });
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, polls: listPolls(ctx.serverId).slice(0, 50).map(summarizePoll) });
    return;
  }

  if (method === 'POST' && pathname === '/api/poll/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const poll = ownPoll(body?.id, ctx.serverId);
    if (!poll || !deletePoll(poll.id)) {
      sendJson(response, 404, { ok: false, error: 'That poll no longer exists.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'polls', action: 'delete', detail: poll.question.slice(0, 120) });
    sendJson(response, 200, { ok: true, polls: listPolls(ctx.serverId).slice(0, 50).map(summarizePoll) });
    return;
  }

  // ---- Giveaways ----
  if (method === 'POST' && pathname === '/api/giveaway') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const channelId = cleanId(body?.channelId);
    if (!(await channelInServer(ctx.client, ctx.serverId, channelId))) {
      sendJson(response, 400, { ok: false, error: 'Choose a channel in this server.' });
      return;
    }
    const result = await createGiveaway(ctx.client, {
      serverId: ctx.serverId,
      channelId,
      prize: String(body?.prize || ''),
      description: String(body?.description || ''),
      winnerCount: Number(body?.winnerCount) || 1,
      durationMs: durationFrom(body?.durationMs) || 0,
      hostId: '',
      hostName: 'Dashboard',
      source: 'dashboard',
      requirements: {
        minLevel: Math.max(0, Number(body?.minLevel) || 0),
        requiredRoleIds: Array.isArray(body?.requiredRoleIds) ? body.requiredRoleIds.map((id: any) => cleanId(id)).filter(Boolean) : [],
        minAccountAgeDays: Math.max(0, Number(body?.minAccountAgeDays) || 0),
      },
      bonusRoles: sanitizeBonusRoles(body?.bonusRoles),
    });
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, giveaways: listGiveaways(ctx.serverId).slice(0, 50).map((giveaway) => summarizeGiveaway(ctx.client, giveaway)) });
    return;
  }

  if (method === 'POST' && pathname === '/api/giveaway/end') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const giveaway = ownGiveaway(body?.id, ctx.serverId);
    if (!giveaway) {
      sendJson(response, 404, { ok: false, error: 'That giveaway no longer exists.' });
      return;
    }
    const result = await endGiveaway(ctx.client, giveaway.id, DASHBOARD);
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, giveaways: listGiveaways(ctx.serverId).slice(0, 50).map((giveaway) => summarizeGiveaway(ctx.client, giveaway)), winners: result.winners });
    return;
  }

  if (method === 'POST' && pathname === '/api/giveaway/reroll') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const giveaway = ownGiveaway(body?.id, ctx.serverId);
    if (!giveaway) {
      sendJson(response, 404, { ok: false, error: 'That giveaway no longer exists.' });
      return;
    }
    const result = await rerollGiveaway(ctx.client, giveaway.id, Number(body?.count) || undefined, DASHBOARD);
    if (!result.ok) {
      sendJson(response, 400, { ok: false, error: result.error });
      return;
    }
    sendJson(response, 200, { ok: true, giveaways: listGiveaways(ctx.serverId).slice(0, 50).map((giveaway) => summarizeGiveaway(ctx.client, giveaway)), winners: result.winners });
    return;
  }

  if (method === 'POST' && pathname === '/api/giveaway/delete') {
    const body = await readJsonBody(request, { maxBytes: MAX_BODY_BYTES });
    const giveaway = ownGiveaway(body?.id, ctx.serverId);
    if (!giveaway || !deleteGiveaway(giveaway.id)) {
      sendJson(response, 404, { ok: false, error: 'That giveaway no longer exists.' });
      return;
    }
    recordAudit({ serverId: ctx.serverId, actorName: 'Dashboard', source: 'dashboard', area: 'giveaways', action: 'delete', detail: giveaway.prize.slice(0, 120) });
    sendJson(response, 200, { ok: true, giveaways: listGiveaways(ctx.serverId).slice(0, 50).map((giveaway) => summarizeGiveaway(ctx.client, giveaway)) });
    return;
  }

  sendJson(response, 404, { ok: false, error: 'Not found.' });
}

/** Voter ids are not shipped to the browser — the tab needs tallies, not names. */
function summarizePoll(poll: ReturnType<typeof listPolls>[number]) {
  const { total, perOption } = countVotes(poll);
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options,
    emoji: poll.emoji,
    channelId: poll.channelId,
    multi: poll.multi,
    anonymous: poll.anonymous,
    closed: poll.closed,
    createdAt: poll.createdAt,
    endsAt: poll.endsAt,
    votes: perOption,
    totalVotes: total,
  };
}

/**
 * A giveaway for the browser: winners carry display names (a raw `<@id>` is
 * unreadable outside chat), and entrant ids are reduced to a count.
 */
function summarizeGiveaway(client: any, giveaway: Giveaway) {
  const server = client?.servers?.cache?.get?.(giveaway.serverId);
  const nameOf = (userId: string) => {
    const member = server?.members?.cache?.get?.(userId);
    const user = client?.users?.cache?.get?.(userId);
    return String(member?.nickname || user?.displayName || user?.username || userId);
  };
  const { entries, ...rest } = giveaway;
  return { ...rest, entryCount: entries.length, winnerNames: giveaway.winners.map(nameOf) };
}

function sanitizeBonusRoles(value: any): BonusRole[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((bonus: any) => ({ roleId: cleanId(bonus?.roleId), entries: Math.max(1, Math.floor(Number(bonus?.entries) || 1)) }))
    .filter((bonus) => bonus.roleId);
}
