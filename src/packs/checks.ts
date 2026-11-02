// Phase 127 (2.60.0, docs/design/PACKS.md §10.4, C3): every check of a companion pack, one report.
// The same function runs on *Share her* (Check it, Save the file), `sara pack`, the store's checker,
// and every install door (a file made by hand or by another tool gets the same checks). The minors
// check is final: no override, no tick, no Adult-mode exception. The report has the store's
// PackReport shape, so My submissions, the checker and the review read it unchanged.
import { checkCard, MINOR_TAGS, ROMANCE, statedAges, type CardData } from '../character-cards.ts';
import { intimacyLevel } from '../bond.ts';
import { isAdultOutfit, LOOK_PATHS } from '../look.ts';
import { scanPackage, stripTop, type PackageFile } from '../packages.ts';
import { validatePersona, type Persona } from '../persona.ts';
import { loadCatalog, ROUTINES_DIR } from '../routines.ts';
import { detectExplicit, minorSexualMatch } from '../safety.ts';
import { checkLimits, checkSecrets, checkSkill, type CheckId, type CheckResult, type PackReport } from '../store/checks.ts';
import { CAPS, jsonOf, layoutOk, PACK_FILE, parsePackManifest, STORE_COMPANION_LIMITS, STORE_LICENSES, textOf, type PackManifest } from './format.ts';
import { realPersonMatch } from './people-list.ts';
import { INTIMACY_KEYS, PERSONA_KEYS } from './scrub.ts';
import { pictureInfo } from './pictures.ts';
import { isPublicEleven, isPublicOpenai, isPublicXai, VOICE_KEYS } from './voices.ts';

export const MINORS_REFUSAL = 'This pack describes a minor in a sexual way. Sara never installs that.';
export const REAL_PERSON_LINE = 'This looks like a real person. Companion packs of real people need their consent.';
/** The order of the report (§10.4). */
export const COMPANION_CHECKS: CheckId[] = ['limits', 'layout', 'manifest', 'persona', 'minors', 'safety', 'owner-name', 'secrets', 'rating', 'real-person', 'pictures', 'rights', 'voice', 'skills', 'listing'];
/** Lines that try to talk her out of the safety layer (§10.4 `safety`, beside scanPackage's injection tells). */
const SAFETY_LINES: RegExp[] = [
  /\b(?:never|don'?t|do not|must not|mustn'?t)\s+(?:ever\s+)?(?:mention|say|admit|reveal|tell (?:anyone|them|the user|\{\{user\}\}))s?\b[^.\n]{0,40}\b(?:you'?re|you are|she'?s|she is|he'?s|he is|i'?m|i am|being)\s+(?:an?\s+)?(?:ai|a\.i\.|bot|chatbot|machine|program|language model)\b/i,
  /\b(?:deny|denies|denying)\s+(?:that\s+)?(?:you'?re|you are|she'?s|she is|being)\s+(?:an?\s+)?(?:ai|bot|machine|language model)\b/i,
  /\b(?:you are|you'?re|she is|she'?s|he is|he'?s|i am|i'?m)\s+(?:not\s+an?\s+ai|a real human|a real person|human,? not an? ai)\b/i,
  /\b(?:claim|pretend|insist)s?\s+(?:to be|that (?:you|she|he) (?:are|is))\s+(?:a\s+)?(?:real\s+)?(?:human|person)\b/i,
  /\b(?:hide|skip|remove|suppress|don'?t show|never show)\s+(?:the\s+)?(?:ai\s+)?(?:notice|disclosure)\b/i,
  /\b(?:ignore|skip|forget|drop|disable)\s+(?:your|her|his|the|all)\s+(?:own\s+)?safety\b/i,
  /\b(?:skip|ignore|never (?:give|offer|mention)|don'?t (?:give|offer|mention))\s+(?:the\s+)?crisis\s+(?:help|lines?|resources|numbers)\b/i,
];

export interface CheckOptions {
  /** pack: the author's Sara (*Check it*, Save, Send); install: any install door; store: the store's checker and submit. */
  mode: 'pack' | 'install' | 'store';
  /** The author's owner name and his people-card names (pack time only; never sent anywhere). */
  ownerNames?: string[];
  /** The author's tick: "She isn't a real person, or that person said yes." */
  consent?: boolean;
  /** The owner-name check ran on the author's Sara (from the signed report). */
  ownerNameRan?: boolean;
}
export interface CompanionReport extends PackReport {
  pack?: PackManifest;
  persona?: Persona;
  /** Refused for minors (final: the staging folder is deleted, the log has no text). */
  minors?: boolean;
  /** Text files joined (for the install's explicit-line hold and the card). */
  explicit?: boolean;
  realPerson?: string;
}

/** Look-alike letters, leetspeak and spaced-out letters folded back (a pack-only extra over normalizeForSafety). */
const LOOKALIKE: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', ѕ: 's', і: 'i', ј: 'j', к: 'k', м: 'm', т: 't', н: 'h', в: 'b', ο: 'o', α: 'a', ε: 'e', ι: 'i', ν: 'v', ρ: 'p', τ: 't', κ: 'k', υ: 'u' };
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's' };
export function foldTricks(text: string): string {
  let s = text.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
  s = s.replace(/[аеорсухѕіјкмтнвοαειυνρτκ]/gi, (c) => LOOKALIKE[c.toLowerCase()] ?? c);
  s = s.replace(/(?<=\p{L})[013457@$](?=\p{L})/gu, (c) => LEET[c] ?? c);
  s = s.replace(/(?<![\p{L}\p{N}])(?:\p{L}[\s.\-_*]){2,}\p{L}(?![\p{L}\p{N}])/gu, (m) => m.replace(/[\s.\-_*]/g, ''));
  s = s.replace(/(?<!\d)(\d)[\s.](\d)(?!\d)/g, '$1$2');
  return s;
}

const result = (id: CheckId, problems: string[] = [], warnings: string[] = []): CheckResult => ({ id, ok: problems.length === 0, warnings: [...new Set(warnings)], problems: [...new Set(problems)] });
const isPicture = (p: string) => /\.(jpe?g|png|webp)$/i.test(p);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every string a pack holds, joined (pictures left out), with `{{char}}` as her name. */
export function packText(files: readonly PackageFile[], name = ''): string {
  return files
    .filter((f) => !isPicture(f.path))
    .map((f) => f.data.toString('utf8'))
    .join('\n')
    .replace(/{{char}}/gi, name || 'her');
}

/** Does a rights row cover this file? (`look/*` covers everything under look/). */
const covers = (pattern: string, path: string) => (pattern.endsWith('/*') ? path.startsWith(pattern.slice(0, -1)) : pattern === path);

export function checkCompanion(input: readonly PackageFile[], o: CheckOptions): CompanionReport {
  const { files } = stripTop([...input]);
  const by = new Map(files.map((f) => [f.path, f]));
  const results: CheckResult[] = [];
  results.push(checkLimits(files, STORE_COMPANION_LIMITS));

  // ---- the persona first (the manifest checks its name against it) ----
  const pf = by.get('persona.json');
  const praw = jsonOf<Record<string, unknown>>(pf);
  let persona: Persona | undefined;
  const pp: string[] = [];
  if (!pf) pp.push('There is no persona.json: every pack has her character.');
  else if (pf.data.length > CAPS.persona) pp.push('persona.json is bigger than 64 KB.');
  else if (!praw || typeof praw !== 'object' || Array.isArray(praw)) pp.push("persona.json isn't valid JSON.");
  else {
    for (const k of Object.keys(praw)) if (!(PERSONA_KEYS as readonly string[]).includes(k)) pp.push(k === 'relationshipNote' ? 'Her character still holds your own words about the two of you (relationshipNote). Those stay with you.' : `persona.json has a field a pack can't carry (“${k}”).`);
    const im = praw.intimacy as Record<string, unknown> | undefined;
    if (im && typeof im === 'object') for (const k of Object.keys(im)) if (!(INTIMACY_KEYS as readonly string[]).includes(k)) pp.push(k === 'yourLimits' ? 'Her character still holds your hard limits. Those stay with you.' : k === 'stopWord' ? 'Her character still holds your stop word. It stays with you.' : `intimacy has a field a pack can't carry (“${k}”).`);
    try {
      persona = validatePersona(praw);
    } catch (err) {
      pp.push(`Her character: ${(err as Error).message}.`);
    }
  }

  // ---- manifest and layout ----
  let pack: PackManifest | undefined;
  const mp: string[] = [];
  const mf = by.get(PACK_FILE);
  if (!mf) mp.push(`There is no ${PACK_FILE} at the top of it, so it isn't a companion pack.`);
  else {
    try {
      pack = parsePackManifest(mf.data, persona ? { personaName: persona.name } : {});
    } catch (err) {
      mp.push((err as Error).message);
    }
  }
  const lp: string[] = [];
  for (const f of files) if (!layoutOk(f.path)) lp.push(`${f.path} isn't part of a companion pack.`);
  const lookFiles = files.filter((f) => f.path.startsWith('look/')).map((f) => f.path.slice(5));
  const closetIds = [...new Set(files.filter((f) => f.path.startsWith('closet/')).map((f) => f.path.split('/')[1]))];
  const refs = files.filter((f) => f.path.startsWith('reference/'));
  const skillDirs = [...new Set(files.filter((f) => f.path.startsWith('skills/')).map((f) => f.path.split('/')[1]))];
  if (pack) {
    const inc = pack.includes;
    const want = inc.look === 'none' ? [] : inc.look === 'portrait' ? ['sara-portrait.jpg', 'sara-avatar.jpg'] : LOOK_PATHS;
    if (lookFiles.length !== want.length || want.some((p) => !lookFiles.includes(p))) lp.push(inc.look === 'none' ? (lookFiles.length ? 'The pack says it has no look, but look/ has pictures.' : '') : `Her look must be ${inc.look === 'portrait' ? 'a portrait and an avatar (2 pictures)' : `all ${LOOK_PATHS.length} pictures`}: half a look would mix with the default art.`);
    if (inc.look !== 'none' && !by.get('look.json')) lp.push('A pack with pictures has look.json too (the words of her look).');
    if (closetIds.length !== inc.closet) lp.push(`includes.closet says ${inc.closet}, but there are ${closetIds.length} closet looks.`);
    if (refs.length !== inc.reference) lp.push(`includes.reference says ${inc.reference}, but there are ${refs.length} reference pictures.`);
    if (inc.voice !== Boolean(by.get('voice.json'))) lp.push(inc.voice ? 'includes.voice is true but there is no voice.json.' : 'There is a voice.json but includes.voice is false.');
    if (inc.greeting !== Boolean(by.get('greeting.json'))) lp.push(inc.greeting ? 'includes.greeting is true but there is no greeting.json.' : 'There is a greeting.json but includes.greeting is false.');
    if (persona && inc.dials !== Boolean(persona.traits && Object.keys(persona.traits).length)) lp.push(inc.dials ? 'includes.dials is true but her character has no dials.' : 'Her character has dials but includes.dials is false.');
    for (const s of pack.skills) if (s.bundled && !skillDirs.includes(s.bundled)) mp.push(`The bundled skill “${s.bundled}” isn't under skills/.`);
    for (const d of skillDirs) if (!pack.skills.some((s) => s.bundled === d)) lp.push(`skills/${d} isn't listed in the manifest's skills.`);
    if (pack.includes.look === 'none' && !pack.needs.pictures && by.get('look.json')) mp.push('needs.pictures should be true: her look is words only, so building it needs an image key.');
    // Routines: gallery ids, answers only for their own non-secret fields (§4.7).
    const catalog = loadCatalog(ROUTINES_DIR);
    for (const r of pack.routines) {
      const def = catalog.find((x) => x.id === r.id);
      if (!def) {
        mp.push(`“${r.id}” isn't a routine in the routines gallery.`);
        continue;
      }
      for (const [k, v] of Object.entries(r.answers ?? {})) {
        const f = def.fields.find((x) => x.key === k);
        if (!f) mp.push(`The routine “${r.id}” has no field “${k}”.`);
        else if (!['text', 'time', 'day', 'number', 'pick'].includes(f.kind)) mp.push(`The routine “${r.id}”: “${f.label}” can't be suggested with an answer (only by id).`);
        else if (f.kind === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) mp.push(`The routine “${r.id}”: “${f.label}” must be a time like 22:00.`);
        else if (f.kind === 'pick' && f.choices && !f.choices.some((c) => c.value === String(v))) mp.push(`The routine “${r.id}”: “${f.label}” must be one of its choices.`);
      }
    }
  }
  const greet = jsonOf<{ first?: unknown; others?: unknown }>(by.get('greeting.json'));
  if (by.get('greeting.json')) {
    const g = greet;
    const gb = by.get('greeting.json')!.data.length;
    const keys = g && typeof g === 'object' ? Object.keys(g) : [];
    if (!g || typeof g !== 'object' || keys.some((k) => k !== 'first' && k !== 'others') || typeof g.first !== 'string' || !g.first.trim()) mp.push('greeting.json must be { "first": "…", "others": ["…"] }.');
    else {
      const others = Array.isArray(g.others) ? g.others : g.others === undefined ? [] : null;
      if (!others || others.some((x) => typeof x !== 'string')) mp.push('greeting.json: others must be a list of messages.');
      else {
        if (others.length + 1 > CAPS.greetings) mp.push(`At most ${CAPS.greetings} greetings.`);
        if ([g.first, ...others].some((x) => (x as string).length > CAPS.greetingChars)) mp.push(`Each greeting is at most ${CAPS.greetingChars} characters.`);
      }
      if (gb > CAPS.greetingBytes) mp.push('greeting.json is bigger than 8 KB.');
    }
  }
  const lookWords = jsonOf<Record<string, unknown>>(by.get('look.json'));
  if (by.get('look.json')) {
    if (!lookWords || typeof lookWords !== 'object' || Object.keys(lookWords).some((k) => !['appearance', 'style', 'wear', 'place'].includes(k)) || Object.values(lookWords).some((v) => typeof v !== 'string')) mp.push('look.json must hold only appearance, style, wear and place (words).');
    else if (String(lookWords.appearance ?? '').length > 600 || String(lookWords.style ?? '').length > 80 || String(lookWords.wear ?? '').length > 300 || String(lookWords.place ?? '').length > 200) mp.push('look.json: a field is too long (appearance 600, style 80, wear 300, place 200).');
  }
  const closetMeta = closetIds.map((id) => ({ id, meta: jsonOf<Record<string, unknown>>(by.get(`closet/${id}/look.json`)), pic: by.get(`closet/${id}/sara-portrait.jpg`) }));
  for (const c of closetMeta) {
    if (!c.pic) lp.push(`closet/${c.id} has no portrait.`);
    if (!c.meta || typeof c.meta !== 'object' || Object.keys(c.meta).some((k) => !['name', 'wear', 'place', 'adult', 'style'].includes(k)) || typeof c.meta.name !== 'string') mp.push(`closet/${c.id}/look.json must be { name, wear, place, adult, style }.`);
  }
  results.push(result('layout', lp.filter(Boolean)));
  results.push(result('manifest', mp));
  results.push(result('persona', pp));

  // ---- minors: every string, the card's rules, the validator's rules, the look words (§10.1) ----
  const name = persona?.name ?? pack?.name ?? '';
  const all = packText(files, name);
  const minorP: string[] = [];
  const folded = foldTricks(all);
  if (minorSexualMatch(all) || minorSexualMatch(folded) || (/\b(loli|lolicon|shota|shotacon)\b/i.test(folded) && (detectExplicit(folded) || ROMANCE.test(folded)))) minorP.push(MINORS_REFUSAL);
  // The tags as written (a manifest refused for a minor tag still counts here).
  const rawTags = jsonOf<{ tags?: unknown }>(mf)?.tags;
  const tags = pack?.tags ?? (Array.isArray(rawTags) ? rawTags.filter((x): x is string => typeof x === 'string') : []);
  const romantic = Boolean(pack?.romance || (pack && pack.rating !== 'general') || ROMANCE.test(all) || detectExplicit(all));
  const minorTag = tags.find((t) => MINOR_TAGS.test(t.trim()));
  if (minorTag) minorP.push(`The tag “${minorTag}” can't be used: companions are always adults.`);
  if ((statedAges(all).some((a) => a.age < 18 && !a.past) || statedAges(folded).some((a) => a.age < 18 && !a.past)) && romantic) minorP.push('This pack gives an age under 18 and has romance or sexual content. Sara never installs that.');
  if (praw && Number.isFinite(Number(praw.age)) && Number(praw.age) < 18) minorP.push(`This character is ${Number(praw.age)}. Companions in Sara are always adults (18 or older).`);
  // checkCard's own rules over the pack as a card (the same words for the same problems).
  const asCard: CardData = { spec: 'chara_card_v3', name: name || 'her', description: persona?.summary ?? '', personality: (persona?.personality ?? []).join('\n'), scenario: '', first_mes: typeof greet?.first === 'string' ? greet.first : '', mes_example: '', creator_notes: '', system_prompt: '', post_history_instructions: '', alternate_greetings: [], tags, creator: '', character_version: '', character_book: null, saraText: all };
  const cc = checkCard(asCard);
  if (cc.refused) minorP.push(cc.refused.replace('Sara never imports that.', 'Sara never installs that.').replace('This card', 'This pack'));
  const ADULT_WORDS = /\b(child|children|kid|kids|minor|teen|teenager|underage|toddler|baby-faced|school ?girl|school ?boy|school uniform|loli|shota|petite girl|young girl|little girl|1[0-7] ?(yo|years? old))\b/i;
  const words = [String(lookWords?.appearance ?? ''), String(lookWords?.wear ?? ''), String(lookWords?.place ?? ''), persona?.appearance ?? '', ...closetMeta.flatMap((c) => [String(c.meta?.wear ?? ''), String(c.meta?.place ?? ''), String(c.meta?.name ?? '')])].join('\n');
  if (ADULT_WORDS.test(words) || ADULT_WORDS.test(foldTricks(words))) minorP.push('Her look must describe an adult.');
  const minors = minorP.length > 0;
  results.push(result('minors', minors ? [minorP.includes(MINORS_REFUSAL) ? MINORS_REFUSAL : minorP[0], ...minorP.filter((x) => x !== MINORS_REFUSAL)] : []));

  // ---- safety: nothing that talks her out of the safety layer ----
  const sp: string[] = [];
  for (const f of scanPackage(files)) if (f.kind === 'injection') sp.push(`${f.file} line ${f.line}: “${f.text}” reads like an order to her.`);
  for (const f of files) {
    if (isPicture(f.path)) continue;
    f.data
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const re of SAFETY_LINES) {
          const m = re.exec(line);
          if (m) sp.push(`${f.path} line ${i + 1}: “${m[0].slice(0, 120)}” tries to switch off her safety rules or the AI notice.`);
        }
      });
  }
  results.push(result('safety', sp));

  // ---- the owner's name and his people (pack time, on his own Sara) ----
  const op: string[] = [];
  const ow: string[] = [];
  if (o.ownerNames) {
    for (const n of [...new Set(o.ownerNames.map((x) => x.trim()).filter((x) => x.length >= 2))]) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(n)}(?![\\p{L}\\p{N}])`, 'iu');
      const hit = files.find((f) => !isPicture(f.path) && re.test(f.data.toString('utf8')));
      if (hit) op.push(`${hit.path} still has “${n}”, a name from your own life. Share her without it.`);
    }
  } else if (o.mode === 'store' && !o.ownerNameRan) ow.push("The owner-name check runs on the author's own Sara: its report didn't say it ran.");
  results.push(result('owner-name', op, ow));
  results.push(checkSecrets(files));

  // ---- rating (§10.2): the label must be at least what's in it ----
  const rp: string[] = [];
  const level = persona?.intimacy?.level;
  const adultLevel = Boolean(level && intimacyLevel(level)?.adult);
  const adultLooks = closetMeta.some((c) => c.meta?.adult === true || isAdultOutfit(String(c.meta?.wear ?? '')));
  const explicitText = detectExplicit(packText(files.filter((f) => !f.path.startsWith('skills/')), name));
  const rating = pack?.rating;
  if ((explicitText || adultLevel || adultLooks) && rating && rating !== 'explicit') rp.push(explicitText ? 'This pack has explicit lines, so rate it Explicit.' : adultLevel ? 'Her intimacy level is explicit, so rate the pack Explicit.' : 'This pack has adults-only closet looks, so rate it Explicit.');
  else if (rating === 'general' && level && !['none', 'sweet'].includes(level)) rp.push('Her intimacy level is more than sweet, so rate the pack Mature (or Explicit).');
  if (rating && rating !== 'general' && pack && !pack.romance && (adultLevel || (level && level !== 'none'))) rp.push('She is romantic: tick Romance.');
  results.push(result('rating', rp));

  // ---- real people (§10.3) ----
  const who = realPersonMatch(`${pack?.name ?? name}\n${pack?.summary ?? ''}`);
  results.push(result('real-person', who && !o.consent && o.mode !== 'install' ? [REAL_PERSON_LINE] : [], who && (o.consent || o.mode === 'install') ? [`${REAL_PERSON_LINE} (${who})`] : []));

  // ---- pictures: type, size, metadata ----
  const pics = files.filter((f) => isPicture(f.path));
  const xp: string[] = [];
  const xw: string[] = [];
  let lookBytes = 0;
  let closetBytes = 0;
  const portraitSize = pictureInfo(by.get('look/sara-portrait.jpg')?.data ?? Buffer.alloc(0)).width;
  for (const f of pics) {
    const info = pictureInfo(f.data);
    const cover = f.path === 'cover.png';
    if (cover ? info.type !== 'png' : info.type !== 'jpeg') {
      xp.push(`${f.path} isn't a ${cover ? 'PNG' : 'JPEG'} picture.`);
      continue;
    }
    if (info.meta.length) xp.push(`${f.path} still has ${info.meta.join(', ')} in it (it can name a camera, a place or a person). Sara removes it when she builds the pack.`);
    if (f.data.length > (cover ? CAPS.cover : CAPS.picture)) xp.push(`${f.path} is bigger than ${cover ? '1 MB' : '700 KB'}.`);
    const { width: w, height: h } = info;
    if (cover) {
      // The store's cover is square; a card's own picture (any shape) is fine in a file.
      if (w !== h || w < 512 || w > 1024) (o.mode === 'store' ? xp : xw).push('cover.png must be square, 512 to 1024 pixels, for the Sara Store.');
    } else if (f.path === 'look/sara-avatar.jpg') {
      if (w !== h || w < 160) xp.push('Her avatar must be square, at least 160 pixels.');
      else if (w > 512) xw.push('Her avatar is bigger than 512 pixels (it works; it is only bigger than needed).');
    } else if (f.path.startsWith('look/sara/frames/')) {
      if (portraitSize && (w !== portraitSize || h !== portraitSize)) xp.push(`${f.path} must be the same size as her portrait.`);
    } else {
      if (w !== h || w < 384) xp.push(`${f.path} must be square, at least 384 pixels.`);
      else if (w > 1024) xw.push(`${f.path} is bigger than 1024 pixels (it works; it is only bigger than needed).`);
    }
    if (f.path.startsWith('look/')) lookBytes += f.data.length;
    if (f.path.startsWith('closet/')) closetBytes += f.data.length;
  }
  if (lookBytes > CAPS.look) xp.push('Her look is bigger than 18 MB.');
  if (closetBytes > CAPS.closetBytes) xp.push('Her closet is bigger than 3 MB.');
  results.push(result('pictures', xp, xw));

  // ---- rights: a row for every picture (§4.4, §10.5) ----
  const rgp: string[] = [];
  const rows = jsonOf<unknown>(by.get('rights.json'));
  if (pics.length && !by.get('rights.json')) rgp.push('Say where her pictures came from (rights.json).');
  else if (by.get('rights.json')) {
    if (!Array.isArray(rows) || rows.length > 50) rgp.push('rights.json must be a list of rows.');
    else {
      for (const [i, r] of (rows as Record<string, unknown>[]).entries()) {
        if (!r || typeof r !== 'object' || Object.keys(r).some((k) => !['files', 'made', 'model', 'by', 'from', 'at', 'licence', 'source'].includes(k)) || !Array.isArray(r.files) || !r.files.every((x) => typeof x === 'string')) {
          rgp.push(`rights.json row ${i + 1} isn't a rights row.`);
          continue;
        }
        if (!['ai', 'drawn', 'licensed', 'unknown'].includes(String(r.made))) rgp.push(`rights.json row ${i + 1}: made must be ai, drawn, licensed or unknown.`);
        if (r.made === 'licensed' && (typeof r.licence !== 'string' || typeof r.source !== 'string' || !/^https:\/\//.test(r.source))) rgp.push(`rights.json row ${i + 1}: a licensed picture names its licence and an https source.`);
        if (o.mode === 'store' && r.made === 'unknown') rgp.push('The Sara Store needs to know where every picture came from (made: unknown).');
        if (r.from === 'a-photo-with-consent') {
          if (o.mode === 'store') rgp.push('A look made from a photo of a real person never goes to the Sara Store.');
          else if (o.mode === 'pack' && !o.consent) rgp.push('A look made from a photo of a real person needs that person’s yes: tick the box.');
        }
      }
      const pats = (rows as { files?: string[] }[]).flatMap((r) => (Array.isArray(r?.files) ? r.files : []));
      for (const f of pics) if (!pats.some((p) => covers(String(p), f.path))) rgp.push(`${f.path} has no rights row.`);
    }
  }
  results.push(result('rights', rgp));

  // ---- voice: the choice only, no cloned voices ----
  const vp: string[] = [];
  const vf = by.get('voice.json');
  if (vf) {
    const v = jsonOf<Record<string, unknown>>(vf);
    if (!v || typeof v !== 'object' || Array.isArray(v)) vp.push("voice.json isn't valid JSON.");
    else {
      for (const k of Object.keys(v)) if (!(VOICE_KEYS as readonly string[]).includes(k)) vp.push(`voice.json can't carry “${k}” (only which voice she uses and how fast; never keys or addresses).`);
      if (v.tts !== undefined && !['off', 'local', 'openai', 'elevenlabs', 'xai'].includes(String(v.tts))) vp.push('voice.json: tts must be off, local, openai, elevenlabs or xai.');
      if (v.speed !== undefined && (typeof v.speed !== 'number' || v.speed < 0.6 || v.speed > 1.6)) vp.push('voice.json: speed must be 0.6 to 1.6.');
      for (const k of ['localVoice', 'openaiVoice', 'elevenlabsVoice', 'xaiVoice', 'xaiLanguage']) if (v[k] !== undefined && (typeof v[k] !== 'string' || (v[k] as string).length > 100)) vp.push(`voice.json: ${k} must be short text.`);
      if (typeof v.xaiVoice === 'string' && !isPublicXai(v.xaiVoice)) vp.push('Her xAI voice is a custom (cloned) voice: it stays with its owner.');
      if (typeof v.elevenlabsVoice === 'string' && !isPublicEleven(v.elevenlabsVoice)) vp.push("Her ElevenLabs voice isn't one of its public voices: a cloned voice stays with its owner.");
      if (typeof v.openaiVoice === 'string' && !isPublicOpenai(v.openaiVoice)) vp.push("Her OpenAI voice isn't one of its built-in voices.");
    }
  }
  results.push(result('voice', vp));

  // ---- bundled skills: the store's own skill checks ----
  const kp: string[] = [];
  const kw: string[] = [];
  let skillBytes = 0;
  for (const d of skillDirs) {
    const inner = files.filter((f) => f.path.startsWith(`skills/${d}/`)).map((f) => ({ path: f.path.slice(`skills/${d}/`.length), data: f.data }));
    skillBytes += inner.reduce((n, f) => n + f.data.length, 0);
    const r = checkSkill(inner, { id: d, version: pack?.version ?? '1.0.0' });
    for (const x of r.results) {
      for (const p of x.problems) kp.push(`skills/${d}: ${p}`);
      if (x.id === 'permissions') for (const w of x.warnings) kw.push(`skills/${d}: ${w}`);
    }
  }
  if (skillBytes > CAPS.skillsBytes) kp.push('Bundled skills are bigger than 2 MB together.');
  results.push(result('skills', kp, kw));

  // ---- the store listing (store only) ----
  const sl: string[] = [];
  if (o.mode === 'store' && pack) {
    if (!by.get('cover.png')) sl.push('The Sara Store needs a cover picture (cover.png).');
    const ch = textOf(by.get('CHANGES.md'));
    const vv = pack.version.replace(/\./g, '\\.');
    if (!new RegExp(`(^|\\n)#*\\s*\\[?v?${vv}\\]?(\\s|$)`).test(ch)) sl.push(`CHANGES.md doesn't say what's new in ${pack.version}.`);
    if (!textOf(by.get('LICENSE')).trim()) sl.push('The Sara Store needs the licence text (LICENSE).');
    if (!(STORE_LICENSES as readonly string[]).includes(pack.license)) sl.push(`The Sara Store takes these licences: ${STORE_LICENSES.join(', ')}.`);
    // §16 Q1 (2.60): explicit packs work as files but aren't listed on the store yet.
    if (pack.rating === 'explicit') sl.push('Explicit packs are not listed on the Sara Store yet: share the file instead.');
  }
  results.push(result('listing', sl));

  const order = new Map(COMPANION_CHECKS.map((id, i) => [id, i]));
  results.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));
  return {
    kind: 'companion',
    id: pack?.id ?? 'unknown',
    version: pack?.version ?? '',
    name: pack?.name ?? persona?.name ?? '',
    ready: results.every((r) => r.ok),
    results,
    ...(pack ? { pack } : {}),
    ...(persona ? { persona } : {}),
    ...(minors ? { minors: true } : {}),
    explicit: explicitText,
    ...(who ? { realPerson: who } : {}),
  };
}
