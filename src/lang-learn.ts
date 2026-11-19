// W4.3 (docs/LANGUAGE_PRACTICE.md): language practice. Pick the language you're learning
// (es/fr/de/pt/it/en) and a level; each day a short session mixes spaced-repetition cards (the U4.23
// study engine: one study set per language and level, SM-2, Today tile and reminders as before),
// listening (she says a sentence in the local voice for that language, V4.2 `voiceForLang`) and
// speaking practice (you say it back; the W0.3 multilingual hearing on this computer hears it and
// it is scored word by word with a gentle tip). Talk practice = Talk with Sara in a practice chat
// whose system note keeps her at your level (src/lang-learn-note.ts). Progress (streak, words known)
// is per person in <dataDir>/lang-learn.json. Local voices and hearing only: never cloud audio.
import type { AppContext } from './chat.ts';
import { en, trOwner } from './i18n.ts';
import { voiceForLang } from './interpreter.ts';
import { LANG_NAME, LEARN_LANGS, LEARN_LEVELS, readLearn, writeLearn, type LearnLang, type LearnLevel, type LearnState } from './lang-learn-note.ts';
import { studyFor, type Card } from './study.ts';

export { LEARN_LANGS, LEARN_LEVELS, type LearnLang, type LearnLevel };

export interface Phrase extends Record<LearnLang, string> {
  id: string;
  level: LearnLevel;
}

/** A small built-in sentence bank: the same everyday sentence in all six languages, by level. */
const P = (id: string, en: string, es: string, fr: string, de: string, pt: string, it: string): Phrase => ({ id, level: id.slice(0, 2) as LearnLevel, en, es, fr, de, pt, it });
export const PHRASES: Phrase[] = [
  P('a1-1', 'Good morning, how are you?', 'Buenos días, ¿cómo estás?', 'Bonjour, comment ça va ?', 'Guten Morgen, wie geht es dir?', 'Bom dia, como você está?', 'Buongiorno, come stai?'),
  P('a1-2', 'My name is Ana.', 'Me llamo Ana.', "Je m'appelle Ana.", 'Ich heiße Ana.', 'Meu nome é Ana.', 'Mi chiamo Ana.'),
  P('a1-3', 'I would like a coffee, please.', 'Quisiera un café, por favor.', "Je voudrais un café, s'il vous plaît.", 'Ich hätte gern einen Kaffee, bitte.', 'Eu queria um café, por favor.', 'Vorrei un caffè, per favore.'),
  P('a1-4', 'Where is the train station?', '¿Dónde está la estación de tren?', 'Où est la gare ?', 'Wo ist der Bahnhof?', 'Onde fica a estação de trem?', "Dov'è la stazione?"),
  P('a1-5', "I don't understand. Can you repeat that?", 'No entiendo. ¿Puede repetirlo?', 'Je ne comprends pas. Vous pouvez répéter ?', 'Ich verstehe nicht. Können Sie das wiederholen?', 'Não entendo. Pode repetir?', 'Non capisco. Può ripetere?'),
  P('a1-6', 'How much does it cost?', '¿Cuánto cuesta?', 'Combien ça coûte ?', 'Wie viel kostet das?', 'Quanto custa?', 'Quanto costa?'),
  P('a1-7', 'Thank you very much, see you tomorrow.', 'Muchas gracias, hasta mañana.', 'Merci beaucoup, à demain.', 'Vielen Dank, bis morgen.', 'Muito obrigado, até amanhã.', 'Grazie mille, a domani.'),
  P('a1-8', 'I have a brother and a sister.', 'Tengo un hermano y una hermana.', "J'ai un frère et une sœur.", 'Ich habe einen Bruder und eine Schwester.', 'Eu tenho um irmão e uma irmã.', 'Ho un fratello e una sorella.'),
  P('a2-1', 'Yesterday I went to the market with my friend.', 'Ayer fui al mercado con mi amiga.', 'Hier, je suis allé au marché avec mon ami.', 'Gestern bin ich mit meinem Freund auf den Markt gegangen.', 'Ontem eu fui ao mercado com meu amigo.', 'Ieri sono andato al mercato con il mio amico.'),
  P('a2-2', 'What time does the next bus leave?', '¿A qué hora sale el próximo autobús?', 'À quelle heure part le prochain bus ?', 'Wann fährt der nächste Bus?', 'A que horas sai o próximo ônibus?', 'A che ora parte il prossimo autobus?'),
  P('a2-3', 'I usually cook dinner at home.', 'Normalmente preparo la cena en casa.', "D'habitude, je prépare le dîner à la maison.", 'Normalerweise koche ich zu Hause das Abendessen.', 'Normalmente eu faço o jantar em casa.', 'Di solito preparo la cena a casa.'),
  P('a2-4', 'Can you recommend a good restaurant near here?', '¿Puede recomendarme un buen restaurante cerca de aquí?', "Vous pouvez me recommander un bon restaurant près d'ici ?", 'Können Sie mir ein gutes Restaurant in der Nähe empfehlen?', 'Você pode me recomendar um bom restaurante perto daqui?', 'Mi può consigliare un buon ristorante qui vicino?'),
  P('a2-5', "The weather is nice today, let's go for a walk.", 'Hoy hace buen tiempo, vamos a dar un paseo.', "Il fait beau aujourd'hui, allons nous promener.", 'Heute ist schönes Wetter, lass uns spazieren gehen.', 'Hoje o tempo está bom, vamos dar uma caminhada.', 'Oggi fa bel tempo, andiamo a fare una passeggiata.'),
  P('a2-6', "I'm looking for a gift for my mother.", 'Busco un regalo para mi madre.', 'Je cherche un cadeau pour ma mère.', 'Ich suche ein Geschenk für meine Mutter.', 'Estou procurando um presente para minha mãe.', 'Cerco un regalo per mia madre.'),
  P('a2-7', 'We have been living here for two years.', 'Vivimos aquí desde hace dos años.', 'Nous habitons ici depuis deux ans.', 'Wir wohnen seit zwei Jahren hier.', 'Moramos aqui há dois anos.', 'Abitiamo qui da due anni.'),
  P('a2-8', "I'm tired because I worked a lot.", 'Estoy cansado porque trabajé mucho.', "Je suis fatigué parce que j'ai beaucoup travaillé.", 'Ich bin müde, weil ich viel gearbeitet habe.', 'Estou cansado porque trabalhei muito.', 'Sono stanco perché ho lavorato molto.'),
  P('b1-1', 'If I had more time, I would learn to play the guitar.', 'Si tuviera más tiempo, aprendería a tocar la guitarra.', "Si j'avais plus de temps, j'apprendrais à jouer de la guitare.", 'Wenn ich mehr Zeit hätte, würde ich Gitarre spielen lernen.', 'Se eu tivesse mais tempo, aprenderia a tocar violão.', 'Se avessi più tempo, imparerei a suonare la chitarra.'),
  P('b1-2', "I think it's important to protect the environment.", 'Creo que es importante proteger el medio ambiente.', "Je pense qu'il est important de protéger l'environnement.", 'Ich finde, es ist wichtig, die Umwelt zu schützen.', 'Acho que é importante proteger o meio ambiente.', "Penso che sia importante proteggere l'ambiente."),
  P('b1-3', 'Although it was raining, we decided to go out.', 'Aunque llovía, decidimos salir.', 'Même s\'il pleuvait, nous avons décidé de sortir.', 'Obwohl es regnete, haben wir beschlossen, rauszugehen.', 'Embora estivesse chovendo, decidimos sair.', 'Anche se pioveva, abbiamo deciso di uscire.'),
  P('b1-4', 'Could you tell me how to get to the museum?', '¿Podría decirme cómo llegar al museo?', 'Pourriez-vous me dire comment aller au musée ?', 'Könnten Sie mir sagen, wie ich zum Museum komme?', 'Você poderia me dizer como chegar ao museu?', 'Potrebbe dirmi come arrivare al museo?'),
  P('b1-5', "I've been working on this project since last spring.", 'Trabajo en este proyecto desde la primavera pasada.', 'Je travaille sur ce projet depuis le printemps dernier.', 'Ich arbeite seit letztem Frühling an diesem Projekt.', 'Trabalho neste projeto desde a primavera passada.', 'Lavoro a questo progetto dalla primavera scorsa.'),
  P('b1-6', 'It would be great if we could meet next week.', 'Sería genial si pudiéramos vernos la semana que viene.', 'Ce serait super si on pouvait se voir la semaine prochaine.', 'Es wäre toll, wenn wir uns nächste Woche treffen könnten.', 'Seria ótimo se pudéssemos nos encontrar na semana que vem.', 'Sarebbe bello se potessimo vederci la settimana prossima.'),
  P('b1-7', 'In my opinion, the book is better than the film.', 'En mi opinión, el libro es mejor que la película.', 'À mon avis, le livre est meilleur que le film.', 'Meiner Meinung nach ist das Buch besser als der Film.', 'Na minha opinião, o livro é melhor que o filme.', 'Secondo me, il libro è meglio del film.'),
  P('b1-8', "I'm sorry I'm late, there was a lot of traffic.", 'Perdón por llegar tarde, había mucho tráfico.', 'Désolé d\'être en retard, il y avait beaucoup de circulation.', 'Entschuldigung für die Verspätung, es war viel Verkehr.', 'Desculpe o atraso, tinha muito trânsito.', 'Scusa il ritardo, c\'era molto traffico.'),
];

export const LEARN_LINES = [
  en('Pick a language from the list.'),
  en('Pick a level from the list.'),
  en('Pick a language to learn first.'),
  en('That sentence was not found.'),
  en('Every word was right. Lovely!'),
  en('Very close. Listen to {words} once more and say it again.'),
  en('Good try. Listen once more, then say it slowly, one piece at a time.'),
  en('I did not hear any words. Try again a little closer to the microphone.'),
  en('No voice for this language on this computer yet. Add one in Settings → Voice.'),
  en('Hearing in this language is not installed on this computer yet. Add it in Settings → Voice.'),
  en('Voice is turned off for you on this server.'),
  en('Practice: {lang}'),
];

export class LearnError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The person's own language for meanings: the app language when it is not the one being learned. */
function meaningLang(target: LearnLang, ui: string | undefined): LearnLang {
  const u = String(ui ?? '').slice(0, 2).toLowerCase() as LearnLang;
  if (LEARN_LANGS.includes(u) && u !== target) return u;
  return target === 'en' ? 'es' : 'en';
}

export function phrasesFor(lang: LearnLang, level: LearnLevel, ui?: string): { id: string; text: string; meaning: string }[] {
  const m = meaningLang(lang, ui);
  return PHRASES.filter((p) => p.level === level).map((p) => ({ id: p.id, text: p[lang], meaning: p[m] }));
}

// ------------------------------------------------------------------ scoring what was said
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').replace(/œ/g, 'oe');
const wordsOf = (s: string) => (s.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []);
function dist(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}
const near = (a: string, b: string) => dist(a, b) <= Math.max(1, Math.ceil(a.length / 3));

export interface WordMark {
  w: string;
  mark: 'ok' | 'close' | 'missed';
  heard?: string;
}
export interface SaidScore {
  words: WordMark[];
  pct: number;
  /** An en() key (the web shows t(feedback, params)). */
  feedback: string;
  params?: Record<string, string>;
  heard: string;
}

/** Word by word: the sentence's words lined up with what was heard (accents and case forgiven). */
export function scoreSaid(want: string, said: string): SaidScore {
  const w = wordsOf(want);
  const h = wordsOf(said);
  const fw = w.map(fold);
  const fh = h.map(fold);
  // Longest common subsequence on exact (folded) words.
  const L = Array.from({ length: w.length + 1 }, () => new Array<number>(h.length + 1).fill(0));
  for (let i = w.length - 1; i >= 0; i--) for (let j = h.length - 1; j >= 0; j--) L[i][j] = fw[i] === fh[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const pair = new Array<number>(w.length).fill(-1);
  for (let i = 0, j = 0; i < w.length && j < h.length; ) {
    if (fw[i] === fh[j]) {
      pair[i] = j;
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  const words: WordMark[] = w.map((x) => ({ w: x, mark: 'missed' }));
  pair.forEach((j, i) => {
    if (j >= 0) words[i].mark = 'ok';
  });
  // Between two matched words, an unmatched heard word near an unmatched wanted word = close.
  const used = new Set(pair.filter((j) => j >= 0));
  for (let i = 0; i < w.length; i++) {
    if (pair[i] >= 0) continue;
    const lo = Math.max(-1, ...pair.slice(0, i).filter((j) => j >= 0));
    const after = pair.slice(i + 1).find((j) => j >= 0);
    const hi = after === undefined ? h.length : after;
    for (let j = lo + 1; j < hi; j++) {
      if (used.has(j) || !near(fw[i], fh[j])) continue;
      used.add(j);
      words[i] = { w: w[i], mark: 'close', heard: h[j] };
      break;
    }
  }
  const ok = words.filter((x) => x.mark === 'ok').length;
  const close = words.filter((x) => x.mark === 'close').length;
  const pct = w.length ? Math.round(((ok + close * 0.5) / w.length) * 100) : 0;
  const feedback = !h.length
    ? en('I did not hear any words. Try again a little closer to the microphone.')
    : pct === 100
      ? en('Every word was right. Lovely!')
      : pct >= 70
        ? en('Very close. Listen to {words} once more and say it again.')
        : en('Good try. Listen once more, then say it slowly, one piece at a time.');
  const off = words.filter((x) => x.mark !== 'ok').slice(0, 3).map((x) => `“${x.w}”`).join(', ');
  return { words, pct, feedback, ...(pct >= 70 && pct < 100 && h.length ? { params: { words: off } } : {}), heard: said.trim() };
}

// ------------------------------------------------------------------ the engine
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nativeName = (l: LearnLang) => {
  try {
    return new Intl.DisplayNames([l], { type: 'language' }).of(l) ?? LANG_NAME[l];
  } catch {
    return LANG_NAME[l];
  }
};

type Voice = { available?: { stt: boolean; tts: boolean }; voices?: () => { id: string; label: string }[]; streamingReady?: (lang?: string) => boolean; warm?: (voiceId?: string, o?: { streaming?: boolean; lang?: string }) => Promise<boolean>; transcribe: (wav: Buffer, o?: { lang?: string }) => Promise<string>; speak: (text: string, id: string, speed?: number) => Promise<{ data: Buffer; type: string }> };

export class LangLearn {
  readonly #app: AppContext;
  constructor(app: AppContext) {
    this.#app = app;
  }
  #ui(): string | undefined {
    return this.#app.settings.get().language || undefined;
  }
  #voice(): Voice | undefined {
    return this.#app.voice as unknown as Voice | undefined;
  }
  #voiceAllowed(): boolean {
    const m = this.#app.member as { limits?: () => { voice?: boolean } } | undefined;
    return !(m && typeof m.limits === 'function' && m.limits().voice === false);
  }
  /** What this computer can do for a language: a local voice, local hearing, words as you speak. */
  local(lang: LearnLang | null): { voice: boolean; hearing: boolean; live: boolean } {
    const v = this.#voice();
    if (!lang || !v || !this.#voiceAllowed()) return { voice: false, hearing: false, live: false };
    const live = Boolean(v.streamingReady?.(lang));
    return {
      voice: Boolean(v.available?.tts && voiceForLang(v.voices?.() ?? [], lang)),
      // Whole-sentence local hearing is English only (Parakeet); other languages need the W0.3 model.
      hearing: Boolean(v.available?.stt && (lang === 'en' || live)),
      live,
    };
  }
  #setFor(s: LearnState, lang: LearnLang, level: LearnLevel): number {
    const study = studyFor(this.#app);
    const key = `${lang}:${level}`;
    const have = s.sets[key];
    if (have && study.get(have)) return have;
    const set = study.importCards(`${nativeName(lang)} · ${level.toUpperCase()}`, phrasesFor(lang, level, this.#ui()).map((p) => ({ kind: 'basic' as const, front: p.text, back: p.meaning })));
    s.sets[key] = set.id;
    return set.id;
  }
  setup(o: { lang?: unknown; level?: unknown; daily?: unknown }): ReturnType<LangLearn['view']> {
    const s = readLearn(this.#app);
    if (o.lang !== undefined) {
      if (!LEARN_LANGS.includes(o.lang as LearnLang)) throw new LearnError(400, en('Pick a language from the list.'));
      s.lang = o.lang as LearnLang;
    }
    if (o.level !== undefined) {
      if (!LEARN_LEVELS.includes(o.level as LearnLevel)) throw new LearnError(400, en('Pick a level from the list.'));
      s.level = o.level as LearnLevel;
    }
    if ([5, 10, 20].includes(Number(o.daily))) s.daily = Number(o.daily);
    if (s.lang) this.#setFor(s, s.lang, s.level);
    writeLearn(this.#app, s);
    return this.view();
  }
  #must(): LearnState & { lang: LearnLang } {
    const s = readLearn(this.#app);
    if (!s.lang) throw new LearnError(400, en('Pick a language to learn first.'));
    return s as LearnState & { lang: LearnLang };
  }
  progress(s: LearnState = readLearn(this.#app)): { streak: number; days: number; wordsKnown: number; saidToday: number; cardsLearned: number; cards: number } {
    const study = studyFor(this.#app);
    const today = study.today();
    const empty = { streak: 0, days: 0, wordsKnown: 0, saidToday: 0, cardsLearned: 0, cards: 0 };
    if (!s.lang) return empty;
    const setId = s.sets[`${s.lang}:${s.level}`];
    const days = new Set(s.days);
    const known = new Set(Object.keys(s.words[s.lang] ?? {}));
    let cards: Card[] = [];
    if (setId && study.get(setId)) {
      cards = study.cards(setId);
      for (const c of cards) if (c.reps >= 2) for (const w of wordsOf(c.front)) known.add(fold(w));
      // Card reviews count as practice days too (the study log of that set).
      const db = this.#app.store.db;
      for (const r of db.prepare('SELECT DISTINCT day FROM study_log WHERE set_id = ?').all(setId) as { day: string }[]) days.add(r.day);
    }
    let streak = 0;
    for (let d = days.has(today) ? today : addDays(today, -1); days.has(d); d = addDays(d, -1)) streak++;
    return { streak, days: days.size, wordsKnown: known.size, saidToday: s.saidOn[today] ?? 0, cardsLearned: cards.filter((c) => c.reps >= 2).length, cards: cards.length };
  }
  /** Today's short session: due cards, three sentences to listen to and three to say. */
  view(): { prefs: { lang: LearnLang | null; level: LearnLevel; daily: number }; langs: LearnLang[]; levels: LearnLevel[]; progress: ReturnType<LangLearn['progress']>; local: ReturnType<LangLearn['local']>; session: { setId: number | null; cards: Card[]; listen: { id: string; text: string; meaning: string }[]; speak: { id: string; text: string; meaning: string }[] } } {
    const s = readLearn(this.#app);
    const base = { prefs: { lang: s.lang, level: s.level, daily: s.daily }, langs: [...LEARN_LANGS], levels: [...LEARN_LEVELS], progress: this.progress(s), local: this.local(s.lang) };
    if (!s.lang) return { ...base, session: { setId: null, cards: [], listen: [], speak: [] } };
    const setId = s.sets[`${s.lang}:${s.level}`] ?? null;
    const study = studyFor(this.#app);
    const cards = setId && study.get(setId) ? study.queue(setId, s.daily) : [];
    // Least-said sentences first, a different start each day so the mix changes.
    const said = s.said[s.lang] ?? {};
    const all = phrasesFor(s.lang, s.level, this.#ui());
    const day = Number(study.today().replace(/-/g, '')) % all.length;
    const order = all.map((p, i) => ({ p, k: (said[p.id] ?? 0) * 100 + ((i - day + all.length) % all.length) })).sort((a, b) => a.k - b.k).map((x) => x.p);
    return { ...base, session: { setId, cards, listen: order.slice(3, 6).length === 3 ? order.slice(3, 6) : order.slice(0, 3), speak: order.slice(0, 3) } };
  }
  /** What was heard for a sentence: scored word by word; words said right count as known. */
  score(id: string, said: string): { result: SaidScore; progress: ReturnType<LangLearn['progress']> } {
    const s = this.#must();
    const p = PHRASES.find((x) => x.id === id);
    if (!p) throw new LearnError(404, en('That sentence was not found.'));
    const result = scoreSaid(p[s.lang], String(said ?? '').slice(0, 1000));
    const today = studyFor(this.#app).today();
    if (result.heard) {
      const words = (s.words[s.lang] ??= {});
      for (const w of result.words) if (w.mark === 'ok') words[fold(w.w)] = (words[fold(w.w)] ?? 0) + 1;
      const n = (s.said[s.lang] ??= {});
      n[id] = (n[id] ?? 0) + 1;
      s.saidOn[today] = (s.saidOn[today] ?? 0) + 1;
      for (const d of Object.keys(s.saidOn)) if (d < addDays(today, -60)) delete s.saidOn[d];
      if (!s.days.includes(today)) s.days = [...s.days, today].slice(-400);
      writeLearn(this.#app, s);
    }
    return { result, progress: this.progress(s) };
  }
  /** The practice chat for Talk (one per language; her system note keeps her at the level). */
  talkConversation(): string {
    const s = this.#must();
    const have = s.talk[s.lang];
    if (have && this.#app.store.getConversation(have)) return have;
    const title = trOwner(en('Practice: {lang}'), this.#app.settings.get(), { lang: nativeName(s.lang) });
    const c = this.#app.store.createConversation({ title, titleSource: 'user' } as never);
    s.talk[s.lang] = c.id;
    writeLearn(this.#app, s);
    return c.id;
  }
  /** Her local voice for the language being learned (never a cloud voice). */
  async say(text: string, lang: LearnLang | null = readLearn(this.#app).lang, speed = 1): Promise<{ data: Buffer; type: string }> {
    if (!this.#voiceAllowed()) throw new LearnError(403, en('Voice is turned off for you on this server.'));
    const v = this.#voice();
    const id = lang && v?.available?.tts ? voiceForLang(v.voices?.() ?? [], lang) : undefined;
    if (!v || !id) throw new LearnError(409, en('No voice for this language on this computer yet. Add one in Settings → Voice.'));
    return v.speak(text.slice(0, 600), id, speed);
  }
  /** Loads the language's local voice and hearing now, so the first sentence doesn't wait for them. */
  warm(): boolean {
    const s = readLearn(this.#app);
    const v = this.#voice();
    const loc = this.local(s.lang);
    if (!s.lang || !v?.warm || !(loc.voice || loc.hearing)) return false;
    void v.warm(voiceForLang(v.voices?.() ?? [], s.lang), { streaming: loc.live, lang: s.lang }).catch(() => undefined);
    return true;
  }
  /** Local hearing in the language being learned (W0.3 multilingual model for es/fr/de/pt/it). */
  async hear(wav: Buffer, lang: LearnLang | null = readLearn(this.#app).lang): Promise<string> {
    if (!this.#voiceAllowed()) throw new LearnError(403, en('Voice is turned off for you on this server.'));
    if (!lang || !this.local(lang).hearing) throw new LearnError(409, en('Hearing in this language is not installed on this computer yet. Add it in Settings → Voice.'));
    return (await this.#voice()!.transcribe(wav, { lang })).trim();
  }
}

const ENGINES = new WeakMap<AppContext, LangLearn>();
export function langLearnFor(app: AppContext): LangLearn {
  let e = ENGINES.get(app);
  if (!e) ENGINES.set(app, (e = new LangLearn(app)));
  return e;
}
export const learnLang = (v: unknown): LearnLang | null => (LEARN_LANGS.includes(String(v ?? '').slice(0, 2).toLowerCase() as LearnLang) ? (String(v).slice(0, 2).toLowerCase() as LearnLang) : null);
