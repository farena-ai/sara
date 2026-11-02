// Her Markdown as WhatsApp shows it (WHATSAPP §4.6): *bold*, _italic_, ~strike~, ``` blocks and
// `code` are WhatsApp's own; headings become bold lines, tables aligned monospace blocks, links
// "text (url)". Long replies split at paragraph or sentence ends under 4096 characters, at most 3
// messages (Meta's pair rate); the rest stays in the app.

export const TEXT_MAX = 4096;
export const MAX_PARTS = 3;
export const CAPTION_MAX = 1024;
export const BUTTON_LABEL_MAX = 20;
export const BUTTON_BODY_MAX = 1024;

function table(lines) {
  const rows = lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()));
  const widths = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, [...c].length)));
  return ['```', ...rows.map((r) => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd()), '```'].join('\n');
}

/** Markdown → WhatsApp formatting. Code blocks are left as they are. */
export function toWhatsApp(md) {
  const out = [];
  const lines = String(md ?? '').replace(/\r\n/g, '\n').split('\n');
  let code = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      code = !code;
      out.push('```');
      continue;
    }
    if (code) {
      out.push(l);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      i--;
      out.push(table(block));
      continue;
    }
    let x = l;
    const h = /^\s{0,3}#{1,6}\s+(.*)$/.exec(x);
    if (h) x = `**${h[1].replace(/\*\*/g, '')}**`;
    // Links first (so their text keeps its own formatting), then emphasis, then inline code stays.
    x = x.replace(/!?\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_m, t, u) => (t === u ? u : `${t} (${u})`));
    x = x.replace(/(^|[^*])\*(?!\*)([^*\n]+?)\*(?!\*)/g, '$1_$2_');
    x = x.replace(/\*\*([^*\n]+?)\*\*/g, '*$1*');
    x = x.replace(/__([^_\n]+?)__/g, '*$1*');
    x = x.replace(/~~([^~\n]+?)~~/g, '~$1~');
    x = x.replace(/^(\s*)[-*+]\s+/, '$1• ');
    out.push(x);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Splits at paragraph, then line, then sentence ends; at most `parts` messages; the last says the rest is in the app. */
export function split(text, max = TEXT_MAX, parts = MAX_PARTS, more = '…(continued in the app)') {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > max && out.length < parts) {
    const room = out.length === parts - 1 ? max - more.length - 2 : max;
    let cut = rest.lastIndexOf('\n\n', room);
    if (cut < room * 0.4) cut = rest.lastIndexOf('\n', room);
    if (cut < room * 0.4) cut = Math.max(rest.lastIndexOf('. ', room), rest.lastIndexOf('? ', room), rest.lastIndexOf('! ', room)) + 1;
    if (cut < room * 0.4) cut = room;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && out.length < parts) out.push(rest);
  else if (rest) out[out.length - 1] = `${out[out.length - 1]}\n\n${more}`;
  return out;
}

/** A button label within WhatsApp's 20 characters (cut with an ellipsis). */
export const label = (s) => {
  const a = [...String(s ?? '').trim()];
  return a.length <= BUTTON_LABEL_MAX ? a.join('') : `${a.slice(0, BUTTON_LABEL_MAX - 1).join('')}…`;
};
