// R4: types for web/ios-web.js (the tests import it).
export function isIOS(ua?: string, maxTouchPoints?: number): boolean;
export function isStandalone(win?: unknown): boolean;
export function inSaraApp(ua?: string): boolean;
export function needsInstallGuide(o?: { ua?: string; maxTouchPoints?: number; standalone?: boolean }): boolean;
export function pushPossible(o?: { ua?: string; maxTouchPoints?: number; standalone?: boolean; hasPush?: boolean }): boolean;
export function badgeValue(n: unknown): number;
export function applyBadge(nav: unknown, n: unknown): Promise<number | null>;
