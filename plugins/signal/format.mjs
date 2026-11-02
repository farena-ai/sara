// Text for Signal (docs/design/BRIDGES3.md §4.6): Signal shows **bold** literally, so simple Markdown
// (bold, italic, inline code, code blocks, strikethrough) becomes `textStyle` ranges in UTF-16 code
// units ("start:length:STYLE") and the marks are removed. Long replies are split at 2000 characters.

export const TEXT_MAX = 2000;

const RULES = [
  { re: /```(?:[\w+-]*\n)?([\s\S]*?)```/g, style: 'MONOSPACE' },
  { re: /`([^`\n]+)`/g, style: 'MONOSPACE' },
  { re: /\*\*([^*\n][^*]*?)\*\*/g, style: 'BOLD' },
  { re: /__([^_\n][^_]*?)__/g, style: 'BOLD' },
  { re: /~~([^~\n]+?)~~/g, style: 'STRIKETHROUGH' },
  { re: /(?<![\w*])\*([^*\n]+?)\*(?![\w*])/g, style: 'ITALIC' },
  { re: /(?<![\w_])_([^_\n]+?)_(?![\w_])/g, style: 'ITALIC' },
];

/** Markdown → { text, styles: ['start:length:STYLE'] } (UTF-16 units; JavaScript strings already are). */
export function toSignal(md) {
  let text = String(md ?? '');
  let styles = [];
  for (const rule of RULES) {
    let out = '';
    let last = 0;
    const moved = [];
    rule.re.lastIndex = 0;
    let m;
    while ((m = rule.re.exec(text))) {
      out += text.slice(last, m.index);
      const start = out.length;
      out += m[1];
      moved.push({ at: m.index, len: m[0].length, inner: m[1].length, start, open: m[0].indexOf(m[1]) });
      if (m[1].length) styles.push({ start, length: m[1].length, style: rule.style, fresh: true });
      last = m.index + m[0].length;
    }
    if (!moved.length) continue;
    out += text.slice(last);
    // Earlier ranges shift by the marks removed before (or inside) them.
    const shift = (pos) => {
      let d = 0;
      for (const x of moved) {
        if (pos >= x.at + x.len) d += x.len - x.inner;
        else if (pos > x.at) d += Math.min(pos - x.at, x.open);
      }
      return pos - d;
    };
    styles = styles.map((s) => (s.fresh ? { ...s, fresh: false } : { ...s, start: shift(s.start), length: shift(s.start + s.length) - shift(s.start) }));
    text = out;
  }
  return { text, styles: styles.filter((s) => s.length > 0).map((s) => `${s.start}:${s.length}:${s.style}`) };
}

/** Splits a long reply at paragraph, line or word boundaries (≤ max characters each). */
export function split(text, max = TEXT_MAX) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}
