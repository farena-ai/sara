// Phase 126 (2.59.0, docs/design/WAKE.md): "Hey Sara". The detector runs on the device (the Windows
// app, the Android app); this file is the server side that the devices talk to:
// - W2 the keyword lines: a phrase ("Hey Mira") becomes sherpa-onnx keyword lines from the model's own
//   English lexicon (`en.phone`, plain text lookup, no tool); "Hey Sara" and "stop" are built in;
// - the phrase rules (2–4 words, 6+ sounds, not a stop word, not another assistant's name, English);
// - `wake.json` per person: the cached lines per label and the devices that listen (keyed by the
//   session id), with day counters kept 14 days and the "make her harder to wake" hint;
// - the claim: when several of one person's devices hear the phrase, the first one answers;
// - the words that end an exchange on the server without a turn (stop words, filler, nothing).
// Nothing here ever holds audio or message text.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

export type Sensitivity = 'relaxed' | 'normal' | 'strict';
export type TalksIn = 'own' | 'open' | 'new';
export type WakePlatform = 'windows' | 'mac' | 'android' | 'linux';

/** §4.3: the two numbers each keyword line carries (boosting score, trigger threshold). */
export const SENSITIVITY: Record<Sensitivity, { boost: number; threshold: number }> = {
  relaxed: { boost: 2.0, threshold: 0.2 },
  normal: { boost: 1.5, threshold: 0.25 },
  strict: { boost: 1.0, threshold: 0.35 },
};
export const SENSITIVITIES: readonly Sensitivity[] = ['relaxed', 'normal', 'strict'];

/** "Hey Sara" is built in: both spellings the lexicon gives "Sara" ("S EH1 R AH0", "S AA1 R AH0"). */
export const HEY_SARA = ['HH EY1 S EH1 R AH0', 'HH EY1 S AA1 R AH0'] as const;
/** "Stop" (said while she speaks) and "Sara stop". */
export const STOP_SPELLINGS = ['S T AA1 P'] as const;
export const SARA_SPELLINGS = ['S EH1 R AH0', 'S AA1 R AH0'] as const;

export const MAX_PHRASES = 4;
export const MIN_SOUNDS = 6;
export const DAYS_KEPT = 14;
export const CLAIM_WINDOW_MS = 1500;
export const CLAIM_TTL_MS = 20_000;
export const STRICT_HINT_AT = 5;
export const STRICT_HINT_EVERY_MS = 7 * 24 * 3600_000;
export const POLL_SECONDS = 60;
/** §5.5: the recording limits. */
export const TURN_MAX_BYTES = 600 * 1024;
export const TURN_MAX_SECONDS = 15;

/** One keyword line: tokens, then ":boost #threshold @label" (the sherpa-onnx keywords file format). */
export function keywordLine(spelling: string, label: string, sensitivity: Sensitivity = 'normal'): string {
  const s = SENSITIVITY[sensitivity] ?? SENSITIVITY.normal;
  return `${spelling} :${s.boost.toFixed(1)} #${s.threshold.toFixed(2)} @${label}`;
}

/** A cached line at another sensitivity (only the `:boost #threshold` part changes). */
export function withSensitivity(line: string, sensitivity: Sensitivity): string {
  const s = SENSITIVITY[sensitivity] ?? SENSITIVITY.normal;
  return line.replace(/ :[\d.]+ #[\d.]+ @/, ` :${s.boost.toFixed(1)} #${s.threshold.toFixed(2)} @`);
}

/** The lexicon: WORD → its spellings (one line per spelling in `en.phone`, "WORD PH1 PH2 …"). */
export type Lexicon = Map<string, string[]>;
export function parseLexicon(text: string): Lexicon {
  const lex: Lexicon = new Map();
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;
    const w = parts[0].toUpperCase();
    const sp = parts.slice(1).join(' ');
    const list = lex.get(w) ?? [];
    if (!list.includes(sp)) list.push(sp);
    lex.set(w, list);
  }
  return lex;
}

/** Upper-case words of a phrase, punctuation and case ignored ("Hey, Mira!" → HEY MIRA). */
export function phraseWords(text: string): string[] {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toUpperCase());
}

/** The OS's and other assistants' wake words: two assistants would wake at once. */
const OTHER_ASSISTANTS = ['GOOGLE', 'ALEXA', 'SIRI', 'CORTANA', 'BIXBY', 'COPILOT'];
/** Common greetings and names-of-things in the app's other languages (§4.4, §19 Q8). */
const FOREIGN_WORDS = new Set(['HALLO', 'HOLA', 'OLÁ', 'OLA', 'OI', 'CIAO', 'SALUT', 'BONJOUR', 'COUCOU', 'SERVUS', 'MOIN', 'HEJ', 'EI', 'EHI', 'OYE', 'OIGA', 'GUTEN', 'BUENOS', 'BUENAS', 'BOM', 'BOA', 'BUONGIORNO', 'BONSOIR', 'LIEBE', 'QUERIDA', 'CARA', 'CHÉRIE', 'SCHATZ', 'TESORO', 'AMORE', 'AMOR', 'MEINE', 'MINHA', 'MIA']);
const LANGUAGE_NAMES = ['German', 'Spanish', 'French', 'Italian', 'Portuguese'];

export const WHY = {
  words: 'Use two to four words, like “Hey Mira”.',
  short: 'Short phrases wake her by mistake. Try a longer one, like “Hey Alfred”.',
  stop: 'That phrase has a word that stops her (“stop”, “cancel”…). Pick other words.',
  assistant: 'That wakes another assistant too (Google, Alexa, Siri, Cortana). Pick other words.',
  duplicate: 'You already use that phrase.',
  many: 'Up to 4 phrases. Remove one first.',
  language: `Custom wake words in ${LANGUAGE_NAMES.join(', ')} need a model Sara doesn't have yet: use English words, or “Hey Sara”.`,
  lexicon: 'Other words need the English word list on your server first (Settings → Hey Sara → Download).',
} as const;

export type PhraseCheck = { ok: true; lines: string[]; sounds: number } | { ok: false; why: string; word?: string };

/**
 * W2: a phrase → its keyword lines (at most 4 spellings). "Hey Sara" needs no lexicon; every other
 * phrase needs `en.phone`. Words it can't find are refused, naming the word; spellings are never guessed.
 */
export function phraseLines(text: string, lexicon?: Lexicon, opts: { label?: string; sensitivity?: Sensitivity } = {}): PhraseCheck {
  const label = opts.label ?? 'W1';
  const sens = opts.sensitivity ?? 'normal';
  const words = phraseWords(text);
  if (words.join(' ') === 'HEY SARA') return { ok: true, lines: HEY_SARA.map((s) => keywordLine(s, label, sens)), sounds: 6 };
  let combos: string[][] = [[]];
  for (const w of words) {
    const sp = lexicon?.get(w);
    if (!sp?.length) {
      if (FOREIGN_WORDS.has(w) || /[^A-Z']/.test(w)) return { ok: false, why: WHY.language, word: w };
      if (!lexicon) return { ok: false, why: WHY.lexicon, word: w };
      return { ok: false, why: `Sara doesn't know how “${w.toLowerCase()}” sounds. Try another word, or another spelling of it.`, word: w };
    }
    const next: string[][] = [];
    for (const c of combos) for (const s of sp) if (next.length < 4) next.push([...c, s]);
    combos = next;
  }
  const lines = combos.map((c) => keywordLine(c.join(' '), label, sens));
  const sounds = combos[0]?.join(' ').split(' ').filter(Boolean).length ?? 0;
  return { ok: true, lines, sounds };
}

/** §4.4: the rules a phrase must pass before it's saved (shown by /api/wake/phrase-check). */
export function checkPhrase(text: string, opts: { lexicon?: Lexicon; others?: string[]; label?: string; sensitivity?: Sensitivity; count?: number } = {}): PhraseCheck {
  const words = phraseWords(text);
  const norm = words.join(' ');
  if ((opts.count ?? 0) >= MAX_PHRASES) return { ok: false, why: WHY.many };
  if (words.some((w) => OTHER_ASSISTANTS.includes(w)) || norm === 'OK GOOGLE' || norm === 'OKAY GOOGLE') return { ok: false, why: WHY.assistant };
  if (words.length < 2 || words.length > 4) return { ok: false, why: WHY.words };
  if (words.some((w) => PHRASE_STOP_WORDS.has(w))) return { ok: false, why: WHY.stop };
  if ((opts.others ?? []).some((o) => phraseWords(o).join(' ') === norm)) return { ok: false, why: WHY.duplicate };
  const r = phraseLines(text, opts.lexicon, { label: opts.label, sensitivity: opts.sensitivity });
  if (!r.ok) return r;
  if (r.sounds < MIN_SOUNDS) return { ok: false, why: WHY.short };
  return r;
}
const PHRASE_STOP_WORDS = new Set(['STOP', 'CANCEL', 'NEVERMIND', 'GOODBYE', 'BYE', 'NOTHING']);

/** The stop lines: "stop", and "{her name} stop" for each phrase's name the lexicon (or "Sara") knows. */
export function stopLines(names: string[], lexicon?: Lexicon, sensitivity: Sensitivity = 'normal'): string[] {
  const out = STOP_SPELLINGS.map((s) => keywordLine(s, 'STOP', sensitivity));
  for (const n of new Set(names.map((x) => x.toUpperCase()))) {
    const sp = n === 'SARA' ? [...SARA_SPELLINGS] : (lexicon?.get(n) ?? []);
    for (const s of sp.slice(0, 2)) out.push(keywordLine(`${s} ${STOP_SPELLINGS[0]}`, 'STOP', sensitivity));
  }
  return out;
}

/** Her name from a phrase ("Hey Mira" → Mira): the last word. */
export const nameOf = (phrase: string) => {
  const w = phraseWords(phrase).at(-1) ?? 'SARA';
  return w.charAt(0) + w.slice(1).toLowerCase();
};

// ---------------- settings (per person, settings.json `wake`; §3.3) ----------------

export interface WakePhrase {
  text: string;
  companionId: string;
  /** W1…W4, kept when other phrases are removed (the devices map labels to companions). */
  label: string;
}
export interface WakeSettings {
  phrases?: WakePhrase[];
  talksIn?: TalksIn;
  starts?: 'question' | 'call';
  followUpSeconds?: 0 | 5 | 8;
  sensitivity?: Sensitivity;
  /** C17: never listen for the phrase in the quiet hours (Settings → Calls from her); off by default. */
  quietHours?: boolean;
}
export const TALKS_IN: readonly TalksIn[] = ['own', 'open', 'new'];
export interface WakeView {
  phrases: WakePhrase[];
  talksIn: TalksIn;
  starts: 'question' | 'call';
  followUpSeconds: 0 | 5 | 8;
  sensitivity: Sensitivity;
  quietHours: boolean;
}
/** The settings with the defaults (§19): own conversation, one question, no follow-up, Normal. */
export function wakeView(s: WakeSettings | undefined, fallback: () => WakePhrase[]): WakeView {
  const phrases = Array.isArray(s?.phrases) && s.phrases.length ? s.phrases.filter((p) => p && typeof p.text === 'string' && typeof p.companionId === 'string' && /^W[1-4]$/.test(p.label)).slice(0, MAX_PHRASES) : fallback();
  return {
    phrases,
    talksIn: TALKS_IN.includes(s?.talksIn as TalksIn) ? (s!.talksIn as TalksIn) : 'own',
    starts: s?.starts === 'call' ? 'call' : 'question',
    followUpSeconds: s?.followUpSeconds === 5 || s?.followUpSeconds === 8 ? s.followUpSeconds : 0,
    sensitivity: cleanSensitivity(s?.sensitivity),
    quietHours: s?.quietHours === true,
  };
}
/** The first free label W1…W4. */
export function freeLabel(phrases: WakePhrase[]): string | undefined {
  for (let i = 1; i <= MAX_PHRASES; i++) if (!phrases.some((p) => p.label === `W${i}`)) return `W${i}`;
  return undefined;
}

// ---------------- the words that end an exchange without a turn (§4.5 step 3, §4.7) ----------------

/** Whole-utterance stop words in the app's six languages (next to the chat's COMMAND_WORDS). */
export const STOP_WORDS: Record<string, readonly string[]> = {
  en: ['stop', 'cancel', 'never mind', 'nevermind', "that's all", 'that is all', 'goodbye', 'good bye', 'bye', 'nothing', 'forget it'],
  es: ['para', 'detente', 'cancela', 'cancelar', 'olvídalo', 'nada', 'adiós', 'eso es todo', 'déjalo'],
  fr: ['stop', 'arrête', 'annule', 'laisse tomber', 'rien', 'au revoir', "c'est tout", 'oublie'],
  de: ['stopp', 'halt', 'abbrechen', 'vergiss es', 'nichts', 'tschüss', 'auf wiedersehen', 'das ist alles'],
  'pt-BR': ['para', 'pare', 'cancela', 'cancelar', 'esquece', 'nada', 'tchau', 'adeus', 'é só isso', 'deixa pra lá'],
  it: ['stop', 'basta', 'ferma', 'fermati', 'annulla', 'lascia stare', 'niente', 'ciao', 'arrivederci', 'è tutto'],
};
const STOP_SET = new Set(Object.values(STOP_WORDS).flat());
const FILLER = new Set(['um', 'umm', 'uh', 'uhh', 'hmm', 'hm', 'mm', 'er', 'erm', 'ah', 'eh', 'oh', 'huh']);

/** Lower-case, punctuation off, "hey"/her name in front dropped ("Sara, stop." → "stop"). */
function utterance(text: string, names: string[]): string {
  let s = String(text ?? '').toLowerCase().normalize('NFC').replace(/[’]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const lead = new Set(['hey', 'ok', 'okay', ...names.map((n) => n.toLowerCase())]);
  for (let i = 0; i < 3; i++) {
    const [first, ...rest] = s.split(' ');
    if (rest.length && lead.has(first)) s = rest.join(' ');
  }
  return s;
}

/** §5.5 step 2: nothing worth a turn (empty, a single character, only filler). */
export function saidNothing(text: string): boolean {
  const s = utterance(text, []);
  if (s.replace(/\s/g, '').length < 2) return true;
  return s.split(' ').every((w) => FILLER.has(w));
}

/** §5.5 step 2: a stop word on its own ("stop", "Sara, never mind"); "stop the timer" is a request. */
export function isStopWord(text: string, names: string[] = []): boolean {
  return STOP_SET.has(utterance(text, names));
}

// ---------------- wake.json (per person) ----------------

export interface DayCount {
  wakes: number;
  nothing: number;
  stopped: number;
  answered: number;
}
export interface WakeDevice {
  platform: WakePlatform;
  label: string;
  on: boolean;
  paused?: string;
  pack?: string;
  sensitivity: Sensitivity;
  personal: boolean;
  chime: boolean;
  /** Why it is off when the device didn't do it ('remote': one of his sessions; 'everywhere'). */
  offBy?: 'remote' | 'everywhere';
  lastWake?: string;
  lastSeen: string;
  hintAt?: string;
  days: Record<string, DayCount>;
}
export interface WakeFile {
  v: 1;
  phrases: Record<string, { text: string; companionId: string; lines: string[]; madeAt: string }>;
  devices: Record<string, WakeDevice>;
}

const empty = (): WakeFile => ({ v: 1, phrases: {}, devices: {} });
const PLATFORMS: readonly WakePlatform[] = ['windows', 'mac', 'android', 'linux'];
export const cleanPlatform = (p: unknown): WakePlatform => (PLATFORMS.includes(p as WakePlatform) ? (p as WakePlatform) : 'windows');
export const cleanSensitivity = (s: unknown): Sensitivity => (SENSITIVITIES.includes(s as Sensitivity) ? (s as Sensitivity) : 'normal');
const day = (d: Date) => d.toISOString().slice(0, 10);

interface Claim {
  id: string;
  deviceId: string;
  label: string;
  at: number;
  expires: number;
  done?: boolean;
}
/** Claims live in memory only, one list per person (every companion's server of that person shares it). */
const CLAIMS = new Map<string, Claim[]>();

/** One person's wake.json (atomic writes), their devices, counters and claims. */
export class WakeStore {
  readonly file: string;
  readonly #now: () => Date;
  readonly #key: string;

  constructor(personDir: string, now: () => Date = () => new Date()) {
    this.file = join(personDir, 'wake.json');
    this.#now = now;
    this.#key = personDir;
  }

  /** Reads the file; devices whose session is gone (`alive`) are dropped, days older than 14 are pruned. */
  read(alive?: (sessionId: string) => boolean): WakeFile {
    let f: WakeFile;
    try {
      f = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as WakeFile) : empty();
      if (f?.v !== 1 || typeof f.devices !== 'object') f = empty();
      f.phrases ??= {};
    } catch {
      f = empty();
    }
    let changed = false;
    const cutoff = day(new Date(this.#now().getTime() - (DAYS_KEPT - 1) * 86_400_000));
    for (const [id, d] of Object.entries(f.devices)) {
      if (alive && !alive(id)) {
        delete f.devices[id];
        changed = true;
        continue;
      }
      for (const k of Object.keys(d.days ?? {})) {
        if (k < cutoff) {
          delete d.days[k];
          changed = true;
        }
      }
    }
    if (changed) this.write(f);
    return f;
  }

  write(f: WakeFile): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(f, null, 1)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  update(fn: (f: WakeFile) => void, alive?: (sessionId: string) => boolean): WakeFile {
    const f = this.read(alive);
    fn(f);
    this.write(f);
    return f;
  }

  /** Adds to today's counters of a device; sets the Strict hint once a week at most. */
  count(f: WakeFile, sessionId: string, add: Partial<DayCount>): void {
    const d = f.devices[sessionId];
    if (!d) return;
    const today = day(this.#now());
    const c = (d.days[today] ??= { wakes: 0, nothing: 0, stopped: 0, answered: 0 });
    for (const k of ['wakes', 'nothing', 'stopped', 'answered'] as const) {
      const n = Math.max(0, Math.min(1000, Math.floor(Number(add[k] ?? 0)) || 0));
      c[k] += n;
    }
    if (c.nothing + c.stopped >= STRICT_HINT_AT && d.sensitivity !== 'strict') {
      const last = d.hintAt ? Date.parse(d.hintAt) : 0;
      if (!last || this.#now().getTime() - last >= STRICT_HINT_EVERY_MS) d.hintAt = this.#now().toISOString();
    }
  }

  /** Today's counts of a device, and whether the Strict hint is to be shown today. */
  today(d: WakeDevice): DayCount & { hint: boolean } {
    const today = day(this.#now());
    return { ...(d.days[today] ?? { wakes: 0, nothing: 0, stopped: 0, answered: 0 }), hint: Boolean(d.hintAt && d.hintAt.slice(0, 10) === today) };
  }

  // ---- the claim (§5.4) ----

  /** First claim wins; another of his devices within 1.5 s loses (with the winner's name). */
  claim(deviceId: string, label: string, deviceLabel: (id: string) => string): { ok: true; claim: string } | { ok: false; by: string } {
    const now = this.#now().getTime();
    const list = (CLAIMS.get(this.#key) ?? []).filter((c) => c.expires > now);
    const recent = list.find((c) => now - c.at < CLAIM_WINDOW_MS && c.deviceId !== deviceId);
    if (recent) {
      CLAIMS.set(this.#key, list);
      return { ok: false, by: deviceLabel(recent.deviceId) };
    }
    const c: Claim = { id: randomUUID(), deviceId, label, at: now, expires: now + CLAIM_TTL_MS };
    list.push(c);
    CLAIMS.set(this.#key, list);
    return { ok: true, claim: c.id };
  }

  /** A live claim of this device (not expired, not used up by a finished turn). */
  liveClaim(id: string, deviceId: string): { label: string } | undefined {
    const now = this.#now().getTime();
    const c = (CLAIMS.get(this.#key) ?? []).find((x) => x.id === id);
    return c && c.deviceId === deviceId && !c.done && c.expires > now ? { label: c.label } : undefined;
  }

  endClaim(id: string): void {
    const c = (CLAIMS.get(this.#key) ?? []).find((x) => x.id === id);
    if (c) c.done = true;
  }
}

/** The length of a 16-bit PCM WAV in seconds (from its header), or undefined when it isn't one. */
export function wavSeconds(b: Buffer): number | undefined {
  if (b.length < 44 || b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return undefined;
  let p = 12;
  let byteRate = 0;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ' && p + 16 <= b.length) byteRate = b.readUInt32LE(p + 16);
    if (id === 'data') return byteRate ? Math.min(size, b.length - p - 8) / byteRate : undefined;
    p += 8 + size + (size % 2);
  }
  return undefined;
}

/** §5.5 4.3: her reply as it is spoken: plain words, cut at the last sentence before 1,200 characters. */
export function spokenReply(text: string, clean: (t: string) => string): { text: string; more: boolean } {
  const s = clean(text).trim();
  if (s.length <= 1200) return { text: s, more: false };
  const cut = s.slice(0, 1200);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return { text: (end > 200 ? cut.slice(0, end + 1) : cut).trim(), more: true };
}
