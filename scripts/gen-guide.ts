// Rewrites the generated parts of the guide so they never drift from the app:
//   - the dial tables in web/help.html (between <!-- dials:start --> and <!-- dials:end -->) from src/traits.ts;
//   - Phase 114 (PL1d): the "How do I…?" index in web/help.html (between <!-- howto:start --> and
//     <!-- howto:end -->) and the docs page docs/HOW_DO_I.md, both from web/howto.json.
//   node scripts/gen-guide.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRAITS } from '../src/traits.ts';
import { withDialTables } from '../src/guide-dials.ts';
import { howtoIndexMd, pageTitles, withHowtoIndex, type HowtoData } from '../src/guide-howto.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(ROOT, 'web', 'help.html');
const html = readFileSync(file, 'utf8');
const howto = JSON.parse(readFileSync(join(ROOT, 'web', 'howto.json'), 'utf8')) as HowtoData;
const titles = pageTitles(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8'));
// Keep the file's own line endings (a Windows checkout has CRLF).
const crlf = html.includes('\r\n');
const out = withHowtoIndex(withDialTables(html.replace(/\r\n/g, '\n')), howto, titles);
writeFileSync(file, crlf ? out.replace(/\n/g, '\r\n') : out);
writeFileSync(join(ROOT, 'docs', 'HOW_DO_I.md'), howtoIndexMd(howto, titles));
const count = Object.values(howto).reduce((n, l) => n + l.length, 0);
console.log(`Wrote ${TRAITS.length} dials and ${count} "How do I…?" answers into web/help.html, and docs/HOW_DO_I.md`);
