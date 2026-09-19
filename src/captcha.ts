/**
 * Captcha anti-bot verification.
 *
 * Disabled by default. When enabled it can gate new members two ways:
 *   • On join   — automatically DM a captcha image when someone joins.
 *   • On react  — DM a captcha when someone reacts to a configured message.
 *
 * The member is DM'd an image containing 4–9 random letters/numbers, rendered
 * with anti-OCR distortion (warped glyphs, noise, strike lines, speckle) so an
 * automated reader has a hard time. They reply with the text; a correct answer
 * grants the configured role. A wrong/expired answer starts a cooldown (default
 * 5 minutes) before they can retry.
 */

import { File as NodeFile } from 'node:buffer';
import { randomInt as cryptoRandomInt } from 'node:crypto';
import { renderSvgToPngAsync } from './svg-render.js';
import { config } from './config.js';
import { getClientToken, getApiBaseUrl } from './stoat-api.js';
import { cleanId } from './id-utils.js';
import { getMemberIds, getRoleIds } from './member-utils.js';
import { createArrayFileStore, dataFile } from './json-store.js';

export type CaptchaConfig = {
  serverId: string;
  enabled: boolean;
  roleId: string | null; // role granted on success
  triggerOnJoin: boolean; // DM captcha automatically when a member joins
  triggerOnReaction: boolean; // DM captcha when reacting to the message below
  reactionMessageId: string | null;
  reactionEmoji: string | null;
  minLength: number; // 4..9
  maxLength: number; // 4..9
  maxAttempts: number; // wrong answers allowed before cooldown
  cooldownMinutes: number; // wait after failing before a retry is offered
  expiryMinutes: number; // how long a sent captcha stays valid
  dmMessage: string; // instruction text sent with the image
};

const store = createArrayFileStore<CaptchaConfig>(dataFile('captcha.json'), 'servers', 'captcha');

// Ambiguous glyphs (0/O, 1/I/L) removed so humans do not misread the image.
const CHARSET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const DEFAULT_DM_MESSAGE =
  'To get verified in **{server}**, type the {length} characters shown in the image below and send them back to me. Not case-sensitive.';

const DEFAULTS: Omit<CaptchaConfig, 'serverId'> = {
  enabled: false,
  roleId: null,
  triggerOnJoin: true,
  triggerOnReaction: false,
  reactionMessageId: null,
  reactionEmoji: null,
  minLength: 4,
  maxLength: 9,
  maxAttempts: 3,
  cooldownMinutes: 5,
  expiryMinutes: 10,
  dmMessage: DEFAULT_DM_MESSAGE,
};

// In-memory runtime state (not persisted).
type PendingChallenge = { serverId: string; code: string; expiresAt: number; attemptsLeft: number };
const pending = new Map<string, PendingChallenge>(); // userId -> challenge
const cooldownUntil = new Map<string, number>(); // userId -> ms timestamp

// --- Config persistence -----------------------------------------------------

export function getCaptchaConfig(serverId = config.serverId): CaptchaConfig {
  const found = store.read().find((s) => s.serverId === serverId);
  return { serverId: serverId || '', ...DEFAULTS, ...(found || {}) };
}

export function setCaptchaConfig(serverId: string, updates: Partial<CaptchaConfig>): CaptchaConfig {
  const servers = store.read();
  const current = servers.find((s) => s.serverId === serverId) || { serverId, ...DEFAULTS };
  const next: CaptchaConfig = { ...DEFAULTS, ...current, ...updates, serverId };

  next.minLength = clampInt(next.minLength, 4, 9, DEFAULTS.minLength);
  next.maxLength = clampInt(next.maxLength, 4, 9, DEFAULTS.maxLength);
  if (next.minLength > next.maxLength) next.maxLength = next.minLength;
  next.maxAttempts = clampInt(next.maxAttempts, 1, 10, DEFAULTS.maxAttempts);
  next.cooldownMinutes = clampInt(next.cooldownMinutes, 1, 1440, DEFAULTS.cooldownMinutes);
  next.expiryMinutes = clampInt(next.expiryMinutes, 1, 120, DEFAULTS.expiryMinutes);
  next.roleId = cleanId(next.roleId) || null;
  next.reactionMessageId = cleanId(next.reactionMessageId) || null;
  next.reactionEmoji = next.reactionEmoji ? String(next.reactionEmoji).trim().slice(0, 64) : null;
  next.dmMessage = String(next.dmMessage || DEFAULT_DM_MESSAGE).slice(0, 1000) || DEFAULT_DM_MESSAGE;

  store.write(servers.filter((s) => s.serverId !== serverId).concat(next));
  return next;
}

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// --- Runtime status ---------------------------------------------------------

export function getCaptchaRuntimeStatus() {
  const now = Date.now();
  let activeCooldowns = 0;
  for (const until of cooldownUntil.values()) if (until > now) activeCooldowns += 1;
  return { pending: pending.size, activeCooldowns };
}

function getCooldownRemainingMs(userId: string): number {
  const until = cooldownUntil.get(userId) || 0;
  return until > Date.now() ? until - Date.now() : 0;
}

// --- Public entry points ----------------------------------------------------

/** Wired into `serverMemberJoin` — DM a captcha automatically when enabled. */
export function scheduleCaptchaForMember(client: any, member: any) {
  setTimeout(() => {
    const ids = getMemberIds(member, config.serverId);
    if (!ids) return;
    const cfg = getCaptchaConfig(ids.serverId);
    if (!cfg.enabled || !cfg.triggerOnJoin) return;
    startCaptchaForUser(client, ids.serverId, ids.userId, member).catch((error) => {
      console.error('Failed to start join captcha:', error?.message || error);
    });
  }, 1800);
}

/**
 * Wired into the raw `MessageReact` handler. Returns true when the reaction
 * matched the configured captcha message/emoji (so the caller stops).
 */
export async function handleCaptchaReaction({ client, messageId, userId, emoji }: any): Promise<boolean> {
  if (!messageId || !userId) return false;
  const cfg = getCaptchaConfig();
  if (!cfg.enabled || !cfg.triggerOnReaction || !cfg.reactionMessageId) return false;
  if (String(messageId) !== cfg.reactionMessageId) return false;
  if (cfg.reactionEmoji && normalizeEmoji(emoji) !== normalizeEmoji(cfg.reactionEmoji)) return false;
  if (userId === client?.user?.id) return true;

  await startCaptchaForUser(client, cfg.serverId, userId).catch((error) => {
    console.error('Failed to start reaction captcha:', error?.message || error);
  });
  return true;
}

/**
 * Wired into the `message` event. Handles verification replies in the bot's
 * DMs. Returns true when the message was a captcha interaction (so the caller
 * skips normal command handling).
 */
export async function handleCaptchaDM(client: any, message: any): Promise<boolean> {
  try {
    const channel = message?.channel;
    if (!channel || channel.type !== 'DM') return false;
    if (message?.author?.bot) return false;

    const userId = message?.author?.id || message?.authorId;
    if (!userId || userId === client?.user?.id) return false;

    const cfg = getCaptchaConfig();
    if (!cfg.enabled || !cfg.roleId) return false;

    const answer = String(message?.content || '').trim();
    const existing = pending.get(userId);

    // Active challenge → grade the answer.
    if (existing) {
      if (Date.now() > existing.expiresAt) {
        pending.delete(userId);
        startCooldown(userId, cfg);
        await reply(channel, `⏱️ That captcha expired. Wait ${cfg.cooldownMinutes} minute(s), then send me any message to get a new one.`);
        return true;
      }

      if (!answer) return true; // ignore empty (e.g. image-only) DM while waiting

      if (answer.toUpperCase() === existing.code) {
        pending.delete(userId);
        cooldownUntil.delete(userId);
        const granted = await grantRole(client, existing.serverId, userId, cfg.roleId).catch((error) => {
          console.error('Captcha role grant failed:', error?.message || error);
          return false;
        });
        await reply(channel, granted
          ? '✅ Verified! Your role has been granted. Welcome in.'
          : '✅ Correct — but I could not assign the role. Make sure my role is above the verified role. Tell a server admin.');
        return true;
      }

      existing.attemptsLeft -= 1;
      if (existing.attemptsLeft > 0) {
        pending.set(userId, existing);
        await reply(channel, `❌ Wrong code. ${existing.attemptsLeft} attempt(s) left.`);
        return true;
      }

      pending.delete(userId);
      startCooldown(userId, cfg);
      await reply(channel, `❌ Too many wrong attempts. Wait ${cfg.cooldownMinutes} minute(s), then send me any message to try again.`);
      return true;
    }

    // No active challenge. Cooldown gate for retries.
    const remaining = getCooldownRemainingMs(userId);
    if (remaining > 0) {
      await reply(channel, `⏱️ Please wait ${Math.ceil(remaining / 60000)} more minute(s) before trying again.`);
      return true;
    }

    // Only auto-issue a new captcha to someone who still needs the role.
    const alreadyVerified = await memberHasRole(client, cfg.serverId, userId, cfg.roleId);
    if (alreadyVerified) return false;

    const result = await startCaptchaForUser(client, cfg.serverId, userId);
    return result.ok || result.reason === 'cooldown';
  } catch (error) {
    console.error('Captcha DM handler error:', error?.message || error);
    return false;
  }
}

/** Generate a challenge and DM it to the user. */
export async function startCaptchaForUser(
  client: any,
  serverId: string,
  userId: string,
  member?: any,
): Promise<{ ok: boolean; reason?: string }> {
  const cfg = getCaptchaConfig(serverId);
  if (!cfg.enabled) return { ok: false, reason: 'disabled' };
  if (!cfg.roleId) return { ok: false, reason: 'no role configured' };
  if (!userId || userId === client?.user?.id) return { ok: false, reason: 'invalid user' };

  if (getCooldownRemainingMs(userId) > 0) return { ok: false, reason: 'cooldown' };

  // Skip if the member already has the verified role.
  if (await memberHasRole(client, serverId, userId, cfg.roleId)) {
    return { ok: false, reason: 'already verified' };
  }

  const user = await resolveUser(client, userId, member);
  if (!user) return { ok: false, reason: 'user not found' };

  const length = randomInt(cfg.minLength, cfg.maxLength);
  const code = generateCode(length);
  const png = await renderCaptchaPng(code);
  const file = new NodeFile([new Uint8Array(png)], 'captcha.png', { type: 'image/png' });

  const serverName = await resolveServerName(client, serverId);
  const content = renderDmMessage(cfg.dmMessage, { serverName, length });

  try {
    const dm = typeof user.createDM === 'function' ? await user.createDM() : null;
    if (dm && typeof dm.send === 'function') {
      await dm.send({ content, attachments: [file] });
    } else if (typeof user.sendDM === 'function') {
      await user.sendDM({ content, attachments: [file] });
    } else {
      return { ok: false, reason: 'cannot DM user' };
    }
  } catch (error) {
    console.warn(`Captcha DM to ${userId} failed:`, error?.message || error);
    return { ok: false, reason: 'dm failed' };
  }

  pending.set(userId, {
    serverId,
    code,
    expiresAt: Date.now() + cfg.expiryMinutes * 60_000,
    attemptsLeft: cfg.maxAttempts,
  });
  console.log(`🔐 Sent captcha to ${userId} for server ${serverId}.`);
  return { ok: true };
}

function startCooldown(userId: string, cfg: CaptchaConfig) {
  cooldownUntil.set(userId, Date.now() + cfg.cooldownMinutes * 60_000);
}

function renderDmMessage(template: string, ctx: { serverName: string; length: number }) {
  return String(template || DEFAULT_DM_MESSAGE)
    .replaceAll('{server}', ctx.serverName || 'this server')
    .replaceAll('{length}', String(ctx.length));
}

// --- Code + image generation ------------------------------------------------

// The challenge code is the whole security boundary of this feature, so it is
// drawn from the CSPRNG. Math.random() is a seeded xorshift128+ whose internal
// state can be recovered from a handful of observed outputs, which would let a
// bot that solves one captcha predict every later code.
function randomInt(min: number, max: number): number {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return cryptoRandomInt(lo, hi + 1);
}

function generateCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += CHARSET[cryptoRandomInt(0, CHARSET.length)];
  return out;
}

function rand(min: number, max: number) {
  return min + Math.random() * (max - min);
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Build an SVG packed with anti-OCR noise: warped/rotated glyphs at jittered
 * baselines, multi-hue fills, overlapping strike lines, a wavy interference
 * mesh, and dense speckle. Rendered to PNG so there is no selectable text.
 */
function generateCaptchaSvg(code: string): string {
  const width = Math.max(220, 70 + code.length * 52);
  const height = 130;
  const palette = ['#1f2937', '#312e81', '#7f1d1d', '#134e4a', '#3730a3', '#164e63', '#78350f'];
  const bgA = pick(['#f8fafc', '#eef2ff', '#fef2f2', '#ecfeff', '#f5f3ff']);
  const bgB = pick(['#e2e8f0', '#e0e7ff', '#fee2e2', '#cffafe', '#ede9fe']);

  const parts: string[] = [];
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<defs>`);
  parts.push(`<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${bgA}"/><stop offset="100%" stop-color="${bgB}"/></linearGradient>`);
  // Turbulence-based displacement warps every glyph that references it.
  parts.push(`<filter id="warp"><feTurbulence type="turbulence" baseFrequency="0.028 0.045" numOctaves="2" seed="${Math.floor(rand(1, 9999))}" result="n"/><feDisplacementMap in="SourceGraphic" in2="n" scale="${rand(8, 16).toFixed(1)}" xChannelSelector="R" yChannelSelector="G"/></filter>`);
  parts.push(`</defs>`);
  parts.push(`<rect width="${width}" height="${height}" fill="url(#bg)"/>`);

  // Faint interference mesh (sine waves across the whole image).
  for (let w = 0; w < 5; w++) {
    const amp = rand(6, 16);
    const yBase = rand(15, height - 15);
    const phase = rand(0, Math.PI * 2);
    const freq = rand(0.02, 0.06);
    let d = `M0 ${yBase.toFixed(1)}`;
    for (let x = 0; x <= width; x += 8) {
      const y = yBase + Math.sin(x * freq + phase) * amp;
      d += ` L${x} ${y.toFixed(1)}`;
    }
    parts.push(`<path d="${d}" fill="none" stroke="${pick(palette)}" stroke-width="${rand(0.8, 1.8).toFixed(1)}" opacity="${rand(0.12, 0.28).toFixed(2)}"/>`);
  }

  // The glyphs.
  const slot = width / (code.length + 1);
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const cx = slot * (i + 1) + rand(-6, 6);
    const cy = height / 2 + rand(-10, 12);
    const size = rand(52, 68);
    const rot = rand(-34, 34);
    const skew = rand(-14, 14);
    const fill = pick(palette);
    const family = pick(['Georgia', 'Times New Roman', 'Arial', 'Trebuchet MS', 'Verdana', 'Impact']);
    const weight = pick([700, 800, 900]);
    parts.push(
      `<g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot.toFixed(1)}) skewX(${skew.toFixed(1)})" filter="url(#warp)">` +
        `<text x="0" y="0" font-family="${family}" font-size="${size.toFixed(1)}" font-weight="${weight}" ` +
        `fill="${fill}" text-anchor="middle" dominant-baseline="central" ` +
        `stroke="${pick(palette)}" stroke-width="${rand(0.4, 1.4).toFixed(1)}">${escapeXml(ch)}</text></g>`,
    );
  }

  // Strike-through lines drawn over the glyphs.
  for (let l = 0; l < 4; l++) {
    const x1 = rand(0, width * 0.3);
    const y1 = rand(10, height - 10);
    const x2 = rand(width * 0.7, width);
    const y2 = rand(10, height - 10);
    const cxp = rand(0, width);
    const cyp = rand(0, height);
    parts.push(`<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} Q${cxp.toFixed(1)} ${cyp.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="${pick(palette)}" stroke-width="${rand(1.4, 2.6).toFixed(1)}" opacity="${rand(0.4, 0.7).toFixed(2)}"/>`);
  }

  // Dense speckle noise.
  const dots = Math.floor(width * height * 0.012);
  for (let d = 0; d < dots; d++) {
    parts.push(`<circle cx="${rand(0, width).toFixed(1)}" cy="${rand(0, height).toFixed(1)}" r="${rand(0.5, 1.8).toFixed(1)}" fill="${pick(palette)}" opacity="${rand(0.15, 0.5).toFixed(2)}"/>`);
  }

  parts.push(`</svg>`);
  return parts.join('');
}

/** Render a captcha image for an explicit code. Exposed for previews/tests. */
export function renderCaptchaImage(code: string): Promise<Buffer> {
  return renderCaptchaPng(String(code || 'AB23').toUpperCase());
}

function renderCaptchaPng(code: string): Promise<Buffer> {
  const svg = generateCaptchaSvg(code);
  return renderSvgToPngAsync(svg, {
    fitTo: { mode: 'zoom', value: 2 }, // 2x supersample for crisp warp edges
    font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
  });
}

// --- Stoat helpers (role grant, lookups) ------------------------------------

async function grantRole(client: any, serverId: string, userId: string, roleId: string): Promise<boolean> {
  const currentRoleIds = await fetchMemberRoleIds(client, serverId, userId);
  const roleIds = Array.from(new Set([...(currentRoleIds || []), roleId].filter(Boolean)));
  if (currentRoleIds && roleIds.length === currentRoleIds.length) return true; // already has it
  await patchMemberRoles(client, serverId, userId, roleIds);
  console.log(`✅ Captcha granted role ${roleId} to ${userId}.`);
  return true;
}

async function memberHasRole(client: any, serverId: string, userId: string, roleId: string): Promise<boolean> {
  const roleIds = await fetchMemberRoleIds(client, serverId, userId);
  return Array.isArray(roleIds) && roleIds.includes(roleId);
}

async function fetchMemberRoleIds(client: any, serverId: string, userId: string): Promise<string[] | null> {
  try {
    if (typeof client?.api?.get === 'function') {
      const rawMember = await client.api.get(`/servers/${serverId}/members/${userId}`);
      return getRoleIds(rawMember?.roles);
    }
  } catch {
    // fall through
  }
  return null;
}

async function patchMemberRoles(client: any, serverId: string, userId: string, roleIds: string[]): Promise<void> {
  const token = getClientToken(client);
  if (!token) throw new Error('missing bot token for captcha role grant');
  const baseUrl = getApiBaseUrl(client);
  const response = await fetch(`${baseUrl}/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(userId)}`, {
    method: 'PATCH',
    headers: {
      [client?.bot === false ? 'X-Session-Token' : 'X-Bot-Token']: token,
      'Content-Type': 'application/json',
      'User-Agent': 'YetAnotherOverengineeredStoatBot captcha verification',
    },
    body: JSON.stringify({ roles: roleIds }),
  });
  if (response.ok) return;
  const text = await response.text().catch(() => '');
  let detail = response.statusText;
  try { detail = JSON.parse(text)?.type || detail; } catch { if (text) detail = text; }
  throw new Error(`API call failed with status ${response.status}: ${detail}`);
}

async function resolveUser(client: any, userId: string, member?: any) {
  return (
    member?.user ||
    client?.users?.cache?.get?.(userId) ||
    (await client?.users?.fetch?.(userId).catch(() => null)) ||
    null
  );
}

async function resolveServerName(client: any, serverId: string): Promise<string> {
  const server = client?.servers?.cache?.get?.(serverId) || (await client?.servers?.fetch?.(serverId).catch(() => null));
  return String(server?.name || server?.title || 'this server').trim();
}

async function reply(channel: any, content: string) {
  try {
    if (typeof channel?.send === 'function') await channel.send({ content });
  } catch (error) {
    console.warn('Captcha reply failed:', error?.message || error);
  }
}

function normalizeEmoji(emoji: any): string {
  const input = String(emoji || '').trim();
  const custom = input.match(/^<a?:[^:>]+:([A-Za-z0-9_-]+)>$/);
  return custom?.[1] || input;
}

function escapeXml(value: string) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
