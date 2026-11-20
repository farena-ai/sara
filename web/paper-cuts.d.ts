// Types for web/paper-cuts.js (P3FIXES), for the tests.
export const DRAFT_KEY: string;
export const DRAFT_MAX: number;
export interface DraftStorage { getItem(k: string): string | null; setItem(k: string, v: string): void }
export class Drafts {
  constructor(storage: DraftStorage | undefined);
  get(id: string | null | undefined): string;
  set(id: string | null | undefined, text: string, now?: number): void;
}
export function msgWhen(d: Date, now: Date, loc: string): string;
export function menuKeys(menu: any, e: { key: string; preventDefault(): void; stopPropagation(): void }, active?: unknown): boolean;
export function extraShortcut(e: { key?: string; code?: string; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean; altKey?: boolean }): 'new' | 'focus' | null;
export function busy<T>(btn: { disabled: boolean; setAttribute?(k: string, v: string): void; removeAttribute?(k: string): void } | null | undefined, fn: () => Promise<T> | T): Promise<T | undefined>;
