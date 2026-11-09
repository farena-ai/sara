// Phase 127 (2.60.0, docs/design/PACKS.md §8, §11.2, §13.1, C5): a pack → the review card → a NEW
// companion. Every door (the store, a file, a card) runs checkCompanion first; a minors refusal is
// final (the staging folder is deleted at once, the log line has no text). *Add her* re-checks the
// staged files' hash, fills {{user}} and {{char}}, applies the rename, holds explicit lines aside
// while her Adult mode is off (always, for a new companion), and makes her with the same code as
// POST /api/companions (retired again if the build throws). Nobody else is touched; no memory row
// is written; skills only through their review cards; routines are offered, never switched on.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AppContext } from '../chat.ts';
import { withCharacterVoice, type CharacterVoice } from '../characterfile.ts';
import { createCompanionDir, retireCompanionDir, type CompanionManager } from '../companions.ts';
import { appLanguage } from '../i18n.ts';
import { intimacyLevel } from '../bond.ts';
import { LOOK_PATHS } from '../look.ts';
import { fromFolder, hashFiles, writePackage, type PackageFile } from '../packages.ts';
import { validatePersona, type Persona } from '../persona.ts';
import { compareSemver, satisfies, saraSatisfies } from '../plugins/manifest.ts';
import { SARA_VERSION } from '../plugins/manager.ts';
import { loadCatalog, MEMBER_ENGINES, ROUTINES_DIR } from '../routines.ts';
import { detectExplicit, disclosureText } from '../safety.ts';
import { adultModeOn } from '../settings.ts';
import { savePersona } from '../studio.ts';
import { TRAITS } from '../traits.ts';
import { InstallError, StoreInstaller } from '../store/install.ts';
import type { StoreClient } from '../store/client.ts';
import type { StoreInstalls } from '../store/installs.ts';
import { checkCompanion, MINORS_REFUSAL, type CompanionReport } from './checks.ts';
import { jsonOf, LICENSE_WORDS, PACK_FILE, STORE_COMPANION_LIMITS, type PackManifest } from './format.ts';
import { fillNames } from './scrub.ts';
import { LOCAL_VOICES, voiceWords } from './voices.ts';

export const PACK_CARD_MS = 15 * 60_000;
export const MAX_STAGED = 3;
export const COMPANION_CAP = 8;
export const CAP_LINE = 'Up to 8 companions on one server. Retire one in Settings → Her → Companions first.';
export type PackOrigin = 'store' | 'file' | 'card';
export type PackTrust = 'first-party' | 'reviewed' | 'community' | 'file';

// ---------------------------------------------------------------------------------------------
// pack_installs (the owner's sara.db, additive)
// ---------------------------------------------------------------------------------------------

export interface PackInstallRow {
  companion_id: string;
  pack_id: string;
  version: string;
  origin: PackOrigin;
  trust: PackTrust;
  content_sha: string;
  rating: string;
  author: string;
  license: string;
  remix: string;
  taken: string;
  held: number;
  state: 'ok' | 'yanked' | 'blocked' | 'paused';
  state_note: string | null;
  installed_at: string;
  updated_at: string;
}
export class PackInstalls {
  readonly db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS pack_installs (
  companion_id TEXT PRIMARY KEY,
  pack_id      TEXT NOT NULL,
  version      TEXT NOT NULL,
  origin       TEXT NOT NULL,
  trust        TEXT NOT NULL,
  content_sha  TEXT NOT NULL,
  rating       TEXT NOT NULL,
  author       TEXT NOT NULL,
  license      TEXT NOT NULL,
  remix        TEXT NOT NULL,
  taken        TEXT NOT NULL DEFAULT '{}',
  held         INTEGER NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'ok',
  state_note   TEXT,
  installed_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pack_installs_pack ON pack_installs(pack_id);`);
  }
  all(): PackInstallRow[] {
    return this.db.prepare('SELECT * FROM pack_installs ORDER BY installed_at').all() as unknown as PackInstallRow[];
  }
  get(companion: string): PackInstallRow | undefined {
    return this.db.prepare('SELECT * FROM pack_installs WHERE companion_id = ?').get(companion) as unknown as PackInstallRow | undefined;
  }
  upsert(r: Omit<PackInstallRow, 'state' | 'state_note'> & { state?: PackInstallRow['state']; state_note?: string | null }): void {
    this.db
      .prepare(`INSERT INTO pack_installs (companion_id, pack_id, version, origin, trust, content_sha, rating, author, license, remix, taken, held, state, state_note, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(companion_id) DO UPDATE SET pack_id = excluded.pack_id, version = excluded.version, origin = excluded.origin, trust = excluded.trust, content_sha = excluded.content_sha, rating = excluded.rating, author = excluded.author, license = excluded.license, remix = excluded.remix, taken = excluded.taken, held = excluded.held, state = excluded.state, state_note = excluded.state_note, updated_at = excluded.updated_at`)
      .run(r.companion_id, r.pack_id, r.version, r.origin, r.trust, r.content_sha, r.rating, r.author, r.license, r.remix, r.taken, r.held, r.state ?? 'ok', r.state_note ?? null, r.installed_at, r.updated_at);
  }
  setState(companion: string, state: PackInstallRow['state'], note: string | null, at: string): void {
    this.db.prepare('UPDATE pack_installs SET state = ?, state_note = ?, updated_at = ? WHERE companion_id = ?').run(state, note, at, companion);
  }
  setHeld(companion: string, held: number, at: string): void {
    this.db.prepare('UPDATE pack_installs SET held = ?, updated_at = ? WHERE companion_id = ?').run(held, at, companion);
  }
  delete(companion: string): void {
    this.db.prepare('DELETE FROM pack_installs WHERE companion_id = ?').run(companion);
  }
}

// ---------------------------------------------------------------------------------------------
// the card
// ---------------------------------------------------------------------------------------------

export interface PackCard {
  token: string;
  origin: PackOrigin;
  trust: PackTrust;
  source?: string;
  creator?: string;
  id: string;
  version: string;
  name: string;
  nameHere: string;
  nameTaken: boolean;
  pronouns: string;
  age: number;
  summary: string;
  relationship: string | null;
  romance: boolean;
  rating: string;
  author: string;
  license: string;
  licenseWords: string;
  remix: string;
  others: string[];
  dials: { id: string; label: string; low: string; high: string; value: number }[];
  sheet: { section: string; lines: string[] }[];
  sheetLines: number;
  look: { kind: string; count: number; rights: string; needsPictures: boolean; closet: number; adultLooks: number; reference: number; picture: boolean };
  voice: { words: string; speed: number; here: boolean; note?: string } | null;
  greeting: { first: string; others: number } | null;
  skills: { key: string; name: string; from: 'store' | 'pack'; why?: string }[];
  routines: { id: string; title: string; why?: string; member: boolean }[];
  suggests: { store: string; why?: string }[];
  adult: { held: number; adultLooks: number; level: boolean } | null;
  capReached: boolean;
  fingerprint: string;
  size: number;
  notes: string[];
  warnings: string[];
  expires: number;
}
interface Staged {
  card: PackCard;
  dir: string;
  sha: string;
  report: CompanionReport;
  store?: { item: string; version: string; entrySha: string; trust: string };
  /** An update of this companion (the update card), not a new one. */
  update?: string;
  member?: string;
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SHEET_FIELDS = ['background', 'personality', 'speech', 'boundaries'] as const;
const RIGHTS_WORDS = (rows: unknown): string => {
  if (!Array.isArray(rows) || !rows.length) return 'none';
  const r = rows[0] as { made?: string; model?: string; by?: string };
  if (r.made === 'ai') return `made with ${r.model === 'grok-imagine-image-quality' || !r.model ? 'Grok Imagine' : r.model}${r.by ? ` by ${r.by}` : ''}`;
  if (r.made === 'drawn') return `drawn${r.by ? ` by ${r.by}` : ''}`;
  if (r.made === 'licensed') return 'licensed';
  return 'not said';
};

/** A copy of a sheet with one name swapped for another, as whole words (newCompanionPersona's swap). */
export function renameSheet<T>(v: T, from: string, to: string): T {
  if (!from || from === to) return v;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(from)}(?![\\p{L}\\p{N}])`, 'gu');
  const walk = (x: unknown): unknown => (typeof x === 'string' ? x.replace(re, to) : Array.isArray(x) ? x.map(walk) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)])) : x);
  return walk(v) as T;
}

/** Her sheet with explicit lines held aside (§8.3), and what was held. */
export function holdExplicit(p: Persona): { persona: Persona; held: Record<string, unknown>; count: number } {
  const held: Record<string, unknown> = {};
  let count = 0;
  const out = structuredClone(p);
  for (const k of SHEET_FIELDS) {
    const keep: string[] = [];
    const away: string[] = [];
    for (const line of out[k]) (detectExplicit(line) ? away : keep).push(line);
    out[k] = keep;
    if (away.length) {
      held[k] = away;
      count += away.length;
    }
  }
  const sents = out.summary.split(/(?<=[.!?…])\s+/);
  const away = sents.filter((x) => detectExplicit(x));
  if (away.length && away.length < sents.length) {
    out.summary = sents.filter((x) => !detectExplicit(x)).join(' ');
    held.summary = away;
    count += away.length;
  }
  if (out.life) {
    const life: Record<string, string> = {};
    for (const [k, v] of Object.entries(out.life)) if (v && detectExplicit(v)) life[k] = v;
    for (const k of Object.keys(life)) delete out.life[k];
    if (Object.keys(life).length) {
      held.life = life;
      count += Object.keys(life).length;
    }
  }
  if (out.intimacy) {
    const im: Record<string, string> = {};
    for (const k of ['likes', 'limits', 'turnoffs'] as const) if (out.intimacy[k] && detectExplicit(out.intimacy[k]!)) im[k] = out.intimacy[k]!;
    for (const k of Object.keys(im)) delete (out.intimacy as Record<string, unknown>)[k];
    if (Object.keys(im).length) {
      held.intimacy = im;
      count += Object.keys(im).length;
    }
  }
  return { persona: out, held, count };
}

export interface PackInstallerDeps {
  /** The owner's main companion (its sara.db holds pack_installs). */
  app: AppContext;
  companions: CompanionManager;
  /** The owner's data folder (companions/ lives under it). */
  rootDir: string;
  installs: PackInstalls;
  client?: StoreClient;
  storeInstalls?: StoreInstalls;
  now?: () => Date;
  log?: (line: string) => void;
  /** The running Sara's version (the manifest's `sara` range is checked against it). */
  saraVersion?: string;
}

const staged = new Map<string, Staged>();

export class PackInstaller {
  readonly d: PackInstallerDeps;
  constructor(d: PackInstallerDeps) {
    this.d = d;
  }
  #now(): Date {
    return this.d.now?.() ?? this.d.app.now();
  }
  #log(line: string): void {
    (this.d.log ?? ((l: string) => console.warn(l)))(line);
  }
  get stagingRoot(): string {
    return join(this.d.rootDir, 'packs', 'staging');
  }
  #sweep(): void {
    const now = Date.now();
    for (const [k, s] of staged) if (s.card.expires < now) this.cancel(k);
  }
  cancel(token: string): boolean {
    const s = staged.get(token);
    if (!s) return false;
    rmSync(s.dir, { recursive: true, force: true });
    staged.delete(token);
    return true;
  }
  pending(token: string): PackCard | undefined {
    const s = staged.get(token);
    return s && s.card.expires > Date.now() ? s.card : undefined;
  }
  /** The staged files (for the update card and tests). */
  stagedFiles(token: string): PackageFile[] | undefined {
    const s = staged.get(token);
    return s ? fromFolder(s.dir, STORE_COMPANION_LIMITS) : undefined;
  }
  #names(): string[] {
    return this.d.companions.all().map((c) => c.app.persona.name.toLowerCase());
  }
  freeName(base: string): { name: string; taken: boolean } {
    const names = this.#names();
    if (!names.includes(base.toLowerCase())) return { name: base, taken: false };
    for (let i = 2; i < 100; i++) {
      const n = `${base.slice(0, 36)} ${i}`;
      if (!names.includes(n.toLowerCase())) return { name: n, taken: true };
    }
    return { name: base, taken: true };
  }

  /**
   * Checks a pack and stages its card (or refuses in plain words). A minors refusal deletes
   * everything at once and logs without the text.
   */
  preview(files: PackageFile[], o: { origin: PackOrigin; trust?: PackTrust; source?: string; creator?: string; notes?: string[]; store?: Staged['store']; update?: string; member?: string } = { origin: 'file' }): { card: PackCard; report: CompanionReport } {
    this.#sweep();
    const report = checkCompanion(files, { mode: 'install' });
    if (report.minors) {
      this.#log(`packs: refused a ${o.origin} pack (minors): no override`);
      throw Object.assign(new InstallError(400, 'minors', MINORS_REFUSAL), { report });
    }
    if (!report.ready) {
      const first = report.results.find((r) => !r.ok)!;
      throw Object.assign(new InstallError(400, 'checks', first.problems[0] ?? 'This pack failed a check.'), { report });
    }
    const m = report.pack!;
    const p = report.persona!;
    const running = this.d.saraVersion ?? this.d.app.pluginManager?.version ?? SARA_VERSION;
    if (!saraSatisfies(running, m.sara)) throw Object.assign(new InstallError(400, 'sara', `This companion pack needs Sara ${m.sara.replace(/^>=\s*/, '')} or newer. Update Sara first.`), { report });
    while (staged.size >= MAX_STAGED) this.cancel(staged.keys().next().value!);
    const token = randomBytes(12).toString('base64url');
    const dir = join(this.stagingRoot, token);
    rmSync(dir, { recursive: true, force: true });
    writePackage(files, dir);
    const by = new Map(files.map((f) => [f.path, f]));
    const greet = jsonOf<{ first: string; others?: string[] }>(by.get('greeting.json'));
    const voice = jsonOf<CharacterVoice>(by.get('voice.json'));
    const owner = this.d.app.settings.get().ownerName;
    const filled = fillNames(p, owner, p.name);
    const { name, taken } = this.freeName(m.name);
    const hold = holdExplicit(filled);
    const closet = files.filter((f) => /^closet\/[^/]+\/look\.json$/.test(f.path)).map((f) => jsonOf<{ adult?: boolean }>(f));
    const catalog = loadCatalog(ROUTINES_DIR);
    const local = voice?.tts === 'local' || !voice?.tts ? voice?.localVoice : undefined;
    const voiceHere = !local || !this.d.app.voice || this.d.app.voice.voices().some((x: { id: string }) => x.id === local);
    const cloud = voice && ['openai', 'elevenlabs', 'xai'].includes(voice.tts) ? voice.tts : undefined;
    const keyed = cloud ? Boolean(this.d.app.vault.get(cloud === 'xai' ? 'tts:xai' : cloud === 'openai' ? 'tts:openai' : 'tts:elevenlabs') ?? this.d.app.vault.get(cloud === 'xai' ? 'images:xai' : `${cloud}`)) : true;
    const sheet = [
      { section: 'Summary', lines: [filled.summary] },
      { section: 'Background', lines: filled.background },
      { section: 'Personality', lines: filled.personality },
      { section: 'How she talks', lines: filled.speech },
      { section: 'Boundaries', lines: filled.boundaries },
      ...(filled.life ? [{ section: 'Her life', lines: Object.entries(filled.life).map(([k, v]) => `${k}: ${v}`) }] : []),
      ...(filled.intimacy ? [{ section: 'Intimacy, her side', lines: [`${filled.intimacy.level ?? 'none'}`, ...(['likes', 'limits', 'turnoffs'] as const).filter((k) => filled.intimacy![k]).map((k) => `${k}: ${filled.intimacy![k]}`)] }] : []),
    ].filter((s) => s.lines.length);
    const level = Boolean(p.intimacy?.level && intimacyLevel(p.intimacy.level)?.adult);
    const adultLooks = closet.filter((c) => c?.adult).length;
    const card: PackCard = {
      token,
      origin: o.origin,
      trust: o.trust ?? (o.origin === 'store' ? 'reviewed' : 'file'),
      ...(o.source ? { source: o.source } : {}),
      ...(o.creator ? { creator: o.creator } : {}),
      id: m.id,
      version: m.version,
      name: m.name,
      nameHere: name,
      nameTaken: taken,
      pronouns: p.pronouns ?? 'she',
      age: p.age,
      summary: filled.summary,
      relationship: p.relationship ?? null,
      romance: m.romance,
      rating: m.rating,
      author: m.author.name,
      license: m.license,
      licenseWords: LICENSE_WORDS[m.license] ?? m.license,
      remix: m.remix,
      others: this.d.companions.all().map((c) => c.app.persona.name),
      dials: TRAITS.filter((t) => p.traits?.[t.id] !== undefined).map((t) => ({ id: t.id, label: t.label, low: t.low, high: t.high, value: p.traits![t.id]! })),
      sheet,
      sheetLines: sheet.reduce((n, s) => n + s.lines.length, 0),
      look: { kind: m.includes.look, count: files.filter((f) => f.path.startsWith('look/')).length, rights: RIGHTS_WORDS(jsonOf(by.get('rights.json'))), needsPictures: m.needs.pictures, closet: m.includes.closet, adultLooks, reference: m.includes.reference, picture: Boolean(by.get('cover.png')) },
      voice: voice ? { words: voiceWords(voice), speed: voice.speed ?? 1, here: voiceHere && keyed, ...(!voiceHere ? { note: `${LOCAL_VOICES[local!] ?? local} isn't on this computer yet: Get local voices (Settings → Her → Voice) or she'll use yours until then.` } : !keyed ? { note: 'There is no key for that voice here, so she uses your local voice until you add one.' } : {}) } : null,
      greeting: greet?.first ? { first: fillNames(greet.first, owner, name), others: greet.others?.length ?? 0 } : null,
      skills: m.skills.map((s) => (s.store ? { key: `store:${s.store}`, name: s.store, from: 'store' as const, ...(s.why ? { why: s.why } : {}) } : { key: `pack:${s.bundled}`, name: s.bundled!, from: 'pack' as const, ...(s.why ? { why: s.why } : {}) })),
      routines: m.routines.map((r) => {
        const def = catalog.find((x) => x.id === r.id);
        return { id: r.id, title: def?.title ?? r.id, ...(r.why ? { why: r.why } : {}), member: Boolean(def && (MEMBER_ENGINES as readonly string[]).includes(def.engine)) };
      }),
      suggests: m.suggests,
      adult: m.rating === 'explicit' || hold.count || adultLooks || level ? { held: hold.count, adultLooks, level } : null,
      capReached: this.d.companions.all().length >= COMPANION_CAP,
      fingerprint: hashFiles(files),
      size: files.reduce((n, f) => n + f.data.length, 0),
      notes: o.notes ?? [],
      warnings: report.results.flatMap((r) => r.warnings),
      expires: Date.now() + PACK_CARD_MS,
    };
    staged.set(token, { card, dir, sha: card.fingerprint, report, ...(o.store ? { store: o.store } : {}), ...(o.update ? { update: o.update } : {}), ...(o.member ? { member: o.member } : {}) });
    return { card, report };
  }

  /** The staged pack for the update card (diff.ts). */
  takeStaged(token: string): { files: PackageFile[]; report: CompanionReport; card: PackCard; store?: Staged['store'] } {
    const s = staged.get(token);
    if (!s || s.card.expires < Date.now()) throw new InstallError(404, 'expired', 'This card has expired. Choose the pack again.');
    const files = fromFolder(s.dir, STORE_COMPANION_LIMITS);
    if (hashFiles(files) !== s.sha) {
      this.cancel(token);
      throw new InstallError(409, 'changed', 'The pack changed while the card was open, so Sara threw it away. Choose it again.');
    }
    return { files, report: s.report, card: s.card, ...(s.store ? { store: s.store } : {}) };
  }

  /** *Add her* (§8.3). Returns the new companion and the follow-ups (skill reviews, routines, links). */
  async install(token: string, body: { name?: string; skills?: string[]; picture?: boolean } = {}, o: { dataRoot?: string; companions?: CompanionManager; space?: string } = {}): Promise<{ companion: string; name: string; held: number; followUps: Record<string, unknown>[] }> {
    const { files, report, card, store } = this.takeStaged(token);
    const cm = o.companions ?? this.d.companions;
    const root = o.dataRoot ?? this.d.rootDir;
    if (!cm.build) throw new InstallError(400, 'none', 'More companions are not available on this server.');
    if (cm.all().length >= COMPANION_CAP) throw new InstallError(400, 'cap', CAP_LINE);
    const name = String(body.name ?? card.nameHere).trim();
    if (!name || name.length > 40) throw new InstallError(400, 'name', 'Give her a name of up to 40 characters.');
    if (cm.all().some((c) => c.app.persona.name.toLowerCase() === name.toLowerCase())) throw new InstallError(400, 'name', `You already have a ${name}. Pick another name for this one.`);
    const m = report.pack as PackManifest;
    const by = new Map(files.map((f) => [f.path, f]));
    const owner = this.d.app.settings.get().ownerName;
    const sheet0 = renameSheet(fillNames(report.persona!, owner, m.name), m.name, name);
    sheet0.name = name;
    // A new companion starts with Adult mode off: explicit lines wait in pack/held.json.
    const hold = holdExplicit(sheet0);
    let persona: Persona;
    try {
      persona = validatePersona(hold.persona);
    } catch (err) {
      throw new InstallError(400, 'persona', `Her character can't be used: ${(err as Error).message}.`);
    }
    const now = this.#now();
    const { id, dir } = createCompanionDir(root, persona as unknown as Record<string, unknown>, now);
    let comp;
    try {
      // Her look (the relative paths LookBuilder.files() reads), closet, reference.
      const lookFiles = files.filter((f) => f.path.startsWith('look/'));
      if (lookFiles.length) {
        mkdirSync(join(dir, 'look', 'sara', 'frames'), { recursive: true, mode: 0o700 });
        for (const f of lookFiles) if (LOOK_PATHS.includes(f.path.slice(5))) writeFileSync(join(dir, 'look', f.path.slice(5)), f.data, { mode: 0o600 });
        const lw = jsonOf<Record<string, string>>(by.get('look.json')) ?? {};
        writeFileSync(join(dir, 'look', 'meta.json'), JSON.stringify({ ...(lw.wear ? { wear: lw.wear } : {}), ...(lw.place ? { place: lw.place } : {}), ...(lw.style ? { style: lw.style } : {}) }), { mode: 0o600 });
      }
      for (const cid of [...new Set(files.filter((f) => f.path.startsWith('closet/')).map((f) => f.path.split('/')[1]))]) {
        const meta = jsonOf<{ name?: string; wear?: string; place?: string; adult?: boolean; style?: string }>(by.get(`closet/${cid}/look.json`)) ?? {};
        const lid = randomBytes(6).toString('hex');
        const ld = join(dir, 'looks', lid);
        mkdirSync(ld, { recursive: true, mode: 0o700 });
        writeFileSync(join(ld, 'sara-portrait.jpg'), by.get(`closet/${cid}/sara-portrait.jpg`)!.data, { mode: 0o600 });
        writeFileSync(join(ld, 'look.json'), JSON.stringify({ id: lid, name: String(meta.name ?? 'A look').slice(0, 60), savedAt: now.toISOString() }), { mode: 0o600 });
        writeFileSync(join(ld, 'meta.json'), JSON.stringify({ ...(meta.wear ? { wear: meta.wear } : {}), ...(meta.place ? { place: meta.place } : {}), ...(meta.adult ? { adult: true } : {}), ...(meta.style ? { style: meta.style } : {}) }), { mode: 0o600 });
      }
      const ref = by.get('reference/face-1.jpg');
      if (ref) writeFileSync(join(dir, 'look-face.jpg'), ref.data, { mode: 0o600 });
      // A card's picture becomes her picture, like Settings → Look → Upload (Phase 57).
      if (card.origin === 'card' && by.get('cover.png') && body.picture !== false) writeFileSync(join(dir, 'avatar.png'), by.get('cover.png')!.data, { mode: 0o600 });
      const extras = { tags: m.tags, first_mes: jsonOf<{ first?: string }>(by.get('greeting.json'))?.first ?? '', alternate_greetings: jsonOf<{ others?: string[] }>(by.get('greeting.json'))?.others ?? [], creator: m.author.name, character_version: m.version, importedAt: now.toISOString(), pack: m.id };
      writeFileSync(join(dir, 'character-card.json'), json(extras), { mode: 0o600 });
      // The base for updates: the installed version's words (no pictures), and what was held.
      const base = join(dir, 'pack');
      mkdirSync(base, { recursive: true, mode: 0o700 });
      writeFileSync(join(base, PACK_FILE), json(m), { mode: 0o600 });
      writeFileSync(join(base, 'persona.json'), json(persona), { mode: 0o600 });
      if (by.get('voice.json')) writeFileSync(join(base, 'voice.json'), by.get('voice.json')!.data, { mode: 0o600 });
      writeFileSync(join(base, 'look.sha'), hashFiles(lookFiles), { mode: 0o600 });
      if (hold.count) writeFileSync(join(base, 'held.json'), json(hold.held), { mode: 0o600 });
      comp = cm.build(id, dir);
      cm.add(comp);
      comp.start();
    } catch (err) {
      try {
        retireCompanionDir(root, id, now);
      } catch {
        /* nothing to put aside */
      }
      if (err instanceof InstallError) throw err;
      throw new InstallError(500, 'build', `Sara couldn't add her: ${(err as Error).message}`);
    }
    staged.delete(token);
    rmSync(join(this.stagingRoot, token), { recursive: true, force: true });
    const app = comp.app;
    const voice = jsonOf<CharacterVoice>(by.get('voice.json'));
    if (voice) app.settings.update({ voice: withCharacterVoice(app, { tts: voice.tts ?? 'local', localVoice: voice.localVoice ?? '', speed: voice.speed ?? 1, openaiVoice: voice.openaiVoice ?? '', elevenlabsVoice: voice.elevenlabsVoice ?? '', xaiVoice: voice.xaiVoice ?? 'eve', xaiLanguage: voice.xaiLanguage ?? 'en' }) });
    if (ref0(files)) app.settings.update({ faceLock: false } as never);
    // Her first chat: the AI notice first, then the pack's greeting (marked as from the pack).
    const greet = jsonOf<{ first?: string }>(by.get('greeting.json'))?.first;
    if (greet) {
      const hello = renameSheet(fillNames(greet, owner, m.name), m.name, name);
      const conv = app.store.createConversation({ title: `Hello from ${name}` });
      app.store.addMessage(conv.id, 'notice', `disclosure:${disclosureText(name, appLanguage(app.settings.get()))}`);
      if (!detectExplicit(hello) || adultModeOn(app.settings.get())) app.store.addMessage(conv.id, 'assistant', hello.slice(0, 1200), { fromPack: { id: m.id, version: m.version } });
    }
    const at = now.toISOString();
    this.d.installs.upsert({ companion_id: id, pack_id: m.id, version: m.version, origin: card.origin, trust: card.trust, content_sha: card.fingerprint, rating: m.rating, author: m.author.name, license: m.license, remix: m.remix, taken: '{}', held: hold.count, installed_at: at, updated_at: at });
    if (store && this.d.storeInstalls) this.d.storeInstalls.upsert({ item: store.item, kind: 'companion', version: store.version, trust: store.trust, local_ref: id, content_sha: card.fingerprint, entry_sha: store.entrySha, recipe: null, prev_recipe: null, installed_at: at, updated_at: at });
    this.#log(`packs: added ${name} from ${card.origin === 'store' ? 'the Sara Store' : card.origin === 'card' ? 'a character card' : 'a file'}, ${m.id} ${m.version}`);
    const followUps = await this.followUps(app, files, m, body.skills, o.space);
    return { companion: id, name, held: hold.count, followUps };
  }

  /** After *Add her* (§8.3 step 7): a skill review per ticked skill, then routines, then links. Nothing is installed here. */
  async followUps(app: AppContext, files: PackageFile[], m: PackManifest, ticked?: string[], space?: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    const want = (key: string) => !ticked || ticked.includes(key);
    for (const s of m.skills) {
      if (s.bundled && want(`pack:${s.bundled}`)) {
        if (!app.skills) continue;
        const inner = files.filter((f) => f.path.startsWith(`skills/${s.bundled}/`)).map((f) => ({ path: `${s.bundled}/${f.path.slice(`skills/${s.bundled}/`.length)}`, data: f.data }));
        const p = app.skills.stage(inner, `pack:${m.id}@${m.version}`, 'zip');
        out.push({ kind: 'skill', from: 'pack', name: s.bundled, review: { id: p.id, origin: p.origin, skills: p.skills } });
      } else if (s.store && want(`store:${s.store}`)) {
        const c = this.d.client;
        const hit = c?.current()?.index.items.find((x) => x.id === s.store && x.kind === 'skill');
        const v = hit?.versions.filter((x) => !x.yanked && satisfies(x.version, s.version!)).sort((a, b) => compareSemver(b.version, a.version))[0];
        if (!c || !hit || !v || !this.d.storeInstalls) {
          out.push({ kind: 'skill', from: 'store', name: s.store, missing: true, line: `She suggests the skill ${s.store}, which isn't available right now.` });
          continue;
        }
        try {
          const r = await new StoreInstaller({ app, client: c, installs: this.d.storeInstalls }).install(s.store, { version: v.version, understand: true, community: hit.trust === 'community' });
          out.push({ kind: 'skill', from: 'store', name: s.store, review: 'review' in r ? r.review : null });
        } catch (err) {
          out.push({ kind: 'skill', from: 'store', name: s.store, missing: true, line: `She suggests the skill ${s.store}, which isn't available right now.`, why: (err as Error).message });
        }
      }
    }
    const catalog = loadCatalog(ROUTINES_DIR);
    for (const r of m.routines) {
      const def = catalog.find((x) => x.id === r.id);
      if (!def) continue;
      if (space && !(MEMBER_ENGINES as readonly string[]).includes(def.engine)) continue;
      out.push({ kind: 'routine', id: r.id, title: def.title, pitch: def.pitch, answers: r.answers ? fillNames(r.answers, app.settings.get().ownerName) : {}, ...(r.why ? { why: r.why } : {}) });
    }
    for (const s of m.suggests) out.push({ kind: 'suggest', store: s.store, ...(s.why ? { why: s.why } : {}) });
    return out;
  }

  /** *Add the held lines* (only with Adult mode on for her; one tap, never by itself). */
  addHeld(companion: string): { added: number } {
    const c = this.d.companions.get(companion);
    if (!c) throw new InstallError(404, 'missing', 'No such companion.');
    if (!adultModeOn(c.app.settings.get())) throw new InstallError(403, 'adult', 'Turn on Adult mode for her first (Settings → You → Adult mode, in a web browser).');
    const f = join(c.app.dataDir, 'pack', 'held.json');
    if (!existsSync(f)) return { added: 0 };
    const held = JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>;
    const p = structuredClone(c.app.persona);
    let added = 0;
    for (const k of SHEET_FIELDS) {
      const lines = (held[k] as string[] | undefined) ?? [];
      const room = 20 - p[k].length;
      p[k] = [...p[k], ...lines.slice(0, Math.max(0, room))];
      added += Math.min(lines.length, Math.max(0, room));
    }
    if (Array.isArray(held.summary)) {
      const s = `${p.summary} ${(held.summary as string[]).join(' ')}`.trim();
      if (s.length <= 1500) {
        p.summary = s;
        added += (held.summary as string[]).length;
      }
    }
    if (held.life) {
      p.life = { ...(p.life ?? {}), ...(held.life as Record<string, string>) };
      added += Object.keys(held.life as object).length;
    }
    if (held.intimacy) {
      p.intimacy = { ...(p.intimacy ?? {}), ...(held.intimacy as Record<string, string>) };
      added += Object.keys(held.intimacy as object).length;
    }
    savePersona(c.app, validatePersona(p));
    rmSync(f, { force: true });
    this.d.installs.setHeld(companion, 0, this.#now().toISOString());
    return { added };
  }

  /** A blocked pack (§11.2): she is paused, with the reason and three ways out. Minors: her pictures go at once. */
  block(companion: string, reason: string, minors: boolean): void {
    const c = this.d.companions.get(companion);
    const at = this.#now().toISOString();
    this.d.installs.setState(companion, 'paused', reason.slice(0, 300), at);
    if (!c) return;
    mkdirSync(join(c.app.dataDir, 'pack'), { recursive: true, mode: 0o700 });
    writeFileSync(join(c.app.dataDir, 'pack', 'paused.json'), json({ reason, minors, at }), { mode: 0o600 });
    if (minors) this.#stripPictures(c.app);
  }
  #stripPictures(app: AppContext): void {
    for (const p of ['look', 'looks', 'look-face.jpg', 'avatar.png', 'look-draft']) rmSync(join(app.dataDir, p), { recursive: true, force: true });
  }
  /** The ways out of a pause: strip (*Remove what the pack added*), keep (*Keep her anyway*, not for minors). */
  resolve(companion: string, how: 'strip' | 'keep'): void {
    const c = this.d.companions.get(companion);
    if (!c) throw new InstallError(404, 'missing', 'No such companion.');
    const f = join(c.app.dataDir, 'pack', 'paused.json');
    const paused = existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as { minors?: boolean }) : undefined;
    if (how === 'keep') {
      if (paused?.minors) throw new InstallError(403, 'minors', "This pack was pulled for describing a minor: it can't be kept.");
      this.#log(`packs: ${companion} kept by the owner after the Sara Store pulled it`);
    } else {
      // Her sheet back to a plain starting sheet with her name; her look to the default. Memories and chats stay.
      const p = c.app.persona;
      savePersona(c.app, validatePersona({ name: p.name, pronouns: p.pronouns, age: p.age, summary: `${p.name} is the owner's companion.`, background: [], personality: ['Warm, honest and curious.'], speech: ['Plain and friendly.'], boundaries: [] }));
      this.#stripPictures(c.app);
      for (const s of c.app.skills?.list().filter((x) => x.scope === 'companion' && String(x.origin ?? '').startsWith('pack:')) ?? []) c.app.skills?.delete(s.scope, s.name);
    }
    rmSync(f, { force: true });
    this.d.installs.setState(companion, how === 'keep' ? 'blocked' : 'ok', null, this.#now().toISOString());
  }
}

const ref0 = (files: PackageFile[]) => files.some((f) => f.path.startsWith('reference/'));

/** True while a companion is paused because her pack was pulled (§11.2): no new turns. */
export function packPaused(dataDir: string): { reason: string; minors: boolean } | undefined {
  const f = join(dataDir, 'pack', 'paused.json');
  if (!existsSync(f)) return undefined;
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as { reason: string; minors: boolean };
  } catch {
    return { reason: '', minors: false };
  }
}

