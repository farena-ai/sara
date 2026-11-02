// Her Markdown as Matrix HTML (docs/design/BRIDGES4.md §6.9, §9.2): `body` stays plain text and
// `formatted_body` (format org.matrix.custom.html) is built ESCAPE-FIRST: every character of hers is
// HTML-escaped, then only Markdown she wrote becomes tags from the spec's allowed list (b, i, code,
// pre, ul/ol/li, a href http(s), h1–h6, table). No raw HTML from the model ever passes: a <script>
// or <img onerror> in her reply arrives as visible text. HTML from others is never read (the plugin
// uses `body` only).

export const escapeHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Inline Markdown on an already-escaped line: code spans first (their insides stay as they are). */
function inline(escaped) {
  const parts = escaped.split(/(`[^`\n]+`)/g);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return `<code>${p.slice(1, -1)}</code>`;
      let x = p;
      // Links: only http(s); the text and the address are already escaped.
      x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
      x = x.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
      x = x.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
      x = x.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
      x = x.replace(/(^|[^_\w])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
      x = x.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
      return x;
    })
    .join('');
}

const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** Markdown → `{ body, formatted_body? }`: no formatted body when the text has no Markdown at all. */
export function toMatrix(md) {
  const text = String(md ?? '').replace(/\r\n/g, '\n').trim();
  const lines = text.split('\n');
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      closeList();
      const lang = l.trim().slice(3).trim().replace(/[^\w+-]/g, '');
      const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code${lang ? ` class="language-${lang}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      closeList();
      const block = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) block.push(lines[i++]);
      i--;
      const rows = block.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cells);
      const head = rows.shift() ?? [];
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l);
    if (h) {
      closeList();
      out.push(`<h${h[1].length}>${inline(escapeHtml(h[2]))}</h${h[1].length}>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(l);
    const ol = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(l);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${inline(escapeHtml((ul ?? ol)[1]))}</li>`);
      continue;
    }
    closeList();
    out.push(l.trim() ? inline(escapeHtml(l)) + '<br>' : '<br>');
  }
  closeList();
  const html = out.join('').replace(/(<br>)+$/, '').replace(/(<br>){3,}/g, '<br><br>');
  const plain = escapeHtml(text).replace(/\n/g, '<br>');
  return html === plain ? { body: text } : { body: text, format: 'org.matrix.custom.html', formatted_body: html };
}

/** Splits at paragraph, then line ends under `max` characters; at most `parts` messages. */
export function split(text, max = 16_000, parts = 3, more = '…(continued in the app)') {
  const s = String(text ?? '').trim();
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > max && out.length < parts) {
    const room = out.length === parts - 1 ? max - more.length - 2 : max;
    let cut = rest.lastIndexOf('\n\n', room);
    if (cut < room * 0.4) cut = rest.lastIndexOf('\n', room);
    if (cut < room * 0.4) cut = room;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest && out.length < parts) out.push(rest);
  else if (rest) out[out.length - 1] = `${out[out.length - 1]}\n\n${more}`;
  return out;
}
