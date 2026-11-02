// Phase 127 (2.60.0, docs/design/PACKS.md §4.5): the public voice ids a pack may carry. A cloned
// voice (an xAI custom voice id, an ElevenLabs voice that isn't one of its public premade voices)
// only works on its owner's account and may be someone's real voice, so the builder removes it and
// the `voice` check refuses it. Local voice ids are the ones voice-install.ts ships.
import type { CharacterVoice } from '../characterfile.ts';

/** xAI's built-in voices (lower case, as the TTS API takes them). */
export const XAI_VOICES: readonly string[] = ['eve', 'ara', 'rex', 'sal', 'leo'];
/** OpenAI's built-in TTS voices. */
export const OPENAI_VOICES: readonly string[] = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
/** ElevenLabs' public premade voice ids (the library voices everyone has). */
export const ELEVENLABS_PREMADE: readonly string[] = [
  '21m00Tcm4TlvDq8ikWAM', // Rachel
  'AZnzlk1XvdvUeBnXmlld', // Domi
  'EXAVITQu4vr4xnSDxMaL', // Sarah
  'ErXwobaYiN019PkySvjV', // Antoni
  'MF3mGyEYCl7XYWbV9V6O', // Elli
  'TxGEqnHWrfWFTfGW9XjX', // Josh
  'VR6AewLTigWG4xSOukaG', // Arnold
  'pNInz6obpgDQGcFmaJgB', // Adam
  'yoZ06aMxZJJ28mfd3POQ', // Sam
  'XB0fDUnXU5powFXDhCwa', // Charlotte
  'pFZP5JQG7iQjIQuC4Bku', // Lily
  'JBFqnCBsd6RMkjVDRZzb', // George
  'onwK4e9ZLuTAKqWW03F9', // Daniel
  'nPczCjzI2devNBz1zQrb', // Brian
  'XrExE9yKIg1WjnnlVkGX', // Matilda
  'Xb7hH8MSUJpSbSDYk0k2', // Alice
  'IKne3meq5aSn9XLyUdCD', // Charlie
  'N2lVS1w4EtoT3dr4eOWO', // Callum
  'TX3LPaxmHKxFdv7VOQHJ', // Liam
  'bIHbv24MWmeRgasZH58o', // Will
  'cgSgspJ2msm6clMCkdW9', // Jessica
  'cjVigY5qzO86Huf0OWal', // Eric
  'iP95p4xoKVk53GoZ742B', // Chris
  'CwhRBWXzGAHq8TQ4Fs17', // Roger
  'FGY2WhTYpPnrIDTdsKH5', // Laura
  'SAz9YHcvj6GT2YYXdXww', // River
];
/** The local voices Sara installs (voice-install.ts), with the names the card says. */
export const LOCAL_VOICES: Readonly<Record<string, string>> = {
  'kokoro:0': 'Default (Kokoro, US)',
  'kokoro:1': 'Bella (Kokoro, US)',
  'kokoro:2': 'Nicole (Kokoro, US)',
  'kokoro:3': 'Sarah (Kokoro, US)',
  'kokoro:4': 'Sky (Kokoro, US)',
  'kokoro:7': 'Emma (Kokoro, UK)',
  'kokoro:8': 'Isabella (Kokoro, UK)',
  'piper:hfc_female': 'Piper (US)',
};
export const VOICE_KEYS = ['tts', 'localVoice', 'speed', 'openaiVoice', 'elevenlabsVoice', 'xaiVoice', 'xaiLanguage'] as const;
export const CLONED_NOTE = 'Her own cloned voice stays with you: it belongs to your account, and it may be someone’s real voice.';

export const isPublicXai = (id: string): boolean => !id || XAI_VOICES.includes(id.toLowerCase());
export const isPublicEleven = (id: string): boolean => !id || ELEVENLABS_PREMADE.includes(id);
export const isPublicOpenai = (id: string): boolean => !id || OPENAI_VOICES.includes(id.toLowerCase());

/** The voice choice with cloned voices removed (§4.5), and whether anything was removed. */
export function shareableVoice(v: CharacterVoice): { voice: CharacterVoice; removed: boolean } {
  let removed = false;
  const out = { ...v };
  if (!isPublicXai(out.xaiVoice)) {
    out.xaiVoice = 'eve';
    removed = true;
  }
  if (!isPublicEleven(out.elevenlabsVoice)) {
    out.elevenlabsVoice = '';
    removed = true;
  }
  if (!isPublicOpenai(out.openaiVoice)) {
    out.openaiVoice = '';
    removed = true;
  }
  if (removed && ((out.tts === 'xai' && !v.xaiVoice) || out.tts === 'elevenlabs')) out.tts = 'local';
  return { voice: out, removed };
}

/** How the card names a voice choice (“Bella (Kokoro, US)”). */
export function voiceWords(v: Partial<CharacterVoice>): string {
  if (v.tts === 'off') return 'No voice';
  if (v.tts === 'xai') return `${String(v.xaiVoice || 'eve').replace(/^./, (c) => c.toUpperCase())} (xAI)`;
  if (v.tts === 'openai') return `${v.openaiVoice || 'alloy'} (OpenAI)`;
  if (v.tts === 'elevenlabs') return 'ElevenLabs';
  return LOCAL_VOICES[v.localVoice ?? ''] ?? 'Her local voice';
}
