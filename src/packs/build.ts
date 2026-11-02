// Phase 127 (2.60.0, docs/design/PACKS.md §5, §6, C2): *Share her*, the allow-list builder. It reads
// only the named parts of one companion (her sheet in memory, her voice choice, her look folder, the
// saved looks and her face reference she picked, the card's greetings) and never opens her memories,
// chats, people, moments, the vault, uploads or the server's settings. The locked rows of the preview
// are counts only (COUNT(*), never a row's content). The owner's name becomes {{user}} everywhere,
// and the never-packed fields of her sheet are left out. The Q8 fix (scrubPersona) is shared with the
// character-card and character-file exports (src/packs/scrub.ts).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../chat.ts';
import { characterVoice } from '../characterfile.ts';
import { isAdultOutfit, type LookMeta } from '../look.ts';
import { fromZip, type PackageFile } from '../packages.ts';
import { DEFAULT_IMAGE_MODEL } from '../photos.ts';
import { zipStored } from '../zip-write.ts';
import { checkCompanion, type CompanionReport } from './checks.ts';
import { ownerNames, scrubPersona, swapOwner, type Replacement } from './scrub.ts';
import { idFrom, PACK_FILE, PACK_FORMAT, type LookKind, type PackManifest, type PackRating, type PackRemix, type PackRoutine } from './format.ts';
import { stripMeta } from './pictures.ts';
import { CLONED_NOTE, shareableVoice, voiceWords } from './voices.ts';

export interface BuildOptions {
  include?: { dials?: boolean; look?: boolean; closet?: string[]; reference?: boolean; voice?: boolean; greeting?: boolean; skills?: string[]; routines?: PackRoutine[] };
  rating?: PackRating;
  romance?: boolean;
  license?: string;
  remix?: PackRemix;
  author?: string;
  /** How her uploaded or built pictures were made (the builder fills `ai` for looks Sara built). */
  rights?: { from?: 'words' | 'my-drawing' | 'a-photo-with-consent'; made?: 'ai' | 'drawn' };
  consent?: boolean;
  version?: string;
  summary?: string;
  saraVersion?: string;
  /** Extra names to keep out (the people cards; read by the route, never from here). */
  people?: string[];
}
export interface Built {
  files: PackageFile[];
  manifest: PackManifest;
  replaced: Replacement[];
  notes: string[];
  report: CompanionReport;
}

const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const day = (d: Date) => d.toISOString().slice(0, 10);
function cardExtras(app: AppContext): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(join(app.dataDir, 'character-card.json'), 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function lookMeta(app: AppContext): LookMeta {
  try {
    return JSON.parse(readFileSync(join(app.dataDir, 'look', 'meta.json'), 'utf8')) as LookMeta;
  } catch {
    return {};
  }
}
const voiceOf = characterVoice;

/** The pack's files for a companion (nothing else read), checked. */
export function buildPack(app: AppContext, o: BuildOptions = {}): Built {
  const inc = o.include ?? {};
  const now = app.now();
  const owner = app.settings.get().ownerName;
  const names = ownerNames(owner);
  const notes: string[] = [];
  const { persona: sheet, replaced } = scrubPersona(app.persona, owner);
  if (inc.dials === false) delete sheet.traits;
  const files: PackageFile[] = [];
  const add = (path: string, data: Buffer) => files.push({ path, data });
  add('persona.json', json(sheet));
  // Her look: all of it (or the portrait and avatar), metadata stripped.
  let look: LookKind = 'none';
  const pictures = inc.look === false ? {} : (app.look?.files() ?? {});
  const meta = lookMeta(app);
  if (Object.keys(pictures).length) {
    const full = Object.keys(pictures).length >= 37;
    look = full ? 'full' : 'portrait';
    for (const [rel, b] of Object.entries(pictures)) if (full || rel === 'sara-portrait.jpg' || rel === 'sara-avatar.jpg') add(`look/${rel}`, stripMeta(b));
    if (!full && !pictures['sara-avatar.jpg']) add('look/sara-avatar.jpg', stripMeta(pictures['sara-portrait.jpg']));
    if (!full) notes.push('Her look is not complete here, so only her portrait goes (the new owner can build the rest).');
  }
  const words = swapOwner({ ...(sheet.appearance ? { appearance: sheet.appearance } : {}), ...(meta.style ? { style: meta.style } : {}), ...(meta.wear && !isAdultOutfit(meta.wear) ? { wear: meta.wear } : {}), ...(meta.place ? { place: meta.place } : {}) }, names, 'look', replaced).value;
  if (look !== 'none' || sheet.appearance) add('look.json', json(words));
  // Closet looks he picked (≤ 6): one portrait and its words each.
  let closet = 0;
  for (const id of (inc.closet ?? []).slice(0, 6)) {
    const s = app.look?.saved().find((x) => x.id === id);
    if (!s || !app.look) continue;
    const pic = readFileSync(app.look.savedPortrait(id));
    const cid = `look-${++closet}`;
    add(`closet/${cid}/sara-portrait.jpg`, stripMeta(pic));
    add(`closet/${cid}/look.json`, json(swapOwner({ name: s.name, ...(s.wear ? { wear: s.wear } : {}), ...(s.place ? { place: s.place } : {}), ...(s.adult || (s.wear && isAdultOutfit(s.wear)) ? { adult: true } : {}), ...(s.style ? { style: s.style } : {}) }, names, `closet.${cid}`, replaced).value));
  }
  // Her face reference (Face lock), only when ticked.
  let reference = 0;
  const face = app.look?.faceFile;
  if (inc.reference && face && existsSync(face)) {
    add('reference/face-1.jpg', stripMeta(readFileSync(face)));
    reference = 1;
  }
  // Her voice: the choice only; a cloned voice stays home.
  let voiceIncluded = false;
  if (inc.voice !== false) {
    const { voice, removed } = shareableVoice(voiceOf(app));
    if (removed) notes.push(CLONED_NOTE);
    add('voice.json', json(voice));
    voiceIncluded = true;
  }
  // Her hello: the card's greetings (if she came from one) or a short one.
  let greeting = false;
  if (inc.greeting !== false) {
    const ex = cardExtras(app);
    const first = typeof ex.first_mes === 'string' && ex.first_mes.trim() ? ex.first_mes : `Hi {{user}}, I'm ${sheet.name}. It's nice to meet you.`;
    const others = Array.isArray(ex.alternate_greetings) ? (ex.alternate_greetings as unknown[]).filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 5) : [];
    add('greeting.json', json(swapOwner({ first: first.slice(0, 1200), others: others.map((x) => x.slice(0, 1200)) }, names, 'greeting', replaced).value));
    greeting = true;
  }
  // Skills: a store skill goes as its id and range; her own skills go inside (reviewed on install).
  const skills: PackManifest['skills'] = [];
  for (const ref of (inc.skills ?? []).slice(0, 8)) {
    const [scope, name] = [ref.slice(0, ref.lastIndexOf('/')), ref.slice(ref.lastIndexOf('/') + 1)];
    const row = app.storeInstalls?.all().find((r) => r.kind === 'skill' && r.local_ref === ref);
    if (row) {
      skills.push({ store: row.item, version: `^${row.version}` });
      continue;
    }
    const sk = app.skills;
    if (!sk?.get(scope, name) || skills.filter((s) => s.bundled).length >= 5) continue;
    const dir = join(sk.dirOf(scope), name);
    try {
      for (const f of fromSkillZip(sk.exportZip(scope, name))) add(`skills/${name}/${f.path}`, f.data);
      skills.push({ bundled: name });
    } catch {
      notes.push(`The skill ${name} couldn't be read, so it stays here (${dir}).`);
    }
  }
  const rights: Record<string, unknown>[] = [];
  const pics = files.filter((f) => /\.(jpe?g|png)$/i.test(f.path)).map((f) => f.path);
  if (pics.length) {
    const madeBy = o.author?.trim() || 'the author';
    const from = o.rights?.from ?? 'words';
    rights.push({ files: pics.filter((p) => !p.startsWith('reference/')).map((p) => (p.startsWith('look/') ? 'look/*' : p)).filter((p, i, a) => a.indexOf(p) === i), made: o.rights?.made ?? (from === 'my-drawing' ? 'drawn' : 'ai'), ...(from === 'my-drawing' ? {} : { model: (app.settings.get().photos as { model?: string } | undefined)?.model || DEFAULT_IMAGE_MODEL }), by: madeBy, from, at: day(now) });
    if (reference) rights.push({ files: ['reference/face-1.jpg'], made: 'ai', model: DEFAULT_IMAGE_MODEL, by: madeBy, from, at: day(now) });
    add('rights.json', json(rights.filter((r) => (r.files as string[]).length)));
  }
  const rating: PackRating = o.rating ?? 'general';
  const version = o.version ?? '1.0.0';
  const summaryRaw = o.summary?.trim() || sheet.summary.split(/(?<=[.!?])\s+/)[0] || `${sheet.name}, a companion.`;
  const summary = swapOwner(summaryRaw.length < 20 ? `${summaryRaw} A Sara companion.` : summaryRaw.slice(0, 160), names).value;
  const manifest: PackManifest = {
    format: PACK_FORMAT,
    v: 1,
    id: idFrom(sheet.name),
    version,
    sara: `>=${(o.saraVersion ?? '2.60.0').replace(/^(\d+\.\d+\.\d+).*$/, '$1')}`,
    name: sheet.name,
    summary,
    author: { name: (o.author?.trim() || 'A Sara owner').slice(0, 60) },
    license: o.license ?? 'CC-BY-4.0',
    remix: o.remix ?? 'yes',
    rating,
    romance: rating === 'explicit' ? true : Boolean(o.romance),
    language: 'en',
    tags: [],
    includes: { persona: true, dials: Boolean(sheet.traits && Object.keys(sheet.traits).length), look, closet, reference, voice: voiceIncluded, greeting },
    skills,
    routines: (inc.routines ?? []).slice(0, 5),
    suggests: [],
    needs: { pictures: look === 'none' && Boolean(sheet.appearance), voices: voiceIncluded ? [voiceOf(app).localVoice].filter(Boolean) : [] },
    made: { with: `Sara ${o.saraVersion ?? '2.60.0'}`, at: day(now) },
  };
  add(PACK_FILE, json(manifest));
  add('CHANGES.md', Buffer.from(`# ${version}\n\nFirst shared version of ${sheet.name}.\n`));
  const report = checkCompanion(files, { mode: 'pack', ownerNames: [...names, ...(o.people ?? [])], consent: o.consent === true });
  return { files, manifest, replaced, notes, report };
}

const fromSkillZip = (zip: Buffer): PackageFile[] => fromZip(zip);

/** The pack as a stored zip (`<name>.sara-companion.zip`). */
export const packZip = (files: readonly PackageFile[]): Buffer => zipStored(files.map((f) => ({ path: f.path, data: f.data })));

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
function count(app: AppContext, sql: string): number {
  try {
    return Number((app.store.db.prepare(sql).get() as { n: number }).n) || 0;
  } catch {
    return 0;
  }
}

/**
 * The *Share her* preview model (§6.2): what goes in with sizes, what never does with counts. The
 * counts are COUNT(*) only: no memory, message or person is read.
 */
export function previewModel(app: AppContext, o: { lines?: boolean } = {}): Record<string, unknown> {
  const owner = app.settings.get().ownerName;
  const { persona, replaced } = scrubPersona(app.persona, owner);
  const pictures = app.look?.files() ?? {};
  const lookBytes = Object.values(pictures).reduce((n, b) => n + b.length, 0);
  const saved = app.look?.saved() ?? [];
  const v = voiceOf(app);
  const sv = shareableVoice(v);
  const ex = cardExtras(app);
  const alts = Array.isArray(ex.alternate_greetings) ? ex.alternate_greetings.length : 0;
  const skills = (app.skills?.list() ?? []).filter((s) => s.scope === 'companion').map((s) => ({ ref: `${s.scope}/${s.name}`, name: s.name, store: Boolean(app.storeInstalls?.all().some((r) => r.kind === 'skill' && r.local_ref === `${s.scope}/${s.name}`)) }));
  const first = ownerNames(owner)[0];
  return {
    companion: app.companionId ?? 'main',
    name: app.persona.name,
    sections: [
      { id: 'character', on: true, locked: false, size: kb(Buffer.byteLength(JSON.stringify(persona))) },
      { id: 'dials', on: Boolean(persona.traits), count: Object.keys(persona.traits ?? {}).length },
      { id: 'look', on: Object.keys(pictures).length > 0, count: Object.keys(pictures).length, size: kb(lookBytes), custom: Object.keys(pictures).length > 0 },
      { id: 'closet', on: false, count: saved.length, adult: saved.filter((s) => s.adult).length, looks: saved.map((s) => ({ id: s.id, name: s.name, adult: Boolean(s.adult) })) },
      { id: 'reference', on: false, available: Boolean(app.look && existsSync(app.look.faceFile)) },
      { id: 'voice', on: true, words: voiceWords(sv.voice), cloned: sv.removed },
      { id: 'greeting', on: true, count: 1 + Math.min(5, alts) },
      { id: 'skills', on: skills.length > 0, skills },
      { id: 'routines', on: false },
    ],
    locked: {
      memories: count(app, 'SELECT COUNT(*) AS n FROM memories'),
      chats: count(app, 'SELECT COUNT(*) AS n FROM conversations'),
      people: count(app, 'SELECT COUNT(*) AS n FROM people'),
      keys: true,
      name: first ? { name: first, count: replaced.length } : null,
      notes: Boolean(app.persona.relationshipNote || app.persona.intimacy?.yourLimits || app.persona.intimacy?.stopWord),
      photos: count(app, 'SELECT COUNT(*) AS n FROM moments'),
      cloned: sv.removed,
    },
    ...(o.lines ? { lines: replaced } : {}),
    intimacy: app.persona.intimacy?.level ?? null,
    explicitLevel: Boolean(app.persona.intimacy?.level && ['explicit', 'full'].includes(app.persona.intimacy.level)),
  };
}
