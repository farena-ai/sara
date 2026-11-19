// V4.5 Screen companion (docs/design/V4SCREEN.md). Opt-in and local only: the Windows app looks at the
// window in front every few seconds (its title and short texts, read on the computer through UI
// Automation), and when an error dialog or a form that stays stuck shows, offers help in one small
// bubble. This file is the reference for those rules; the app ports them as fixed lists
// (desktop/windows/src/screen-watch.cpp, kept equal by test/v4-screen.test.ts, which also runs the test build's
// ScreenWatchChecks on the same fake screens). Rules:
// - never a window hidden from Sara (password managers, banking, the person's own list) or her own;
// - only short texts (labels, messages: at most 300 characters each) count, so a document or a web
//   page that mentions an error is not one;
// - an error = a dialog with an error word, or a window whose title says it is not responding;
//   a stuck form = a form message (\"is required\", \"invalid\") still there after three looks;
// - one offer per thing seen (remembered as a number, never as text), at most one every 2 minutes,
//   none while paused or switched off (the default);
// - nothing is written or sent: the offer goes to the bubble on that computer, and only \"Help with
//   this\" puts the line into the quick-ask box, where the person still presses Ask.
import { maskDesktopText } from './hands-desktop.ts';

export interface ScreenLook {
  title: string;
  app: string;
  /** A dialog box (a classic #32770 dialog or a small owned pop-up). */
  dialog: boolean;
  /** Names of the window's controls (labels, messages, buttons), never typed values or password fields. */
  texts: string[];
  /** The window is hidden from Sara (blockedKind). */
  hidden?: string;
  /** One of Sara's own windows. */
  own?: boolean;
}
export interface ScreenFinding {
  kind: 'error' | 'form';
  line: string;
}
export interface ScreenOffer extends ScreenFinding {
  app: string;
}

export const SCREEN_WATCH = { everyMs: 5000, cooldownMs: 120000, stuckChecks: 3, maxTexts: 80, maxTextLen: 300, lineLen: 160, remember: 64 } as const;

/** An error shown in a dialog (English, Spanish, French, German, Portuguese, Italian). Lower case. */
export const ERROR_WORDS: readonly string[] = [
  'error', 'failed', 'failure', 'could not', "couldn't", 'cannot', "can't", 'unable to', 'exception', 'has stopped working',
  'something went wrong', 'access is denied', 'access denied', 'permission denied', 'timed out', 'not found', 'crashed', 'fatal',
  'no se pudo', 'no se puede', 'falló', 'ha fallado', 'acceso denegado',
  'erreur', 'échec', 'impossible de', 'a échoué', 'accès refusé',
  'fehler', 'fehlgeschlagen', 'konnte nicht', 'kann nicht', 'zugriff verweigert',
  'erro', 'falhou', 'falha', 'não foi possível', 'acesso negado',
  'errore', 'impossibile', 'non è stato possibile', 'accesso negato',
];
/** A form that is waiting for something. Lower case. */
export const FORM_WORDS: readonly string[] = [
  'required', 'is missing', 'please enter', 'please fill', 'must be', 'invalid', 'not valid', 'incorrect',
  'obligatorio', 'no es válido', 'obligatoire', "n'est pas valide", 'erforderlich', 'pflichtfeld', 'ungültig',
  'obrigatório', 'inválido', 'obbligatorio', 'non valido',
];
/** A window title saying the program hangs. Lower case. */
export const HANG_WORDS: readonly string[] = ['not responding', 'no responde', 'ne répond pas', 'reagiert nicht', 'não responde', 'non risponde'];

const wordChar = (c: string | undefined) => Boolean(c && /[\p{L}\p{N}]/u.test(c));
const fold = (s: string) => s.toLowerCase().replace(/[\u2018\u2019]/g, "'");

/** One of the words, as a whole word (no letter or digit right before or after). */
export function hasWord(text: string, words: readonly string[]): boolean {
  const t = fold(text);
  for (const w of words) {
    for (let i = t.indexOf(w); i >= 0; i = t.indexOf(w, i + 1)) {
      if (!wordChar(t[i - 1]) && !wordChar(t[i + w.length])) return true;
    }
  }
  return false;
}

const tidy = (s: string) => String(s ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim();
const cut = (s: string) => {
  const m = maskDesktopText(s);
  return m.length > SCREEN_WATCH.lineLen ? m.slice(0, SCREEN_WATCH.lineLen - 1) + '…' : m;
};

/** What one look at a window finds: an error, a form message, or nothing. */
export function screenFinding(look: ScreenLook): ScreenFinding | undefined {
  if (look.own || look.hidden) return undefined;
  const title = tidy(look.title);
  const texts = (look.texts ?? []).slice(0, SCREEN_WATCH.maxTexts).map(tidy).filter((t) => t && t.length <= SCREEN_WATCH.maxTextLen);
  if (look.dialog) {
    const e = [...texts, title].find((t) => t && hasWord(t, ERROR_WORDS));
    if (e) return { kind: 'error', line: cut(e) };
  }
  if (title && hasWord(title, HANG_WORDS)) return { kind: 'error', line: cut(title) };
  const f = texts.find((t) => hasWord(t, FORM_WORDS));
  if (f) return { kind: 'form', line: cut(f) };
  return undefined;
}

/** FNV-1a over UTF-16 code units (the app hashes its wchar_t text the same way). */
export function screenHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The watch: switched off by default; one offer per thing seen; pause; a cool-down. Memory only. */
export class ScreenWatch {
  on = false;
  #pausedUntil = 0;
  #lastOffer = -Infinity;
  readonly #offered: number[] = [];
  #streak = { fp: 0, n: 0 };

  pause(ms: number, now: number): void { this.#pausedUntil = ms > 0 ? now + ms : 0; }
  pausedFor(now: number): number { return Math.max(0, this.#pausedUntil - now); }
  /** All it keeps (for the test that nothing readable is kept). */
  memory(): { offered: number[]; streak: { fp: number; n: number } } { return { offered: [...this.#offered], streak: { ...this.#streak } }; }

  check(look: ScreenLook, now: number): ScreenOffer | undefined {
    const f = this.on && now >= this.#pausedUntil ? screenFinding(look) : undefined;
    if (!f) {
      this.#streak = { fp: 0, n: 0 };
      return undefined;
    }
    const app = tidy(look.app).slice(0, 80);
    const fp = screenHash(`${f.kind}\n${app}\n${f.line}`);
    this.#streak = this.#streak.fp === fp ? { fp, n: this.#streak.n + 1 } : { fp, n: 1 };
    if (f.kind === 'form' && this.#streak.n < SCREEN_WATCH.stuckChecks) return undefined;
    if (this.#offered.includes(fp) || now - this.#lastOffer < SCREEN_WATCH.cooldownMs) return undefined;
    this.#offered.push(fp);
    if (this.#offered.length > SCREEN_WATCH.remember) this.#offered.shift();
    this.#lastOffer = now;
    return { kind: f.kind, app, line: f.line };
  }
}
