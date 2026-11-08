// Teams text in and out (docs/ops/EC7_DESIGN.md). In: Teams sends HTML-ish text with <at>Name</at> for
// mentions; her own mention is dropped, other people's stay as @Name, tags go, entities are decoded.
// Out: Teams renders a Markdown subset (bold, italics, lists, links, code); `<` and `>` are escaped
// first so nothing she writes can become HTML, and only http(s) links stay links.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z0-9]{2,8});/gi, (m, e) => {
  const k = e.toLowerCase();
  if (ENT[k] !== undefined) return ENT[k];
  if (k.startsWith('#x')) return safeChar(parseInt(k.slice(2), 16), m);
  if (k.startsWith('#')) return safeChar(parseInt(k.slice(1), 10), m);
  return m;
});
const safeChar = (n, m) => (Number.isFinite(n) && n > 31 && n < 0x110000 ? String.fromCodePoint(n) : m);

/** The words he wrote, without her own @mention. `botNames` = the mention texts Teams sent for her. */
export function fromTeams(text, botNames = []) {
  let s = String(text ?? '');
  const mine = new Set(botNames.map((n) => decode(String(n)).replace(/<\/?at>/gi, '').trim().toLowerCase()).filter(Boolean));
  s = s.replace(/<at>([\s\S]*?)<\/at>/gi, (_, name) => {
    const n = decode(name.replace(/<[^>]*>/g, '')).trim();
    return mine.has(n.toLowerCase()) ? '' : `@${n}`;
  });
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<li[^>]*>/gi, '• ');
  s = s.replace(/<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, label) => {
    const l = label.replace(/<[^>]*>/g, '').trim();
    return l && l !== href ? `${l} (${href})` : href;
  });
  s = decode(s.replace(/<[^>]*>/g, ''));
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^[ \t]+|[ \t]+$/g, '').trim();
}

/** Her Markdown for Teams: HTML escaped, links only http(s), headings as bold lines. */
export function toTeams(md) {
  let s = String(md ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  s = s.replace(/\[([^\]\n]{1,200})\]\(((?:[^()\s]|\([^()\s]*\)){1,800})\)/g, (_, label, url) => (/^https?:\/\//i.test(url) ? `[${label}](${url})` : label));
  s = s.replace(/^#{1,6}\s+(.+)$/gm, '**$1**');
  return s;
}

/** Splits long text at paragraph, then line, then word ends (each part ≤ max characters). */
export function split(text, max) {
  const out = [];
  let rest = String(text ?? '');
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}
