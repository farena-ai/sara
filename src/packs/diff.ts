// Phase 127 (2.60.0, docs/design/PACKS.md §9, C6): an update of a companion made from a pack, as a
// three-way diff per section: base (the installed version's words, kept in <companion>/pack/), now
// (her sheet today, which the owner may have edited) and new (the update). A line only the author
// changed is preselected *Take*; a line both changed is a conflict preselected *Yours*; a line only
// the owner changed isn't shown. The name never changes; pronouns and age are always conflicts; a
// raised rating is a red row preselected *Keep*. Her memories, chats, people, moments, Adult mode
// and closet are never touched; *Go back* restores the sheet, dials, look pictures and voice.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../chat.ts';
import { withCharacterVoice, type CharacterVoice } from '../characterfile.ts';
import { LOOK_PATHS } from '../look.ts';
import { hashFiles, type PackageFile } from '../packages.ts';
import { validatePersona, type Persona } from '../persona.ts';
import { compareSemver } from '../plugins/manifest.ts';
import { savePersona } from '../studio.ts';
import { TRAITS, type TraitId } from '../traits.ts';
import { InstallError } from '../store/install.ts';
import { jsonOf, PACK_FILE, RATINGS, type PackManifest } from './format.ts';
import { holdExplicit, renameSheet, type PackInstalls } from './install.ts';
import { fillNames } from './scrub.ts';
import { adultModeOn } from '../settings.ts';

export type Pick = 'take' | 'keep' | 'yours' | 'theirs';
export interface DiffRow {
  id: string;
  section: 'personality' | 'dials' | 'look' | 'voice' | 'skills' | 'rating' | 'identity';
  kind: 'added' | 'removed' | 'changed' | 'conflict' | 'rating' | 'line';
  field?: string;
  before?: string;
  after?: string;
  /** For a conflict: the owner's own version. */
  yours?: string;
  pick: Pick | null;
  red?: boolean;
  text?: string;
}
export interface UpdateModel {
  companion: string;
  from: string;
  to: string;
  changes: string;
  rows: DiffRow[];
  summary: { picked: number; decide: number };
}

const LIST_FIELDS = ['background', 'personality', 'speech', 'boundaries'] as const;
const SCALARS = ['summary', 'appearance', 'humour', 'relationship', 'talk', 'archetype', 'away', 'conflict', 'others'] as const;
const read = <T>(f: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

/** The new version's sheet as this owner would get it (names filled, the rename, explicit lines held while Adult mode is off). */
function prepared(p: Persona, m: PackManifest, app: AppContext, owner: string | undefined): Persona {
  const name = app.persona.name;
  let s = renameSheet(fillNames(p, owner, m.name), m.name, name);
  s.name = name;
  if (!adultModeOn(app.settings.get())) s = holdExplicit(s).persona;
  return s;
}

/** The update card's rows (§9.2). */
export function updateRows(base: Persona, now: Persona, next: Persona, o: { baseVoice?: CharacterVoice; nowVoice?: CharacterVoice; newVoice?: CharacterVoice; baseManifest: PackManifest; newManifest: PackManifest; lookChanged: number; lookEdited: boolean }): DiffRow[] {
  const rows: DiffRow[] = [];
  let n = 0;
  const id = () => `r${++n}`;
  // A raised rating first, in red, preselected Keep.
  const rank = (r: string) => (RATINGS as readonly string[]).indexOf(r);
  if (rank(o.newManifest.rating) > rank(o.baseManifest.rating) || (o.newManifest.romance && !o.baseManifest.romance)) rows.push({ id: id(), section: 'rating', kind: 'rating', before: `${o.baseManifest.rating}${o.baseManifest.romance ? ', romantic' : ''}`, after: `${o.newManifest.rating}${o.newManifest.romance ? ', romantic' : ''}`, pick: 'keep', red: true });
  // Pronouns and age: always conflict rows, never preselected.
  for (const k of ['pronouns', 'age'] as const) if (String(base[k] ?? '') !== String(next[k] ?? '')) rows.push({ id: id(), section: 'identity', kind: 'conflict', field: k, before: String(base[k] ?? ''), after: String(next[k] ?? ''), yours: String(now[k] ?? ''), pick: null });
  for (const k of SCALARS) {
    const b = String(base[k] ?? '');
    const x = String(next[k] ?? '');
    if (b === x) continue;
    const mine = String(now[k] ?? '');
    rows.push(mine === b ? { id: id(), section: 'personality', kind: 'changed', field: k, before: b, after: x, pick: 'take' } : mine === x ? { id: id(), section: 'personality', kind: 'line', field: k, text: 'already the same', pick: null } : { id: id(), section: 'personality', kind: 'conflict', field: k, before: b, after: x, yours: mine, pick: 'yours' });
  }
  for (const k of LIST_FIELDS) {
    const b = base[k];
    const x = next[k];
    const mine = now[k];
    const removed = b.filter((l) => !x.includes(l));
    const added = x.filter((l) => !b.includes(l));
    const pairs = Math.min(removed.length, added.length);
    for (let i = 0; i < pairs; i++) {
      const before = removed[i];
      const after = added[i];
      if (mine.includes(after)) continue;
      rows.push(mine.includes(before) ? { id: id(), section: 'personality', kind: 'changed', field: k, before, after, pick: 'take' } : { id: id(), section: 'personality', kind: 'conflict', field: k, before, after, yours: '', pick: 'yours' });
    }
    for (const after of added.slice(pairs)) if (!mine.includes(after)) rows.push({ id: id(), section: 'personality', kind: 'added', field: k, after, pick: 'take' });
    for (const before of removed.slice(pairs)) if (mine.includes(before)) rows.push({ id: id(), section: 'personality', kind: 'removed', field: k, before, pick: 'take' });
  }
  for (const t of TRAITS) {
    const b = base.traits?.[t.id];
    const x = next.traits?.[t.id];
    if (b === x || x === undefined) continue;
    const mine = now.traits?.[t.id];
    rows.push(mine === b ? { id: id(), section: 'dials', kind: 'changed', field: t.id, before: String(b ?? 5), after: String(x), pick: 'take', text: t.label } : { id: id(), section: 'dials', kind: 'conflict', field: t.id, before: String(b ?? 5), after: String(x), yours: String(mine ?? 5), pick: 'yours', text: t.label });
  }
  if (o.lookChanged) rows.push({ id: id(), section: 'look', kind: o.lookEdited ? 'conflict' : 'changed', text: `${o.lookChanged} new or changed picture${o.lookChanged === 1 ? '' : 's'}`, pick: o.lookEdited ? 'keep' : 'take' });
  const vkey = (v?: CharacterVoice) => (v ? `${v.tts}|${v.localVoice}|${v.xaiVoice}|${v.openaiVoice}|${v.elevenlabsVoice}|${v.speed}` : '');
  if (o.newVoice && vkey(o.newVoice) !== vkey(o.baseVoice)) {
    const edited = vkey(o.nowVoice) !== vkey(o.baseVoice);
    rows.push({ id: id(), section: 'voice', kind: edited ? 'conflict' : 'changed', before: vkey(o.baseVoice), after: vkey(o.newVoice), pick: edited ? 'keep' : 'take' });
  }
  const sk = (m: PackManifest) => m.skills.map((s) => s.store ?? `pack:${s.bundled}`);
  for (const s of sk(o.newManifest)) if (!sk(o.baseManifest).includes(s)) rows.push({ id: id(), section: 'skills', kind: 'added', after: s.replace(/^pack:/, ''), pick: 'take' });
  for (const s of sk(o.baseManifest)) if (!sk(o.newManifest).includes(s)) rows.push({ id: id(), section: 'skills', kind: 'line', before: s.replace(/^pack:/, ''), text: `The new version doesn't include ${s.replace(/^pack:/, '')} any more. It stays with her; remove it in Skills if you like.`, pick: null });
  return rows;
}

/** Applies the picks to her sheet now (only rows picked take/theirs change anything). */
export function applyRows(now: Persona, rows: DiffRow[], picks: Record<string, Pick | undefined>): Persona {
  const p = structuredClone(now);
  for (const r of rows) {
    const pick = picks[r.id] ?? r.pick;
    if (pick !== 'take' && pick !== 'theirs') continue;
    if (r.section === 'identity' && r.field) (p as unknown as Record<string, unknown>)[r.field] = r.field === 'age' ? Number(r.after) : r.after;
    else if (r.section === 'personality' && r.field) {
      if ((SCALARS as readonly string[]).includes(r.field)) (p as unknown as Record<string, unknown>)[r.field] = r.after || undefined;
      else {
        const k = r.field as (typeof LIST_FIELDS)[number];
        if (r.kind === 'added') p[k] = [...p[k], r.after!];
        else if (r.kind === 'removed') p[k] = p[k].filter((l) => l !== r.before);
        else {
          const i = p[k].indexOf(r.before!);
          if (i >= 0) p[k][i] = r.after!;
          else p[k] = [...p[k], r.after!];
        }
      }
    } else if (r.section === 'dials' && r.field) p.traits = { ...(p.traits ?? {}), [r.field as TraitId]: Number(r.after) };
  }
  return p;
}

const staged = new Map<string, { companion: string; files: PackageFile[]; manifest: PackManifest; next: Persona; rows: DiffRow[]; expires: number }>();

/** The update card for a companion (§9.2), from the checked new version's files. */
export function updateCard(app: AppContext, companion: string, files: PackageFile[], report: { pack?: PackManifest; persona?: Persona; ready: boolean; results: { ok: boolean; problems: string[] }[] }, owner: string | undefined): UpdateModel & { token: string } {
  const base = join(app.dataDir, 'pack');
  const baseManifest = read<PackManifest>(join(base, PACK_FILE));
  const basePersona = read<Persona>(join(base, 'persona.json'));
  if (!baseManifest || !basePersona) throw new InstallError(404, 'missing', "She didn't come from a pack, so there's nothing to update.");
  if (!report.ready || !report.pack || !report.persona) throw new InstallError(400, 'checks', report.results.find((r) => !r.ok)?.problems[0] ?? 'The new version failed a check, so her current version keeps working.');
  const m = report.pack;
  if (m.id !== baseManifest.id) throw new InstallError(409, 'other', 'This is a different pack: adding it makes a new companion.');
  if (compareSemver(m.version, baseManifest.version) <= 0) throw new InstallError(409, 'older', `She already has ${baseManifest.name} ${baseManifest.version}; this file is ${m.version}.`);
  const next = prepared(report.persona, m, app, owner);
  const by = new Map(files.map((f) => [f.path, f]));
  const lookNew = files.filter((f) => f.path.startsWith('look/'));
  const current = app.look?.files() ?? {};
  const changed = lookNew.filter((f) => !current[f.path.slice(5)] || !current[f.path.slice(5)].equals(f.data)).length;
  const lookSha = existsSync(join(base, 'look.sha')) ? readFileSync(join(base, 'look.sha'), 'utf8').trim() : '';
  const curSha = hashFiles(Object.entries(current).map(([k, v]) => ({ path: `look/${k}`, data: v })));
  const nowVoice = voiceNow(app);
  const rows = updateRows(basePersona, app.persona, next, { baseVoice: read<CharacterVoice>(join(base, 'voice.json')), nowVoice, newVoice: jsonOf<CharacterVoice>(by.get('voice.json')), baseManifest, newManifest: m, lookChanged: changed, lookEdited: lookSha !== '' && lookSha !== curSha && Object.keys(current).length > 0 });
  const token = `u${Math.random().toString(36).slice(2, 14)}`;
  for (const [k, s] of staged) if (s.expires < Date.now()) staged.delete(k);
  staged.set(token, { companion, files, manifest: m, next, rows, expires: Date.now() + 15 * 60_000 });
  const changes = String(by.get('CHANGES.md')?.data.toString('utf8') ?? '').split(/\n#+\s/)[0].replace(/^#+\s*\S+\s*/, '').trim().slice(0, 400);
  return { token, companion, from: baseManifest.version, to: m.version, changes, rows, summary: { picked: rows.filter((r) => r.pick === 'take').length, decide: rows.filter((r) => r.kind === 'conflict').length } };
}
function voiceNow(app: AppContext): CharacterVoice {
  const v = app.settings.get().voice;
  return { tts: v?.tts ?? 'local', localVoice: v?.localVoice ?? '', speed: v?.speed ?? 1, openaiVoice: v?.openai?.ttsVoice ?? '', elevenlabsVoice: v?.elevenlabs?.voiceId ?? '', xaiVoice: v?.xai?.voiceId ?? 'eve', xaiLanguage: v?.xai?.language ?? 'en' };
}

/** *Update with what I picked*: keeps prev/ for Go back; the base becomes the new version. */
export function applyUpdate(app: AppContext, token: string, picks: Record<string, Pick | undefined>, installs: PackInstalls, now: Date): { version: string; taken: Record<string, Pick | null> } {
  const s = staged.get(token);
  if (!s || s.expires < Date.now()) throw new InstallError(404, 'expired', 'This update card has expired. Open it again.');
  const base = join(app.dataDir, 'pack');
  // prev/: her sheet, voice and look pictures just before the update.
  const prev = join(base, 'prev');
  rmSync(prev, { recursive: true, force: true });
  mkdirSync(prev, { recursive: true, mode: 0o700 });
  writeFileSync(join(prev, 'persona.json'), JSON.stringify(app.persona, null, 2), { mode: 0o600 });
  writeFileSync(join(prev, 'voice.json'), JSON.stringify(app.settings.get().voice ?? {}), { mode: 0o600 });
  for (const f of [PACK_FILE, 'persona.json', 'voice.json', 'look.sha']) if (existsSync(join(base, f))) cpSync(join(base, f), join(prev, `base-${f}`));
  if (existsSync(join(app.dataDir, 'look'))) cpSync(join(app.dataDir, 'look'), join(prev, 'look'), { recursive: true });
  const taken: Record<string, Pick | null> = {};
  for (const r of s.rows) taken[r.id] = picks[r.id] ?? r.pick;
  const next = validatePersona({ ...applyRows(app.persona, s.rows, picks), name: app.persona.name });
  savePersona(app, next);
  const by = new Map(s.files.map((f) => [f.path, f]));
  const pick = (section: string) => s.rows.filter((r) => r.section === section).every((r) => (picks[r.id] ?? r.pick) === 'take' || (picks[r.id] ?? r.pick) === 'theirs');
  const lookRows = s.rows.filter((r) => r.section === 'look');
  if (lookRows.length && pick('look')) {
    const dir = join(app.dataDir, 'look');
    mkdirSync(join(dir, 'sara', 'frames'), { recursive: true, mode: 0o700 });
    for (const f of s.files) if (f.path.startsWith('look/') && LOOK_PATHS.includes(f.path.slice(5))) writeFileSync(join(dir, f.path.slice(5)), f.data, { mode: 0o600 });
  }
  const v = jsonOf<CharacterVoice>(by.get('voice.json'));
  if (v && s.rows.some((r) => r.section === 'voice') && pick('voice')) app.settings.update({ voice: withCharacterVoice(app, v) });
  // The base is the new version now (what he took and kept is recorded for the next diff).
  writeFileSync(join(base, PACK_FILE), `${JSON.stringify(s.manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(base, 'persona.json'), `${JSON.stringify(s.next, null, 2)}\n`, { mode: 0o600 });
  if (v) writeFileSync(join(base, 'voice.json'), `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  const lookFiles = s.files.filter((f) => f.path.startsWith('look/'));
  if (lookFiles.length) writeFileSync(join(base, 'look.sha'), hashFiles(lookFiles), { mode: 0o600 });
  const row = installs.get(s.companion);
  if (row) installs.upsert({ ...row, version: s.manifest.version, content_sha: hashFiles(s.files), rating: s.rows.some((r) => r.section === 'rating' && (picks[r.id] ?? r.pick) === 'keep') ? row.rating : s.manifest.rating, taken: JSON.stringify(taken), updated_at: now.toISOString() });
  staged.delete(token);
  return { version: s.manifest.version, taken };
}

/** *Go back to <version>*: her sheet, dials, look pictures and voice from prev/ (memories unaffected). */
export function goBack(app: AppContext, companion: string, installs: PackInstalls, now: Date): { version: string } {
  const base = join(app.dataDir, 'pack');
  const prev = join(base, 'prev');
  const p = read<Persona>(join(prev, 'persona.json'));
  if (!p) throw new InstallError(409, 'none', 'There is no earlier version to go back to.');
  savePersona(app, validatePersona(p));
  const v = read<Record<string, unknown>>(join(prev, 'voice.json'));
  if (v) app.settings.update({ voice: v as never });
  if (existsSync(join(prev, 'look'))) {
    rmSync(join(app.dataDir, 'look'), { recursive: true, force: true });
    renameSync(join(prev, 'look'), join(app.dataDir, 'look'));
  }
  const m = read<PackManifest>(join(prev, `base-${PACK_FILE}`));
  for (const f of [PACK_FILE, 'persona.json', 'voice.json', 'look.sha']) if (existsSync(join(prev, `base-${f}`))) cpSync(join(prev, `base-${f}`), join(base, f));
  rmSync(prev, { recursive: true, force: true });
  const row = installs.get(companion);
  if (row && m) installs.upsert({ ...row, version: m.version, updated_at: now.toISOString() });
  return { version: m?.version ?? row?.version ?? '' };
}
