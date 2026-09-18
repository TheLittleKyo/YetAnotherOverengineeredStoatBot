/**
 * Tests for the pure parts of the music system: link parsing, yt-dlp / Spotify
 * metadata mapping, queue operations, voice-state tracking and formatting.
 * Nothing here spawns yt-dlp/ffmpeg or opens a voice connection.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.YAOSB_DATA_DIR = mkdtempSync(join(tmpdir(), 'yaosb-music-'));

const resolver = await import('../src/music/resolver.js');
const format = await import('../src/music/format.js');
const { GuildPlayer } = await import('../src/music/player.js');
const manager = await import('../src/music/manager.js');
const { extractYtDlpError } = await import('../src/music/tools.js');
const { cleanSearchTitle, lyricsQueryFor, pickLyrics } = await import('../src/music/lyrics.js');
const { parseProviderArgs, MUSIC_COMMAND_NAMES } = await import('../src/commands/music.js');

const requester = { id: 'u1', name: 'Tester' };

function fakeTrack(title: string, extra: Record<string, unknown> = {}) {
  return {
    title,
    url: `https://www.youtube.com/watch?v=${title}`,
    source: 'youtube' as const,
    author: 'Artist',
    duration: 180,
    isLive: false,
    requester,
    playbackUrl: `https://www.youtube.com/watch?v=${title}`,
    ...extra,
  };
}

test('parseSpotifyRef accepts links, intl links, embeds and URIs', () => {
  const id = '4PTG3Z6ehGkBFwjybzWkR8';
  assert.deepEqual(resolver.parseSpotifyRef(`https://open.spotify.com/track/${id}?si=abc`), { type: 'track', id });
  assert.deepEqual(resolver.parseSpotifyRef(`<https://open.spotify.com/intl-de/album/${id}>`), { type: 'album', id });
  assert.deepEqual(resolver.parseSpotifyRef(`https://open.spotify.com/embed/playlist/${id}`), { type: 'playlist', id });
  assert.deepEqual(resolver.parseSpotifyRef(`spotify:track:${id}`), { type: 'track', id });
  assert.equal(resolver.parseSpotifyRef('https://open.spotify.com/artist/' + id), null);
  assert.equal(resolver.parseSpotifyRef('never gonna give you up'), null);
});

test('extractUrl only accepts a single http(s) link', () => {
  assert.equal(resolver.extractUrl('<https://youtu.be/dQw4w9WgXcQ>'), 'https://youtu.be/dQw4w9WgXcQ');
  assert.equal(resolver.extractUrl('rick astley'), null);
  assert.equal(resolver.extractUrl('https://a.com b'), null);
  assert.equal(resolver.extractUrl('ftp://example.com/a.mp3'), null);
});

test('direct audio and mix-playlist detection', () => {
  assert.equal(resolver.isDirectAudioUrl('https://cdn.example.com/music/song.mp3?token=1'), true);
  assert.equal(resolver.isDirectAudioUrl('https://radio.example.com/stream'), false);
  assert.equal(resolver.shouldIgnorePlaylist('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ'), true);
  assert.equal(resolver.shouldIgnorePlaylist('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123'), false);
  assert.equal(resolver.shouldIgnorePlaylist('https://www.youtube.com/playlist?list=PL123'), false);
});

test('searchTarget builds provider-specific yt-dlp inputs', () => {
  assert.equal(resolver.searchTarget('a b', 'youtube', 5), 'ytsearch5:a b');
  assert.equal(resolver.searchTarget('a b', 'soundcloud', 1), 'scsearch1:a b');
  assert.equal(resolver.searchTarget('a b', 'ytmusic', 3), 'https://music.youtube.com/search?q=a%20b#songs');
  assert.equal(resolver.searchTarget('x', 'youtube', 99), 'ytsearch10:x');
});

test('ytDlpEntryToTrack maps YouTube flat entries', () => {
  const track = resolver.ytDlpEntryToTrack(
    {
      _type: 'url',
      ie_key: 'Youtube',
      id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Rick Astley - Never Gonna Give You Up',
      duration: 214,
      channel: 'Rick Astley',
      channel_url: 'https://www.youtube.com/channel/x',
      live_status: 'not_live',
    },
    requester,
  );
  assert.equal(track.source, 'youtube');
  assert.equal(track.duration, 214);
  assert.equal(track.author, 'Rick Astley');
  assert.equal(track.isLive, false);
  assert.equal(track.thumbnail, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  assert.equal(track.playbackUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});

test('ytDlpEntryToTrack prefers webpage_url (SoundCloud search) and skips private videos', () => {
  const sc = resolver.ytDlpEntryToTrack(
    {
      ie_key: 'Soundcloud',
      id: '253508261',
      url: 'https://api.soundcloud.com/tracks/soundcloud%3Atracks%3A253508261',
      webpage_url: 'https://soundcloud.com/rick/never-gonna',
      title: 'Never Gonna Give You Up',
      duration: 213.6,
      uploader: 'Rick Astley',
      thumbnails: [{ url: 'https://i1.sndcdn.com/small.jpg' }, { url: 'https://i1.sndcdn.com/large.jpg' }],
    },
    requester,
  );
  assert.equal(sc.url, 'https://soundcloud.com/rick/never-gonna');
  assert.equal(sc.source, 'soundcloud');
  assert.equal(sc.thumbnail, 'https://i1.sndcdn.com/large.jpg');

  assert.equal(resolver.ytDlpEntryToTrack({ url: 'https://youtu.be/x', title: '[Private video]' }, requester), null);
  const live = resolver.ytDlpEntryToTrack({ url: 'https://youtu.be/abc', title: 'Lofi', is_live: true }, requester);
  assert.equal(live.isLive, true);
  assert.equal(live.duration, null);
});

function spotifyPage(entity: unknown) {
  return `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { state: { data: { entity } } } },
  })}</script></html>`;
}

test('parseSpotifyEmbed reads a single track', () => {
  const result = resolver.parseSpotifyEmbed(
    spotifyPage({
      type: 'track',
      id: '4PTG3Z6ehGkBFwjybzWkR8',
      name: 'Never Gonna Give You Up',
      artists: [{ name: 'Rick Astley' }],
      duration: 213573,
      visualIdentity: { image: [{ url: 'https://i.scdn.co/small', maxWidth: 64 }, { url: 'https://i.scdn.co/big', maxWidth: 640 }] },
    }),
    requester,
  );
  assert.equal(result.tracks.length, 1);
  const [track] = result.tracks;
  assert.equal(track.source, 'spotify');
  assert.equal(track.url, 'https://open.spotify.com/track/4PTG3Z6ehGkBFwjybzWkR8');
  assert.equal(track.lookupQuery, 'Rick Astley - Never Gonna Give You Up');
  assert.equal(track.playbackUrl, undefined);
  assert.equal(Math.round(track.duration), 214);
  assert.equal(track.thumbnail, 'https://i.scdn.co/big');
  assert.equal(result.playlistTitle, undefined);
});

test('parseSpotifyEmbed reads playlists and drops unplayable items', () => {
  const result = resolver.parseSpotifyEmbed(
    spotifyPage({
      type: 'playlist',
      name: 'Today’s Top Hits',
      trackList: [
        { uri: 'spotify:track:aaaaaaaaaaaaaaaaaaaaaa', title: 'One', subtitle: 'A, B', duration: 1000, isPlayable: true },
        { uri: 'spotify:track:bbbbbbbbbbbbbbbbbbbbbb', title: 'Two', subtitle: 'C', duration: 2000, isPlayable: false },
        { uri: 'spotify:episode:cccccccccccccccccccccc', title: 'Pod', subtitle: 'D', duration: 3000, entityType: 'episode' },
      ],
    }),
    requester,
  );
  assert.equal(result.playlistTitle, 'Today’s Top Hits');
  assert.deepEqual(result.tracks.map((t) => t.title), ['One']);
  assert.equal(result.tracks[0].lookupQuery, 'A, B - One');
  assert.equal(resolver.parseSpotifyEmbed('<html>no data</html>', requester), null);
});

test('formatDuration and progress helpers', () => {
  assert.equal(format.formatDuration(0), '0:00');
  assert.equal(format.formatDuration(213.9), '3:33');
  assert.equal(format.formatDuration(3725), '1:02:05');
  assert.equal(format.formatDuration(null), '?:??');
  assert.equal(format.formatTrackDuration(fakeTrack('x', { isLive: true })), 'live');
  assert.equal([...format.progressBar(50, 100, 10)].length, 10);
  assert.equal(format.progressBar(10, null), '');
  assert.equal(format.escapeLinkText('[Hot] Song  (Remix)'), 'Hot Song (Remix)');
  assert.equal(format.totalDuration([fakeTrack('a'), fakeTrack('b', { isLive: true }), fakeTrack('c', { duration: null })]), 180);
});

test('paginateQueue numbers across pages and clamps the page', () => {
  const queue = Array.from({ length: 23 }, (_, i) => fakeTrack(`t${i + 1}`));
  const second = format.paginateQueue(queue, 2);
  assert.equal(second.pages, 3);
  assert.equal(second.lines.length, 10);
  assert.match(second.lines[0], /^`11\.` \[t11\]/);
  assert.equal(format.paginateQueue(queue, 99).page, 3);
  assert.equal(format.paginateQueue([], 1).pages, 1);
});

test('clampMessage cuts at a line boundary', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const clamped = format.clampMessage(text, 200);
  assert.ok(clamped.length <= 200);
  assert.ok(clamped.endsWith('\n…'));
});

test('GuildPlayer queue editing without a connection', () => {
  const player = new GuildPlayer('srv', 1.5);
  assert.equal(player.volume, 1.5);
  assert.equal(player.setVolume(5), 2);

  assert.equal(player.enqueue([fakeTrack('a'), fakeTrack('b'), fakeTrack('c')]), 3);
  player.enqueue([fakeTrack('first')], { next: true });
  assert.deepEqual(player.queue.map((t) => t.title), ['first', 'a', 'b', 'c']);

  assert.equal(player.move(4, 1).title, 'c');
  assert.deepEqual(player.queue.map((t) => t.title), ['c', 'first', 'a', 'b']);
  assert.equal(player.move(1, 99).title, 'c');
  assert.deepEqual(player.queue.map((t) => t.title), ['first', 'a', 'b', 'c']);

  assert.equal(player.remove(2).title, 'a');
  assert.equal(player.remove(0), null);
  assert.equal(player.remove(10), null);

  const before = player.queue.map((t) => t.title).sort();
  player.shuffle();
  assert.deepEqual(player.queue.map((t) => t.title).sort(), before);

  // Nothing playing: skipTo drops everything before the target.
  player.queue = [fakeTrack('first'), fakeTrack('b'), fakeTrack('c')];
  assert.equal(player.skipTo(3).title, 'c');
  assert.deepEqual(player.queue.map((t) => t.title), ['c']);
  assert.equal(player.skip(), null);
  assert.equal(player.pause(), false);
});

test('GuildPlayer caps the queue at MUSIC_MAX_QUEUE', async () => {
  const { env } = await import('../src/config.js');
  const player = new GuildPlayer('srv-cap');
  const many = Array.from({ length: env.musicMaxQueue + 5 }, (_, i) => fakeTrack(`t${i}`));
  assert.equal(player.enqueue(many), env.musicMaxQueue);
  assert.equal(player.enqueue([fakeTrack('overflow')]), 0);
});

test('voice state follows Ready / join / move / leave packets', () => {
  manager.resetVoiceState();
  const channels = new Map([
    ['vc1', { id: 'vc1', serverId: 'srv', name: 'Lounge', type: 'VOICE' }],
    ['vc2', { id: 'vc2', serverId: 'srv', name: 'Music', type: 'VOICE' }],
    ['txt', { id: 'txt', serverId: 'srv', name: 'general', type: 'TEXT' }],
    ['other', { id: 'other', serverId: 'srv2', name: 'Elsewhere', type: 'VOICE' }],
  ]);
  const client: any = { channels: { cache: channels } };

  manager.handleVoicePacket({ type: 'Ready', voice_states: [{ id: 'vc1', participants: [{ id: 'alice' }] }] });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'alice'), 'vc1');

  manager.handleVoicePacket({ type: 'VoiceChannelJoin', id: 'vc2', state: { id: 'bob' } });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'bob'), 'vc2');

  manager.handleVoicePacket({ type: 'VoiceChannelMove', user: 'bob', from: 'vc2', to: 'vc1' });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'bob'), 'vc1');

  // A stale leave for the old channel must not clear the new one.
  manager.handleVoicePacket({ type: 'VoiceChannelLeave', id: 'vc2', user: 'bob' });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'bob'), 'vc1');
  manager.handleVoicePacket({ type: 'VoiceChannelLeave', id: 'vc1', user: 'bob' });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'bob'), null);

  manager.handleVoicePacket({ type: 'VoiceChannelJoin', id: 'other', state: { id: 'carol' } });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'carol'), null);

  // A deleted (uncached) channel must not be offered as a join target.
  manager.handleVoicePacket({ type: 'VoiceChannelJoin', id: 'deleted-vc', state: { id: 'dave' } });
  assert.equal(manager.findUserVoiceChannel(client, 'srv', 'dave'), null);

  assert.equal(manager.resolveVoiceChannelArg(client, 'srv', 'music'), 'vc2');
  assert.equal(manager.resolveVoiceChannelArg(client, 'srv', '<#vc1>'), 'vc1');
  assert.equal(manager.resolveVoiceChannelArg(client, 'srv', 'general'), null);
  assert.deepEqual(manager.listVoiceChannels(client, 'srv').map((c) => c.id), ['vc1', 'vc2']);
});

test('music settings persist per server', () => {
  assert.deepEqual(manager.getMusicSettings('s1'), { volume: 1, announce: true });
  manager.updateMusicSettings('s1', { volume: 0.4 });
  manager.updateMusicSettings('s1', { announce: false });
  assert.deepEqual(manager.getMusicSettings('s1'), { volume: 0.4, announce: false });
  assert.deepEqual(manager.getMusicSettings('s2'), { volume: 1, announce: true });
});

test('search sessions expire and are single-use', () => {
  manager.startSearchSession('c', 'u', { serverId: 's', tracks: [fakeTrack('a')], next: false });
  assert.equal(manager.hasSearchSession('c', 'u'), true);
  assert.equal(manager.hasSearchSession('c', 'someone-else'), false);
  assert.equal(manager.takeSearchSession('c', 'u').tracks[0].title, 'a');
  assert.equal(manager.takeSearchSession('c', 'u'), null);
});

test('parseProviderArgs pulls search flags out of the query', () => {
  assert.deepEqual(parseProviderArgs(['--sc', 'lofi', 'beats']), { provider: 'soundcloud', query: 'lofi beats' });
  assert.deepEqual(parseProviderArgs(['lofi', '--ytm']), { provider: 'ytmusic', query: 'lofi' });
  assert.deepEqual(parseProviderArgs(['https://youtu.be/x']), { provider: 'youtube', query: 'https://youtu.be/x' });
});

test('music command names do not collide with each other', () => {
  assert.equal(new Set(MUSIC_COMMAND_NAMES).size, MUSIC_COMMAND_NAMES.length);
});

test('extractYtDlpError keeps the last ERROR line without the extractor prefix', () => {
  const stderr = 'WARNING: old\nERROR: [youtube] dQw4w9WgXcQ: Video unavailable\n';
  assert.equal(extractYtDlpError(stderr), 'Video unavailable');
  assert.equal(extractYtDlpError('nothing useful'), '');
});

test('lyrics helpers clean titles and pick the first real result', () => {
  assert.equal(cleanSearchTitle('Rick Astley - Never Gonna Give You Up (Official Video) [4K Remaster]'), 'Rick Astley - Never Gonna Give You Up');
  assert.equal(lyricsQueryFor(fakeTrack('Never Gonna Give You Up', { author: 'Rick Astley - Topic' })), 'Rick Astley Never Gonna Give You Up');
  assert.equal(lyricsQueryFor(fakeTrack('Rick Astley - Never Gonna Give You Up (Official Video)')), 'Rick Astley Never Gonna Give You Up');
  assert.deepEqual(
    pickLyrics([{ trackName: 'A', artistName: 'B', plainLyrics: '' }, { trackName: 'C', artistName: 'D', plainLyrics: 'la la\n' }]),
    { title: 'C', artist: 'D', lyrics: 'la la' },
  );
  assert.equal(pickLyrics([]), null);
});

// ── Managed yt-dlp + youtubei.js fast path ─────────────────────────────────

const binary = await import('../src/music/ytdlp-binary.js');
const youtube = await import('../src/music/youtube.js');
const { isOutdatedYtDlpError } = await import('../src/music/tools.js');

test('releaseAssets prefers the onedir zip and falls back to the single-file build', () => {
  const names = (platform: string, arch: string, musl = false) => binary.releaseAssets(platform, arch, musl).map((a) => `${a.kind}:${a.name}`);
  assert.deepEqual(names('win32', 'x64'), ['zip:yt-dlp_win.zip', 'binary:yt-dlp.exe']);
  assert.deepEqual(names('win32', 'arm64'), ['zip:yt-dlp_win_arm64.zip', 'binary:yt-dlp_arm64.exe']);
  assert.deepEqual(names('linux', 'x64'), ['zip:yt-dlp_linux.zip', 'binary:yt-dlp_linux']);
  assert.deepEqual(names('linux', 'x64', true), ['zip:yt-dlp_musllinux.zip', 'binary:yt-dlp_musllinux']);
  assert.deepEqual(names('linux', 'arm64'), ['zip:yt-dlp_linux_aarch64.zip', 'binary:yt-dlp_linux_aarch64']);
  assert.deepEqual(names('linux', 'arm'), ['zip:yt-dlp_linux_armv7l.zip']);
  assert.deepEqual(names('darwin', 'arm64'), ['zip:yt-dlp_macos.zip', 'binary:yt-dlp_macos']);
  assert.deepEqual(names('freebsd', 'x64'), []);
});

test('findLauncherName picks the yt-dlp executable at the archive root', () => {
  assert.equal(binary.findLauncherName(['_internal', 'yt-dlp.exe']), 'yt-dlp.exe');
  assert.equal(binary.findLauncherName(['yt-dlp_linux', 'LICENSE']), 'yt-dlp_linux');
  assert.equal(binary.findLauncherName(['README.txt']), null);
});

test('parseChecksum and tagFromReleaseUrl read GitHub release data', () => {
  const sums = [
    '1111111111111111111111111111111111111111111111111111111111111111  yt-dlp',
    '66674953FE251B89F4D08C5F0E35E0728679BD67AB3D7D05C0562AF101DD3E7A  yt-dlp.exe',
    '2222222222222222222222222222222222222222222222222222222222222222  yt-dlp_x86.exe',
  ].join('\n');
  assert.equal(binary.parseChecksum(sums, 'yt-dlp.exe'), '66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a');
  assert.equal(binary.parseChecksum(sums, 'yt-dlp_macos'), null);
  assert.equal(binary.tagFromReleaseUrl('https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19'), '2026.08.19');
  assert.equal(binary.tagFromReleaseUrl(null), null);
});

test('jsRuntimeArgs points yt-dlp at the running JS runtime when supported', () => {
  const args = binary.jsRuntimeArgs('2026.08.19');
  assert.equal(args[0], '--no-js-runtimes');
  assert.equal(args[2], `${process.versions.bun ? 'bun' : 'node'}:${process.execPath}`);
  assert.deepEqual(binary.jsRuntimeArgs('2025.10.22'), []);
  assert.equal(binary.jsRuntimeArgs(null).length, 3);
});

test('isOutdatedYtDlpError recognizes errors a yt-dlp update fixes', () => {
  assert.equal(isOutdatedYtDlpError('unable to download video data: HTTP Error 403: Forbidden'), true);
  assert.equal(isOutdatedYtDlpError('Sign in to confirm you are not a bot'), true);
  assert.equal(isOutdatedYtDlpError('Video unavailable'), false);
  assert.equal(isOutdatedYtDlpError('HTTP Error 429: Too Many Requests'), false);
});

test('parseYouTubeUrl handles every link shape', () => {
  const id = 'dQw4w9WgXcQ';
  assert.deepEqual(youtube.parseYouTubeUrl(`https://youtu.be/${id}?si=abc`), { videoId: id, playlistId: null, music: false });
  assert.deepEqual(youtube.parseYouTubeUrl(`https://www.youtube.com/watch?v=${id}&list=PL1`), { videoId: id, playlistId: 'PL1', music: false });
  assert.deepEqual(youtube.parseYouTubeUrl(`https://music.youtube.com/watch?v=${id}`), { videoId: id, playlistId: null, music: true });
  assert.equal(youtube.parseYouTubeUrl(`https://m.youtube.com/shorts/${id}`).videoId, id);
  assert.equal(youtube.parseYouTubeUrl(`https://www.youtube.com/live/${id}`).videoId, id);
  assert.deepEqual(youtube.parseYouTubeUrl('https://www.youtube.com/playlist?list=PL123'), { videoId: null, playlistId: 'PL123', music: false });
  assert.equal(youtube.parseYouTubeUrl('https://www.youtube.com/watch?v=short').videoId, null);
  assert.equal(youtube.parseYouTubeUrl('https://notyoutube.com/watch?v=' + id), null);
  assert.equal(youtube.parseYouTubeUrl('never gonna'), null);
});

test('parseClock reads badge durations', () => {
  assert.equal(youtube.parseClock('3:55'), 235);
  assert.equal(youtube.parseClock('1:02:05'), 3725);
  assert.equal(youtube.parseClock('LIVE'), null);
  assert.equal(youtube.parseClock(''), null);
});

test('trackFromListNode maps Video and LockupView nodes', () => {
  const video = youtube.trackFromListNode(
    {
      type: 'Video',
      video_id: 'dQw4w9WgXcQ',
      title: { toString: () => 'Never Gonna Give You Up' },
      duration: { seconds: 214 },
      author: { name: 'Rick Astley', url: '/@RickAstleyYT' },
      is_live: false,
    },
    requester,
  );
  assert.equal(video.title, 'Never Gonna Give You Up');
  assert.equal(video.authorUrl, 'https://www.youtube.com/@RickAstleyYT');
  assert.equal(video.playbackUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const lockup = youtube.trackFromListNode(
    {
      type: 'LockupView',
      content_id: 'fOT0BUpITw8',
      content_type: 'VIDEO',
      content_image: { overlays: [{ badges: [{ text: '3:55' }] }, { buttons: [] }] },
      metadata: {
        title: { text: 'BELLAKEO (Video Oficial)' },
        metadata: { metadata_rows: [{ metadata_parts: [{ text: { text: 'Peso Pluma' } }] }] },
      },
    },
    requester,
  );
  assert.deepEqual(
    [lockup.title, lockup.author, lockup.duration, lockup.isLive, lockup.thumbnail],
    ['BELLAKEO (Video Oficial)', 'Peso Pluma', 235, false, 'https://i.ytimg.com/vi/fOT0BUpITw8/hqdefault.jpg'],
  );
  assert.equal(youtube.trackFromListNode({ type: 'LockupView', content_id: 'PLxxxxxxxxxxxxx', content_type: 'PLAYLIST' }, requester), null);
  assert.equal(youtube.trackFromListNode({ type: 'PlaylistVideo', id: 'dQw4w9WgXcQ', is_playable: false }, requester), null);
});

test('trackFromMusicNode maps YouTube Music songs', () => {
  const song = youtube.trackFromMusicNode(
    {
      id: 'lYBUbBu4W08',
      title: 'Never Gonna Give You Up',
      duration: { seconds: 214 },
      artists: [{ name: 'Rick Astley' }],
      thumbnails: [{ url: 'https://yt3/small', width: 60 }, { url: 'https://yt3/big', width: 544 }],
    },
    requester,
  );
  assert.equal(song.url, 'https://music.youtube.com/watch?v=lYBUbBu4W08');
  assert.equal(song.author, 'Rick Astley');
  assert.equal(song.thumbnail, 'https://yt3/big');
});

test('asUnavailable separates dead videos from bot checks', () => {
  assert.ok(youtube.asUnavailable({ message: 'This video is unavailable', info: { status: 'ERROR' } }) instanceof youtube.YouTubeUnavailableError);
  assert.ok(youtube.asUnavailable({ message: 'Private video' }) instanceof youtube.YouTubeUnavailableError);
  assert.equal(youtube.asUnavailable({ message: 'Sign in to confirm you are not a bot', info: { status: 'LOGIN_REQUIRED' } }), null);
  assert.equal(youtube.asUnavailable({ message: 'fetch failed' }), null);
});

test('CircuitBreaker opens after consecutive failures and resets on success', () => {
  const breaker = new youtube.CircuitBreaker('test', 2, 60_000);
  const warn = console.warn;
  console.warn = () => {};
  try {
    breaker.failure(new Error('a'));
    breaker.success();
    breaker.failure(new Error('b'));
    assert.equal(breaker.available, true);
    breaker.failure(new Error('c'));
    assert.equal(breaker.available, false);
  } finally {
    console.warn = warn;
  }
});

// ── Review fixes ───────────────────────────────────────────────────────────

test('mention syntax from untrusted text cannot ping', () => {
  const neutral = format.neutralizeMentions('hi <@01ABC> and <%01ROLE> and @everyone / @online');
  assert.ok(!/<[@%]/.test(neutral));
  assert.ok(!/@(everyone|online)\b/.test(neutral));
  assert.ok(!format.trackLink(fakeTrack('<@01ABC>')).includes('<@'));
  assert.equal(format.escapeLinkUrl('https://a.com/x_(y) z'), 'https://a.com/x_%28y%29%20z');
});

test('withTimeout rejects late work and hands the late result to onLate', async () => {
  const { withTimeout } = await import('../src/async-utils.js');
  let late: string | null = null;
  const slowValue = new Promise<string>((resolve) => setTimeout(() => resolve('stream'), 30));
  await assert.rejects(withTimeout(slowValue, 5, 'too slow', (value) => { late = value; }), /too slow/);
  await slowValue;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(late, 'stream');
  assert.equal(await withTimeout(Promise.resolve(1), 50, 'never'), 1);
});

test('skipTo keeps loop-queue order: current before the jumped-over tracks', () => {
  const player = new GuildPlayer('srv-jump');
  player.loop = 'queue';
  player.current = fakeTrack('now');
  player.queue = [fakeTrack('a'), fakeTrack('b'), fakeTrack('target'), fakeTrack('rest')];
  assert.equal(player.skipTo(3).title, 'target');
  assert.deepEqual(player.queue.map((t) => t.title), ['target', 'rest', 'now', 'a', 'b']);
});

test('an empty fast-path result only trips the breaker when yt-dlp finds something', async () => {
  const { withYouTubeFallback } = resolver;
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await withYouTubeFallback('search', async () => [], async () => []), []);
    }
    assert.equal(youtube.metadataBreaker.available, true, 'legitimately empty searches must not disable the fast path');

    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await withYouTubeFallback('search', async () => [], async () => ['found']), ['found']);
    }
    assert.equal(youtube.metadataBreaker.available, false);
  } finally {
    console.warn = warn;
  }
});

// ── Preloading ─────────────────────────────────────────────────────────────

test('upcomingTrack follows the loop mode', () => {
  const player: any = new GuildPlayer('srv-upcoming');
  const now = fakeTrack('now');
  const next = fakeTrack('next');
  assert.equal(player.upcomingTrack(), null);
  player.queue = [next];
  assert.equal(player.upcomingTrack(), next);
  player.current = now;
  assert.equal(player.upcomingTrack(), next);
  player.loop = 'track';
  assert.equal(player.upcomingTrack(), now);
  player.loop = 'queue';
  player.queue = [];
  assert.equal(player.upcomingTrack(), now, 'a one-track queue loop replays the current track');
  player.loop = 'off';
  assert.equal(player.upcomingTrack(), null);
});

test('a preload is only started for a player that is in or joining a call', () => {
  const player: any = new GuildPlayer('srv-idle');
  player.queue = [fakeTrack('a')];
  assert.equal(player.preloadingTrack, null, 'no call, no background download');
  assert.equal(player.shouldPreloadNow(), false);
});

test('queue and loop changes drop a preload that is no longer next', () => {
  const player: any = new GuildPlayer('srv-preload');
  const a = fakeTrack('a');
  const b = fakeTrack('b');
  player.queue = [a, b];
  let stops = 0;
  const fake = (track) => ({ track, pipeline: { stop: () => { stops++; } }, ready: Promise.resolve(), startedAt: Date.now(), cancelled: false });

  player.preload = fake(a);
  player.move(2, 1); // b is next now
  assert.equal(player.preloadingTrack, null);
  assert.equal(stops, 1);

  player.preload = fake(b);
  player.queue = [b, a];
  assert.equal(player.preloadingTrack, b, 'still next: kept');

  player.current = fakeTrack('now');
  player.loop = 'track'; // the current track repeats instead of b
  assert.equal(player.preloadingTrack, null);
  assert.equal(stops, 2);

  player.loop = 'off';
  player.preload = fake(b);
  player.stop();
  assert.equal(player.preloadingTrack, null);
  assert.equal(stops, 3);
});

// ── Radio ──────────────────────────────────────────────────────────────────

const radio = await import('../src/music/radio.js');
const { ffmpegArgs } = await import('../src/music/audio-stream.js');

test('parsePls returns stream URLs in their numbered order', () => {
  const pls = '[playlist]\nnumberofentries=2\nFile2=https://b.example/stream\nTitle2=B\nFile1=https://a.example/stream\nLength1=-1\n';
  assert.deepEqual(radio.parsePls(pls), ['https://a.example/stream', 'https://b.example/stream']);
  assert.deepEqual(radio.parsePls('<html>nope</html>'), []);
});

test('parseM3u tells plain station lists from HLS playlists', () => {
  assert.deepEqual(radio.parseM3u('#EXTM3U\n#EXTINF:-1,Station\nhttp://ice6.somafm.com/groovesalad-128-aac\n'), {
    hls: false,
    urls: ['http://ice6.somafm.com/groovesalad-128-aac'],
  });
  const hls = radio.parseM3u('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-STREAM-INF:BANDWIDTH=96000\nchunklist.m3u8\n');
  assert.equal(hls.hls, true);
});

test('ICY metadata titles are parsed and re-decoded', () => {
  assert.equal(radio.parseIcyStreamTitle("StreamTitle='Guns N' Roses - Don't Cry';StreamUrl='';"), "Guns N' Roses - Don't Cry");
  assert.equal(radio.parseIcyStreamTitle("StreamTitle='';"), null);
  assert.equal(radio.parseIcyStreamTitle('garbage'), null);
  // "Café" sent as UTF-8 but read as Latin-1 bytes.
  assert.equal(radio.decodeIcyText(Buffer.from('Café <b>FM</b>', 'utf8').toString('latin1')), 'Café FM');
});

test('radioInfoFromHeaders reads station details and ignores unsafe homepages', () => {
  const headers = new Headers({
    'icy-name': 'Groove Salad [SomaFM]',
    'icy-genre': 'Ambient Chill',
    'icy-br': '128',
    'icy-url': 'http://somafm.com',
  });
  assert.deepEqual(radio.radioInfoFromHeaders(headers), {
    name: 'Groove Salad [SomaFM]',
    genre: 'Ambient Chill',
    description: undefined,
    homepage: 'http://somafm.com',
    bitrate: 128,
  });
  assert.equal(radio.radioInfoFromHeaders(new Headers({ 'icy-url': 'javascript:alert(1)' })).homepage, undefined);
});

test('playlistKind and isRadioPlaylistUrl detect playlists by type or extension', () => {
  assert.equal(radio.playlistKind('audio/x-scpls', 'https://x/listen'), 'pls');
  assert.equal(radio.playlistKind('audio/x-mpegurl', 'https://x/listen'), 'm3u');
  assert.equal(radio.playlistKind('application/vnd.apple.mpegurl', 'https://x/a'), 'm3u');
  assert.equal(radio.playlistKind('audio/mpeg', 'https://x/stream'), null);
  assert.equal(radio.isRadioPlaylistUrl('https://somafm.com/groovesalad.pls'), true);
  assert.equal(radio.isRadioPlaylistUrl('https://x/live/index.m3u8?token=1'), true);
  assert.equal(radio.isRadioPlaylistUrl('https://x/song.mp3'), false);
});

test('radioTrack is live and falls back to the stream address for a name', () => {
  const track = radio.radioTrack({ pageUrl: 'https://radio.example/stream', streamUrl: 'https://radio.example/stream', info: {}, requester });
  assert.equal(track.source, 'radio');
  assert.equal(track.isLive, true);
  assert.equal(track.duration, null);
  assert.equal(track.title, 'radio.example/stream');
  assert.equal(format.formatTrackDuration(track), 'live');
});

test('readIcyTitle skips the audio interval and reads the metadata block across chunks', async () => {
  const metaint = 10;
  const meta = Buffer.from("StreamTitle='Artist - Song';");
  const block = Buffer.concat([meta, Buffer.alloc(Math.ceil(meta.length / 16) * 16 - meta.length)]);
  const bytes = Buffer.concat([Buffer.alloc(metaint, 1), Buffer.from([block.length / 16]), block, Buffer.alloc(20)]);
  const chunks = [bytes.subarray(0, 7), bytes.subarray(7, 12), bytes.subarray(12, 30), bytes.subarray(30)];
  const reader = { read: async () => (chunks.length ? { done: false, value: chunks.shift() } : { done: true }) };
  assert.equal(await radio.readIcyTitle(reader, metaint), 'Artist - Song');

  const silent = Buffer.concat([Buffer.alloc(metaint), Buffer.from([0])]);
  assert.equal(await radio.readIcyTitle({ read: async () => ({ done: false, value: silent }) }, metaint), null);
});

test('ffmpeg input flags: radio reconnects at EOF, HLS and files do not', () => {
  const radioArgs = ffmpegArgs('https://s/stream', { radio: true });
  assert.ok(radioArgs.includes('-reconnect_at_eof'));
  assert.ok(radioArgs.includes('-rw_timeout'));
  assert.ok(radioArgs.includes('-user_agent'));
  assert.ok(!ffmpegArgs('https://s/live.m3u8', { radio: true, manifest: 'hls' }).includes('-reconnect_at_eof'));
  assert.ok(!ffmpegArgs('https://s/song.mp3', { network: true }).includes('-reconnect_at_eof'));
  assert.ok(!ffmpegArgs('pipe:0').includes('-reconnect'));
});

test('radio link kinds cover DASH and Windows Media / XSPF playlists', () => {
  assert.equal(radio.playlistKind('application/dash+xml', 'https://x/live'), 'dash');
  assert.equal(radio.playlistKind('', 'https://x/live/manifest.mpd'), 'dash');
  assert.equal(radio.playlistKind('video/x-ms-wvx', 'https://x/listen'), 'xml');
  assert.equal(radio.playlistKind('', 'https://x/station.asx'), 'xml');
  assert.equal(radio.playlistKind('application/xspf+xml', 'https://x/p'), 'xml');
  assert.deepEqual(
    radio.parseXmlPlaylist('<asx version="3.0"><entry><ref href="http://a.example/stream?x=1&amp;y=2"/></entry><entry><REF HREF=\'mms://b\'/></entry></asx>'),
    ['http://a.example/stream?x=1&y=2', 'mms://b'],
  );
  assert.deepEqual(radio.parseXmlPlaylist('<playlist><trackList><track><location> https://c.example/live </location></track></trackList></playlist>'), [
    'https://c.example/live',
  ]);
});

test('lenient-server errors are told apart from unreachable stations', () => {
  const parseError = new TypeError('fetch failed', { cause: new Error('Response does not match the HTTP/1.1 protocol (Missing expected CR after response line)') });
  assert.equal(radio.isLenientServerError(parseError), true);
  assert.equal(radio.isLenientServerError(new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'HPE_INVALID_CONSTANT' }) })), true);
  assert.equal(radio.isLenientServerError(new TypeError('fetch failed', { cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }) })), false);
  assert.ok(!radio.RADIO_USER_AGENT.includes('Mozilla'), 'SHOUTcast sends browser user agents to its HTML page');
  assert.ok(ffmpegArgs('https://s/stream', { radio: true }).includes(radio.RADIO_USER_AGENT));
});

// ── Radio formats ──────────────────────────────────────────────────────────

test('extractRadioUrl normalizes stream schemes and rejects unplayable ones', () => {
  assert.equal(radio.extractRadioUrl('<https://ice1.somafm.com/groovesalad-128-mp3>'), 'https://ice1.somafm.com/groovesalad-128-mp3');
  assert.equal(radio.extractRadioUrl('icy://radio.example:8000/live'), 'http://radio.example:8000/live');
  assert.equal(radio.extractRadioUrl('icyx://regiocast.streamabc.net/stream?x=1'), 'http://regiocast.streamabc.net/stream?x=1');
  assert.equal(radio.extractRadioUrl('mms://wm.example.com/live'), 'mmsh://wm.example.com/live');
  assert.equal(radio.extractRadioUrl('rtsp://media.example.com:554/radio'), 'rtsp://media.example.com:554/radio');
  assert.equal(radio.extractRadioUrl('rtmp://live.example.com/app/stream'), 'rtmp://live.example.com/app/stream');
  assert.equal(radio.extractRadioUrl('just words'), null);
  assert.equal(radio.extractRadioUrl('gopher://x.example/1'), null);
  assert.throws(() => radio.extractRadioUrl('pnm://old.example/x.ra'), /pnm/);
  assert.throws(() => radio.extractRadioUrl('udp://239.0.0.1:1234'), /not supported/);
  assert.throws(() => radio.extractRadioUrl('file:///etc/passwd'), /not supported/);
});

test('sniffBody tells formats apart by content, not headers', () => {
  const text = (value: string) => Buffer.from(value);
  assert.equal(radio.sniffBody(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 1, 2, 3, 0, 0, 0])), 'audio');
  assert.equal(radio.sniffBody(Buffer.concat([text('OggS'), Buffer.alloc(40)])), 'audio');
  assert.equal(radio.sniffBody(text('#EXTM3U\n#EXT-X-TARGETDURATION:10\nseg.php?s=1\n')), 'm3u');
  assert.equal(radio.sniffBody(text('\uFEFF[playlist]\nFile1=http://a/stream\n')), 'pls');
  assert.equal(radio.sniffBody(text('<asx version="3.0"><entry><ref href="http://a/s"/></entry></asx>')), 'xml');
  assert.equal(radio.sniffBody(text('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">')), 'dash');
  assert.equal(radio.sniffBody(text('<?wpl version="1.0"?><smil><body><seq><media src="http://a/s"/></seq></body></smil>')), 'xml');
  assert.equal(radio.sniffBody(text('http://stream.srg-ssr.ch/srgssr/srf3/aac/96\n')), 'lines');
  assert.equal(radio.sniffBody(text('<!DOCTYPE html><html><body>Player</body></html>')), 'html');
  assert.equal(radio.sniffBody(text('Stream is currently offline.')), 'text');
});

test('parsePlaylist handles RAM, STRM, SMIL, WPL, B4S and QTL', () => {
  assert.deepEqual(radio.parsePlaylist('lines', 'rtsp://real.example/live.rm\n--stop--\nhttp://b.example/aac\n').urls, [
    'rtsp://real.example/live.rm',
    'http://b.example/aac',
  ]);
  assert.deepEqual(radio.parseXmlPlaylist('<smil><body><audio src="rtsp://s.example/radio"/></body></smil>'), ['rtsp://s.example/radio']);
  assert.deepEqual(radio.parseXmlPlaylist('<?wpl version="1.0"?><smil><body><seq><media src="http://w.example/live"/></seq></body></smil>'), ['http://w.example/live']);
  assert.deepEqual(
    radio.parseXmlPlaylist('<?xml version="1.0"?><WinampXML><playlist num_entries="1"><entry Playstring="file:http://b4s.example/stream"><Name>X</Name></entry></playlist></WinampXML>'),
    ['http://b4s.example/stream'],
  );
  assert.deepEqual(
    radio.parseXmlPlaylist('<?xml version="1.0"?><?quicktime type="application/x-quicktimeplayer"?><embed src="rtsp://qt.example/live.sdp" autoplay="true"/>'),
    ['rtsp://qt.example/live.sdp'],
  );
  assert.deepEqual(radio.parseXmlPlaylist('<asx><entry><entryref href="http://a.example/next.asx"/></entry></asx>'), ['http://a.example/next.asx']);
});

test('playlistKind covers every radio playlist extension', () => {
  for (const ext of ['pls', 'm3u', 'm3u8']) assert.ok(radio.isRadioPlaylistUrl(`https://x.example/radio.${ext}`), ext);
  for (const ext of ['asx', 'wax', 'wvx', 'xspf', 'smil', 'smi', 'wpl', 'b4s', 'qtl']) assert.equal(radio.playlistKind('', `https://x.example/r.${ext}`), 'xml', ext);
  for (const ext of ['ram', 'rpm', 'strm']) assert.equal(radio.playlistKind('', `https://x.example/r.${ext}`), 'lines', ext);
  assert.equal(radio.playlistKind('audio/x-pn-realaudio', 'https://x.example/listen'), 'lines');
  assert.equal(radio.playlistKind('application/vnd.ms-wpl', 'https://x.example/listen'), 'xml');
  assert.equal(radio.playlistKind('video/x-ms-asf', 'https://x.example/listen'), null, 'real ASF streams share this type; the body decides');
});

test('ffmpeg input options are chosen per protocol and ffmpeg version', () => {
  const rtsp = ffmpegArgs('rtsp://s.example/radio', { radio: true });
  assert.ok(rtsp.includes('-rtsp_transport') && !rtsp.includes('-reconnect') && !rtsp.includes('-user_agent'));
  const rtmp = ffmpegArgs('rtmp://s.example/app/radio', { radio: true });
  assert.ok(rtmp.includes('-rw_timeout') && !rtmp.includes('-reconnect') && !rtmp.includes('-rtsp_transport'));
  const mms = ffmpegArgs('mmsh://s.example/radio', { radio: true });
  assert.ok(!mms.includes('-reconnect'));

  const hlsNew = ffmpegArgs('https://s.example/live.php', { radio: true, manifest: 'hls', ffmpegVersion: 8.1 });
  assert.ok(hlsNew.includes('-allowed_extensions') && hlsNew.includes('-extension_picky'));
  const hlsOld = ffmpegArgs('https://s.example/live.php', { radio: true, manifest: 'hls', ffmpegVersion: 6.1 });
  assert.ok(hlsOld.includes('-allowed_extensions') && !hlsOld.includes('-extension_picky'), 'older ffmpeg rejects unknown options');
  assert.ok(!ffmpegArgs('https://s.example/live.mpd', { radio: true, manifest: 'dash' }).includes('-allowed_extensions'));
});

test('parseFfmpegVersion reads release, git and distro version strings', async () => {
  const { parseFfmpegVersion } = await import('../src/music/tools.js');
  assert.equal(parseFfmpegVersion('ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026'), 8.1);
  assert.equal(parseFfmpegVersion('ffmpeg version 4.4.2-0ubuntu0.22.04.1 Copyright'), 4.4);
  assert.equal(parseFfmpegVersion('ffmpeg version n7.1 Copyright'), 7.1);
  assert.equal(parseFfmpegVersion('ffmpeg version N-118896-g1234abcd Copyright'), Number.POSITIVE_INFINITY);
  assert.equal(parseFfmpegVersion(null), null);
});

test('stream proxies and broken TLS chains still reach ffmpeg', () => {
  assert.equal(radio.sniffBody(Buffer.from('ICY 200 OK\r\nicy-notice1:<BR>This stream requires Winamp<BR>\r\n')), 'audio');
  assert.equal(radio.sniffBody(Buffer.from('HTTP/1.0 200 OK\r\nContent-Type: audio/mpeg\r\n\r\n')), 'audio');
  const tls = new TypeError('fetch failed', { cause: Object.assign(new Error('unable to verify the first certificate'), { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }) });
  assert.equal(radio.isLenientServerError(tls), true);
});
