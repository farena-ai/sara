// 2.7.1 (owner decision): Sara opens on Today. Deep links (a conversation, a place, a tour, a
// sign-in coming back), answering her call, the asked-for guided setup and the demo still win.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const web = (f: string) => readFileSync(join(ROOT, 'web', f), 'utf8');
type StartsOnToday = (s?: { hash?: string; answering?: boolean; wizard?: boolean; demo?: boolean }) => boolean;
const load = async (): Promise<StartsOnToday> => (await import(`data:text/javascript;base64,${Buffer.from(web('start-view.js')).toString('base64')}`)).startsOnToday;

test('Today by default; any link, a call being answered, the guided setup or the demo win', async () => {
  const startsOnToday = await load();
  assert.equal(startsOnToday(), true);
  assert.equal(startsOnToday({ hash: '' }), true, 'a plain start (the apps, a home-screen icon, a bookmark)');
  assert.equal(startsOnToday({ hash: '#' }), true);
  for (const hash of ['#c=abc-123', '#view=planner', '#view=settings:models', '#view=today', '#tour=first', '#google=ok', '#anything']) assert.equal(startsOnToday({ hash }), false, hash);
  assert.equal(startsOnToday({ answering: true }), false, 'answering her call from the notification');
  assert.equal(startsOnToday({ wizard: true }), false, 'the guided setup the owner asked for');
  assert.equal(startsOnToday({ demo: true }), false, 'demo visitors come to talk to her');
});

test('boot: the last conversation is opened underneath, then Today on top (the link is read before it is cleared)', () => {
  const app = ['app.js', 'settings-nav.js', 'tours.js', 'setup-wizard.js'].map((f) => web(f)).join('\n');
  assert.match(app, /import \{ startsOnToday \} from '\.\/start-view\.js';/);
  const boot = app.slice(app.indexOf('async function boot()'), app.indexOf('function setChatTitle()'));
  const decide = boot.indexOf('const onToday = startsOnToday({ hash: location.hash,');
  const clear = boot.indexOf("if (fromLink) history.replaceState(null, '', '/');");
  assert.ok(decide > 0 && decide < clear, 'decided before the conversation link is taken out of the address');
  assert.match(boot, /answering: Boolean\(sessionStorage\.getItem\('sara\.answer'\)\)/);
  assert.match(boot, /wizard: sessionStorage\.getItem\('sara\.openWizard'\) === '1'/);
  assert.match(boot, /demo: Boolean\(session\.demo\)/);
  const open = boot.indexOf('if (first) await openConversation(first.id);');
  const today = boot.indexOf('if (onToday) void openToday();');
  assert.ok(open > 0 && today > open, 'Chat stays one tap away under Today');
  // Today is still a view (not a modal window): Chat in the bar, Esc and the back button close it.
  assert.match(web('today.js'), /if \(!d\.open\) d\.show\(\);/);
  // The deep links keep working after boot.
  assert.match(app, /setTimeout\(openViewFromHash, 300\);/);
  assert.match(app, /window\.addEventListener\('hashchange', openViewFromHash\);/);
  assert.match(app, /window\.addEventListener\('hashchange', tourFromHash\);/);
  // Notifications (service worker message) and the phone/desktop apps' conversation links.
  assert.match(app, /navigator\.serviceWorker\?\.addEventListener\('message', \(e\) => \{\s*const id = e\.data\?\.type === 'open' && \/#c=/);
  // The first tour's steps close Today themselves (closeOpenDialogs), so it can start from Today.
  assert.match(app, /const closeOpenDialogs = \(\) => \{\s*for \(const d of document\.querySelectorAll\('dialog\[open\]'\)\) d\.close\(\);/);
  assert.match(app, /first: \[\s*\{ sel: '#new-chat',[^\n]*before: sidebar\(true\) \},\s*\{ before: sidebar\(false\), sel: '#input'/);
});

// PL2a (docs/design/POLISH2.md N26): after the wizard the anonymous check-in note's box never meets
// the message box's. The note lives in the page flow (a card at the top of Today, or right above the
// composer), so its box ends where #input's begins. Laid out here with the boxes the app's CSS gives
// at 1440×900 and 390×844 (the live check with Edge is in the release notes' screenshots).
test('after the wizard, the check-in note does not intersect #input at 1440×900 and 390×844', () => {
  const html = web('index.html');
  const hub = web('hub.js');
  const css = web('hub.css');
  // Where it goes: Today open → #td-checkin (inside Today, not over the chat); otherwise #chat-checkin, a sibling just before the composer.
  assert.match(hub, /const host = today\?\.open \? \$\('#td-checkin'\) : \$\('#chat-checkin'\);/);
  assert.match(html, /<div id="chat-checkin" class="checkin-slot"><\/div>\n {6}<form id="composer">/);
  // In the flow: static, no offsets, no transform (the fixed note of 2.60 covered the composer).
  assert.match(css, /\.hub-note\.hub-note-inline \{ position: static; z-index: auto; transform: none; left: auto; bottom: auto;/);
  // #chat is a column: messages (flex 1), the slot, the composer. Boxes in a column never overlap.
  assert.match(web('style.css'), /#chat \{ display: flex; flex-direction: column;/);
  type Box = { top: number; bottom: number };
  const column = (h: number, items: { h: number; grow?: boolean }[]): Box[] => {
    const fixed = items.filter((i) => !i.grow).reduce((n, i) => n + i.h, 0);
    let y = 0;
    return items.map((i) => {
      const height = i.grow ? Math.max(0, h - fixed) : i.h;
      const b = { top: y, bottom: y + height };
      y += height;
      return b;
    });
  };
  const meets = (a: Box, b: Box) => a.top < b.bottom && b.top < a.bottom;
  for (const [w, h, noteH] of [[1440, 900, 140], [390, 844, 260]]) {
    const [, note, input] = column(h, [{ h: 0, grow: true }, { h: noteH }, { h: 46 }]);
    assert.equal(meets(note, input), false, `${w}×${h}`);
    assert.ok(note.bottom <= input.top);
  }
  // The wizard still folds the note into its last step (PL1b F2) and puts it back after.
  assert.match(hub, /export function foldFirstRun\(host\)/);
});
