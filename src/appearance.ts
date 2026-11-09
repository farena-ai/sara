// V1 (docs/ops/V1_DESIGN.md → Storage): the look a new device starts from. Each device keeps its own
// look in localStorage (applied before the first paint); "Use on all my devices" on Settings → You →
// Appearance saves the set here so a device that never chose starts from it.

export const PALETTES = ['graphite', 'midnight', 'slate', 'nord', 'solarized', 'paper', 'ember', 'contrast', 'classic'] as const;
export const ACCENTS = ['rose', 'blue', 'cyan', 'green', 'amber', 'red', 'pink', 'violet', 'grey', 'emerald', 'lavender', 'ocean', 'forest', 'mono', 'custom'] as const;

export interface AccentShade { fill: string; text: string; on: string }
export interface Appearance {
  palette: (typeof PALETTES)[number];
  theme: 'dark' | 'light' | 'system';
  accent: (typeof ACCENTS)[number];
  accentCustom?: { hex: string; dark: AccentShade; light: AccentShade };
  density: 'comfy' | 'compact';
  decor?: 'on' | 'off';
  portrait: 'large' | 'small' | 'hidden';
}

const HEX = /^#[0-9a-f]{6}$/i;
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const shade = (v: unknown): AccentShade | null => {
  const o = v as Partial<AccentShade> | null;
  return o && HEX.test(String(o.fill)) && HEX.test(String(o.text)) && HEX.test(String(o.on)) ? { fill: String(o.fill), text: String(o.text), on: String(o.on) } : null;
};

/** A clean copy of a posted look; null clears it. Unknown values fall back to the defaults. */
export function cleanAppearance(v: unknown): Appearance | undefined {
  if (v === null || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Appearance = {
    palette: pick(o.palette, PALETTES, 'graphite'),
    // V3 (docs/ops/V3_DESIGN.md §5): the owner's defaults, Follow the system and (V4e) Violet; Sara Classic its rose.
    theme: pick(o.theme, ['dark', 'light', 'system'] as const, 'system'),
    accent: pick(o.accent, ACCENTS, o.palette === 'classic' ? 'rose' : 'violet'),
    density: pick(o.density, ['comfy', 'compact'] as const, 'comfy'),
    portrait: pick(o.portrait, ['large', 'small', 'hidden'] as const, 'small'),
  };
  if (o.decor === 'on' || o.decor === 'off') out.decor = o.decor;
  const c = o.accentCustom as Record<string, unknown> | undefined;
  const dark = shade(c?.dark), light = shade(c?.light);
  if (out.accent === 'custom') {
    if (c && HEX.test(String(c.hex)) && dark && light) out.accentCustom = { hex: String(c.hex), dark, light };
    else out.accent = 'rose';
  }
  return out;
}
