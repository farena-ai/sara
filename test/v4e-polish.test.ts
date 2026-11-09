// V4e (docs/ops/V4_DESIGN.md → V4e): the owner's polish batch after 3.0.1. Pins the layout fixes
// (composer controls, content column, Settings panel), the Violet default, palettes as full presets,
// richer Full decoration, the quiet motion and the guided move-in.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');

test('V4e: the composer controls share one height and the split Send reads as one control', () => {
  const css = read('web', 'v4.css');
  assert.match(css, /#composer \{ --cmp-h: 36px; --cmp-gap: 4px;/);
  // Every control in the row takes the same height and the same centre line.
  const row = /:is\(#composer > button\.icon, #composer-plus, #composer #send, #composer \.send-more, #composer #stop\) \{ height: var\(--cmp-h\);[^}]*align-self: center;/;
  assert.match(css, row);
  // The ▾ butts onto Send (no overlap, no gap) and shares its fill; Send drops its right corners.
  assert.match(css, /\.send-more-wrap \{ align-self: center; margin-left: calc\(-1 \* var\(--cmp-gap\)\); \}/);
  assert.match(css, /#composer #send\.busy-send \{[^}]*border-radius: 10px 0 0 10px;/);
  assert.match(css, /#composer \.send-more \{[^}]*border-radius: 0 10px 10px 0; background: var\(--btn-fill\);/);
  // Phones: a little taller, same rule.
  assert.match(css, /@media \(max-width: 520px\) \{\s*:where\(:root:not\(\[data-palette="classic"\]\)\) #composer \{ --cmp-h: 40px;/);
});

test('V4e: Today keeps How do I…?, the safety line and the routine offer on the content column', () => {
  // The block had margin: 0 (stuck to the left edge of the wide scroll area): auto sides centre it like the hero.
  assert.match(read('web', 'kit.css'), /#today \.td-howto \{ margin: 0 auto var\(--s-4\); \}/);
  const css = read('web', 'v4-pages.css');
  assert.match(css, /#today \.td-begin \{ display: grid; grid-template-columns: minmax\(0, 1fr\);[^}]*margin-bottom: 22px; \}/);
  assert.match(css, /#today \.td-safety-line \{ display: flex;[^}]*width: 100%;[^}]*background: var\(--danger-soft\);[^}]*white-space: normal;/);
  assert.match(css, /#today \.td-safety-line \.td-safety-dot \{ color: var\(--danger\);/);
  assert.match(css, /#today \.td-begin \.rt-sub::before \{ content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var\(--accent-solid\);/);
});

test('V4e: Settings is a centred panel on desktop (no longer a right-hand sheet); phones stay full screen', () => {
  const css = read('web', 'screens.css');
  const rule = /@media \(min-width: 721px\) \{\s*:where\(:root:not\(\[data-palette="classic"\]\)\) dialog\.settings-dialog \{ width: min\(1240px, calc\(100vw - 64px\)\);[^}]*margin: auto;/;
  assert.match(css, rule);
  assert.doesNotMatch(css, /dialog\.settings-dialog \{[^}]*margin: 0 0 0 auto;/);
  // The phone rule (full screen) is untouched.
  assert.match(read('web', 'style.css'), /dialog\.settings-dialog \{ width: 100vw; height: 100dvh; max-height: 100dvh; max-width: 100vw; border-radius: 0; margin: 0; \}/);
});

test('V4e: Violet is the default colour for every palette but Sara Classic (boot, app, server, CSS fallbacks)', () => {
  assert.match(read('web', 'theme-boot.js'), /var looks = \{ accent: pal === 'classic' \? 'rose' : 'violet',/);
  assert.match(read('web', 'app.js'), /const accentPick = \(pal = palettePick\(\)\) => localStorage\.getItem\('sara\.accent'\) \?\? paletteDefaultAccent\(pal\);/);
  assert.match(read('web', 'accent.js'), /export const paletteDefaultAccent = \(pal\) => \(pal === 'classic' \? 'rose' : 'violet'\);/);
  assert.match(read('src', 'appearance.ts'), /accent: pick\(o\.accent, ACCENTS, o\.palette === 'classic' \? 'rose' : 'violet'\),/);
  const theme = read('web', 'theme.css');
  // The hue fallback (glows, field, orb) and Graphite's own colour are the Violet preset's.
  assert.match(theme, /:root \{ --acc-h: 262; --acc-s: 72%; --acc-l: 64%; \}/);
  assert.match(theme, /:root\[data-palette="graphite"\]\[data-theme="dark"\] \{[^}]*--accent-solid: #a78bfa;/);
  assert.match(theme, /:root\[data-palette="graphite"\]\[data-theme="light"\] \{[^}]*--accent-solid: #7c3aed;/);
  assert.doesNotMatch(theme, /#2f6fe0/);
  const html = read('web', 'index.html');
  assert.match(html, /<option value="rose">Theme color<\/option><option value="violet">Violet \(default\)<\/option><option value="blue">Blue<\/option>/);
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.match(read('web', 'i18n', `${l}.json`), /\n"Violet \(default\)": "/, l);
});

test('V4e: a palette pick resets the colour in the real Appearance page (Custom and presets alike)', async () => {
  const a = await import(new URL('../web/accent.js', import.meta.url).href);
  // Simulate the page's change handler against a store: a custom colour and a picked preset both clear.
  for (const stored of [{ 'sara.accent': 'custom', 'sara.accentCustom': '{"hex":"#ff8800"}', 'sara.accentPicked': 'graphite' }, { 'sara.accent': 'emerald', 'sara.accentPicked': 'nord' }]) {
    const ls = new Map(Object.entries(stored));
    ls.set('sara.palette', 'midnight');
    for (const k of a.PALETTE_RESETS) ls.delete(k);
    const accent = ls.get('sara.accent') ?? a.paletteDefaultAccent(ls.get('sara.palette'));
    assert.equal(accent, 'violet');
    if (stored['sara.accentCustom']) assert.ok(ls.has('sara.accentCustom'), 'the custom colour is still offered in the field');
  }
});

test('V4e: English UI strings use US spelling (color, favorite, customize, organize, behavior, center, gray)', () => {
  // Every English UI string is a translation key: none may keep the British forms. Stored values and
  // code names (sara.* keys, 'grey' accent value, the 'neighbour' circle, CSS classes) are not keys.
  const uk = /\b(colour|favourite|customis|organis|behaviour|centre|grey|honour|neighbour)/i;
  for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const lines = read('web', 'i18n', `${l}.json`).split(/\r?\n/).filter((line) => line.startsWith('"') && !line.startsWith('"@') && line.includes('": '));
    const keys = lines.map((line) => Object.keys(JSON.parse(`{${line.replace(/,\s*$/, '')}}`))[0] ?? '');
    const bad = keys.filter((k) => uk.test(k));
    assert.deepEqual(bad, [], l);
  }
  const html = read('web', 'index.html');
  assert.match(html, /<label>Color\n/);
  assert.match(html, /<option value="rose">Theme color<\/option>/);
  assert.match(html, /<option value="grey">Gray<\/option>/, 'the stored value stays grey; the label is Gray');
  assert.match(html, /<span class="td-btn-text">Customize<\/span>/);
  assert.match(read('web', 'people.js'), /neighbour: \(\) => t\('neighbor'\)/, 'the circle id stays; its word is US');
});

test('V4e: four more non-romantic relationships (teammate, tutor, creative, adventure); custom stays last', async () => {
  const { RELATIONSHIPS, quickCharacter } = await import('../src/character.ts');
  const { RELATIONSHIP_INFO, isRomantic } = await import('../src/bond.ts');
  const ids = Object.keys(RELATIONSHIPS);
  assert.deepEqual(ids, ['friend', 'best-friend', 'flirting', 'dating', 'partner', 'married', 'open', 'complicated', 'assistant', 'mentor', 'teammate', 'tutor', 'creative', 'adventure', 'custom']);
  assert.deepEqual(Object.keys(RELATIONSHIP_INFO), ids, 'card info in the same order');
  for (const id of ['teammate', 'tutor', 'creative', 'adventure']) {
    assert.equal(RELATIONSHIP_INFO[id].romantic, false, id);
    assert.equal(isRomantic(id), false, id);
    const r = RELATIONSHIPS[id];
    assert.match(r.summary, /\{owner\}/, `${id}: the summary names the owner`);
    assert.doesNotMatch(r.summary + RELATIONSHIP_INFO[id].blurb, /romanc|flirt|love|date|dating|partner\b|kiss/i, `${id}: nothing romantic`);
    const p = quickCharacter({ name: 'Nova', pronouns: 'she', age: 30, relationship: id, vibe: 'warm', talk: 'texting', interests: '' }, 'Alex');
    assert.match(p.summary, /Alex/);
  }
  assert.equal(RELATIONSHIPS.teammate.label, 'Teammate / coworker');
  assert.equal(RELATIONSHIPS.creative.label, 'Creative partner');
  // Their labels and card lines are translated.
  const extra = read('web', 'i18n', '_extra.json');
  for (const id of ['teammate', 'tutor', 'creative', 'adventure']) {
    for (const s of [RELATIONSHIPS[id].label, RELATIONSHIP_INFO[id].blurb]) {
      assert.ok(extra.includes(JSON.stringify(s)), `_extra: ${s}`);
      for (const l of ['es', 'fr', 'de', 'pt-BR', 'it']) assert.ok(read('web', 'i18n', `${l}.json`).includes(`\n${JSON.stringify(s)}: `), `${l}: ${s}`);
    }
  }
});

test('V4e: Full decoration is visibly richer than Reduced (edge light, deeper shadows, header glow, stronger light, grain)', () => {
  const css = read('web', 'v4-pages.css');
  const FULL = ':where(:root:not([data-palette="classic"]))[data-decor="on"]:not([data-palette="contrast"])';
  const v4e = css.slice(css.indexOf('/* ---------- V4e: Full decoration'));
  assert.ok(v4e.length > 500);
  // Every rule of the block is Full-only (Reduced, High contrast and Sara Classic are untouched).
  for (const m of v4e.matchAll(/^([^\s/@}][^{]*)\{/gm)) assert.ok(m[1].trim().startsWith(FULL) || m[1].trim().startsWith(FULL.replace('"on"]:not(', '"on"][data-theme="light"]:not(')), m[1]);
  assert.match(v4e, /--v4e-edge: linear-gradient\(150deg, hsl\(var\(--acc-h\)/);
  assert.match(v4e, /::before \{\s*content: "";\s*position: absolute;[^}]*background: var\(--v4e-edge\);[^}]*pointer-events: none;[^}]*mask:/);
  assert.match(v4e, /:is\(#chat-head, \.v4-strip\) \{ box-shadow:/);
  const theme = read('web', 'theme.css');
  assert.match(theme, /--v3-light: 14%;/);
  assert.match(theme, /--grain-opacity: \.03;/);
  // The system's reduced transparency still forces Reduced before paint.
  assert.match(read('web', 'theme-boot.js'), /prefers-reduced-transparency: reduce\)'\)\.matches\) decor = 'off';/);
});

test('V4e: quiet motion: counts, draws and entrances, all off with reduced motion or Motion: Off, loops pause when hidden', async () => {
  const m = await import('../web/v4-motion.js');
  assert.deepEqual(m.numberParts('63°'), ['', 63, 0, '°']);
  assert.deepEqual(m.numberParts('$0.43'), ['$', 0.43, 2, '']);
  assert.deepEqual(m.numberParts('1,204'), ['', 1204, 0, '']);
  assert.equal(m.numberParts('Clear'), null);
  assert.equal(m.numberParts('3 of 7'), null, 'only a lone headline number counts');
  const parts = m.numberParts('$0.43');
  assert.equal(m.countFrame(parts, 0), '$0.00');
  assert.equal(m.countFrame(parts, 1), '$0.43', 'ends exactly on the real value');
  assert.equal(m.countFrame(m.numberParts('63°'), 1), '63°');
  // Off: Settings → Background motion: Off, the system's reduced motion, and Sara Classic.
  const root = (d: Record<string, string>) => ({ dataset: d }) as unknown as HTMLElement;
  const mm = (reduce: boolean) => (() => ({ matches: reduce })) as unknown as typeof matchMedia;
  assert.equal(m.motionOn(root({ motion: 'on', palette: 'graphite' }), mm(false)), true);
  assert.equal(m.motionOn(root({ motion: 'off', palette: 'graphite' }), mm(false)), false);
  assert.equal(m.motionOn(root({ motion: 'on', palette: 'graphite' }), mm(true)), false);
  assert.equal(m.motionOn(root({ motion: 'on', palette: 'classic' }), mm(false)), false);
  const app = read('web', 'app.js');
  assert.match(app, /import \{ initMotion \} from '\.\/v4-motion\.js';/);
  assert.match(app, /\ninitMotion\(\);\n/);
  const css = read('web', 'v4-living.css');
  const v4e = css.slice(css.indexOf('/* ---------- V4e: quiet motion'));
  // Transforms, opacity and clip-path only (no layout properties animate).
  for (const k of v4e.matchAll(/@keyframes [\w-]+ \{([^@]*?)\}\n/g)) assert.doesNotMatch(k[1], /\b(width|height|top|left|margin|padding)\s*:/, k[0]);
  assert.match(v4e, /#today\[open\] \.td-grid > \.td-tile \{ animation: v4e-rise [^;]*backwards;/, 'backwards: no transform left behind');
  assert.match(v4e, /:root\[data-tab-hidden\] :is\(#today \.td-face-wrap::before, #today \.td-hero::after, #today \.td-mood \.hp-dot::after\) \{ animation-play-state: paused; \}/);
  assert.match(v4e, /:root\[data-motion="off"\] #today \.td-face-wrap::before, :root\[data-motion="off"\] #today \.td-hero::after, :root\[data-motion="off"\] #today \.td-mood \.hp-dot::after \{ animation: none !important; \}/);
  assert.match(v4e, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?animation: none !important;[\s\S]*?transition: none !important;/);
  // Every rule outside the motion-off/reduced/paused guards is scoped outside Sara Classic.
  for (const r of v4e.matchAll(/^(:where[^{]*|#[^{]*)\{/gm)) assert.ok(r[1].startsWith(':where(:root:not([data-palette="classic"]))'), r[1]);
});

test('V4e move-in: the collector ships with every install (server, Docker, Windows, Mac) and is public', async () => {
  // The bug: deploy/install.sh copied src, web, persona… but not scripts/, so every server install said
  // "The collector is not on this server." while still offering Copy the command.
  assert.match(read('deploy', 'install.sh'), /mkdir -p "\$APP_DIR\/scripts"\ncp "\$SRC_DIR\/scripts\/sara-movein\.py" "\$APP_DIR\/scripts\/"/);
  assert.match(read('Dockerfile'), /\nCOPY scripts\/sara-movein\.py \.\/scripts\/sara-movein\.py\n/);
  assert.match(read('desktop', 'windows', 'build-installer.sh'), /cp "\$ROOT\/scripts\/sara-movein\.py" "\$STAGE\/server\/scripts\/"/);
  assert.match(read('desktop', 'mac', 'build.sh'), /cp "\$ROOT\/scripts\/sara-movein\.py" "\$S\/scripts\/"/);
  // Where the server looks for it, and that it is there.
  const { COLLECTOR_PATH } = await import('../src/movein/index.ts');
  assert.equal(COLLECTOR_PATH.replace(/\\/g, '/').split('/').slice(-2).join('/'), 'scripts/sara-movein.py');
  assert.ok(readFileSync(COLLECTOR_PATH, 'utf8').startsWith('#!'), 'the collector file exists');
  // The public copy keeps it (the fallback command downloads it from GitHub).
  const { PRIVATE } = await import('../scripts/public-export.ts');
  assert.ok(!PRIVATE.some((r: RegExp) => r.test('scripts/sara-movein.py')), 'scripts/sara-movein.py is published');
});

test('V4e move-in: the exact command for each system and source, checked before it runs', async () => {
  const w = await import('../web/movein-wizard.js');
  const sha = 'a'.repeat(64);
  const origin = 'https://sara.example.com';
  const mac = w.collectorCommand({ origin, sha, system: 'mac', source: 'hermes' });
  // Mac and Linux: the server's own line (curl, then sha256sum or shasum, then python3).
  assert.equal(mac, `curl -fsSL ${origin}/movein/sara-movein.py -o sara-movein.py && echo "${sha}  sara-movein.py" | (sha256sum -c - 2>/dev/null || shasum -a 256 -c -) && python3 sara-movein.py`);
  assert.equal(w.collectorCommand({ origin, sha, system: 'linux', source: 'openclaw' }), mac, 'the collector finds Hermes Agent and OpenClaw by itself');
  assert.match(w.collectorCommand({ origin, sha, system: 'linux', source: 'custom' }), /python3 sara-movein\.py --scan FOLDER$/);
  // Windows: PowerShell's own download and hash check, run only on a match.
  const win = w.collectorCommand({ origin, sha, system: 'windows', source: 'hermes' });
  assert.equal(win, `Invoke-WebRequest -UseBasicParsing ${origin}/movein/sara-movein.py -OutFile sara-movein.py; if ((Get-FileHash sara-movein.py -Algorithm SHA256).Hash -eq '${sha}') { py sara-movein.py } else { Write-Host 'The download does not match. Do not run it.' }`);
  assert.match(w.collectorCommand({ origin, sha, system: 'windows', source: 'custom' }), /\{ py sara-movein\.py --scan FOLDER \}/);
  // No collector on this server: the same file from GitHub (never a dead "Copy the command").
  assert.equal(w.fallbackCommand({ system: 'linux', source: 'hermes' }), 'curl -fsSL https://raw.githubusercontent.com/farena-ai/sara/main/scripts/sara-movein.py -o sara-movein.py && python3 sara-movein.py');
  assert.match(w.fallbackCommand({ system: 'windows', source: 'hermes' }), /^Invoke-WebRequest -UseBasicParsing https:\/\/raw\.githubusercontent\.com\/farena-ai\/sara\/main\/scripts\/sara-movein\.py -OutFile sara-movein\.py; py sara-movein\.py$/);
  // The server's command (GET /api/movein) is the Mac/Linux one.
  assert.match(read('src', 'routes', 'movein.ts'), /return `curl -fsSL \$\{origin\}\/movein\/sara-movein\.py -o sara-movein\.py && echo "\$\{sha\}  sara-movein\.py" \| \(sha256sum -c - 2>\/dev\/null \|\| shasum -a 256 -c -\) && python3 sara-movein\.py`;/);
  // First tab: this browser's system.
  assert.equal(w.guessSystem({ platform: 'Win32', userAgent: '' }), 'windows');
  assert.equal(w.guessSystem({ platform: 'MacIntel', userAgent: '' }), 'mac');
  assert.equal(w.guessSystem({ platform: 'Linux x86_64', userAgent: '' }), 'linux');
  // What they'll see: a real plan screen (the collector's own words).
  const collector = read('scripts', 'sara-movein.py');
  for (const line of ['Sara move-in collector', 'Found: Hermes Agent home', 'Skipped', 'Sensitive (off until you say yes)', 'This file is as private as your diary: delete it after the move-in.', 'Continue? [Y/n]', 'Written: ']) {
    assert.ok(w.EXAMPLE_OUTPUT.includes(line), line);
  }
  for (const word of ["'Sara move-in collector {v}", "'Sensitive (off until you say yes)'", "'Continue? [Y/n] '", "'Written'"]) assert.ok(collector.includes(word), word);
});

test('V4e move-in: a five-step wizard; steps 4 and 5 follow the bundle; every earlier control is kept', async () => {
  const w = await import('../web/movein-wizard.js');
  assert.deepEqual(w.STEPS, ['source', 'run', 'file', 'check', 'done']);
  assert.equal(w.stepForState(null), null, 'no bundle: the person walks steps 1-3');
  for (const s of ['uploading', 'checking', 'reading', 'ready', 'importing', 'failed']) assert.equal(w.stepForState(s), 'check', s);
  assert.equal(w.stepForState('imported'), 'done');
  const html = read('web', 'index.html');
  const page = /data-page="dh-movein"[\s\S]*?<\/section>\n\s*<section class="settings-page" data-page="dh-updates"/.exec(html)![0];
  // Progress 1-5 and one pane per step.
  assert.deepEqual([...page.matchAll(/<li data-step="(\w+)"><span class="mi-pnum">(\d)<\/span>/g)].map((m) => `${m[2]}:${m[1]}`), ['1:source', '2:run', '3:file', '4:check', '5:done']);
  assert.deepEqual([...page.matchAll(/<section class="mi-pane" data-pane="(\w+)"/g)].map((m) => m[1]), ['source', 'run', 'file', 'check', 'done']);
  // Step 1: three sources; Next waits for a pick. Step 2: three systems, the checkbox gates Next.
  assert.deepEqual([...page.matchAll(/data-source="(\w+)"/g)].map((m) => m[1]), ['hermes', 'openclaw', 'custom']);
  assert.match(page, /<button id="mi-next-1" type="button" class="primary" disabled>Next<\/button>/);
  assert.deepEqual([...page.matchAll(/data-os="(\w+)"/g)].map((m) => m[1]), ['windows', 'mac', 'linux']);
  assert.match(page, /<label class="row mi-ran"><input id="mi-ran" type="checkbox"> I ran it and have the \.saramove file<\/label>/);
  assert.match(page, /<button id="mi-next-2" type="button" class="primary" disabled>Next<\/button>/);
  // Everything that was there stays (copy, download, fingerprint, upload with pause, move-in code, past move-ins, mappings).
  for (const id of ['mi-cmd', 'mi-copy', 'mi-download', 'mi-sha', 'mi-file', 'mi-upload', 'mi-upbar', 'mi-pause', 'mi-resume', 'mi-code', 'mi-codeline', 'mi-work', 'mi-batches', 'mi-mappings', 'mi-map-file', 'mi-nocollector', 'mi-example', 'mi-again']) assert.ok(page.includes(`id="${id}"`), id);
  assert.doesNotMatch(read('web', 'movein.js'), /The collector is not on this server\./, 'no dead command line any more');
  const js = read('web', 'movein.js');
  assert.match(js, /\$\('#mi-ran'\)\.addEventListener\('change', \(\) => \(\$\('#mi-next-2'\)\.disabled = !\$\('#mi-ran'\)\.checked\)\);/);
  assert.match(js, /setStep\(stepForState\(pv\.state\) \?\? wiz\.step\);/, 'the preview and the import move the wizard on by themselves');
  assert.match(js, /\$\('#mi-cmd'\)\.textContent = col \? collectorCommand\(\{ origin: location\.origin, sha: col\.sha256, system, source \}\) : fallbackCommand\(\{ system, source \}\);/);
  assert.match(js, /\$\('#mi-download'\)\.hidden = !col;/);
});
