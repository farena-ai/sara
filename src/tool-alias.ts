// HANDSFREE (robustness): smaller models call tools that don't exist ("pc_read_text", "pc_browser_scroll_down").
// A name close to one real tool offered this turn runs that tool, with a note in its result; otherwise the
// error lists the real tools of that family so the next try is right.

/** Names models invent, mapped to the real tool (the first one offered this turn wins). */
const KNOWN: Record<string, string[]> = {
  pc_read_text: ['pc_browser_read', 'pc_look'],
  pc_read: ['pc_browser_read', 'pc_look'],
  pc_read_page: ['pc_browser_read'],
  pc_browser_text: ['pc_browser_read'],
  pc_browser_get_text: ['pc_browser_read'],
  pc_page_text: ['pc_browser_read'],
  pc_get_text: ['pc_browser_read', 'pc_look'],
  pc_screenshot: ['pc_look', 'pc_browser_look'],
  pc_screen: ['pc_look'],
  pc_see: ['pc_look'],
  pc_snapshot: ['pc_browser_look', 'pc_look'],
  pc_browser_snapshot: ['pc_browser_look'],
  pc_browser_screenshot: ['pc_browser_look'],
  pc_browser_view: ['pc_browser_look'],
  pc_open: ['pc_open', 'pc_browser_open'],
  pc_browser_goto: ['pc_browser_open'],
  pc_browser_go: ['pc_browser_open'],
  pc_navigate: ['pc_browser_open'],
  pc_goto: ['pc_browser_open'],
  pc_open_url: ['pc_browser_open'],
  pc_browser_press: ['pc_browser_keys'],
  pc_browser_key: ['pc_browser_keys'],
  pc_press: ['pc_keys'],
  pc_key: ['pc_keys'],
  pc_type_text: ['pc_type', 'pc_browser_type'],
  pc_browser_fill: ['pc_browser_type'],
  pc_fill: ['pc_browser_type'],
  pc_scroll_down: ['pc_scroll', 'pc_browser_scroll'],
  pc_scroll_up: ['pc_scroll', 'pc_browser_scroll'],
  pc_browser_scroll_down: ['pc_browser_scroll'],
  pc_browser_scroll_up: ['pc_browser_scroll'],
  pc_tabs: ['pc_my_tabs', 'pc_browser_tabs'],
  pc_list_tabs: ['pc_my_tabs', 'pc_browser_tabs'],
  pc_browser_list_tabs: ['pc_browser_tabs'],
  pc_list_windows: ['pc_windows'],
  pc_window: ['pc_windows'],
};
/** Extra arguments an invented name implies ("pc_scroll_down" → direction down). */
const IMPLIED: Record<string, Record<string, unknown>> = {
  pc_scroll_down: { direction: 'down' },
  pc_scroll_up: { direction: 'up' },
  pc_browser_scroll_down: { direction: 'down' },
  pc_browser_scroll_up: { direction: 'up' },
};

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0];
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j];
      d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length];
}

export interface AliasHit {
  name: string;
  args: Record<string, unknown>;
  note: string;
}

/**
 * The real tool for a name the model invented, from the tools offered this turn; or a "use one of
 * these" hint (`hint`) when nothing is close enough. Only names with a family prefix (pc_, browser_,
 * mail_…) are mapped; never across families.
 */
export function toolAlias(raw: string, offered: readonly string[], args: Record<string, unknown> = {}): AliasHit | { hint: string } | undefined {
  const name = String(raw ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!name || offered.includes(raw)) return undefined;
  const set = new Set(offered);
  const known = (KNOWN[name] ?? []).find((n) => set.has(n));
  const hit = (to: string): AliasHit => ({ name: to, args: { ...(IMPLIED[name] ?? {}), ...args }, note: `[Note: there is no tool "${raw.slice(0, 60)}"; this ran ${to} instead. Next time call ${to}.]` });
  if (known) return hit(known);
  if (offered.includes(name)) return hit(name);
  const family = /^([a-z]+_)/.exec(name)?.[1];
  if (!family) return undefined;
  const same = offered.filter((n) => n.startsWith(family));
  if (!same.length) return undefined;
  const scored = same.map((n) => ({ n, d: distance(name, n) })).sort((a, b) => a.d - b.d);
  if (scored[0].d <= 2 && (scored.length === 1 || scored[1].d > scored[0].d)) return hit(scored[0].n);
  return { hint: `There is no tool "${raw.slice(0, 60)}". Tools you can use for this: ${same.slice(0, 30).join(', ')}.` };
}
