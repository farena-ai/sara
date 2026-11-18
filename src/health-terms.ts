// U4.22 (docs/HEALTH.md): the words of every open health log (medicine names, symptoms, appointment
// titles), so anything that leaves this server can hide them: support and hub reports, remote help
// reports and fix recipes all pass scrubText (src/hub.ts), which calls hideHealth. No imports: hub.ts
// stays light. Health lines by shape ("BP 128/82", "glucose 104", "6/10 headache") go too.

const TERMS = new Map<string, Set<string>>();
let re: RegExp | undefined;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Generic words that are no secret (and would hide half a report). */
const PLAIN = new Set(['mood', 'sleep', 'weight', 'pulse', 'glucose', 'temperature', 'blood pressure', 'pain', 'other', 'note', 'notes', 'checkup', 'doctor']);

/** The terms of one space's health log (replaces what that space had). */
export function setHealthTerms(space: string, terms: Iterable<string>): void {
  const keep = new Set<string>();
  for (const t of terms) {
    const x = String(t ?? '').trim().toLowerCase();
    if (x.length >= 3 && !PLAIN.has(x)) keep.add(x);
  }
  TERMS.set(space, keep);
  re = undefined;
}

const SHAPES = [
  /\b(?:bp|blood pressure)\s*:?\s*\d{2,3}\s*\/\s*\d{2,3}\b/gi,
  /\b(?:glucose|blood sugar|sugar|pulse|heart rate|temp|temperature|weight)\s*:?\s*\d{2,3}(?:\.\d)?\s*(?:mg\/dl|mmol\/l|bpm|lb|lbs|kg|°?f|°?c)?/gi,
  /\b\d{1,2}\s*\/\s*10\s+(?:pain|headache|migraine|nausea)\b|\b(?:pain|headache|migraine|nausea)\s*:?\s*\d{1,2}\s*\/\s*10\b/gi,
];

/** The text with health words and health-shaped readings replaced by "[health]". */
export function hideHealth(text: string): string {
  let s = String(text ?? '');
  for (const r of SHAPES) s = s.replace(r, '[health]');
  if (!re) {
    const all = [...new Set([...TERMS.values()].flatMap((t) => [...t]))].sort((a, b) => b.length - a.length);
    re = all.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${all.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : /(?!)/;
  }
  return s.replace(re, '[health]');
}

/** A chat message that logged or read health (kept out of memory and Ask about anything). */
export function healthMessage(m: { role: string; meta?: Record<string, unknown> }): boolean {
  if (m.meta?.health === true) return true;
  if (m.role === 'tool' && /^health_/.test(String(m.meta?.name ?? ''))) return true;
  const calls = m.meta?.toolCalls;
  return m.role === 'assistant' && Array.isArray(calls) && calls.some((c) => /^health_/.test(String((c as { name?: unknown }).name ?? '')));
}
/** The messages without whole health exchanges (a marked message up to the next plain user message). */
export function withoutHealth<T extends { role: string; meta?: Record<string, unknown> }>(messages: T[]): T[] {
  const out: T[] = [];
  let inHealth = false;
  for (const m of messages) {
    if (m.role === 'user') inHealth = healthMessage(m);
    if (inHealth || healthMessage(m)) continue;
    out.push(m);
  }
  return out;
}
