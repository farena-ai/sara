// R2: the guided setup's words (web/get-started-words.js), Try cards picked by a pack, the page
// wiring (index.html slots, no inline styles, theme tokens only) and the tips' length in every language.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { PACKS, PACK_DEFS, SAMPLE_KINDS, STEPS } from '../src/get-started.ts';
import { guideWords, packWords, PACK_IDS, routineName, SAMPLE_IDS, sampleTour, sampleWords, STEP_IDS, stepWords } from '../web/get-started-words.js';
import { tryCards } from '../web/try-cards.js';
import { ROOT } from './helpers.ts';

const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'];
const dict = (l: string) => JSON.parse(readFileSync(join(ROOT, 'web', 'i18n', `${l}.json`), 'utf8')) as Record<string, string>;
const tr = (d: Record<string, string>) => (s: string, v: Record<string, unknown> = {}) => (d[s] ?? s).replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));

test('R2 words: the app and the server name the same steps, packs and examples', () => {
  assert.deepEqual(STEP_IDS, [...STEPS]);
  assert.deepEqual(PACK_IDS, [...PACKS]);
  assert.deepEqual(SAMPLE_IDS, [...SAMPLE_KINDS]);
  const t = (s: string) => s;
  for (const id of STEP_IDS) {
    const w = stepWords(id, t);
    assert.ok(w.title && w.text && w.go && w.page, id);
  }
  for (const id of PACK_IDS) assert.ok(packWords(id, t).title);
  // Every routine a pack adds has words (so its name is translated in the pack card).
  for (const id of PACKS) for (const r of PACK_DEFS[id].routines) assert.notEqual(routineName(r.name, (s: string) => `«${s}»`), r.name, r.name);
  for (const kind of SAMPLE_IDS) assert.ok(sampleWords({ kind, day: '2026-11-18' }, t)?.title, kind);
  assert.equal(sampleTour(t).length, 6);
});

test('R2 words: every language translates them; pt-BR is not English; tips fit 260 characters', () => {
  const tips = [guideWords((s: string) => s).examplesTip, 'A pack picks Try cards, the order of Today and a few routines for what you use her for. Routines stay off until you press Allow. Pick None to undo it.'];
  for (const l of LANGS) {
    const d = dict(l);
    const t = tr(d);
    for (const id of STEP_IDS) assert.ok(d[stepWords(id, (s: string) => s).text], `${l}: ${id}`);
    for (const tip of tips) {
      assert.ok(d[tip], `${l} has the tip`);
      assert.ok(d[tip].length <= 260, `${l} tip is ${d[tip].length} characters`);
    }
    assert.match(guideWords(t).count(2, 5), /2.*5/);
  }
  const pt = dict('pt-BR');
  assert.notEqual(pt['Show me with examples'], 'Show me with examples');
  assert.notEqual(pt['Connect your mail'], 'Connect your mail');
  for (const tip of tips) assert.ok(tip.length <= 260);
});

test('R2 packs pick their Try cards (in order), even for a coding setup', () => {
  const tools = ['fill_document', 'watch_add', 'find_product', 'decide', 'invoice_make', 'spending_summary'];
  assert.deepEqual(tryCards({ tools, pick: PACK_DEFS.business.tryCards }).map((c) => c.id), PACK_DEFS.business.tryCards);
  assert.deepEqual(tryCards({ tools, path: 'coding' }), []);
  assert.deepEqual(tryCards({ tools, path: 'coding', pick: ['invoice'] }).map((c) => c.id), ['invoice']);
  assert.equal(tryCards({ tools }).length, 6, 'no pack: every card');
  assert.deepEqual(tryCards({ tools: ['decide'], pick: PACK_DEFS.student.tryCards }).map((c) => c.id), ['decide'], 'only cards whose tools exist');
});

test('R2 page wiring: slots on Today and in About you, its stylesheet, no inline styles, theme tokens only', () => {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  for (const id of ['td-gs', 'td-examples', 'gs-card']) assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) ?? []).length, 1, id);
  assert.equal((html.match(/href="\/get-started\.css"/g) ?? []).length, 1);
  const js = readFileSync(join(ROOT, 'web', 'get-started.js'), 'utf8');
  assert.doesNotMatch(js, /\.style\.|style=/, 'no inline styles');
  for (const f of ['get-started.css', 'download.css']) {
    const css = readFileSync(join(ROOT, 'web', f), 'utf8');
    assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, `${f}: theme variables only`);
  }
  const app = readFileSync(join(ROOT, 'web', 'app.js'), 'utf8');
  assert.match(app, /initGetStarted\(/);
  assert.match(app, /pick: state\.packTry/);
  // The examples' card names say they are samples, and Remove is on the section.
  assert.match(js, /sw\.badge/);
  assert.match(js, /td-examples-remove/);
});
