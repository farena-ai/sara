// T54: the companion side, off and on again at any time (Settings → You → About you). Owner request
// (2026-11-27): "Sometimes people just need a harness for work and for coding, and the companion side
// gets in the way. There should be a switch to shut down the personality completely."
//
// Off: a plain work assistant. No personality, backstory, mood, day or relationship in her
// instructions; nothing sent on her own initiative as a companion (texting first, pictures of herself,
// the moments album, the yearly look-back, outfit changes, typed-like-a-person pauses); no adult mode;
// the companion parts of the screen are hidden. Kept: every tool, her memory in the same space (this is
// not the work profile, which has its own memory and a shorter tool list), research, coding, routing,
// reminders, the briefing (in plain words) and the whole safety layer.
// On again: everything is as it was. Nothing is deleted by the switch; her mood and day simply were
// not updated while it was off.
import { PLAIN, type Persona } from './persona.ts';

export interface CompanionSettings {
  on: boolean;
}

/** True when the owner switched the companion side off. */
export const companionOff = (s: { companion?: Partial<CompanionSettings> } | undefined): boolean => s?.companion?.on === false;

/** For an app: its own settings decide (a household member's space has its own). */
export const companionOffIn = (app: { settings: { get(): { companion?: Partial<CompanionSettings> } } }): boolean => companionOff(app.settings.get());

/** Tools that only make sense with the companion side: her selfies, her outfit, the moments album. */
export const COMPANION_TOOLS: ReadonlySet<string> = new Set(['take_photo', 'change_outfit', 'moments']);

/** The same sheet marked plain (a symbol: it is never saved with the persona and never sent anywhere). */
export function plainSheet(sheet: Persona): Persona {
  return { ...sheet, [PLAIN]: true } as Persona;
}

const stripped = (sheet: Persona): Persona => {
  if (!(PLAIN in (sheet as object))) return sheet;
  const { [PLAIN]: _gone, ...rest } = sheet as Persona & { [PLAIN]?: boolean };
  return rest as Persona;
};

/**
 * Every place that builds her instructions reads `app.persona`. With the switch off they all get the
 * plain sheet, so no caller can forget; an edit of her character while it is off is still saved as
 * it was written (the mark is taken off on the way in).
 */
export function installCompanionSwitch<T extends { persona: Persona; settings: { get(): { companion?: Partial<CompanionSettings> } } }>(app: T): T {
  let sheet = stripped(app.persona);
  Object.defineProperty(app, 'persona', {
    enumerable: true,
    configurable: true,
    get: () => (companionOff(app.settings.get()) ? plainSheet(sheet) : sheet),
    set: (next: Persona) => {
      sheet = stripped(next);
    },
  });
  return app;
}
