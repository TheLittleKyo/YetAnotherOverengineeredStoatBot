/**
 * Shared shapes for the music system.
 */

export type TrackSource = 'youtube' | 'soundcloud' | 'spotify' | 'direct' | 'radio' | 'other';

/** Station details from the stream's ICY headers. */
export type RadioInfo = {
  name?: string;
  genre?: string;
  description?: string;
  homepage?: string;
  /** kbps */
  bitrate?: number;
  /** Segmented live manifest rather than a continuous Icecast/SHOUTcast stream. */
  manifest?: 'hls' | 'dash';
};

export type SearchProvider = 'youtube' | 'ytmusic' | 'soundcloud';

export type Requester = {
  id: string;
  name: string;
};

export type Track = {
  title: string;
  /** Page URL shown to users (YouTube watch page, Spotify track, stream URL…). */
  url: string;
  source: TrackSource;
  author: string;
  authorUrl?: string;
  /** Seconds, or null when unknown or a live stream. */
  duration: number | null;
  isLive: boolean;
  thumbnail?: string;
  requester: Requester;
  /**
   * What the audio pipeline actually feeds to yt-dlp / ffmpeg. For Spotify
   * tracks this starts empty and is filled by a YouTube lookup right before
   * playback, so a 100-track playlist does not run 100 searches up front.
   */
  playbackUrl?: string;
  /** Search used to find playable audio when `playbackUrl` is missing. */
  lookupQuery?: string;
  /** Set for internet radio stations. */
  radio?: RadioInfo;
};

export type ResolveResult = {
  tracks: Track[];
  /** Set when the input was a playlist / album. */
  playlistTitle?: string;
};

export type LoopMode = 'off' | 'track' | 'queue';
