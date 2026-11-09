// C8 (docs/ops/C8_DESIGN.md, docs/COSTS.md): add-on auto-update. Off by default; the owner turns it
// on for all of his Store plugins or one at a time (Get more → My add-ons). It rides the Sara Store's
// daily look at the signed index (src/store/client.ts): for each add-on with a newer verified
// version it stages the same review as the Update button, and
//   - never applies it when the new version asks for more permissions (or needs the "I trust the
//     author" tick): the owner is told and decides on the card, as before;
//   - otherwise installs it, health-checks it (its process starts and stays up), and on failure
//     rolls back to the kept version by itself; either way the owner is told.
// A version he was already asked about isn't asked again.
import { en } from './i18n.ts';
import type { Settings } from './settings.ts';

export interface AutoUpdateSettings {
  all: boolean;
  items: Record<string, boolean>;
  /** The version each add-on last asked about (so the owner is asked once per version). */
  asked: Record<string, string>;
  /** The last few outcomes (newest first), shown under the switch. */
  last: AutoOutcome[];
}
export interface AutoOutcome {
  item: string;
  name: string;
  from: string;
  to: string;
  outcome: 'updated' | 'asked' | 'rolled-back' | 'failed';
  why?: string;
  at: string;
}

const ITEM = /^[a-z0-9][a-z0-9-]{0,63}$/;
export function autoUpdateSettings(s: { addonAutoUpdate?: unknown } | undefined): AutoUpdateSettings {
  const v = (s?.addonAutoUpdate ?? {}) as Record<string, unknown>;
  const items: Record<string, boolean> = {};
  for (const [k, on] of Object.entries((v.items ?? {}) as Record<string, unknown>).slice(0, 200)) if (ITEM.test(k)) items[k] = on === true;
  const asked: Record<string, string> = {};
  for (const [k, ver] of Object.entries((v.asked ?? {}) as Record<string, unknown>).slice(0, 200)) if (ITEM.test(k) && typeof ver === 'string') asked[k] = ver.slice(0, 40);
  const last = (Array.isArray(v.last) ? v.last : []).slice(0, 20) as AutoOutcome[];
  return { all: v.all === true, items, asked, last };
}

/** On for this add-on: its own switch wins; otherwise the "all" switch. */
export function autoUpdateOn(a: AutoUpdateSettings, item: string): boolean {
  return a.items[item] ?? a.all;
}

/** A staged update as the auto-updater needs it (a plugin manager Review). */
export interface StagedUpdate {
  id: string;
  added: string[];
  needsTrust: boolean;
  firstParty?: boolean;
  manifest: { name: string; version: string };
}

export interface AutoUpdateDeps {
  settings: () => Settings;
  save: (patch: Partial<Settings>) => void;
  now: () => Date;
  /** Installed Store plugins with a newer verified version on the signed index. */
  candidates: () => { item: string; name: string; current: string; version: string }[];
  /** Stage the update review (the Update button's download, signature and fingerprint checks). */
  stage: (item: string) => Promise<StagedUpdate>;
  cancel: (reviewId: string) => void;
  /** Install the staged review (the same path as the card's Update, with the Store record kept). */
  apply: (review: StagedUpdate) => Promise<void>;
  healthy: (item: string) => Promise<{ ok: boolean; why?: string }>;
  rollback: (item: string) => Promise<void>;
  notify: (title: string, line: string) => void;
  /** Translate an English line for the owner (trOwner). */
  tr: (text: string, params?: Record<string, unknown>) => string;
}

/** One pass: called after each look at the Store index. Returns what happened (also kept in settings). */
export async function runAutoUpdates(d: AutoUpdateDeps): Promise<AutoOutcome[]> {
  const cfg = autoUpdateSettings(d.settings());
  const out: AutoOutcome[] = [];
  const asked = { ...cfg.asked };
  for (const c of d.candidates()) {
    if (!autoUpdateOn(cfg, c.item)) continue;
    const base = { item: c.item, name: c.name, from: c.current, to: c.version, at: d.now().toISOString() };
    let review: StagedUpdate;
    try {
      review = await d.stage(c.item);
    } catch (err) {
      out.push({ ...base, outcome: 'failed', why: (err as Error).message.slice(0, 200) });
      continue;
    }
    const to = review.manifest.version;
    if (review.added.length || (review.needsTrust && !review.firstParty)) {
      d.cancel(review.id);
      if (asked[c.item] === to) continue;
      asked[c.item] = to;
      out.push({ ...base, to, outcome: 'asked', why: review.added.length ? 'more permissions' : 'trust' });
      d.notify(d.tr(en('{name} {version} needs your OK'), { name: c.name, version: to }), review.added.length ? d.tr(en('This update asks for more permissions, so it was not installed by itself. Open Get more → My add-ons to look at it.')) : d.tr(en('This computer cannot fence add-ons in, so updates need your “I trust the author” tick. Open Get more → My add-ons.')));
      continue;
    }
    try {
      await d.apply(review);
    } catch (err) {
      d.cancel(review.id);
      out.push({ ...base, to, outcome: 'failed', why: (err as Error).message.slice(0, 200) });
      d.notify(d.tr(en('{name} was not updated'), { name: c.name }), d.tr(en('The automatic update to {version} failed: {why}'), { version: to, why: (err as Error).message.slice(0, 160) }));
      continue;
    }
    const h = await d.healthy(c.item).catch((err: Error) => ({ ok: false, why: err.message }));
    if (h.ok) {
      delete asked[c.item];
      out.push({ ...base, to, outcome: 'updated' });
      d.notify(d.tr(en('{name} updated to {version}'), { name: c.name, version: to }), d.tr(en('It updated by itself and is running. You can go back from Get more → My add-ons.')));
      continue;
    }
    try {
      await d.rollback(c.item);
      out.push({ ...base, to, outcome: 'rolled-back', ...(h.why ? { why: h.why } : {}) });
      d.notify(d.tr(en('{name} went back to {version}'), { name: c.name, version: c.current }), d.tr(en('The update to {version} did not work ({why}), so the earlier version was put back by itself.'), { version: to, why: d.tr(h.why ?? en('it did not start')) }));
    } catch (err) {
      out.push({ ...base, to, outcome: 'failed', why: `${h.why ?? 'unhealthy'}; going back failed: ${(err as Error).message}`.slice(0, 200) });
      d.notify(d.tr(en('{name} needs a look'), { name: c.name }), d.tr(en('The update to {version} did not work and going back failed. Open Get more → My add-ons.'), { version: to }));
    }
  }
  if (out.length || JSON.stringify(asked) !== JSON.stringify(cfg.asked)) {
    const cur = autoUpdateSettings(d.settings());
    d.save({ addonAutoUpdate: { all: cur.all, items: cur.items, asked, last: [...out, ...cur.last].slice(0, 20) } as never });
  }
  return out;
}
