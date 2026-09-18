import { config } from '../config.js';
import { requirePermission } from '../permissions.js';
import {
  getConfig,
  getOrCreateConfig,
  updateConfig,
  deleteConfig,
  fetchOffersForConfig,
  buildOfferEmbed,
  buildHeader,
  CHEAPSHARK_STORES,
} from '../giveaways/index.js';
import type { FreeStuffConfig } from '../giveaways/index.js';

const P = () => config.prefix;

/**
 * Free games / deals feed — mirrors the popular "Free Stuff" bot.
 *
 * !freestuff setup            — post the feed in the current channel & enable it
 * !freestuff enable|disable   — toggle without changing the channel
 * !freestuff channel          — move the feed to the current channel
 * !freestuff sources <...>     — pick sources: gamerpower, cheapshark
 * !freestuff platforms <...>   — GamerPower platform filter (epic steam gog ...), or "all"
 * !freestuff types <...>       — GamerPower types: game loot dlc beta, or "all"
 * !freestuff deals <minPct>    — enable CheapShark deals at a discount threshold
 * !freestuff onlyfree on|off   — CheapShark: only 100%-off deals
 * !freestuff mention <role|off>— role to ping on new offers
 * !freestuff status            — show current config
 * !freestuff test [n]          — post the latest n offers now (default 2)
 * !freestuff reset             — delete this server's config
 * !freestuff help
 */
export async function freeStuffCommand(message, args, client) {
  const sub = (args.shift() || '').toLowerCase();

  switch (sub) {
    case '':
    case 'help':
      return sendHelp(message);
    case 'status':
    case 'info':
      return sendStatus(message);
    case 'setup':
    case 'enable':
    case 'on':
    case 'start':
      return guard(message, client, () => handleEnable(message, sub));
    case 'disable':
    case 'off':
    case 'stop':
      return guard(message, client, () => handleDisable(message));
    case 'channel':
    case 'here':
      return guard(message, client, () => handleChannel(message));
    case 'sources':
    case 'source':
      return guard(message, client, () => handleSources(message, args));
    case 'platforms':
    case 'platform':
      return guard(message, client, () => handlePlatforms(message, args));
    case 'types':
    case 'type':
      return guard(message, client, () => handleTypes(message, args));
    case 'deals':
    case 'minsavings':
      return guard(message, client, () => handleDeals(message, args));
    case 'onlyfree':
      return guard(message, client, () => handleOnlyFree(message, args));
    case 'stores':
    case 'store':
      return guard(message, client, () => handleStores(message, args));
    case 'mention':
    case 'ping':
    case 'role':
      return guard(message, client, () => handleMention(message, args));
    case 'reset':
    case 'delete':
      return guard(message, client, () => handleReset(message));
    case 'test':
    case 'preview':
      return guard(message, client, () => handleTest(message, args));
    default:
      return sendHelp(message, `Unknown subcommand: \`${sub}\`.`);
  }
}

async function guard(message, client, fn: () => Promise<void>) {
  if (!(await requirePermission(message, client, ['ManageServer'], 'Manage Server'))) return;
  await fn();
}

function serverIdOf(message): string | undefined {
  return message.serverId || config.serverId;
}

async function handleEnable(message, sub: string) {
  const serverId = serverIdOf(message);
  if (!serverId) return void send(message, '❌ Could not determine the server.');

  const existing = getConfig(serverId);
  // `setup` binds to the current channel; `enable`/`on` keeps an existing channel if set.
  const channelId = sub === 'setup' || !existing?.channelId ? message.channelId : existing.channelId;
  if (!channelId) return void send(message, '❌ No channel set. Run this in the channel you want the feed in.');

  const cfg = updateConfig(serverId, { channelId, enabled: true });
  await send(
    message,
    `✅ **Free Stuff feed enabled** in <#${channelId}>.\n` +
      `New offers post automatically (checked every ~10 min).\n` +
      summarize(cfg) +
      `\n\nTip: \`${P()}freestuff test\` to preview now, \`${P()}freestuff status\` to review settings.`,
  );
}

async function handleDisable(message) {
  const serverId = serverIdOf(message);
  const cfg = serverId && getConfig(serverId);
  if (!cfg) return void send(message, 'ℹ️ Free Stuff is not set up here.');
  updateConfig(serverId!, { enabled: false });
  await send(message, '🛑 Free Stuff feed **disabled**. Config kept — re-enable with `' + P() + 'freestuff enable`.');
}

async function handleChannel(message) {
  const serverId = serverIdOf(message);
  if (!serverId) return void send(message, '❌ Could not determine the server.');
  const cfg = updateConfig(serverId, { channelId: message.channelId });
  await send(message, `✅ Free Stuff feed will now post in <#${cfg.channelId}>.`);
}

async function handleSources(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const picked = args.map((a) => a.toLowerCase());
  if (picked.length === 0) {
    return void send(
      message,
      `Usage: \`${P()}freestuff sources gamerpower cheapshark\`\n` +
        `• **gamerpower** — free game/DLC/loot giveaways\n` +
        `• **cheapshark** — discounted paid games`,
    );
  }
  const known = ['gamerpower', 'cheapshark'];
  const bad = picked.filter((p) => !known.includes(p) && p !== 'all' && p !== 'none');
  if (bad.length) return void send(message, `❌ Unknown source(s): ${bad.join(', ')}. Valid: ${known.join(', ')}.`);

  const sources =
    picked.includes('all')
      ? { gamerpower: true, cheapshark: true }
      : picked.includes('none')
        ? { gamerpower: false, cheapshark: false }
        : { gamerpower: picked.includes('gamerpower'), cheapshark: picked.includes('cheapshark') };

  const cfg = updateConfig(serverId, { sources });
  await send(message, `✅ Sources updated.\n${summarize(cfg)}`);
}

async function handlePlatforms(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const vals = args.map((a) => a.toLowerCase()).filter(Boolean);
  const platforms = vals.length === 0 || vals.includes('all') ? [] : vals;
  const cfg = updateConfig(serverId, { platforms });
  await send(
    message,
    platforms.length === 0
      ? '✅ GamerPower platform filter cleared — **all platforms** will post.'
      : `✅ GamerPower platform filter: **${platforms.join(', ')}**.\n${summarize(cfg)}`,
  );
}

async function handleTypes(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const valid = ['game', 'loot', 'dlc', 'beta', 'early access', 'other'];
  const vals = args.map((a) => a.toLowerCase()).filter(Boolean);
  if (vals.includes('all')) {
    const cfg = updateConfig(serverId, { types: [] });
    return void send(message, `✅ GamerPower types: **all**.\n${summarize(cfg)}`);
  }
  const bad = vals.filter((v) => !valid.includes(v));
  if (bad.length) return void send(message, `❌ Unknown type(s): ${bad.join(', ')}. Valid: ${valid.join(', ')}, all.`);
  if (vals.length === 0) return void send(message, `Usage: \`${P()}freestuff types game loot dlc\` (or \`all\`).`);
  const cfg = updateConfig(serverId, { types: vals });
  await send(message, `✅ GamerPower types: **${vals.join(', ')}**.\n${summarize(cfg)}`);
}

async function handleDeals(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const pct = Math.round(Number(args[0]));
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return void send(message, `Usage: \`${P()}freestuff deals <0-100>\` — enables CheapShark deals at that minimum discount %.`);
  }
  const cfg = updateConfig(serverId, {
    minSavings: pct,
    sources: { gamerpower: getConfig(serverId)?.sources.gamerpower ?? true, cheapshark: true },
  });
  await send(message, `✅ CheapShark deals enabled at **-${pct}%** minimum.\n${summarize(cfg)}`);
}

async function handleOnlyFree(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const on = ['on', 'true', 'yes', '1', 'enable'].includes((args[0] || '').toLowerCase());
  const cfg = updateConfig(serverId, { onlyFreeDeals: on });
  await send(message, `✅ CheapShark "only 100%-off deals" is now **${on ? 'ON' : 'OFF'}**.\n${summarize(cfg)}`);
}

async function handleStores(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const vals = args.map((a) => a.toLowerCase()).filter(Boolean);

  if (vals.length === 0) {
    const list = CHEAPSHARK_STORES.map((s) => `\`${s.name.toLowerCase().replace(/\s.*/, '')}\` ${s.name}`).join('\n');
    return void send(
      message,
      `Pick CheapShark stores by name (matches against the store name):\n${list}\n\n` +
        `Usage: \`${P()}freestuff stores steam epic gog\` — or \`all\` for every store.`,
    );
  }

  if (vals.includes('all') || vals.includes('none')) {
    const cfg = updateConfig(serverId, { stores: [] });
    return void send(message, `✅ CheapShark store filter cleared — **all stores** included.\n${summarize(cfg)}`);
  }

  // Match each keyword against store names; collect the matching IDs.
  const ids = new Set<string>();
  const unmatched: string[] = [];
  for (const kw of vals) {
    const hit = CHEAPSHARK_STORES.filter((s) => s.name.toLowerCase().includes(kw));
    if (hit.length === 0) unmatched.push(kw);
    hit.forEach((s) => ids.add(s.id));
  }
  if (ids.size === 0) {
    return void send(message, `❌ No stores matched: ${unmatched.join(', ')}. Try \`${P()}freestuff stores\` to list them.`);
  }
  const cfg = updateConfig(serverId, {
    stores: [...ids],
    sources: { gamerpower: getConfig(serverId)?.sources.gamerpower ?? true, cheapshark: true },
  });
  const warn = unmatched.length ? `\n⚠️ Ignored (no match): ${unmatched.join(', ')}` : '';
  await send(message, `✅ CheapShark stores set to **${storeNames(cfg.stores)}**.${warn}\n${summarize(cfg)}`);
}

async function handleMention(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const raw = (args[0] || '').trim();
  if (!raw || ['off', 'none', 'clear'].includes(raw.toLowerCase())) {
    updateConfig(serverId, { mentionRole: undefined });
    return void send(message, '✅ Role mention cleared.');
  }
  const roleId = raw.replace(/[<@&>]/g, '');
  if (!roleId) return void send(message, `Usage: \`${P()}freestuff mention @Role\` or \`${P()}freestuff mention off\`.`);
  updateConfig(serverId, { mentionRole: roleId });
  await send(message, `✅ New offers will ping <@&${roleId}>.`);
}

async function handleReset(message) {
  const serverId = serverIdOf(message)!;
  const ok = deleteConfig(serverId);
  await send(message, ok ? '🗑️ Free Stuff config deleted for this server.' : 'ℹ️ Nothing to reset.');
}

async function handleTest(message, args: string[]) {
  const serverId = serverIdOf(message)!;
  const cfg = getConfig(serverId) || getOrCreateConfig(serverId);
  const n = Math.min(Math.max(Number(args[0]) || 2, 1), 5);

  await send(message, '🔎 Fetching latest offers…');
  const { offers, errors } = await fetchOffersForConfig(cfg);

  if (offers.length === 0) {
    const detail = errors.length ? `\n${errors.map((e) => `• ${e}`).join('\n')}` : '';
    return void send(
      message,
      `No offers matched your current filters.${detail}\n\nCheck \`${P()}freestuff status\` — your platform/type filters may be too narrow.`,
    );
  }

  for (const offer of offers.slice(0, n)) {
    await message.channel?.send({
      content: buildHeader(offer, undefined),
      embeds: [buildOfferEmbed(offer)],
    });
  }
  if (errors.length) await send(message, `⚠️ Some sources errored: ${errors.join('; ')}`);
}

// ============================================================
// Rendering helpers
// ============================================================

function storeNames(ids: string[]): string {
  if (!ids.length) return 'all';
  return ids.map((id) => CHEAPSHARK_STORES.find((s) => s.id === id)?.name || `#${id}`).join(', ');
}

function summarize(cfg: FreeStuffConfig): string {
  const srcs = [
    cfg.sources.gamerpower ? 'GamerPower' : null,
    cfg.sources.cheapshark ? `CheapShark (≥${cfg.onlyFreeDeals ? '100 (free only)' : cfg.minSavings}%)` : null,
  ].filter(Boolean);
  const platforms = cfg.platforms.length ? cfg.platforms.join(', ') : 'all';
  const types = cfg.types.length ? cfg.types.join(', ') : 'all';
  const storesLine = cfg.sources.cheapshark ? `\n> **Stores:** ${storeNames(cfg.stores)}` : '';
  return (
    `> **Sources:** ${srcs.join(', ') || 'none'}\n` +
    `> **Platforms:** ${platforms} · **Types:** ${types}` +
    storesLine
  );
}

async function sendStatus(message) {
  const serverId = serverIdOf(message);
  const cfg = serverId && getConfig(serverId);
  if (!cfg) {
    return void send(message, `ℹ️ Free Stuff is not set up here. Run \`${P()}freestuff setup\` in your announcements channel.`);
  }
  const state = cfg.enabled ? '🟢 Enabled' : '🔴 Disabled';
  const channel = cfg.channelId ? `<#${cfg.channelId}>` : '_not set_';
  const mention = cfg.mentionRole ? `<@&${cfg.mentionRole}>` : '_none_';
  await send(
    message,
    `**🎁 Free Stuff — Status**\n` +
      `**State:** ${state}\n` +
      `**Channel:** ${channel}\n` +
      `**Mention role:** ${mention}\n` +
      summarize(cfg),
  );
}

async function sendHelp(message, prefixNote?: string) {
  const p = P();
  const note = prefixNote ? `${prefixNote}\n\n` : '';
  await send(
    message,
    `${note}**🎁 Free Stuff — free games & deals feed**\n` +
      `Auto-posts free game giveaways (GamerPower) and big discounts (CheapShark).\n\n` +
      `\`${p}freestuff setup\` — enable in the current channel\n` +
      `\`${p}freestuff disable\` / \`enable\` — toggle the feed\n` +
      `\`${p}freestuff channel\` — move the feed here\n` +
      `\`${p}freestuff sources gamerpower cheapshark\` — pick sources\n` +
      `\`${p}freestuff platforms epic steam gog\` — GamerPower platform filter (or \`all\`)\n` +
      `\`${p}freestuff types game loot dlc\` — GamerPower offer types (or \`all\`)\n` +
      `\`${p}freestuff deals 80\` — enable CheapShark deals at ≥80% off\n` +
      `\`${p}freestuff stores steam epic gog\` — limit CheapShark to specific stores (or \`all\`)\n` +
      `\`${p}freestuff onlyfree on\` — CheapShark: only 100%-off deals\n` +
      `\`${p}freestuff mention @Role\` — ping a role on new offers (\`off\` to clear)\n` +
      `\`${p}freestuff test [n]\` — preview the latest offers now\n` +
      `\`${p}freestuff status\` — show current settings\n` +
      `\`${p}freestuff reset\` — delete this server's config`,
  );
}

function send(message, content: string) {
  return message.channel?.send({ content });
}
