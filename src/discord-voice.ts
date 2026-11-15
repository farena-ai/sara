// R5 (docs/PHONE_CALLS.md "Discord voice"): her voice in a Discord voice channel, ready as an
// interface and switched off. Joining and leaving a channel is one gateway message on the bridge's
// existing connection (op 4, Voice State Update); the audio itself needs Discord's voice transport
// (a second WebSocket, UDP, transport encryption and the Opus codec). Sara ships without
// dependencies and package.json has no Discord or Opus library, so the audio transport is not built:
// the setting stays off and Join explains why. Speech in and out would reuse the existing speech
// stack (her hearing for each speaker's turn, her voice for replies), like phone calls do.
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';

export interface DiscordVoiceSettings {
  /** Off by default; it can't be switched on until a voice transport exists. */
  on: boolean;
  /** The voice channel the owner picked (server id + channel id). */
  guildId: string;
  channelId: string;
}
export const DEFAULT_DISCORD_VOICE: DiscordVoiceSettings = { on: false, guildId: '', channelId: '' };

export const DISCORD_VOICE_LINES = {
  noTransport: en('Discord voice needs a voice library (Discord’s voice connection and the Opus codec) that Sara doesn’t include yet, so it stays off.'),
  noBridge: en('Connect Discord first (Settings → Chat apps → Discord).'),
  noChannel: en('Pick the voice channel first (its server ID and channel ID).'),
} as const;

/** What a voice transport must do; nothing implements it yet. */
export interface DiscordVoiceTransport {
  /** Connects to the channel's voice server after Discord sent VOICE_STATE_UPDATE + VOICE_SERVER_UPDATE. */
  connect(o: { guildId: string; channelId: string; sessionId: string; endpoint: string; token: string; userId: string }): Promise<void>;
  /** PCM 48 kHz stereo from each speaker, per turn. */
  onSpeech?: (userId: string, pcm: Int16Array) => void;
  /** Plays her voice (PCM 48 kHz stereo). */
  play(pcm: Int16Array): Promise<void>;
  disconnect(): Promise<void>;
}

export function discordVoiceSettings(app: AppContext): DiscordVoiceSettings {
  const s = (app.settings.get() as { discordVoice?: Partial<DiscordVoiceSettings> }).discordVoice ?? {};
  return { ...DEFAULT_DISCORD_VOICE, ...s };
}

const snowflake = (v: unknown) => {
  const s = String(v ?? '').trim();
  return /^\d{15,22}$/.test(s) ? s : '';
};

/** Saves the picked channel. The switch stays off while no transport is available. */
export function saveDiscordVoice(app: AppContext, input: Record<string, unknown>, transport?: DiscordVoiceTransport): DiscordVoiceSettings {
  const cur = discordVoiceSettings(app);
  const next: DiscordVoiceSettings = {
    guildId: input.guildId === undefined ? cur.guildId : snowflake(input.guildId),
    channelId: input.channelId === undefined ? cur.channelId : snowflake(input.channelId),
    on: Boolean(transport) && (input.on === undefined ? cur.on : input.on === true),
  };
  app.settings.update({ discordVoice: next } as never);
  return next;
}

/** Gateway op 4: join (channelId) or leave (null) a voice channel. */
export function voiceStateUpdate(guildId: string, channelId: string | null): string {
  return JSON.stringify({ op: 4, d: { guild_id: guildId, channel_id: channelId, self_mute: false, self_deaf: false } });
}

/** Can she join now? English lines for what's missing (the route translates). */
export function discordVoiceStatus(app: AppContext, o: { bridge: boolean; transport?: DiscordVoiceTransport }): { on: boolean; canJoin: boolean; missing: string[]; settings: DiscordVoiceSettings } {
  const s = discordVoiceSettings(app);
  const missing: string[] = [];
  if (!o.transport) missing.push(DISCORD_VOICE_LINES.noTransport);
  if (!o.bridge) missing.push(DISCORD_VOICE_LINES.noBridge);
  if (!s.guildId || !s.channelId) missing.push(DISCORD_VOICE_LINES.noChannel);
  return { on: s.on && Boolean(o.transport), canJoin: missing.length === 0 && s.on, missing, settings: s };
}
