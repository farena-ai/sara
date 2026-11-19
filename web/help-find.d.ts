// Types for web/help-find.js (W2.5 help search).
export interface HelpHit {
  i: string;
  k: string;
  t: string;
  x: string;
  p?: string;
  l: string;
  s?: string;
  a?: string;
  c?: string;
  te?: string;
  e?: number;
}
export const HELP_LANGS: string[];
export function foldHelp(s: string): string;
export function loadHelpIndex(lang?: string, fetcher?: (u: string) => Promise<Response>): Promise<HelpHit[]>;
export function prepareHelp(entries: HelpHit[]): HelpHit[];
export function searchHelp(prepared: HelpHit[], query: string, limit?: number): HelpHit[];
export function renderHelpHits(box: unknown, hits: HelpHit[], o?: Record<string, unknown>): void;
export function settingsTarget(link: string): { page: string; howto: string; show: string } | null;
export function initHelpFind(ctx: Record<string, unknown>): void;
