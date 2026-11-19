// W4.2 Memory lane (docs/MEMORY_LANE.md): a section of Your story. Pick "My year 2026" or a trip,
// she writes the story from your own photos, journal, moments and trips (a model on this computer
// only), with picked photos, a narrated version (the voice on this computer), a PDF and, only when
// you ask, a share link. Private by default.
import { serverText, t } from './naming.js';

let ctx = null;
let poll = null;
const $ = (s) => document.querySelector(s);
const MONTHS_FMT = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const range = (a, b) => (a === b ? MONTHS_FMT(a) : `${MONTHS_FMT(a)} – ${MONTHS_FMT(b)}`);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function button(label, fn, cls = 'ghost small') {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', fn);
  return b;
}
const titleOf = (s) => (s.kind === 'year' && /^My year \d{4}$/.test(s.title) ? t('My year {year}', { year: s.title.slice(8) }) : s.title);

function story(s) {
  const card = el('article', 'lane-card');
  card.dataset.id = String(s.id);
  const head = el('div', 'lane-head');
  head.append(el('strong', '', titleOf(s)), el('span', 'muted small', `${range(s.from, s.to)}, ${s.to.slice(0, 4)}`));
  head.append(el('span', 'lane-chip small', s.how === 'local' ? t('Written on this computer') : t('Put together from your facts')));
  card.append(head);
  if (s.photos.length) {
    const strip = el('div', 'lane-photos');
    s.photos.forEach((p, i) => {
      const fig = el('figure', 'lane-photo');
      const img = el('img');
      img.loading = 'lazy';
      img.src = `/api/story/lane/${s.id}/photo/${i + 1}`;
      img.alt = p.caption || p.place || t('Photo');
      const drop = button('✕', async () => {
        const btnEl = drop;
        btnEl.disabled = true;
        await ctx.api(`/story/lane/${s.id}`, { method: 'PATCH', body: { drop: i + 1 } }).catch(() => {});
        await loadLane();
      }, 'lane-drop');
      drop.title = t('Leave this photo out');
      drop.setAttribute('aria-label', t('Leave this photo out'));
      fig.append(img, drop);
      if (p.place || p.caption) fig.append(el('figcaption', 'small muted', [p.place, MONTHS_FMT(p.date)].filter(Boolean).join(' · ')));
      strip.append(fig);
    });
    card.append(strip);
  }
  const text = el('div', 'lane-text');
  const paras = s.text.split(/\n{2,}/).filter((x) => x.trim());
  paras.forEach((p, i) => {
    const para = el('p', i > 1 ? 'lane-more' : '', p);
    if (i > 1) para.hidden = true;
    text.append(para);
  });
  card.append(text);
  const acts = el('div', 'lane-acts');
  if (paras.length > 2) {
    const more = button(t('Read it all'), () => {
      const open = more.dataset.open !== '1';
      for (const x of text.querySelectorAll('.lane-more')) x.hidden = !open;
      more.dataset.open = open ? '1' : '';
      more.textContent = open ? t('Show less') : t('Read it all');
    });
    acts.append(more);
  }
  if (s.audio) {
    const au = el('audio', 'lane-audio');
    au.controls = true;
    au.preload = 'none';
    au.src = `/api/story/lane/${s.id}/audio`;
    acts.append(au);
  } else {
    const nar = button(t('Narrate it'), async () => {
      const b = nar;
      b.disabled = true;
      b.textContent = t('Recording…');
      try {
        await ctx.api(`/story/lane/${s.id}/audio`, { method: 'POST', body: {} });
        await loadLane();
      } catch (err) {
        b.disabled = false;
        b.textContent = t('Narrate it');
        $('#lane-status').textContent = serverText(err.message);
      }
    });
    acts.append(nar);
  }
  acts.append(
    button(t('Save as PDF'), () => {
      const a = el('a');
      a.href = `/api/story/lane/${s.id}/pdf`;
      a.download = '';
      document.body.append(a);
      a.click();
      a.remove();
    }),
  );
  const share = button(t('Share link…'), async () => {
    if (!confirm(t('Make a share link? Anyone with the link can read this story and see its photos for 7 days. You can stop it any time in Settings → Household → Shared links.'))) return;
    const b = share;
    b.disabled = true;
    try {
      const r = await ctx.api('/shares', { method: 'POST', body: { lane: s.id, expires: '7d' } });
      const out = el('input', 'lane-link');
      out.readOnly = true;
      out.value = r.link;
      out.setAttribute('aria-label', t('Share link'));
      acts.append(out);
      out.select();
      try {
        await navigator.clipboard?.writeText(r.link);
        $('#lane-status').textContent = t('Link copied.');
      } catch {}
    } catch (err) {
      $('#lane-status').textContent = serverText(err.message);
    } finally {
      b.disabled = false;
    }
  });
  acts.append(share);
  acts.append(
    button(t('Delete'), async () => {
      if (!confirm(t('Delete this story? Your photos and journal stay.'))) return;
      await ctx.api(`/story/lane/${s.id}`, { method: 'DELETE' }).catch(() => {});
      await loadLane();
    }),
  );
  card.append(acts);
  return card;
}

export async function loadLane() {
  if (!ctx || !$('#lane-list')) return;
  let d;
  try {
    d = await ctx.api('/story/lane');
  } catch {
    return;
  }
  const pick = $('#lane-pick');
  const was = pick.value;
  const opts = [...d.years.map((y) => [`year:${y}`, t('My year {year}', { year: String(y) })]), ...d.trips.map((tr) => [tr.key, `${tr.title} (${range(tr.from, tr.to)})`])];
  pick.replaceChildren(...opts.map(([v, label]) => Object.assign(el('option', '', label), { value: v })));
  if (opts.some(([v]) => v === was)) pick.value = was;
  $('#lane-write').disabled = d.running;
  $('#lane-status').textContent = d.running
    ? t('She is writing your story… you can close this window meanwhile.')
    : d.error
      ? `${t("Couldn't write the story:")} ${serverText(d.error)}`
      : d.model
        ? ''
        : t('No model on this computer yet: she puts the story together from your facts. Add a local model in Settings → Models to have her write it.');
  $('#lane-list').replaceChildren(...d.stories.map(story));
  if (d.running && !poll) poll = setInterval(() => (!$('#story')?.open ? (clearInterval(poll), (poll = null)) : void loadLane()), 3000);
  if (!d.running && poll) {
    clearInterval(poll);
    poll = null;
  }
}

export function initLane(c) {
  ctx = c;
  $('#lane-write')?.addEventListener('click', async () => {
    const v = $('#lane-pick').value;
    if (!v) return;
    const body = v.startsWith('year:') ? { kind: 'year', year: Number(v.slice(5)) } : { kind: 'trip', key: v };
    $('#lane-write').disabled = true;
    try {
      await ctx.api('/story/lane', { method: 'POST', body });
    } catch (err) {
      $('#lane-status').textContent = serverText(err.message);
    }
    await loadLane();
  });
}
