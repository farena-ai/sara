// R1 (c): Settings → Privacy & system → Health → "Check everything". One click, plain lines: does mail read,
// can a draft be made and removed (with consent), does the calendar read and take a test event (consent),
// does a test notification reach each phone (consent), is the desktop app connected and current and can it
// list windows (read-only, no actions), the Mac tabs switch, the inbox helper's last scan, the last
// automation run, and what Auto picks for talking and how fast. Each line: ok / needs attention, a one-line
// fix and the Settings page that fixes it. Text is English keys with {params} (web translates with t()).
// Nothing here reads message contents: counts, addresses of the owner's own mailboxes and model names only.
import type { MailAccountInfo, MailProvider } from './mail/types.ts';
import type { SearchTerms } from './mail/search.ts';
import type { HandsDeviceView, HandsReply } from './hands.ts';
import type { AppInstallView } from './app-installs.ts';
import { en } from './i18n.ts';

export type SelfTestStatus = 'ok' | 'attention' | 'skipped';
export interface SelfTestLine {
  id: string;
  area: string;
  status: SelfTestStatus;
  text: string;
  params?: Record<string, string | number>;
  fix?: string;
  /** The Settings page that fixes it. */
  page?: string;
}
export interface SelfTestConsent {
  /** Make a draft to yourself and remove it again. */
  draft?: boolean;
  /** Add a 5-minute test event and remove it again. */
  event?: boolean;
  /** Send a test notification to each phone. */
  push?: boolean;
}
export interface SelfTestDeps {
  now: () => Date;
  timeZone: string;
  mail?: { list(): MailAccountInfo[]; provider(id: string): MailProvider };
  google?: { status(): { connected?: boolean; gmail?: boolean; calendar?: boolean; email?: string }; api(url: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<unknown> };
  push?: { list(): { endpoint: string; label: string }[]; sendAll(p: { title: string; body: string; url: string; tag?: string }): Promise<{ sent: number; failed: number; removed: number }> };
  hands?: { devices(): HandsDeviceView[]; request(deviceId: string, op: string, args?: Record<string, unknown>, opts?: { deadlineMs?: number; what?: string }): Promise<HandsReply> };
  apps?: () => AppInstallView[];
  serverVersion?: string;
  inbox?: () => { lastScan: { at: string; problems: string[] } | null } | undefined;
  lastAutomation?: () => { name: string; at: string; outcome: string } | undefined;
  auto?: () => { model: string; provider: string; why?: string; firstMs?: number; auto: boolean } | undefined;
}

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const GCAL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
export const SELF_TEST_SUBJECT = 'Sara self-test (safe to delete)';
const TERMS: SearchTerms = { from: [], to: [], subject: [], words: [], notFrom: [], notWords: [], folder: 'inbox' };
const why = (e: unknown) => String((e as Error)?.message ?? e).split('\n')[0]!.slice(0, 160);
const ago = (now: Date, at: string) => {
  const h = (now.getTime() - Date.parse(at)) / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} d`;
};
const within = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`no answer within ${Math.round(ms / 1000)} seconds`)), ms).unref?.())]);

export async function runSelfTest(d: SelfTestDeps, consent: SelfTestConsent = {}): Promise<SelfTestLine[]> {
  const out: SelfTestLine[] = [];
  const now = d.now();
  const add = (l: SelfTestLine) => out.push(l);
  const MAIL = en('Mail');
  const CAL = en('Calendar');

  // ---- mail and calendar, per mailbox ----
  const boxes = d.mail?.list() ?? [];
  if (!boxes.length) add({ id: 'mail', area: MAIL, status: 'attention', text: en('No mailbox is connected.'), fix: en('Connect Gmail, Outlook or another mailbox.'), page: 'ab-mail' });
  for (const box of boxes) {
    const p = { address: box.address };
    if (box.problem) {
      add({ id: `mail:${box.id}`, area: MAIL, status: 'attention', text: en('{address}: signed out.'), params: p, fix: en('Sign in to this mailbox again.'), page: 'ab-mail' });
      continue;
    }
    const google = box.kind === 'google';
    // 1. read one message
    try {
      let n = 0;
      if (google) n = ((await within(d.google!.api(`${GMAIL}/messages?maxResults=1&labelIds=INBOX`), 20_000)) as { messages?: unknown[] }).messages?.length ?? 0;
      else {
        const prov = d.mail!.provider(box.id);
        const r = await within(prov.searchIds(TERMS, 1), 20_000);
        n = r.ids.length ? (await within(prov.list(r.ids.slice(0, 1)), 20_000)).length : 0;
      }
      add({ id: `mail:${box.id}`, area: MAIL, status: 'ok', text: n ? en('{address}: reads mail (the newest inbox message came back).') : en('{address}: signed in; the inbox is empty.'), params: p });
    } catch (e) {
      add({ id: `mail:${box.id}`, area: MAIL, status: 'attention', text: en('{address}: could not read mail ({why}).'), params: { ...p, why: why(e) }, fix: en('Sign in to this mailbox again, then run the check again.'), page: 'ab-mail' });
      continue;
    }
    // 2. a draft made and removed (consent)
    if (!consent.draft) add({ id: `draft:${box.id}`, area: MAIL, status: 'skipped', text: en('{address}: draft test not run (tick “Make and remove a test draft”).'), params: p });
    else {
      try {
        if (google) {
          const raw = Buffer.from(`To: ${box.address}\r\nSubject: ${SELF_TEST_SUBJECT}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSara made this draft to test the mailbox. It is removed right away.\r\n`).toString('base64url');
          const r = (await within(d.google!.api(`${GMAIL}/drafts`, { method: 'POST', body: { message: { raw } } }), 20_000)) as { id?: string };
          if (!r.id) throw new Error('Gmail gave no draft id');
          await within(d.google!.api(`${GMAIL}/drafts/${encodeURIComponent(r.id)}`, { method: 'DELETE' }), 20_000);
          add({ id: `draft:${box.id}`, area: MAIL, status: 'ok', text: en('{address}: made a draft and removed it again.'), params: p });
        } else {
          const prov = d.mail!.provider(box.id);
          const id = await within(prov.draft({ to: box.address, subject: SELF_TEST_SUBJECT, body: 'Sara made this draft to test the mailbox. It is removed right away.' }), 30_000);
          if (prov.discardDraft) {
            await within(prov.discardDraft(id), 20_000);
            add({ id: `draft:${box.id}`, area: MAIL, status: 'ok', text: en('{address}: made a draft and removed it again.'), params: p });
          } else add({ id: `draft:${box.id}`, area: MAIL, status: 'ok', text: en('{address}: made a draft. This mailbox cannot remove it for her: delete “{subject}” from Drafts.'), params: { ...p, subject: SELF_TEST_SUBJECT } });
        }
      } catch (e) {
        add({ id: `draft:${box.id}`, area: MAIL, status: 'attention', text: en('{address}: could not make a draft ({why}).'), params: { ...p, why: why(e) }, fix: en('Sign in again and accept every permission.'), page: 'ab-mail' });
      }
    }
    // 3. calendar read + a test event (consent)
    const hasCal = google ? Boolean(d.google?.status().calendar) : Boolean(box.calendar && d.mail!.provider(box.id).calendar);
    if (!hasCal) continue;
    try {
      const from = new Date(now.getTime());
      const to = new Date(now.getTime() + 7 * 86_400_000);
      const n = google
        ? (((await within(d.google!.api(`${GCAL}?maxResults=5&singleEvents=true&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}`), 20_000)) as { items?: unknown[] }).items?.length ?? 0)
        : (await within(d.mail!.provider(box.id).calendar!.events(from, to, undefined), 20_000)).length;
      add({ id: `cal:${box.id}`, area: CAL, status: 'ok', text: en('{address}: reads the calendar ({n} events in the next 7 days).'), params: { ...p, n } });
    } catch (e) {
      add({ id: `cal:${box.id}`, area: CAL, status: 'attention', text: en('{address}: could not read the calendar ({why}).'), params: { ...p, why: why(e) }, fix: en('Sign in again and allow the calendar.'), page: 'ab-mail' });
      continue;
    }
    if (!consent.event) {
      add({ id: `event:${box.id}`, area: CAL, status: 'skipped', text: en('{address}: test event not added (tick “Add and remove a test event”).'), params: p });
      continue;
    }
    try {
      const start = new Date(Math.ceil((now.getTime() + 86_400_000) / 3_600_000) * 3_600_000);
      const end = new Date(start.getTime() + 5 * 60_000);
      if (google) {
        const ev = (await within(d.google!.api(GCAL, { method: 'POST', body: { summary: SELF_TEST_SUBJECT, start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() } } }), 20_000)) as { id?: string };
        if (!ev.id) throw new Error('Google gave no event id');
        await within(d.google!.api(`${GCAL}/${encodeURIComponent(ev.id)}?sendUpdates=none`, { method: 'DELETE' }), 20_000);
      } else {
        const cal = d.mail!.provider(box.id).calendar!;
        const ev = await within(cal.add({ title: SELF_TEST_SUBJECT, start: start.toISOString(), end: end.toISOString(), allDay: false, guests: [], timeZone: 'UTC' }), 20_000);
        await within(cal.remove(ev.id), 20_000);
      }
      add({ id: `event:${box.id}`, area: CAL, status: 'ok', text: en('{address}: added a test event and removed it again.'), params: p });
    } catch (e) {
      add({ id: `event:${box.id}`, area: CAL, status: 'attention', text: en('{address}: could not add a test event ({why}).'), params: { ...p, why: why(e) }, fix: en('Sign in again and allow the calendar.'), page: 'ab-mail' });
    }
  }

  // ---- phone notifications ----
  const PHONE = en('Phone');
  const subs = d.push?.list() ?? [];
  if (!subs.length) add({ id: 'push', area: PHONE, status: 'attention', text: en('No phone gets notifications yet.'), fix: en('On your phone, open Sara and turn on notifications.'), page: 'co-phone' });
  else if (!consent.push) add({ id: 'push', area: PHONE, status: 'skipped', text: en('{n} phones get notifications; test not sent (tick “Send a test notification”).'), params: { n: subs.length } });
  else {
    try {
      const r = await within(d.push!.sendAll({ title: 'Sara', body: 'Test notification from Check everything.', url: '/#settings=dh-health', tag: 'self-test' }), 30_000);
      add(r.failed || r.removed
        ? { id: 'push', area: PHONE, status: 'attention', text: en('Test notification: {sent} sent, {failed} failed.'), params: { sent: r.sent, failed: r.failed + r.removed }, fix: en('On the phone that got nothing, turn notifications off and on again.'), page: 'co-phone' }
        : { id: 'push', area: PHONE, status: 'ok', text: en('Test notification sent to {sent} phones. Check that each one shows it.'), params: { sent: r.sent } });
    } catch (e) {
      add({ id: 'push', area: PHONE, status: 'attention', text: en('Test notification failed ({why}).'), params: { why: why(e) }, fix: en('On your phone, turn notifications off and on again.'), page: 'co-phone' });
    }
  }

  // ---- the desktop apps ----
  const PC = en('Desktop app');
  const devices = d.hands?.devices() ?? [];
  const apps = d.apps?.() ?? [];
  if (!devices.length && !apps.length) add({ id: 'desktop', area: PC, status: 'attention', text: en('No Sara desktop app is connected.'), fix: en('Install the Sara app on your computer and sign in.'), page: 'desktop-app' });
  for (const a of apps) {
    const p = { computer: a.computer || a.label || a.platform, version: a.version, latest: d.serverVersion ?? '' };
    add(a.behind
      ? { id: `app:${a.id}`, area: PC, status: 'attention', text: en('{computer}: Sara app {version}, this server is {latest}.'), params: p, fix: en('Update the app (Devices and sign-in → Update it).'), page: 'dh-devices' }
      : { id: `app:${a.id}`, area: PC, status: 'ok', text: en('{computer}: Sara app {version} is current.'), params: p });
  }
  for (const dev of devices) {
    const p = { computer: dev.computer || dev.label };
    if (!dev.connected) {
      add({ id: `pc:${dev.id}`, area: PC, status: 'attention', text: en('{computer}: the app is not connected now.'), params: p, fix: en('Open the Sara app on that computer (it may be closed or asleep).'), page: 'co-computer' });
      continue;
    }
    if (!dev.optIn?.desktop || !dev.ops?.includes('d.windows')) {
      add({ id: `pc:${dev.id}`, area: PC, status: 'ok', text: en('{computer}: connected; desktop look is off there.'), params: p });
    } else {
      try {
        const r = await within(d.hands!.request(dev.id, 'd.windows', {}, { deadlineMs: 10_000, what: 'Check everything: list windows' }), 12_000);
        const list = (r as { result?: { windows?: unknown[] } }).result?.windows;
        add({ id: `pc:${dev.id}`, area: PC, status: 'ok', text: en('{computer}: connected; lists {n} windows (nothing was clicked).'), params: { ...p, n: Array.isArray(list) ? list.length : 0 } });
      } catch (e) {
        add({ id: `pc:${dev.id}`, area: PC, status: 'attention', text: en('{computer}: connected but could not list windows ({why}).'), params: { ...p, why: why(e) }, fix: en('Check the app’s permissions there, then run the check again.'), page: 'co-computer' });
      }
    }
    if (/mac/i.test(dev.os ?? '')) {
      const tabs = dev.optIn?.tabs;
      add(tabs
        ? { id: `tabs:${dev.id}`, area: PC, status: 'ok', text: en('{computer}: “Let Sara see my tabs” is on.'), params: p }
        : { id: `tabs:${dev.id}`, area: PC, status: 'attention', text: tabs === false ? en('{computer}: “Let Sara see my tabs” is off.') : en('{computer}: this Mac app cannot share tabs yet.'), params: p, fix: tabs === false ? en('Turn it on in the Sara app on the Mac, then allow Automation when macOS asks.') : en('Update the Sara app on the Mac.'), page: 'co-computer' });
    }
  }

  // ---- background helpers ----
  const BG = en('Helpers');
  const ib = d.inbox?.();
  if (ib) {
    const s = ib.lastScan;
    add(!s
      ? { id: 'inbox', area: BG, status: 'attention', text: en('The inbox helper has not scanned yet.'), fix: en('Connect a mailbox and turn on the inbox helper.'), page: 'ab-mail' }
      : s.problems.length
        ? { id: 'inbox', area: BG, status: 'attention', text: en('Inbox helper: last scan {ago} ago, with {n} problems.'), params: { ago: ago(now, s.at), n: s.problems.length }, fix: en('Open Email and calendar to see which mailbox failed.'), page: 'ab-mail' }
        : { id: 'inbox', area: BG, status: Date.parse(s.at) < now.getTime() - 2 * 86_400_000 ? 'attention' : 'ok', text: en('Inbox helper: last scan {ago} ago.'), params: { ago: ago(now, s.at) }, ...(Date.parse(s.at) < now.getTime() - 2 * 86_400_000 ? { fix: en('Sign in to your mailbox again.'), page: 'ab-mail' } : {}) });
  }
  const au = d.lastAutomation?.();
  if (au) {
    const bad = au.outcome === 'failed';
    add({ id: 'automations', area: BG, status: bad ? 'attention' : 'ok', text: bad ? en('Last automation “{name}” failed {ago} ago.') : en('Last automation “{name}” ran {ago} ago ({outcome}).'), params: { name: au.name.slice(0, 60), ago: ago(now, au.at), outcome: au.outcome }, ...(bad ? { fix: en('Open Automations and look at that run.'), page: 'you-automations' } : {}) });
  }

  // ---- models ----
  const M = en('Models');
  const a = d.auto?.();
  if (!a) add({ id: 'auto', area: M, status: 'attention', text: en('No model is ready for talking.'), fix: en('Connect a model provider.'), page: 'models-providers' });
  else {
    const slow = a.firstMs !== undefined && a.firstMs > 20_000;
    const p = { model: `${a.provider} (${a.model})`, s: a.firstMs !== undefined ? Math.max(1, Math.round(a.firstMs / 1000)) : '?' };
    add({ id: 'auto', area: M, status: slow ? 'attention' : 'ok', text: a.firstMs === undefined ? (a.auto ? en('Auto picks {model} for talking (no speed measured yet).') : en('{model} answers when you talk (no speed measured yet).')) : a.auto ? en('Auto picks {model} for talking: first word in {s} s here.') : en('{model} answers when you talk: first word in {s} s here.'), params: p, ...(slow ? { fix: en('Pick a faster model or turn on Auto.'), page: 'models-routes' } : {}) });
  }
  return out;
}

/** The plain report for a support request (English, no message contents). */
export function formatSelfTest(lines: SelfTestLine[], version = ''): string {
  const fill = (s: string, p?: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => (p && p[k] !== undefined ? String(p[k]) : m));
  const mark = { ok: 'OK', attention: 'NEEDS ATTENTION', skipped: 'not run' } as const;
  return [`Sara check everything${version ? ` (Sara ${version})` : ''}`, ...lines.map((l) => `- [${mark[l.status]}] ${l.area}: ${fill(l.text, l.params)}${l.fix ? ` Fix: ${l.fix}` : ''}`)].join('\n');
}
