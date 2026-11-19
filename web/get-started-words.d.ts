// R2: types for web/get-started-words.js (test/r2-get-started-web.test.ts imports it).
type T = (s: string, v?: Record<string, unknown>) => string;
export const STEP_IDS: string[];
export const PACK_IDS: string[];
export const SAMPLE_IDS: string[];
export function stepWords(id: string, t: T): { title: string; text: string; go: string; page: string };
export function guideWords(t: T): Record<string, string> & { count: (n: number, total: number) => string; today: (done: number, total: number) => string };
export function packWords(id: string, t: T): { title: string; text: string };
export function routineName(name: string | undefined, t: T): string;
export function packResultWords(r: { pack: string | null; added: number[]; kept: number[] } | undefined, t: T): string;
export function sampleWords(card: { kind: string; day: string }, t: T, day?: (iso: string) => string): { title: string; text: string; icon: string } | undefined;
export function sampleSectionWords(t: T): Record<string, string>;
export function sampleTour(t: T): { sel: string; title: string; text: string }[];
// W2.2 the first ten minutes.
export const PATH_IDS: string[];
export function pathWords(id: string, t: T): { title: string; text: string };
export function modelWords(t: T): Record<string, string & ((...a: never[]) => string)> & { machine: string };
export function chatWords(t: T): Record<string, unknown>;
export const WIN_IDS: string[];
export function winWords(win: { id: string; app?: string; note?: string }, t: T): { title: string; prompt: string };
export function winsWords(t: T): { title: string; text: string };
