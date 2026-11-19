// W1.4 (docs/PERSONA_STYLE.md): one personality drives her writing, voice and face. The source is the
// persona store she already has (persona.json in her space: per companion, per household member),
// plus the two choices that already live per person: her voice (settings.voice, a companion key) and
// the writing default (S11 writing_prefs). This file only RESOLVES them into one view; it stores
// nothing of its own. Every surface reads it:
//   chat / email drafts → humanize.ts writingNote (sign-off line)
//   Talk, voice notes   → speech.ts Speech.speak (voice id + speed)
//   briefing audio      → briefing-audio.ts briefingSpeaker
//   receptionist        → reception.ts greeting + tone line
//   her picture         → GET /api/persona/style → web (a device with no pick of its own)
import type { AppContext } from './chat.ts';
import { TALK } from './character.ts';
import { en } from './i18n.ts';
import { writingFor, type WritingStyle } from './humanize.ts';
import type { Persona } from './persona.ts';
import { DEFAULT_VOICE, type VoiceSettings } from './voice.ts';

export { cleanStyle, FACE_MODES, GREET_STYLES, SIGNOFF_MAX, type FaceMode, type GreetStyle, type PersonaStyleFile } from './persona-style-file.ts';
import { type FaceMode, type GreetStyle } from './persona-style-file.ts';

export interface HerVoice {
  tts: VoiceSettings['tts'];
  /** The voice id for the chosen engine ('' = the engine's default). */
  id: string;
  /** Her voice on this computer (used by local-only paths such as briefing audio). */
  local: string;
  speed: number;
}

/** Her voice choice (which engine, which voice, how fast): the per-person settings.voice. */
export function herVoice(app: Pick<AppContext, 'settings'>): HerVoice {
  const v = { ...DEFAULT_VOICE, ...(app.settings.get().voice ?? {}) } as VoiceSettings;
  const id = v.tts === 'local' ? v.localVoice : v.tts === 'openai' ? (v.openai?.ttsVoice ?? '') : v.tts === 'elevenlabs' ? (v.elevenlabs?.voiceId ?? '') : v.tts === 'xai' ? (v.xai?.voiceId ?? '') : '';
  const speed = Number.isFinite(v.speed) && v.speed > 0 ? v.speed : 1;
  return { tts: v.tts, id: id ?? '', local: v.localVoice ?? '', speed };
}

/** The default greeting style from how she talks (Starting point → How she talks). */
const TALK_GREET: Record<string, GreetStyle> = { texting: 'casual', thoughtful: 'warm', brief: 'brief' };

export interface PersonaStyle {
  name: string;
  /** Her text style rules (the first lines of "How they talk"). */
  textRules: string[];
  talk: string;
  voice: HerVoice;
  humanizer: WritingStyle;
  /** Whether the person made a "match my voice" card (S11). */
  voiceCard: boolean;
  /** How email drafts she writes for them end ('' = no fixed sign-off). */
  signOff: string;
  greet: GreetStyle;
  face: FaceMode;
  /** Where each default came from: 'set' (chosen here), 'talk' (how she talks) or 'default'. */
  source: { greet: 'set' | 'talk' | 'default' };
}

/** The one view every surface reads. */
export function personaStyle(app: Pick<AppContext, 'settings' | 'store' | 'persona'>): PersonaStyle {
  const p: Persona = app.persona;
  const st = p.style ?? {};
  let humanizer: WritingStyle = 'as-written';
  let voiceCard = false;
  try {
    const w = writingFor(app).get();
    humanizer = w.style;
    voiceCard = Boolean(w.card);
  } catch {
    /* a fixture without the writing table */
  }
  const fromTalk = p.talk ? TALK_GREET[p.talk] : undefined;
  return {
    name: p.name,
    textRules: (p.speech ?? []).slice(0, 4),
    talk: p.talk && TALK[p.talk] ? TALK[p.talk].label : '',
    voice: herVoice(app),
    humanizer,
    voiceCard,
    signOff: st.signOff ?? '',
    greet: st.greet ?? fromTalk ?? 'warm',
    face: st.face ?? '',
    source: { greet: st.greet ? 'set' : fromTalk ? 'talk' : 'default' },
  };
}

/** The receptionist's greeting, per style (translated keys; {name} = the business). */
const GREETINGS: Record<GreetStyle, string> = {
  warm: en('Hi! I can answer questions about {name}.'),
  casual: en('Hey! Ask me anything about {name}.'),
  brief: en('Hello. Questions about {name}?'),
  formal: en('Good day. I can answer your questions about {name}.'),
};
export const greetingKey = (g: GreetStyle): string => GREETINGS[g] ?? GREETINGS.warm;

/** One line for the receptionist's prompt (English: model-facing). */
const TONES: Record<GreetStyle, string> = {
  warm: 'Tone: warm and friendly.',
  casual: 'Tone: relaxed and casual, short sentences.',
  brief: 'Tone: brief and to the point.',
  formal: 'Tone: polite and formal.',
};
export const toneLine = (g: GreetStyle): string => TONES[g] ?? TONES.warm;

/** The email-draft line for her chat note ('' = no fixed sign-off). */
export function signOffNote(s: PersonaStyle): string {
  if (!s.signOff) return '';
  return `Email drafts you write for them end with this sign-off, then their name: "${s.signOff.replace(/\n/g, ' / ')}".`;
}

export interface StylePreview {
  chat: string;
  spoken: { text: string; voice: HerVoice };
  email: string;
  greeting: { key: string; params: { name: string }; then: string };
}

/** The same sentence as chat text, spoken voice, email line and receptionist greeting (no model call). */
export function previewOf(s: PersonaStyle, sentence: string, o: { owner?: string; business?: string } = {}): StylePreview {
  const text = String(sentence ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const sign = s.signOff ? `\n\n${s.signOff}${o.owner ? `\n${o.owner}` : ''}` : o.owner ? `\n\n${o.owner}` : '';
  return {
    chat: text,
    spoken: { text, voice: s.voice },
    email: `${text}${sign}`,
    greeting: { key: greetingKey(s.greet), params: { name: o.business || 'this business' }, then: text },
  };
}
