export const ENTER_KEY: string;
type Store = { getItem(k: string): string | null; setItem?(k: string, v: string): void };
export function enterSendsOn(store?: Store): boolean;
export function setEnterSends(on: boolean, store?: Store): void;
export function enterAction(e: { key?: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number } | null, on: boolean): 'send' | null;
export function enterSend(box: unknown, send: (e: any) => void, opts?: { multiline?: boolean; store?: Store }): void;
