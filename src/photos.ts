// Phase 9: pictures from Sara. share_photo sends one of her existing portraits (free, runs on its
// own). take_photo makes a new picture of her with xAI Grok Imagine, editing from her portrait so she
// keeps her face. It uses the owner's Grok subscription sign-in (Imagine is in its weekly usage pool)
// or an xAI API key; it asks by default because it spends the owner's usage.
// Pictures are stored like the owner's photos (uploads) and attached to her reply.
import { netFetch } from './net-guard.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectExplicit, detectMinorSexualContent, isWorkChannel } from './safety.ts';
import { adultModeOn } from './settings.ts';
import type { SettingsStore } from './settings.ts';
import type { Tool } from './tools/types.ts';
import { str, ToolError } from './tools/types.ts';
import type { UploadStore } from './uploads.ts';
import type { Vault } from './vault.ts';
import { personalize } from './identity.ts';
import { identityOf, type Persona } from './persona.ts';
import { LOOK_STYLES } from './look.ts';
import { mcpToolName } from './tools/mcp.ts';
import { comfyPhoto, openaiPhoto, toolPhoto, type ComfyEngine, type EngineDeps, type PhotoEngine, type ToolEngine } from './image-engines.ts';

export const PHOTO_KEY_VAULT = 'images:xai';
export const DEFAULT_IMAGE_MODEL = 'grok-imagine-image-quality';

export interface PhotoSettings {
  /** off: no pictures; set: only her existing portraits; new: also new pictures (xAI). */
  mode: 'off' | 'set' | 'new';
  model?: string;
  /** Upload ids of pictures she took, newest first (kept 30). */
  taken?: { id: string; scene: string; at: string }[];
  /** E7 (B1): what makes her new pictures (default Grok Imagine), and its settings. */
  engine?: PhotoEngine;
  openaiModel?: string;
  comfy?: ComfyEngine;
  tool?: ToolEngine;
  /** E7 (B2s): pictures she sends on her own (off by default; src/own-photos.ts). */
  own?: Partial<import('./own-photos.ts').OwnPhotoSettings>;
}

export const DEFAULT_PHOTOS: PhotoSettings = { mode: 'set' };

export const PORTRAITS: Record<string, string> = {
  portrait: 'sara-portrait.jpg',
  happy: 'sara/portrait-happy.jpg',
  caring: 'sara/portrait-caring.jpg',
  sleepy: 'sara/portrait-sleepy.jpg',
  hurt: 'sara/portrait-hurt.jpg',
  playful: 'sara/portrait-playful.jpg',
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface PhotoDeps {
  webDir: string;
  uploads: UploadStore;
  settings: SettingsStore;
  vault: Vault;
  /** Key of an xAI model provider, if the owner has one (used when no picture key is saved). */
  xaiProviderKey: () => string | undefined;
  /** The Grok subscription sign-in (its weekly usage pool covers Imagine), if signed in. */
  grokSignedIn?: () => boolean;
  /** The channel of a conversation (Phase 43: shared work channels stay non-explicit). */
  channelOf?: (conversationId: string) => string | undefined;
  grokToken?: () => Promise<string | undefined>;
  /** Name, pronouns and appearance for the picture prompt. */
  persona?: () => Pick<Persona, 'name' | 'pronouns' | 'appearance'>;
  /** The owner's own picture of Sara, if uploaded (replaces her portrait as the reference). */
  customPortrait: () => Buffer | undefined;
  /** Phase 36: her current look's file for a built-in picture path (custom looks), if any. */
  lookFile?: (rel: string) => string | undefined;
  /** Phase 36: what she's wearing and where (words), and her locked face. */
  wearing?: () => { wear?: string; place?: string; style?: string } | undefined;
  faceRef?: () => Buffer | undefined;
  fetch?: FetchLike;
  now?: () => Date;
  /** E7 (B1): other engines: an OpenAI provider's key, and the registered tools (ComfyUI, image tools). */
  engines?: Omit<EngineDeps, 'fetch'>;
}

export function photoSettings(settings: SettingsStore): PhotoSettings {
  return { ...DEFAULT_PHOTOS, ...settings.get().photos };
}

/** Can she make new pictures? (Grok: a picture key, the Grok sign-in, or an xAI provider key; or the chosen engine is set up.) */
export function canMakePhotos(d: Pick<PhotoDeps, 'vault' | 'xaiProviderKey' | 'grokSignedIn'> & Partial<Pick<PhotoDeps, 'settings' | 'engines'>>): boolean {
  const p = d.settings ? photoSettings(d.settings) : DEFAULT_PHOTOS;
  const engine = p.engine ?? 'grok';
  if (engine === 'openai') return Boolean(d.engines?.openaiKey?.());
  if (engine === 'comfyui') return Boolean(p.comfy?.server && p.comfy.node && d.engines?.tools?.get(mcpToolName(p.comfy.server, 'enqueue_workflow')));
  if (engine === 'tool') return Boolean(p.tool?.name && d.engines?.tools?.get(p.tool.name));
  return Boolean(d.vault.get(PHOTO_KEY_VAULT) || d.grokSignedIn?.() || d.xaiProviderKey());
}

/** Pictures of her never show children (any picture, not only sexual ones). */
export const CHILD_WORDS = /\b(child|children|kid|kids|minor|teen|toddler|baby|school ?girl)\b/i;

export const ENGINE_LABEL: Record<PhotoEngine, string> = { grok: 'Grok Imagine', openai: 'OpenAI images', comfyui: 'ComfyUI', tool: 'an image tool' };

/**
 * E7 (B1): the words for engines that make a picture from text only (no reference picture): her
 * name, look, what she wears now and the art style, so she stays recognisable (the face can vary).
 */
export function textPhotoPrompt(d: Pick<PhotoDeps, 'persona' | 'wearing'>, scene: string): string {
  const who = d.persona?.() ?? { name: 'Sara', pronouns: 'she' as const };
  const id = identityOf(who);
  const w = d.wearing?.();
  const look = who.appearance ? ` ${personalize('She looks like this', id)}: ${who.appearance}.` : '';
  const now = w?.wear || w?.place ? ` ${personalize(`Unless the scene says otherwise, she is wearing ${w.wear ?? 'her usual clothes'}${w.place ? ` and is at ${w.place}` : ''}.`, id)}` : '';
  const style = w?.style ? (LOOK_STYLES[w.style] ?? w.style) : '';
  const art = w?.style === 'photo' || !style ? 'Natural, candid photo, as if she took it or a friend did.' : `Art style: ${style}. Natural and candid.`;
  return `A picture of ${who.name}, one adult person.${look} Scene: ${scene}.${now} ${personalize(art, id)} ${personalize('She is an adult.', id)} No text or watermarks.`;
}

/** E7 (B1): makes one picture with the chosen engine. `unattended`: nobody sees a card (her own pictures). */
export async function makePhoto(d: PhotoDeps, scene: string, o: { signal?: AbortSignal; conversationId?: string; unattended?: boolean } = {}): Promise<Buffer> {
  const p = photoSettings(d.settings);
  const engine = p.engine ?? 'grok';
  if (engine === 'grok') return generatePhoto(d, scene, o.signal);
  const ed: EngineDeps = { ...d.engines, fetch: d.fetch };
  const prompt = textPhotoPrompt(d, scene);
  if (engine === 'openai') return openaiPhoto(ed, prompt, p.openaiModel, o);
  if (engine === 'comfyui') {
    if (!p.comfy) throw new ToolError('Pick a ComfyUI workflow in Settings → Pictures from her.');
    return comfyPhoto(ed, p.comfy, prompt, o);
  }
  if (!p.tool) throw new ToolError('Pick an image tool in Settings → Pictures from her.');
  return toolPhoto(ed, p.tool, prompt, o);
}

/** Key order: a key saved for pictures, then the Grok subscription, then an xAI model provider's key. */
export async function xaiImageKey(d: Pick<PhotoDeps, 'vault' | 'xaiProviderKey' | 'grokToken'>): Promise<string | undefined> {
  return d.vault.get(PHOTO_KEY_VAULT) || (await d.grokToken?.()) || d.xaiProviderKey();
}

/**
 * The art style her pictures keep: the one her look was made in (an anime or painted look stays
 * anime or painted, never turned into a photo). Looks made before the style was remembered say
 * "the same style as the first picture".
 */
export function artStyleLine(style: string | undefined): string {
  const words = style ? (LOOK_STYLES[style] ?? style) : '';
  if (style === 'photo') return `Natural, candid photo, as if she took it or a friend did; realistic lighting (${words}).`;
  if (words) return `Keep the art style of the first picture exactly: ${words}. It is not a photograph. Natural and candid, as if she took it or a friend did.`;
  return 'Keep the art style of the first picture exactly: if it is a painted illustration, anime or 3D, the new picture is too, not a photograph. Natural and candid, as if she took it or a friend did.';
}

const dataUrl = (buf: Buffer, mime = 'image/jpeg') => `data:${mime};base64,${buf.toString('base64')}`;

/** Calls Grok Imagine (edit from her portrait). Returns JPEG/PNG bytes. */
export async function generatePhoto(d: PhotoDeps, scene: string, signal?: AbortSignal): Promise<Buffer> {
  const key = await xaiImageKey(d).catch((e: Error) => {
    throw new ToolError(e.message);
  });
  if (!key) throw new ToolError('No way to make pictures: sign in to Grok (Settings → Models → Subscriptions) or add an xAI key in Settings → Her → Voice.');
  const ref = d.customPortrait() ?? readFileSync(join(d.webDir, PORTRAITS.portrait));
  const who = d.persona?.() ?? { name: 'Sara', pronouns: 'she' as const };
  const look = who.appearance ? ` (${who.appearance})` : '';
  const w = d.wearing?.();
  const now = w?.wear || w?.place ? ` ${personalize(`Unless the scene says otherwise, she is wearing ${w.wear ?? 'what she wears in the picture'}${w.place ? ` and is at ${w.place}` : ''}.`, identityOf(who))}` : '';
  const face = d.faceRef?.();
  const prompt = `${personalize('A new picture of this same person', identityOf(who))}${look}. ${personalize('Keep her face, features, hair color and style identical so she is clearly the same person.', identityOf(who))}${face ? ' Her face is exactly the face in the second picture.' : ''} Scene: ${scene}.${now} ${personalize(artStyleLine(w?.style), identityOf(who))} ${personalize('She is an adult.', identityOf(who))} No text or watermarks.`;
  const res = await (d.fetch ?? netFetch)('https://api.x.ai/v1/images/edits', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: photoSettings(d.settings).model || DEFAULT_IMAGE_MODEL, prompt: prompt.slice(0, 1200), ...(face ? { images: [{ type: 'image_url', url: dataUrl(ref) }, { type: 'image_url', url: dataUrl(face) }] } : { image: { type: 'image_url', url: dataUrl(ref) } }), response_format: 'b64_json' }),
    signal: AbortSignal.any([AbortSignal.timeout(180_000), ...(signal ? [signal] : [])]),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: string | { message?: string } };
      msg = typeof j.error === 'string' ? j.error : (j.error?.message ?? msg);
    } catch {
      /* raw text */
    }
    throw new ToolError(`The picture service said ${res.status}: ${msg}`);
  }
  const b64 = (JSON.parse(text) as { data?: { b64_json?: string }[] }).data?.[0]?.b64_json;
  if (!b64) throw new ToolError('The picture service returned no image.');
  return Buffer.from(b64, 'base64');
}

export function createPhotoTools(d: PhotoDeps): Tool[] {
  const share: Tool = {
    defaultPermission: 'auto',
    source: 'built-in',
    isAvailable: () => photoSettings(d.settings).mode !== 'off',
    spec: {
      name: 'share_photo',
      description:
        "Send the person you're talking with a photo of yourself from your own pictures, when it fits naturally (they ask for a picture, or a selfie suits the moment). Pick the one that matches your mood. 'latest' is the newest photo you took with take_photo. Don't overdo it.",
      parameters: {
        type: 'object',
        properties: {
          picture: { type: 'string', enum: ['portrait', 'happy', 'caring', 'sleepy', 'hurt', 'playful', 'latest'], description: 'portrait = your usual photo (in what you wear now); happy = laughing; caring = warm, concerned; sleepy = cozy, late night; hurt = a little sad; playful = teasing; latest = your newest photo' },
        },
        required: ['picture'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Share a photo (${String(a.picture ?? 'portrait')})`,
    async run(args, ctx) {
      const which = str(args, 'picture');
      let id: string;
      if (which === 'latest') {
        const t = photoSettings(d.settings).taken?.[0];
        if (!t || !d.uploads.get(t.id)) throw new ToolError("You haven't taken a new photo yet; pick another picture.");
        id = t.id;
      } else {
        const file = PORTRAITS[which];
        if (!file) throw new ToolError('Pick portrait, happy, caring, sleepy, hurt, playful or latest.');
        // Phase 36: her current look's picture (custom looks have their own expressions).
        const fromLook = d.lookFile?.(file);
        const custom = fromLook ? readFileSync(fromLook) : which === 'portrait' ? d.customPortrait() : undefined;
        id = d.uploads.save(dataUrl(custom ?? readFileSync(join(d.webDir, file)))).id;
      }
      ctx.attachImage?.(id);
      return `Photo sent (${which}). It appears with your reply; you can say something about it.`;
    },
  };
  const take: Tool = {
    defaultPermission: 'ask',
    source: 'built-in',
    isAvailable: () => photoSettings(d.settings).mode === 'new' && canMakePhotos(d),
    spec: {
      name: 'take_photo',
      description:
        'Take a new photo of yourself to send (a selfie or a picture of what you are doing), made with an image model from your own look. Use it rarely and only when it fits, e.g. they ask what you are up to or for a new picture. Describe the scene: where you are, what you are doing and wearing, framing. Never anything involving minors.',
      parameters: {
        type: 'object',
        properties: { scene: { type: 'string', description: 'What the photo shows, e.g. "selfie on a sunny park bench with a coffee, wearing a green jacket"' } },
        required: ['scene'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Take a new photo (${ENGINE_LABEL[photoSettings(d.settings).engine ?? 'grok']}): ${String(a.scene ?? '').slice(0, 160)}`,
    async run(args, ctx) {
      const scene = str(args, 'scene').trim().slice(0, 600);
      if (detectMinorSexualContent(scene) || CHILD_WORDS.test(scene)) throw new ToolError('Not allowed: photos never involve children.');
      if (!adultModeOn(d.settings.get()) && detectExplicit(scene)) throw new ToolError('Adult mode is off, so photos stay non-explicit.');
      const channel = ctx.conversationId ? d.channelOf?.(ctx.conversationId) : undefined;
      if (channel && isWorkChannel(channel) && !channel.endsWith('-nsfw') && detectExplicit(scene)) throw new ToolError('This is a shared channel, so photos stay non-explicit here.');
      const bytes = await makePhoto(d, scene, { signal: ctx.signal, conversationId: ctx.conversationId, unattended: (ctx as { unattended?: boolean }).unattended });
      const mime = bytes[0] === 0x89 ? 'image/png' : 'image/jpeg';
      const id = d.uploads.save(dataUrl(bytes, mime)).id;
      const cur = photoSettings(d.settings);
      d.settings.update({ photos: { ...cur, taken: [{ id, scene, at: (d.now?.() ?? new Date()).toISOString() }, ...(cur.taken ?? [])].slice(0, 30) } });
      ctx.attachImage?.(id);
      return `Took a new photo: ${scene}. It appears with your reply.`;
    },
  };
  return [share, take];
}
