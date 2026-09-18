import { MessageEmbed } from 'stoatbot.js';
import { config } from '../config.js';
import { hasPermissionInServer } from '../permissions.js';
import { resolveBotPermission, runWithBotPermission } from '../bot-permissions.js';
import { withTimeout } from '../async-utils.js';
import { getReadableError } from '../error-utils.js';
import { debug } from '../logger.js';
import type { StoatClient } from '../stoat-types.js';
import {
  clampMessage,
  describeLoop,
  escapeLinkText,
  formatDuration,
  formatTrackDuration,
  MESSAGE_LIMIT,
  neutralizeMentions,
  paginateQueue,
  progressBar,
  totalDuration,
  trackLink,
} from '../music/format.js';
import { fetchLyrics, lyricsQueryFor } from '../music/lyrics.js';
import {
  canControlPlayer,
  findUserVoiceChannel,
  getMusicSettings,
  getOrCreatePlayer,
  getPanel,
  getPlayer,
  hasSearchSession,
  PANEL_CONTROLS,
  type PanelAction,
  refreshPanels,
  registerPanel,
  resolveVoiceChannelArg,
  startSearchSession,
  takeSearchSession,
  updateMusicSettings,
} from '../music/manager.js';
import type { GuildPlayer } from '../music/player.js';
import { extractRadioUrl, fetchNowPlaying, resolveRadio, STREAM_DIRECTORY_URL } from '../music/radio.js';
import { MUSIC_COMMANDS, MUSIC_HELP_LINES } from './music-meta.js';
import { extractUrl, resolveQuery, searchTracks } from '../music/resolver.js';
import { checkMusicTools, describeMissingTools } from '../music/tools.js';
import { metadataBreaker, streamBreaker } from '../music/youtube.js';
import { isManagedYtDlp } from '../music/ytdlp-binary.js';
import type { LoopMode, Requester, SearchProvider, Track } from '../music/types.js';

/**
 * Music playback in voice channels: YouTube, YouTube Music, SoundCloud,
 * Spotify links, radio streams and anything else yt-dlp can read. Feature set
 * modelled on Remix (https://github.com/remix-bot/stoat).
 *
 * Every music command is registered under its own name in commands/index.ts
 * and routed here as `[invokedAs, ...args]`.
 */

type Ctx = {
  client: StoatClient;
  message: any;
  serverId: string;
  userId: string;
  channelId: string;
  requester: Requester;
  send: (content: string) => Promise<any>;
};

type Handler = (ctx: Ctx, args: string[]) => Promise<unknown>;

// The name table and help text live in music-meta.ts, which the always-loaded
// command registry and help can import without pulling in the music stack.
export { MUSIC_COMMAND_NAMES, MUSIC_COMMANDS, MUSIC_HELP_LINES } from './music-meta.js';

const ALIAS_TO_HANDLER = new Map<string, string>();
for (const [handler, names] of Object.entries(MUSIC_COMMANDS)) {
  for (const name of names) ALIAS_TO_HANDLER.set(name, handler);
}

const EMBED_COLOR = '#fd6671';

export async function musicCommand(message: any, args: string[], client: StoatClient) {
  const [invokedAs, ...rest] = args;
  let handlerName = ALIAS_TO_HANDLER.get(String(invokedAs || '').toLowerCase()) || 'music';
  let handlerArgs = rest;

  // `!music play …` works the same as `!play …`.
  if (handlerName === 'music' && rest[0] && ALIAS_TO_HANDLER.has(rest[0].toLowerCase()) && rest[0].toLowerCase() !== 'music') {
    handlerName = ALIAS_TO_HANDLER.get(rest[0].toLowerCase());
    handlerArgs = rest.slice(1);
  }

  const serverId = message?.channel?.serverId || message?.server?.id || message?.serverId;
  if (!serverId) {
    await message.channel?.send({ content: '❌ Music only works in server channels.' });
    return;
  }

  const ctx: Ctx = {
    client,
    message,
    serverId: String(serverId),
    userId: String(message.authorId || message.author?.id || ''),
    channelId: String(message.channelId || message.channel?.id || ''),
    requester: {
      id: String(message.authorId || message.author?.id || ''),
      name: message.member?.nickname || message.author?.displayName || message.author?.username || 'someone',
    },
    send: (content) => message.channel?.send({ content: clampMessage(content) }),
  };

  await HANDLERS[handlerName](ctx, handlerArgs);
}

// ── Shared guards ──────────────────────────────────────────────────────────

const p = () => config.prefix;

async function requireTools(ctx: Ctx): Promise<boolean> {
  const missing = await describeMissingTools();
  if (!missing) return true;
  await ctx.send(`❌ ${missing}`);
  return false;
}

/** The server's player, but only if it is connected; otherwise explain and return null. */
async function requireActivePlayer(ctx: Ctx): Promise<GuildPlayer | null> {
  const player = getPlayer(ctx.serverId);
  if (!player?.connected) {
    await ctx.send(`❌ I'm not playing anything here. Start with \`${p()}play <song or link>\`.`);
    return null;
  }
  return player;
}

/** Active player that the caller is allowed to control. */
async function requireControl(ctx: Ctx): Promise<GuildPlayer | null> {
  const player = await requireActivePlayer(ctx);
  if (!player) return null;
  if (await canControlPlayer(ctx.client, ctx.serverId, ctx.userId)) {
    player.textChannelId = ctx.channelId;
    return player;
  }
  const inCall = findUserVoiceChannel(ctx.client, ctx.serverId, ctx.userId) === player.channelId;
  await ctx.send(inCall ? '❌ Your roles are not allowed to control the music.' : `❌ Join <#${player.channelId}> to control the music.`);
  return null;
}

function parsePosition(value: string | undefined): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** Pull a provider flag (`--sc`, `--ytm`, `--yt`) out of the arguments. */
export function parseProviderArgs(args: string[]): { provider: SearchProvider; query: string } {
  let provider: SearchProvider = 'youtube';
  const rest: string[] = [];
  for (const arg of args) {
    const flag = arg.toLowerCase();
    if (flag === '--sc' || flag === '--soundcloud') provider = 'soundcloud';
    else if (flag === '--ytm' || flag === '--music' || flag === '--ytmusic') provider = 'ytmusic';
    else if (flag === '--yt' || flag === '--youtube') provider = 'youtube';
    else rest.push(arg);
  }
  return { provider, query: rest.join(' ').trim() };
}

// ── Queueing ───────────────────────────────────────────────────────────────

/**
 * Join the caller's voice channel if needed, then queue `tracks`. `status` is
 * a message to edit with the result (a new one is sent when absent).
 */
async function queueTracks(
  ctx: Ctx,
  resolveTracks: () => Promise<{ tracks: Track[]; playlistTitle?: string }>,
  options: { next: boolean; status?: any },
) {
  const edit = async (content: string) => {
    if (options.status?.edit) {
      try {
        await options.status.edit({ content: clampMessage(content) });
        return;
      } catch {
        // fall back to a new message
      }
    }
    await ctx.send(content);
  };

  const existing = getPlayer(ctx.serverId);
  let targetChannel: string | null = null;
  // Connected or still joining: the bot stays where it is, and only people there may add music.
  // Checking only `connected` let a second user drag the bot into their channel mid-join.
  if (existing?.targetChannelId) {
    if (!(await canControlPlayer(ctx.client, ctx.serverId, ctx.userId, { queueing: true }))) {
      await edit(`❌ I'm already playing in <#${existing.targetChannelId}>. Join it to add music.`);
      return;
    }
  } else {
    targetChannel = findUserVoiceChannel(ctx.client, ctx.serverId, ctx.userId);
    if (!targetChannel) {
      await edit(`❌ Join a voice channel first, or bring me in with \`${p()}join <channel>\`.`);
      return;
    }
  }

  const player = getOrCreatePlayer(ctx.client, ctx.serverId);
  player.textChannelId = ctx.channelId;

  // Join and look up at the same time. Tracks are queued as soon as the lookup
  // is done, even if the join is still in progress, so the first song already
  // downloads (preloads) while the bot connects.
  const joining = targetChannel ? player.join(ctx.client, targetChannel) : null;
  joining?.catch(() => {}); // awaited below; avoid an unhandled rejection meanwhile

  let resolved: { tracks: Track[]; playlistTitle?: string };
  try {
    resolved = await resolveTracks();
  } catch (error) {
    await edit(`❌ ${getReadableError(error)}`);
    // Only this command's own join is undone, never one another command started.
    if (joining) {
      await joining.catch(() => {});
      if (!player.current && player.queue.length === 0) await player.destroy('command');
    }
    return;
  }

  const { tracks, playlistTitle } = resolved;
  const wasIdle = !player.current && player.queue.length === 0;
  const added = player.enqueue(tracks, { next: options.next });

  if (joining) {
    try {
      await joining;
    } catch (error) {
      await edit(`❌ ${getReadableError(error)}`);
      // This command's join failed, so nothing queued for that call can play.
      await player.destroy('command');
      return;
    }
  }
  refreshPanels(ctx.client, ctx.serverId);

  if (added === 0) {
    await edit(`❌ The queue is full (${player.queue.length} tracks).`);
    return;
  }

  if (playlistTitle) {
    const truncated = added < tracks.length ? ` (queue limit reached, ${tracks.length - added} skipped)` : '';
    await edit(
      `📃 Queued **${added}** track${added === 1 ? '' : 's'} from **${escapeLinkText(playlistTitle)}**` +
        ` \`${formatDuration(totalDuration(tracks.slice(0, added)))}\`${truncated}`,
    );
    return;
  }

  const track = tracks[0];
  if (track.source === 'radio') {
    const details = radioDetails(track);
    if (wasIdle) await edit(`📻 Tuning in to ${trackLink(track)}${details ? ` · ${details}` : ''}`);
    else await edit(`📻 Queued ${trackLink(track)} at position **${options.next ? 1 : player.queue.length}**. Use \`${p()}skip\` to reach it.`);
    return;
  }
  if (wasIdle) {
    await edit(`▶️ Starting ${trackLink(track)} \`${formatTrackDuration(track)}\``);
  } else {
    const position = options.next ? 1 : player.queue.length;
    await edit(`➕ Queued ${trackLink(track)} \`${formatTrackDuration(track)}\` at position **${position}**`);
  }
}

async function play(ctx: Ctx, args: string[], next: boolean) {
  const { provider, query } = parseProviderArgs(args);
  if (!query) {
    await ctx.send(
      `Usage: \`${p()}${next ? 'playnext' : 'play'} <song name or link>\`\n` +
        'Links: YouTube, YouTube Music, SoundCloud, Spotify, radio streams and most media sites.\n' +
        'Search flags: `--sc` SoundCloud, `--ytm` YouTube Music (default: YouTube).',
    );
    return;
  }
  if (!(await requireTools(ctx))) return;

  const status = await ctx.send(`🔎 Looking up **${escapeLinkText(query).slice(0, 100)}**…`);
  await queueTracks(ctx, () => resolveQuery(query, { provider, requester: ctx.requester }), { next, status });
}

// ── Handlers ───────────────────────────────────────────────────────────────

const HANDLERS: Record<string, Handler> = {
  async music(ctx, args) {
    const sub = String(args[0] || '').toLowerCase();

    if (sub === 'announce') {
      const value = String(args[1] || '').toLowerCase();
      if (!['on', 'off'].includes(value)) {
        const current = getMusicSettings(ctx.serverId).announce ? 'on' : 'off';
        await ctx.send(`Now-playing announcements are **${current}**. Change with \`${p()}music announce on|off\`.`);
        return;
      }
      const canChange = await runWithBotPermission('music.dj', ctx.userId, () =>
        hasPermissionInServer(ctx.client, ctx.serverId, ctx.userId, ['ManageServer']),
      );
      if (!canChange) {
        await ctx.send('❌ You need **Manage Server** permission to change music settings.');
        return;
      }
      updateMusicSettings(ctx.serverId, { announce: value === 'on' });
      await ctx.send(`✅ Now-playing announcements turned **${value}**.`);
      return;
    }

    if (sub === 'status') {
      const tools = await checkMusicTools();
      const player = getPlayer(ctx.serverId);
      const ytDlpSource = isManagedYtDlp() ? 'managed, auto-updated daily' : 'from YTDLP_PATH';
      const fastPath = metadataBreaker.available && streamBreaker.available ? 'on' : 'paused after repeated failures (yt-dlp only)';
      await ctx.send(
        `# 🎵 Music status\n\n` +
          `• yt-dlp: ${tools.ytDlp ? `\`${tools.ytDlp}\` (${ytDlpSource})` : '**not found**'}\n` +
          `• YouTube fast path (youtubei.js): ${fastPath}\n` +
          `• ffmpeg: ${tools.ffmpeg ? `\`${tools.ffmpeg.replace(/ Copyright.*$/, '')}\`` : '**not found**'}\n` +
          `• This server: ${player?.connected ? `playing in <#${player.channelId}>, ${player.queue.length} queued` : 'not connected'}\n` +
          `• Announcements: **${getMusicSettings(ctx.serverId).announce ? 'on' : 'off'}**`,
      );
      return;
    }

    await ctx.send(renderMusicHelp());
  },

  play: (ctx, args) => play(ctx, args, false),
  playnext: (ctx, args) => play(ctx, args, true),

  async radio(ctx, args) {
    const input = args.join(' ').trim();
    if (!input) {
      const current = getPlayer(ctx.serverId)?.current;
      if (current?.source === 'radio') {
        const onAir = await withTimeout(fetchNowPlaying(current), 6_000, 'slow').catch(() => null);
        return ctx.send(
          `📻 Streaming ${trackLink(current)}${radioDetails(current) ? ` · ${radioDetails(current)}` : ''}` +
            (onAir ? `\n🎶 On air: **${escapeLinkText(onAir)}**` : ''),
        );
      }
      return ctx.send(
        `Usage: \`${p()}radio <stream link>\`\n` +
          `Find a station's stream link on <${STREAM_DIRECTORY_URL}>: search the station, open it, and copy one of its stream URLs.\n` +
          'Works with Icecast/SHOUTcast streams (`http`, `https`, `icy`), HLS `.m3u8`, DASH `.mpd`, `rtsp://`, `rtmp://` and `mms://` links, ' +
          'and the playlist files stations hand out (`.pls`, `.m3u`, `.asx`, `.xspf`, `.ram`, `.smil`, `.wpl`, `.b4s`, `.qtl`, `.strm`), e.g. ' +
          '`https://ice1.somafm.com/groovesalad-128-mp3`.\n' +
          `While a station plays, \`${p()}radio\` shows the song on air and \`${p()}skip\` moves on.`,
      );
    }

    let url: string | null;
    try {
      url = extractRadioUrl(args[0]);
    } catch (error) {
      return ctx.send(`❌ ${getReadableError(error)}`);
    }
    if (!url) {
      return ctx.send(
        `❌ \`${p()}radio\` needs a stream link (http, https, rtsp, rtmp or mms). Find one on <${STREAM_DIRECTORY_URL}>, or search for music with \`${p()}play\`.`,
      );
    }
    if (!(await requireTools(ctx))) return;

    const status = await ctx.send('📻 Tuning in…');
    await queueTracks(ctx, () => resolveRadio(url, ctx.requester), { next: false, status });
  },

  async search(ctx, args) {
    const { provider, query } = parseProviderArgs(args);
    if (!query) {
      await ctx.send(`Usage: \`${p()}search [--sc|--ytm] <query>\``);
      return;
    }
    if (!(await requireTools(ctx))) return;

    const status = await ctx.send(`🔎 Searching for **${escapeLinkText(query).slice(0, 100)}**…`);
    let results: Track[];
    try {
      results = await searchTracks(query, provider, ctx.requester, 5);
    } catch (error) {
      await status?.edit?.({ content: `❌ ${getReadableError(error)}` });
      return;
    }
    if (results.length === 0) {
      await status?.edit?.({ content: `❌ No results for **${escapeLinkText(query).slice(0, 100)}**.` });
      return;
    }

    startSearchSession(ctx.channelId, ctx.userId, { serverId: ctx.serverId, tracks: results, next: false });
    const lines = results.map((track, i) => `\`${i + 1}.\` ${trackLink(track)} \`${formatTrackDuration(track)}\` · ${escapeLinkText(track.author)}`);
    const content = clampMessage(
      `# 🔎 Results\n\n${lines.join('\n')}\n\nReply with a number (1-${results.length}) within 60 seconds, or \`x\` to cancel.`,
    );
    if (status?.edit) await status.edit({ content });
    else await ctx.send(content);
  },

  async join(ctx, args) {
    const target = args.length
      ? resolveVoiceChannelArg(ctx.client, ctx.serverId, args.join(' '))
      : findUserVoiceChannel(ctx.client, ctx.serverId, ctx.userId);
    if (!target) {
      await ctx.send(
        args.length
          ? '❌ I could not find that voice channel in this server.'
          : `❌ Join a voice channel first, or name one: \`${p()}join <channel>\`.`,
      );
      return;
    }

    const existing = getPlayer(ctx.serverId);
    if (existing?.targetChannelId) {
      if (existing.targetChannelId === target) {
        await ctx.send(`I'm already in <#${target}>.`);
        return;
      }
      if (!(await canControlPlayer(ctx.client, ctx.serverId, ctx.userId))) {
        await ctx.send(`❌ I'm busy in <#${existing.targetChannelId}>. Join it to move me.`);
        return;
      }
    }

    if (!(await requireTools(ctx))) return;
    const player = getOrCreatePlayer(ctx.client, ctx.serverId);
    player.textChannelId = ctx.channelId;
    try {
      await player.join(ctx.client, target);
    } catch (error) {
      if (!player.connected) await player.destroy('command');
      await ctx.send(`❌ ${getReadableError(error)}`);
      return;
    }
    await ctx.send(`🔊 Joined <#${target}>.`);
  },

  async leave(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    const channelId = player.channelId;
    await player.destroy('command');
    await ctx.send(`👋 Left <#${channelId}> and cleared the queue.`);
  },

  async pause(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    if (!player.current) return ctx.send('❌ Nothing is playing.');
    if (!player.pause()) return ctx.send(`Already paused. Use \`${p()}resume\` to continue.`);
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send('⏸️ Paused.');
  },

  async resume(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    if (!player.resume()) return ctx.send('❌ Playback is not paused.');
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send('▶️ Resumed.');
  },

  async skip(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    const skipped = player.skip();
    if (!skipped) return ctx.send('❌ Nothing is playing.');
    await ctx.send(`⏭️ Skipped ${trackLink(skipped)}.`);
  },

  async skipto(ctx, args) {
    const player = await requireControl(ctx);
    if (!player) return;
    const position = parsePosition(args[0]);
    if (!position || position > player.queue.length) {
      return ctx.send(`Usage: \`${p()}skipto <position>\` (1-${player.queue.length || 1}). See \`${p()}queue\`.`);
    }
    const target = player.skipTo(position);
    await ctx.send(target ? `⏭️ Jumping to ${trackLink(target)}.` : '❌ Could not skip there.');
  },

  async stop(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    player.stop();
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send(`⏹️ Stopped and cleared the queue. \`${p()}leave\` disconnects me.`);
  },

  async clear(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    const count = player.queue.length;
    player.queue = [];
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send(`🧹 Removed **${count}** upcoming track${count === 1 ? '' : 's'}.`);
  },

  async queue(ctx, args) {
    const player = getPlayer(ctx.serverId);
    if (!player?.connected || (!player.current && player.queue.length === 0)) {
      return ctx.send(`The queue is empty. Add music with \`${p()}play <song or link>\`.`);
    }
    const page = paginateQueue(player.queue, Number(args[0]) || 1);
    const header = `# 🎵 Queue · ${player.queue.length} track${player.queue.length === 1 ? '' : 's'} · \`${formatDuration(totalDuration(player.queue))}\``;
    const now = player.current
      ? `**Now:** ${trackLink(player.current)} \`${formatDuration(player.position)} / ${formatTrackDuration(player.current)}\`${player.paused ? ' (paused)' : ''}`
      : '**Now:** loading…';
    const body = page.lines.length ? page.lines.join('\n') : '*Nothing queued after this track.*';
    const footer = `Page ${page.page}/${page.pages} · Loop: ${describeLoop(player.loop)} · Volume: ${Math.round(player.volume * 100)}%`;
    await ctx.send(`${header}\n\n${now}\n\n${body}\n\n${footer}`);
  },

  async nowplaying(ctx) {
    const player = getPlayer(ctx.serverId);
    const track = player?.current;
    if (!player || !track) return ctx.send('❌ Nothing is playing.');

    const bar = track.isLive ? `🔴 Live · listening for ${formatDuration(player.position)}` : `${progressBar(player.position, track.duration)} \`${formatDuration(player.position)} / ${formatTrackDuration(track)}\``;
    const onAir = track.source === 'radio' ? await withTimeout(fetchNowPlaying(track), 6_000, 'slow').catch(() => null) : null;
    const description = [
      track.source === 'radio' ? radioDetails(track, true) : `by ${escapeLinkText(track.author)}`,
      onAir ? `🎶 On air: **${escapeLinkText(onAir)}**` : '',
      bar,
      `Requested by ${escapeLinkText(track.requester.name)} · Volume ${Math.round(player.volume * 100)}% · Loop ${describeLoop(player.loop)}${player.paused ? ' · Paused' : ''}`,
      player.queue[0] ? `Up next: ${trackLink(player.queue[0])}` : '',
    ].filter(Boolean).join('\n\n');

    const build = (withMedia: boolean) => {
      const embed = new MessageEmbed().setTitle(escapeLinkText(track.title).slice(0, 100)).setDescription(description).setColor(EMBED_COLOR);
      if (track.url) embed.setURL(track.url);
      if (withMedia && track.thumbnail) embed.setMedia(track.thumbnail);
      return embed;
    };

    try {
      await ctx.message.channel?.send({ embeds: [build(true)] });
    } catch (error) {
      debug('music:np', () => `embed with thumbnail failed: ${error?.message || error}`);
      await ctx.message.channel?.send({ embeds: [build(false)] });
    }
  },

  async remove(ctx, args) {
    const player = await requireControl(ctx);
    if (!player) return;
    const position = parsePosition(args[0]);
    const removed = position ? player.remove(position) : null;
    if (!removed) return ctx.send(`Usage: \`${p()}remove <position>\` (1-${player.queue.length || 1}). See \`${p()}queue\`.`);
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send(`🗑️ Removed ${trackLink(removed)}.`);
  },

  async move(ctx, args) {
    const player = await requireControl(ctx);
    if (!player) return;
    const from = parsePosition(args[0]);
    const to = parsePosition(args[1]);
    const moved = from && to ? player.move(from, to) : null;
    if (!moved) return ctx.send(`Usage: \`${p()}move <from> <to>\` (1-${player.queue.length || 1}). See \`${p()}queue\`.`);
    await ctx.send(`↕️ Moved ${trackLink(moved)} to position **${Math.min(to, player.queue.length)}**.`);
  },

  async shuffle(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;
    if (player.queue.length < 2) return ctx.send('❌ Need at least two queued tracks to shuffle.');
    player.shuffle();
    await ctx.send(`🔀 Shuffled **${player.queue.length}** tracks.`);
  },

  async loop(ctx, args) {
    const player = await requireControl(ctx);
    if (!player) return;
    const wanted = String(args[0] || '').toLowerCase();
    const aliases: Record<string, LoopMode> = { off: 'off', none: 'off', track: 'track', song: 'track', one: 'track', queue: 'queue', all: 'queue' };
    let mode: LoopMode;
    if (!wanted) mode = player.loop === 'off' ? 'track' : player.loop === 'track' ? 'queue' : 'off';
    else if (aliases[wanted]) mode = aliases[wanted];
    else return ctx.send(`Usage: \`${p()}loop [off|track|queue]\``);
    player.loop = mode;
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send(`🔁 Loop: **${describeLoop(mode)}**.`);
  },

  async volume(ctx, args) {
    if (!args[0]) {
      const player = getPlayer(ctx.serverId);
      const level = player ? player.volume : getMusicSettings(ctx.serverId).volume;
      return ctx.send(`🔊 Volume is **${Math.round(level * 100)}%**. Change with \`${p()}volume <0-200>\`.`);
    }
    const percent = Number(String(args[0]).replace(/%$/, ''));
    if (!Number.isFinite(percent) || percent < 0 || percent > 200) return ctx.send(`Usage: \`${p()}volume <0-200>\``);

    const player = getPlayer(ctx.serverId);
    if (player?.connected && !(await canControlPlayer(ctx.client, ctx.serverId, ctx.userId))) {
      return ctx.send(`❌ Join <#${player.channelId}> to control the music.`);
    }
    const level = percent / 100;
    player?.setVolume(level);
    updateMusicSettings(ctx.serverId, { volume: level });
    refreshPanels(ctx.client, ctx.serverId);
    await ctx.send(`🔊 Volume set to **${Math.round(percent)}%**.`);
  },

  async lyrics(ctx, args) {
    const player = getPlayer(ctx.serverId);
    const current = player?.current;
    let query = args.join(' ');
    if (!query && current?.source === 'radio') {
      // For a station, look up the song currently on air.
      query = (await fetchNowPlaying(current)) || '';
      if (!query) return ctx.send('❌ This station does not say which song is on air. Try `' + p() + 'lyrics <song>`.');
    } else if (!query && current) {
      query = lyricsQueryFor(current);
    }
    if (!query) return ctx.send(`Usage: \`${p()}lyrics [song]\` (defaults to the current track).`);

    let result;
    try {
      result = await fetchLyrics(query);
    } catch (error) {
      return ctx.send(`❌ Lyrics lookup failed: ${getReadableError(error)}`);
    }
    if (!result) return ctx.send(`❌ No lyrics found for **${escapeLinkText(query).slice(0, 100)}**.`);

    const header = `# 📝 ${escapeLinkText(result.title)} · ${escapeLinkText(result.artist)}\n\n`;
    const chunks = chunkLines(neutralizeMentions(result.lyrics), MESSAGE_LIMIT - header.length);
    const shown = chunks.slice(0, 3);
    for (let i = 0; i < shown.length; i++) {
      const more = i === shown.length - 1 && chunks.length > shown.length ? '\n\n*…truncated*' : '';
      const credit = i === shown.length - 1 ? '\n\n*Lyrics from LRCLIB*' : '';
      await ctx.send(`${i === 0 ? header : ''}${shown[i]}${more}${credit}`);
    }
  },

  async player(ctx) {
    const player = await requireControl(ctx);
    if (!player) return;

    const render = () => renderPanel(ctx.serverId);
    const sent = await ctx.message.channel?.send({ content: render() });
    if (!sent?.id) return;
    registerPanel({ serverId: ctx.serverId, channelId: ctx.channelId, messageId: sent.id, render });
    for (const emoji of Object.keys(PANEL_CONTROLS)) {
      try {
        await sent.addReaction(emoji);
      } catch (error) {
        debug('music:panel', () => `could not add ${emoji}: ${error?.message || error}`);
        break;
      }
    }
  },
};

/** `Ambient Chill · 128 kbps`, plus the station's own description when `long`. */
function radioDetails(track: Track, long = false): string {
  const info = track.radio;
  if (!info) return '';
  const parts = [info.genre, info.bitrate ? `${info.bitrate} kbps` : '', info.manifest ? info.manifest.toUpperCase() : ''].filter(Boolean).map((part) => escapeLinkText(part));
  const line = parts.join(' · ');
  if (!long) return line;
  const description = info.description ? escapeLinkText(info.description).slice(0, 300) : '';
  return [line, description].filter(Boolean).join('\n') || 'Internet radio';
}

function renderPanel(serverId: string): string {
  const player = getPlayer(serverId);
  if (!player?.connected) return '⏹️ Player closed.';
  const track = player.current;
  const now = track
    ? `${player.paused ? '⏸️' : '▶️'} ${trackLink(track)} \`${formatTrackDuration(track)}\``
    : '⏹️ Nothing playing';
  const next = player.queue[0] ? `Up next: ${trackLink(player.queue[0])}` : 'Queue is empty';
  return (
    `# 🎛️ Music player · <#${player.channelId}>\n\n${now}\n${next}\n\n` +
    `Loop: **${describeLoop(player.loop)}** · Volume: **${Math.round(player.volume * 100)}%** · Queued: **${player.queue.length}**\n\n` +
    '*⏯️ pause/resume · ⏭️ skip · ⏹️ stop · 🔁 loop · 🔀 shuffle · 🔉/🔊 volume*'
  );
}

export function renderMusicHelp(): string {
  const prefix = config.prefix;
  return MUSIC_HELP_LINES.map((line) => `• ${line.replaceAll('{p}', prefix)}`).join('\n').replace(/^/, '# 🎵 Music\n\n');
}

function chunkLines(text: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = line.slice(0, limit);
    } else {
      current = candidate.slice(0, limit);
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ── Non-command entry points (wired in index.ts) ───────────────────────────

/**
 * A plain `1`-`5` (or `x`) reply to a pending `search`. Returns true when the
 * message was consumed.
 */
export async function handleMusicSearchReply(message: any, client: StoatClient): Promise<boolean> {
  if (message?.author?.bot) return false;
  const content = String(message?.content || '').trim().toLowerCase();
  if (!/^(\d{1,2}|x|cancel)$/.test(content)) return false;

  const channelId = String(message.channelId || message.channel?.id || '');
  const userId = String(message.authorId || message.author?.id || '');
  if (!hasSearchSession(channelId, userId)) return false;
  const session = takeSearchSession(channelId, userId);
  if (!session) return false;

  if (content === 'x' || content === 'cancel') {
    await message.channel?.send({ content: 'Search cancelled.' });
    return true;
  }
  const track = session.tracks[Number(content) - 1];
  if (!track) {
    await message.channel?.send({ content: `❌ Pick a number between 1 and ${session.tracks.length}. Search again with \`${config.prefix}search\`.` });
    return true;
  }

  await musicCommandForSearchPick(message, client, session.serverId, track, session.next);
  return true;
}

async function musicCommandForSearchPick(message: any, client: StoatClient, serverId: string, track: Track, next: boolean) {
  const ctx: Ctx = {
    client,
    message,
    serverId,
    userId: String(message.authorId || message.author?.id || ''),
    channelId: String(message.channelId || message.channel?.id || ''),
    requester: track.requester,
    send: (content) => message.channel?.send({ content: clampMessage(content) }),
  };
  if (!(await requireTools(ctx))) return;
  await queueTracks(ctx, async () => ({ tracks: [track] }), { next });
}

/** Reaction on a `player` panel. Returns true when the message was a panel. */
export async function handleMusicPanelReaction({
  client,
  messageId,
  userId,
  emoji,
}: {
  client: StoatClient;
  messageId: string;
  userId: string;
  emoji: string;
}): Promise<boolean> {
  const panel = messageId ? getPanel(messageId) : null;
  if (!panel) return false;
  if (!userId || userId === (client as any).user?.id) return true;

  const action: PanelAction | undefined = PANEL_CONTROLS[emoji as keyof typeof PANEL_CONTROLS];
  if (!action) return true;

  const player = getPlayer(panel.serverId);
  if (!player?.connected) return true;
  // Reactions bypass the command dispatcher, so apply a Music deny here too.
  if ((await resolveBotPermission(client, panel.serverId, userId, 'music')) === 'deny') return true;
  if (!(await canControlPlayer(client, panel.serverId, userId))) return true;

  applyPanelAction(player, action, panel.serverId);
  refreshPanels(client, panel.serverId);

  // Take the reaction back so the button can be pressed again (needs Manage Messages).
  try {
    await (client as any).api.delete(
      `/channels/${panel.channelId}/messages/${panel.messageId}/reactions/${encodeURIComponent(emoji)}` +
        `?user_id=${encodeURIComponent(userId)}&remove_all=false`,
    );
  } catch (error) {
    debug('music:panel', () => `could not remove reaction: ${error?.message || error}`);
  }
  return true;
}

function applyPanelAction(player: GuildPlayer, action: PanelAction, serverId: string) {
  switch (action) {
    case 'toggle':
      if (!player.pause()) player.resume();
      break;
    case 'skip':
      player.skip();
      break;
    case 'stop':
      player.stop();
      break;
    case 'loop':
      player.loop = player.loop === 'off' ? 'track' : player.loop === 'track' ? 'queue' : 'off';
      break;
    case 'shuffle':
      player.shuffle();
      break;
    case 'volumeDown':
    case 'volumeUp': {
      const step = action === 'volumeUp' ? 0.1 : -0.1;
      const level = player.setVolume(Math.round((player.volume + step) * 10) / 10);
      updateMusicSettings(serverId, { volume: level });
      break;
    }
  }
}
