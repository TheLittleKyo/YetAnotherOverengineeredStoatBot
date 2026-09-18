/**
 * The one way into the music stack for the parts of the bot loaded at boot.
 *
 * Music is by far the heaviest feature: youtubei.js alone takes ~3 s to
 * import, and starting music downloads or updates yt-dlp and opens a YouTube
 * session. None of that is imported until music is actually used (or the
 * Music module is switched on, which warms it up in the background). The
 * LiveKit native library is not saved this way: stoatbot.js loads it itself.
 * Voice-state tracking, which must run from boot, lives in voice-state.ts and
 * does not go through here.
 */
import type { StoatClient } from '../stoat-types.js';

type MusicCommandModule = typeof import('../commands/music.js');
type MusicManagerModule = typeof import('./manager.js');

let loading: Promise<[MusicCommandModule, MusicManagerModule]> | null = null;
let loaded = false;
let backgroundStarted = false;

function loadMusic(): Promise<[MusicCommandModule, MusicManagerModule]> {
  if (!loading) {
    const attempt = Promise.all([import('../commands/music.js'), import('./manager.js')]);
    loading = attempt;
    attempt.then(
      () => { loaded = true; },
      () => { if (loading === attempt) loading = null; },
    );
  }
  return loading;
}

/** Whether the music stack has been imported in this process. */
export function isMusicLoaded(): boolean {
  return loaded;
}

/** Run a music command, importing the music stack first when needed. */
export async function runMusicCommand(message: any, args: string[], client: StoatClient): Promise<void> {
  const [commands] = await loadMusic();
  await commands.musicCommand(message, args, client);
}

// Control panels and pending searches only exist in the music module's memory,
// so until it is loaded there is nothing for these two to answer.

export async function handleMusicPanelReaction(ctx: { client: StoatClient; messageId: string; userId: string; emoji: string }): Promise<boolean> {
  if (!loaded) return false;
  const [commands] = await loadMusic();
  return commands.handleMusicPanelReaction(ctx);
}

export async function handleMusicSearchReply(message: any, client: StoatClient): Promise<boolean> {
  if (!loaded) return false;
  const [commands] = await loadMusic();
  return commands.handleMusicSearchReply(message, client);
}

/**
 * Import the music stack and start its background upkeep (yt-dlp maintenance
 * and the YouTube session warm-up), so the first `play` is quick. Runs once.
 */
export async function startMusicBackground(): Promise<void> {
  if (backgroundStarted) return;
  backgroundStarted = true;
  try {
    const [, manager] = await loadMusic();
    manager.startMusicBackground();
  } catch (error) {
    backgroundStarted = false;
    throw error;
  }
}

/** Leave every voice channel and stop the upkeep timers. A no-op when never loaded. */
export async function shutdownMusic(): Promise<void> {
  if (!loaded) return;
  const [, manager] = await loadMusic();
  backgroundStarted = false;
  await manager.shutdownMusic();
}
