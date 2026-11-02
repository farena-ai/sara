// HTML mail → plain text (BRIDGES3 §5.4). Written for safety first: whatever the reader of the mail
// can't see, she doesn't get either.
//
// - Dropped with everything inside them: comments, <head>, <style>, <script>, <template>,
//   <noscript>, <title>, <svg>, <object>, <iframe>, and any element the sender hid: the `hidden`
//   attribute, aria-hidden="true", and inline styles with display:none, visibility:hidden,
//   font-size:0 (any unit), max-height:0 / height:0 with overflow hidden, or opacity:0. These go
//   BEFORE tags are stripped, so text a reader can't see (hidden instructions) never reaches the model.
// - Block elements become line breaks, list items "- ", table cells a " · " between them.
// - Links become `text (address)` when the address isn't the text itself (http, https, mailto only).
// - Images are dropped (no alt text either: a tracking pixel says nothing, and nothing is fetched).
// - Entities decoded (the common named ones and every numeric one); runs of blank lines folded.

const DROP = new Set(['head', 'style', 'script', 'template', 'noscript', 'title', 'svg', 'object', 'iframe', 'math', 'select', 'button']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const BLOCK = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'blockquote', 'pre', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl', 'dt', 'dd', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'fieldset', 'figure', 'figcaption', 'address', 'center', 'hr']);

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', yen: '¥', cent: '¢', deg: '°', middot: '·', bull: '•', times: '×', divide: '÷', shy: '', zwnj: '', zwj: '', lrm: '', rlm: '', thinsp: ' ', ensp: ' ', emsp: ' ', iexcl: '¡', iquest: '¿', szlig: 'ß', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', eacute: 'é', egrave: 'è', ecirc: 'ê', aacute: 'á', agrave: 'à', acirc: 'â', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', ccedil: 'ç', Eacute: 'É', atilde: 'ã', otilde: 'õ' };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,10});?/gi, (all, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '';
      // Zero-width and direction marks hide text too: dropped.
      if (n === 0x200b || n === 0x200c || n === 0x200d || n === 0x2060 || n === 0xfeff || n === 0xad) return '';
      return String.fromCodePoint(n);
    }
    return ENT[e] ?? ENT[e.toLowerCase()] ?? all;
  });
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const k = m[1].toLowerCase();
    if (k in out) continue;
    out[k] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

/** Whether the sender hid this element (BRIDGES3 §5.4: dropped before tags are stripped). */
export function hiddenBy(a) {
  if ('hidden' in a) return true;
  if (String(a['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  const st = String(a.style ?? '').toLowerCase().replace(/\s+/g, '');
  if (!st) return false;
  if (/(^|;)display:none/.test(st)) return true;
  if (/(^|;)visibility:(hidden|collapse)/.test(st)) return true;
  if (/(^|;)font-size:0(\.0+)?(px|pt|em|rem|%)?(;|$|!)/.test(st)) return true;
  if (/(^|;)opacity:0(\.0+)?(;|$|!)/.test(st)) return true;
  if (/(^|;)(max-)?height:0(px)?(;|$|!)/.test(st) && /overflow:hidden/.test(st)) return true;
  return false;
}

const safeHref = (h) => (/^(https?:|mailto:)/i.test(String(h).trim()) ? String(h).trim().slice(0, 500) : '');

export function htmlToText(html) {
  let s = String(html ?? '');
  // Comments and conditional comments go first (they can hold anything).
  s = s.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '').replace(/<![^>]*>/g, '').replace(/<\?[^>]*>/g, '');
  const out = [];
  const stack = [];
  /** While > 0, everything is inside a dropped or hidden element. */
  let skip = 0;
  let link = null;
  const re = /<\/?([a-zA-Z][\w:-]*)((?:\s+(?:[^\s"'>/=]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
  let last = 0;
  const text = (t) => {
    if (skip || !t) return;
    const plain = decodeEntities(t.replace(/[ \t\r\n\f]+/g, ' '));
    if (link) link.text += plain;
    else out.push(plain);
  };
  const nl = (n = 1) => {
    if (skip) return;
    if (link) return void (link.text += ' ');
    out.push('\n'.repeat(n));
  };
  for (let m; (m = re.exec(s)); ) {
    text(s.slice(last, m.index));
    last = re.lastIndex;
    const raw = m[0];
    const name = m[1].toLowerCase();
    const closing = raw.startsWith('</');
    if (closing) {
      // Pop to the matching open element (tolerates missing end tags).
      const at = stack.map((x) => x.name).lastIndexOf(name);
      if (at < 0) continue;
      for (const el of stack.splice(at)) {
        if (el.skip) skip--;
        if (el.name === 'a' && el.link && link === el.link) {
          const t = link.text.replace(/\s+/g, ' ').trim();
          link = null;
          const href = el.link.href.replace(/^mailto:/i, '');
          if (!skip) out.push(href && t && href !== t && !t.includes(href) ? `${t} (${href})` : t || href);
        }
        if (!el.skip && BLOCK.has(el.name)) nl();
      }
      continue;
    }
    const a = attrs(m[2] ?? '');
    const selfClose = raw.endsWith('/>') || VOID.has(name);
    if (selfClose) {
      if (skip) continue;
      if (name === 'br') nl();
      else if (name === 'hr') nl(2);
      continue; // images and the rest of the void elements say nothing
    }
    const hide = DROP.has(name) || hiddenBy(a);
    const el = { name, skip: hide, link: null };
    if (hide) skip++;
    else if (!skip) {
      if (BLOCK.has(name)) nl();
      if (name === 'li') {
        nl();
        out.push('- ');
      } else if (name === 'td' || name === 'th') {
        if (out.length && !/\n$|^$/.test(out.at(-1))) out.push(' · ');
      } else if (name === 'a' && !link) {
        el.link = { href: safeHref(a.href ?? ''), text: '' };
        link = el.link;
      }
    }
    stack.push(el);
    if (stack.length > 2000) break;
  }
  text(s.slice(last));
  if (link) out.push(link.text);
  return out
    .join('')
    .split('\n')
    .map((l) => l.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
