/**
 * Stoat's message and embed size limits, and helpers that keep generated
 * content inside them.
 *
 * The API rejects the whole send when one field is too long: an embed title
 * over 100 characters, a description over 2000, or message content over 2000.
 * A poll question, a giveaway prize or a tag body are all user-typed, so any
 * embed or list built from them is clamped here rather than trusted to fit.
 */

import { MessageEmbed } from 'stoatbot.js';

export const EMBED_TITLE_MAX = 100;
export const EMBED_DESCRIPTION_MAX = 2000;
export const MESSAGE_CONTENT_MAX = 2000;

/** Cut `value` to `max` characters, ending in an ellipsis when it was cut. */
export function clampText(value: unknown, max: number): string {
  const text = String(value ?? '');
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Message content that is guaranteed to fit, for list-style replies. */
export function clampMessage(value: unknown): string {
  return clampText(value, MESSAGE_CONTENT_MAX - 10);
}

/**
 * Join list lines into one message, dropping the lines that would not fit and
 * saying how many were left out, rather than cutting a line in half.
 */
export function joinLinesWithin(header: string, lines: string[], max = MESSAGE_CONTENT_MAX - 10): string {
  const out: string[] = header ? [header] : [];
  let length = header.length;
  for (let index = 0; index < lines.length; index++) {
    const line = clampText(lines[index], max - 40);
    // Leave room for the "…and N more" line whenever more lines follow.
    const reserve = index < lines.length - 1 ? 24 : 0;
    if (length + 1 + line.length + reserve > max) {
      out.push(`…and ${lines.length - index} more`);
      return out.join('\n');
    }
    out.push(line);
    length += 1 + line.length;
  }
  return out.join('\n');
}

const HEX_COLOUR = /^#[0-9a-f]{3,8}$/i;

/** True for the colour forms these features store (hex). */
export function isHexColour(value: unknown): boolean {
  return HEX_COLOUR.test(String(value || '').trim());
}

/** True for an absolute http(s) URL. */
export function isHttpUrl(value: unknown): boolean {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Build a MessageEmbed whose fields all fit Stoat's limits. Empty fields are
 * left out, an invalid colour or URL is dropped instead of failing the send.
 */
export function safeEmbed(parts: { title?: string; description?: string; color?: string; url?: string }): MessageEmbed {
  const embed = new MessageEmbed();
  const title = clampText(String(parts.title || '').trim(), EMBED_TITLE_MAX);
  const description = clampText(String(parts.description || '').trim(), EMBED_DESCRIPTION_MAX);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (parts.color && isHexColour(parts.color)) embed.setColor(String(parts.color).trim());
  if (parts.url && isHttpUrl(parts.url)) embed.setURL(String(parts.url).trim());
  return embed;
}

/**
 * Neutralise mass mentions in text a member typed, so a tag's `{args}` or a
 * nickname cannot make the bot ping everyone or a role it may mention.
 */
export function neutraliseMentions(value: unknown): string {
  return String(value ?? '')
    .replace(/@(everyone|online|here)/gi, '@\u200b$1')
    .replace(/<%/g, '<\u200b%');
}
