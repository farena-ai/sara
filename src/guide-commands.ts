// Phase 128 (PL2b, docs/design/POLISH2.md §4.3): the app's / menu table in docs/CHATS.md, generated
// from APP_MENU (src/bridges/commands.ts) by scripts/gen-guide.ts; test/phase128b checks it matches.
import { appMenuTable } from './bridges/commands.ts';

export const APPMENU_START = '<!-- appmenu:start -->';
export const APPMENU_END = '<!-- appmenu:end -->';

/** docs/CHATS.md with its / menu table replaced (or the same text when it already matches). */
export function withAppMenuTable(md: string): string {
  const a = md.indexOf(APPMENU_START);
  const b = md.indexOf(APPMENU_END);
  if (a < 0 || b < a) throw new Error('CHATS.md has no appmenu markers');
  return `${md.slice(0, a + APPMENU_START.length)}\n${appMenuTable()}\n${md.slice(b)}`;
}
