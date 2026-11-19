// W1.4: the style block kept in persona.json (no imports, so src/persona.ts can use it without
// pulling the chat graph in). Resolved for every surface by src/persona-style.ts.
export type GreetStyle = 'warm' | 'casual' | 'brief' | 'formal';
export const GREET_STYLES: readonly GreetStyle[] = ['warm', 'casual', 'brief', 'formal'];
/** Her picture on a device that hasn't picked one (web/v4-picture.js modes). '' = the device default. */
export type FaceMode = '' | 'orb' | 'portrait' | 'still' | 'own';
export const FACE_MODES: readonly FaceMode[] = ['orb', 'portrait', 'still', 'own'];
export const SIGNOFF_MAX = 80;

/** What persona.json keeps (only the parts set). */
export interface PersonaStyleFile {
  signOff?: string;
  greet?: GreetStyle;
  face?: Exclude<FaceMode, ''>;
}

/** Cleans a style block (also used by validatePersona). Throws on a too-long sign-off. */
export function cleanStyle(raw: unknown): PersonaStyleFile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const out: PersonaStyleFile = {};
  const so = String(o.signOff ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .slice(0, 2)
    .join('\n');
  if (so.length > SIGNOFF_MAX) throw new Error('Sign-off: at most 80 characters');
  if (so) out.signOff = so;
  if (GREET_STYLES.includes(o.greet as GreetStyle)) out.greet = o.greet as GreetStyle;
  if (FACE_MODES.includes(o.face as FaceMode)) out.face = o.face as PersonaStyleFile['face'];
  return Object.keys(out).length ? out : undefined;
}
