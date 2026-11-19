// W5.3 (docs/design/W5BACKUP.md): Settings → Privacy & system → Backups → recovery sheet, carry
// copies (drives, other folders, linked Saras), backups kept for friends and Restore on a new computer.
// Loaded from loadBackups in app.js; the server is src/routes/carry.ts.
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
/** Used until app.js lends its own api() (the same shape: /api prefix, JSON, translated errors). */
async function ownApi(path, opts = {}) {
  const res = await fetch(`/api${path}`, { method: opts.method ?? 'GET', headers: opts.body !== undefined ? { 'content-type': 'application/json' } : {}, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ? t(j.error, j.params) : `HTTP ${res.status}`);
  return j;
}
let api = ownApi;
let data;
let restoreId = null;

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function btn(text, cls, on) {
  const b = el('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await on(b);
    } catch (err) {
      say(b, err.message);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}
function say(near, text, bad = true) {
  const box = near?.closest('.cy-step, .cy-box') ?? near?.parentElement;
  let s = box?.querySelector(':scope > .cy-say');
  if (!s && box) {
    s = el('p', 'cy-say small');
    s.setAttribute('role', 'status');
    box.append(s);
  }
  if (s) {
    s.textContent = text;
    s.classList.toggle('cy-bad', bad);
  }
}
const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');
const size = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);

// ---- recovery sheet -----------------------------------------------------------------------------
async function paintSheet() {
  const box = $('#cy-sheet');
  box.replaceChildren();
  const s = data.sheet;
  if (!s) {
    box.append(el('p', 'small', t("You don't have a recovery sheet yet. Carried copies are sealed with it, so print it once and keep it somewhere safe.")));
    box.append(btn(t('Make my recovery sheet'), 'primary', async () => {
      await api('/backups/carry/sheet', { method: 'POST', body: {} });
      await loadCarry();
    }));
    return;
  }
  if (s.confirmedAt) {
    box.append(el('p', 'small cy-ok', t('✓ Recovery sheet made {date}. Sara does not show the words again.', { date: day(s.madeAt) })));
    box.append(btn(t('Make a new sheet'), 'ghost small', async () => {
      if (!confirm(t('A new sheet means a new key. Copies made before still open only with the old sheet. Make a new one?'))) return;
      await api('/backups/carry/sheet', { method: 'POST', body: { again: true } });
      await loadCarry();
    }));
    return;
  }
  const sh = await api('/backups/carry/sheet');
  box.append(el('p', 'small', t('Print this page or write the 18 words down, in order. Anyone with them and a backup can open it, so keep them private.')));
  const wrap = el('div', 'cy-sheetview');
  const ol = el('ol', 'cy-words');
  for (const w of sh.words) ol.append(el('li', '', w));
  const img = el('img', 'cy-qr');
  img.src = sh.qr;
  img.alt = t('QR code with the 18 words');
  wrap.append(ol, img);
  box.append(wrap);
  const pdf = el('a', 'button ghost', t('Download the sheet to print (PDF)'));
  pdf.href = '/api/backups/carry/sheet.pdf';
  pdf.setAttribute('download', 'sara-recovery-sheet.pdf');
  const row = el('p', 'cy-row');
  row.append(pdf);
  box.append(row);
  const lab = el('label', 'cy-check small');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.id = 'cy-printed';
  lab.append(cb, document.createTextNode(` ${t('I printed it (or wrote the 18 words down)')}`));
  const done = btn(t('Done, hide the words'), 'primary', async () => {
    await api('/backups/carry/sheet/confirm', { method: 'POST', body: {} });
    await loadCarry();
  });
  done.disabled = true;
  cb.addEventListener('change', () => (done.disabled = !cb.checked));
  box.append(lab, done);
}

// ---- carry copies -------------------------------------------------------------------------------
function placeLabel(tg) {
  if (tg.kind === 'peer') return t("{name}'s Sara", { name: tg.name ?? t('a linked Sara') });
  const d = (data.drives ?? []).find((x) => x.path === tg.path);
  return d ? t('Drive {name}', { name: d.name }) : tg.path;
}
function statusOf(tg) {
  if (tg.waiting) return [t('Waiting for the drive (not plugged in since {date}). Sara copies as soon as it is back.', { date: day(tg.waitingSince) }), 'cy-wait'];
  if (!tg.last) return [t('No copy yet.'), ''];
  if (tg.last.ok) return [t('✓ Last copy {date}', { date: day(tg.last.at) }), 'cy-ok'];
  return [t('Last try failed: {error}', { error: tg.last.error ?? '' }), 'cy-bad'];
}
function paintTargets() {
  const box = $('#cy-targets');
  box.replaceChildren();
  const ready = Boolean(data.sheet?.confirmedAt);
  $('#cy-add').hidden = !ready;
  if (!ready) {
    box.append(el('p', 'muted small', t('Make and print your recovery sheet first: carried copies are sealed with it.')));
    return;
  }
  const ul = el('ul', 'backups cy-list');
  for (const tg of data.targets ?? []) {
    const li = el('li', 'cy-item');
    const head = el('strong', '', placeLabel(tg));
    const how = el('span', 'muted small', ` · ${tg.every === 'week' ? t('every week') : t('every day')} · ${t('keeps {n}', { n: tg.keep })}`);
    const [text, cls] = statusOf(tg);
    const st = el('span', `small cy-state ${cls}`, text);
    const acts = el('span', 'cy-acts');
    acts.append(
      btn(t('Copy now'), 'ghost small', async (b) => {
        say(b, t('Making a fresh backup and sealing it…'), false);
        await api(`/backups/carry/targets/${tg.id}/copy`, { method: 'POST', body: {} });
        await loadCarry();
      }),
      btn(t('Remove'), 'ghost small', async () => {
        await api(`/backups/carry/targets/${tg.id}`, { method: 'DELETE' });
        await loadCarry();
      }),
    );
    li.append(head, how, el('br'), st, acts);
    ul.append(li);
  }
  if (!(data.targets ?? []).length) box.append(el('p', 'muted small', t('Nowhere yet. Plug in a USB drive and add it below.')));
  else box.append(ul);
  // The "Copy to" choices: drives first (not this computer's own disk), then linked Saras, then any folder.
  const sel = $('#cy-where');
  const keep = sel.value;
  sel.replaceChildren();
  const drives = [...(data.drives ?? [])].sort((a, b) => Number(a.system) - Number(b.system));
  for (const d of drives) {
    const o = el('option', '', d.system ? t("{name} (this computer's own disk: not safe if it breaks)", { name: d.name }) : t('Drive {name} ({free} free)', { name: d.name, free: size(d.free ?? 0) }));
    o.value = `folder:${d.path}`;
    sel.append(o);
  }
  for (const l of data.links ?? []) {
    const o = el('option', '', t("{name}'s Sara (sealed, they can't open it)", { name: l.name }));
    o.value = `peer:${l.id}`;
    sel.append(o);
  }
  const other = el('option', '', t('Another folder…'));
  other.value = 'other';
  sel.append(other);
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  showPath();
}
const showPath = () => {
  const other = $('#cy-where').value === 'other';
  $('#cy-path').hidden = !other;
  $('#cy-path').closest('label').hidden = !other;
};
async function addTarget() {
  const v = $('#cy-where').value;
  const body = { every: $('#cy-every').value, keep: Number($('#cy-keep').value) || 4 };
  if (v === 'other') Object.assign(body, { kind: 'folder', path: $('#cy-path').value.trim() });
  else if (v.startsWith('peer:')) Object.assign(body, { kind: 'peer', link: v.slice(5) });
  else Object.assign(body, { kind: 'folder', path: v.slice(7) });
  await api('/backups/carry/targets', { method: 'POST', body });
  await loadCarry();
}

// ---- holding for friends ------------------------------------------------------------------------
function paintHold() {
  const box = $('#cy-hold');
  box.replaceChildren();
  if (!(data.hold ?? []).length) {
    box.append(el('p', 'muted small', t("Link a friend's Sara under Messages first. Then you can keep their sealed backups here (and they yours).")));
    return;
  }
  for (const h of data.hold) {
    const item = el('div', 'cy-friend');
    const lab = el('label', 'cy-check small');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = h.on;
    cb.setAttribute('aria-label', t('Keep sealed backups for {name}', { name: h.name }));
    cb.addEventListener('change', async () => {
      try {
        await api(`/backups/carry/hold/${encodeURIComponent(h.id)}`, { method: 'PUT', body: { on: cb.checked } });
        await loadCarry();
      } catch (err) {
        say(cb, err.message);
      }
    });
    lab.append(cb, document.createTextNode(` ${t('Keep sealed backups for {name} (up to {n} GB)', { name: h.name, n: Math.round(h.maxMb / 1000) })}`));
    item.append(lab);
    if (h.copies.length) {
      const ul = el('ul', 'backups');
      for (const c of h.copies) {
        const li = el('li', '');
        const a = el('a', '', c.name);
        a.href = `/api/backups/carry/hold/${encodeURIComponent(h.id)}/${encodeURIComponent(c.name)}`;
        a.setAttribute('download', c.name);
        li.append(a, el('span', 'muted small', ` · ${size(c.size)} · ${day(c.at)} `));
        li.append(btn(t('Remove'), 'ghost small', async () => {
          await api(`/backups/carry/hold/${encodeURIComponent(h.id)}/${encodeURIComponent(c.name)}`, { method: 'DELETE' });
          await loadCarry();
        }));
        ul.append(li);
      }
      item.append(ul);
    }
    box.append(item);
  }
  box.append(el('p', 'muted small', t('You only hold locked files: without their sheet nobody here can open them.')));
}

// ---- restore on a new computer ------------------------------------------------------------------
function paintRestore() {
  const box = $('#cy-restore');
  box.replaceChildren();
  if (data.staged) {
    box.append(el('p', 'small cy-ok', t('Ready: the backup from {date} will replace what is here when Sara restarts. What is here now is kept in a before-restore folder.', { date: day(data.staged.madeAt) })));
    box.append(el('p', 'muted small', t('Restart Sara now: quit and open the app again, or restart the server.')));
    box.append(btn(t('Cancel the restore'), 'ghost small', async () => {
      await api('/backups/carry/restore/staged', { method: 'DELETE' });
      await loadCarry();
    }));
    return;
  }
  const steps = el('ol', 'cy-steps');
  const s1 = el('li', 'cy-step');
  s1.append(el('strong', '', t('Find the backup')), el('br'));
  s1.append(el('span', 'muted small', t('Plug in the drive with your backup, or choose the .sara file a friend gave back to you.')), el('br'));
  const found = el('div', 'cy-found');
  s1.append(
    btn(t('Look on the drives'), 'ghost small', async (b) => {
      const r = await api('/backups/carry/restore/found');
      found.replaceChildren();
      if (!r.files.length) say(b, t('No .sara files on the drives. Is the drive plugged in?'));
      for (const f of r.files.slice(0, 8)) {
        found.append(btn(`${f.drive} · ${f.name} · ${size(f.size)}`, 'ghost small cy-pick', async () => {
          const st = await api('/backups/carry/restore', { method: 'POST', body: { path: f.path } });
          picked(st);
        }));
      }
    }),
  );
  const file = el('input');
  file.type = 'file';
  file.accept = '.sara';
  file.id = 'cy-file';
  file.setAttribute('aria-label', t('Choose a .sara file'));
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    say(file, t('Uploading {name}…', { name: f.name }), false);
    try {
      const res = await fetch(`/api/backups/carry/restore/upload?name=${encodeURIComponent(f.name)}`, { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ? t(j.error, j.params) : `HTTP ${res.status}`);
      picked(j);
    } catch (err) {
      say(file, err.message);
    }
  });
  s1.append(' ', file, found);
  const s2 = el('li', 'cy-step');
  s2.id = 'cy-step2';
  s2.append(el('strong', '', t('Type the 18 words from your sheet')), el('br'));
  const pickedLine = el('span', 'muted small cy-picked', t('Pick a backup first.'));
  const words = el('textarea', 'cy-wordsin');
  words.id = 'cy-words';
  words.rows = 3;
  words.setAttribute('autocomplete', 'off');
  words.setAttribute('spellcheck', 'false');
  words.setAttribute('aria-label', t('The 18 words from your recovery sheet'));
  words.placeholder = t('Or paste what your phone read from the QR code');
  const check = btn(t('Check the backup'), 'primary', async (b) => {
    say(b, t('Opening and checking it in a throwaway folder… (a minute or two)'), false);
    const r = await api(`/backups/carry/restore/${restoreId}/check`, { method: 'POST', body: { words: words.value } });
    const rec = r.record;
    if (!rec.ok) return say(b, t('The check failed: {error}', { error: rec.error ?? '' }));
    say(b, t('✓ It opens with your sheet and every check passed: {chats} chats, {messages} messages. Made {date}.', { chats: rec.counts?.conversations ?? 0, messages: rec.counts?.messages ?? 0, date: day(rec.madeAt) }), false);
    go.hidden = false;
  });
  check.disabled = true;
  s2.append(pickedLine, words, check);
  const s3 = el('li', 'cy-step');
  s3.append(el('strong', '', t('Restore it')), el('br'));
  s3.append(el('span', 'muted small', t('Nothing changes until Sara restarts; what is here now is kept.')), el('br'));
  const go = btn(t('Restore this backup'), 'primary', async () => {
    await api(`/backups/carry/restore/${restoreId}/stage`, { method: 'POST', body: {} });
    await loadCarry();
  });
  go.hidden = true;
  s3.append(go);
  steps.append(s1, s2, s3);
  box.append(steps);
  function picked(st) {
    restoreId = st.id;
    pickedLine.textContent = t('Backup: {name} ({size})', { name: st.name, size: size(st.size) });
    check.disabled = false;
    go.hidden = true;
    words.focus();
  }
}

export async function loadCarry(apiFn) {
  if (apiFn) api = apiFn;
  if (!$('#cy-sheet')) return;
  initCarry(api);
  try {
    data = await api('/backups/carry');
  } catch {
    return;
  }
  await paintSheet().catch((err) => say($('#cy-sheet'), err.message));
  paintTargets();
  paintHold();
  paintRestore();
}

let wired = false;
export function initCarry(apiFn) {
  api = apiFn;
  if (wired || !$('#cy-add-go')) return;
  wired = true;
  $('#cy-where').addEventListener('change', showPath);
  $('#cy-add-go').addEventListener('click', async () => {
    const b = $('#cy-add-go');
    b.disabled = true;
    try {
      await addTarget();
      $('#cy-add-status').textContent = '';
    } catch (err) {
      $('#cy-add-status').textContent = err.message;
    } finally {
      b.disabled = false;
    }
  });
}
