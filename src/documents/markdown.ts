// make_document (docs/DOCUMENTS.md): the Markdown every format is made from. One small dialect,
// the same for every model: # / ## / ### headings, paragraphs, **bold**, *italic*, `code`,
// [links](https://…), "- " and "1. " lists (indent two spaces to nest), | tables |, "> " quotes,
// "---" rules, a line "[page break]", and pictures from her own library or uploads on their own
// line: ![a caption](upload:ID) or ![a caption](library:12). Nothing in a document is ever fetched
// from the internet: picture lines that point anywhere else stay as their caption.

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  href?: string;
}

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; runs: Run[] }
  | { t: 'p'; runs: Run[] }
  | { t: 'li'; ordered: boolean; num: number; depth: number; runs: Run[] }
  | { t: 'quote'; runs: Run[] }
  | { t: 'code'; text: string }
  | { t: 'table'; head: Run[][]; rows: Run[][][] }
  | { t: 'img'; ref: string; alt: string }
  | { t: 'hr' }
  | { t: 'break' };

/** Only these links are written as links (others stay plain text). */
export const safeHref = (u: string): string | undefined => (/^(https?:\/\/|mailto:)[^\s<>"']+$/i.test(u) ? u : undefined);

/** A picture reference she may use: an upload id or a library document id. */
export function imageRef(src: string): string | undefined {
  const s = src.trim();
  let m = /^upload:([a-f0-9]{16,64}\.(?:jpg|png|webp|gif))$/i.exec(s);
  if (m) return `upload:${m[1].toLowerCase()}`;
  m = /^library:(\d{1,9})$/i.exec(s);
  if (m) return `library:${Number(m[1])}`;
  m = /^([a-f0-9]{32}\.(?:jpg|png|webp|gif))$/i.exec(s);
  if (m) return `upload:${m[1].toLowerCase()}`;
  return undefined;
}

const INLINE = /(\*\*|__)(?=\S)(.+?)(?<=\S)\1|(?<![\p{L}\p{N}*_])(\*|_)(?=[^\s*_])(.+?)(?<=[^\s*_])\3(?![\p{L}\p{N}*_])|`([^`]+)`|!?\[([^\]]+)\]\(([^)\s]+)\)|((?:https?:\/\/|mailto:)[^\s<>()]+[^\s<>().,;:!?'"])/gu;

/** Inline Markdown as runs (bold, italic, code, links). */
export function inline(src: string, base: Omit<Run, 'text'> = {}): Run[] {
  const runs: Run[] = [];
  let at = 0;
  const push = (r: Run) => {
    if (!r.text) return;
    const last = runs.at(-1);
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.code === !!r.code && last.href === r.href) last.text += r.text;
    else runs.push(r);
  };
  for (const m of src.matchAll(INLINE)) {
    if (m.index > at) push({ ...base, text: unescape(src.slice(at, m.index)) });
    if (m[2] !== undefined) for (const r of inline(m[2], { ...base, bold: true })) push(r);
    else if (m[4] !== undefined) for (const r of inline(m[4], { ...base, italic: true })) push(r);
    else if (m[5] !== undefined) push({ ...base, text: m[5], code: true });
    else if (m[6] !== undefined) {
      const href = safeHref(m[7]);
      for (const r of inline(m[6], href ? { ...base, href } : base)) push(r);
    } else if (m[8] !== undefined) {
      const href = safeHref(m[8]);
      push({ ...base, text: m[8].replace(/^mailto:/i, ''), ...(href ? { href } : {}) });
    }
    at = m.index + m[0].length;
  }
  if (at < src.length) push({ ...base, text: unescape(src.slice(at)) });
  return runs;
}
const unescape = (s: string) => s.replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, '$1');

export const plain = (runs: Run[]): string => runs.map((r) => r.text).join('');

const TABLE_SEP = /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/;
const cells = (line: string): string[] => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
};
const BREAK = /^(\[page ?break\]|\\pagebreak|\\newpage|<!--\s*page ?break\s*-->|---\s*page ?break\s*---)$/i;

/** The document's Markdown as blocks. */
export function parseMarkdown(md: string, o: { keepLines?: boolean } = {}): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  // A paragraph's lines, and whether each ends in a line break.
  let para: { text: string; br: boolean }[] = [];
  const flush = () => {
    // Letters and resumes keep their line breaks (an address, a contact line), and a line ending in
    // two spaces or \ breaks in any document; \n is a line break in every writer.
    if (para.length) out.push({ t: 'p', runs: para.flatMap((l, i) => [...inline(l.text), ...(i < para.length - 1 ? [{ text: l.br ? '\n' : ' ' }] : [])]) });
    para = [];
  };
  const counters: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    const indent = raw.length - raw.trimStart().length;
    let m: RegExpExecArray | null;
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith('```')) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i]);
      out.push({ t: 'code', text: body.join('\n') });
      continue;
    }
    if (BREAK.test(line)) {
      flush();
      out.push({ t: 'break' });
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      flush();
      out.push({ t: 'hr' });
      continue;
    }
    if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) {
      flush();
      out.push({ t: 'h', level: Math.min(3, m[1].length) as 1 | 2 | 3, runs: inline(m[2]) });
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/.exec(line))) {
      flush();
      const ref = imageRef(m[2]);
      // A picture from anywhere else is never fetched: a real caption stays as text, a placeholder one ("image") goes.
      const alt = m[1].trim();
      if (ref) out.push({ t: 'img', ref, alt });
      else if (alt && !/^(caption|image|img|picture|photo|figure|alt|alt text)\s*\d*$/i.test(alt)) out.push({ t: 'p', runs: [{ text: alt, italic: true }] });
      continue;
    }
    if (line.startsWith('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1].trim())) {
      flush();
      const head = cells(line).map((c) => inline(c));
      const rows: Run[][][] = [];
      i++;
      while (i + 1 < lines.length && lines[i + 1].trim().startsWith('|')) rows.push(cells(lines[++i]).map((c) => inline(c)));
      out.push({ t: 'table', head, rows });
      continue;
    }
    if ((m = /^([-*+]|\d{1,4}[.)])\s+(.*)$/.exec(line))) {
      flush();
      const depth = Math.min(2, Math.floor(indent / 2));
      const ordered = /\d/.test(m[1]);
      counters.length = depth + 1;
      const prev = out.at(-1);
      const continuing = prev?.t === 'li' && prev.ordered === ordered;
      const num = ordered ? (continuing && prev.depth >= depth && counters[depth] ? counters[depth] + 1 : Number.parseInt(m[1], 10) || 1) : 0;
      counters[depth] = num;
      out.push({ t: 'li', ordered, num, depth, runs: inline(m[2]) });
      continue;
    }
    if ((m = /^>\s?(.*)$/.exec(line))) {
      flush();
      const prev = out.at(-1);
      if (prev?.t === 'quote' && m[1]) prev.runs.push({ text: ' ' }, ...inline(m[1]));
      else if (m[1]) out.push({ t: 'quote', runs: inline(m[1]) });
      continue;
    }
    // A wrapped line of a list item continues it.
    const prev = out.at(-1);
    if (!para.length && prev?.t === 'li' && indent >= 2) {
      prev.runs.push({ text: ' ' }, ...inline(line));
      continue;
    }
    para.push({ text: line.replace(/\\$/, ''), br: Boolean(o.keepLines) || / {2}$|\\$/.test(raw) });
  }
  flush();
  return out;
}

/** The first top-level heading's text (a title when none was given). */
export function firstHeading(blocks: Block[]): string | undefined {
  const h = blocks.find((b) => b.t === 'h');
  return h && h.t === 'h' ? plain(h.runs).trim() : undefined;
}
