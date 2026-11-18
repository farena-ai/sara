// U5.32 (docs/WHATS_NEW.md): builds web/whats-new.json from CHANGELOG.md (src/whats-new.ts).
//   node scripts/whats-new.ts                     write the file and list what still needs a translation
//   node scripts/whats-new.ts --check             fail when the file is stale or a highlight has no translation
//   node scripts/whats-new.ts --prune [--dry-run] V0.5: also drop the translations of highlights that fell
//                                                 off the 8-release window (old = the file before this run
//                                                 and the committed one), unless something else uses the key
// The release chores in one place: run it after the CHANGELOG has its new section, translate the list it
// prints (each language's lines are ready to append before the last `}` of web/i18n/<lang>.json), run it
// with --prune, then --check.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWhatsNew, whatsNewStrings, type WhatsNewData } from '../src/whats-new.ts';
import { allKeys, LANGS, loadLang } from './i18n-extract.ts';

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

const stringsOf = (json: string): string[] => {
  try {
    return whatsNewStrings(JSON.parse(json) as WhatsNewData);
  } catch {
    return [];
  }
};

/** Strings of the old file(s) that the new file dropped and no other part of Sara uses (`used`). */
export function goneStrings(oldJsons: string[], nextJson: string, used: Set<string>): Set<string> {
  const next = new Set(stringsOf(nextJson));
  return new Set(oldJsons.flatMap(stringsOf).filter((s) => !next.has(s) && !used.has(s)));
}

/** Drops the `"key": "…"` lines of `gone` from one web/i18n/<lang>.json text, keeping everything else byte for byte. */
export function pruneLangText(raw: string, gone: Set<string>): { text: string; removed: number } {
  if (!gone.size) return { text: raw, removed: 0 };
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(nl);
  const heads = [...gone].map((k) => `${JSON.stringify(k)}:`);
  const keep = lines.filter((l) => !heads.some((h) => l.trimStart().startsWith(h)));
  const removed = lines.length - keep.length;
  if (!removed) return { text: raw, removed: 0 };
  // The last entry may have lost its successor: no comma before the closing brace.
  const text = `${keep.join(nl).trimEnd().replace(/,(\s*)\}$/, '$1}')}${nl}`;
  JSON.parse(text);
  return { text, removed };
}

/** What to translate, in plain words: each string with the languages that lack it, then per language the lines to append. */
export function translateList(miss: Record<string, string[]>): string {
  const byString = new Map<string, string[]>();
  for (const [lang, list] of Object.entries(miss)) for (const s of list) byString.set(s, [...(byString.get(s) ?? []), lang]);
  if (!byString.size) return '';
  const out = [`${byString.size} ${byString.size === 1 ? 'string' : 'strings'} to translate (What's new highlights and release titles):`];
  for (const [s, langs] of byString) out.push(`  ${JSON.stringify(s)}  ← ${langs.join(', ')}`);
  for (const [lang, list] of Object.entries(miss)) out.push('', `--- web/i18n/${lang}.json (append before the last }) ---`, ...list.map((s) => `${JSON.stringify(s)}: "",`));
  return out.join('\n');
}

function committed(): string {
  try {
    return execFileSync('git', ['-C', ROOT, 'show', 'HEAD:web/whats-new.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = render();
  const check = process.argv.includes('--check');
  const prune = process.argv.includes('--prune');
  const dry = process.argv.includes('--dry-run');
  let now = '';
  try {
    now = readFileSync(OUT, 'utf8');
  } catch {
    /* first run */
  }
  if (!check && !dry && now !== next) writeFileSync(OUT, next);
  if (prune) {
    // allKeys() reads web/whats-new.json from disk, so the new highlights are added by hand (dry runs).
    const used = new Set([...allKeys().keys(), ...stringsOf(next)]);
    const gone = goneStrings([now, committed()], next, used);
    let total = 0;
    for (const lang of LANGS) {
      const p = join(ROOT, 'web', 'i18n', `${lang}.json`);
      const r = pruneLangText(readFileSync(p, 'utf8'), gone);
      total += r.removed;
      if (r.removed && !dry) writeFileSync(p, r.text);
      if (r.removed) console.log(`${lang}.json: ${dry ? 'would drop' : 'dropped'} ${r.removed} old highlight translation(s)`);
    }
    console.log(total ? `Prune${dry ? ' (dry run)' : ''}: ${gone.size} string(s) left the window, ${total} line(s).` : `Prune${dry ? ' (dry run)' : ''}: nothing to drop.`);
  }
  const stale = check && now.replace(/\r\n/g, '\n') !== next;
  const miss = untranslated(next);
  const count = Object.values(miss).reduce((n, l) => n + l.length, 0);
  if (stale) console.error('web/whats-new.json is stale: run node scripts/whats-new.ts');
  if (count) console.error(translateList(miss));
  if (!stale && !count) console.log(`web/whats-new.json: ${JSON.parse(next).releases.length} releases, all translated.`);
  if (check && (stale || count)) process.exit(1);
}
