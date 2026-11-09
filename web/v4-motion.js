// V4e (docs/ops/V4_DESIGN.md → V4e): small, quiet motion so the dashboard feels alive, not flat.
// The CSS (web/v4-living.css, V4e block) does the card entrance, hover lift, breathing orb glow, the
// hero border's slow shimmer, the mood dot's pulse and the progress bars. This module does the two
// things CSS can't: a sparkline draws in once (a wipe, class v4e-draw) and a few headline numbers
// count up once. Both run once per page session per place (a refresh redraws without replaying),
// never with reduced motion or Settings → Appearance → Background motion: Off, and never in Sara
// Classic. It also marks the page hidden (data-tab-hidden) so the CSS pauses its loops.
//
// Pure helpers (countFrames, numberParts) are exported for the tests; no DOM work at import time.

/** The number inside a short headline like "63°", "$0.43", "1,204" or "12": [prefix, value, decimals, suffix] or null. */
export function numberParts(text) {
  const m = /^(\D{0,2}?)(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))?(\D{0,3})$/.exec(String(text ?? '').trim());
  if (!m) return null;
  const value = Number(`${m[2].replace(/,/g, '')}${m[3] ? `.${m[3]}` : ''}`);
  return Number.isFinite(value) ? [m[1], value, m[3]?.length ?? 0, m[4]] : null;
}

/** The text at progress p (0..1, eased) of a count from 0 to the value. */
export function countFrame(parts, p) {
  const [pre, value, dec, suf] = parts;
  const e = 1 - (1 - Math.min(1, Math.max(0, p))) ** 3;
  const v = value * e;
  const s = dec ? v.toFixed(dec) : String(Math.round(v));
  return `${pre}${value >= 1000 && !dec ? Number(s).toLocaleString('en-US') : s}${suf}`;
}

/** Motion is allowed: not reduced (system or Settings), not Sara Classic. */
export function motionOn(root = globalThis.document?.documentElement, mm = globalThis.matchMedia) {
  if (!root) return false;
  if (root.dataset.motion === 'off' || root.dataset.palette === 'classic') return false;
  return !(mm && mm('(prefers-reduced-motion: reduce)').matches);
}

const COUNT = ['#today .td-wx-temp', '#v4-g-spend-big'];
const DRAW = ['#today .td-wx-spark .spark-line', '#today .td-usage-spark .spark-line', '#v4-g-spark .v4-spark-line'];
const done = new Set();

function countUp(node, key) {
  const parts = numberParts(node.textContent);
  if (!parts || parts[1] === 0) return;
  done.add(key);
  const final = node.textContent;
  // No layout shift: hold the final width while the digits change.
  node.style.minWidth = `${node.getBoundingClientRect().width}px`;
  node.style.display ||= 'inline-block';
  const t0 = performance.now();
  const step = (now) => {
    if (node.textContent !== final && !node.dataset.v4eCounting) return; // redrawn meanwhile
    const p = (now - t0) / 700;
    node.dataset.v4eCounting = '1';
    node.textContent = p >= 1 ? final : countFrame(parts, p);
    if (p < 1 && document.visibilityState === 'visible') requestAnimationFrame(step);
    else {
      node.textContent = final;
      delete node.dataset.v4eCounting;
      node.style.minWidth = '';
    }
  };
  requestAnimationFrame(step);
}

function drawIn(line, key) {
  done.add(key);
  // A left-to-right wipe of the whole sparkline (clip-path in the CSS): the same in every browser,
  // whatever the line's stroke settings.
  (line.closest('svg') ?? line).classList.add('v4e-draw');
}

function scan() {
  if (!motionOn()) return;
  for (const sel of COUNT) {
    if (done.has(sel)) continue;
    const n = document.querySelector(sel);
    if (n && n.getClientRects().length) countUp(n, sel);
  }
  for (const sel of DRAW) {
    if (done.has(sel)) continue;
    const n = document.querySelector(sel);
    if (n && n.getClientRects().length) drawIn(n, sel);
  }
}

/** Starts watching (once). */
export function initMotion(doc = globalThis.document) {
  if (!doc || doc.documentElement.dataset.v4eMotion) return;
  doc.documentElement.dataset.v4eMotion = '1';
  const hidden = () => doc.documentElement.toggleAttribute('data-tab-hidden', doc.visibilityState === 'hidden');
  doc.addEventListener('visibilitychange', hidden);
  hidden();
  let queued = false;
  const later = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      scan();
    });
  };
  for (const id of ['today', 'v4-glance']) {
    const host = doc.getElementById(id);
    if (host) new MutationObserver(later).observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'hidden'] });
  }
  later();
}
