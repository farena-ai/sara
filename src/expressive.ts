// Phase 37: her voice with feeling. Grok voice understands speech tags: inline ones like [laugh] or
// [sigh] and wrapping ones like <whisper>…</whisper>. Her written replies never contain them: the tags
// are added only to the words sent to Grok voice, from cues already in what she wrote ("haha",
// "*sighs*", "…", "*whispers*") and from her mood (softer when you're down). Other voices get
// the same words with the stage directions taken out. Tags are never shown or saved.

export type Expressive = 'off' | 'subtle' | 'lively';
export type VoiceTone = 'natural' | 'warm' | 'bright' | 'calm';

/** Grok voice's speech tags we use. */
export const INLINE_TAGS = ['laugh', 'chuckle', 'sigh', 'breath', 'pause'] as const;
export const WRAP_TAGS = ['whisper', 'soft', 'laugh-speak'] as const;

const INLINE_RE = new RegExp(`\\[(?:${INLINE_TAGS.join('|')}|long-pause|giggle|exhale|inhale|cough|gasp)\\]`, 'gi');
const WRAP_RE = new RegExp(`</?(?:${WRAP_TAGS.join('|')}|emphasis|sing|slow|fast|loud|quiet)>`, 'gi');

/** ElevenLabs v3 audio tags we may send (bracketed words). */
const EL_RE = /\[(?:laughs|sighs|exhales|whispers|softly)\]/gi;

/** Removes any speech tags (for captions, transcripts and saved text). */
export function stripTags(text: string): string {
  return text.replace(INLINE_RE, '').replace(WRAP_RE, '').replace(EL_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?…])/g, '$1').trim();
}

/**
 * R2d: which of our tags each voice engine documents. Grok voice: xAI's /v1/tts tag list
 * (docs.x.ai → Text to Speech → Speech tags). ElevenLabs Eleven v3/v4 audio tags (elevenlabs.io →
 * Best practices → Audio tags): our tag → their word; chuckle and pause have no documented tag.
 * OpenAI speech takes delivery instructions, not tags; the local Kokoro/Piper voices read tags as
 * words. Engines without an entry get plain words.
 */
export interface EngineTags { inline: Record<string, string>; wrap: Record<string, string> }
const XAI_TAGS: EngineTags = {
  inline: { laugh: '[laugh]', chuckle: '[chuckle]', sigh: '[sigh]', breath: '[breath]', pause: '[pause]' },
  wrap: { whisper: '<whisper>', soft: '<soft>' },
};
const ELEVEN_V3_TAGS: EngineTags = {
  inline: { laugh: '[laughs]', sigh: '[sighs]', breath: '[exhales]' },
  wrap: { whisper: '[whispers]', soft: '[softly]' },
};

export function engineTags(tts: string, model = ''): EngineTags | undefined {
  if (tts === 'xai') return XAI_TAGS;
  if (tts === 'elevenlabs' && /^eleven_v[34]\b/.test(model)) return ELEVEN_V3_TAGS;
  return undefined;
}

/** Tagged text (from addTags) made right for one engine: its own tags kept or renamed, the rest dropped. */
export function forEngine(text: string, tts: string, model = ''): string {
  const tags = engineTags(tts, model);
  let t = text.replace(/\[([a-z-]+)\]/gi, (_m, name: string) => (tags?.inline[name.toLowerCase()] ? ` ${tags.inline[name.toLowerCase()]} ` : ' '));
  t = t.replace(/<(\/?)([a-z-]+)>/gi, (_m, close: string, name: string) => {
    const tag = tags?.wrap[name.toLowerCase()];
    if (!tag) return ' ';
    if (tag.startsWith('[')) return close ? ' ' : ` ${tag} `; // ElevenLabs: a lead-in tag, no closing one
    return close ? `</${tag.slice(1)}` : tag;
  });
  return t.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.!?…])/g, '$1').replace(/(<\w[\w-]*>) /g, '$1').replace(/ (<\/)/g, '$1').trim();
}

/** Stage directions she may write: *laughs*, (sighs), *whispers* … */
const ACTION = /(?:\*|\()\s*(laughs?|laughing|giggles?|giggling|chuckles?|chuckling|sighs?|sighing|whispers?|whispering|smiles?|grins?|winks?|blushes|blushing|pauses?|takes a (?:deep )?breath|breathes? (?:in|out))\s*[^*)]{0,40}?(?:\*|\))/gi;

/** For voices without tags: drop stage directions so she doesn't read "asterisk sighs" aloud. */
export function plainSpeech(text: string): string {
  return text.replace(ACTION, ' ').replace(/[ \t]{2,}/g, ' ').trim();
}

export interface MoodHint {
  /** Owner seems down: speak softer and a little slower. */
  soft?: boolean;
  /** Late at night / she's sleepy. */
  sleepy?: boolean;
  /** She's happy. */
  bright?: boolean;
}

/**
 * The text for Grok voice with tags added (call before markdown cleanup is fine: only plain
 * words and the cues matter). `level` subtle = only clear cues; lively = more of them.
 */
export function addTags(text: string, level: Expressive, mood: MoodHint = {}, tone: VoiceTone = 'natural'): string {
  if (level === 'off') return plainSpeech(text);
  let t = text;
  // Stage directions become the matching sound (or wrap what follows, for whispers).
  t = t.replace(/(?:\*|\()\s*whisper(?:s|ing)?[^*)]{0,40}?(?:\*|\))\s*([^.!?…]+[.!?…]*)/gi, (_m, said: string) => `<whisper>${said.trim()}</whisper> `);
  t = t.replace(ACTION, (m) => {
    const w = m.toLowerCase();
    if (/laugh|giggl/.test(w)) return level === 'lively' ? ' [laugh] ' : ' [chuckle] ';
    if (/chuckl|grin|smile|wink/.test(w)) return level === 'lively' ? ' [chuckle] ' : ' ';
    if (/sigh/.test(w)) return ' [sigh] ';
    if (/breath|breathe/.test(w)) return ' [breath] ';
    if (/pause/.test(w)) return ' [pause] ';
    return ' ';
  });
  // Written laughter.
  t = t.replace(/\b(?:ha){2,}h?\b|\bahaha+\b|\blol\b|\blmao\b/gi, level === 'lively' ? '[laugh]' : '[chuckle]');
  t = t.replace(/\bhehe+\b/gi, '[chuckle]');
  // Sighs and relief.
  t = t.replace(/^\s*(ugh|sigh|phew)\b[,.!]*\s*/i, (_m, w: string) => (w.toLowerCase() === 'phew' ? '[breath] Phew, ' : '[sigh] '));
  if (level === 'lively') {
    // A thoughtful beat for a mid-sentence ellipsis; a breath before a long confession.
    t = t.replace(/(\S)\s*(?:\.\.\.|…)\s+(?=\S)/g, '$1 [pause] ');
    t = t.replace(/^(honestly|okay so|so,? um|well),?\s+/i, (m) => `[breath] ${m}`);
  }
  t = t.replace(/[ \t]{2,}/g, ' ').trim();
  // Mood and tone: softer when the owner is down, or when her voice is set to warm/calm.
  const soft = mood.soft || mood.sleepy || tone === 'warm' || tone === 'calm';
  if (soft && !/^<\w/.test(t)) t = `<soft>${t}</soft>`;
  return t;
}

/** Speed adjusted for mood and tone, kept within Grok's range. */
export function moodSpeed(speed: number, mood: MoodHint = {}, tone: VoiceTone = 'natural'): number {
  let s = speed;
  if (mood.soft) s *= 0.95;
  if (mood.sleepy) s *= 0.94;
  if (mood.bright) s *= 1.03;
  if (tone === 'calm') s *= 0.96;
  if (tone === 'bright') s *= 1.04;
  return Math.round(Math.min(1.5, Math.max(0.7, s)) * 100) / 100;
}

/** OpenAI's speech model takes plain instructions about delivery. */
export function toneInstructions(mood: MoodHint, tone: VoiceTone, level: Expressive): string | undefined {
  const parts: string[] = [];
  if (tone === 'warm') parts.push('Speak warmly and gently.');
  if (tone === 'bright') parts.push('Speak brightly, with energy.');
  if (tone === 'calm') parts.push('Speak calmly and slowly.');
  if (mood.soft) parts.push('The listener is having a hard time: soft, caring and unhurried.');
  else if (mood.sleepy) parts.push('It is late: relaxed and a little sleepy.');
  else if (mood.bright) parts.push('You are in a good mood.');
  if (level === 'lively') parts.push('Expressive and natural, like talking to someone close.');
  return parts.length ? parts.join(' ') : undefined;
}

/** The sample for Settings → Voice. */
export const EXPRESSIVE_SAMPLE = "Haha, okay, that's actually really funny. *sighs* Honestly… I needed that today. *whispers* Don't tell anyone, but I missed you.";
