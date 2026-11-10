// A1 (docs/ops/A1_AVATAR_DESIGN.md): Settings → Appearance → Her picture, the two extra rows. "A 3D
// model (.vrm)": choose a file (checked, kept in this browser), see its name, author and licence,
// remove it. "Your picture": Fit the face, three dots (eyes, mouth) dragged onto the picture so it can
// blink and glance (sara.faceFit, this device; a new upload clears it).
import { fitRegions, VRM_MAX_BYTES } from './avatar-rig.js';

const $ = (s) => document.querySelector(s);
const FIT_KEY = 'sara.faceFit';

/** The saved dots for your picture, or null. */
export function readFaceFit() {
  try {
    const v = JSON.parse(localStorage.getItem(FIT_KEY) ?? 'null');
    return fitRegions(v) ? v : null;
  } catch {
    return null;
  }
}
export const clearFaceFit = () => localStorage.removeItem(FIT_KEY);

export function initAvatarSettings({ t, refresh, reloadVrm, ownPicture }) {
  const sel = $('#ap-herpic');
  const vrmRow = $('#ap-vrm-row');
  const fitRow = $('#ap-fit-row');
  const note = $('#ap-vrm-note');
  const reasons = {
    big: () => t('This model is too big (limit {n} MB).', { n: Math.round(VRM_MAX_BYTES / 1048576) }),
    type: () => t('This is not a VRM model (.vrm).'),
    broken: () => t('The file is broken or incomplete.'),
    external: () => t('It links to files outside the model; only self-contained .vrm files work.'),
  };
  const describe = (meta) => {
    if (!meta) return '';
    const who = [meta.name || t('A 3D model'), meta.author ? t('by {author}', { author: meta.author }) : ''].filter(Boolean).join(' ');
    return meta.licence ? `${who} · ${t('License: {license}', { license: meta.licence })}` : who;
  };
  async function showStored() {
    if (!note) return;
    const has = localStorage.getItem('sara.vrm') === '1';
    $('#ap-vrm-remove').hidden = !has;
    if (!has) return void (note.textContent = t('No model yet. VRM 0.x and 1.0 files up to {n} MB; it stays on this device.', { n: Math.round(VRM_MAX_BYTES / 1048576) }));
    const mod = await import('./avatar-vrm.js');
    const s = await mod.loadStoredVrm();
    note.textContent = s ? describe(s.meta) : '';
    note.dataset.raw = '';
  }
  function syncRows() {
    if (vrmRow) vrmRow.hidden = sel?.value !== 'vrm';
    if (fitRow) fitRow.hidden = sel?.value !== 'own' || !ownPicture();
    if (sel?.value === 'vrm') void showStored();
  }
  $('#ap-vrm-file')?.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    note.textContent = t('Checking the model…');
    try {
      const mod = await import('./avatar-vrm.js');
      const r = await mod.storeVrm(f);
      if (!r.ok) return void (note.textContent = (reasons[r.code] ?? reasons.type)());
      localStorage.setItem('sara.vrm', '1');
      await showStored();
      refresh();
      reloadVrm();
    } catch (err) {
      note.textContent = String(err?.message ?? err);
    }
  });
  $('#ap-vrm-remove')?.addEventListener('click', async () => {
    const mod = await import('./avatar-vrm.js');
    await mod.removeStoredVrm();
    localStorage.removeItem('sara.vrm');
    await showStored();
    refresh();
    reloadVrm();
  });
  document.addEventListener('sara-vrm', (e) => {
    if (note && e.detail && !e.detail.ok) note.textContent = t('The model could not be shown: {error}', { error: e.detail.error ?? '' });
  });
  $('#ap-fit-open')?.addEventListener('click', () => openFit({ t, src: ownPicture(), done: refresh }));
  return { syncRows };
}

/** The fit dialog: her picture with three dots to drag (keyboard: arrow keys move the focused dot). */
function openFit({ t, src, done }) {
  if (!src) return;
  let dlg = $('#ap-fit');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'ap-fit';
    dlg.className = 'ap-fit';
    dlg.setAttribute('aria-labelledby', 'ap-fit-h');
    const h = document.createElement('h3');
    h.id = 'ap-fit-h';
    h.textContent = t('Fit the face');
    const p = document.createElement('p');
    p.className = 'small muted';
    p.textContent = t('Drag the three dots onto her eyes and the middle of her mouth. Then she can blink and glance in your picture.');
    const stage = document.createElement('div');
    stage.className = 'ap-fit-stage';
    const img = document.createElement('img');
    img.alt = '';
    stage.append(img);
    for (const [k, label] of [['le', t('Left eye')], ['re', t('Right eye')], ['mouth', t('Mouth')]]) {
      const d = document.createElement('button');
      d.type = 'button';
      d.className = `ap-fit-dot ap-fit-${k}`;
      d.dataset.dot = k;
      d.setAttribute('aria-label', label);
      stage.append(d);
    }
    const msg = document.createElement('p');
    msg.className = 'small ap-fit-msg';
    msg.setAttribute('role', 'status');
    const acts = document.createElement('p');
    acts.className = 'ap-fit-acts';
    const mk = (id, text, cls = '') => {
      const b = document.createElement('button');
      b.type = 'button';
      b.id = id;
      if (cls) b.className = cls;
      b.textContent = text;
      return b;
    };
    acts.append(mk('ap-fit-save', t('Save')), ' ', mk('ap-fit-cancel', t('Cancel'), 'ghost'), ' ', mk('ap-fit-clear', t('Remove the fit'), 'linkish small'));
    dlg.append(h, p, stage, msg, acts);
    document.body.append(dlg);
  }
  const stage = dlg.querySelector('.ap-fit-stage');
  const img = stage.querySelector('img');
  // The stage takes the picture's own shape, so the dots are in the picture's coordinates.
  img.onload = () => (stage.style.aspectRatio = `${img.naturalWidth} / ${img.naturalHeight}`);
  img.src = src;
  const pts = readFaceFit() ?? { le: { x: 40, y: 40 }, re: { x: 60, y: 40 }, mouth: { x: 50, y: 62 } };
  const place = () => {
    for (const d of stage.querySelectorAll('.ap-fit-dot')) {
      d.style.left = `${pts[d.dataset.dot].x}%`;
      d.style.top = `${pts[d.dataset.dot].y}%`;
    }
    dlg.querySelector('.ap-fit-msg').textContent = fitRegions(pts) ? '' : t('The eyes go side by side, the mouth below them.');
    dlg.querySelector('#ap-fit-save').disabled = !fitRegions(pts);
  };
  place();
  let drag = null;
  stage.onpointerdown = (e) => {
    const d = e.target.closest('.ap-fit-dot');
    if (!d) return;
    drag = d.dataset.dot;
    d.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  stage.onpointermove = (e) => {
    if (!drag) return;
    const r = stage.getBoundingClientRect();
    pts[drag] = { x: Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)), y: Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100)) };
    place();
  };
  stage.onpointerup = () => (drag = null);
  stage.onkeydown = (e) => {
    const d = e.target.closest?.('.ap-fit-dot');
    const mv = { ArrowLeft: [-0.5, 0], ArrowRight: [0.5, 0], ArrowUp: [0, -0.5], ArrowDown: [0, 0.5] }[e.key];
    if (!d || !mv) return;
    e.preventDefault();
    const p = pts[d.dataset.dot];
    pts[d.dataset.dot] = { x: Math.max(0, Math.min(100, p.x + mv[0] * (e.shiftKey ? 4 : 1))), y: Math.max(0, Math.min(100, p.y + mv[1] * (e.shiftKey ? 4 : 1))) };
    place();
  };
  dlg.querySelector('#ap-fit-save').onclick = () => {
    if (!fitRegions(pts)) return;
    localStorage.setItem(FIT_KEY, JSON.stringify(pts));
    dlg.close();
    done();
  };
  dlg.querySelector('#ap-fit-cancel').onclick = () => dlg.close();
  dlg.querySelector('#ap-fit-clear').onclick = () => {
    clearFaceFit();
    dlg.close();
    done();
  };
  dlg.showModal();
}
