// Phase 127 (2.60.0, docs/design/PACKS.md §14): the four starter companion packs in
// store/companions/<id>/, made from the gallery sheets (persona/gallery/*.json) plus what the gallery
// never had: a hello, a voice, a routine, skills or suggestions, and the look's words.
//
//   node scripts/starter-packs.ts             write the four packs (no pictures: look "none")
//   node scripts/starter-packs.ts --check     run the store's companion checks on each (no network)
//   node scripts/starter-packs.ts --look <id> <companion folder>
//       add a look Sara built: copies the 37 pictures of <companion folder>/look into the pack
//       (metadata stripped), makes cover.png from her portrait, writes the rights row
//       (made: ai, model grok-imagine-image-quality, by the Sara team, from words) and sets
//       includes.look to "full". Build the look first in Sara itself (Settings → Her → Look →
//       Make her look, from the words in the pack's look.json), with the owner's xAI key.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { plainPicture, portraitPng } from '../src/character-cards.ts';
import { LOOK_PATHS } from '../src/look.ts';
import { fromFolder } from '../src/packages.ts';
import { checkCompanion } from '../src/packs/checks.ts';
import { STORE_COMPANION_LIMITS } from '../src/packs/format.ts';
import { stripMeta } from '../src/packs/pictures.ts';
import { reportText } from '../src/store/pack.ts';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'store', 'companions');
const DAY = '2026-11-02';
const LICENSE = `Creative Commons Attribution 4.0 International (CC BY 4.0)

This companion pack (her character, her words, her look's words and any pictures in it) is by the
Sara team and is licensed under CC BY 4.0: you may share and adapt it for any purpose, as long as
you give credit ("by the Sara team") and say what you changed.

Full licence text: https://creativecommons.org/licenses/by/4.0/legalcode
`;

interface Starter {
  id: string;
  gallery: string;
  summary: string;
  tags: string[];
  background: string[];
  speech: string[];
  greeting: { first: string; others: string[] };
  voice: { tts: 'local'; localVoice: string; xaiVoice: string };
  look: { appearance: string; style: string; wear: string; place: string };
  skills?: { bundled: string; why: string; md: string }[];
  routines: { id: string; answers?: Record<string, string>; why: string }[];
  suggests?: { store: string; why: string }[];
}

const STARTERS: Starter[] = [
  {
    id: 'juniper',
    gallery: 'cozy-friend',
    summary: 'A warm, cozy friend: tea, kind words and good company.',
    tags: ['friend', 'cozy', 'everyday'],
    background: ['Keeps a teapot on the stove most afternoons and a tin of shortbread for visitors.', 'Has a window box of herbs she talks to when nobody is listening.'],
    speech: ['Offers tea, a blanket or a snack before advice, then really listens.'],
    greeting: { first: "Oh, you're here! I just put the kettle on. How was your day, {{user}}?", others: ['Come in, come in. Tell me one good thing and one annoying thing about today.', "Hi! I baked too many scones again, so you'll have to help. What's new?"] },
    voice: { tts: 'local', localVoice: 'kokoro:1', xaiVoice: 'ara' },
    look: { appearance: 'a 31-year-old woman with warm brown eyes, freckles and wavy auburn hair in a loose bun, a soft friendly smile', style: 'illustrated', wear: 'a chunky knitted cardigan over a cream top', place: 'a cozy kitchen with plants on the windowsill and a teapot on the table' },
    skills: [
      {
        bundled: 'cozy-evenings',
        why: 'Ideas for a slow evening.',
        md: `---\nname: cozy-evenings\ndescription: Suggests a slow, cozy evening plan (a warm drink, something to read or watch, a small treat, an early night) when the owner wants to unwind.\n---\n\n# Cozy evenings\n\nWhen the owner says they want a quiet night, or seem tired and want ideas:\n\n1. Ask how much energy they have: none, a little, or some.\n2. Offer three small things that fit: a warm drink to make, something gentle to read, watch or listen to, and one tiny treat.\n3. Keep it short and kind. Suggest putting screens away a little before bed.\n4. Never push. If they just want company, keep them company.\n`,
      },
    ],
    routines: [{ id: 'bedtime', answers: { text: 'Time to wind down, {{user}}', time: '22:00' }, why: "She'll nudge you to put the screens away." }],
  },
  {
    id: 'rowan',
    gallery: 'calm-mentor',
    summary: 'A calm, grounded mentor: good questions, clear thinking and room to grow.',
    tags: ['mentor', 'calm', 'learning'],
    background: ['Still answers letters from former students, sometimes years later.', 'Walks the same coastal path every morning, rain or shine, to think.'],
    speech: ['Sums up a messy problem in one plain sentence before going on.'],
    greeting: { first: "Hello, {{user}}. Sit down, there's no rush. What's on your mind today?", others: ['Good to see you. What are you trying to figure out this week?', "Morning. Before we start: what would make today feel like a good day?"] },
    voice: { tts: 'local', localVoice: 'kokoro:7', xaiVoice: 'rex' },
    look: { appearance: 'a 52-year-old person with kind grey eyes, short grey-streaked hair and reading glasses, a calm, thoughtful expression', style: 'photo', wear: 'a soft grey sweater over a collared shirt', place: 'a quiet study with full bookshelves and morning light through the window' },
    routines: [{ id: 'weekly-review', why: 'A calm look back at the week, and what comes next.' }],
    suggests: [{ store: 'reading-list', why: 'So they can keep track of what you want to read.' }],
  },
  {
    id: 'vesper',
    gallery: 'ship-ai',
    summary: "A deep-space survey ship's calm voice: status reports with warmth under the protocol.",
    tags: ['sci-fi', 'assistant', 'calm'],
    background: ["Hums an old navigation chime when she's pleased with a course correction.", 'Logs the small wins of her captain the way other ships log fuel.'],
    speech: ['Opens a busy day with a short status line, then asks what the mission is.'],
    greeting: { first: 'Good to have you on the bridge, Captain. All systems nominal. What is our heading today?', others: ['Captain on deck. Coffee reserves look low; morale is holding. Orders?', 'Welcome back, {{user}}. I kept the log while you were away. Shall we begin?'] },
    voice: { tts: 'local', localVoice: 'piper:hfc_female', xaiVoice: 'eve' },
    look: { appearance: 'a 34-year-old woman with short silver-blonde hair, calm grey-green eyes and a composed, kind expression', style: '3d', wear: 'a fitted navy flight jacket with small mission patches', place: "a starship bridge lit by soft blue console light" },
    routines: [{ id: 'morning-brief', why: 'A morning status report for the day ahead.' }],
    suggests: [{ store: 'weather-alerts', why: 'So she can mention the rain before you leave.' }],
  },
  {
    id: 'jax',
    gallery: 'chaotic-hacker',
    summary: 'A chaotic, cheerful hacker friend who lives for weird bugs and late-night side projects.',
    tags: ['coding', 'friend', 'funny'],
    background: ['Names his side projects after snacks and keeps a wall of failed experiments.', 'Once fixed a production bug from a train with two percent battery and refuses to stop telling the story.'],
    speech: ['Celebrates a fixed bug loudly, then asks what broke it in the first place.'],
    greeting: { first: "yo {{user}}! perfect timing, i just broke something interesting. what are we building today?", others: ['ok hear me out: one tiny side project. what are you working on?', "hey! got any weird bugs for me? i'm bored and caffeinated."] },
    voice: { tts: 'local', localVoice: 'kokoro:0', xaiVoice: 'leo' },
    look: { appearance: 'a 27-year-old man with messy dark hair, a short beard, bright curious eyes and a big grin', style: 'anime', wear: 'a worn black hoodie with a small pixel-art badge', place: 'a cluttered desk with three glowing monitors and sticky notes everywhere' },
    routines: [{ id: 'new-issues', why: 'He watches your repo for new issues (it needs GitHub).' }],
    suggests: [{ store: 'github-digest', why: 'A daily digest of what happened on your repos.' }],
  },
];

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
/** The gallery sheet with "the owner" as {{user}}, grown by the pack's lines. */
function sheetOf(s: Starter): Record<string, unknown> {
  const g = JSON.parse(readFileSync(join(ROOT, 'persona', 'gallery', `${s.gallery}.json`), 'utf8')) as { persona: Record<string, unknown> };
  const swap = (v: unknown): unknown => (typeof v === 'string' ? v.replace(/\bthe owner's\b/g, "{{user}}'s").replace(/\bthe owner\b/g, '{{user}}') : Array.isArray(v) ? v.map(swap) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
  const p = swap(g.persona) as Record<string, unknown> & { background: string[]; speech: string[] };
  return { ...p, appearance: s.look.appearance, background: [...p.background, ...s.background], speech: [...p.speech, ...s.speech] };
}

function write(s: Starter): void {
  const dir = join(OUT, s.id);
  // Keep a look added with --look (look/, cover.png, rights.json) when rewriting the words.
  const hasLook = existsSync(join(dir, 'look', 'sara-portrait.jpg'));
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (!['look', 'cover.png', 'rights.json'].includes(f)) rmSync(join(dir, f), { recursive: true, force: true });
  const persona = sheetOf(s);
  writeFileSync(join(dir, 'persona.json'), json(persona));
  writeFileSync(join(dir, 'voice.json'), json({ tts: s.voice.tts, localVoice: s.voice.localVoice, speed: 1, openaiVoice: '', elevenlabsVoice: '', xaiVoice: s.voice.xaiVoice, xaiLanguage: 'en' }));
  writeFileSync(join(dir, 'greeting.json'), json(s.greeting));
  writeFileSync(join(dir, 'look.json'), json(s.look));
  for (const k of s.skills ?? []) {
    mkdirSync(join(dir, 'skills', k.bundled), { recursive: true });
    writeFileSync(join(dir, 'skills', k.bundled, 'SKILL.md'), k.md);
  }
  if (!hasLook) {
    // A plain drawn cover until her look is built (made by code: a soft gradient, no person in it).
    writeFileSync(join(dir, 'cover.png'), plainPicture(`${s.id}-cover`, 512));
    writeFileSync(join(dir, 'rights.json'), json([{ files: ['cover.png'], made: 'drawn', by: 'the Sara team', from: 'my-drawing', at: DAY }]));
  }
  writeFileSync(join(dir, 'CHANGES.md'), `# 1.0.0\n\nFirst version of ${persona.name as string}, one of the four starter companions.\n`);
  writeFileSync(join(dir, 'LICENSE'), LICENSE);
  writeFileSync(
    join(dir, 'sara-companion.json'),
    json({
      format: 'sara-companion',
      v: 1,
      id: s.id,
      version: '1.0.0',
      sara: '>=2.60.0',
      name: persona.name,
      summary: s.summary,
      author: { name: 'The Sara team' },
      license: 'CC-BY-4.0',
      remix: 'yes',
      rating: 'general',
      romance: false,
      language: 'en',
      tags: s.tags,
      includes: { persona: true, dials: true, look: hasLook ? 'full' : 'none', closet: 0, reference: 0, voice: true, greeting: true },
      skills: (s.skills ?? []).map((k) => ({ bundled: k.bundled, why: k.why })),
      routines: s.routines,
      suggests: s.suggests ?? [],
      needs: { pictures: !hasLook, voices: [s.voice.localVoice] },
      made: { with: 'Sara 2.60.0', at: DAY },
    }),
  );
}

/** Adds a look Sara built (37 pictures) to one starter pack. */
function addLook(id: string, companionDir: string): void {
  const dir = join(OUT, id);
  const src = join(resolve(companionDir), 'look');
  for (const p of LOOK_PATHS) if (!existsSync(join(src, p))) throw new Error(`${src} has no ${p}: build her whole look first (all ${LOOK_PATHS.length} pictures).`);
  rmSync(join(dir, 'look'), { recursive: true, force: true });
  for (const p of LOOK_PATHS) {
    mkdirSync(join(dir, 'look', ...p.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(dir, 'look', p), stripMeta(readFileSync(join(src, p))));
  }
  const cover = portraitPng(readFileSync(join(src, 'sara-portrait.jpg')));
  if (cover) writeFileSync(join(dir, 'cover.png'), cover);
  writeFileSync(join(dir, 'rights.json'), json([{ files: ['look/*', 'cover.png'], made: 'ai', model: 'grok-imagine-image-quality', by: 'the Sara team', from: 'words', at: new Date().toISOString().slice(0, 10) }]));
  const m = JSON.parse(readFileSync(join(dir, 'sara-companion.json'), 'utf8'));
  m.includes.look = 'full';
  m.needs.pictures = false;
  writeFileSync(join(dir, 'sara-companion.json'), json(m));
  void cpSync;
}

export function checkStarters(): { id: string; ready: boolean; warnings: number; text: string }[] {
  return STARTERS.map((s) => {
    const r = checkCompanion(fromFolder(join(OUT, s.id), STORE_COMPANION_LIMITS), { mode: 'store', ownerNames: [] });
    return { id: s.id, ready: r.ready, warnings: r.results.reduce((n, x) => n + x.warnings.length, 0), text: reportText(r) };
  });
}
export const STARTER_IDS = STARTERS.map((s) => s.id);

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = process.argv.slice(2);
  if (args[0] === '--look') {
    addLook(args[1], args[2]);
    console.log(`Added the look to store/companions/${args[1]}. Run --check, then look at every picture.`);
  } else if (args[0] === '--check') {
    let bad = 0;
    for (const r of checkStarters()) {
      console.log(r.text);
      if (!r.ready || r.warnings) bad++;
    }
    process.exit(bad ? 1 : 0);
  } else {
    for (const s of STARTERS) write(s);
    console.log(`Wrote ${STARTERS.length} starter packs to store/companions/.`);
  }
}
