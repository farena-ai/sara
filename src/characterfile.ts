// Phase 21: a whole character in one file, to keep, share or move to another server: name,
// pronouns, personality and the rest of the character sheet, her look (all the pictures), and
// her voice choice. No keys, no memories, no conversations: only who she is.
import { DEFAULT_VOICE, type VoiceSettings } from './voice.ts';
import { LOOK_PATHS } from './look.ts';
import { validatePersona, type Persona } from './persona.ts';
import type { AppContext } from './chat.ts';
import { scrubPersona } from './packs/scrub.ts';

export const CHARACTER_FORMAT = 'sara-character';
const MAX_PICTURE = 5 * 1024 * 1024;

/** The voice choice only (which voice, how fast): never keys or server addresses. */
export interface CharacterVoice {
  tts: VoiceSettings['tts'];
  localVoice: string;
  speed: number;
  openaiVoice: string;
  elevenlabsVoice: string;
  xaiVoice: string;
  xaiLanguage: string;
}

export interface CharacterFile {
  format: typeof CHARACTER_FORMAT;
  version: 1;
  exportedAt: string;
  persona: Persona;
  voice?: CharacterVoice;
  /** Look pictures by their place in the app, base64. Missing = the default look. */
  look?: Record<string, string>;
}

function voiceOf(app: AppContext): VoiceSettings {
  const v = app.settings.get().voice ?? {};
  return { ...DEFAULT_VOICE, ...v, openai: { ...DEFAULT_VOICE.openai, ...v.openai }, elevenlabs: { ...DEFAULT_VOICE.elevenlabs, ...v.elevenlabs }, xai: { ...DEFAULT_VOICE.xai, ...v.xai } };
}

/** Her voice choice (which voice, how fast), never keys or addresses. */
export function characterVoice(app: AppContext): CharacterVoice {
  const v = voiceOf(app);
  return { tts: v.tts, localVoice: v.localVoice, speed: v.speed, openaiVoice: v.openai.ttsVoice, elevenlabsVoice: v.elevenlabs.voiceId, xaiVoice: v.xai.voiceId, xaiLanguage: v.xai.language };
}

/**
 * The character file. Phase 127 (§16 Q8, a privacy fix): it never carries the owner's name (it
 * becomes {{user}}), his own words about the two of them, his hard limits or his stop word.
 */
export function exportCharacter(app: AppContext): CharacterFile {
  const files = app.look?.files() ?? {};
  return {
    format: CHARACTER_FORMAT,
    version: 1,
    exportedAt: app.now().toISOString(),
    persona: scrubPersona(app.persona, app.settings.get().ownerName).persona,
    voice: characterVoice(app),
    ...(Object.keys(files).length ? { look: Object.fromEntries(Object.entries(files).map(([k, b]) => [k, b.toString('base64')])) } : {}),
  };
}

const isPicture = (b: Buffer) =>
  b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) || b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP');

export interface ParsedCharacter {
  persona: Persona;
  voice?: CharacterVoice;
  look?: Record<string, Buffer>;
}

/** Checks a character file completely before anything is changed. Throws a plain-words error. */
export function parseCharacter(raw: unknown): ParsedCharacter {
  const f = raw as Partial<CharacterFile> | null;
  if (!f || typeof f !== 'object' || f.format !== CHARACTER_FORMAT) throw new Error("This isn't a Sara character file.");
  if (f.version !== 1) throw new Error('This character file is from a newer Sara: update this server first.');
  const persona = validatePersona(f.persona); // adult only, the same checks as the editor
  let look: Record<string, Buffer> | undefined;
  if (f.look !== undefined) {
    if (typeof f.look !== 'object' || !f.look) throw new Error('The look in this file is damaged.');
    look = {};
    for (const [rel, b64] of Object.entries(f.look)) {
      if (!LOOK_PATHS.includes(rel)) throw new Error(`Unexpected picture in the file: ${rel.slice(0, 80)}`);
      const b = Buffer.from(String(b64), 'base64');
      if (!b.length || b.length > MAX_PICTURE || !isPicture(b)) throw new Error(`A picture in the file is damaged (${rel}).`);
      look[rel] = b;
    }
    if (!look['sara-portrait.jpg']) throw new Error('The look in this file has no portrait.');
  }
  let voice: CharacterVoice | undefined;
  if (f.voice) {
    const v = f.voice;
    const s = (x: unknown, max = 100) => String(x ?? '').trim().slice(0, max);
    voice = {
      tts: (['off', 'local', 'openai', 'elevenlabs', 'xai'] as const).includes(v.tts) ? v.tts : 'local',
      localVoice: s(v.localVoice),
      speed: Math.min(1.6, Math.max(0.6, Number(v.speed) || 1)),
      openaiVoice: s(v.openaiVoice),
      elevenlabsVoice: s(v.elevenlabsVoice),
      xaiVoice: s(v.xaiVoice) || 'eve',
      xaiLanguage: s(v.xaiLanguage, 20) || 'en',
    };
  }
  return { persona, ...(voice ? { voice } : {}), ...(look ? { look } : {}) };
}

/** The voice settings after taking a character's voice choice (keys and addresses unchanged). */
export function withCharacterVoice(app: AppContext, v: CharacterVoice): VoiceSettings {
  const cur = voiceOf(app);
  const localOk = !v.localVoice || !app.voice || app.voice.voices().some((x: { id: string }) => x.id === v.localVoice);
  return {
    ...cur,
    tts: v.tts,
    localVoice: localOk && v.localVoice ? v.localVoice : cur.localVoice,
    speed: v.speed,
    openai: { ...cur.openai, ttsVoice: v.openaiVoice || cur.openai.ttsVoice },
    elevenlabs: { ...cur.elevenlabs, voiceId: v.elevenlabsVoice || cur.elevenlabs.voiceId },
    xai: { ...cur.xai, voiceId: v.xaiVoice, language: v.xaiLanguage },
  };
}
