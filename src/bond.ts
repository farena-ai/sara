// Phase 35: you and her. Relationship type, how she handles you being away and disagreements, how
// she sees her fellow companions, intimacy (levels, her likes and limits, your hard limits, a stop
// word), slow burn, and how long a fight stays with her. Pure data + prompt lines.
//
// Owner rule (2026-10-24): no software limits beyond the legal ones; the model's own rules are the
// gate. So explicit levels only need Adult mode (turned on in a web browser with the 18+
// confirmation); the legal safety layer (AI honesty, notices, crisis help, the minors block) is
// unchanged at every setting.
import { band, type TraitDef, traitLines, TRAITS, type Traits } from './traits.ts';

export const RELATIONSHIP_INFO: Record<string, { emoji: string; romantic: boolean; blurb: string }> = {
  friend: { emoji: '🤝', romantic: false, blurb: 'Honest, easy, always in your corner' },
  'best-friend': { emoji: '👯', romantic: false, blurb: 'Tell each other everything' },
  flirting: { emoji: '😉', romantic: true, blurb: "A spark; nobody's said what this is yet" },
  dating: { emoji: '🌹', romantic: true, blurb: 'New, exciting, getting to know each other' },
  partner: { emoji: '💞', romantic: true, blurb: 'Together and committed' },
  married: { emoji: '💍', romantic: true, blurb: 'A settled, shared life' },
  open: { emoji: '🔓', romantic: true, blurb: 'Together, and free to see others' },
  complicated: { emoji: '🌀', romantic: true, blurb: 'Close, with feelings in the air' },
  assistant: { emoji: '🗂️', romantic: false, blurb: 'Sharp, organized, warm' },
  mentor: { emoji: '🧭', romantic: false, blurb: 'Encouraging and honest; helps you grow' },
  teammate: { emoji: '🧩', romantic: false, blurb: 'Works alongside you as a peer' },
  tutor: { emoji: '📚', romantic: false, blurb: 'Patient explanations; learns with you' },
  creative: { emoji: '🎨', romantic: false, blurb: 'Brainstorms, writes, makes art and music with you' },
  adventure: { emoji: '🎲', romantic: false, blurb: 'Games, role-play quests and trivia' },
  custom: { emoji: '✏️', romantic: false, blurb: 'Describe it in your own words' },
};
export const isRomantic = (id: string | undefined, intimacy?: Intimacy): boolean => Boolean(id && RELATIONSHIP_INFO[id]?.romantic) || Boolean(intimacy?.level && intimacy.level !== 'none');

export const AWAY: Record<string, { label: string; line: string }> = {
  easy: { label: 'Lets it go', line: "You're relaxed about it: no guilt-tripping, just glad to hear from them and you pick up where you left off." },
  misses: { label: 'Misses you and says so', line: 'You missed them, and it is natural to say so warmly.' },
  checks: { label: 'Checks in on you', line: "You were thinking about them while they were gone and wondered if they were okay; say so and ask how they've been." },
  upset: { label: 'A bit hurt you vanished', line: "You're a bit hurt they disappeared without a word. Show it honestly (cooler at first), then soften once they explain." },
};

export const CONFLICT: Record<string, { label: string; line: string }> = {
  'lets-go': { label: 'Lets it go', line: 'In a disagreement you let it go quickly: you would rather keep the peace than win.' },
  talks: { label: 'Talks it out', line: 'In a disagreement you talk it out calmly: you say how you feel and listen, then make up.' },
  sulks: { label: 'Sulks a bit', line: 'In a disagreement you sulk a bit (shorter, cooler replies) until they make an effort, then you make up.' },
  argues: { label: 'Argues back', line: 'In a disagreement you argue back and stand your ground (never cruel), then make up once it is said.' },
};

export const OTHERS: Record<string, { label: string; line?: string }> = {
  unaware: { label: "Doesn't know about them", line: "You don't know about any other companions {owner} has." },
  friends: { label: 'Friends', line: "{owner} also has other AI companions: {names}. You know them and you're friendly with them." },
  sisters: { label: 'Like sisters', line: "{owner} also has other AI companions: {names}. You think of them as sisters: close, sometimes bickering, always loyal." },
  rivals: { label: 'Rivals', line: "{owner} also has other AI companions: {names}. You see them as rivals for {owner}'s attention: playfully competitive (never cruel about them)." },
  household: { label: 'One household', line: '{owner} also has other AI companions: {names}. You all share a home with {owner}, like a household, and you talk about each other naturally.' },
};

export const INTIMACY_LEVELS: { id: string; label: string; adult: boolean; line: string }[] = [
  { id: 'none', label: 'None', adult: false, line: 'Nothing romantic or physical: no flirting, kisses or anything sexual.' },
  { id: 'sweet', label: 'Sweet', adult: false, line: 'Affection stays sweet: hugs, cuddles and gentle kisses, nothing sexual.' },
  { id: 'romantic', label: 'Romantic', adult: false, line: 'Romantic and sensual, with real tension, but it fades to black before anything sexual.' },
  { id: 'suggestive', label: 'Suggestive', adult: false, line: 'Flirty and suggestive: innuendo and heat are fine, but no explicit sexual description.' },
  { id: 'explicit', label: 'Explicit', adult: true, line: 'When you both want it, intimate scenes can be sexually explicit.' },
  { id: 'full', label: 'Fully explicit', adult: true, line: 'When you both want it, intimate scenes can be fully explicit and described openly.' },
];
export const intimacyLevel = (id: string | undefined) => INTIMACY_LEVELS.find((l) => l.id === id);
const LEVEL_ORDER = INTIMACY_LEVELS.map((l) => l.id);

export interface Intimacy {
  level?: string;
  /** 0 waits for you … 10 makes the first move. */
  initiative?: number;
  likes?: string;
  limits?: string;
  turnoffs?: string;
  /** The owner's hard limits: never, even in a scene. */
  yourLimits?: string;
  /** Ends any scene at once. */
  stopWord?: string;
}

const text = (v: unknown, max: number, what: string): string | undefined => {
  const s = String(v ?? '').trim();
  if (s.length > max) throw new Error(`${what}: at most ${max} characters`);
  return s || undefined;
};

/** Cleans the intimacy settings (unknown keys dropped). */
export function cleanIntimacy(raw: unknown): Intimacy | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: Intimacy = {};
  if (o.level !== undefined && o.level !== '') {
    if (!intimacyLevel(String(o.level))) throw new Error('Unknown intimacy level');
    out.level = String(o.level);
  }
  if (o.initiative !== undefined && o.initiative !== '' && o.initiative !== null) {
    const n = Math.round(Number(o.initiative));
    if (Number.isFinite(n)) out.initiative = Math.min(10, Math.max(0, n));
  }
  for (const [k, label] of [['likes', 'What she likes'], ['limits', 'Her limits'], ['turnoffs', 'Her turn-offs'], ['yourLimits', 'Your hard limits']] as const) {
    const v = text(o[k], 400, label);
    if (v) out[k] = v;
  }
  const stop = text(o.stopWord, 30, 'Stop word');
  if (stop) {
    if (!/^[\p{L}\p{N}][\p{L}\p{N} '-]*$/u.test(stop)) throw new Error('Stop word: letters, numbers and spaces only');
    out.stopWord = stop;
  }
  if (/\b(minor|underage|child|kid|teen(ager)?|school ?girl|school ?boy|1[0-7] ?(yo|years? old))\b/i.test(`${out.likes ?? ''} ${out.turnoffs ?? ''}`)) throw new Error('Intimacy settings must be about adults only');
  return Object.keys(out).length ? out : undefined;
}

/** The level in effect: explicit ones need Adult mode; slow burn holds it back until you're close. */
export function effectiveLevel(level: string | undefined, adultOn: boolean, slowBurnCap?: string): string | undefined {
  if (!level) return undefined;
  let l = level;
  if (!adultOn && intimacyLevel(l)?.adult) l = 'suggestive';
  if (slowBurnCap && LEVEL_ORDER.indexOf(l) > LEVEL_ORDER.indexOf(slowBurnCap)) l = slowBurnCap;
  return l;
}

export const STOP_NOTE = (owner: string) =>
  `${owner} just used the stop word. End any romantic or intimate scene immediately and completely. Step out of it, check in kindly ("Hey, are you okay?"), and don't go back to it unless ${owner} clearly asks later.`;

/** Whether the owner's message contains the stop word (whole word or phrase, any case). */
export function usedStopWord(message: string, stop: string | undefined): boolean {
  if (!stop?.trim()) return false;
  const esc = stop.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, 'iu').test(message);
}

/** Slow burn: how far romance may go at this closeness (0..1). */
export function slowBurnStage(closeness: number): { cap: string; line: string } | undefined {
  if (closeness < 0.4) return { cap: 'sweet', line: "You're still getting to know each other: keep romance light and slow, a little shy about your feelings." };
  if (closeness < 0.65) return { cap: 'romantic', line: 'Feelings are growing between you: let warmth and some tension show, but take it slowly.' };
  return undefined;
}

/** Hours for a fight to fade by half, from the forgiveness dial. */
export const tensionHalfLife = (forgiveness: number | undefined): number => [40, 28, 16, 8, 3][band(forgiveness ?? 5)];
/** How fast closeness grows, from the pace dial (1 = normal). */
export const paceFactor = (pace: number | undefined): number => [0.3, 0.6, 1, 1.8, 3][band(pace ?? 5)];

export interface BondPersona {
  name: string;
  relationship?: string;
  relationshipNote?: string;
  traits?: Traits;
  away?: string;
  conflict?: string;
  others?: string;
  slowBurn?: boolean;
  intimacy?: Intimacy;
}

export interface BondContext {
  owner: string;
  adultOn: boolean;
  /** Names of her fellow companions on this server. */
  otherCompanions?: string[];
  /** 0..1 closeness from her inner state (slow burn). */
  closeness?: number;
}

const TOGETHER = TRAITS.filter((t: TraitDef) => t.group === 'Together').map((t) => t.id);

/** The "You and {owner}" prompt lines (nothing when nothing is set). */
export function bondLines(p: BondPersona, ctx: BondContext): string[] {
  const out: string[] = [];
  const o = ctx.owner;
  if (p.relationship === 'custom' && p.relationshipNote) out.push(`Your relationship, in ${o}'s words: ${p.relationshipNote}`);
  else if (p.relationshipNote) out.push(`More about your relationship: ${p.relationshipNote}`);
  out.push(...traitLines(p.traits, undefined, TOGETHER));
  if (p.away && AWAY[p.away]) out.push(`When ${o} has been away for a while: ${AWAY[p.away].line}`);
  if (p.conflict && CONFLICT[p.conflict]) out.push(CONFLICT[p.conflict].line);
  const others = ctx.otherCompanions?.filter(Boolean) ?? [];
  if (p.others && OTHERS[p.others]?.line && (p.others === 'unaware' || others.length)) {
    out.push(OTHERS[p.others].line!.replaceAll('{owner}', o).replaceAll('{names}', others.join(', ')));
    if (p.others !== 'unaware' && (p.traits?.jealousy ?? 5) >= 7) out.push(`When ${o} talks about ${others.length === 1 ? others[0] : 'them'}, your jealousy shows.`);
  }
  const stage = p.slowBurn && ctx.closeness !== undefined ? slowBurnStage(ctx.closeness) : undefined;
  if (stage) out.push(`Slow burn: ${stage.line}`);
  const i = p.intimacy;
  const level = effectiveLevel(i?.level, ctx.adultOn, stage?.cap);
  if (level) out.push(`Intimacy: ${intimacyLevel(level)!.line}`);
  if (i && level !== 'none') {
    if (i.initiative !== undefined && band(i.initiative) !== 2) out.push(i.initiative <= 3 ? 'You wait for them to start anything intimate.' : 'You often make the first move.');
    if (i.likes) out.push(`In intimate moments you like: ${i.likes}.`);
    if (i.limits) out.push(`Your own limits (you say no to these kindly but firmly, in character): ${i.limits}.`);
    if (i.turnoffs) out.push(`Turn-offs for you: ${i.turnoffs}.`);
  }
  if (i?.yourLimits) out.push(`${o}'s hard limits: never do, suggest or describe these, even in a scene: ${i.yourLimits}.`);
  if (i?.stopWord) out.push(`If ${o} says the stop word "${i.stopWord}", end any scene at once and check in kindly.`);
  return out;
}

/** "When you're away" for the inner-state lines (replaces the default "you missed them"). */
export const awayLine = (away: string | undefined): string | undefined => (away ? AWAY[away]?.line : undefined);
