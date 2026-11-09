// V4d (docs/ops/V4_DESIGN.md → V4d): the sidebar lists projects once. Every group the old list had
// (channel projects, his projects, No project, Archived, Hidden) is one folder row that folds open to
// its sessions; the project page is a separate button; Sara Classic keeps its groups as they were.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
const fnOf = (src: string, name: string) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';

test('V4d sidebar: one list of projects, every old group kept', () => {
  const app = web('app.js');
  // The duplicate list is gone (it opened the page only and skipped channel projects and No project).
  assert.doesNotMatch(app, /function projectsSection\(/);
  assert.doesNotMatch(app, /side-projects/);
  const rc = fnOf(app, 'renderConversations');
  // Channel projects (Telegram, Discord…) with their channel icon, his projects with a folder, No project.
  assert.match(rc, /group\(`p\$\{p\.id\}`, p\.name, convs, \{\s*builtin: p,\s*icon: channelIcon\(p\),/);
  assert.match(rc, /group\(`p\$\{p\.id\}`, p\.name, live\.filter\(\(c\) => c\.projectId === p\.id\), \{\s*folder: 'folder',/);
  assert.match(rc, /group\('none', [^\n]*\{ folder: 'chat', dropProject: null,/);
  assert.match(rc, /group\('archived', t\('Archived'\), archived, \{ folder: 'archive', \.\.\.paging\('archived', 'archived'\) \}\)/);
  assert.match(rc, /parts\.push\(hiddenGroup\(hidden, live\)\)/);
  // Drag and drop, paging, the folded set and the counts stay in group().
  const g = fnOf(app, 'group');
  for (const re of [/opts\.dropProject !== undefined/, /moveConversation\(id, \{ projectId: opts\.dropProject, archived: false \}\)/, /saveCollapsed\(\);/, /appendPage\(box, key, convs, o\)/, /convs\.length \+ unloaded/]) assert.match(g, re);
});

test('V4d sidebar: a folder row folds open (aria-expanded, arrows) and the project page is a separate button', () => {
  const app = web('app.js');
  const g = fnOf(app, 'group');
  assert.match(g, /toggle\.setAttribute\('aria-expanded', String\(!isCollapsed\)\);/);
  // Arrow keys: right opens, left folds (Enter and Space are the button's own).
  assert.match(g, /e\.key === 'ArrowRight' && collapsed\.has\(key\)/);
  assert.match(g, /e\.key === 'ArrowLeft' && !collapsed\.has\(key\)/);
  assert.match(g, /el\('span', 'group-arrow', isCollapsed \? '▸' : '▾'\)/);
  assert.match(g, /icon\('chevron-down', 'group-chev'\)/);
  assert.match(g, /opts\.folder \? icon\(opts\.folder, 'group-icon group-folder'\) : null/);
  // The page opens from its own button (not the row), with a label for screen readers.
  const rc = fnOf(app, 'renderConversations');
  assert.match(rc, /pageBtn\(p\)/);
  assert.match(fnOf(app, 'pageBtn'), /openProjectPage\(p\.id\)/);
  assert.match(fnOf(app, 'pageBtn'), /setAttribute\('aria-label'/);
  // Each session row says its state for the dot (working, ended, open, idle).
  assert.match(fnOf(app, 'convRow'), /a\.dataset\.state = c\.working \? 'working' : c\.endedAt \? 'ended' : c\.id === state\.currentId \? 'open' : 'idle';/);
});

test('V4d sidebar: the folder look is outside Sara Classic only; Classic keeps its arrows and capitals', () => {
  const css = web('v4-pages.css');
  assert.match(css, /:root\[data-palette="classic"\] :is\(\.group-chev, \.group-folder, \.gb-ic\) \{ display: none; \}/);
  assert.match(css, /:where\(:root:not\(\[data-palette="classic"\]\)\) \.group-arrow \{ display: none; \}/);
  assert.match(css, /:where\(:root:not\(\[data-palette="classic"\]\)\) #conversations \.group-toggle \{[^}]*text-transform: none;/);
  assert.match(css, /:where\(:root:not\(\[data-palette="classic"\]\)\) #conversations \.group-toggle\[aria-expanded="false"\] \.group-chev \{ transform: rotate\(-90deg\); \}/);
  // Row actions show on hover and keyboard focus (always on touch screens).
  assert.match(css, /#conversations \.group-head:is\(:hover, :focus-within\) \.group-btn/);
  assert.match(css, /@media \(pointer: coarse\)/);
  // The session dots: one colour per state.
  for (const s of ['working', 'open', 'idle', 'ended']) assert.ok(css.includes(`a.conv[data-state="${s}"]`), s);
});
