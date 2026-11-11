// Phase 53: languages. The web app ships in English (the source) plus Spanish, French, German,
// Portuguese (Brazil) and Italian (web/i18n/<lang>.json, keyed by the English text). The owner picks
// the app language in Settings → You → Language (Automatic = the browser's language) and, separately,
// the language she talks in ("Talk to me in": Automatic = the language the owner writes in, else the
// app language). The AI disclosure is legally required and has its own reviewed texts (DISCLOSURE).
// Phase 61: other server-made text the owner sees goes through tr() (below), from the same
// web/i18n/<lang>.json files as the app, keyed by the English text.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { personalize, personalizeTranslation, selectPronoun, type Identity } from './identity.ts';
import type { Settings } from './settings.ts';

export const LANGUAGES = ['en', 'es', 'fr', 'de', 'pt-BR', 'it'] as const;
export type Lang = (typeof LANGUAGES)[number];

/** English names (for prompts) and native names (for pickers). */
export const LANGUAGE_NAMES: Record<Lang, { english: string; native: string }> = {
  en: { english: 'English', native: 'English' },
  es: { english: 'Spanish', native: 'Español' },
  fr: { english: 'French', native: 'Français' },
  de: { english: 'German', native: 'Deutsch' },
  'pt-BR': { english: 'Portuguese (Brazil)', native: 'Português (Brasil)' },
  it: { english: 'Italian', native: 'Italiano' },
};

/** Any browser or owner language code ("de-AT", "pt", "es-419") → one of ours, or undefined. */
export function toLang(code: unknown): Lang | undefined {
  const c = String(code ?? '').trim().toLowerCase().replace('_', '-');
  if (!c) return undefined;
  if (c.startsWith('pt')) return 'pt-BR';
  const base = c.split('-')[0];
  return (LANGUAGES as readonly string[]).includes(base) ? (base as Lang) : undefined;
}

/** The app language: the owner's pick, or (Automatic) the browser language the app reported. */
export function appLanguage(s: Pick<Settings, 'language' | 'languageDetected'>): Lang {
  const pick = s.language && s.language !== 'auto' ? toLang(s.language) : undefined;
  return pick ?? toLang(s.languageDetected) ?? 'en';
}

// Small, frequent words that mark a language. Scored on whole words; English is a candidate too so
// "Automatic" can tell that the owner switched back to English.
const MARKERS: Record<Lang, string[]> = {
  en: 'the and you are is that this what with have was for not but just my me your it to of in i do how why'.split(' '),
  es: 'el la los las que de y es en un una por para con no pero muy está estoy eres soy qué cómo tengo tienes hola gracias también mi tu yo porque hoy bien'.split(' '),
  fr: 'le la les des que de et est en un une pour avec pas mais très je tu suis es ça quoi comment bonjour merci aussi mon ton moi parce aujourd hui bien vous nous'.split(' '),
  de: 'der die das und ist nicht ich du bin es ein eine mit für aber sehr was wie hallo danke auch mein dein heute gut wir ihr sie auf zu noch schon'.split(' '),
  'pt-BR': 'o a os as que de e é em um uma por para com não mas muito estou você sou eu oi obrigado obrigada também meu seu hoje bem tá isso como'.split(' '),
  it: 'il lo la gli le che di e è in un una per con non ma molto sto sono tu io ciao grazie anche mio tuo oggi bene come cosa perché questo'.split(' '),
};

/**
 * The language a message is written in, when it is clear (at least three marker words and a clear
 * lead over the runner-up); otherwise undefined. Short or mixed messages don't switch anything.
 */
export function detectLanguage(text: string): Lang | undefined {
  const words = (text.toLowerCase().match(/[\p{L}']+/gu) ?? []).flatMap((w) => w.split("'"));
  if (words.length < 3) return undefined;
  const score = new Map<Lang, number>();
  for (const lang of LANGUAGES) {
    const set = new Set(MARKERS[lang]);
    score.set(lang, words.filter((w) => set.has(w)).length);
  }
  // Letters only some languages use settle close calls.
  if (/[ñ¿¡]/.test(text)) score.set('es', (score.get('es') ?? 0) + 2);
  if (/[ãõ]|ção\b|ções\b/.test(text)) score.set('pt-BR', (score.get('pt-BR') ?? 0) + 2);
  if (/[äöüß]/.test(text)) score.set('de', (score.get('de') ?? 0) + 2);
  if (/[çœ]|[êâî]/.test(text) && !/ção/.test(text)) score.set('fr', (score.get('fr') ?? 0) + 1);
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]);
  const [best, second] = ranked;
  if (best[1] < 2 || best[1] < second[1] + 2) return undefined;
  return best[0];
}

/**
 * The language she replies in: a fixed pick, or (Automatic) the language of the owner's message when
 * it is clear, else the app language.
 */
export function talkLanguage(s: Pick<Settings, 'language' | 'languageDetected' | 'talkLanguage'>, ownerText?: string): Lang {
  const fixed = s.talkLanguage && s.talkLanguage !== 'auto' ? toLang(s.talkLanguage) : undefined;
  if (fixed) return fixed;
  return (ownerText ? detectLanguage(ownerText) : undefined) ?? appLanguage(s);
}

/** The prompt line for a language: nothing for English (the prompts are English already). */
export function languageLine(lang: Lang | undefined): string | undefined {
  if (!lang || lang === 'en') return undefined;
  const name = LANGUAGE_NAMES[lang].english;
  return `Reply in ${name} unless asked otherwise. You are the same person in every language: same personality, voice and way of talking. Notes and quotes from earlier stay in the language they were said in; don't translate quotes.`;
}

// The AI disclosure (required by law): the same meaning in every language. {name} is the companion's name.
const DISCLOSURE: Record<Lang, string> = {
  en: '{name} is an AI companion, not a human. Conversations are generated by AI models and may be inaccurate.',
  es: '{name} es una IA de compañía, no un ser humano. Las conversaciones las generan modelos de IA y pueden contener errores.',
  fr: '{name} est une IA de compagnie, pas un être humain. Les conversations sont générées par des modèles d’IA et peuvent être inexactes.',
  de: '{name} ist eine KI-Begleitung, kein Mensch. Die Gespräche werden von KI-Modellen erzeugt und können ungenau sein.',
  'pt-BR': '{name} é uma IA de companhia, não um ser humano. As conversas são geradas por modelos de IA e podem conter imprecisões.',
  it: '{name} è un’IA di compagnia, non un essere umano. Le conversazioni sono generate da modelli di IA e possono essere inesatte.',
};

/** The disclosure in a language (English when unknown). */
export function disclosureIn(name: string, lang: Lang | string | undefined = 'en'): string {
  const l = toLang(lang) ?? 'en';
  return DISCLOSURE[l].replace('{name}', name.trim() || 'Sara');
}

/** Every translation of the disclosure (tests, and the client's fallback for old notices). */
export const DISCLOSURES: Readonly<Record<Lang, string>> = DISCLOSURE;

/** Voice engines: a language for speech-to-text and Grok voice from the owner's talk language. */
export function voiceLanguage(lang: Lang): string {
  return lang === 'es' ? 'es-MX' : lang;
}

/**
 * The language hint for hearing and Grok's voice: Settings → Voice → Language when the owner set
 * something other than English there ('auto' included), else her talk language. So an owner who
 * talks German gets German transcription and a German Grok voice without touching the voice page.
 */
export function speechLanguage(s: Pick<Settings, 'language' | 'languageDetected' | 'talkLanguage' | 'voice'>): string {
  const own = s.voice?.xai?.language;
  if (own && own !== 'en') return own;
  const talk = talkLanguage(s);
  return talk === 'en' ? 'en' : voiceLanguage(talk);
}

// ---------- Phase 61: server-made text in the owner's language ----------
// One set of translation files for the app and the server: web/i18n/<lang>.json, keyed by the
// English text with {placeholders}. scripts/i18n-extract.ts finds the server's keys in src/ (tr()
// and en() calls, and fixed HttpError messages), so a new English text needs its translations in
// the same change. English is the fallback for any key a language lacks.

/** Marks English text the owner sees that is translated elsewhere (the app, or a later tr()); returns it unchanged. */
export const en = <S extends string>(text: S): S => text;

/** Fills {name}-style placeholders. */
export function fill(text: string, params?: Record<string, unknown>): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k] ?? '') : m));
}

const I18N_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'i18n');
const dicts = new Map<Lang, Record<string, unknown>>();
function dictFor(lang: Lang): Record<string, unknown> {
  let d = dicts.get(lang);
  if (!d) {
    try {
      d = JSON.parse(readFileSync(join(I18N_DIR, `${lang}.json`), 'utf8')) as Record<string, unknown>;
    } catch {
      d = {};
    }
    dicts.set(lang, d);
  }
  return d;
}

/**
 * English text in a language, with its {placeholders} filled. Like the app's t(): translate first,
 * then the companion's name (and, in English only, her pronouns), then the values, so owner text
 * in the values is never rewritten. Unknown keys and languages stay English.
 */
export function tr(text: string, lang: Lang | string | undefined, params?: Record<string, unknown>, who?: Identity): string {
  const l = toLang(lang) ?? 'en';
  const found = l === 'en' ? undefined : dictFor(l)[text.replace(/\s+/g, ' ').trim()];
  let out = typeof found === 'string' && found.trim() ? found : text;
  // Translations may hold {p, select, she {…} he {…} other {…}} for gendered grammar (src/identity.ts).
  out = who ? (l === 'en' ? personalize(out, who) : personalizeTranslation(text, out, who, l)) : selectPronoun(out, 'she');
  return fill(out, params);
}

/** tr() in the owner's app language (Settings → You → Language). */
export function trOwner(text: string, s: Pick<Settings, 'language' | 'languageDetected'>, params?: Record<string, unknown>, who?: Identity): string {
  return tr(text, appLanguage(s), params, who);
}
