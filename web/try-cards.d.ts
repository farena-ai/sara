// E7: types for web/try-cards.js (test/e7-ready.test.ts imports it).
export const TRY_DONE_KEY: string;
export interface TryCardDef { id: string; icon: string; tools: string[]; prefix: string[]; title: string; text: string; message: string }
export const TRY_CARDS: TryCardDef[];
export interface TryCard { id: string; icon: string; title: string; text: string; message: string }
export function tryCards(o: { tools?: string[]; path?: string; done?: Set<string>; t?: (s: string) => string }): TryCard[];
type Storage = { getItem(k: string): string | null; setItem(k: string, v: string): void };
export function triedSet(storage?: Storage): Set<string>;
export function markTried(storage: Storage | undefined, id: string): void;
