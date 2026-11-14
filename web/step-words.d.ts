// Phase 115: types for web/step-words.js (the server imports it for the progress message).
export function stepWordsWith(t: (text: string, params?: Record<string, unknown>) => string, name: string, args?: Record<string, unknown>, named?: string): [string, string, string];
export function stoppedByPerson(x: { status?: string; stopped?: boolean; output?: unknown } | null | undefined): boolean;
