// Built-in looks. Sara ships three default characters with the same picture set (portrait, mood
// portraits, small avatars, blink and mouth frames, face landmarks): Sara (she), a male default (he)
// and an androgynous default (they). Until the owner makes or picks a look of their own, the one that
// matches the companion's pronouns is shown ("auto"); the owner can also pick one by name in
// Settings → Her → Look. A custom look always wins and is never replaced.
// Sara's pictures live at the web root (web/sara-portrait.jpg, web/sara/…); the others mirror those
// paths under web/looks/<he|they>/. Prompts: docs/APPEARANCE.md.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Pronouns } from './identity.ts';

export type DefaultLookId = 'she' | 'he' | 'they';
export type DefaultLookSetting = 'auto' | DefaultLookId;
export const DEFAULT_LOOK_IDS: readonly DefaultLookId[] = ['she', 'he', 'they'];

const SARA_APPEARANCE = 'a woman in her late 20s with shoulder-length wavy auburn-brown hair, freckles, green eyes and a warm smile, usually in a cozy cream knit sweater; painterly illustrated style';

export const DEFAULT_LOOKS: Record<DefaultLookId, { label: string; appearance: string }> = {
  she: { label: 'Default (she)', appearance: SARA_APPEARANCE },
  he: { label: 'Default (he)', appearance: 'a man in his early 30s with short, tousled dark brown hair, light stubble, warm brown eyes and a kind smile, usually in a cozy moss-green knit sweater; painterly illustrated style' },
  they: { label: 'Default (they)', appearance: 'an androgynous adult in their late 20s with a messy jaw-length black shag and wispy bangs, small silver hoop earrings, warm brown eyes and a kind smile, usually in a cozy mustard knit sweater; painterly illustrated style' },
};

/** A stored setting → one we know ("auto" when missing or unknown). */
export function toDefaultLookSetting(v: unknown): DefaultLookSetting {
  return v === 'she' || v === 'he' || v === 'they' ? v : 'auto';
}

/** Which built-in look shows: the owner's pick, else the one matching the pronouns. */
export function defaultLookFor(setting: unknown, pronouns: Pronouns | undefined): DefaultLookId {
  const s = toDefaultLookSetting(setting);
  if (s !== 'auto') return s;
  return pronouns === 'he' || pronouns === 'they' ? pronouns : 'she';
}

/** Built-in picture paths every default look has (the same set a custom look is made of). */
export const BUILTIN_PATH = /^(?:sara-portrait\.jpg|sara-avatar\.jpg|sara\/(?:portrait|avatar)-(?:happy|caring|sleepy|hurt|playful)\.jpg|sara\/frames\/(?:default|happy|caring|sleepy|hurt|playful)-(?:blink|talk|oo|ee|half)\.jpg|sara\/face\.json)$/;

/**
 * The file to serve for a built-in path under a non-Sara default look; undefined for Sara (the web
 * root serves her) or a path that isn't part of a look.
 */
export function defaultLookFile(webRoot: string, rel: string, id: DefaultLookId): string | undefined {
  if (id === 'she' || !BUILTIN_PATH.test(rel)) return undefined;
  const f = join(webRoot, 'looks', id, rel);
  return existsSync(f) ? f : undefined;
}

/**
 * The appearance words for pictures: a built-in default description follows the default look in
 * use; anything the owner wrote is kept.
 */
export function appearanceFor(appearance: string | undefined, id: DefaultLookId): string {
  const a = String(appearance ?? '').trim();
  if (!a || Object.values(DEFAULT_LOOKS).some((l) => l.appearance === a)) return DEFAULT_LOOKS[id].appearance;
  return a;
}
