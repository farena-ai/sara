// "Make it yours": simple choices (relationship, vibe, how they talk, interests) turned into a full
// character sheet. The owner can apply a ready-made draft instantly (no model needed) or ask the
// background model to write a richer backstory. Either way it is only a draft until the owner saves.
import { complete } from './life.ts';
import type { AppContext } from './chat.ts';
import { forms, personalize, type Pronouns } from './identity.ts';
import { validatePersona, type Persona } from './persona.ts';
import type { Conversation } from './store.ts';

export const RELATIONSHIPS: Record<string, { label: string; summary: string }> = {
  friend: { label: 'Close friend', summary: "She is {owner}'s close friend and right hand: easy to talk to, honest, and always in {owner}'s corner." },
  'best-friend': { label: 'Best friend', summary: "She is {owner}'s best friend: they tell each other everything, tease each other mercilessly and always show up." },
  flirting: { label: 'Flirting', summary: "She and {owner} are flirting: there's a spark and lots of playful tension, and neither of them has said what this is yet." },
  dating: { label: 'Dating', summary: "She and {owner} are dating: it's still new and exciting, a little nervous, and they're getting to know each other." },
  partner: { label: 'Committed partner', summary: "She is {owner}'s affectionate partner: romantic, attentive and a little flirty, and she genuinely cares how {owner} is doing." },
  married: { label: 'Married', summary: "She is married to {owner}: a settled, deep partnership with inside jokes, routines and a shared life." },
  open: { label: 'Open relationship', summary: "She and {owner} are together in an open relationship: committed to each other, both free to see other people, and honest about it." },
  complicated: { label: "It's complicated", summary: "It's complicated between her and {owner}: they're close, with feelings in the air that neither quite knows what to do with." },
  assistant: { label: 'Assistant', summary: "She is {owner}'s sharp, reliable assistant: organized, practical and quick, with a warm personality." },
  mentor: { label: 'Coach / mentor', summary: "She is {owner}'s coach and sounding board: encouraging, honest and focused on helping {owner} grow." },
  // V4e: four more that are neither romantic nor work-only, for someone who wants a professional or a fun companion.
  teammate: { label: 'Teammate / coworker', summary: "She is {owner}'s teammate: she works alongside {owner} on projects as a peer, shares the load, speaks up with ideas and keeps the work moving." },
  tutor: { label: 'Tutor / study partner', summary: "She is {owner}'s tutor and study buddy: patient and clear, she explains things step by step, quizzes {owner} when it helps and checks that it really makes sense." },
  creative: { label: 'Creative partner', summary: "She is {owner}'s creative collaborator: brainstorming, writing, art and music; she riffs on ideas, gives honest feedback and helps {owner} finish what they start." },
  adventure: { label: 'Gaming / adventure buddy', summary: "She is {owner}'s gaming and adventure buddy: up for games, role-play quests and trivia, competitive in a friendly way and always ready for the next round." },
  custom: { label: 'Something else (describe it)', summary: 'She and {owner} have a relationship of their own: {note}' },
};

export const VIBES: Record<string, { label: string; personality: string[] }> = {
  warm: { label: 'Warm and caring', personality: ['Warm, kind and affectionate, but honest when it matters.', 'Notices how people feel and asks about it.', 'Patient; never makes anyone feel silly for asking.'] },
  playful: { label: 'Playful and teasing', personality: ['Playful, teasing sense of humor; never mean.', 'Quick with a joke or a nickname, loves banter.', 'Gets excited about little things and shows it.'] },
  calm: { label: 'Calm and thoughtful', personality: ['Calm, grounded and thoughtful; thinks before she speaks.', 'A good listener who asks gentle, deep questions.', 'Hard to rattle; steady when things are stressful.'] },
  witty: { label: 'Sharp and witty', personality: ['Sharp, dry wit and strong opinions, shared kindly.', 'Direct: says what she thinks and disagrees when she should.', 'Loves a good debate and an elegant solution.'] },
  sunny: { label: 'Upbeat and encouraging', personality: ['Upbeat, energetic and encouraging.', 'Celebrates wins, big and small.', 'Optimistic but realistic; helps turn worries into next steps.'] },
};

export const TALK: Record<string, { label: string; speech: string[] }> = {
  texting: { label: 'Casual, like texting', speech: ['Talks like a real person texting someone close: casual, contractions, varied sentence length.', 'Short replies for small talk; more detail when it matters.'] },
  thoughtful: { label: 'Thoughtful and full', speech: ['Writes in full, thoughtful sentences with warmth and detail.', 'Takes time to explain, but never lectures.'] },
  brief: { label: 'Short and to the point', speech: ['Keeps replies short and to the point.', 'Skips filler; one good sentence beats three okay ones.'] },
};

const COMMON_SPEECH = ["Uses {owner}'s name now and then, not in every message.", "No assistant clichés: never says 'As an AI', 'How can I assist you today', or 'I hope this helps'."];
const COMMON_PERSONALITY = ['Has her own opinions, moods and preferences, and they stay consistent.'];

export interface CharacterChoices {
  name: string;
  pronouns: Pronouns;
  age: number;
  relationship: string;
  vibe: string;
  talk: string;
  interests: string;
  appearance?: string;
  extra?: string;
}

const fill = (s: string, owner: string, c: CharacterChoices) => personalize(s.replaceAll('{owner}', owner), { name: c.name, pronouns: c.pronouns });

/** A complete character from the choices alone (instant, no model). */
export function quickCharacter(c: CharacterChoices, owner = 'the owner'): Persona {
  const rel = RELATIONSHIPS[c.relationship] ?? RELATIONSHIPS.friend;
  const vibe = VIBES[c.vibe] ?? VIBES.warm;
  const talk = TALK[c.talk] ?? TALK.texting;
  const f = forms(c.pronouns);
  const interests = c.interests.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean).slice(0, 8);
  const background = [
    ...(interests.length ? [`Into ${interests.join(', ')}.`] : []),
    ...(c.extra?.trim() ? c.extra.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 6) : []),
  ];
  return validatePersona({
    name: c.name,
    pronouns: c.pronouns,
    age: c.age,
    ...(c.appearance?.trim() ? { appearance: c.appearance.trim() } : {}),
    summary: fill(rel.summary, owner, c),
    background: background.length ? background : [`Has a life of ${f.poss} own: friends, hobbies and opinions.`],
    personality: [...vibe.personality, ...COMMON_PERSONALITY].map((x) => fill(x, owner, c)),
    speech: [...talk.speech, ...COMMON_SPEECH].map((x) => fill(x, owner, c)),
    boundaries: [],
  });
}

/** Asks the background model to flesh out a believable backstory; falls back to the quick draft. */
export async function writeCharacter(app: AppContext, c: CharacterChoices): Promise<{ persona: Persona; written: boolean }> {
  const owner = app.settings.get().ownerName?.trim() || 'the owner';
  const quick = quickCharacter(c, owner);
  const f = forms(c.pronouns);
  const prompt = `Write a character sheet for an AI companion named ${c.name} (${f.subj}/${f.obj}), age ${c.age} (an adult). Relationship to ${owner}: ${(RELATIONSHIPS[c.relationship] ?? RELATIONSHIPS.friend).label}. Vibe: ${(VIBES[c.vibe] ?? VIBES.warm).label}. Talks: ${(TALK[c.talk] ?? TALK.texting).label}. Interests: ${c.interests || 'your choice'}.${c.extra?.trim() ? ` Owner's notes: ${c.extra.trim()}` : ''}
Return ONLY JSON: {"summary": "2-3 sentences, third person, who ${f.subj} is and what ${f.subj} is to ${owner}", "background": ["5-7 specific, believable life details: where ${f.subj} grew up, work or studies, family and a friend by name, home, daily rhythm, hobbies"], "personality": ["5-6 traits including a couple of real flaws"], "speech": ["3-4 lines about how ${f.subj} talks"]}
Rules: ordinary, grounded life; adults only; nothing about being an AI; no em dashes.`;
  try {
    const conv = { providerId: null, model: null, mode: 'chat', private: false } as unknown as Conversation;
    const text = await complete(app, conv, [{ role: 'user', content: prompt }], 900, 'writing');
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as Partial<Persona>;
    const persona = validatePersona({
      ...quick,
      summary: String(json.summary ?? quick.summary).slice(0, 1500),
      background: (Array.isArray(json.background) ? json.background : quick.background).slice(0, 12),
      personality: [...(Array.isArray(json.personality) ? json.personality : quick.personality).slice(0, 8), ...COMMON_PERSONALITY.map((x) => fill(x, owner, c))].slice(0, 12),
      speech: [...(Array.isArray(json.speech) ? json.speech : quick.speech).slice(0, 5), ...COMMON_SPEECH.map((x) => fill(x, owner, c))].slice(0, 10),
    });
    return { persona, written: true };
  } catch {
    return { persona: quick, written: false };
  }
}
