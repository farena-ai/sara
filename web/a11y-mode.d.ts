export interface A11yState { on: boolean; read: 'easy' | 'normal'; lineFocus: boolean; reduceMotion: boolean; large: boolean }
export const KEYS: { on: string; read: string; lineFocus: string; reduceMotion: string; large: string };
export function a11yState(get: (k: string) => string | null): A11yState;
export function applyA11y(root: unknown, s: A11yState): void;
export function switchAll(on: boolean, get: (k: string) => string | null): { set: Record<string, string>; remove: string[] };
export function accessKeys(a: A11yState): Record<string, string>;
export function refreshA11y(): A11yState | undefined;
export function initA11y(o?: { after?: () => void }): void;
export function currentAccess(): A11yState;
export function adoptAccess(a: unknown): void;
export function nameDialogs(root: unknown): number;
