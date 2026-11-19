// D3 Live canvas (src/canvas.ts): the script every live view gets, served at <view>/_sara/canvas.js.
// It runs INSIDE the sandboxed frame (opaque origin, no Sara session): it reads the view's own state
// from <view>/_state, draws a checklist / table / chart (or hands the data to her small html page
// through `saraCanvas`), polls for changes while the page is visible, and tells the chat its height.
// No imports, no storage, nothing but its own address.
(() => {
  const base = location.pathname.replace(/[^/]*$/, '');
  const POLL = 3000;
  const SLOW = 15000;
  const SLOW_AFTER = 10 * 60_000;
  const started = Date.now();
  let rev = '';
  let state = null;
  let timer = 0;
  let failing = false;
  const listeners = [];
  let words = { empty: 'Nothing here yet.', done: '{done} of {total} done', offline: 'Not updating right now; trying again.', failed: 'That did not save. Try again.', live: 'Live' };
  const fill = (s, p) => String(s).replace(/\{(\w+)\}/g, (_, k) => (p[k] ?? ''));

  // Colours come from the chat page through the address (#t=dark&accent=…); only plain colours pass.
  const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([0-9., %]+\)|hsla?\([0-9., %deg]+\))$/i;
  function applyTheme() {
    const p = new URLSearchParams(location.hash.slice(1));
    const root = document.documentElement;
    root.dataset.theme = p.get('t') === 'dark' ? 'dark' : 'light';
    for (const k of ['accent', 'text', 'muted', 'surface', 'line', 'ok']) {
      const v = p.get(k);
      if (v && COLOR.test(v)) root.style.setProperty(`--cv-${k}`, v);
      else root.style.removeProperty(`--cv-${k}`);
    }
  }
  const CSS = `
:root { --cv-text: #1d2433; --cv-muted: #5b6473; --cv-surface: #ffffff; --cv-line: #d9dee7; --cv-accent: #2f6fd6; --cv-ok: #1f8a4c; color-scheme: light; }
:root[data-theme="dark"] { --cv-text: #e8ebf1; --cv-muted: #a4acba; --cv-surface: #171b23; --cv-line: #323a48; --cv-accent: #7aa7ff; --cv-ok: #5ccf8d; color-scheme: dark; }
html, body { margin: 0; padding: 0; background: var(--cv-surface); color: var(--cv-text); font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
#cv { padding: 10px 12px 12px; }
.cv-note { color: var(--cv-muted); font-size: 13px; margin: 6px 0 0; }
.cv-warn { color: var(--cv-muted); font-size: 13px; margin: 0 0 6px; }
.cv-list { list-style: none; margin: 0; padding: 0; }
.cv-list li { border-bottom: 1px solid var(--cv-line); }
.cv-list li:last-child { border-bottom: 0; }
.cv-list label { display: flex; gap: 10px; align-items: center; min-height: 44px; cursor: pointer; }
.cv-list input { width: 20px; height: 20px; margin: 0; flex: 0 0 auto; accent-color: var(--cv-accent); }
.cv-list .done span { color: var(--cv-muted); text-decoration: line-through; }
.cv-bar { height: 6px; border-radius: 3px; background: var(--cv-line); overflow: hidden; margin: 2px 0 6px; }
.cv-bar i { display: block; height: 100%; background: var(--cv-ok); }
.cv-scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--cv-line); vertical-align: top; }
th { color: var(--cv-muted); font-weight: 600; white-space: nowrap; }
.cv-bars { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.cv-bars li { display: grid; grid-template-columns: minmax(60px, 30%) 1fr auto; gap: 8px; align-items: center; font-size: 14px; }
.cv-bars .l { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cv-bars .t { display: block; min-width: 0; }
.cv-bars .b { display: block; height: 14px; border-radius: 4px; background: var(--cv-accent); min-width: 2px; }
.cv-bars .v { color: var(--cv-muted); font-variant-numeric: tabular-nums; }
svg.cv-line { width: 100%; height: 160px; display: block; }
svg.cv-line polyline { fill: none; stroke: var(--cv-accent); stroke-width: 2; vector-effect: non-scaling-stroke; }
svg.cv-line circle { fill: var(--cv-accent); }
.cv-axis { display: flex; justify-content: space-between; color: var(--cv-muted); font-size: 12px; gap: 8px; }
`;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const num = (n) => {
    try {
      return Number(n).toLocaleString(document.documentElement.lang || undefined);
    } catch {
      return String(n);
    }
  };

  function tellHeight() {
    const h = Math.ceil(document.documentElement.scrollHeight);
    try {
      parent.postMessage({ saraCanvas: 'height', h }, '*');
    } catch {
      /* no parent */
    }
  }

  async function send(path, body) {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error('save');
  }

  function checklist(host, s) {
    const items = s.items || [];
    const done = items.filter((i) => i.done).length;
    if (items.length) {
      host.append(el('p', 'cv-note', fill(words.done, { done: num(done), total: num(items.length) })));
      const bar = el('div', 'cv-bar');
      const fillEl = el('i');
      fillEl.style.width = `${Math.round((done / items.length) * 100)}%`;
      bar.append(fillEl);
      host.append(bar);
    }
    const ul = el('ul', 'cv-list');
    for (const it of items) {
      const li = el('li', it.done ? 'done' : '');
      const label = el('label');
      const box = el('input');
      box.type = 'checkbox';
      box.checked = Boolean(it.done);
      box.disabled = !s.canTick;
      box.addEventListener('change', async () => {
        li.classList.toggle('done', box.checked);
        try {
          await send('_tick', { item: it.id, done: box.checked });
          void poll(true);
        } catch {
          box.checked = !box.checked;
          li.classList.toggle('done', box.checked);
          note(words.failed);
        }
      });
      label.append(box, el('span', '', it.text));
      li.append(label);
      ul.append(li);
    }
    host.append(ul);
  }

  function table(host, s) {
    const wrap = el('div', 'cv-scroll');
    const tb = el('table');
    const head = el('tr');
    for (const c of s.columns || []) head.append(el('th', '', c));
    const thead = el('thead');
    thead.append(head);
    const body = el('tbody');
    for (const r of s.rows || []) {
      const tr = el('tr');
      for (const c of r) tr.append(el('td', '', c));
      body.append(tr);
    }
    tb.append(thead, body);
    wrap.append(tb);
    host.append(wrap);
  }

  function chart(host, s) {
    const bars = (s.bars || []).filter((b) => Number.isFinite(b.value));
    if (s.chartType === 'line' && bars.length > 1) {
      const lo = Math.min(...bars.map((b) => b.value));
      const hi = Math.max(...bars.map((b) => b.value));
      const span = hi - lo || 1;
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'cv-line');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'none');
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', bars.map((b) => `${b.label}: ${num(b.value)}`).join(', '));
      const pts = bars.map((b, i) => `${(i / (bars.length - 1)) * 100},${96 - ((b.value - lo) / span) * 92}`);
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', pts.join(' '));
      svg.append(line);
      host.append(svg);
      const axis = el('div', 'cv-axis');
      axis.append(el('span', '', `${bars[0].label}: ${num(bars[0].value)}`), el('span', '', `${bars.at(-1).label}: ${num(bars.at(-1).value)}`));
      host.append(axis);
      return;
    }
    const top = Math.max(0, ...bars.map((b) => b.value));
    const ul = el('ul', 'cv-bars');
    for (const b of bars) {
      const li = el('li');
      const bar = el('span', 'b');
      bar.style.width = `${top > 0 ? Math.max(1, (Math.max(0, b.value) / top) * 100) : 0}%`;
      const track = el('span', 't');
      track.append(bar);
      li.append(el('span', 'l', b.label), track, el('span', 'v', num(b.value)));
      ul.append(li);
    }
    host.append(ul);
  }

  function note(text) {
    const host = document.getElementById('cv');
    if (!host) return;
    host.querySelector('.cv-flash')?.remove();
    const p = el('p', 'cv-note cv-flash', text);
    host.prepend(p);
    tellHeight();
  }

  function draw(s) {
    const host = document.getElementById('cv');
    if (!host) {
      for (const f of listeners) {
        try {
          f(s.data, s);
        } catch (err) {
          console.error(err);
        }
      }
      tellHeight();
      return;
    }
    host.replaceChildren();
    if (s.problem) host.append(el('p', 'cv-warn', s.problem));
    const empty = (s.kind === 'checklist' && !(s.items || []).length) || (s.kind === 'table' && !(s.rows || []).length) || (s.kind === 'chart' && !(s.bars || []).length);
    if (empty && !s.problem) host.append(el('p', 'cv-note', words.empty));
    else if (s.kind === 'checklist') checklist(host, s);
    else if (s.kind === 'table') table(host, s);
    else if (s.kind === 'chart') chart(host, s);
    tellHeight();
  }

  async function poll(now) {
    clearTimeout(timer);
    if (document.visibilityState === 'hidden' && !now) return;
    try {
      const r = await fetch(`${base}_state${rev ? `?rev=${encodeURIComponent(rev)}` : ''}`);
      if (r.status === 200) {
        state = await r.json();
        rev = state.rev;
        draw(state);
      } else if (r.status !== 204) throw new Error(String(r.status));
      if (failing) {
        failing = false;
        document.querySelector('.cv-flash')?.remove();
        tellHeight();
      }
    } catch {
      if (!failing) note(words.offline);
      failing = true;
    }
    timer = setTimeout(poll, Date.now() - started > SLOW_AFTER ? SLOW : POLL);
  }

  window.saraCanvas = {
    get data() {
      return state ? state.data : null;
    },
    onData(fn) {
      if (typeof fn !== 'function') return;
      listeners.push(fn);
      if (state) fn(state.data, state);
    },
    async save(data) {
      await send('_save', { data });
      void poll(true);
      return data;
    },
  };

  function start() {
    try {
      const w = JSON.parse(document.getElementById('cv-words')?.textContent || '{}');
      words = { ...words, ...w };
    } catch {
      /* defaults */
    }
    applyTheme();
    const style = document.createElement('style');
    // Her own html page keeps its own look: it only gets the colour variables (--cv-text, …).
    style.textContent = document.getElementById('cv') ? CSS : CSS.split('\nhtml, body')[0];
    document.head.append(style);
    if (typeof ResizeObserver === 'function') new ResizeObserver(tellHeight).observe(document.body);
    void poll(true);
  }
  window.addEventListener('hashchange', applyTheme);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void poll(true);
  });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
