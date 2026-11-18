// U4.24 (docs/VOICE_FIRST.md): Talk with Sara, the voice-first mode. The page runs the turn loop
// (web/talk.js on top of the classic call in web/voice.js); the server keeps the person's talk prefs
// (Settings → Sara → Voice), tells her to answer in short spoken sentences on a talk turn, and answers
// a spoken yes/no through the same rule as car mode (voiceAnswer: money and passwords never by voice).

export interface TalkPrefs {
  /** A short "Mm-hm." / "One moment." while she is still quiet after you spoke. */
  fillers: boolean;
  /** A spoken yes/no may answer a waiting card (the card stays on screen; hard limits apply). */
  approveByVoice: boolean;
  /** Saying "goodbye" (alone) ends the talk. */
  goodbye: boolean;
  /** U5: minutes the local hearing and voice engines stay loaded after use (0 = load per call). Owner's setting, server-wide. */
  keepLoaded: number;
  /** V0.2: 'streaming' shows your words while you speak (the streaming hearing model); 'whole' hears each sentence when you stop. */
  hearing: 'whole' | 'streaming';
}

export const KEEP_LOADED = [0, 10, 30, 60] as const;
export const TALK_DEFAULTS: TalkPrefs = { fillers: true, approveByVoice: true, goodbye: true, keepLoaded: 10, hearing: 'whole' };

/** Saved prefs with the defaults; anything not a boolean falls back to the default (true). */
export function cleanTalk(v: unknown): TalkPrefs {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const b = (x: unknown, d: boolean) => (x === undefined ? d : x !== false);
  const keep = Number(o.keepLoaded);
  return {
    fillers: b(o.fillers, TALK_DEFAULTS.fillers),
    approveByVoice: b(o.approveByVoice, TALK_DEFAULTS.approveByVoice),
    goodbye: b(o.goodbye, TALK_DEFAULTS.goodbye),
    keepLoaded: o.keepLoaded !== undefined && o.keepLoaded !== '' && (KEEP_LOADED as readonly number[]).includes(keep) ? keep : TALK_DEFAULTS.keepLoaded,
    hearing: o.hearing === 'streaming' ? 'streaming' : 'whole',
  };
}

/** Her instruction on a talk turn: everything she writes is spoken right away, sentence by sentence. */
export function talkNote(owner: string): string {
  return `${owner} is talking with you out loud (Talk with Sara): everything you write is spoken sentence by sentence as it arrives. Start with a short first sentence, answer in a few short spoken sentences, with no lists, tables, markdown, links, emoji or code; put long material in a file or note and say so. If something needs ${owner}'s OK, the card is on screen and ${owner} may answer by saying yes or no, except for money or passwords, which always need a tap.`;
}
