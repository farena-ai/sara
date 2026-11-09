// V4e: types for web/movein-wizard.js (the tests import its pure helpers).
export const STEPS: readonly string[];
export const SOURCES: Record<string, { flag: string }>;
export const SYSTEMS: readonly string[];
export const COLLECTOR_FALLBACK: string;
export const EXAMPLE_OUTPUT: string;
export function guessSystem(nav?: unknown): 'windows' | 'mac' | 'linux';
export function collectorCommand(o: { origin: string; sha: string; system: string; source: string }): string;
export function fallbackCommand(o: { system: string; source: string }): string;
export function stepForState(state: string | null | undefined): 'check' | 'done' | null;
