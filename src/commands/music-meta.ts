/**
 * The music command's names and help text, kept apart from commands/music.ts.
 *
 * The command registry and `!help` load at boot; the music command itself
 * pulls in youtubei.js (~3 s to import), so it is only imported on first use
 * (see music/lazy.ts). Everything boot needs to know about music lives here
 * instead.
 */
import { STREAM_DIRECTORY_URL } from '../music/radio.js';

/** Every name that routes to the music command, grouped by handler. */
export const MUSIC_COMMANDS: Record<string, string[]> = {
  music: ['music'],
  play: ['play', 'p'],
  radio: ['radio', 'fm'],
  playnext: ['playnext', 'pn', 'playtop'],
  search: ['search'],
  join: ['join', 'summon'],
  leave: ['leave', 'disconnect', 'dc'],
  pause: ['pause'],
  resume: ['resume', 'unpause'],
  skip: ['skip', 'next'],
  skipto: ['skipto', 'jump'],
  stop: ['stop'],
  clear: ['clear'],
  queue: ['queue', 'q'],
  nowplaying: ['nowplaying', 'np', 'current'],
  remove: ['remove', 'rm'],
  move: ['move', 'mv'],
  shuffle: ['shuffle'],
  loop: ['loop', 'repeat'],
  volume: ['volume', 'vol'],
  lyrics: ['lyrics', 'ly'],
  player: ['player', 'controls'],
};

export const MUSIC_COMMAND_NAMES = Object.values(MUSIC_COMMANDS).flat();

export const MUSIC_HELP_LINES = [
  '`{p}play <song|link>` - Play or queue from YouTube, YouTube Music, SoundCloud, Spotify, radio streams (aliases: `{p}p`)',
  '`{p}playnext <song|link>` - Queue at the front (alias: `{p}pn`). Flags for text search: `--sc` SoundCloud, `--ytm` YouTube Music',
  `\`{p}radio <stream link>\` - Play an internet radio station: Icecast/SHOUTcast, HLS, DASH, RTSP, RTMP and MMS streams, or a playlist file (\`.pls\`, \`.m3u\`, \`.asx\`, \`.xspf\`, \`.ram\`, \`.smil\`, \`.wpl\`, \`.b4s\`, \`.qtl\`, \`.strm\`) (alias: \`{p}fm\`). Find stream links on <${STREAM_DIRECTORY_URL}>. \`{p}radio\` alone shows the song on air`,
  '`{p}search <query>` - Show 5 results, reply with a number to play one',
  '`{p}join [channel]` / `{p}leave` - Bring the bot into your voice channel, or disconnect',
  '`{p}pause` / `{p}resume` / `{p}skip` / `{p}skipto <n>` / `{p}stop` - Playback controls',
  '`{p}queue [page]` / `{p}np` - Show the queue / the current track',
  '`{p}remove <n>` / `{p}move <from> <to>` / `{p}shuffle` / `{p}clear` - Edit the queue',
  '`{p}loop [off|track|queue]` / `{p}volume <0-200>` - Repeat mode and volume (volume is remembered per server)',
  '`{p}lyrics [song]` - Lyrics for the current track or a search',
  '`{p}player` - Reaction control panel (pause, skip, stop, loop, shuffle, volume)',
  '`{p}music announce on|off` / `{p}music status` - Now-playing messages (Manage Server) and tool check',
  'Controls work for people in the bot\'s voice channel, or members with Manage Server / Move Members.',
];
