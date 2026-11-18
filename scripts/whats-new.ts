// U5.32 (docs/WHATS_NEW.md): builds web/whats-new.json from CHANGELOG.md (src/whats-new.ts).
//   node scripts/whats-new.ts            write the file and list highlights that still need translations
//   node scripts/whats-new.ts --check    fail when the file is stale or a highlight has no translation
// Translate a new highlight like any other string: `node scripts/i18n-extract.ts --missing es` lists
// it, then append its line to web/i18n/<lang>.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWhatsNew, whatsNewStrings } from '../src/whats-new.ts';
import { LANGS, loadLang } from './i18n-extract.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'web', 'whats-new.json');

export const render = (): string => `${JSON.stringify(buildWhatsNew(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')), null, 1)}\n`;

/** Highlights and titles without a translation, per language. */
export function untranslated(json: string): Record<string, string[]> {
  const strings = whatsNewStrings(JSON.parse(json));
  const out: Record<string, string[]> = {};
  for (const lang of LANGS) {
    const tr = loadLang(lang);
    const miss = strings.filter((s) => !tr[s]?.trim());
    if (miss.length) out[lang] = miss;
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = render();
  const check = process.argv.includes('--check');
  let now = '';
  try {
    now = readFileSync(OUT, 'utf8');
  } catch {
    /* first run */
  }
  if (!check && now !== next) writeFileSync(OUT, next);
  const stale = check && now.replace(/\r\n/g, '\n') !== next;
  const miss = untranslated(next);
  const count = Object.values(miss).reduce((n, l) => n + l.length, 0);
  if (stale) console.error('web/whats-new.json is stale: run node scripts/whats-new.ts');
  for (const [lang, l] of Object.entries(miss)) console.error(`${lang}: ${l.length} highlight(s) without a translation, e.g. ${JSON.stringify(l[0])}`);
  if (!stale && !count) console.log(`web/whats-new.json: ${JSON.parse(next).releases.length} releases, all translated.`);
  if (check && (stale || count)) process.exit(1);
}
