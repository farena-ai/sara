// Phase 109 (CH3, docs/design/CHATS.md §6.7): the title evals. 40 invented sessions
// (evals/titles/sessions.json) are stored in a throwaway companion, named by the real code path
// (src/titles.ts `retitle`: the trigger, the cheap call, the output checks), and scored in code:
//   - topic: her first title has one of the session's topic words (≥ 85 %);
//   - change: sessions that move to a new topic get a new title after it, at /new (≥ 80 %),
//     and the code check sees the move (reported);
//   - sensitive: no title shows a health or intimate word (100 %);
//   - people: no title names a third person (100 %);
//   - language: no title is in another language than the session's (≥ 95 %).
// scripts/eval-titles.ts runs it against a model; test/phase109.test.ts with a fake one.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AppContext } from './chat.ts';
import { EventHub } from './events.ts';
import { detectLanguage, type Lang } from './i18n.ts';
import { loadPersona } from './persona.ts';
import type { Provider, ProviderConfig } from './providers/types.ts';
import { Redactor } from './redact.ts';
import { SettingsStore } from './settings.ts';
import { Store } from './store.ts';
import { fold, openingTitle, retitle, sensitiveWord, topicMoved } from './titles.ts';
import { Vault } from './vault.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const TITLE_SET = join(ROOT, 'evals', 'titles', 'sessions.json');

export interface EvalSession {
  id: string;
  lang: Lang;
  kind: 'plain' | 'change' | 'partner' | 'sensitive';
  topics: string[];
  lines: string[];
  after?: string[];
  lines2?: string[];
  people: string[];
  partner?: string;
  avoid: string[];
}

export interface SessionResult {
  id: string;
  lang: Lang;
  kind: EvalSession['kind'];
  first: string;
  firstChanged: boolean;
  topic: boolean;
  second?: string;
  changed?: boolean;
  secondTopic?: boolean;
  codeSawMove?: boolean;
  sensitiveShown?: string;
  personNamed?: string;
  wrongLanguage?: string;
  skipped?: string[];
}

export interface TitleScore {
  sessions: number;
  topic: number;
  change: number;
  changeMatched: number;
  codeCheck: number;
  sensitive: number;
  people: number;
  language: number;
  pass: boolean;
  targets: { topic: 0.85; change: 0.8; sensitive: 1; people: 1; language: 0.95 };
}

export function loadTitleSet(path = TITLE_SET): { owner: string; sessions: EvalSession[] } {
  return JSON.parse(readFileSync(path, 'utf8')) as { owner: string; sessions: EvalSession[] };
}

/** A topic word matches a title word when they start alike (5 letters, or the whole shorter word). */
export function matchesTopic(title: string, topics: string[]): boolean {
  const words = fold(title).split(/[^\p{L}]+/u).filter((w) => w.length >= 3);
  return topics.some((t) => {
    const f = fold(t);
    const k = Math.min(5, f.length);
    return words.some((w) => w.length >= Math.min(k, 3) && w.slice(0, k) === f.slice(0, k));
  });
}

/** A throwaway companion for one eval run (its own data folder; removed by `close`). */
function evalApp(provider: { config: ProviderConfig; make: (config: ProviderConfig) => Provider }, owner: string): { app: AppContext; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'sara-title-evals-'));
  const vault = new Vault(dir);
  const settings = new SettingsStore(dir);
  settings.update({ providers: [provider.config], defaultProviderId: provider.config.id, defaultModel: provider.config.defaultModel, ownerName: owner, language: 'en', talkLanguage: 'auto', chats: { titles: { auto: true, model: 'local', dailyCap: 200 } } } as never);
  const store = new Store(join(dir, 'sara.db'));
  const app = {
    store,
    settings,
    vault,
    persona: loadPersona(join(ROOT, 'persona', 'sara.json')),
    now: () => new Date(),
    dataDir: dir,
    redactor: new Redactor(() => []),
    events: new EventHub(),
    providerFactory: (c: ProviderConfig) => provider.make(c),
  } as unknown as AppContext;
  return {
    app,
    close: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs the set through the real retitle path and scores it. */
export async function runTitleEvals(opts: { provider: ProviderConfig; make: (config: ProviderConfig) => Provider; sessions?: EvalSession[]; owner?: string; onSession?: (r: SessionResult) => void }): Promise<{ score: TitleScore; results: SessionResult[] }> {
  const set = opts.sessions ? { owner: opts.owner ?? 'Alex', sessions: opts.sessions } : loadTitleSet();
  const { app, close } = evalApp({ config: opts.provider, make: opts.make }, set.owner);
  const results: SessionResult[] = [];
  try {
    for (const s of set.sessions) {
      const partner = s.partner ?? null;
      const conv = app.store.createConversation(partner ? { title: `Telegram: ${partner}`, titleSource: 'placeholder', channel: 'telegram', channelKey: s.id, partner } : { title: openingTitle(s.lines[0]), titleSource: 'placeholder' });
      s.lines.forEach((l, i) => app.store.addMessage(conv.id, i % 2 ? 'assistant' : 'user', l));
      const skipped: string[] = [];
      const r1 = await retitle(app, conv.id);
      if (r1.skipped) skipped.push(`first:${r1.skipped}`);
      const first = app.store.getConversation(conv.id)!.title;
      const res: SessionResult = { id: s.id, lang: s.lang, kind: s.kind, first, firstChanged: r1.changed, topic: r1.changed && matchesTopic(first, s.topics) };
      const titles = [first];
      if (s.lines2?.length && s.after) {
        res.codeSawMove = topicMoved(first, s.lines2.join('\n'));
        s.lines2.forEach((l, i) => app.store.addMessage(conv.id, i % 2 ? 'assistant' : 'user', l));
        const r2 = await retitle(app, conv.id, { atNew: true });
        if (r2.skipped) skipped.push(`new:${r2.skipped}`);
        const second = app.store.getConversation(conv.id)!.title;
        res.second = second;
        res.changed = r2.changed && fold(second) !== fold(first);
        res.secondTopic = res.changed && matchesTopic(second, s.after);
        titles.push(second);
      }
      for (const t of titles) {
        const sw = sensitiveWord(t) ?? s.avoid.find((a) => fold(t).includes(fold(a)));
        if (sw) res.sensitiveShown = sw;
        const named = s.people.find((p) => new RegExp(`(?<![\\p{L}])${fold(p)}(?![\\p{L}])`, 'u').test(fold(t)));
        if (named) res.personNamed = named;
        const lang = wrongLanguage(t, s.lang);
        if (lang) res.wrongLanguage = lang;
      }
      if (skipped.length) res.skipped = skipped;
      results.push(res);
      opts.onSession?.(res);
    }
  } finally {
    close();
  }
  return { score: scoreTitles(results), results };
}

const EN_SMALL = new Set(['the', 'and', 'for', 'of', 'with', 'to', 'at', 'on', 'an', 'your', 'my', 'how', 'from']);
const OWN_SMALL: Record<string, string[]> = { es: ['de', 'del', 'la', 'el', 'y', 'para', 'con', 'en', 'los', 'las', 'un', 'una'], fr: ['de', 'du', 'la', 'le', 'les', 'et', 'pour', 'avec', 'en', 'un', 'une', 'des', 'au'], de: ['der', 'die', 'das', 'und', 'für', 'mit', 'im', 'zum', 'zur', 'ein', 'eine', 'einer', 'nach', 'von'], 'pt-BR': ['de', 'do', 'da', 'e', 'para', 'com', 'em', 'um', 'uma', 'no', 'na', 'os', 'as'], it: ['di', 'del', 'della', 'la', 'il', 'e', 'per', 'con', 'in', 'un', 'una', 'dal', 'dei'] };

/** The language a title is clearly in when it isn't the session's (undefined = fine, or can't tell). */
export function wrongLanguage(title: string, lang: Lang): string | undefined {
  const words = fold(title).split(/[^\p{L}]+/u).filter(Boolean);
  const detected = words.length >= 3 ? detectLanguage(title) : undefined;
  if (detected && detected !== lang) return detected;
  if (lang === 'en') return undefined;
  const own = new Set(OWN_SMALL[lang] ?? []);
  if (words.some((w) => EN_SMALL.has(w)) && !words.some((w) => own.has(w))) return 'en';
  return undefined;
}

export function scoreTitles(results: SessionResult[]): TitleScore {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const share = (rows: SessionResult[], ok: (r: SessionResult) => boolean) => (rows.length ? r3(rows.filter(ok).length / rows.length) : 1);
  const changes = results.filter((r) => r.second !== undefined);
  const sens = results.filter((r) => r.kind === 'sensitive');
  const score: TitleScore = {
    sessions: results.length,
    topic: share(results, (r) => r.topic),
    change: share(changes, (r) => Boolean(r.changed)),
    changeMatched: share(changes, (r) => Boolean(r.secondTopic)),
    codeCheck: share(changes, (r) => Boolean(r.codeSawMove)),
    sensitive: share(sens.length ? results : [], (r) => !r.sensitiveShown),
    people: share(results, (r) => !r.personNamed),
    language: share(results, (r) => !r.wrongLanguage),
    pass: false,
    targets: { topic: 0.85, change: 0.8, sensitive: 1, people: 1, language: 0.95 },
  };
  score.pass = score.topic >= 0.85 && score.change >= 0.8 && score.sensitive >= 1 && score.people >= 1 && score.language >= 0.95;
  return score;
}
