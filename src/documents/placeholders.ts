// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): the blanks in a template. A template is
// any Library document the person marks as one; its placeholders are found here: {{Client}},
// [CLIENT NAME] / [insert date], <<Project>> / «Project», and labelled blank lines ("Date: ______").
// Signature lines ("Signature: ____", "By: ____") are left for signing, not filled. Filling a Word
// template writes the values in place (src/documents/tracked.ts paragraph model), so each value keeps
// the placeholder's own formatting and every other part of the file stays as it was.
import { repack, serializeXml } from './ooxml-edit.ts';
import { editModel, modelText, OPAQUE, openDocx, paraModel, writeModel } from './tracked.ts';
import { findAll, parseXml } from '../library/xml.ts';

export type PlaceholderKind = 'braces' | 'brackets' | 'angle' | 'blank' | 'signature';
export interface Placeholder {
  /** Folded label: what a value is matched by. */
  key: string;
  /** As written in the document ("CLIENT NAME", "Date"). */
  label: string;
  kind: PlaceholderKind;
  /** The distinct ways it is written ("{{Client}}", "{{ client }}"). */
  raw: string[];
  count: number;
}
interface Hit {
  start: number;
  end: number;
  label: string;
  key: string;
  kind: PlaceholderKind;
  raw: string;
  /** For a blank: only the underscores are replaced (the label stays). */
}

export const keyOf = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const BRACKET_WORDS = /^(insert|enter|add|type|your|client|customer|company|name|date|address|amount|title|phone|email|project|fee|price|state|city)\b/i;
const SIGNATURE = /\b(signature|signed|sign here|initials?|by)\s*:?\s*$/i;

/** Every placeholder in a piece of text, in order. */
export function placeholderHits(text: string): Hit[] {
  const hits: Hit[] = [];
  const add = (start: number, end: number, label: string, kind: PlaceholderKind) => {
    const l = label.replace(/\s+/g, ' ').trim();
    if (!l || l.includes(OPAQUE) || hits.some((h) => start < h.end && end > h.start)) return;
    hits.push({ start, end, label: l, key: keyOf(l), kind, raw: text.slice(start, end) });
  };
  for (const m of text.matchAll(/\{\{\s*([^{}\n]{1,60}?)\s*\}\}/g)) add(m.index, m.index + m[0].length, m[1], 'braces');
  for (const m of text.matchAll(/\[([^[\]\n]{2,60})\](?!\()/g)) {
    const inner = m[1].trim();
    const caps = /^[\p{Lu}\p{N} &'’/.,#-]+$/u.test(inner) && (inner.match(/\p{Lu}/gu)?.length ?? 0) >= 2;
    if (/^page\s+\d+$/i.test(inner) || /^\d+$/.test(inner)) continue;
    if (caps || BRACKET_WORDS.test(inner)) add(m.index, m.index + m[0].length, inner, 'brackets');
  }
  for (const m of text.matchAll(/<<\s*([^<>\n]{1,60}?)\s*>>|«\s*([^«»\n]{1,60}?)\s*»/g)) add(m.index, m.index + m[0].length, m[1] ?? m[2], 'angle');
  // Blank lines: the words just before them (since the line start or the last blank) are the label.
  let n = 0;
  for (const m of text.matchAll(/_{4,}/g)) {
    const lineStart = Math.max(text.lastIndexOf('\n', m.index) + 1, ...hits.filter((h) => h.end <= m.index).map((h) => h.end), prevBlankEnd(text, m.index));
    const before = text.slice(lineStart, m.index);
    const sig = SIGNATURE.test(before);
    const lab = before.split(/[.;!?]\s+/).pop()!.replace(/[:\s]+$/, '').replace(/^[\s:]+/, '').slice(-40).trim();
    add(m.index, m.index + m[0].length, lab || `Blank ${++n}`, sig ? 'signature' : 'blank');
  }
  return hits.sort((a, b) => a.start - b.start);
}

function prevBlankEnd(text: string, at: number): number {
  const before = text.slice(0, at);
  const m = /_{4,}(?![\s\S]*_{4,})/.exec(before);
  return m ? m.index + m[0].length : 0;
}

/** The placeholders in a document's text, each once (with how often it appears). */
export function detectPlaceholders(text: string): Placeholder[] {
  const out: Placeholder[] = [];
  for (const h of placeholderHits(text)) {
    const had = out.find((p) => p.key === h.key && (p.kind === 'signature') === (h.kind === 'signature'));
    if (had) {
      had.count++;
      if (!had.raw.includes(h.raw)) had.raw.push(h.raw);
    } else out.push({ key: h.key, label: h.label, kind: h.kind, raw: [h.raw], count: 1 });
  }
  return out.slice(0, 200);
}

/** Values by folded label. */
export function valueMap(values: Record<string, unknown>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(values ?? {})) {
    if (v === null || v === undefined || typeof v === 'object') continue;
    const s = String(v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 4000);
    if (s.trim()) m.set(keyOf(k), s);
  }
  return m;
}

/** A plain text with its placeholders filled (signature lines stay). */
export function fillText(text: string, values: Record<string, unknown>): { text: string; filled: string[]; missing: string[] } {
  const vals = valueMap(values);
  const filled = new Set<string>();
  const missing = new Set<string>();
  let out = text;
  for (const h of placeholderHits(text).reverse()) {
    if (h.kind === 'signature') continue;
    const v = vals.get(h.key);
    if (v === undefined) {
      missing.add(h.label);
      continue;
    }
    out = out.slice(0, h.start) + v + out.slice(h.end);
    filled.add(h.label);
  }
  return { text: out, filled: [...filled].reverse(), missing: [...missing].reverse() };
}

/** A copy of a Word template with its placeholders filled in place (body, headers and footers). */
export function fillDocxPlaceholders(bytes: Buffer, values: Record<string, unknown>): { data: Buffer; filled: string[]; missing: string[] } {
  const d = openDocx(bytes);
  const vals = valueMap(values);
  const filled: string[] = [];
  const missing: string[] = [];
  const changed = new Map<string, string | Buffer>();
  const parts: [string, ReturnType<typeof parseXml>][] = [[d.main, d.doc]];
  for (const e of d.zip.all) if (/^word\/(header|footer)\d*\.xml$/i.test(e.name)) parts.push([e.name, parseXml(d.zip.text(e.name) ?? '')]);
  for (const [path, root] of parts) {
    let touched = false;
    for (const p of path === d.main ? d.paras : findAll(root, 'p')) {
      const m = paraModel(p);
      const hits = placeholderHits(modelText(m).text);
      let edited = false;
      for (const h of hits) {
        if (h.kind === 'signature') continue;
        if (vals.has(h.key)) {
          if (!filled.includes(h.label)) filled.push(h.label);
        } else if (!missing.includes(h.label)) missing.push(h.label);
      }
      for (const h of hits.reverse()) {
        const v = h.kind === 'signature' ? undefined : vals.get(h.key);
        if (v === undefined) continue;
        editModel(m, h.start, h.end, v, false);
        edited = true;
      }
      if (edited) {
        writeModel(m);
        touched = true;
      }
    }
    if (touched) changed.set(path, serializeXml(root));
  }
  return { data: changed.size ? repack(d.zip, changed) : bytes, filled, missing: missing.filter((x) => !filled.includes(x)) };
}
