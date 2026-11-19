// D3 Live canvas (src/canvas.ts, docs/design/LIVE_CANVAS.md): a live view she posted in the chat.
// The card keeps only the view's number; its address is fetched here with the Sara session (so a
// shared chat never carries it). The view runs in an iframe with sandbox="allow-scripts" only (the
// server adds the same CSP sandbox): an opaque origin that can't read this page, Sara's cookies,
// storage or API. The only thing it may tell us is its height, and only from its own frame.
import { t } from './naming.js';

const MIN_H = 60;
const MAX_H = 900;
const frames = new Set();
let listening = false;
let watching = false;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ? t(data.error) : res.statusText), { status: res.status });
  return data;
}

const KIND = { checklist: () => t('Live checklist'), table: () => t('Live table'), chart: () => t('Live chart'), html: () => t('Live view') };

/** The page's colours as plain rgb() values (theme variables resolved), for the frame's address. */
function themeHash() {
  const root = document.documentElement;
  const p = new URLSearchParams({ t: root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light' });
  const probe = el('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  document.body.append(probe);
  const pick = { accent: 'var(--accent-solid, var(--accent))', text: 'var(--text-1)', muted: 'var(--text-2)', surface: 'var(--surface-1)', line: 'var(--hairline-strong)', ok: 'var(--success)' };
  for (const [k, v] of Object.entries(pick)) {
    probe.style.color = '';
    probe.style.color = v;
    const c = getComputedStyle(probe).color;
    if (/^rgba?\(/.test(c)) p.set(k, c.replace(/\s+/g, ''));
  }
  probe.remove();
  return p.toString();
}

function onMessage(e) {
  if (e.origin !== 'null') return;
  for (const f of frames) {
    if (!f.isConnected) {
      frames.delete(f);
      continue;
    }
    if (f.contentWindow === e.source) {
      const m = e.data;
      if (m && typeof m === 'object' && m.saraCanvas === 'height' && Number.isFinite(m.h)) f.style.height = `${Math.max(MIN_H, Math.min(MAX_H, Math.round(m.h) + 2))}px`;
      return;
    }
  }
}

/** A theme switch repaints every live view (only the address hash changes: no reload). */
function watchTheme() {
  if (watching) return;
  watching = true;
  new MutationObserver(() => {
    const hash = themeHash();
    for (const f of frames) if (f.isConnected && f.dataset.base && f.dataset.hash !== hash) {
      f.dataset.hash = hash;
      f.src = `${f.dataset.base}#${hash}`;
    }
  }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-look', 'class'] });
}

export function canvasCard(c) {
  const title = String(c.title || '') || KIND[c.view]?.() || t('Live view');
  const card = el('div', 'rcard rcard-canvas');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', title);
  const head = el('div', 'rcard-head');
  const live = el('span', 'cvc-live', t('Live'));
  head.append(el('span', 'rcard-title', title), el('span', 'rcard-meta muted small', (KIND[c.view] ?? KIND.html)()), live);
  card.append(head);
  const id = Number(c.id);
  if (!Number.isInteger(id) || id <= 0) return card;
  const body = el('div', 'cvc-body');
  const foot = el('div', 'cvc-foot');
  foot.append(el('span', 'muted small', t('Updates by itself. Runs apart from Sara, without your sign-in.')));
  const remove = el('button', 'ghost small cvc-remove', t('Remove'));
  remove.type = 'button';
  foot.append(remove);
  card.append(body, foot);
  const gone = () => {
    body.replaceChildren(el('p', 'muted small', t('This live view was removed.')));
    live.hidden = true;
    remove.hidden = true;
  };
  remove.addEventListener('click', async () => {
    if (!confirm(t('Remove the live view "{name}"? It stops updating in every chat.', { name: title }))) return;
    try {
      await api(`/library/canvases/${id}`, { method: 'DELETE' });
      gone();
    } catch (err) {
      foot.querySelector('.cvc-err')?.remove();
      foot.prepend(el('span', 'small cvc-err', err.message));
    }
  });
  api(`/library/canvases/${id}`).then(
    (d) => {
      const path = String(d.canvas?.openPath ?? '');
      if (!/^\/myapp\/[A-Za-z0-9]+\/cv[A-Za-z0-9_-]{22}\/$/.test(path)) return gone();
      const frame = document.createElement('iframe');
      frame.className = 'cvc-frame';
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('allow', '');
      frame.setAttribute('loading', 'lazy');
      frame.title = title;
      frame.dataset.base = path;
      frame.dataset.hash = themeHash();
      frame.src = `${path}#${frame.dataset.hash}`;
      frames.add(frame);
      if (!listening) {
        listening = true;
        window.addEventListener('message', onMessage);
      }
      watchTheme();
      body.append(frame);
    },
    (err) => (err.status === 404 ? gone() : body.replaceChildren(el('p', 'muted small', err.message))),
  );
  return card;
}
