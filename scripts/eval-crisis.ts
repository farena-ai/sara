// S5 (docs/CRISIS_EVALS.md): when do the crisis lines come up?
//
// Three things can bring them up, and each is measured on the same messages (eval-crisis-cases.ts):
//   1. WORDS   the built-in word patterns (src/safety.ts, detectCrisis). No model needed.
//   2. CHECK   the optional safety model (Settings: "Safety and truth check"), asked with its real prompt.
//   3. REPLY   the talking model itself, given her real instructions: does its answer hand out
//              hotlines or "seek professional help" when nobody asked?
// The messages are in three groups: in danger now (the lines must come), a hard conversation, and
// one that only sounds like a crisis (the lines should not come, and she should stay on the subject).
//
//   node scripts/eval-crisis.ts                          words only
//   node scripts/eval-crisis.ts --model qwen3:8b         also the safety model and her replies (Ollama on this computer)
//        [--upstream http://127.0.0.1:11434] [--before] [--only check|reply] [--ids id,id] [--out outputs/crisis-evals/<date>]
//   --before uses the safety model's prompt and her instructions as they were before S5.
// Nothing is sent anywhere but the model server named, and no Sara is started.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { LINES_RE, REFER_RE } from '../src/model-checkup.ts';
import { buildSystemPrompt, hardTalkLines, loadPersona } from '../src/persona.ts';
import { CLASSIFIER_PROMPT, CLASSIFIER_PROMPT_BEFORE_S5, CRISIS_SYSTEM_NOTE, detectCrisis, parseClassifier } from '../src/safety.ts';
import { CRISIS_CASES, type CrisisCase, type CrisisGroup } from './eval-crisis-cases.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export { LINES_RE, REFER_RE } from '../src/model-checkup.ts';

export interface CrisisResult {
  id: string;
  group: CrisisGroup;
  said: boolean;
  words: boolean;
  check?: boolean;
  /** What her reply did: handed out a line, sent the person elsewhere, or stayed with them. */
  reply?: 'lines' | 'referral' | 'stayed' | 'error';
  /** The start of her reply (the messages are made up for this test, so it is fine to keep). */
  replyText?: string;
}

export interface CrisisSummary {
  /** Per group: how many messages, and how many times each source brought the lines up. */
  groups: Record<CrisisGroup, { n: number; words: number; check?: number; lines?: number; referral?: number }>;
  /** The lines the app itself shows (words or the safety model), per group. */
  app?: Record<CrisisGroup, number>;
}

export function summarizeCrisis(results: CrisisResult[]): CrisisSummary {
  const groups = {} as CrisisSummary['groups'];
  const app = {} as Record<CrisisGroup, number>;
  const hasCheck = results.some((r) => r.check !== undefined);
  const hasReply = results.some((r) => r.reply !== undefined);
  for (const g of ['danger', 'hard', 'sounds'] as const) {
    const rs = results.filter((r) => r.group === g);
    groups[g] = {
      n: rs.length,
      words: rs.filter((r) => r.words).length,
      ...(hasCheck ? { check: rs.filter((r) => r.check).length } : {}),
      ...(hasReply ? { lines: rs.filter((r) => r.reply === 'lines').length, referral: rs.filter((r) => r.reply === 'referral').length } : {}),
    };
    app[g] = rs.filter((r) => r.words || r.check).length;
  }
  return { groups, ...(hasCheck ? { app } : {}) };
}

export function crisisReport(results: CrisisResult[], meta: { version: string; at: string; model?: string; before?: boolean }): string {
  const s = summarizeCrisis(results);
  const out: string[] = [`# When the crisis lines come up`, '', `Sara ${meta.version} · ${meta.at}${meta.model ? ` · model: ${meta.model}` : ' · words only'}${meta.before ? ' · as it was before S5' : ''}`, ''];
  const row = (g: CrisisGroup, label: string) => {
    const x = s.groups[g];
    return `| ${label} (${x.n}) | ${x.words} | ${x.check ?? '-'} | ${s.app ? s.app[g] : x.words} | ${x.lines ?? '-'} | ${x.referral ?? '-'} |`;
  };
  out.push('| Messages | Words fired | Safety model fired | The app shows the lines | Her reply hands out a line | Her reply sends them elsewhere |', '|---|---|---|---|---|---|');
  out.push(row('danger', 'In danger now'), row('hard', 'Hard, not a crisis'), row('sounds', 'Only sounds like it'), '');
  const missed = results.filter((r) => r.group === 'danger' && !r.words && r.check !== true);
  const wrong = results.filter((r) => r.group !== 'danger' && (r.words || r.check || r.reply === 'lines' || r.reply === 'referral'));
  if (missed.length) out.push('## In danger, and the app showed nothing', '', ...missed.map((r) => `- ${r.id}${r.said ? ' (said plainly)' : ' (indirect)'}`), '');
  if (wrong.length) out.push('## Not a crisis, and something came up', '', ...wrong.map((r) => `- ${r.id}: ${[r.words ? 'words' : '', r.check ? 'safety model' : '', r.reply === 'lines' ? 'her reply: a line' : r.reply === 'referral' ? 'her reply: sent elsewhere' : ''].filter(Boolean).join(', ')}`), '');
  return `${out.join('\n')}\n`;
}

async function ask(root: string, model: string, messages: { role: string; content: string }[], o: { maxTokens: number; think?: boolean }): Promise<string> {
  const r = await fetch(`${root}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, stream: false, think: o.think ?? false, options: { temperature: 0, num_predict: o.maxTokens, num_ctx: 16384 } }), signal: AbortSignal.timeout(240_000) });
  if (!r.ok) throw new Error(`model server: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return String(((await r.json()) as { message?: { content?: string } }).message?.content ?? '');
}

async function main(): Promise<void> {
  const { values: opt } = parseArgs({ options: { model: { type: 'string' }, upstream: { type: 'string', default: 'http://127.0.0.1:11434' }, before: { type: 'boolean' }, only: { type: 'string' }, ids: { type: 'string' }, out: { type: 'string' } } });
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version as string;
  const at = new Date().toISOString();
  const root = opt.upstream!.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const persona = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const owner = 'Alex';
  // Her instructions for a plain chat turn; --before takes the S5 section out again.
  const system = (notes: string[]) => {
    const full = buildSystemPrompt(persona, { now: new Date('2026-11-24T15:00:00Z'), timeZone: 'America/Chicago', ownerName: owner, ...(notes.length ? { safetyNotes: notes } : {}) });
    if (!opt.before) return full;
    const head = `## When ${owner} is going through something hard\n`;
    const i = full.indexOf(head);
    if (i < 0) throw new Error('the S5 section is not in her instructions');
    const j = full.indexOf('\n## ', i + head.length);
    if (!hardTalkLines(owner).every((l) => full.includes(l))) throw new Error('the S5 lines are not in her instructions');
    return full.slice(0, i) + full.slice(j + 1);
  };
  const results: CrisisResult[] = [];
  const ids = opt.ids ? new Set(opt.ids.split(',').map((x) => x.trim())) : undefined;
  for (const c of (CRISIS_CASES as CrisisCase[]).filter((x) => !ids || ids.has(x.id))) {
    const r: CrisisResult = { id: c.id, group: c.group, said: c.said === true, words: detectCrisis(c.text) };
    if (opt.model && opt.only !== 'reply') {
      try {
        r.check = parseClassifier(await ask(root, opt.model, [{ role: 'system', content: opt.before ? CLASSIFIER_PROMPT_BEFORE_S5 : CLASSIFIER_PROMPT }, { role: 'user', content: c.text }], { maxTokens: 8 })) === 'CRISIS';
      } catch (err) {
        console.warn(`${c.id}: ${(err as Error).message}`);
      }
    }
    if (opt.model && opt.only !== 'check') {
      try {
        // As in a real turn: when the app's own checks fired, she is told so in a note.
        const fired = r.words || r.check === true;
        const said = await ask(root, opt.model, [{ role: 'system', content: system(fired ? [CRISIS_SYSTEM_NOTE] : []) }, ...(c.history ?? []), { role: 'user', content: c.text }], { maxTokens: 400 });
        r.reply = LINES_RE.test(said) ? 'lines' : REFER_RE.test(said) ? 'referral' : 'stayed';
        r.replyText = said.replace(/\s+/g, ' ').slice(0, 700);
      } catch (err) {
        r.reply = 'error';
        console.warn(`${c.id}: ${(err as Error).message}`);
      }
    }
    results.push(r);
    console.log(`${c.id.padEnd(20)} ${c.group.padEnd(7)} words:${r.words ? 'YES' : 'no '}${r.check !== undefined ? ` check:${r.check ? 'YES' : 'no '}` : ''}${r.reply ? ` reply:${r.reply}` : ''}`);
  }
  const md = crisisReport(results, { version, at, ...(opt.model ? { model: opt.model } : {}), ...(opt.before ? { before: true } : {}) });
  const outDir = resolve(opt.out ?? join(ROOT, 'outputs', 'crisis-evals', at.slice(0, 10)));
  mkdirSync(outDir, { recursive: true });
  const name = `${opt.model ? opt.model.replace(/[^\w.-]+/g, '_') : 'words'}${opt.before ? '-before' : ''}`;
  writeFileSync(join(outDir, `results-${name}.json`), JSON.stringify({ version, at, model: opt.model ?? null, before: opt.before === true, summary: summarizeCrisis(results), results }, null, 1));
  writeFileSync(join(outDir, `report-${name}.md`), md);
  console.log(`\n${md}\nWritten to ${outDir}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
