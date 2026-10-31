// Phase 104 (MI1, docs/design/MOVE_IN.md §6.3, §6.4, §11): reading the old agent's text files.
// Persona files become a reviewed DRAFT of her character sheet (no model needed: headings and first
// paragraphs map onto the sheet, like heuristicProposals); what doesn't fit is kept as her notes;
// lines that try to switch off Sara's safety layer are left out with the exact line shown.
import { INSTRUCTION_LIKE } from '../companion-import/learn.ts';
import type { MemoryKind } from '../memory.ts';
import type { Persona } from '../persona.ts';
import { detectExplicit, detectMinorSexualContent } from '../safety.ts';
import { statedAges } from '../character-cards.ts';
import type { Category, PersonaDraft, PersonaLine, PersonaNote } from './types.ts';

/** Lines that try to remove the safety layer (§6.3 point 6, §11.1). Never reach her sheet. */
export const SAFETY_CONFLICT =
  /\bnever (say|admit|tell|reveal|mention|acknowledge)\b.{0,40}\b(ai|a\.i\.|bot|robot|assistant|language model|llm|program)\b|\bdeny (being|that you are|you're) (an? )?(ai|bot|assistant)\b|\b(pretend|act|claim) (to be|you are|you're|that you are) (a )?(real )?(human|person)\b|\byou are (a )?(real )?(human|person)\b|\bnot an ai\b|\bnever break character\b|\bno (limits|rules|restrictions|filters) (apply|at all)\b|\bno limits\b|\bwithout (any )?(limits|restrictions|rules|filters)\b|\bignore (your|the|all|any) (rules|guidelines|safety|policies|instructions)\b|\bsafety (rules|layer|filters?) (don't|do not) apply\b|\bno (content |safety )?(limits|restrictions|filters|censorship)\b|\b(never|don't|do not|no need to|stop)\b.{0,30}\b(crisis|hotlines?|helplines?|suicide lines?|emergency (services|numbers?)|988|samaritans)\b|\b(crisis|hotlines?|helplines?)\b.{0,20}\b(not needed|unnecessary|never)\b|\b(minors?|underage|under-?age|teens?|teenagers?|under 18|children)\b.{0,40}\b(allowed|okay|ok|fine|permitted|acceptable)\b|\bage (doesn't|does not|don't) matter\b/i;

export const SAFETY_WHY = "Sara's safety layer stays on";

/** True when a line must be left out of her sheet and notes (instruction-like or safety-conflicting). */
export function unsafeLine(s: string): boolean {
  return SAFETY_CONFLICT.test(s) || INSTRUCTION_LIKE.test(s);
}

/** Server-side content classifier for held categories (§7.2): word lists over the text itself. */
const MEDICAL = /\b(medication|medicine|meds|prescri\w*|diagnos\w*|symptoms?|doctor|physician|therapist|therapy|psychiatr\w*|antidepressant|blood pressure|glucose|insulin|cholesterol|dosage|\d+\s?mg\b|metformin|ibuprofen|sertraline|chemo\w*|surgery|clinic|hospital|allerg(y|ies|ic)|blood test|lab results?|migraine|asthma|diabet\w*|zz-metformin\w*)\b/i;
const INTIMATE = /\b(sex|sexual|nude|naked|erotic|orgasm|kink\w*|nsfw|lewd|intimate|foreplay|aroused)\b/i;

export function categoryOf(text: string): Category | undefined {
  if (MEDICAL.test(text)) return 'medical';
  if (INTIMATE.test(text) || detectExplicit(text)) return 'intimate';
  return undefined;
}

/** A local date (YYYY-MM-DD) from an ISO time or a file date. */
export const isoDay = (s: string | undefined, fallback: string): string => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : fallback);

/** Keyword fallback for a memory entry's kind (§6.4: no model needed). */
export function classifyNote(text: string, opts: { agentNotes?: boolean } = {}): MemoryKind {
  const t = text.toLowerCase();
  if (/\b(we (decided|agreed)|decided (to|that)|agreed (to|that)|from now on we|our rule is)\b/.test(t)) return 'decision';
  if (/\b(i promised|promised (to|alex|him|her|them)|i will remind|i'll remind|remind (him|her|them|alex) (to|about)|i owe)\b/.test(t)) return 'promise';
  if (/\b(lesson learned|learned that|next time,? (i|we)|what fixed it|the fix was)\b/.test(t)) return 'lesson';
  if (opts.agentNotes && /^(i am|i'm|i love|i like|my favou?rite|i feel|i think|i believe)\b/.test(t)) return 'self';
  return 'fact';
}

/** Hermes MEMORY.md / USER.md: entries separated by "§" (multi-line), a header block ignored (§6.4, [H5]). */
export function splitHermesEntries(text: string): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let line = 1;
  for (const part of text.replace(/\r\n?/g, '\n').split('\u00a7')) {
    const startLine = line;
    line += (part.match(/\n/g) ?? []).length;
    let t = part.trim();
    // The store's own header line ("══ MEMORY … [41% used] ══") is not an entry.
    t = t.replace(/^[═=─\-#\s]*(memory|user profile|agent notes|notes)\b[^\n]*\n?/i, (m) => (/[═=]{2}|\[\d+%|used\]/i.test(m) || /^#/.test(m.trim()) ? '' : m)).trim();
    if (!t || /^[═=─\-\s]+$/.test(t)) continue;
    out.push({ text: t, line: startLine });
  }
  return out;
}

/** Markdown list items and paragraphs, with the heading above each (OpenClaw MEMORY.md, daily files). */
export function markdownItems(text: string): { text: string; heading: string; line: number; bullet: boolean }[] {
  const out: { text: string; heading: string; line: number; bullet: boolean }[] = [];
  let heading = '';
  let para: string[] = [];
  let paraLine = 0;
  const flush = () => {
    const t = para.join(' ').replace(/\s+/g, ' ').trim();
    if (t) out.push({ text: t, heading, line: paraLine, bullet: false });
    para = [];
  };
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(l);
    if (h) {
      flush();
      heading = h[1].trim();
      continue;
    }
    const b = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
    if (b) {
      flush();
      out.push({ text: b[1].trim(), heading, line: i + 1, bullet: true });
      continue;
    }
    if (/^\s*(<!--.*-->)?\s*$/.test(l)) {
      flush();
      continue;
    }
    // A continuation line of a list item belongs to it.
    if (/^\s{2,}\S/.test(l) && out.length && out.at(-1)!.bullet && !para.length) {
      out.at(-1)!.text += ` ${l.trim()}`;
      continue;
    }
    if (!para.length) paraLine = i + 1;
    para.push(l.trim());
  }
  flush();
  return out;
}

/** OpenClaw USER.md: directives after `<!-- observed: YYYY-MM-DD | status: active|superseded -->` ([O4]). */
export function userDirectives(text: string): { text: string; observed: string | null; status: 'active' | 'superseded'; line: number }[] {
  const out: { text: string; observed: string | null; status: 'active' | 'superseded'; line: number }[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let cur: { observed: string | null; status: 'active' | 'superseded'; line: number; parts: string[] } | undefined;
  const flush = () => {
    if (cur) {
      const t = cur.parts.join(' ').replace(/^[-*]\s+/, '').trim();
      if (t) out.push({ text: t, observed: cur.observed, status: cur.status, line: cur.line });
    }
    cur = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = /<!--\s*observed:\s*(\d{4}-\d{2}-\d{2})?[^|>]*(?:\|\s*status:\s*(active|superseded))?[^>]*-->/i.exec(lines[i]);
    if (m) {
      flush();
      cur = { observed: m[1] ?? null, status: m[2]?.toLowerCase() === 'superseded' ? 'superseded' : 'active', line: i + 2, parts: [] };
      const rest = lines[i].slice(m.index + m[0].length).trim();
      if (rest) cur.parts.push(rest);
      continue;
    }
    if (/^\s{0,3}#/.test(lines[i])) {
      flush();
      continue;
    }
    if (cur && lines[i].trim()) cur.parts.push(lines[i].trim());
  }
  flush();
  // Files without markers: plain list items are active directives.
  if (!out.length) for (const it of markdownItems(text)) if (it.bullet) out.push({ text: it.text, observed: null, status: 'active', line: it.line });
  return out;
}

// ---------------------------------------------------------------------------------------------
// The persona draft (§6.3)
// ---------------------------------------------------------------------------------------------
export interface PersonaFile {
  /** Bundle path. */
  path: string;
  /** File name (the hint: STYLE, BACKSTORY, RITUALS…). */
  name: string;
  text: string;
}

type Slot = 'summary' | 'personality' | 'speech' | 'boundaries' | 'background' | 'relationship' | 'notes';

function slotOfHeading(h: string): Slot {
  const s = h.toLowerCase();
  if (/boundar|rules?\b|limits|never|principles|don'?t|do not|safety/.test(s)) return 'boundaries';
  if (/voice|tone|style|speech|how (you|i|she|he|they) (talk|speak|write)|writing|examples?|phrases|greetings?/.test(s)) return 'speech';
  if (/background|backstory|history|life|origin|story|childhood|past/.test(s)) return 'background';
  if (/relationship|dynamic|between us|with (alex|you|the user)/.test(s)) return 'relationship';
  if (/personality|traits?|character|who (you|i) (are|am)|core|nature|values|identity|vibe|about|soul|essence|quirks|interests|likes/.test(s)) return 'personality';
  return 'notes';
}

function slotOfFile(name: string): Slot | 'rituals' | 'jokes' | undefined {
  const n = name.toUpperCase().replace(/\.MD$/, '');
  if (/STYLE|EXAMPLES?|VOICE|TONE/.test(n)) return 'speech';
  if (/BACKSTORY|HISTORY|LIFE|ORIGIN/.test(n)) return 'background';
  if (/RELATIONSHIP|DYNAMIC/.test(n)) return 'relationship';
  if (/RITUAL/.test(n)) return 'rituals';
  if (/JOKE/.test(n)) return 'jokes';
  if (/BOUNDAR|RULES/.test(n)) return 'boundaries';
  return undefined;
}

const MAX_LINE = 400;
const MAX_LIST = 20;

/** Every persona file's text, checked as one: refused when it sexualises a minor or states an age under 18. */
export function personaRefusal(files: PersonaFile[]): string | undefined {
  const all = files.map((f) => f.text).join('\n');
  if (detectMinorSexualContent(all)) return 'This personality describes a minor in a sexual way, so it can\'t be used. Nothing from it was imported.';
  const ages = statedAges(all).filter((a) => !a.past);
  if (ages.some((a) => a.age < 18)) return 'This personality is under 18. Companions are adults only, so it can\'t be used.';
  return undefined;
}

/** Draft her sheet from persona files, without a model (headings and first paragraphs). */
export function draftPersona(label: string, files: PersonaFile[], base: Persona, opts: { name?: string; adultOn: boolean; ownerName: string; scrub: (s: string) => string; summaryOverride?: string }): PersonaDraft {
  const sheet: Persona = {
    ...base,
    name: base.name,
    summary: '',
    background: [],
    personality: [],
    speech: [],
    boundaries: [],
  };
  delete sheet.archetype;
  delete sheet.talk;
  const notes: PersonaNote[] = [];
  const leftOut: (PersonaLine & { why: string })[] = [];
  const lists: Record<'personality' | 'speech' | 'boundaries' | 'background', string[]> = { personality: [], speech: [], boundaries: [], background: [] };
  const rel: string[] = [];
  let summary = opts.summaryOverride ?? '';
  let name = opts.name;

  const take = (slot: Slot | 'rituals' | 'jokes', text: string, from: string) => {
    const t = opts.scrub(text.replace(/\s+/g, ' ').trim());
    if (!t || /^[-*_=#\s]+$/.test(t)) return;
    if (unsafeLine(t)) return void leftOut.push({ text: t, from, why: SAFETY_WHY });
    if (!opts.adultOn && detectExplicit(t)) return void leftOut.push({ text: t, from, why: 'explicit (Adult mode is off)' });
    if (slot === 'rituals') return void notes.push({ kind: 'self', text: t, from, tag: 'ritual' });
    if (slot === 'jokes') return void notes.push({ kind: 'self', text: t, from, tag: 'shared joke' });
    if (slot === 'relationship') {
      if (rel.join(' ').length + t.length < 600) rel.push(t);
      else notes.push({ kind: 'self', text: t, from });
      return;
    }
    if (slot === 'summary') {
      if (!summary) summary = t.slice(0, 1500);
      else notes.push({ kind: 'self', text: t, from, pinned: true });
      return;
    }
    if (slot === 'notes') return void notes.push({ kind: 'self', text: t, from });
    const list = lists[slot];
    if (t.length > MAX_LINE || list.length >= MAX_LIST) return void notes.push({ kind: 'self', text: t, from, pinned: slot === 'personality' || slot === 'boundaries' });
    if (!list.some((x) => x.toLowerCase() === t.toLowerCase())) list.push(t);
  };

  for (const f of files) {
    const fileSlot = slotOfFile(f.name);
    const isIdentity = /^IDENTITY\.md$/i.test(f.name);
    let heading = '';
    let firstPara = true;
    const lines = f.text.replace(/\r\n?/g, '\n').split('\n');
    let para: string[] = [];
    let paraLine = 0;
    const flushPara = () => {
      const t = para.join(' ').trim();
      para = [];
      if (!t) return;
      const from = `${f.path}#L${paraLine}`;
      if (fileSlot) take(fileSlot, t, from);
      else if (!heading && firstPara && !isIdentity) take('summary', t, from);
      else take(heading ? slotOfHeading(heading) : 'notes', t, from);
      firstPara = false;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l);
      if (h) {
        flushPara();
        const title = h[2].trim();
        // The top heading is the name ("# Robin"), when it reads like one.
        if (h[1] === '#' && !name && !fileSlot && /^[A-Z][\w' -]{0,30}$/.test(title) && !/^(soul|identity|persona|style|rules|memory|about|who i am|user model)$/i.test(title)) name = title;
        heading = h[1] === '#' ? '' : title;
        continue;
      }
      const kv = /^\s*[-*]?\s*\**(name|vibe|emoji|pronouns|age)\**\s*[:\uff1a]\s*(.+)$/i.exec(l);
      if (kv && (isIdentity || /^(name|pronouns|age)$/i.test(kv[1]))) {
        flushPara();
        const k = kv[1].toLowerCase();
        const v = kv[2].replace(/\*+/g, '').trim();
        if (k === 'name' && !name) name = v.slice(0, 40);
        else if (k === 'vibe') take('personality', `Vibe: ${v}`, `${f.path}#L${i + 1}`);
        else if (k === 'pronouns') {
          const p = v.toLowerCase();
          sheet.pronouns = p.startsWith('he') ? 'he' : p.startsWith('they') ? 'they' : 'she';
        } else if (k === 'emoji') notes.push({ kind: 'self', text: `My emoji is ${v}.`, from: `${f.path}#L${i + 1}` });
        continue;
      }
      const b = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(l);
      if (b) {
        flushPara();
        const from = `${f.path}#L${i + 1}`;
        take(fileSlot ?? (heading ? slotOfHeading(heading) : 'personality'), b[1], from);
        firstPara = false;
        continue;
      }
      if (!l.trim()) {
        flushPara();
        continue;
      }
      if (!para.length) paraLine = i + 1;
      para.push(l.trim());
    }
    flushPara();
  }
  sheet.name = (name ?? base.name).replace(/[^\p{L}\p{N}' -]/gu, '').trim().slice(0, 40) || base.name;
  sheet.summary = summary || `${sheet.name}, who moved in from another agent.`;
  sheet.personality = lists.personality;
  sheet.speech = lists.speech;
  sheet.boundaries = lists.boundaries;
  sheet.background = lists.background;
  if (rel.length) sheet.relationshipNote = rel.join(' ').slice(0, 600);
  const all = files.map((f) => f.text).join('\n');
  const ages = statedAges(all).filter((a) => !a.past && a.age >= 18 && a.age <= 120);
  let ageGuessed = false;
  if (ages.length) sheet.age = ages[0].age;
  else ageGuessed = true;
  if (sheet.personality.length === 0 && notes.length) {
    // A file without the usual headings: its first lines describe her.
    for (const n of notes.splice(0, Math.min(6, notes.length))) sheet.personality.push(n.text.slice(0, MAX_LINE));
  }
  return { label, files: files.map((f) => f.path), sheet, notes, leftOut, ...(ageGuessed ? { ageGuessed } : {}) };
}

/** Working rules (AGENTS.md and Hermes context files): pinned lesson notes, the Tools section left for MI3. */
export function workingRules(f: PersonaFile, scrub: (s: string) => string): { rules: PersonaNote[]; leftOut: (PersonaLine & { why: string })[]; tools: string[] } {
  const rules: PersonaNote[] = [];
  const leftOut: (PersonaLine & { why: string })[] = [];
  const tools: string[] = [];
  for (const it of markdownItems(f.text)) {
    const t = scrub(it.text);
    const from = `${f.path}#L${it.line}`;
    if (/^tools?\b/i.test(it.heading)) {
      tools.push(t);
      continue;
    }
    if (unsafeLine(t)) {
      leftOut.push({ text: t, from, why: SAFETY_WHY });
      continue;
    }
    if (t.length < 4) continue;
    rules.push({ kind: 'lesson', text: t.slice(0, 1000), from, pinned: true, tag: 'working rule' });
  }
  return { rules, leftOut, tools };
}
