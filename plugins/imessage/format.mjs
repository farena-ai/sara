// iMessage shows plain text (docs/design/BRIDGES4.md §4.6, §4.8, §4.10): Markdown is flattened
// (bold and headings to plain words, lists with •, tables as "a — b" lines, code kept as lines,
// links as "text: url"); a reply is at most 4 messages of at most 2,000 characters, the rest
// "…(continued in the app)". iOS turns "--" into "—" and quotes into curly ones: commands are mapped back.

export const PART_MAX = 2_000;
export const PARTS_MAX = 4;
export const MORE = '…(continued in the app)';

export function flatten(md) {
  const out = [];
  let code = false;
  for (const raw of String(md ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) {
      code = !code;
      continue;
    }
    if (code) {
      out.push(raw);
      continue;
    }
    let line = raw;
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) line = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(' — ');
    line = line.replace(/^\s*#{1,6}\s+/, '');
    line = line.replace(/^(\s*)[-*+]\s+/, '$1• ');
    line = line.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, t, u) => (t ? `${t}: ${u}` : u));
    line = line.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t, u) => (t === u ? u : `${t}: ${u}`));
    line = line.replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_m, a, b) => a ?? b);
    line = line.replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,!?:;]|$)/g, '$1$2');
    line = line.replace(/`([^`]+)`/g, '$1');
    line = line.replace(/~~([^~]+)~~/g, '$1');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** At most `PARTS_MAX` parts of at most `PART_MAX` characters, cut at a paragraph, line or space. */
export function split(text, max = PART_MAX, parts = PARTS_MAX) {
  const out = [];
  let rest = String(text ?? '').trim();
  while (rest && out.length < parts) {
    if (rest.length <= max) {
      out.push(rest);
      rest = '';
      break;
    }
    const room = out.length === parts - 1 ? max - MORE.length - 1 : max;
    let cut = rest.lastIndexOf('\n\n', room);
    if (cut < room / 2) cut = rest.lastIndexOf('\n', room);
    if (cut < room / 2) cut = rest.lastIndexOf(' ', room);
    if (cut < room / 2) cut = room;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && out.length) out[out.length - 1] = `${out[out.length - 1]}\n${MORE}`;
  return out;
}

/** Smart quotes and dashes back to plain ones, for a command (\"/model —list\" → \"/model --list\"). */
export function plainCommand(text) {
  const t = String(text ?? '');
  if (!/^\s*[/!]/.test(t)) return t;
  return t.replace(/[\u201c\u201d\u201e]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/\u2014/g, '--').replace(/\u2013/g, '-');
}

/** A quote of his message for an answer in basic mode (no Private API: no real replies). */
export function quoteLine(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return `↪ ${t.length > 60 ? `${t.slice(0, 59)}…` : t}`;
}
