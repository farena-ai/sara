// SETTINGS3 S4 (docs/design/SETTINGS3.md): Settings search finds single settings. Every label in the page
// markup finds its own control (one record per control); the page ranking (128b.3) is untouched.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const html = web('index.html');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const find: any = await import(pathToFileURL(join(ROOT, 'web', 'settings-find.js')).href);
const strip = (s: string) => s.replace(/<button[^>]*class="tip"[^>]*>[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/** The labelled controls of every Settings page: [{ id, page, label }]. */
function controls() {
  const out: { id: string; page: string; label: string }[] = [];
  for (const m of html.matchAll(/<section class="settings-page[^"]*" data-page="([\w-]+)"[^>]*>([\s\S]*?)<\/section>/g)) {
    const [, page, body] = m;
    // <label>Text <select|input id=…>  and  <label class="row"><input id=… type="checkbox"> Text</label>
    for (const l of body.matchAll(/<label(?: class="row")?>([^<]*(?:<button[^>]*class="tip"[^>]*>[^<]*<\/button>)?[^<]*)<(?:select|input)[^>]*\bid="([\w-]+)"/g)) {
      const label = strip(l[1]);
      if (label) out.push({ id: l[2], page, label });
    }
    for (const l of body.matchAll(/<label class="row"><input id="([\w-]+)" type="checkbox"(?: checked)?>([^<]+)</g)) if (strip(l[2])) out.push({ id: l[1], page, label: strip(l[2]) });
  }
  return out;
}

test('S4: every label in the Settings markup finds its own control', () => {
  const list = controls().filter((c) => /[\p{L}\d]/u.test(c.label)); // a bare "$" is no search word
  assert.ok(list.length >= 250, `${list.length} labelled controls`);
  const recs = list.map((c) => find.controlRecord({ ...c, path: c.page }));
  const miss = list.filter((c) => !find.rankControls(c.label, recs, 1000).some((r: { id: string }) => r.id === c.id)).map((c) => `${c.page}#${c.id} “${c.label}”`);
  assert.deepEqual(miss, []);
  // A label's own words rank it above controls that only mention them in a tip.
  const r = [find.controlRecord({ id: 'a', page: 'p', label: 'Weekly review', tip: '' }), find.controlRecord({ id: 'b', page: 'p', label: 'Other', tip: 'weekly review on Sunday' })];
  assert.deepEqual(find.rankControls('weekly review', r).map((x: { id: string }) => x.id), ['a', 'b']);
  assert.deepEqual(find.rankControls('', r), []);
});

test('S4: results show where a setting lives and its value now (never a secret), a jump opens folds and highlights the row', () => {
  const src = web('settings-find.js');
  assert.match(src, /if \(c\.type === 'password' \|\| SECRET\.test\(c\.id\) \|\| c\.type === 'file'\) return '';/);
  const nav = web('settings-nav.js');
  assert.match(nav, /export function jumpToSetting\(page, id\) \{\s*showSettingsTab\(page, \{ focus: false, searchResult: true \}\);/);
  assert.match(nav, /row\.classList\.add\('s3-hit'\);\s*setTimeout\(\(\) => row\.classList\.remove\('s3-hit'\), 2000\);/);
  // The single-setting results live in their own box, so the page results (and their tests) keep their shape.
  assert.match(html, /<div id="settings-hits" class="s3-hits" aria-live="polite" hidden><\/div>\s*<div id="settings-results"/);
  // Ctrl K inside Settings goes to the Settings search.
  assert.match(web('command-bar.js'), /if \(settings\?\.open && !d\.open\) \{[\s\S]*?getElementById\('settings-search'\)/);
});
