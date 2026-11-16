// S11 (docs/WRITING_STYLE.md): Settings → You → About you → Writing style. The default (Natural / As
// written) and Match my voice: 1-5 samples of the person's own writing (pasted, or documents from
// their Library) become a short style card in their own space. Saves on change (not the page saver).
import { t } from './naming.js';

const $ = (s) => document.querySelector(s);
let wired = false;

async function call(path, method = 'GET', body) {
  const r = await fetch(`/api/writing${path}`, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? String(r.status));
  return d;
}

const FORMAL = () => ({ casual: t('casual'), neutral: t('neutral'), formal: t('formal') });
const OFTEN = () => ({ often: t('often'), sometimes: t('sometimes'), rarely: t('rarely') });
function showCard(card) {
  const p = $('#wr-card');
  if (!p) return;
  $('#wr-forget').hidden = !card;
  if (!card) {
    p.textContent = t('No style card yet. Add samples of your own writing to make one.');
    return;
  }
  const bits = [t('Sentences around {n} words', { n: Math.round(card.avgSentence) }), t('{tone} tone', { tone: FORMAL()[card.formality] ?? card.formality }), t('contractions {how}', { how: OFTEN()[card.contractions] ?? card.contractions })];
  if (card.favorites?.length) bits.push(t('favorite words: {words}', { words: card.favorites.join(', ') }));
  p.textContent = `${t('Your style card ({n} samples):', { n: card.samples })} ${bits.join(' · ')}`;
}

export async function loadWritingStyle() {
  if (!$('#wr-style')) return;
  wire();
  try {
    const w = await call('');
    $('#wr-style').value = w.style;
    showCard(w.card);
  } catch {
    $('#wr-card').textContent = '';
  }
  const lib = $('#wr-lib');
  try {
    const r = await fetch('/api/library', { credentials: 'same-origin' });
    const docs = r.ok ? ((await r.json()).docs ?? []) : [];
    lib.replaceChildren(...docs.filter((d) => !/^Research - /.test(d.name ?? '')).slice(0, 200).map((d) => {
      const o = document.createElement('option');
      o.value = String(d.id);
      o.textContent = d.title ?? d.name ?? `#${d.id}`;
      return o;
    }));
  } catch {
    lib.replaceChildren();
  }
  lib.closest('label').hidden = !lib.options.length;
}

function wire() {
  if (wired) return;
  wired = true;
  $('#wr-style').addEventListener('change', async (e) => {
    try {
      await call('', 'PUT', { style: e.target.value });
      $('#wr-card').dataset.saved = '1';
    } catch (err) {
      $('#wr-card').textContent = err.message;
    }
  });
  $('#wr-make').addEventListener('click', async () => {
    const samples = $('#wr-samples').value.split(/^\s*---+\s*$/m).map((s) => s.trim()).filter(Boolean);
    const libraryIds = [...$('#wr-lib').selectedOptions].map((o) => Number(o.value));
    if (samples.length + libraryIds.length > 5) return void ($('#wr-card').textContent = t('Pick up to 5 samples.'));
    $('#wr-make').disabled = true;
    try {
      const r = await call('/voice', 'POST', { samples, libraryIds });
      $('#wr-samples').value = '';
      showCard(r.card);
    } catch (err) {
      $('#wr-card').textContent = err.message;
    } finally {
      $('#wr-make').disabled = false;
    }
  });
  $('#wr-forget').addEventListener('click', async () => {
    await call('/voice', 'DELETE').catch(() => {});
    showCard(null);
  });
}
