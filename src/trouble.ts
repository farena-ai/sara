// 3.3.0 easy mode (ezfirst): she fixes or explains her own problems. One small pattern for the
// things a non-technical owner can't diagnose: her AI service is down, it rejected the key, the
// account is out of credit or busy, the model is gone, a mailbox signed her out, an add-on stopped.
// Each becomes one plain notice in her words that names the service, with ONE Fix it button (the
// Settings page that fixes it) and, for model trouble, Try again. The chat shows it under a failed
// reply, Today lists it under Needs you, and Health's Model line follows the real calls (a failed
// call since the last good one is not ✓). Nothing here calls a model or the network.
import type { AppContext } from './chat.ts';
import { en, fill } from './i18n.ts';
import { todayChanged } from './today.ts';

export type TroubleKind = 'unreachable' | 'key' | 'credit' | 'busy' | 'model' | 'mail' | 'addon';

export interface Trouble {
  /** Stable id (Today's "Not today" and de-dup): e.g. "model:ollama-cloud", "mail:m1". */
  id: string;
  kind: TroubleKind;
  /** The English template (the app shows it in the owner's language with `params`). */
  key: string;
  params: Record<string, string>;
  /** `key` filled in (English), for logs, Health and channels without the app. */
  text: string;
  /** The one fix: a button label (English template) and the Settings page it opens. */
  fix: { label: string; page: string };
  /** Model trouble can be tried again from the chat. */
  retry: boolean;
  at: string;
}

const FIX_IT = en('Fix it');
const SIGN_IN = en('Sign in again');

const MODEL_WORDS: Record<Exclude<TroubleKind, 'mail' | 'addon'>, string> = {
  unreachable: en('I can’t reach my AI service ({service}) right now, so I can’t answer. Check that your internet is working, then press Try again. If it keeps happening, Fix it shows the setting.'),
  key: en('{service} didn’t accept my key, so I can’t think right now. Fix it opens the place to paste a new key; then I’m back.'),
  credit: en('{service} says the account is out of credit or needs a paid plan. Add credit on their website, or pick another service with Fix it.'),
  busy: en('{service} is busy or its usage limit is reached for now. Wait a minute and press Try again, or pick a backup with Fix it.'),
  model: en('{service} doesn’t have the model I was set to use anymore. Fix it lets you pick another one.'),
};

/**
 * A provider error message (the plain sentences of src/providers/types.ts, a network failure, a
 * slow model) as a notice, or null when it isn't a service problem (stopped, empty message, …).
 */
export function troubleOf(message: string, service: string, id = 'model'): Trouble | null {
  const m = String(message ?? '');
  let kind: TroubleKind | null = null;
  if (/didn't accept the key|didn’t accept the key|\b401\b|\b403\b|invalid api key|unauthori[sz]ed|incorrect api key/i.test(m)) kind = 'key';
  else if (/needs credit|insufficient|quota|credit|billing|payment required|\b402\b/i.test(m)) kind = 'credit';
  else if (/busy or the usage limit|rate.?limit|too many requests|\b429\b|overloaded/i.test(m)) kind = 'busy';
  else if (/doesn't have the model|doesn’t have the model|model .*not found|no such model/i.test(m)) kind = 'model';
  else if (/couldn't reach|couldn’t reach|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|socket hang up|network|no answer within|had a problem on its side|\b50[0234]\b/i.test(m)) kind = 'unreachable';
  if (!kind) return null;
  const key = MODEL_WORDS[kind as keyof typeof MODEL_WORDS];
  // Plain words: "Ollama Cloud", not the picker's "Ollama Cloud (API key)".
  const params = { service: String(service).replace(/\s*\(API key\)$/i, '') };
  return { id, kind, key, params, text: fill(key, params), fix: { label: FIX_IT, page: kind === 'model' ? 'models-default' : 'models-providers' }, retry: true, at: new Date().toISOString() };
}

// ---------- the real calls: the last result per provider ----------

interface CallResult {
  ok: boolean;
  label: string;
  message: string;
  at: string;
}
const results = new WeakMap<object, Map<string, CallResult>>();
const resultsOf = (app: AppContext) => {
  let m = results.get(app);
  if (!m) results.set(app, (m = new Map()));
  return m;
};

/** Records one real model call: no `err` = it answered. */
export function noteCall(app: AppContext, provider: { id: string; label: string }, err?: unknown): void {
  if (!provider?.id) return;
  const message = err ? String((err as Error)?.message ?? err) : '';
  // A stop or an abort says nothing about the service.
  if (err && ((err as Error)?.name === 'AbortError' || /^(Stopped\.?|aborted|restart)$/i.test(message))) return;
  const map = resultsOf(app);
  const was = map.get(provider.id);
  map.set(provider.id, { ok: !err, label: provider.label || provider.id, message, at: app.now().toISOString() });
  // Today's Needs you shows it (or drops it) now, not when its cache runs out.
  if (Boolean(was && !was.ok) !== Boolean(err)) {
    try {
      todayChanged(app, 'needs');
    } catch {
      /* no Today here */
    }
  }
}

/** Providers whose latest real call failed with a service problem (last 6 hours), as notices. */
export function callTrouble(app: AppContext): Trouble[] {
  const now = app.now().getTime();
  const out: Trouble[] = [];
  for (const [id, r] of resultsOf(app)) {
    if (r.ok || now - Date.parse(r.at) > 6 * 3600_000) continue;
    const t = troubleOf(r.message, r.label, `model:${id}`);
    if (t) out.push({ ...t, at: r.at });
  }
  return out;
}

/** The default provider's trouble, if its latest real call failed (Health's Model line). */
export function modelHealth(app: AppContext): Trouble | null {
  const s = app.settings.get();
  const id = s.defaultProviderId ?? s.providers[0]?.id;
  return callTrouble(app).find((x) => x.id === `model:${id}`) ?? null;
}

// ---------- everything she can tell the owner about now ----------

/** Model trouble, mailboxes that signed her out and add-ons that stopped. Cheap; no calls. */
export function gatherTrouble(app: AppContext): Trouble[] {
  const at = app.now().toISOString();
  const out = callTrouble(app);
  if (app.google?.status().signedOut) {
    const key = en('{service} signed me out, so I can’t read or send that mail. Sign in again and I’ll pick up where I left off.');
    const params = { service: 'Gmail' };
    out.push({ id: 'mail:google', kind: 'mail', key, params, text: fill(key, params), fix: { label: SIGN_IN, page: 'ab-google' }, retry: false, at });
  }
  try {
    for (const a of (app.mailAccounts?.list() ?? []) as { id: string; address?: string; problem?: string }[]) {
      if (!a.problem) continue;
      const key = en('{service} signed me out, so I can’t read or send that mail. Sign in again and I’ll pick up where I left off.');
      const params = { service: a.address || 'Email' };
      out.push({ id: `mail:${a.id}`, kind: 'mail', key, params, text: fill(key, params), fix: { label: SIGN_IN, page: 'ab-mail' }, retry: false, at });
    }
  } catch {
    /* no mail here */
  }
  try {
    for (const p of (app.pluginManager?.list() ?? []) as { id: string; name?: string; status?: string }[]) {
      if (p.status !== 'crashed') continue;
      const key = en('The add-on {service} stopped working. Fix it shows what happened and lets you turn it back on.');
      const params = { service: p.name || p.id };
      out.push({ id: `addon:${p.id}`, kind: 'addon', key, params, text: fill(key, params), fix: { label: FIX_IT, page: 'ab-plugins' }, retry: false, at });
    }
  } catch {
    /* no add-ons here */
  }
  return out;
}
