// Who the companion is to the owner: name and pronouns. The app ships as "Sara" (she/her); owners
// can rename their companion and pick pronouns. All built-in wording (screens, prompts, messages)
// is written for "Sara"/she and passed through personalize(). Owner and companion text (chats,
// memories, titles) is never rewritten.
// No imports: this file is also served to the browser (types stripped) so both sides agree.

export type Pronouns = 'she' | 'he' | 'they';

export interface Identity {
  name: string;
  pronouns: Pronouns;
}

export const DEFAULT_IDENTITY: Identity = { name: 'Sara', pronouns: 'she' };

const FORMS = {
  she: { subj: 'she', obj: 'her', poss: 'her', poss2: 'hers', refl: 'herself' },
  he: { subj: 'he', obj: 'him', poss: 'his', poss2: 'his', refl: 'himself' },
  they: { subj: 'they', obj: 'them', poss: 'their', poss2: 'theirs', refl: 'themself' },
} as const;

/** Pronoun forms for templates: subj (she), obj (her), poss (her), poss2 (hers), refl (herself). */
export function forms(p: Pronouns): (typeof FORMS)[Pronouns] {
  return FORMS[p] ?? FORMS.she;
}

// After "her": these words mean it was the object ("wait for her or…", "let her keep going").
// Words that are also common nouns after a possessive (look, reply, laugh, work…) are left out.
const AFTER_OBJECT = new Set(
  'and or to for about with at in on up out off first again back now too more that when if so but a an the yet alone there here it anything something everything nothing what how why than as by from into before after while until know be do go see say tell feel take send stop wait try use write think remember decide have add find make keep get give let hear want speak learn choose forget any anytime every each some all once later soon today tonight tomorrow anyway instead directly right'.split(' '),
);

const KEEP_S = new Set(['is', 'was', 'has', 'does', 'this', 'yes', 'its', 'has', 'always', 'perhaps', 'sometimes', 'thus', 'plus']);

const cap = (s: string, like: string) => (like[0] === like[0].toUpperCase() ? s[0].toUpperCase() + s.slice(1) : s);

/** "keeps" → "keep", "watches" → "watch", "tries" → "try" (for they). */
function baseVerb(v: string): string {
  if (KEEP_S.has(v.toLowerCase()) || !/s$/.test(v) || /ss$/.test(v)) return v;
  if (/ies$/.test(v)) return v.slice(0, -3) + 'y';
  if (/(sh|ch|ss|x|z|o)es$/.test(v)) return v.slice(0, -2);
  return v.slice(0, -1);
}

// "Sara" as the product, not the companion: these keep the name after a rename ("the Sara app for
// Windows", "Sara Store", "Update Sara", "Sara 3.3.0", "Sara Classic").
const PRODUCT = /\bSara(?= (?:app|apps|Store|Classic|Classique|Clásico|Classico|Clássico|Hub|Desktop|Business|Pro|Connect|move-in|for (?:Windows|Mac|macOS|iPhone|iPad|iOS|Android|Linux))\b| \d)|(?<=\b(?:Update|update|Updating|updating|Install|install|Uninstall|uninstall|Restart|restart|version of|version de|versión de|versione di|versão da|Version von) )Sara\b(?! (?:is|was|has|can|will|says|said|does|knows|remembers|asks)\b)/g;
const KEEP_MARK = '\u2063S\u2063';

/** The companion's name instead of "Sara" (product mentions keep it). */
export function swapName(text: string, name: string): string {
  if (!name || name === 'Sara' || !/\bSara\b/.test(text)) return text;
  return text.replace(PRODUCT, KEEP_MARK).replace(/\bSara\b/g, name).split(KEEP_MARK).join('Sara');
}

/**
 * Picks the pronoun variant of a translation: "{p, select, she {…} he {…} other {…}}" (ICU-like;
 * "other" covers they and anything missing). Used in the few translated strings whose grammar
 * changes with the companion's gender (adjectives, articles, German pronouns).
 */
export function selectPronoun(text: string, pronouns: Pronouns = 'she'): string {
  if (!text.includes(', select,')) return text;
  return text.replace(/\{p, select,((?:\s*(?:she|he|they|other) \{[^{}]*\})+)\s*\}/g, (_m, body: string) => {
    const opts: Record<string, string> = {};
    for (const m of body.matchAll(/(she|he|they|other) \{([^{}]*)\}/g)) opts[m[1]] = m[2];
    return opts[pronouns] ?? opts.other ?? opts.she ?? '';
  });
}

// Strong pronouns for the companion in translations whose English mentions her (she/her/herself).
// Only in those strings, so a feminine noun elsewhere ("la boîte… elle") is never touched. They:
// the companion's name (Romance languages have no settled neutral pronoun). German "sie" is also
// "they"/"it"/formal "you": no rule; its strings use {p, select, …} where it matters.
const PREP_FR = "(?:avec|pour|à|de|chez|sans|par|sur|contre|comme|entre|envers|vers|sauf|selon|qu'à|d'|à part)";
// [pattern, replacement, subject]: "subject" rules (a bare subject pronoun) apply only when the English
// has her as a subject ("she"); with only "her", a French/Portuguese "elle"/"ela" is usually a noun.
type Rule = [RegExp, (name: string, cap: boolean) => string, boolean?];
const ROMANCE: Record<string, Partial<Record<'he' | 'they', Rule[]>>> = {
  es: {
    he: [[/\b([Ee])lla misma\b/g, (_n, c) => (c ? 'Él mismo' : 'él mismo')], [/\b([Ee])lla\b/g, (_n, c) => (c ? 'Él' : 'él')]],
    they: [[/\b([Ee])lla misma\b/g, (n) => n], [/\b([Ee])lla\b/g, (n) => n]],
  },
  fr: {
    he: [
      [/\b([Dd])['’]elle-même\b/g, (_n, c) => (c ? 'De lui-même' : 'de lui-même')],
      [/\b([Ee])lle-même\b/g, (_n, c) => (c ? 'Lui-même' : 'lui-même')],
      [new RegExp(`(?<=${PREP_FR} ?)elle\\b`, 'g'), () => 'lui'],
      [/\b([Ee])lle\b/g, (_n, c) => (c ? 'Il' : 'il'), true],
    ],
    they: [[/\b([Ee])lle-même\b/g, (n) => n], [new RegExp(`(?<=${PREP_FR} ?)elle\\b`, 'g'), (n) => n], [/\b([Ee])lle\b/g, (n) => n, true]],
  },
  it: {
    he: [[/\b([Ll])ei stessa\b/g, (_n, c) => (c ? 'Lui stesso' : 'lui stesso')], [/\b([Ll])ei\b/g, (_n, c) => (c ? 'Lui' : 'lui')]],
    they: [[/\b([Ll])ei stessa\b/g, (n) => n], [/\b([Ll])ei\b/g, (n) => n]],
  },
  'pt-BR': {
    he: [
      [/\b([Ee])la mesma\b/g, (_n, c) => (c ? 'Ele mesmo' : 'ele mesmo')],
      [/\b([DdNn])ela\b/g, () => ''],
      [/\b([Ee])la\b/g, (_n, c) => (c ? 'Ele' : 'ele'), true],
    ],
    they: [[/\b([Ee])la mesma\b/g, (n) => n], [/\b([Dd])ela\b/g, (n, c) => `${c ? 'De' : 'de'} ${n}`], [/\b([Nn])ela\b/g, (n, c) => `${c ? 'Em' : 'em'} ${n}`], [/\b([Ee])la\b/g, (n) => n, true]],
  },
};

const ABOUT_HER = /\b(she|her|hers|herself)\b/i;
// Only a sentence with "she" (or "herself") has her as a subject: with only "her", a translated
// subject pronoun is usually a noun (French "la tâche … elle est refusée").
const SHE_SUBJECT = /\b(she|she's|herself)\b/i;
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Agreement with her as the subject, only right after her name or pronoun: French inversions
 * ("doit-elle", "a-t-elle") and past participles ("s'est arrêtée"), and the Italian/Spanish/
 * Portuguese participles after "si è" / "se ha" / "ficou". They: French inclusive "·e"/"iel";
 * the others take the masculine, the grammatical default. Other adjectives use {p, select, …}.
 */
function agree(out: string, lang: string, pronouns: 'he' | 'they', name: string): string {
  const who = `(?:${esc(name)}|[Ee]lle|[Ll]ei|[Ee]la|[Ee]lla|[Ee]le|[Éé]l|[Ll]ui|[Ii]l)`;
  if (lang === 'fr') {
    // "d'elle-même" (of her own accord) after her name: "de lui-même", or the neutral "de son propre chef".
    out = out.replace(new RegExp(`(${who} \\p{L}+(?: \\p{L}+)? )d['’]elle-même\\b`, 'gu'), (_m, pre: string) => `${pre}${pronouns === 'he' ? 'de lui-même' : 'de son propre chef'}`);
    out = out.replace(/-t-elle\b/g, pronouns === 'he' ? '-t-il' : '-t-iel').replace(/(\p{L})-elle\b/gu, (_m, l: string) => `${l}-${pronouns === 'he' ? 'il' : 'iel'}`);
    return out.replace(new RegExp(`(${who}(?: ne)? s['’]est(?: (?:donc|déjà|bien|pas|aussi))? )(\\p{L}+?)(é|u|i|t|s)e\\b`, 'gu'), (_m, pre: string, stem: string, end: string) => `${pre}${stem}${end}${pronouns === 'he' ? '' : '·e'}`);
  }
  const part: Record<string, RegExp> = {
    it: new RegExp(`(${who}(?: non)? (?:si è|è)(?: già)? )(\\p{L}+)(at|ut|it)a\\b`, 'gu'),
    es: new RegExp(`(${who}(?: no)? (?:se ha|ha sido|está|se quedó)(?: ya)? )(\\p{L}+)(ad|id)a\\b`, 'gu'),
    'pt-BR': new RegExp(`(${who}(?: não)? (?:ficou|está|foi|fica)(?: já)? )(\\p{L}+)(ad|id)a\\b`, 'gu'),
  };
  if (lang === 'it') out = out.replace(new RegExp(`(${who}(?: non)? è )stata (\\p{L}+)(at|ut|it)a\\b`, 'gu'), (_m, pre: string, stem: string, end: string) => `${pre}stato ${stem}${end}o`);
  return part[lang] ? out.replace(part[lang], (_m, pre: string, stem: string, end: string) => `${pre}${stem}${end}o`) : out;
}

/**
 * A translated built-in string for the owner's companion: the pronoun variant, the name, and (when
 * the English source speaks of her) the Romance-language strong pronouns. English uses personalize().
 */
export function personalizeTranslation(english: string, translated: string, id: Identity, lang: string): string {
  // Not translated yet: it is still English, so the English rules apply.
  if (translated === english) return personalize(english, id);
  let out = swapName(selectPronoun(translated, id.pronouns), id.name);
  if (id.pronouns === 'she') return out;
  // Agreement after her name too ("Sara s'est arrêtée"), so also when the English only names her.
  if (ABOUT_HER.test(english) || /\bSara\b/.test(english)) out = agree(out, lang, id.pronouns, id.name);
  if (!ABOUT_HER.test(english)) return out;
  // German: only the unambiguous case, a sentence that starts with "She" and "Sie" (er/sie take the
  // same verb form; they: the name).
  if (lang === 'de') return /^She\b/.test(english.trim()) ? out.replace(/^(\s*)Sie\b/, (_m, sp: string) => `${sp}${id.pronouns === 'he' ? 'Er' : id.name}`) : out;
  const subject = SHE_SUBJECT.test(english);
  // French: "elle est configurée" (her, the subject) → "il est configuré" / "iel est configuré·e".
  if (subject && lang === 'fr') {
    const who = `(?:${esc(id.name)}|[Ee]lle)`;
    out = out.replace(new RegExp(`(${who}(?: ne)? (?:est|était|sera|reste|semble)(?: (?:pas|déjà|bien|toujours|aussi|très|un peu))? )(\\p{L}+?)(é|u|i|t|s)e\\b`, 'gu'), (_m, pre: string, stem: string, end: string) => `${pre}${stem}${end}${id.pronouns === 'he' ? '' : '·e'}`);
  }
  for (const [re, to, subjectOnly] of ROMANCE[lang]?.[id.pronouns] ?? []) {
    if (subjectOnly && !subject) continue;
    out = out.replace(re, (m: string, c?: string) => {
      // pt-BR "dela"/"nela" → "dele"/"nele" (keeps the first letter and its case).
      if (lang === 'pt-BR' && id.pronouns === 'he' && /^[DdNn]ela$/.test(m)) return `${m[0]}ele`;
      return to(id.name, typeof c === 'string' ? c === c.toUpperCase() : m[0] === m[0].toUpperCase());
    });
  }
  return out;
}

/** Rewrites built-in wording written for "Sara"/she to the owner's companion. */
export function personalize(text: string, id: Identity = DEFAULT_IDENTITY): string {
  if (!text) return text;
  let out = selectPronoun(text, id.pronouns);
  if (id.name && id.name !== 'Sara') out = swapName(out, id.name);
  if (id.pronouns === 'she' || !id.pronouns) return out;
  const f = forms(id.pronouns);
  if (id.pronouns === 'they') {
    out = out
      .replace(/\b([Ss])he's\b/g, (_m, s: string) => cap("they're", s))
      .replace(/\b([Ss])he (is|was|has|does|doesn't|isn't|wasn't|hasn't)\b/g, (_m, s: string, v: string) => {
        const map: Record<string, string> = { is: 'are', was: 'were', has: 'have', does: 'do', "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't" };
        return `${cap('they', s)} ${map[v]}`;
      })
      .replace(/\b([Ss])he ((?:never|always|also|only|still|just|really|sometimes|usually|often|even|already) )?([a-z]+)\b/g, (_m, s: string, adv: string | undefined, v: string) => `${cap('they', s)} ${adv ?? ''}${baseVerb(v)}`);
  }
  out = out
    .replace(/\b([Hh])erself\b/g, (_m, h: string) => cap(f.refl, h))
    .replace(/\b([Hh])ers\b/g, (_m, h: string) => cap(f.poss2, h))
    .replace(/\b([Ss])he\b/g, (_m, s: string) => cap(f.subj, s))
    // The next word is only looked at (not consumed), so "make her her own" changes both.
    .replace(/\b([Hh])er\b(?=(\s*)([A-Za-z']*))/g, (_m, h: string, _sp: string, next: string) => {
      const object = !next || AFTER_OBJECT.has(next.toLowerCase()) || /^(her|hers|herself)$/i.test(next);
      return cap(object ? f.obj : f.poss, h);
    });
  return out;
}

/** Normalizes stored settings into an Identity (unknown pronouns fall back to she). */
export function toIdentity(name: unknown, pronouns: unknown): Identity {
  const n = String(name ?? '').trim() || DEFAULT_IDENTITY.name;
  const p = pronouns === 'he' || pronouns === 'they' ? pronouns : 'she';
  return { name: n, pronouns: p };
}
