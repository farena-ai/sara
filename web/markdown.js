// Safe Markdown for chat replies. parse() turns text into a small tree; toDom() builds real DOM
// nodes from it with textContent only, so model output can never inject HTML or scripts.
// Supported: paragraphs, line breaks, # headings, - / * / 1. lists (one nesting level by indent),
// > quotes, ``` code fences (language label), --- rules, `code`, **bold**, *italic* / _italic_,
// ~~strike~~, [links](https://…) and bare https:// links, and | pipe | tables | (V1: a header row,
// a --- separator row, optional :--: alignment). Anything else stays plain text.

/** @typedef {{ t: string, [k: string]: any }} Node */

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
// A table's separator row: | --- | :--: | --: | (outer pipes optional, at least one inner pipe or an outer one).
const TABLE_SEP = /^ {0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The cells of one table row: split on pipes that are not escaped and not inside a code span. */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out = [];
  let cur = '';
  let tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += tick ? '\\|' : '|';
      i++;
    } else if (c === '`') {
      tick = tick ? 0 : 1;
      cur += c;
    } else if (c === '|' && !tick) {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}
/** True when lines[i] is a table header: it has a pipe and the next line is a separator row with the same cells. */
function tableAt(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head || sep === undefined || !head.includes('|') || !TABLE_SEP.test(sep) || !sep.includes('|') && !/\|/.test(head)) return false;
  return cells(sep).length === cells(head).length;
}

/** Block-level parse. An unclosed fence (still streaming) becomes an open code block. */
export function parse(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  /** @type {Node[]} */
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const body = [];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      const closed = i < lines.length;
      i++;
      out.push({ t: 'code', lang: fence[2] || '', text: body.join('\n'), open: !closed });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      out.push({ t: 'h', level: h[1].length, kids: inline(h[2]) });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])[1]);
      out.push({ t: 'quote', kids: parse(body.join('\n')) });
      continue;
    }
    if (tableAt(lines, i)) {
      const head = cells(lines[i]);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const r = cells(lines[i++]).slice(0, head.length);
        while (r.length < head.length) r.push('');
        rows.push(r.map((c) => inline(c)));
      }
      out.push({ t: 'table', align, head: head.map((c) => inline(c)), rows });
      continue;
    }
    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEADING.test(lines[i]) && !QUOTE.test(lines[i]) && !RULE.test(lines[i]) && !tableAt(lines, i) && !(para.length && (BULLET.test(lines[i]) || ORDERED.test(lines[i])))) {
      para.push(lines[i++]);
    }
    out.push({ t: 'p', kids: inlineLines(para) });
  }
  return out;
}

function parseList(lines, start) {
  const first = BULLET.exec(lines[start]) ?? ORDERED.exec(lines[start]);
  const ordered = !BULLET.test(lines[start]);
  const indent = first[1].length;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = (ordered ? ORDERED : BULLET).exec(line);
    if (m && m[1].length <= indent + 1) {
      items.push({ text: [m[3]], sub: [] });
      i++;
      continue;
    }
    if (!items.length) break;
    const any = BULLET.exec(line) ?? ORDERED.exec(line);
    if (any && any[1].length > indent + 1) {
      const [sub, next] = parseList(lines, i);
      items.at(-1).sub.push(sub);
      i = next;
      continue;
    }
    // Continuation line (indented text under an item); a blank line followed by another item keeps the list going.
    if (line.trim() && /^\s{2,}/.test(line) && !any) {
      items.at(-1).text.push(line.trim());
      i++;
      continue;
    }
    if (!line.trim() && i + 1 < lines.length && (ordered ? ORDERED : BULLET).test(lines[i + 1])) {
      i++;
      continue;
    }
    break;
  }
  const startNum = ordered ? Number(first[2]) : 1;
  return [{ t: ordered ? 'ol' : 'ul', start: startNum, items: items.map((it) => ({ kids: inlineLines(it.text), sub: it.sub })) }, i];
}

function inlineLines(lines) {
  const kids = [];
  lines.forEach((l, n) => {
    if (n) kids.push({ t: 'br' });
    kids.push(...inline(l.replace(/\s+$/, '')));
  });
  return kids;
}

const SAFE_URL = /^(https?:\/\/|mailto:)[^\s<>"]+$/i;
/** Links inside the app: a page (/#view=…), a tour (/#tour=…) or the guide (/help#…). */
const APP_URL = /^\/(#(view|tour)=[\w:-]+|help(#[\w-]+)?)$/;

/** Inline parse: code spans first (their contents are literal), then links, emphasis, bare URLs. */
export function inline(s) {
  /** @type {Node[]} */
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && /[\\`*_[\]()#~>-]/.test(s[i + 1])) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const ticks = /^`+/.exec(s.slice(i))[0];
      const end = s.indexOf(ticks, i + ticks.length);
      if (end > 0) {
        flush();
        out.push({ t: 'code', text: s.slice(i + ticks.length, end).replace(/^ (.+) $/, '$1') });
        i = end + ticks.length;
        continue;
      }
    }
    if (c === '[') {
      // (Models sometimes write an in-app link as "/ #view=…": that space is dropped.)
      // (Phase 74: and sometimes without the slash, "#view=library:3:412": that is the same page.)
      const m = /^\[([^\]\n]+)\]\(\s*([^\s)]+|\/ #(?:view|tour)=[\w:-]+)\s*\)/.exec(s.slice(i));
      // (Small models also wrap it in emphasis, "(_#view=library:3:412_)": the marks are dropped.)
      if (m) m[2] = m[2].replace(/^\/ #/, '/#').replace(/^[_*]{1,2}(\/?#(?:view|tour)=[\w:-]+?)[_*]{1,2}$/, '$1').replace(/^#((?:view|tour)=[\w:-]+)$/, '/#$1');
      if (m && (SAFE_URL.test(m[2]) || APP_URL.test(m[2]))) {
        flush();
        out.push({ t: 'a', href: m[2], kids: inline(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    if ((c === '*' || c === '_' || c === '~') && s[i + 1] === c) {
      const mark = c + c;
      const end = s.indexOf(mark, i + 2);
      if (end > i + 2 && s[i + 2] !== ' ') {
        flush();
        out.push({ t: c === '~' ? 'del' : 'strong', kids: inline(s.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] !== ' ' && s[i + 1] !== c) {
      // _ only counts at word edges, so snake_case stays as typed.
      const before = s[i - 1] ?? ' ';
      if (c === '*' || !/\w/.test(before)) {
        let end = i + 1;
        for (;;) {
          end = s.indexOf(c, end);
          if (end < 0) break;
          if (s[end - 1] !== ' ' && (c === '*' || !/\w/.test(s[end + 1] ?? ' '))) break;
          end++;
        }
        if (end > i + 1) {
          flush();
          out.push({ t: 'em', kids: inline(s.slice(i + 1, end)) });
          i = end + 1;
          continue;
        }
      }
    }
    if ((c === 'h' || c === 'H') && /^https?:\/\//i.test(s.slice(i, i + 8)) && !/\w/.test(s[i - 1] ?? ' ')) {
      const m = /^https?:\/\/[^\s<>"]+/i.exec(s.slice(i));
      let url = m[0];
      while (/[.,;:!?)'\]]$/.test(url)) url = url.slice(0, -1);
      flush();
      out.push({ t: 'a', href: url, kids: [{ t: 'text', text: url }] });
      i += url.length;
      continue;
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** Plain text of a tree (for copy/speech fallbacks and tests). */
export function plain(nodes) {
  return nodes.map((n) => (n.t === 'table' ? [n.head, ...n.rows].map((r) => r.map((c) => plain(c)).join('\t')).join('\n') : n.t === 'text' || n.t === 'code' ? n.text : n.t === 'br' ? '\n' : n.kids ? plain(n.kids) : '')).join('');
}

/**
 * Builds DOM nodes. `opts.onCopy(text, button)` is called by a code block's Copy button
 * (`opts.copyLabel`: its label in the app language).
 * @returns {DocumentFragment}
 */
export function toDom(nodes, doc = document, opts = {}) {
  const frag = doc.createDocumentFragment();
  for (const n of nodes) frag.append(node(n, doc, opts));
  return frag;
}

function el(doc, tag, kids, opts) {
  const e = doc.createElement(tag);
  if (kids) e.append(toDom(kids, doc, opts));
  return e;
}

function node(n, doc, opts) {
  switch (n.t) {
    case 'text':
      return doc.createTextNode(n.text);
    case 'br':
      return doc.createElement('br');
    case 'hr':
      return doc.createElement('hr');
    case 'p':
      return el(doc, 'p', n.kids, opts);
    case 'h':
      return el(doc, `h${Math.min(6, n.level + 2)}`, n.kids, opts);
    case 'strong':
    case 'em':
    case 'del':
      return el(doc, n.t, n.kids, opts);
    case 'quote':
      return el(doc, 'blockquote', n.kids, opts);
    case 'a': {
      const a = el(doc, 'a', n.kids, opts);
      a.href = n.href;
      // In-app links (a page, a tour) open in place; everything else in a new tab.
      if (!/^\/#/.test(n.href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      return a;
    }
    case 'ul':
    case 'ol': {
      const list = doc.createElement(n.t);
      if (n.t === 'ol' && n.start !== 1) list.start = n.start;
      for (const it of n.items) {
        const li = el(doc, 'li', it.kids, opts);
        for (const sub of it.sub) li.append(node(sub, doc, opts));
        list.append(li);
      }
      return list;
    }
    case 'table': {
      // Wide tables scroll sideways inside their own box (phones), never the whole reply.
      const wrap = doc.createElement('div');
      wrap.className = 'md-table';
      const table = doc.createElement('table');
      const row = (list, tag) => {
        const tr = doc.createElement('tr');
        list.forEach((kids, i) => {
          const c = el(doc, tag, kids, opts);
          if (n.align[i]) c.className = `ta-${n.align[i]}`;
          if (tag === 'th') c.setAttribute?.('scope', 'col');
          tr.append(c);
        });
        return tr;
      };
      const thead = doc.createElement('thead');
      thead.append(row(n.head, 'th'));
      const tbody = doc.createElement('tbody');
      for (const r of n.rows) tbody.append(row(r, 'td'));
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }
    case 'code': {
      if (!('lang' in n)) {
        const c = doc.createElement('code');
        c.textContent = n.text;
        return c;
      }
      const wrap = doc.createElement('div');
      wrap.className = 'code-block';
      const head = doc.createElement('div');
      head.className = 'code-head';
      const lang = doc.createElement('span');
      lang.textContent = n.lang || 'code';
      head.append(lang);
      if (!n.open) {
        const btn = doc.createElement('button');
        btn.type = 'button';
        btn.className = 'ghost small copy-code';
        btn.textContent = opts.copyLabel ?? 'Copy';
        btn.addEventListener?.('click', () => opts.onCopy?.(n.text, btn));
        head.append(btn);
      }
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = n.text;
      pre.append(code);
      wrap.append(head, pre);
      return wrap;
    }
    default:
      return doc.createTextNode('');
  }
}
