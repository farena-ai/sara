// V5.5 Accessibility switch (docs/design/V5_ACCESS.md): one Accessibility group on Settings → You →
// Appearance (a master switch, easier reading, line focus, reduce motion, large layout), applied before
// the first paint so it survives a reload, carried by "Use on all my devices", and the R9 checker over
// the views added since R9.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { checkHtml } from '../web/a11y-check.js';
import * as mode from '../web/a11y-mode.js';
import { cleanAppearance } from '../src/appearance.ts';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const store = (o: Record<string, string> = {}) => ({ get: (k: string) => o[k] ?? null, o });

/** web/theme-boot.js in a sandbox: the attributes and classes it puts on <html>. */
function boot(saved: Record<string, string>) {
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const root = { setAttribute: (k: string, v: string) => (attrs[k] = v), classList: { add: (c: string) => classes.add(c), contains: (c: string) => classes.has(c) }, style: { setProperty: () => {} } };
  const mm = () => ({ matches: false, addEventListener: () => {} });
  runInNewContext(web('theme-boot.js'), { window: { matchMedia: mm }, document: { documentElement: root }, localStorage: { getItem: (k: string) => saved[k] ?? null }, matchMedia: mm, location: { search: '' } });
  return { attrs, classes };
}

/** What web/a11y-mode.js would set, in the same shape. */
function planned(saved: Record<string, string>) {
  const attrs: Record<string, string> = {};
  const classes = new Set<string>();
  const root = { dataset: {} as Record<string, string>, classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, removeAttribute: () => {} };
  mode.applyA11y(root, mode.a11yState(store(saved).get));
  for (const [k, v] of Object.entries(root.dataset)) attrs[`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`] = v;
  return { attrs, classes };
}

test('V5.5.1 the state reads the stored keys; nothing stored = everything off', () => {
  assert.deepEqual(mode.a11yState(store().get), { on: false, read: 'normal', lineFocus: false, reduceMotion: false, large: false });
  assert.deepEqual(mode.a11yState(store({ 'sara.a11y': 'on', 'sara.read': 'easy', 'sara.lineFocus': 'on', 'sara.reduceMotion': 'on', 'sara.large': 'on' }).get), { on: true, read: 'easy', lineFocus: true, reduceMotion: true, large: true });
  // Unknown values are off, never half on.
  assert.deepEqual(mode.a11yState(store({ 'sara.read': 'weird', 'sara.large': 'yes' }).get), { on: false, read: 'normal', lineFocus: false, reduceMotion: false, large: false });
});

test('V5.5.2 the switch turns the parts on together and puts them back when turned off', () => {
  const s = store({ 'sara.textSize': '15', 'sara.read': 'normal' });
  const on = mode.switchAll(true, s.get);
  assert.deepEqual(on.set, { 'sara.a11y': 'on', 'sara.read': 'easy', 'sara.reduceMotion': 'on', 'sara.large': 'on', 'sara.textSize': '17', 'sara.a11yPrev': JSON.stringify({ 'sara.read': 'normal', 'sara.reduceMotion': null, 'sara.large': null, 'sara.textSize': '15' }) });
  assert.deepEqual(on.remove, []);
  // Line focus is a separate choice: the switch leaves it alone.
  assert.equal('sara.lineFocus' in on.set, false);
  const after = store({ ...s.o, ...on.set });
  const off = mode.switchAll(false, after.get);
  assert.deepEqual(off.set, { 'sara.a11y': 'off', 'sara.read': 'normal', 'sara.textSize': '15' });
  assert.deepEqual(off.remove.sort(), ['sara.a11yPrev', 'sara.large', 'sara.reduceMotion']);
  // Already larger text stays larger.
  assert.equal(mode.switchAll(true, store({ 'sara.textSize': '19' }).get).set['sara.textSize'], '19');
  // Text size never picked before: back to the default.
  const fresh = store({});
  const on2 = mode.switchAll(true, fresh.get);
  assert.ok(mode.switchAll(false, store(on2.set).get).remove.includes('sara.textSize'));
  // Off with nothing remembered: the parts go off.
  const bare = mode.switchAll(false, store({ 'sara.a11y': 'on', 'sara.large': 'on' }).get);
  assert.deepEqual(bare.remove.sort(), ['sara.a11yPrev', 'sara.large', 'sara.read', 'sara.reduceMotion']);
});

test('V5.5.3 survives a reload: theme-boot applies the same attributes as the module, before the first paint', () => {
  const cases: Record<string, string>[] = [
    {},
    { 'sara.read': 'easy' },
    { 'sara.lineFocus': 'on', 'sara.large': 'on' },
    { 'sara.a11y': 'on', 'sara.read': 'easy', 'sara.reduceMotion': 'on', 'sara.large': 'on', 'sara.lineFocus': 'on' },
  ];
  for (const c of cases) {
    const b = boot(c), p = planned(c);
    for (const k of ['data-read', 'data-large', 'data-line-focus']) assert.equal(b.attrs[k], p.attrs[k], `${k} ${JSON.stringify(c)}`);
    assert.equal(b.classes.has('reduce-motion'), p.classes.has('reduce-motion'), JSON.stringify(c));
  }
  // Reduce motion also stills the background field.
  assert.equal(boot({ 'sara.reduceMotion': 'on', 'sara.motion': 'on' }).attrs['data-motion'], 'off');
  assert.equal(boot({}).attrs['data-motion'], 'on');
});

test('V5.5.4 Appearance has one Accessibility group with a tip for every control, and no checker findings', () => {
  const html = web('index.html');
  const page = html.slice(html.indexOf('data-page="you-appearance"'), html.indexOf('data-page="you-briefing"'));
  const g = page.slice(page.indexOf('aria-labelledby="ap-g-access"'));
  const group = g.slice(0, g.indexOf('<div class="ap-group" role="group" aria-labelledby="ap-g-theme"'));
  assert.ok(group.length > 200, 'the group sits right before Theme');
  for (const id of ['ap-a11y', 'ap-read', 'ap-linefocus', 'ap-reduce', 'ap-large']) assert.match(group, new RegExp(`id="${id}"`), id);
  assert.match(group, /<h3 id="ap-g-access">Accessibility<\/h3>/);
  assert.deepEqual(checkHtml(`<section>${group}</section>`), []);
  const tips = JSON.parse(web('tips.json'));
  for (const id of ['ap-a11y', 'ap-read', 'ap-linefocus', 'ap-reduce', 'ap-large']) {
    assert.ok(tips.tips?.[id] ?? tips[id], `tip for ${id}`);
    const [text] = tips.tips?.[id] ?? tips[id];
    assert.ok(text.length <= 180, `${id} tip short enough to translate`);
  }
});

test('V5.5.5 easy to find: quick settings, Settings search and the command list', async () => {
  const ov: any = await import(pathToFileURL(join(ROOT, 'web', 'settings-overview.js')).href);
  assert.ok(ov.QUICK.some((q: { id: string; page: string }) => q.id === 'ap-a11y' && q.page === 'you-appearance'));
  const search = web('settings-search.js');
  const line = search.split('\n').find((l) => l.includes("'you-appearance':"))!;
  for (const w of ['accessibility', 'dyslexia', 'reduce motion', 'large layout', 'line focus', 'screen reader']) assert.ok(line.includes(`'${w}'`), w);
  assert.match(web('app.js'), /add\('accessibility', /);
});

test('V5.5.6 CSS: one block, theme variables only, every part styled', () => {
  const css = web('style.css');
  const start = css.indexOf('/* V5.5 Accessibility');
  const block = css.slice(start, css.indexOf('/* end V5.5 */'));
  assert.ok(start > 0 && block.length > 400);
  assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b(?![\w-])(?=[^{]*;)|rgba?\(|hsla?\(/i, 'no hard-coded colors');
  for (const sel of ['[data-read="easy"]', '[data-large="on"]', '.reduce-motion', '#a11y-line']) assert.ok(block.includes(sel), sel);
  // Reduce motion means every animation and transition, not only the background.
  assert.match(block, /animation-duration: 0\.01ms !important/);
  assert.match(block, /transition-duration: 0\.01ms !important/);
});

test('V5.5.7 "Use on all my devices" carries the Accessibility choices', () => {
  const a = cleanAppearance({ palette: 'graphite', access: { on: true, read: 'easy', lineFocus: true, reduceMotion: true, large: true, junk: 1 } })!;
  assert.deepEqual(a.access, { on: true, read: 'easy', lineFocus: true, reduceMotion: true, large: true });
  assert.equal(cleanAppearance({ palette: 'graphite', access: 'yes' })!.access, undefined);
  assert.deepEqual(cleanAppearance({ access: { read: 'comic' } })!.access, { on: false, read: 'normal', lineFocus: false, reduceMotion: false, large: false });
  assert.deepEqual(mode.accessKeys({ on: true, read: 'easy', lineFocus: false, reduceMotion: true, large: false }), { 'sara.a11y': 'on', 'sara.read': 'easy', 'sara.lineFocus': 'off', 'sara.reduceMotion': 'on', 'sara.large': 'off' });
});

test('V5.5.9 every dialog gets a name a screen reader can announce', () => {
  assert.deepEqual(checkHtml('<dialog id="x"><p>Hi</p></dialog>').map((f: { rule: string }) => f.rule), ['dialog-name']);
  assert.deepEqual(checkHtml('<dialog id="x"><h2>Hi</h2></dialog><dialog aria-label="Y"></dialog><h2 id="t">T</h2><dialog aria-labelledby="t"></dialog>'), []);
  // The page names each heading-only dialog after its heading.
  const el = (tag: string, attrs: Record<string, string> = {}, kids: any[] = []) => ({
    tag, attrs, kids,
    get id() { return attrs.id ?? ''; }, set id(v: string) { attrs.id = v; },
    hasAttribute: (k: string) => k in attrs, setAttribute: (k: string, v: string) => (attrs[k] = v),
    querySelector: (s: string) => kids.find((k) => s.split(', ').includes(k.tag)) ?? null,
  });
  const a = el('dialog', { id: 'planner' }, [el('h2')]);
  const b = el('dialog', { id: 'sara-dialog' }, [el('h2', { id: 'sd-title' })]);
  const c = el('dialog', { id: 'named', 'aria-label': 'Named' }, [el('h2')]);
  const d = el('dialog', { id: 'bare' }, [el('p')]);
  assert.equal(mode.nameDialogs({ querySelectorAll: () => [a, b, c, d] }), 2);
  assert.equal(a.attrs['aria-labelledby'], 'planner-name');
  assert.equal(a.kids[0].attrs.id, 'planner-name');
  assert.equal(b.attrs['aria-labelledby'], 'sd-title');
  assert.equal(c.attrs['aria-labelledby'], undefined);
  assert.equal(d.attrs['aria-labelledby'], undefined);
  // index.html: none without a name or a heading (R9.A4 runs the same rule over the whole page).
  assert.deepEqual(checkHtml(web('index.html')).filter((f: { rule: string }) => f.rule === 'dialog-name'), []);
});

test('V5.5.8 screen-reader pass: the views added since R9 have no checker findings', () => {
  const html = web('index.html');
  const block = (open: string) => {
    const i = html.indexOf(open);
    assert.ok(i > 0, open);
    const tag = open.startsWith('<dialog') ? 'dialog' : 'section';
    // The matching close tag (nesting of the same tag counted).
    const re = new RegExp(`<${tag}[\\s>]|</${tag}>`, 'g');
    re.lastIndex = i + 1;
    let depth = 1, m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      depth += m[0].startsWith('</') ? -1 : 1;
      if (!depth) return html.slice(i, m.index + m[0].length);
    }
    throw new Error(`unclosed ${open}`);
  };
  const views = ['ask-all', 'bizpack', 'errands', 'family', 'goals', 'health', 'money', 'msgs', 'trips', 'waiting', 'whats-new', 'try-these', 'talk-mode'].map((id) => `<dialog id="${id}"`);
  const pages = ['dh-health', 'you-automations', 'you-upkeep', 'you-knows', 'you-briefing'].map((id) => `<section class="settings-page" data-page="${id}"`);
  for (const open of [...views, ...pages]) {
    const findings = checkHtml(block(open).replace(/\shidden(?=[\s>])/g, ''));
    assert.deepEqual(findings, [], open);
  }
});
