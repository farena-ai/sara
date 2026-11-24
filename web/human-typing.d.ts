export const TYPING_KEY: string;
export const PAUSE: { minMs: number; perChar: number; maxMs: number; longReply: number; minPart: number; tail: number; partMs: number; parts: number };
export function startPause(chars: number): number;
export function typingOn(o: { choice: string | null | undefined; coding?: boolean; voice?: boolean; reducedMotion?: boolean }): boolean;
export function partBreaks(text: string): number[];
