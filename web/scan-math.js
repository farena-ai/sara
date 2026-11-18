// V2.5 Snap and file (docs/design/SNAP.md): the page math behind a scan, with no DOM so tests run
// it in Node. Find the page on the table (its four corners), cut it out straight (a perspective
// warp, so a page photographed at an angle becomes a rectangle), measure the tilt of text lines when
// the page fills the photo, turn by a quarter and even out the light. Images are plain arrays:
// grey = Uint8Array(w*h), colour = RGBA Uint8ClampedArray(w*h*4), corners = [tl, tr, br, bl].

/** RGBA → grey (luma). */
export function toGray(rgba, w, h) {
  const g = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8;
  return g;
}

/** Otsu's threshold, and how far apart the two classes are (0 = one flat colour). */
function otsu(g) {
  const hist = new Float64Array(256);
  for (let i = 0; i < g.length; i++) hist[g[i]]++;
  const n = g.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = -1;
  let t = 127;
  let gap = 0;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) ** 2;
    if (v > best) {
      best = v;
      t = i;
      gap = mF - mB;
    }
  }
  return { t, gap };
}

const full = (w, h) => [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];

/**
 * The page's four corners in a grey photo: the bright region around the middle (paper on a darker
 * table). `found: false` (and the whole frame) when there is no clear page edge: the page fills the
 * photo, or the light is too flat to tell.
 */
export function findPageQuad(g, w, h) {
  const { t, gap } = otsu(g);
  if (gap < 40) return { found: false, corners: full(w, h) };
  // The bright pixel nearest the middle starts the region.
  const cx = w >> 1;
  const cy = h >> 1;
  let start = -1;
  for (let r = 0; r < Math.max(w, h) / 2 && start < 0; r++)
    for (let dy = -r; dy <= r && start < 0; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && g[y * w + x] > t) {
          start = y * w + x;
          break;
        }
      }
  if (start < 0) return { found: false, corners: full(w, h) };
  const seen = new Uint8Array(w * h);
  const stack = [start];
  seen[start] = 1;
  let area = 0;
  let tl = start;
  let br = start;
  let tr = start;
  let bl = start;
  const xy = (i) => [i % w, (i / w) | 0];
  while (stack.length) {
    const i = stack.pop();
    area++;
    const [x, y] = xy(i);
    const [tx, ty] = xy(tl);
    if (x + y < tx + ty) tl = i;
    const [bx, by] = xy(br);
    if (x + y > bx + by) br = i;
    const [rx, ry] = xy(tr);
    if (x - y > rx - ry) tr = i;
    const [lx, ly] = xy(bl);
    if (x - y < lx - ly) bl = i;
    if (x > 0 && !seen[i - 1] && g[i - 1] > t) (seen[i - 1] = 1), stack.push(i - 1);
    if (x < w - 1 && !seen[i + 1] && g[i + 1] > t) (seen[i + 1] = 1), stack.push(i + 1);
    if (y > 0 && !seen[i - w] && g[i - w] > t) (seen[i - w] = 1), stack.push(i - w);
    if (y < h - 1 && !seen[i + w] && g[i + w] > t) (seen[i + w] = 1), stack.push(i + w);
  }
  const share = area / (w * h);
  if (share < 0.15 || share > 0.97) return { found: false, corners: full(w, h) };
  const corners = [tl, tr, br, bl].map((i) => {
    const [x, y] = xy(i);
    return { x, y };
  });
  return { found: true, corners };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/** The size of the straightened page: the mean of opposite edges. */
export function outSize(c) {
  return { w: Math.max(1, Math.round((dist(c[0], c[1]) + dist(c[3], c[2])) / 2)), h: Math.max(1, Math.round((dist(c[0], c[3]) + dist(c[1], c[2])) / 2)) };
}

/** The 3×3 projective map (8 numbers) taking the output rectangle's corners to the quad. */
function homography(W, H, c) {
  const from = [[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]];
  const A = [];
  for (let k = 0; k < 4; k++) {
    const [x, y] = from[k];
    const { x: u, y: v } = c[k];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col] || 1e-12;
    for (let k = col; k < 9; k++) A[col][k] /= d;
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col];
      if (f) for (let k = col; k < 9; k++) A[r][k] -= f * A[col][k];
    }
  }
  return A.map((r) => r[8]);
}

/** Cuts the quad out of an RGBA picture as a W×H rectangle (bilinear). */
export function warpQuad(rgba, sw, sh, corners, W, H) {
  const [a, b, c, d, e, f, g, h] = homography(W, H, corners);
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const z = g * x + h * y + 1;
      const u = Math.min(sw - 1, Math.max(0, (a * x + b * y + c) / z));
      const v = Math.min(sh - 1, Math.max(0, (d * x + e * y + f) / z));
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = u - x0;
      const fy = v - y0;
      const o = (y * W + x) * 4;
      for (let k = 0; k < 4; k++) {
        const top = rgba[(y0 * sw + x0) * 4 + k] * (1 - fx) + rgba[(y0 * sw + x1) * 4 + k] * fx;
        const bot = rgba[(y1 * sw + x0) * 4 + k] * (1 - fx) + rgba[(y1 * sw + x1) * 4 + k] * fx;
        out[o + k] = Math.round(top * (1 - fy) + bot * fy);
      }
    }
  return out;
}

/**
 * The tilt of the text lines in degrees (positive = lines run down to the right), from the dark
 * pixels: the angle whose row sums are the most uneven. Rotate by minus this to straighten.
 */
export function skewAngle(g, w, h) {
  const { t } = otsu(g);
  const pts = [];
  const step = Math.max(1, Math.round(Math.sqrt((w * h) / 60_000)));
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (g[y * w + x] <= Math.min(t, 160)) pts.push(x, y);
  if (pts.length < 40) return 0;
  const score = (deg) => {
    const tan = Math.tan((deg * Math.PI) / 180);
    const bins = new Map();
    for (let i = 0; i < pts.length; i += 2) {
      const k = Math.round(pts[i + 1] - pts[i] * tan);
      bins.set(k, (bins.get(k) ?? 0) + 1);
    }
    let s = 0;
    for (const v of bins.values()) s += v * v;
    return s;
  };
  let best = 0;
  let top = -1;
  for (let deg = -15; deg <= 15; deg += 0.5) {
    const s = score(deg);
    if (s > top) (top = s), (best = deg);
  }
  const around = best;
  for (let deg = around - 0.5; deg <= around + 0.5; deg += 0.1) {
    const s = score(deg);
    if (s > top) (top = s), (best = deg);
  }
  return Math.round(best * 10) / 10;
}

/** A quarter turn clockwise. */
export function rotateRgba(rgba, w, h) {
  const out = new Uint8ClampedArray(rgba.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y;
      const ny = x;
      const s = (y * w + x) * 4;
      const o = (ny * h + nx) * 4;
      out[o] = rgba[s];
      out[o + 1] = rgba[s + 1];
      out[o + 2] = rgba[s + 2];
      out[o + 3] = rgba[s + 3];
    }
  return { data: out, w: h, h: w };
}

/** Evens out the light: the darkest 1% becomes black and the brightest 1% white (in place). */
export function levels(rgba) {
  const n = rgba.length / 4;
  const hist = new Uint32Array(256);
  for (let p = 0; p < rgba.length; p += 4) hist[(rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8]++;
  let lo = 0;
  let hi = 255;
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.01; lo++);
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.01; hi--);
  if (hi - lo < 30) return rgba;
  const k = 255 / (hi - lo);
  for (let p = 0; p < rgba.length; p += 4) for (let c = 0; c < 3; c++) rgba[p + c] = (rgba[p + c] - lo) * k;
  return rgba;
}
