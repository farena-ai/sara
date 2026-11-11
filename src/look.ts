// "Make it yours": the companion's look. The owner describes a look (or uses a photo they uploaded)
// and xAI Grok Imagine makes the full set the app uses: portrait, happy/caring/sleepy expressions,
// and blink + talk frames for each (for the animated portrait). Built in a scratch folder and swapped
// in only when every picture succeeded, so a failure never leaves a half-made look.
// Files live in <data>/look/ with the same relative paths as the built-in art in web/, and the
// server serves them in place of the built-in art for the signed-in owner.
import { netFetch } from './net-guard.ts';
import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';
import { dirname, join } from 'node:path';

export const EXPRESSIONS = ['default', 'happy', 'caring', 'sleepy', 'hurt', 'playful'] as const;
export type Expression = (typeof EXPRESSIONS)[number];
/** Phase 36: expressions added later; a look made before them shows the nearest older one. */
export const EXPRESSION_FALLBACK: Partial<Record<Expression, Expression>> = { hurt: 'caring', playful: 'happy' };

/** Built-in art paths (relative to web/) that a custom look replaces. */
/** Mouth shapes besides the closed face: "ah" (talk), rounded "oo" and wide "ee" (Phase 11), half-open (Phase 27). */
export const MOUTHS = ['talk', 'oo', 'ee', 'half'] as const;
export const LOOK_PATHS = ['sara-portrait.jpg', 'sara-avatar.jpg', ...EXPRESSIONS.slice(1).map((x) => `sara/portrait-${x}.jpg`), ...EXPRESSIONS.flatMap((x) => [`sara/frames/${x}-blink.jpg`, ...MOUTHS.map((m) => `sara/frames/${x}-${m}.jpg`)])];

export const LOOK_STYLES: Record<string, string> = {
  illustrated: 'warm painterly digital illustration, soft brush texture',
  photo: 'realistic photograph, natural skin texture, shallow depth of field',
  anime: 'clean anime illustration, expressive eyes, soft cel shading',
  '3d': 'stylized 3D animated film character, soft lighting',
};

const KEEP = 'Edit this exact picture. Keep everything identical: the same person, face, features, hair, clothes, pose, head position, framing, background, lighting, colors and art style.';
const EXPRESSION_EDIT: Record<Exclude<Expression, 'default'>, string> = {
  happy: `${KEEP} Only change the expression: a genuine happy smile, laughing a little, eyes bright.`,
  caring: `${KEEP} Only change the expression: gentle, warm and caring, a little concerned, soft eyes.`,
  sleepy: `${KEEP} Only change: sleepy and cozy, heavy relaxed eyelids, as if late at night; the room light a little dimmer and warmer.`,
  hurt: `${KEEP} Only change the expression: a little hurt and sad, eyes slightly lowered, a small unhappy pout, not crying.`,
  playful: `${KEEP} Only change the expression: playful and teasing, a mischievous half-smile, one eyebrow slightly raised, a sparkle in the eyes.`,
};
const BLINK = `${KEEP} Only change: the eyes are gently closed mid-blink, relaxed eyelids. Nothing else changes.`;
const MOUTH_ONLY = `${KEEP} Keep the eyes, eyelids, eyebrows and cheeks exactly as they are, and keep the same mood. Only the mouth moves:`;
export const MOUTH_EDIT: Record<(typeof MOUTHS)[number], string> = {
  talk: `${MOUTH_ONLY} change it to a natural mid-word speaking shape, as if saying "ah" in the middle of a sentence, in the same mood as before. Nothing else changes.`,
  oo: `${MOUTH_ONLY} lips gently rounded and a little pushed forward, slightly open, as if saying "oo" in the middle of a word, in the same mood as before. Nothing else changes.`,
  ee: `${MOUTH_ONLY} lips relaxed and a little wider, teeth slightly showing, as if saying "ee" in the middle of a word, in the same mood as before. Nothing else changes.`,
  half: `${MOUTH_ONLY} lips just slightly parted, barely open, as in a soft syllable between words, in the same mood as before. Nothing else changes.`,
};

/** Phase 21: outfits and seasonal looks (pick-list; the owner can also describe their own). */
export const OUTFITS: Record<string, { label: string; prompt: string }> = {
  cozy: { label: 'Cozy sweater', prompt: 'a soft, chunky knit sweater in a warm colour' },
  casual: { label: 'Casual (T-shirt and jacket)', prompt: 'a plain T-shirt under a light casual jacket' },
  hoodie: { label: 'Hoodie', prompt: 'a comfortable hoodie' },
  work: { label: 'Smart for work', prompt: 'smart, tidy work clothes: a blazer over a simple top' },
  evening: { label: 'Dressed up for the evening', prompt: 'elegant evening clothes, tasteful and stylish' },
  sporty: { label: 'Sporty', prompt: 'sporty athletic wear' },
  winter: { label: 'Winter: coat and scarf', prompt: 'a warm winter coat and a knitted scarf; a few snowflakes in the hair' },
  spring: { label: 'Spring', prompt: 'light, fresh spring clothes in pastel colours, a small flower tucked behind one ear' },
  summer: { label: 'Summer', prompt: 'light, bright summer clothes and sunglasses pushed up on the head' },
  autumn: { label: 'Autumn', prompt: 'a cosy autumn jacket in warm earthy tones; a few autumn leaves in the background' },
  halloween: { label: 'Halloween', prompt: 'a fun Halloween costume with a witch hat; a carved pumpkin glowing in the background' },
  holidays: { label: 'Winter holidays', prompt: 'a festive holiday sweater and a warm hat; soft twinkling lights in the background' },
  pajamas: { label: 'Pajamas', prompt: 'soft, comfy pajamas' },
  date: { label: 'Date night', prompt: 'a stylish date-night outfit, a little dressed up' },
  rain: { label: 'Rainy day', prompt: 'a raincoat, a little damp hair from the rain' },
  beach: { label: 'Beach', prompt: 'a light summer beach outfit: a sundress or shorts and a linen shirt, sunglasses' },
};

/** Phase 36: places behind her. */
export const PLACES: Record<string, { label: string; prompt: string }> = {
  room: { label: 'Her room', prompt: 'her cozy room at home, softly lit' },
  cafe: { label: 'A café', prompt: 'a warm, busy café, blurred in the background' },
  office: { label: 'The office', prompt: 'a bright modern office, blurred in the background' },
  outdoors: { label: 'Outdoors', prompt: 'outdoors in a green park, natural daylight' },
  city: { label: 'The city at night', prompt: 'a city street at night with soft lights, blurred' },
  beach: { label: 'The beach', prompt: 'a sunny beach with the sea behind her' },
  gym: { label: 'The gym', prompt: 'a bright gym, blurred in the background' },
  bedroom: { label: 'Bedroom at night', prompt: 'her bedroom at night, warm lamp light' },
};

/** Phase 36: change one thing about her look without starting over. */
export const PARTS: Record<string, { label: string; ask: string; options?: string[] }> = {
  hair: { label: 'Hair', ask: 'the hair (style, length or colour)', options: ['shorter', 'longer', 'curly', 'straight', 'in a ponytail', 'in a messy bun', 'blonde', 'black', 'auburn', 'pastel pink'] },
  eyes: { label: 'Eyes', ask: 'the eye colour', options: ['brown', 'blue', 'green', 'hazel', 'grey'] },
  makeup: { label: 'Makeup', ask: 'the makeup', options: ['none, natural', 'light and natural', 'bold lipstick', 'smoky eyes', 'glam evening makeup'] },
  body: { label: 'Body type', ask: 'the body type (as far as it shows)', options: ['slimmer', 'curvier', 'more athletic', 'softer'] },
  height: { label: 'Height', ask: 'how tall she looks in the frame', options: ['taller', 'shorter'] },
  accessories: { label: 'Accessories', ask: 'the accessories', options: ['small earrings', 'a necklace', 'a hat', 'a hair clip', 'none'] },
  tattoos: { label: 'Tattoos', ask: 'tattoos (small and tasteful unless described otherwise)', options: ['a small tattoo on the neck', 'sleeve tattoos', 'none'] },
  glasses: { label: 'Glasses', ask: 'glasses', options: ['round glasses', 'thin-framed glasses', 'sunglasses', 'no glasses'] },
  style: { label: 'Art style', ask: 'the art style (redraw the whole picture in it)', options: Object.keys({ illustrated: 1, photo: 1, anime: 1, '3d': 1 }) },
};

/** The outfit wording for a pick-list id or the owner's own words; throws a plain-words error. */
export function outfitPrompt(outfit: string): string {
  const wear = (OUTFITS[outfit]?.prompt ?? outfit).trim();
  if (!wear || wear.length > 300) throw new Error('Pick an outfit or describe one (up to 300 characters).');
  if (ADULT_ONLY.test(wear)) throw new Error('The look must be an adult.');
  return wear;
}

/** Phase 36: words that make an outfit adults-only (it then needs Adult mode). */
const ADULT_OUTFIT = /\b(lingerie|nude|naked|topless|bottomless|see-?through|sheer|bikini|thong|underwear|bra|panties|negligee|garter|stockings|fetish|latex|bondage|harness|sexy|seductive|revealing|explicit|nsfw)\b/i;
export function isAdultOutfit(text: string): boolean {
  return ADULT_OUTFIT.test(text);
}

/** Phase 36: what a look shows (kept with it in the closet). */
export interface LookMeta {
  /** What she's wearing, in words. */
  wear?: string;
  /** Where she is (a PLACES id or words). */
  place?: string;
  /** Scenarios she wears it for (Settings → Look → Closet). */
  scenarios?: string[];
  /** Adults-only: shown and worn only with Adult mode on. */
  adult?: boolean;
  /** The art style the look was made in (a LOOK_STYLES id or words), so her later pictures keep it. */
  style?: string;
}

export interface SavedLook extends LookMeta {
  id: string;
  name: string;
  savedAt: string;
}

export interface LookStatus {
  state: 'idle' | 'drafting' | 'draft-ready' | 'building' | 'done' | 'failed';
  step: number;
  total: number;
  error?: string;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface LookDeps {
  dataDir: string;
  /** xAI key or Grok sign-in token. */
  key: () => Promise<string | undefined>;
  model?: () => string;
  fetch?: FetchLike;
  /** Pictures made at once (each takes ~8 s). */
  parallel?: number;
  /** Phase 36: keep her face from the locked reference in every outfit and change (default on). */
  faceLock?: () => boolean;
  /** The built-in default look's file for a picture path (he/they defaults), when no custom look exists. */
  builtin?: (rel: string) => string | undefined;
}

const ADULT_ONLY = /\b(child|children|kid|kids|minor|teen|teenager|underage|toddler|baby|school ?girl|school ?boy|loli|shota|1[0-7] ?(yo|years? old))\b/i;

export class LookBuilder {
  readonly #d: LookDeps;
  status: LookStatus = { state: 'idle', step: 0, total: 0 };

  constructor(d: LookDeps) {
    this.#d = d;
  }

  get dir(): string {
    return join(this.#d.dataDir, 'look');
  }
  get draftFile(): string {
    return join(this.#d.dataDir, 'look-draft', 'portrait.jpg');
  }
  get custom(): boolean {
    return existsSync(join(this.dir, 'sara-portrait.jpg'));
  }

  /**
   * A custom look made before a frame existed (e.g. the "oo"/"ee" mouths): that frame is missing,
   * and the built-in art must not stand in for it (it would be someone else's mouth).
   */
  missing(rel: string): boolean {
    return this.custom && LOOK_PATHS.includes(rel) && !existsSync(join(this.dir, rel));
  }

  /** The custom file to serve for a built-in art path, if any. */
  fileFor(rel: string): string | undefined {
    // Small mood avatars use the matching full portrait.
    const small = /^sara\/avatar-(happy|caring|sleepy|hurt|playful)\.jpg$/.exec(rel);
    if (small) rel = `sara/portrait-${small[1]}.jpg`;
    if (!LOOK_PATHS.includes(rel)) return undefined;
    const f = join(this.dir, rel);
    if (existsSync(f)) return f;
    // Phase 36: a look made before the newer expressions shows the nearest older one.
    const alt = olderExpression(rel);
    if (alt && this.custom && existsSync(join(this.dir, alt))) return join(this.dir, alt);
    return undefined;
  }

  /**
   * The file for a built-in picture path: the custom look's, else the matching default look's (he/they;
   * undefined means Sara's own pictures at the web root). Never mixes a default into a custom look.
   */
  fileOrDefault(rel: string): string | undefined {
    if (this.custom) return this.fileFor(rel);
    return this.#d.builtin?.(rel);
  }

  get faceFile(): string {
    return join(this.#d.dataDir, 'look-face.jpg');
  }
  /** Phase 36: the locked face (made from the first picture of a new look), if the lock is on. */
  faceRef(): Buffer | undefined {
    if (this.#d.faceLock && !this.#d.faceLock()) return undefined;
    return existsSync(this.faceFile) ? readFileSync(this.faceFile) : undefined;
  }

  get #draftMetaFile(): string {
    return join(this.#d.dataDir, 'look-draft', 'meta.json');
  }
  #writeDraftMeta(m: LookMeta & { newFace?: boolean }): void {
    writeFileAtomic(this.#draftMetaFile, JSON.stringify(m), 0o600);
  }
  draftMeta(): LookMeta & { newFace?: boolean } {
    try {
      return JSON.parse(readFileSync(this.#draftMetaFile, 'utf8')) as LookMeta;
    } catch {
      return {};
    }
  }
  /** What the current look shows (wear, place, scenarios, adult). */
  currentMeta(): LookMeta {
    try {
      return JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf8')) as LookMeta;
    } catch {
      return {};
    }
  }

  async #call(path: '/images/generations' | '/images/edits', body: Record<string, unknown>): Promise<Buffer> {
    const key = await this.#d.key();
    if (!key) throw new Error('Sign in to Grok (Settings → Models → Subscriptions) or add an xAI key (Settings → Her → Voice) to make a look.');
    const res = await (this.#d.fetch ?? netFetch)(`https://api.x.ai/v1${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.#d.model?.() || 'grok-imagine-image-quality', response_format: 'b64_json', aspect_ratio: '1:1', ...body }),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        const j = JSON.parse(text) as { error?: string | { message?: string } };
        msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? msg);
      } catch {
        /* raw */
      }
      throw new Error(`The picture service said ${res.status}: ${msg}`);
    }
    const b64 = (JSON.parse(text) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
    if (!b64) throw new Error('The picture service returned no image.');
    return Buffer.from(b64, 'base64');
  }

  #edit(from: Buffer, prompt: string, face?: Buffer): Promise<Buffer> {
    const url = (b: Buffer) => `data:${b[0] === 0x89 ? 'image/png' : b[0] === 0x52 ? 'image/webp' : 'image/jpeg'};base64,${b.toString('base64')}`;
    // Phase 36 face lock: the second picture is her locked face, so changes never drift from it.
    if (face) return this.#call('/images/edits', { prompt: `${prompt} The person's face must be exactly the face in the second picture: the same person, same features. Keep the art style of the first picture exactly (if it is a painted illustration, it stays a painted illustration, not a photo).`, images: [{ type: 'image_url', url: url(from) }, { type: 'image_url', url: url(face) }] });
    return this.#call('/images/edits', { prompt, image: { type: 'image_url', url: url(from) } });
  }

  /** A draft made by editing the current look (outfit, place or one part), carrying its meta. */
  async #editDraft(current: Buffer, prompt: string, meta: LookMeta): Promise<void> {
    if (this.status.state === 'drafting' || this.status.state === 'building') throw new Error('A picture is already being made.');
    this.status = { state: 'drafting', step: 0, total: 1 };
    try {
      const img = await this.#edit(current, prompt, this.faceRef());
      mkdirSync(dirname(this.draftFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.draftFile, img, { mode: 0o600 });
      this.#writeDraftMeta(meta);
      this.status = { state: 'draft-ready', step: 1, total: 1 };
    } catch (err) {
      this.status = { state: 'failed', step: 0, total: 1, error: (err as Error).message };
      throw err;
    }
  }

  /** Phase 36: change one thing (hair, eyes, glasses, art style…) without starting over. */
  async tweak(current: Buffer, part: string, value: string): Promise<void> {
    const p = PARTS[part];
    const v = value.trim();
    if (!p) throw new Error('Pick what to change.');
    if (!v || v.length > 200) throw new Error('Say how to change it (up to 200 characters).');
    if (ADULT_ONLY.test(v)) throw new Error('The look must be an adult.');
    const ask = part === 'style' ? `Redraw this exact picture as ${LOOK_STYLES[v] ?? v}. The same person, face, hair, clothes, pose, framing and background.` : `${KEEP} Only change ${p.ask}: ${v}. Nothing else changes.`;
    await this.#editDraft(current, ask, { ...this.currentMeta(), ...(part === 'style' ? { style: v } : {}) });
  }

  /** Phase 36: the current look somewhere else. */
  async place(current: Buffer, place: string): Promise<void> {
    const where = (PLACES[place]?.prompt ?? place).trim();
    if (!where || where.length > 200) throw new Error('Pick a place or describe one (up to 200 characters).');
    await this.#editDraft(current, `${KEEP.replace('background, lighting', 'lighting')} Only change the background: ${where}. Lighting on her may match the new place.`, { ...this.currentMeta(), place });
  }

  /** Step 1: a portrait from a description, for the owner to accept or try again. */
  async draft(appearance: string, style: string): Promise<void> {
    const look = appearance.trim();
    if (!look || look.length > 600) throw new Error('Describe the look in up to 600 characters.');
    if (ADULT_ONLY.test(look)) throw new Error('The look must be an adult.');
    if (this.status.state === 'drafting' || this.status.state === 'building') throw new Error('A picture is already being made.');
    this.status = { state: 'drafting', step: 0, total: 1 };
    try {
      const img = await this.#call('/images/generations', {
        prompt: `Head-and-shoulders portrait of ${look}. An adult. Facing the viewer with a friendly, relaxed expression, eyes open, mouth closed. Cozy, softly lit room in the background. ${LOOK_STYLES[style] ?? LOOK_STYLES.illustrated}. Square format. No text, no watermark.`,
      });
      mkdirSync(dirname(this.draftFile), { recursive: true, mode: 0o700 });
      writeFileSync(this.draftFile, img, { mode: 0o600 });
      this.#writeDraftMeta({ newFace: true, place: 'room', style: LOOK_STYLES[style] ? style : 'illustrated' });
      this.status = { state: 'draft-ready', step: 1, total: 1 };
    } catch (err) {
      this.status = { state: 'failed', step: 0, total: 1, error: (err as Error).message };
      throw err;
    }
  }

  /**
   * Step 2: builds the whole set from the accepted draft or an uploaded picture (bytes), then swaps it
   * in. Runs in the background; follow `status`.
   */
  async build(base: Buffer, meta?: LookMeta & { newFace?: boolean }): Promise<void> {
    if (this.status.state === 'drafting' || this.status.state === 'building') throw new Error('A look is already being made.');
    const m = meta ?? this.draftMeta();
    const work = join(this.#d.dataDir, 'look-new');
    rmSync(work, { recursive: true, force: true });
    mkdirSync(join(work, 'sara', 'frames'), { recursive: true, mode: 0o700 });
    const total = EXPRESSIONS.length - 1 + EXPRESSIONS.length * (1 + MOUTHS.length);
    this.status = { state: 'building', step: 0, total };
    const done = () => (this.status = { ...this.status, step: this.status.step + 1 });
    const save = (rel: string, b: Buffer) => writeFileSync(join(work, rel), b, { mode: 0o600 });
    try {
      save('sara-portrait.jpg', base);
      save('sara-avatar.jpg', base);
      const faces = Object.fromEntries(EXPRESSIONS.map((x) => [x, base])) as Record<Expression, Buffer>;
      await this.#pool(
        EXPRESSIONS.filter((x) => x !== 'default').map((x) => async () => {
          faces[x] = await this.#edit(base, EXPRESSION_EDIT[x]);
          save(`sara/portrait-${x}.jpg`, faces[x]);
          done();
        }),
      );
      await this.#pool(
        EXPRESSIONS.flatMap((x) => [
          async () => {
            save(`sara/frames/${x}-blink.jpg`, await this.#edit(faces[x], BLINK));
            done();
          },
          ...MOUTHS.map((m) => async () => {
            save(`sara/frames/${x}-${m}.jpg`, await this.#edit(faces[x], MOUTH_EDIT[m]));
            done();
          }),
        ]),
      );
      const { newFace, ...keep } = m;
      writeFileSync(join(work, 'meta.json'), JSON.stringify(keep), { mode: 0o600 });
      // A new person (not an outfit or a change of the same one): her face is locked from this picture.
      if (newFace || !existsSync(this.faceFile)) writeFileSync(this.faceFile, base, { mode: 0o600 });
      // Swap in only now that every picture exists. The look it replaces is kept in Saved looks.
      if (this.custom && !this.currentSavedId()) this.save(`Look from ${new Date().toISOString().slice(0, 10)}`);
      const old = join(this.#d.dataDir, 'look-old');
      rmSync(old, { recursive: true, force: true });
      if (existsSync(this.dir)) renameSync(this.dir, old);
      renameSync(work, this.dir);
      rmSync(old, { recursive: true, force: true });
      rmSync(dirname(this.draftFile), { recursive: true, force: true });
      this.status = { state: 'done', step: total, total };
    } catch (err) {
      rmSync(work, { recursive: true, force: true });
      this.status = { state: 'failed', step: this.status.step, total, error: (err as Error).message };
      throw err;
    }
  }

  /** Pictures a custom look doesn't have yet (made before newer frames or expressions existed). */
  missingFrames(): string[] {
    return this.custom ? LOOK_PATHS.filter((rel) => rel.startsWith('sara/') && !existsSync(join(this.dir, rel))) : [];
  }

  /** Makes only the missing frames for the current custom look, from its own expressions. */
  async complete(): Promise<void> {
    if (this.status.state === 'drafting' || this.status.state === 'building') throw new Error('A look is already being made.');
    const todo = this.missingFrames();
    if (!todo.length) return;
    const total = todo.length;
    this.status = { state: 'building', step: 0, total };
    try {
      // Missing expressions first (their frames are made from them).
      const base = readFileSync(join(this.dir, 'sara-portrait.jpg'));
      await this.#pool(
        todo
          .filter((rel) => rel.startsWith('sara/portrait-'))
          .map((rel) => async () => {
            const x = /^sara\/portrait-(\w+)\.jpg$/.exec(rel)![1] as Exclude<Expression, 'default'>;
            writeFileSync(join(this.dir, rel), await this.#edit(base, EXPRESSION_EDIT[x]), { mode: 0o600 });
            this.status = { ...this.status, step: this.status.step + 1 };
          }),
      );
      await this.#pool(
        todo.filter((rel) => rel.startsWith('sara/frames/')).map((rel) => async () => {
          const [, x, kind] = /^sara\/frames\/(\w+)-(\w+)\.jpg$/.exec(rel)!;
          const face = readFileSync(join(this.dir, x === 'default' ? 'sara-portrait.jpg' : `sara/portrait-${x}.jpg`));
          const prompt = kind === 'blink' ? BLINK : MOUTH_EDIT[kind as (typeof MOUTHS)[number]];
          const img = await this.#edit(face, prompt);
          writeFileSync(join(this.dir, rel), img, { mode: 0o600 });
          this.status = { ...this.status, step: this.status.step + 1 };
        }),
      );
      this.status = { state: 'done', step: total, total };
    } catch (err) {
      this.status = { state: 'failed', step: this.status.step, total, error: (err as Error).message };
      throw err;
    }
  }

  async #pool(jobs: (() => Promise<void>)[]): Promise<void> {
    const n = Math.max(1, this.#d.parallel ?? 3);
    let next = 0;
    let failed: unknown;
    await Promise.all(
      Array.from({ length: Math.min(n, jobs.length) }, async () => {
        while (next < jobs.length && !failed) {
          const job = jobs[next++];
          try {
            await job();
          } catch (err) {
            failed ??= err;
          }
        }
      }),
    );
    if (failed) throw failed;
  }

  draftBytes(): Buffer | undefined {
    return existsSync(this.draftFile) ? readFileSync(this.draftFile) : undefined;
  }

  // ---------- Phase 21: outfits and saved looks ----------

  /**
   * A draft of the current look (custom, or the built-in portrait passed in) in another outfit.
   * Accept it with `build()` like any draft: the whole set is made from it.
   */
  async outfit(current: Buffer, outfit: string, opts: { place?: string; adultOk?: boolean } = {}): Promise<void> {
    const wear = outfitPrompt(outfit);
    const adult = isAdultOutfit(wear);
    if (adult && !opts.adultOk) throw new Error('That outfit is adults-only: turn on Adult mode first (in a web browser).');
    const where = opts.place ? (PLACES[opts.place]?.prompt ?? opts.place).slice(0, 200) : '';
    await this.#editDraft(
      current,
      `${KEEP.replace('clothes, ', '').replace(where ? 'background, lighting' : '', where ? 'lighting' : '')} Only change the clothes${where ? ` and the background (${where})` : ' (and anything said below about the background)'}: ${wear}. The same person, same face and hair, same expression, same framing and art style.`,
      { wear: OUTFITS[outfit]?.label ? `${OUTFITS[outfit].label.toLowerCase()} (${wear})` : wear, place: opts.place ?? this.currentMeta().place, ...(this.currentMeta().style ? { style: this.currentMeta().style } : {}), ...(adult ? { adult: true } : {}) },
    );
  }

  get savedDir(): string {
    return join(this.#d.dataDir, 'looks');
  }

  /** Saved looks, newest first. */
  saved(): SavedLook[] {
    if (!existsSync(this.savedDir)) return [];
    const out: SavedLook[] = [];
    for (const id of readdirSync(this.savedDir)) {
      try {
        const m = JSON.parse(readFileSync(join(this.savedDir, id, 'look.json'), 'utf8')) as SavedLook;
        let meta: LookMeta = {};
        try {
          meta = JSON.parse(readFileSync(join(this.savedDir, id, 'meta.json'), 'utf8')) as LookMeta;
        } catch {
          /* a look saved before Phase 36 */
        }
        if (existsSync(join(this.savedDir, id, 'sara-portrait.jpg'))) out.push({ ...cleanMeta(meta), id, name: String(m.name), savedAt: String(m.savedAt) });
      } catch {
        /* not a saved look */
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  #fingerprint(dir: string): string {
    return createHash('sha256').update(readFileSync(join(dir, 'sara-portrait.jpg'))).digest('hex');
  }

  /** The saved look that is the same as the current custom look, if any. */
  currentSavedId(): string | undefined {
    if (!this.custom) return undefined;
    const fp = this.#fingerprint(this.dir);
    return this.saved().find((s) => this.#fingerprint(join(this.savedDir, s.id)) === fp)?.id;
  }

  /** Saves the current custom look under a name (or renames it if it's already saved). */
  save(name: string, now = new Date()): SavedLook {
    const n = name.trim().slice(0, 60) || 'My look';
    if (!this.custom) throw new Error('This is the default look: make a custom look first.');
    const existing = this.currentSavedId();
    const id = existing ?? randomBytes(6).toString('hex');
    const dir = join(this.savedDir, id);
    if (!existing) {
      if (this.saved().length >= 30) throw new Error('You have 30 saved looks: delete one first.');
      mkdirSync(this.savedDir, { recursive: true, mode: 0o700 });
      cpSync(this.dir, dir, { recursive: true });
    }
    const meta: SavedLook = { id, name: n, savedAt: existing ? (this.saved().find((s) => s.id === id)?.savedAt ?? now.toISOString()) : now.toISOString() };
    writeFileAtomic(join(dir, 'look.json'), JSON.stringify(meta), 0o600);
    return meta;
  }

  /** Switches to a saved look. The current custom look is saved first, so nothing is lost. */
  use(id: string, now = new Date()): void {
    if (this.status.state === 'drafting' || this.status.state === 'building') throw new Error('A look is being made: wait for it to finish.');
    const from = this.#savedPath(id);
    if (this.custom && !this.currentSavedId()) this.save(`Look from ${now.toISOString().slice(0, 10)}`, now);
    this.#swapIn(from, true);
  }

  deleteSaved(id: string): void {
    rmSync(this.#savedPath(id), { recursive: true, force: true });
  }

  /** Phase 36: what a saved look is for (scenarios, wear, place, adults-only). Also updates the current look if it's the same. */
  setMeta(id: string, patch: LookMeta): SavedLook {
    const dir = this.#savedPath(id);
    const cur = this.saved().find((x) => x.id === id)!;
    const { id: _i, name: _n, savedAt: _s, ...old } = cur;
    const next = cleanMeta({ ...old, ...patch });
    if (next.wear && isAdultOutfit(next.wear)) next.adult = true;
    writeFileAtomic(join(dir, 'meta.json'), JSON.stringify(next), 0o600);
    if (this.currentSavedId() === id) writeFileAtomic(join(this.dir, 'meta.json'), JSON.stringify(next), 0o600);
    return { ...next, id, name: cur.name, savedAt: cur.savedAt };
  }

  savedPortrait(id: string): string {
    return join(this.#savedPath(id), 'sara-portrait.jpg');
  }

  #savedPath(id: string): string {
    if (!/^[a-f0-9]{12}$/.test(id) || !existsSync(join(this.savedDir, id, 'sara-portrait.jpg'))) throw new Error('No such saved look.');
    return join(this.savedDir, id);
  }

  /** Replaces the current look with a folder's pictures (copied or moved), atomically. */
  #swapIn(from: string, copy: boolean): void {
    const work = join(this.#d.dataDir, 'look-new');
    rmSync(work, { recursive: true, force: true });
    if (copy) cpSync(from, work, { recursive: true });
    else renameSync(from, work);
    rmSync(join(work, 'look.json'), { force: true });
    const old = join(this.#d.dataDir, 'look-old');
    rmSync(old, { recursive: true, force: true });
    if (existsSync(this.dir)) renameSync(this.dir, old);
    renameSync(work, this.dir);
    rmSync(old, { recursive: true, force: true });
  }

  /** The current look's pictures (for a character file), or nothing for the default look. */
  files(): Record<string, Buffer> {
    if (!this.custom) return {};
    const out: Record<string, Buffer> = {};
    for (const rel of LOOK_PATHS) if (existsSync(join(this.dir, rel))) out[rel] = readFileSync(join(this.dir, rel));
    return out;
  }

  /** Puts in a look from a character file. The current custom look is saved first. */
  importFiles(files: Record<string, Buffer>, now = new Date()): void {
    if (this.status.state === 'drafting' || this.status.state === 'building') throw new Error('A look is being made: wait for it to finish.');
    if (!files['sara-portrait.jpg']) throw new Error('The look in this file has no portrait.');
    const tmp = join(this.#d.dataDir, 'look-import');
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(join(tmp, 'sara', 'frames'), { recursive: true, mode: 0o700 });
    for (const [rel, b] of Object.entries(files)) {
      if (!LOOK_PATHS.includes(rel)) throw new Error(`Unexpected picture in the file: ${rel.slice(0, 80)}`);
      writeFileSync(join(tmp, rel), b, { mode: 0o600 });
    }
    if (!files['sara-avatar.jpg']) writeFileSync(join(tmp, 'sara-avatar.jpg'), files['sara-portrait.jpg'], { mode: 0o600 });
    if (this.custom && !this.currentSavedId()) this.save(`Look from ${now.toISOString().slice(0, 10)}`, now);
    this.#swapIn(tmp, false);
    this.status = { state: 'idle', step: 0, total: 0 };
  }

  /** Back to the built-in art. */
  reset(): void {
    if (this.custom && !this.currentSavedId()) this.save(`Look from ${new Date().toISOString().slice(0, 10)}`);
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(dirname(this.draftFile), { recursive: true, force: true });
    this.status = { state: 'idle', step: 0, total: 0 };
  }

}

/** The older expression a look made before Phase 36 shows in place of a newer one. */
export function olderExpression(rel: string): string | undefined {
  const p = /^sara\/portrait-(\w+)\.jpg$/.exec(rel);
  const f = /^sara\/frames\/(\w+)-(\w+)\.jpg$/.exec(rel);
  const alt = EXPRESSION_FALLBACK[(p?.[1] ?? f?.[1]) as Expression];
  if (!alt) return undefined;
  return p ? `sara/portrait-${alt}.jpg` : `sara/frames/${alt}-${f![2]}.jpg`;
}

const SCENARIO_ID = /^[a-z0-9-]{1,40}$/;
export function cleanMeta(m: LookMeta): LookMeta {
  const out: LookMeta = {};
  if (typeof m.wear === 'string' && m.wear.trim()) out.wear = m.wear.trim().slice(0, 300);
  if (typeof m.place === 'string' && m.place.trim()) out.place = m.place.trim().slice(0, 200);
  if (Array.isArray(m.scenarios)) out.scenarios = [...new Set(m.scenarios.filter((x) => typeof x === 'string' && SCENARIO_ID.test(x)))].slice(0, 20);
  if (m.adult === true) out.adult = true;
  return out;
}
