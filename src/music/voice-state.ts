/**
 * Who sits in which voice channel, kept from gateway packets.
 *
 * This runs for every packet from boot on, so it lives apart from the music
 * stack (music/manager.ts), which is only imported once someone plays music.
 */
import type { RawPacket } from '../stoat-types.js';

/**
 * userId → voice channelId, maintained from gateway packets. stoatbot.js keeps
 * a per-channel `voice` map too, but its join/leave handlers key it by the
 * channel id instead of the user id, so it is only right straight after Ready.
 */
const userVoiceChannels = new Map<string, string>();
/** Set once a Ready packet seeded the map; before that the stoatbot.js snapshot is the only source. */
let voiceStateSeeded = false;

export function handleVoicePacket(packet: RawPacket): void {
  const p: any = packet;
  switch (p?.type) {
    case 'Ready':
      voiceStateSeeded = true;
      userVoiceChannels.clear();
      for (const state of p.voice_states || []) {
        for (const participant of state?.participants || []) {
          if (participant?.id && state?.id) userVoiceChannels.set(participant.id, state.id);
        }
      }
      break;
    case 'VoiceChannelJoin':
      if (p.state?.id && p.id) userVoiceChannels.set(p.state.id, p.id);
      break;
    case 'VoiceChannelLeave':
      if (p.user && userVoiceChannels.get(p.user) === p.id) userVoiceChannels.delete(p.user);
      break;
    case 'VoiceChannelMove':
      if (p.user && p.to) userVoiceChannels.set(p.user, p.to);
      break;
  }
}

/** Test hook. */
export function resetVoiceState() {
  userVoiceChannels.clear();
  voiceStateSeeded = false;
}

/** The voice channel the gateway last placed this user in. */
export function trackedVoiceChannel(userId: string): string | undefined {
  return userVoiceChannels.get(userId);
}

/** False until a Ready packet seeded the map. */
export function isVoiceStateSeeded(): boolean {
  return voiceStateSeeded;
}
