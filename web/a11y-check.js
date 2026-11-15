// R9 (docs/ACCESSIBILITY.md): Sara's own small accessibility checker. No axe-core here (it is not in
// node_modules), so these few rules, the ones that matter most for a screen reader and a keyboard:
//   img-alt          an image without alt (role="presentation"/"none" or aria-hidden are fine)
//   button-name      a button (or role="button") with no text, aria-label, aria-labelledby or title
//   link-name        a link with no name
//   control-label    an input, select or textarea without a label (placeholder alone is not one)
//   heading-order    a heading that skips a level (h2 → h4) inside the same page, dialog or section
//   contrast         theme colors (web/theme.css, light and dark) below WCAG AA (4.5:1 text, 3:1 large/UI)
//   focus-visible    no :focus-visible outline in the CSS
// It runs on static HTML (Node tests: parseHtml) and on the live page (Playwright: fromDom), over
// the same small tree, so a regression in index.html fails a test without a browser.

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW = new Set(['script', 'style', 'template', 'textarea', 'title']);
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsaquo: '›', lsaquo: '‹', times: '×' };
const decode = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m));

/** A tolerant HTML → { tag, attrs, children, text } tree (enough for these rules; not a full parser). */
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [], text: '', parent: null, line: 1 };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+|<)/g;
  let m;
  let line = 1;
  while ((m = re.exec(html))) {
    const [all, close, open, attrText, txt] = m;
    if (txt !== undefined) {
      cur.children.push({ tag: '#text', text: decode(txt), parent: cur });
    } else if (open) {
      const tag = open.toLowerCase();
      const attrs = {};
      for (const a of (attrText ?? '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[2] ?? a[3] ?? a[4] ?? '');
      const node = { tag, attrs, children: [], parent: cur, line };
      cur.children.push(node);
      if (RAW.has(tag)) {
        const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
        const body = html.slice(re.lastIndex, end < 0 ? html.length : end);
        if (tag === 'textarea' || tag === 'title') node.children.push({ tag: '#text', text: decode(body), parent: node });
        line += (body.match(/\n/g) ?? []).length;
        re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
      } else if (!VOID.has(tag) && !all.endsWith('/>')) cur = node;
    } else if (close) {
      const tag = close.toLowerCase();
      let n = cur;
      while (n && n.tag !== tag) n = n.parent;
      if (n?.parent) cur = n.parent;
    }
    line += (all.match(/\n/g) ?? []).length;
  }
  return root;
}

/** The live page → the same tree (skips what is not rendered when `visible` says so). */
export function fromDom(node, { visible = () => true } = {}) {
  const walk = (el, parent) => {
    if (el.nodeType === 3) return { tag: '#text', text: el.nodeValue, parent };
    if (el.nodeType !== 1) return null;
    const attrs = {};
    for (const a of el.attributes) attrs[a.name] = a.value;
    const n = { tag: el.localName, attrs, children: [], parent, el, hiddenLive: !visible(el) };
    for (const c of el.tagName === 'TEMPLATE' ? [] : el.childNodes) {
      const k = walk(c, n);
      if (k) n.children.push(k);
    }
    return n;
  };
  return walk(node, null);
}

const all = (n, out = []) => {
  for (const c of n.children ?? []) if (c.tag !== '#text') out.push(c), all(c, out);
  return out;
};
const hidden = (n) => {
  for (let p = n; p; p = p.parent) if (p.hiddenLive || p.attrs?.hidden !== undefined || p.attrs?.['aria-hidden'] === 'true' || p.tag === 'template') return true;
  return false;
};
const textOf = (n) => (n.tag === '#text' ? n.text : n.tag === 'img' ? (n.attrs.alt ?? '') : n.attrs?.['aria-hidden'] === 'true' ? '' : (n.children ?? []).map(textOf).join(''));
const byId = (root) => {
  const ids = new Map();
  for (const n of all(root)) if (n.attrs.id) ids.set(n.attrs.id, n);
  return ids;
};
const describe = (n) => `<${n.tag}${n.attrs.id ? `#${n.attrs.id}` : ''}${n.attrs.class ? `.${String(n.attrs.class).split(/\s+/)[0]}` : ''}>${n.line ? ` line ${n.line}` : ''}`;

function nameOf(n, ids) {
  const lb = n.attrs['aria-labelledby'];
  if (lb) {
    const t = lb.split(/\s+/).map((id) => (ids.get(id) ? textOf(ids.get(id)) : '')).join(' ').trim();
    if (t) return t;
  }
  return (n.attrs['aria-label'] ?? '').trim() || (n.attrs.title ?? '').trim();
}

/** The rules over a tree. → [{ rule, where, detail? }] */
export function checkTree(root) {
  const ids = byId(root);
  const out = [];
  const labels = all(root).filter((n) => n.tag === 'label');
  const forIds = new Set(labels.map((l) => l.attrs.for).filter(Boolean));
  for (const n of all(root)) {
    if (hidden(n)) continue;
    const role = n.attrs.role;
    if (n.tag === 'img' && n.attrs.alt === undefined && role !== 'presentation' && role !== 'none') out.push({ rule: 'img-alt', where: describe(n) });
    if (n.tag === 'button' || role === 'button') {
      if (!textOf(n).trim() && !nameOf(n, ids)) out.push({ rule: 'button-name', where: describe(n) });
    }
    if (n.tag === 'a' && n.attrs.href !== undefined && !textOf(n).trim() && !nameOf(n, ids)) out.push({ rule: 'link-name', where: describe(n) });
    if (n.tag === 'input' || n.tag === 'select' || n.tag === 'textarea') {
      const type = (n.attrs.type ?? 'text').toLowerCase();
      if (n.tag === 'input' && ['hidden', 'submit', 'reset', 'button', 'image'].includes(type)) continue;
      let wrapped = false;
      for (let p = n.parent; p; p = p.parent) if (p.tag === 'label') wrapped = Boolean(textOf(p).trim() || nameOf(p, ids));
      const named = wrapped || (n.attrs.id && forIds.has(n.attrs.id)) || nameOf(n, ids);
      if (!named) out.push({ rule: 'control-label', where: describe(n) });
    }
  }
  // Heading order within each page / dialog / section root (the first heading sets the level).
  const SCOPE = (n) => n.tag === 'dialog' || n.tag === 'main' || n.tag === 'aside' || n.tag === 'nav' || (n.tag === 'section' && /\bsettings-page\b/.test(n.attrs.class ?? '')) || n.tag === '#root';
  const scopes = new Map();
  for (const n of all(root)) {
    const m = /^h([1-6])$/.exec(n.tag);
    if (!m || hidden(n)) continue;
    let s = n.parent;
    while (s && !SCOPE(s)) s = s.parent;
    const prev = scopes.get(s);
    const level = Number(m[1]);
    if (prev !== undefined && level > prev + 1) out.push({ rule: 'heading-order', where: describe(n), detail: `h${prev} → h${level}` });
    scopes.set(s, level);
  }
  return out;
}

/** Static HTML → findings (the Node test's entry point). */
export const checkHtml = (html) => checkTree(parseHtml(html));

// ------------------------------------------------------------------ colors

/** The custom properties of every rule whose selector matches `want` (in order: later wins). */
export function themeVars(css, theme) {
  const vars = {};
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Only top-level :root rules (and ones inside @media (prefers-*) are skipped).
  let depth = 0;
  let start = 0;
  let sel = '';
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) sel = clean.slice(start, i).trim();
      depth++;
      start = i + 1;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const body = clean.slice(start, i);
        for (const s of sel.split(',').map((x) => x.trim())) {
          const ok = s === ':root' || s === `:root[data-theme="${theme}"]` || s === ':root:not([data-palette="classic"])' || s === `:root:not([data-palette="classic"])[data-theme="${theme}"]`;
          if (!ok) continue;
          for (const d of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);?/g)) vars[d[1]] = d[2].trim();
        }
        start = i + 1;
      }
      if (depth < 0) depth = 0;
    } else if (ch === ';' && depth === 0) start = i + 1;
  }
  return vars;
}

function resolve(vars, v, depth = 0) {
  if (v === undefined || depth > 8) return undefined;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(v.trim());
  if (m) return resolve(vars, vars[m[1]] ?? m[2], depth + 1);
  return v.trim();
}
/** A CSS color → [r, g, b, a] (hex, rgb(a); anything else → null). */
export function parseColor(v) {
  if (!v) return null;
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join('');
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(v);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : m[4].endsWith('%') ? Number(m[4].slice(0, -1)) / 100 : Number(m[4])];
  if (/^white$/i.test(v)) return [255, 255, 255, 1];
  if (/^black$/i.test(v)) return [0, 0, 0, 1];
  return null;
}
const lum = ([r, g, b]) => {
  const c = (x) => {
    const s = x / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
/** Over an opaque background (alpha blended). */
const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
export function contrast(fg, bg) {
  const f = over(fg, bg);
  const [a, b] = [lum(f), lum(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** Text/background pairs the app uses, with the AA minimum each needs. */
export const PAIRS = [
  ['--text-1', '--surface-0', 4.5], ['--text-2', '--surface-0', 4.5], ['--accent-text', '--surface-0', 4.5],
  ['--text-1', '--bg', 4.5], ['--text-2', '--bg', 4.5], ['--text-1', '--surface-1', 4.5], ['--text-2', '--surface-1', 4.5],
  ['--text-1', '--surface-2', 4.5], ['--text-2', '--surface-2', 4.5], ['--text-1', '--surface-3', 4.5], ['--text-2', '--surface-3', 4.5],
  ['--on-accent', '--accent', 4.5], ['--accent-text', '--bg', 4.5], ['--accent-text', '--surface-1', 4.5],
  ['--danger', '--surface-1', 4.5], ['--warn', '--surface-1', 3], ['--focus', '--bg', 3],
];

/** Theme pairs below AA in a theme ('light' | 'dark'). Pairs with a color it can't compute are skipped. */
export function checkContrast(css, theme) {
  const vars = themeVars(css, theme);
  const out = [];
  const bg0 = parseColor(resolve(vars, vars['--bg'] ?? vars['--surface-0'])) ?? (theme === 'dark' ? [0, 0, 0, 1] : [255, 255, 255, 1]);
  for (const [f, b, min] of PAIRS) {
    const fg = parseColor(resolve(vars, vars[f]));
    let bg = parseColor(resolve(vars, vars[b]));
    if (!fg || !bg) continue;
    if (bg[3] < 1) bg = [...over(bg, bg0), 1];
    const r = contrast(fg, bg);
    if (r < min) out.push({ rule: 'contrast', where: `${theme}: ${f} on ${b}`, detail: `${r.toFixed(2)}:1 < ${min}:1` });
  }
  return out;
}

/** Whether the CSS gives keyboard focus a visible ring. */
export function hasFocusVisible(css) {
  return /:focus-visible[^{]*\{[^}]*(?:outline\s*:\s*(?!none|0)[^;]+|box-shadow\s*:)/.test(css);
}
