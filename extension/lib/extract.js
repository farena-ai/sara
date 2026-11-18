// U4.25 (docs/EXTENSION.md): the readable text of a page, read in the page itself (injected by the
// popup with chrome.scripting after you click; nothing runs on pages before that). The article or
// main part when there is one, else the body; never scripts, styles, menus, forms, hidden or
// aria-hidden parts. Plain script (no import/export) so it can be injected as a file; tests load it
// with import() and read globalThis.SaraExtract.
(() => {
  const MAX_TEXT = 20000;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'NAV', 'ASIDE', 'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'DIALOG']);
  const OUTER = new Set(['HEADER', 'FOOTER']);
  const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'MAIN', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'UL', 'OL', 'DL', 'DT', 'DD', 'TR', 'TABLE', 'BLOCKQUOTE', 'PRE', 'FIGURE', 'FIGCAPTION', 'BR', 'HR', 'ADDRESS', 'DETAILS', 'SUMMARY']);

  const tag = (n) => String(n.tagName || '').toUpperCase();
  const attr = (n, a) => (typeof n.getAttribute === 'function' ? n.getAttribute(a) : null);

  function hiddenEl(n) {
    if (n.hidden || attr(n, 'aria-hidden') === 'true') return true;
    const view = n.ownerDocument && n.ownerDocument.defaultView;
    if (view && typeof view.getComputedStyle === 'function') {
      const s = view.getComputedStyle(n);
      if (s && (s.display === 'none' || s.visibility === 'hidden')) return true;
    }
    return false;
  }

  function findRoot(n) {
    if (n.nodeType === 1 && (tag(n) === 'ARTICLE' || tag(n) === 'MAIN' || attr(n, 'role') === 'main') && !hiddenEl(n)) return n;
    for (const c of n.childNodes || []) {
      if (c.nodeType !== 1 || SKIP.has(tag(c))) continue;
      const r = findRoot(c);
      if (r) return r;
    }
    return null;
  }

  /** The page's readable text, one line per block, capped at `max` characters (… at the end). */
  function readableText(doc, opts = {}) {
    const max = Math.max(50, Math.min(Number(opts.max) || MAX_TEXT, MAX_TEXT));
    const body = doc.body || doc.documentElement;
    if (!body) return '';
    const article = findRoot(body);
    const root = article || body;
    const out = [];
    let size = 0;
    const walk = (n) => {
      if (size > max * 2) return;
      if (n.nodeType === 3) {
        const v = String(n.nodeValue || '');
        out.push(v);
        size += v.length;
        return;
      }
      if (n.nodeType !== 1) return;
      const t = tag(n);
      if (SKIP.has(t) || (!article && OUTER.has(t)) || hiddenEl(n)) return;
      const block = BLOCK.has(t);
      if (block) out.push('\n');
      for (const c of n.childNodes || []) walk(c);
      if (block) out.push('\n');
    };
    walk(root);
    const text = out
      .join('')
      .split('\n')
      .map((l) => l.replace(/[\s\u00a0]+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  globalThis.SaraExtract = { readableText, MAX_TEXT };
})();
