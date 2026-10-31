// Phase 53: finds every user-visible English string of the web app and checks the translations.
// Sources (Phase 61: also server text in src/, see fromServer): web/index.html (text nodes, placeholder, title, aria-label, alt, data-tip, and the Settings
// page names in data-title / data-group), every
// t('…') / t("…") / t(`…`) call in web/*.js (template literals only without ${…}), and the tip
// texts of web/tips.json. Translations live in web/i18n/<lang>.json keyed by the English text.
//   node scripts/i18n-extract.ts            report missing / unused keys per language
//   node scripts/i18n-extract.ts --json     the same as JSON
//   node scripts/i18n-extract.ts --keys     print every key (one JSON array)
//   node scripts/i18n-extract.ts --missing es   print the missing keys of one language as a JSON object
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;

/** Words that stay the same in every language (product names, units, code). */
export const SAME_OK = /^(Sara|OK|Ollama|OpenAI|OpenRouter|ChatGPT|Claude|Claude Code|Grok|Grok Build|Grok Imagine|GitHub|Gmail|Google|Discord|Telegram|ElevenLabs|Home Assistant|MCP|S3|API|URL|PIN|QR|VS Code|Markdown|Kokoro|Piper|Parakeet|Whisper|Tailscale|Docker|Linux|Windows|Mac|macOS|iPhone|Android|Apple|Brave|Tavily|SearXNG|Backblaze|Anthropic|xAI|vLLM|Email|E-mail|Tokens?|Chat|Info|Web|Online|Offline|Playlist|Mini|Auto|Max|Min|Token|Logs?|Branch|Commit|Pull request|Issues?|Repo|Repos|Passkey|Passkeys|Port|Host|Ping|Demo|Pop|Jazz|Rock|Blues|Hip-hop|Country|Fantasy|Romance|Horror|Sci-fi|Anime|Manga|Podcast|Podcasts|Hobby|Hobbys|Video|Videos|Audio|Mail|Bucket|Endpoint|Global|Radio|Panorama|Cool|Fan|Fans|Selfie|Selfies|Emoji|Emojis|Sushi|Pizza|Yoga|Tennis|Golf|Instagram|TikTok|YouTube|Reddit|Netflix|Spotify|Slack|Notion|Stripe|Webhooks?|Excel|Word|PowerPoint|PDF|CSV|JSON|HTML|CSS|TypeScript|JavaScript|Python|Go|Rust|Java|Kotlin|C#|C\+\+|Node|npm|git|ID|IDs|°F|°C|km|mi|AM|PM|UTC|GMT|v\d.*|[\d\s.,:%+\-–—×x/()]+|[^\p{L}]*)$/u;

export function decode(s: string): string {
  return s
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, '\u00a0').replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

/** The same normalization the browser translator applies to a text node: trim + collapse spaces. */
export const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** True when a string is worth translating (has letters and isn't only a brand / code word). */
export function wanted(s: string): boolean {
  if (!/\p{L}/u.test(s)) return false;
  if (SAME_OK.test(s)) return false;
  if (/^[\w.-]+\.(js|ts|json|md|txt|png|jpg|sh|p8)$/i.test(s)) return false; // file names
  if (/^(https?:\/\/|\/api\/|#)\S*$/.test(s)) return false;
  if (/^[a-z][\w-]*$/.test(s) && /[-_]/.test(s)) return false; // ids / model names like gpt-4o-mini
  if (!/\s/.test(s) && (/[/@]|\w\.\w/.test(s) || /^[A-Z0-9]{6,}$/.test(s) || /^GOCSPX/.test(s))) return false; // addresses, handles, sample keys
  if (/^[-/~]/.test(s) || /^(npx|main|owner\/name)$/.test(s)) return false; // commands, paths, sample names
  return true;
}

/** Strings from index.html (or any of our HTML pages). */
export function fromHtml(html: string): string[] {
  const out = new Set<string>();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/g, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/g, ' ')
    // Code samples and owner/raw areas are not translated.
    .replace(/<(code|pre|kbd)\b[^>]*>[\s\S]*?<\/\1>/g, '<_/>')
    .replace(/<(\w+)\b[^>]*\bdata-raw\b[^>]*>[\s\S]*?<\/\1>/g, '<_/>');
  const head = body.indexOf('<body');
  const text = head >= 0 ? body.slice(head) : body;
  for (const m of text.matchAll(/>([^<]+)</g)) {
    const s = norm(decode(m[1]));
    if (s && wanted(s)) out.add(s);
  }
  for (const m of text.matchAll(/\s(?:placeholder|title|aria-label|aria-description|alt|data-tip|data-title|data-group)="([^"]*)"/g)) {
    const s = norm(decode(m[1]));
    if (s && wanted(s)) out.add(s);
  }
  return [...out];
}

/**
 * The help page's translated part (see web/help-i18n.js): title, menu, headings, the opening line,
 * and the items of "Getting started" (keyed by their HTML, so links and emphasis survive).
 */
export function fromHelp(html: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const k = norm(decode(s));
    if (k && wanted(k)) out.add(k);
  };
  const title = /<title>([^<]*)<\/title>/.exec(html)?.[1];
  if (title) add(title);
  const nav = /<nav\b[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
  for (const m of nav.matchAll(/>([^<]+)</g)) add(m[1]);
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>')).replace(/<!--[\s\S]*?-->/g, '');
  for (const m of main.matchAll(/<(h1|h2|h3)\b[^>]*>([^<]*)<\/\1>/g)) add(m[2]);
  // Phase 61: every block of the guide (list items, paragraphs, table cells, tips), keyed by its
  // inner HTML as the browser serializes it (see helpBlocks).
  for (const k of helpBlocks(main)) if (/\p{L}/u.test(k) && wanted(k)) out.add(k);
  return [...out];
}

/**
 * The blocks web/help-i18n.js translates as a whole (li, p, td, th, div.tip), as the keys the
 * browser will look up: inner HTML, spaces collapsed, a bare & written as &amp; (how innerHTML reads).
 */
export function helpBlocks(main: string): string[] {
  const out: string[] = [];
  for (const m of main.matchAll(/<(li|p|td|th)\b[^>]*>([\s\S]*?)<\/\1>|<div class="tip">([\s\S]*?)<\/div>/g)) {
    const k = norm(m[2] ?? m[3] ?? '').replace(/&(?![a-z]+;|#\d+;|#x[\da-f]+;)/gi, '&amp;');
    if (k) out.push(k);
  }
  return out;
}

/** Strings from t('…') calls in our JS modules. */
export function fromJs(src: string): string[] {
  const out = new Set<string>();
  // t('…'), t("…"), t(`…`) with no ${}; the call must not be part of a longer name (sort(), at()).
  const re = /(?<![\w$.])t\(\s*(?:'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)\s*[,)]/g;
  for (const m of src.matchAll(re)) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    const s = raw.replace(/\\(['"`\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\u([\da-f]{4})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (s.trim() && wanted(norm(s))) out.add(norm(s));
  }
  // Label maps (const UPPER_CASE = { key: 'Label', … }): shown through t(MAP[x]) or as text the page
  // translates; their values are keys too.
  // Maps may span lines; values are labels when they start with a capital or read as words ("still open").
  for (const m of src.matchAll(/^const ([A-Z][A-Z0-9_]+) = \{([^\n]*|\n[\s\S]*?\n)\};?$/gm)) {
    for (const v of m[2].matchAll(/:\s*'((?:[^'\\]|\\.)*)'/g)) {
      const s = v[1].replace(/\\(['\\])/g, '$1');
      if (s.trim() && (/^[^a-z]*\p{Lu}/u.test(s) || /^[a-z]+ [\p{L} ✓]+$/u.test(s)) && wanted(norm(s))) out.add(norm(s));
    }
  }
  return [...out];
}

/**
 * Phase 61: server-made text the owner sees (every .ts file in src/): the first argument of tr(…), trOwner(…)
 * and en(…), fixed HttpError messages (the app translates them by their English text), and
 * `errorKey: '…'` templates. Only plain quoted strings (no template literals): text with values is
 * written with {placeholders}.
 */
export function fromServer(src: string): string[] {
  const out = new Set<string>();
  const q = String.raw`'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"`;
  const res = [
    new RegExp(String.raw`(?<![\w$.])(?:tr|trOwner|en)\(\s*(?:${q})\s*[,)]`, 'g'),
    new RegExp(String.raw`new HttpError\(\s*\d+\s*,\s*(?:${q})\s*[,)]`, 'g'),
    new RegExp(String.raw`errorKey:\s*(?:${q})`, 'g'),
  ];
  for (const re of res) {
    for (const m of src.matchAll(re)) {
      const s = (m[1] ?? m[2] ?? '').replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n');
      if (s.trim() && wanted(norm(s))) out.add(norm(s));
    }
  }
  return [...out];
}

/** Every .ts file under src/. */
export function serverFiles(dir = join(ROOT, 'src')): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory()) out.push(...serverFiles(join(dir, d.name)));
    else if (d.name.endsWith('.ts')) out.push(join(dir, d.name));
  }
  return out.sort();
}

/** Tip texts and page summaries from tips.json. */
export function fromTips(json: string): string[] {
  const j = JSON.parse(json) as { tips?: Record<string, [string, string]>; pages?: Record<string, [string, string]> };
  return [...Object.values(j.tips ?? {}), ...Object.values(j.pages ?? {})].map((v) => norm(v[0])).filter(Boolean);
}

export function webJsFiles(): string[] {
  return readdirSync(join(ROOT, 'web')).filter((f) => f.endsWith('.js') && f !== 'sw.js' && f !== 'recorder-worklet.js').map((f) => join(ROOT, 'web', f));
}

/** Every key, sorted, with where it was found first. */
export function allKeys(): Map<string, string> {
  const keys = new Map<string, string>();
  const add = (list: string[], where: string) => { for (const k of list) if (!keys.has(k)) keys.set(k, where); };
  add(fromHtml(readFileSync(join(ROOT, 'web', 'index.html'), 'utf8')), 'index.html');
  for (const f of webJsFiles()) add(fromJs(readFileSync(f, 'utf8')), f.slice(ROOT.length + 1).replace(/\\/g, '/'));
  add(fromTips(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')), 'tips.json');
  add(fromHelp(readFileSync(join(ROOT, 'web', 'help.html'), 'utf8')), 'help.html');
  for (const f of serverFiles()) add(fromServer(readFileSync(f, 'utf8')), f.slice(ROOT.length + 1).replace(/\\/g, '/'));
  // Extra keys a module asks for by list (see web/i18n/_extra.json): words built from data, e.g. memory kinds.
  const extraPath = join(ROOT, 'web', 'i18n', '_extra.json');
  if (existsSync(extraPath)) add((JSON.parse(readFileSync(extraPath, 'utf8')) as { keys: string[] }).keys, '_extra.json');
  return keys;
}

export function loadLang(lang: string): Record<string, string> {
  const p = join(ROOT, 'web', 'i18n', `${lang}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>) : {};
}

/** {name}-style placeholders in a string. */
export const placeholders = (s: string): string[] => [...s.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort();

export interface LangReport {
  lang: string;
  missing: string[];
  unused: string[];
  badPlaceholders: string[];
}

export function report(): { keys: number; langs: LangReport[] } {
  const keys = allKeys();
  const langs = LANGS.map((lang) => {
    const dict = loadLang(lang);
    const missing = [...keys.keys()].filter((k) => !(k in dict) || !String(dict[k]).trim());
    const unused = Object.keys(dict).filter((k) => !keys.has(k) && !k.startsWith('@'));
    const badPlaceholders = Object.keys(dict).filter((k) => keys.has(k) && placeholders(k).join() !== placeholders(dict[k]).join());
    return { lang, missing, unused, badPlaceholders };
  });
  return { keys: keys.size, langs };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/i18n-extract.ts')) {
  if (process.argv.includes('--keys')) {
    console.log(JSON.stringify([...allKeys().keys()], null, 1));
  } else if (process.argv.includes('--missing')) {
    const lang = process.argv[process.argv.indexOf('--missing') + 1];
    const r = report().langs.find((l) => l.lang === lang);
    console.log(JSON.stringify(Object.fromEntries((r?.missing ?? []).map((k) => [k, ''])), null, 1));
  } else {
    const r = report();
    if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
    else {
      console.log(`${r.keys} strings to translate.`);
      for (const l of r.langs) {
        console.log(`  ${l.lang}: ${l.missing.length} missing, ${l.unused.length} unused, ${l.badPlaceholders.length} with wrong {placeholders}`);
        for (const k of l.missing.slice(0, 10)) console.log(`    missing: ${k.slice(0, 90)}`);
        for (const k of l.unused.slice(0, 10)) console.log(`    unused: ${k.slice(0, 90)}`);
        for (const k of l.badPlaceholders.slice(0, 10)) console.log(`    placeholders: ${k.slice(0, 90)}`);
      }
    }
  }
}
