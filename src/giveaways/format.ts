/**
 * Renders an Offer into a Stoat MessageEmbed.
 */

import { MessageEmbed } from 'stoatbot.js';
import type { Offer } from './types.js';

// Green for free giveaways, amber for paid discounts.
const COLOR_FREE = '#22c55e';
const COLOR_DEAL = '#f59e0b';

function isFree(offer: Offer): boolean {
  return offer.source === 'gamerpower' || offer.savings === 100 || offer.salePrice === 'Free';
}

/** Format an end date like "2026-09-10 23:59:00" into a compact label. */
function formatEnd(endDate?: string): string | null {
  if (!endDate) return null;
  const d = new Date(endDate.replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return endDate;
  return d.toISOString().slice(0, 10);
}

export function buildOfferEmbed(offer: Offer): MessageEmbed {
  const free = isFree(offer);
  const embed = new MessageEmbed()
    .setTitle(offer.title.slice(0, 240))
    .setColor(free ? COLOR_FREE : COLOR_DEAL);

  if (offer.url) embed.setURL(offer.url);
  const media = offer.image || offer.thumbnail;
  if (media) embed.setMedia(media);

  const lines: string[] = [];

  // Price line.
  if (free) {
    const worth = offer.worth && offer.worth !== 'Free' ? ` (~~${offer.worth}~~)` : '';
    lines.push(`**💰 FREE**${worth}`);
  } else if (typeof offer.savings === 'number') {
    const from = offer.worth ? `~~${offer.worth}~~ ` : '';
    lines.push(`**💰 ${offer.salePrice || ''}** ${from}· **-${offer.savings}%**`.trim());
  }

  if (offer.platforms) lines.push(`🖥️ ${offer.platforms}`);
  if (offer.type) lines.push(`🏷️ ${offer.type}`);

  const end = formatEnd(offer.endDate);
  if (end) lines.push(`⏳ Ends **${end}**`);

  if (offer.description) {
    const desc = offer.description.replace(/\s+/g, ' ').trim();
    lines.push('', desc.slice(0, 400) + (desc.length > 400 ? '…' : ''));
  }

  if (offer.url) lines.push('', `🔗 [**Claim it here**](${offer.url})`);

  embed.setDescription(lines.join('\n').slice(0, 2000));
  return embed;
}

/** Header content string shown above the embed(s), with optional role mention. */
export function buildHeader(offer: Offer, mentionRole?: string): string {
  const mention = mentionRole ? `<@&${mentionRole}> ` : '';
  const tag = isFree(offer) ? '🎁 **Free Game / Giveaway!**' : '🔥 **Hot Deal!**';
  return `${mention}${tag}`;
}
