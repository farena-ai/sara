// Phase 127 (2.60.0, docs/design/PACKS.md §7, C4): a Character Card (V1/V2/V3, PNG or JSON, or a V3
// CHARX zip) or a Sara character file becomes the same kind of pack, through the existing card
// reader and its minors refusals (same words), and then the pack's own checks. The conversion keeps
// explicit lines (`adultOn: true`); the install decides (held aside while Adult mode is off). The
// lorebook becomes at most 10 background lines, never memories. Remote asset URIs are never fetched:
// nothing here touches the network.
import { CardError, cardToCharacter, isPng, parseCardFile, readCard, readPngChunks, safeJson, type CardData } from '../character-cards.ts';
import { CHARACTER_FORMAT, parseCharacter } from '../characterfile.ts';
import { LOOK_PATHS } from '../look.ts';
import { fromZip, stripTop, type PackageFile } from '../packages.ts';
import type { Persona } from '../persona.ts';
import { compareSemver, parseSemver } from '../plugins/manifest.ts';
import { detectExplicit } from '../safety.ts';
import { idFrom, PACK_FILE, PACK_FORMAT, STORE_COMPANION_LIMITS, type PackManifest } from './format.ts';
import { stripMeta } from './pictures.ts';
import { scrubPersona } from './scrub.ts';
import { shareableVoice } from './voices.ts';

export const MAX_LORE_LINES = 10;
export interface CardPack {
  files: PackageFile[];
  notes: string[];
  /** Where it came from, for the card's strip: "Character Card V3", "Character Card V2", "a Sara character file". */
  source: string;
  creator: string;
  lore: { total: number; kept: number };
}

const json = (v: unknown) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const isZip = (b: Buffer) => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const SPEC_WORDS: Record<CardData['spec'], string> = { chara_card_v1: 'Character Card V1', chara_card_v2: 'Character Card V2', chara_card_v3: 'Character Card V3' };
/** Only these are kept from a card picture: the pixels (text chunks like `chara` and EXIF go). */
const pngPicture = (png: Buffer): Buffer | undefined => {
  try {
    readPngChunks(png);
    return stripMeta(png);
  } catch {
    return undefined;
  }
};

/** {{char}} becomes her name; {{user}} stays (the install fills it with the new owner's name). */
const keepUser = (t: string, name: string) => t.replace(/{{char}}|<BOT>|<CHAR>/gi, name).replace(/<USER>/gi, '{{user}}');

function manifestFor(p: Persona, o: { creator: string; version: string; tags: string[]; nsfw: boolean; romance: boolean; greeting: boolean; picture: boolean }): PackManifest {
  const summary = p.summary.length >= 20 ? p.summary.slice(0, 157).replace(/\s+\S*$/, '').concat(p.summary.length > 160 ? '…' : '') : `${p.summary} A character from a card.`.slice(0, 160);
  return {
    format: PACK_FORMAT,
    v: 1,
    id: idFrom(p.name),
    version: parseSemver(o.version) && compareSemver(o.version, '0.0.0') >= 0 ? o.version : '1.0.0',
    sara: '>=2.60.0',
    name: p.name,
    summary: summary.length >= 20 ? summary : `${p.name}, a character from a character card.`,
    author: { name: (o.creator.replace(/@|https?:\/\/\S*|www\.\S*/gi, '').trim() || 'Unknown').slice(0, 60) },
    license: 'unknown',
    remix: 'ask',
    rating: o.nsfw ? 'explicit' : 'general',
    romance: o.nsfw || o.romance,
    language: 'en',
    tags: [...new Set(o.tags.map((t) => t.trim().slice(0, 24)).filter(Boolean))].slice(0, 8),
    includes: { persona: true, dials: Boolean(p.traits && Object.keys(p.traits).length), look: 'none', closet: 0, reference: 0, voice: false, greeting: o.greeting },
    skills: [],
    routines: [],
    suggests: [],
    needs: { pictures: false, voices: [] },
    made: { with: 'a character card' },
  };
}

/** A card (already read) → pack files. Throws CardError with the card reader's own words. */
export function cardDataToPack(card: CardData, picture: Buffer | undefined, source = SPEC_WORDS[card.spec]): CardPack {
  // The existing reader's minors and age refusals, same words (cardToCharacter runs checkCard first).
  const imp = cardToCharacter(card, { adultOn: true, ownerName: '{{user}}' });
  const notes = imp.notes.filter((n) => !/Adult mode/.test(n));
  const { persona: sheet } = scrubPersona(imp.persona, undefined);
  // §7.3: the lorebook as at most 10 background lines (keys: content), within the 20-line cap.
  const room = Math.max(0, Math.min(MAX_LORE_LINES, 20 - sheet.background.length));
  const total = card.character_book?.entries.length ?? 0;
  const loreLines = imp.lore.slice(0, room).map((e) => `${e.keys.length ? `${e.keys.slice(0, 4).join(', ')}: ` : e.name ? `${e.name}: ` : ''}${e.content.replace(/\s+/g, ' ')}`.slice(0, 400));
  sheet.background = [...sheet.background, ...loreLines];
  if (total > loreLines.length) notes.push(`Only ${loreLines.length} of ${total} lorebook entries became part of her background.`);
  else if (total) notes.push(`Her ${total} lorebook ${total === 1 ? 'entry is' : 'entries are'} part of her background now (never memories).`);
  const files: PackageFile[] = [{ path: 'persona.json', data: json(sheet) }];
  const first = keepUser(card.first_mes, sheet.name).trim();
  const others = card.alternate_greetings.map((g) => keepUser(g, sheet.name).trim()).filter(Boolean).slice(0, 5);
  if (first) files.push({ path: 'greeting.json', data: json({ first: first.slice(0, 1200), others: others.map((x) => x.slice(0, 1200)) }) });
  if (card.alternate_greetings.length > 5) notes.push(`Only 5 of ${card.alternate_greetings.length} other greetings came along.`);
  let pic = picture ? pngPicture(picture) : undefined;
  if (pic && pic.length > STORE_COMPANION_LIMITS.maxFileBytes) {
    notes.push("The card's picture is too big for a pack (over 2 MB), so she arrives without it.");
    pic = undefined;
  }
  if (pic) {
    files.push({ path: 'cover.png', data: pic });
    files.push({ path: 'rights.json', data: json([{ files: ['cover.png'], made: 'unknown', from: 'a character card', by: card.creator || 'unknown' }]) });
  }
  const text = [card.description, card.personality, card.scenario, card.first_mes, ...card.alternate_greetings, card.mes_example].join('\n');
  const m = manifestFor(sheet, { creator: card.creator, version: card.character_version, tags: card.tags.filter((t) => !/^(nsfw|sfw|explicit|smut|lewd|18\+)$/i.test(t)), nsfw: imp.check.nsfw || detectExplicit(text), romance: /\b(romance|romantic|girlfriend|boyfriend|lover|flirt\w*|kiss\w*|dating|in love)\b/i.test(text), greeting: Boolean(first), picture: Boolean(pic) });
  files.push({ path: PACK_FILE, data: json(m) });
  notes.push('A pack made from a character card can be added from the file; to send it to the Sara Store, its author first says where the picture came from and picks a licence.');
  return { files, notes: [...new Set(notes)], source, creator: card.creator, lore: { total, kept: loreLines.length } };
}

/** A Sara character file (another Sara's export) → pack files. */
function characterFileToPack(raw: unknown): CardPack {
  const c = parseCharacter(raw);
  const { persona } = scrubPersona(c.persona, undefined);
  const files: PackageFile[] = [{ path: 'persona.json', data: json(persona) }];
  let look: PackManifest['includes']['look'] = 'none';
  if (c.look) {
    const full = LOOK_PATHS.every((p) => c.look![p]);
    const keep = full ? LOOK_PATHS : ['sara-portrait.jpg', 'sara-avatar.jpg'];
    const jpeg = Object.values(c.look).every((b) => b[0] === 0xff && b[1] === 0xd8);
    if (jpeg) {
      look = full ? 'full' : 'portrait';
      for (const p of keep) files.push({ path: `look/${p}`, data: stripMeta(c.look[p] ?? c.look['sara-portrait.jpg']) });
      files.push({ path: 'look.json', data: json(persona.appearance ? { appearance: persona.appearance } : {}) });
      files.push({ path: 'rights.json', data: json([{ files: ['look/*'], made: 'unknown', from: 'a Sara character file', by: 'unknown' }]) });
    }
  }
  if (c.voice) files.push({ path: 'voice.json', data: json(shareableVoice(c.voice).voice) });
  const m = manifestFor(persona, { creator: '', version: '1.0.0', tags: [], nsfw: Boolean(persona.intimacy?.level && ['explicit', 'full'].includes(persona.intimacy.level)), romance: Boolean(persona.intimacy?.level && persona.intimacy.level !== 'none'), greeting: false, picture: false });
  m.includes.look = look;
  m.includes.voice = Boolean(c.voice);
  m.made = { with: 'a Sara character file' };
  if (look === 'none' && persona.appearance) {
    files.push({ path: 'look.json', data: json({ appearance: persona.appearance }) });
    m.needs.pictures = true;
  }
  files.push({ path: PACK_FILE, data: json(m) });
  return { files, notes: ['Made from a Sara character file.'], source: 'a Sara character file', creator: '', lore: { total: 0, kept: 0 } };
}

/**
 * Any file the *From a file* picker takes, as pack files: a pack zip (returned as is), a CHARX zip, a
 * card PNG or JSON, or a Sara character file. Throws CardError / PackageError with plain words.
 */
export function fileToPack(buf: Buffer): CardPack & { pack: boolean } {
  if (isZip(buf)) {
    const files = stripTop(fromZip(buf, STORE_COMPANION_LIMITS)).files;
    if (files.some((f) => f.path === PACK_FILE)) return { files, notes: [], source: 'pack', creator: '', lore: { total: 0, kept: 0 }, pack: true };
    const cj = files.find((f) => f.path === 'card.json');
    if (!cj) throw new CardError("This zip isn't a companion pack or a character card (CHARX).");
    const card = readCard(safeJson(cj.data.toString('utf8')));
    // CHARX: the main icon asset (embedded, never a remote URI) is her picture.
    const icon = files.find((f) => /^assets\/(?:icon|main)\/[^/]+\.png$/i.test(f.path) && isPng(f.data)) ?? files.find((f) => /^assets\/.*\.png$/i.test(f.path) && isPng(f.data));
    const out = cardDataToPack(card, icon?.data, 'Character Card V3 (CHARX)');
    if (files.some((f) => /^assets\/(?:emotion|expression)s?\//i.test(f.path))) out.notes.push("The card's expression pictures stay out: her expressions come with a full look (Make her look can build one).");
    return { ...out, pack: false };
  }
  if (isPng(buf)) {
    const { card, png, placeholder } = parseCardFile(buf);
    return { ...cardDataToPack(card, placeholder ? undefined : png), pack: false };
  }
  let raw: unknown;
  try {
    raw = safeJson(buf.toString('utf8').replace(/^\uFEFF/, ''));
  } catch {
    throw new CardError("This file isn't a companion pack, a character card or a Sara character file.");
  }
  if (raw && typeof raw === 'object' && (raw as { format?: unknown }).format === CHARACTER_FORMAT) {
    try {
      return { ...characterFileToPack(raw), pack: false };
    } catch (err) {
      throw new CardError((err as Error).message);
    }
  }
  if (raw && typeof raw === 'object' && (raw as { format?: unknown }).format === PACK_FORMAT) throw new CardError(`That's only the pack's ${PACK_FILE}: choose the whole .sara-companion.zip.`);
  const { card } = parseCardFile(buf);
  return { ...cardDataToPack(card, undefined), pack: false };
}
