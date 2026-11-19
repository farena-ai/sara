// W2.4 Free models first (docs/FREE_MODELS.md, docs/design/W2MODELS.md): the curated, versioned list of
// free and local models per job (src/free-models.json) and the pure helpers that pick one for this
// computer. Nothing here downloads: Settings' buttons call the existing routes (/api/local-models/pull
// for Ollama models, the Voice page's installer for hearing and voices, the phone app for its copy).
// The chat rows mirror GPU_TIERS / CPU_TIERS (src/local-models.ts), so the first-run guide and this
// list never disagree (test/w2-models.test.ts).
import { readFileSync } from 'node:fs';
import type { Hardware, OllamaModel, OllamaStatus } from './local-models.ts';

export const FREE_JOBS = ['chat', 'coding', 'vision', 'hearing', 'voice', 'embeddings', 'phone'] as const;
export type FreeJob = (typeof FREE_JOBS)[number];

export interface FreeModel {
  id: string;
  job: FreeJob;
  name: string;
  /** How it gets onto a computer: Ollama, the local voice download, or the phone app. */
  how: 'ollama' | 'voice' | 'phone';
  /** Ollama name to pull (how = 'ollama'). */
  pull?: string;
  /** Graphics memory (or a Mac's share of memory) it needs, in GB. */
  minGb?: number;
  /** Memory to run it on the processor; missing = not suggested without a graphics card. */
  cpuRamGb?: number;
  /** Memory a voice/phone model needs (they run on the processor). */
  ramGb?: number;
  /** Approximate download, GB. */
  sizeGb: number;
  license: string;
  /** English (the web translates it): why this one. */
  why: string;
  /** Our own published eval for this model, when we have one. */
  quality?: { file: string; label: string; score?: string };
}

export interface FreeModelList {
  version: number;
  updated: string;
  note?: string;
  models: FreeModel[];
}

/** One model's re-check result (src/model-recheck.ts), keyed by list id. */
export interface RecheckResult {
  model: string;
  job: string;
  passed: number;
  of: number;
  at: string;
  ms: number;
  failed: string[];
}

export function validateList(list: FreeModelList): string[] {
  const out: string[] = [];
  if (!Number.isInteger(list?.version) || list.version < 1) out.push('version must be a whole number from 1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(list?.updated ?? ''))) out.push('updated must be a date');
  const seen = new Set<string>();
  for (const m of list?.models ?? []) {
    const at = m?.id || '(no id)';
    if (!m?.id) out.push('a model has no id');
    else if (seen.has(m.id)) out.push(`${m.id} is listed twice`);
    seen.add(m?.id);
    if (!FREE_JOBS.includes(m?.job)) out.push(`${at}: unknown job ${m?.job}`);
    if (!['ollama', 'voice', 'phone'].includes(m?.how)) out.push(`${at}: unknown way ${m?.how}`);
    if (m?.how === 'ollama' && !/^[\w.\-/:]{1,200}$/.test(m.pull ?? '')) out.push(`${at}: needs an Ollama name`);
    if (m?.how === 'ollama' && /-cloud$|:cloud$/.test(m.pull ?? '')) out.push(`${at}: cloud models are not local`);
    if (m?.how === 'ollama' && typeof m.minGb !== 'number') out.push(`${at}: needs minGb`);
    if (!(Number(m?.sizeGb) > 0)) out.push(`${at}: needs a download size`);
    if (!String(m?.license ?? '').trim()) out.push(`${at}: needs a license`);
    if (!String(m?.why ?? '').trim()) out.push(`${at}: needs a why`);
    if (!String(m?.name ?? '').trim()) out.push(`${at}: needs a name`);
  }
  return out;
}

export const FREE_MODELS: FreeModelList = JSON.parse(readFileSync(new URL('./free-models.json', import.meta.url), 'utf8')) as FreeModelList;

/** Does it run here? Voice and phone models run on any processor. */
export function fits(m: FreeModel, hw: Pick<Hardware, 'budgetGb' | 'basis' | 'ramGb'>): boolean {
  if (m.how !== 'ollama') return (m.ramGb ?? 0) <= Math.max(hw.ramGb, 1);
  if (hw.basis === 'cpu') return m.cpuRamGb !== undefined && m.cpuRamGb <= hw.ramGb;
  return (m.minGb ?? 0) <= hw.budgetGb;
}

/** The biggest model of a job that fits (list order breaks ties); `smallest` = what the job needs at least. */
export function recommendFor(job: FreeJob, hw: Pick<Hardware, 'budgetGb' | 'basis' | 'ramGb'>, list: FreeModelList = FREE_MODELS): { pick?: FreeModel; others: FreeModel[]; smallest?: FreeModel } {
  const all = list.models.filter((m) => m.job === job);
  const ok = all.filter((m) => fits(m, hw));
  const need = (m: FreeModel) => (m.how !== 'ollama' ? 0 : hw.basis === 'cpu' ? (m.cpuRamGb ?? Infinity) : (m.minGb ?? 0));
  let pick: FreeModel | undefined;
  for (const m of ok) if (m.how !== 'ollama' ? !pick : !pick || need(m) >= need(pick)) pick = m;
  const smallest = [...all].sort((a, b) => (a.minGb ?? 0) - (b.minGb ?? 0))[0];
  return { ...(pick ? { pick } : {}), others: ok.filter((m) => m !== pick), ...(pick ? {} : smallest ? { smallest } : {}) };
}

/** The installed Ollama name of a listed model (exact, :latest, or a local build like qwen3.8:27b-mtp-q4_K_M). */
export function installedAs(m: FreeModel, ollama: Pick<OllamaStatus, 'models'>): string | undefined {
  if (m.how !== 'ollama' || !m.pull) return undefined;
  const want = m.pull;
  const local = ollama.models.filter((x: OllamaModel) => !x.cloud);
  return (
    local.find((x) => x.name === want || x.name === `${want}:latest`)?.name ??
    local.find((x) => want.includes(':') && x.name.startsWith(`${want}-`) && !/cloud/.test(x.name))?.name
  );
}

export type Quality = { kind: 'here'; passed: number; of: number; at: string } | { kind: 'eval'; label: string; score?: string; file: string } | { kind: 'untested' };

/** Re-checked on this computer beats our published eval; otherwise 'untested'. */
export function qualityOf(m: FreeModel, results: Record<string, RecheckResult>): Quality {
  const r = results[m.id];
  if (r) return { kind: 'here', passed: r.passed, of: r.of, at: r.at };
  if (m.quality) return { kind: 'eval', label: m.quality.label, file: m.quality.file, ...(m.quality.score ? { score: m.quality.score } : {}) };
  return { kind: 'untested' };
}

export type RowAction = 'download' | 'installed' | 'get-ollama' | 'voice' | 'phone' | 'none';

export interface JobRow {
  job: FreeJob;
  pick?: FreeModel & { tested: Quality };
  others: (FreeModel & { tested: Quality; installed?: string })[];
  /** Too small a computer: what the smallest one needs. */
  smallest?: FreeModel;
  installed?: string;
  action: RowAction;
}

export function recommendations(hw: Hardware, ollama: OllamaStatus, results: Record<string, RecheckResult>, list: FreeModelList = FREE_MODELS): JobRow[] {
  return FREE_JOBS.map((job): JobRow => {
    const r = recommendFor(job, hw, list);
    const q = (m: FreeModel) => ({ ...m, tested: qualityOf(m, results) });
    if (!r.pick) return { job, others: [], ...(r.smallest ? { smallest: r.smallest } : {}), action: 'none' as const };
    const installed = installedAs(r.pick, ollama);
    const action: RowAction = r.pick.how === 'voice' ? 'voice' : r.pick.how === 'phone' ? 'phone' : !ollama.found ? 'get-ollama' : installed ? 'installed' : 'download';
    const others = r.others.map((m) => {
      const at = installedAs(m, ollama);
      return { ...q(m), ...(at ? { installed: at } : {}) };
    });
    return { job, pick: q(r.pick), others, ...(installed ? { installed } : {}), action };
  });
}
