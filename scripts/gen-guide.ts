// Rewrites the generated parts of the guide so they never drift from the app:
//   - the dial tables in web/help.html (between <!-- dials:start --> and <!-- dials:end -->) from src/traits.ts;
//   - Phase 114 (PL1d): the "How do I…?" index in web/help.html (between <!-- howto:start --> and
//     <!-- howto:end -->) and the docs page docs/HOW_DO_I.md, both from web/howto.json.
//   - PL2d: the answer count in docs/START_HERE.md ("All N answers") from web/howto.json.
//   - Phase 128 (PL2b): the app's / menu table in docs/CHATS.md (and, since PL2d, docs/FOR_CODERS.md) (between <!-- appmenu:start --> and
//     <!-- appmenu:end -->) from APP_MENU in src/bridges/commands.ts.
//   node scripts/gen-guide.ts           (npm run guide) writes them
//   node scripts/gen-guide.ts --check   only says which are out of date (exit 1); a test runs it, so
//                                       `npm run check` catches a howto.json/traits/menu change without it
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAITS } from '../src/traits.ts';
import { withDialTables } from '../src/guide-dials.ts';
import { howtoIndexMd, pageTitles, withHowtoIndex, type HowtoData } from '../src/guide-howto.ts';
import { withAppMenuTable } from '../src/guide-commands.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
/** Each generated file's new text (relative path → text). */
const next = new Map<string, string>();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
// Keep each file's own line endings (a Windows checkout may have CRLF).
const keepEol = (old: string, text: string) => (old.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
const howto = JSON.parse(read('web/howto.json')) as HowtoData;
const titles = pageTitles(read('web/index.html'));
const html = read('web/help.html');
next.set('web/help.html', keepEol(html, withHowtoIndex(withDialTables(html.replace(/\r\n/g, '\n')), howto, titles)));
// W2.5: the how-to clips (docs/media/clips.json, made by scripts/howto-clips.ts) are linked under their answers.
const clips = existsSync(join(ROOT, 'docs/media/clips.json')) ? JSON.parse(read('docs/media/clips.json')) : {};
next.set('docs/HOW_DO_I.md', howtoIndexMd(howto, titles, clips));
// PL2d (N37): START_HERE's "All N answers" is the number of questions in web/howto.json.
const count = Object.values(howto).reduce((sum, qs) => sum + qs.length, 0);
next.set('docs/START_HERE.md', read('docs/START_HERE.md').replace(/All \d+(\s+)answers/, `All ${count}$1answers`));
// PL2d (N36): FOR_CODERS.md carries the same generated table.
for (const page of ['docs/CHATS.md', 'docs/FOR_CODERS.md']) {
  const md = read(page);
  next.set(page, keepEol(md, withAppMenuTable(md.replace(/\r\n/g, '\n'))));
}
if (check) {
  const stale = [...next].filter(([rel, text]) => read(rel) !== text).map(([rel]) => rel);
  if (stale.length) {
    console.error(`The guide's generated parts are out of date: ${stale.join(', ')}.\nRun: npm run guide   (node scripts/gen-guide.ts), then commit those files.`);
    process.exit(1);
  }
} else {
  for (const [rel, text] of next) writeFileSync(join(ROOT, rel), text);
  console.log(`Wrote ${TRAITS.length} dials and ${count} "How do I…?" answers into web/help.html, and docs/HOW_DO_I.md`);
}
