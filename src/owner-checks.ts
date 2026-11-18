// U1.5 (docs/TRY_THESE.md): "Try these", a guided owner checklist inside the app. A short curated
// list of plain "try this" items drawn from the newest docs/OWNER_CHECKS.md (3.15-3.18.2), each with
// 1-3 steps, a deep link that opens the exact place (a `#view=` hash or a prefilled chat message),
// and what you should see. The owner marks each Worked / Didn't work / Skip with an optional note;
// results live in <data>/owner-checks.json. The owner can export them as Markdown or, once they turn
// sending on (off by default), send them to the developer as one report through the existing hub
// ticket path (src/hub.ts fileTicket: scrubbed, and the preview is the exact body).
// Text is English here (en() keys); the web translates titles, steps and what to expect by key.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { en } from './i18n.ts';

export type CheckResult = 'worked' | 'failed' | 'skipped';
export const CHECK_RESULTS: readonly CheckResult[] = ['worked', 'failed', 'skipped'];

export interface OwnerCheck {
  id: string;
  release: string;
  title: string;
  steps: string[];
  /** "Take me there": a hash the app opens (`#view=settings:<page>` or `#view=<place>`)… */
  view?: string;
  /** …or a message she gets in a new chat (the owner presses Send). */
  ask?: string;
  expect: string;
}

/** Newest first in the app; every release here has at least one item (test/u1check-owner-checks). */
export const CHECK_RELEASES = ['3.15.0', '3.16.0', '3.17.0', '3.18.0', '3.18.1', '3.18.2'];

export const CHECKS: OwnerCheck[] = [
  // 3.18.2
  { id: 'google-several', release: '3.18.2', title: en('Add a second Google account'), steps: [en('Press + Add an account and pick Google account.'), en('Sign in with a different Google address.')], view: '#view=settings:ab-mail', expect: en('Both accounts are listed with their own address. The first one is still there.') },
  { id: 'google-ask', release: '3.18.2', title: en('Ask her for another mail account'), steps: [en('Send this message in a new chat.')], ask: en('Add another email account'), expect: en('A card with your accounts and a + Add an account button.') },
  { id: 'code-change', release: '3.18.2', title: en('Approve a code change, then undo it'), steps: [en('Under Code changes, ask her to fix a small thing in her code.'), en('Press Approve and apply. When she is back, press Undo.')], view: '#view=settings:dh-updates', expect: en('She restarts after each step, and after Undo the change is gone again.') },
  // 3.18.1
  { id: 'msg-card', release: '3.18.1', title: en('A message card you can’t miss'), steps: [en('Ask a linked friend to message you while Today is open.'), en('Press Later, then have them send one more.')], view: '#view=msgs', expect: en('A card at the top center with Open and Later. Later keeps it away until a new message comes.') },
  { id: 'win-once', release: '3.18.1', title: en('Sara is listed once in Windows'), steps: [en('Open Windows Settings → Apps → Installed apps.'), en('Search for Sara.')], view: '#view=settings:desktop-app', expect: en('One Sara entry, also after an update or a reinstall.') },
  { id: 'mailbox-second', release: '3.18.1', title: en('A second mailbox keeps the first'), steps: [en('Add a second Gmail with its own app password.')], view: '#view=settings:ab-mail', expect: en('Both mailboxes are listed. Adding the same address again updates it in place.') },
  // 3.18.0
  { id: 'help-pass-fix', release: '3.18.0', title: en('Have a friend’s Sara fix something'), steps: [en('Open your chat with a linked friend.'), en('Press Ask … to fix something, pick 1 hour and “fix with my OK each time”.')], view: '#view=msgs', expect: en('A plan arrives, each step asks you before it runs, and a short report comes at the end.') },
  { id: 'help-pass-look', release: '3.18.0', title: en('Look at a friend’s Sara with a help pass'), steps: [en('Ask a linked friend for a help pass.'), en('Press Look at …’s Sara in your chat with them.')], view: '#view=msgs', expect: en('Health, models and recent errors with private details removed; never their chats or files.') },
  { id: 'community-quiet', release: '3.18.0', title: en('Communities stay quiet'), steps: [en('In a community, set Notify me to “when I’m mentioned”.'), en('Have someone post, then @mention you.')], view: '#view=msgs', expect: en('No card for the post, a card for the mention.') },
  { id: 'repair-check', release: '3.18.0', title: en('Self-repair: Check now'), steps: [en('Find Self-repair on this page.'), en('Press Check now.')], view: '#view=settings:dh-health', expect: en('What is wrong (or nothing), what she fixed lately, and Undo next to each fix.') },
  { id: 'repair-ask', release: '3.18.0', title: en('Tell her “fix yourself”'), steps: [en('Send this message in a new chat.')], ask: en('Something is broken. Check yourself and fix what you can.'), expect: en('She checks herself, explains in plain words, and fixes small things or asks first.') },
  // 3.17.0
  { id: 'adult-apps', release: '3.17.0', title: en('Adult mode in the Windows or Mac app'), steps: [en('Open this page in the Windows or Mac app.'), en('Turn it on with the 18+ confirmation.')], view: '#view=settings:you-adult', expect: en('It turns on like in a browser. In a phone app the page shows its state and Turn off.') },
  { id: 'alerts-settings', release: '3.17.0', title: en('Choose where alerts go'), steps: [en('Open Where alerts go on this page.'), en('Give one kind of alert a chat of its own.')], view: '#view=settings:you-automations', expect: en('The next alert of that kind posts there, and its row shows Posts to with Change.') },
  { id: 'alerts-chat', release: '3.17.0', title: en('Move alerts by asking'), steps: [en('Send this message in a new chat.')], ask: en('Put my reminders in a chat just for them'), expect: en('She says where they go now, and Settings shows the same.') },
  { id: 'doc-template', release: '3.17.0', title: en('Make a template from a document'), steps: [en('Open a contract or letter in the Library.'), en('Mark it as a template.')], view: '#view=library', expect: en('She finds its blanks, and a Word file gets a fill-in form.') },
  { id: 'doc-tracked', release: '3.17.0', title: en('Tracked changes in Word'), steps: [en('Have a Word contract in the Library, then send this message.')], ask: en('Revise my contract: change the payment term to 30 days'), expect: en('The Word file has tracked changes by Sara that you accept or reject in Word.') },
  { id: 'doc-sign', release: '3.17.0', title: en('Ready to sign'), steps: [en('Open a finished document in the Library.'), en('Press Ready to sign.')], view: '#view=library', expect: en('A PDF with page numbers and signature, name and date fields. She warns about blanks left.') },
  { id: 'team-run', release: '3.17.0', title: en('Run an agent team'), steps: [en('Send this message in a new chat.'), en('Change the plan if you like, then approve it.')], ask: en('Have a team research home batteries and write a one-page summary'), expect: en('One plan to approve, live progress with Pause and Stop, and one result at the end.') },
  // 3.16.0
  { id: 'humanize', release: '3.16.0', title: en('Make it sound human'), steps: [en('Send this message in a new chat.'), en('Press Make it sound human on the document card.')], ask: en('Write a short letter to my landlord about the heating as a document'), expect: en('Side by side with the changes marked and a score, plus Keep and Undo.') },
  { id: 'writing-style', release: '3.16.0', title: en('Match my voice'), steps: [en('Find Writing style on this page.'), en('Add 1 to 5 samples of your own writing.')], view: '#view=settings:you-about', expect: en('A short style card she uses from now on.') },
  { id: 'meeting-record', release: '3.16.0', title: en('Record a meeting'), steps: [en('In the Windows app, press Record this computer during a call.'), en('Stop it when the call ends.')], view: '#view=meetings', expect: en('A transcript with speakers, a summary and action items.') },
  { id: 'people-attention', release: '3.16.0', title: en('People who need attention'), steps: [en('Open People.'), en('Open Needs attention.')], view: '#view=memory', expect: en('Most urgent first: who waits for your reply, promises and birthdays.') },
  { id: 'trips', release: '3.16.0', title: en('Your trips'), steps: [en('Open a trip she found in your email.'), en('Press Add to calendar or Packing list.')], view: '#view=trips', expect: en('One timeline per trip in local times, and the same booking shows only once.') },
  // 3.15.0
  { id: 'choices', release: '3.15.0', title: en('Pick-an-answer buttons'), steps: [en('Send this message in a new chat.'), en('Tap one of the buttons.')], ask: en('Help me choose a laptop: give me three options to pick from'), expect: en('Buttons under her question, her pick first and “Other” last. Your tap is sent as your message.') },
  { id: 'goals', release: '3.15.0', title: en('A goal over days'), steps: [en('Send this message in a new chat.')], ask: en('Help me get my house sale paperwork done by Dec 15'), expect: en('A plan of milestones with dates on the Goals page and on Today.') },
  { id: 'research', release: '3.15.0', title: en('A research report'), steps: [en('Send this message in a new chat.'), en('Look at the plan and its budget, then press Start.')], ask: en('Research heat pumps for a cold climate'), expect: en('The report has numbered sources with quotes and a “What I couldn’t verify” part.') },
  { id: 'ask-everything', release: '3.15.0', title: en('Ask about anything in your life'), steps: [en('Type a question in the search box.'), en('Pick ✦ Ask about anything in your life.')], view: '#view=today', expect: en('A short answer with numbered sources. Tapping one opens it at the spot.') },
  { id: 'messages-link', release: '3.15.0', title: en('Link a friend’s server'), steps: [en('In Messages, make a link code and give it to a friend.'), en('Send each other a message.')], view: '#view=msgs', expect: en('The code works once for 30 minutes. Once linked, you stay linked until one of you unlinks.') },
  { id: 'messages-files', release: '3.15.0', title: en('Pictures and edits in Messages'), steps: [en('In a linked chat, send a picture.'), en('Edit, then delete your message.')], view: '#view=msgs', expect: en('The picture arrives, and the edit and the delete show on both sides.') },
  { id: 'community', release: '3.15.0', title: en('Start a community'), steps: [en('Make a community in Messages and share its code.'), en('Make a friend a moderator.')], view: '#view=msgs', expect: en('Friends join with the code, and moderators can remove or ban.') },
];

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));
export const checkById = (id: string): OwnerCheck | undefined => BY_ID.get(id);

interface Saved {
  results: Record<string, { result: CheckResult; note: string; at: string }>;
  /** Items the owner has seen in the list: anything else (added by an update) shows as New. */
  seen: string[];
  sendOn: boolean;
  sentAt: string | null;
  ticket: string | null;
}

const empty = (): Saved => ({ results: {}, seen: [], sendOn: false, sentAt: null, ticket: null });

/** The owner's results (<data>/owner-checks.json). */
export class OwnerChecks {
  readonly #file: string;
  readonly #now: () => Date;
  constructor(dataDir: string, now: () => Date = () => new Date()) {
    this.#file = join(dataDir, 'owner-checks.json');
    this.#now = now;
  }
  get(): Saved {
    if (!existsSync(this.#file)) return empty();
    try {
      const j = JSON.parse(readFileSync(this.#file, 'utf8')) as Partial<Saved>;
      const results: Saved['results'] = {};
      for (const [id, r] of Object.entries(j.results ?? {})) if (BY_ID.has(id) && r && CHECK_RESULTS.includes(r.result)) results[id] = { result: r.result, note: String(r.note ?? '').slice(0, 500), at: String(r.at ?? '') };
      return { results, seen: Array.isArray(j.seen) ? j.seen.filter((x) => typeof x === 'string') : [], sendOn: j.sendOn === true, sentAt: typeof j.sentAt === 'string' ? j.sentAt : null, ticket: typeof j.ticket === 'string' ? j.ticket : null };
    } catch {
      return empty();
    }
  }
  #save(s: Saved): void {
    mkdirSync(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 1));
    renameSync(tmp, this.#file);
  }
  /** Worked / Didn't work / Skip (null clears it), with an optional note (500 characters at most). */
  mark(id: string, result: CheckResult | null, note = ''): void {
    if (!BY_ID.has(id)) throw new Error('unknown check');
    if (result !== null && !CHECK_RESULTS.includes(result)) throw new Error('bad result');
    const s = this.get();
    if (result === null) delete s.results[id];
    else s.results[id] = { result, note: String(note ?? '').replace(/\r\n/g, '\n').trim().slice(0, 500), at: this.#now().toISOString() };
    this.#save(s);
  }
  seen(ids: string[]): void {
    const s = this.get();
    s.seen = [...new Set([...s.seen, ...ids.filter((id) => BY_ID.has(id))])];
    this.#save(s);
  }
  setSendOn(on: boolean): void {
    this.#save({ ...this.get(), sendOn: on === true });
  }
  sent(ticket: string): void {
    this.#save({ ...this.get(), sentAt: this.#now().toISOString(), ticket });
  }
}

const relCmp = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });

/** What the page shows: every item with its result, grouped by release (newest first), and progress. */
export function checksView(store: OwnerChecks) {
  const s = store.get();
  const seen = new Set(s.seen);
  const items = CHECKS.map((c) => ({ ...c, result: s.results[c.id]?.result ?? null, note: s.results[c.id]?.note ?? '', new: !seen.has(c.id) }));
  const counts = { worked: 0, failed: 0, skipped: 0 };
  for (const r of Object.values(s.results)) counts[r.result]++;
  const groups = [...new Set(CHECKS.map((c) => c.release))].sort(relCmp).map((release) => ({ release, ids: items.filter((i) => i.release === release).map((i) => i.id) }));
  return { total: CHECKS.length, done: Object.keys(s.results).length, counts, groups, items, sendOn: s.sendOn, sentAt: s.sentAt, ticket: s.ticket };
}

const LABEL: Record<CheckResult, string> = { worked: 'Worked', failed: "Didn't work", skipped: 'Skipped' };

function lines(store: OwnerChecks, scrub: (s: string) => string): string[] {
  const s = store.get();
  const out: string[] = [];
  for (const release of [...CHECK_RELEASES].sort(relCmp)) {
    const tried = CHECKS.filter((c) => c.release === release && s.results[c.id]);
    if (!tried.length) continue;
    out.push('', `## ${release}`, '');
    for (const c of tried) {
      const r = s.results[c.id];
      out.push(`- **${LABEL[r.result]}**: ${c.title} (${c.id})`);
      if (r.note) out.push(`  - Note: ${scrub(r.note).replace(/\n+/g, ' ')}`);
    }
  }
  return out;
}

/** The Markdown export (kept on this computer: notes are not scrubbed, they are the owner's own). */
export function resultsMarkdown(store: OwnerChecks, o: { version: string }): string {
  const v = checksView(store);
  return [`# Try these: results`, '', `Sara ${o.version}. ${v.done} of ${v.total} tried: ${v.counts.worked} worked, ${v.counts.failed} didn't work, ${v.counts.skipped} skipped.`, ...lines(store, (x) => x), ''].join('\n');
}

/** The report sent to the developer: only tried items, notes scrubbed (keys, emails, home folders). */
export function resultsTicket(store: OwnerChecks, o: { version: string; scrub: (s: string) => string }): { kind: 'bug'; title: string; body: string } {
  const v = checksView(store);
  const title = `Try these: ${v.counts.worked} worked, ${v.counts.failed} didn't work, ${v.counts.skipped} skipped (${o.version})`;
  const body = [`${v.done} of ${v.total} tried on Sara ${o.version}.`, ...lines(store, o.scrub)].join('\n').trim();
  return { kind: 'bug', title, body: o.scrub(body) };
}
