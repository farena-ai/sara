// V4e: types for web/v4-motion.js (the tests import its pure helpers).
export type NumberParts = [prefix: string, value: number, decimals: number, suffix: string];
export function numberParts(text: unknown): NumberParts | null;
export function countFrame(parts: NumberParts | null, p: number): string;
export function motionOn(root?: HTMLElement | null, mm?: (query: string) => { matches: boolean }): boolean;
export function initMotion(doc?: Document): unknown;
