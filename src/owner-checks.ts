// U1.5 (docs/TRY_THESE.md): "Try these", a guided owner checklist inside the app. A short curated
// list of plain "try this" items drawn from the newest docs/OWNER_CHECKS.md (3.15-3.18.2) and, since
// V0.3, the CHANGELOG of 3.19-3.24 (so What's new "Try it" has a check for every release), each with
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
export const CHECK_RELEASES = ['3.15.0', '3.16.0', '3.17.0', '3.18.0', '3.18.1', '3.18.2', '3.19.0', '3.20.0', '3.21.0', '3.22.0', '3.22.1', '3.23.0', '3.24.0', '3.31.0', '3.32.0'];

export const CHECKS: OwnerCheck[] = [
  // 3.32.0
  { id: 'know-why', release: '3.32.0', title: en('See what she knows about you'), steps: [en('Open What Sara knows, press Why on one fact, then Forget and Undo.')], view: '#view=settings:you-knows', expect: en('You see where she learned it and how long ago; Forget removes it and Undo brings it back.') },
  { id: 'nudge-budget', release: '3.32.0', title: en('Set how often she nudges you'), steps: [en('Find Her nudges on this page and look at the daily budget and roundup hour.')], view: '#view=settings:you-automations', expect: en('Up to that many nudges a day; the rest come together at the roundup hour, and each has Why did I get this?') },
  { id: 'continue-device', release: '3.32.0', title: en('Continue on another device'), steps: [en('Type something in a chat on your PC without sending it, then open Sara on your phone.')], view: '#view=settings:co-phone', expect: en('A card says Continue where you left off on your PC, and Continue brings back the chat and your words.') },
  // 3.31.0
  { id: 'time-sense', release: '3.31.0', title: en('Ask how long ago you said something'), steps: [en('Ask her anything, wait a few minutes, then send the message below.')], ask: en('How long ago did I ask you that?'), expect: en('She gives the real time (for example 4 minutes ago), never yesterday.') },
  { id: 'always-allow', release: '3.31.0', title: en('Turn on Always allow everything'), steps: [en('Press Always allow everything, read the warning and confirm it is you.')], view: '#view=settings:co-computer', expect: en('A red Always allow is on bar above the message box, with Turn off. Her computer actions run without cards until it ends.') },
  { id: 'live-words-languages', release: '3.31.0', title: en('Words as you speak in your language'), steps: [en('Press Add words as you speak in other languages, then talk to her in Spanish, French, German, Portuguese or Italian.')], view: '#view=settings:her-voice', expect: en('Your words appear while you speak, in that language.') },
  // 3.24.0
  { id: 'restore-now', release: '3.24.0', title: en('Test a restore now'), steps: [en('Find Test restores on this page.'), en('Press Test a restore now.')], view: '#view=settings:dh-backups', expect: en('After a minute or two a Passed row with how long it took. Your chats and files are not changed.') },
  { id: 'whats-new-help', release: '3.24.0', title: en('What’s new any time'), steps: [en('Open What’s new on this page.'), en('Press Show me on one of its lines.')], view: '#view=help', expect: en('Each release since the version you last saw, in plain words, and Show me opens the place it lives.') },
  // 3.23.0
  { id: 'talk-hands-free', release: '3.23.0', title: en('Talk with Sara hands-free'), steps: [en('Check that Talk with Sara is turned on here.'), en('Press Talk with Sara next to the message box, ask something, then talk over her answer.')], view: '#view=settings:her-voice', expect: en('She answers out loud sentence by sentence with a live transcript, and stops when you talk over her.') },
  { id: 'business-invoice', release: '3.23.0', title: en('Invoice a client’s hours'), steps: [en('In Business, add a client with an hourly rate.'), en('Start and stop the timer, then invoice the unbilled hours.')], view: '#view=business', expect: en('An invoice with the client’s terms and a PDF. Email it shows the exact email before anything is sent.') },
  { id: 'shared-project', release: '3.23.0', title: en('Share a project with a friend'), steps: [en('On a project page, press Shared with friends.'), en('Invite a linked friend as Can edit, then add a to-do.')], view: '#view=shared', expect: en('Your friend accepts and sees the to-do, and their changes show up on your side too.') },
  { id: 'market-share', release: '3.23.0', title: en('Share a skill with friends'), steps: [en('Under Shared by friends, share a skill to a community.'), en('On a friend’s Sara, open the listing and install it.')], view: '#view=addons', expect: en('Before installing, the listing says exactly what it does, and the skill starts on trial.') },
  { id: 'picture-edit', release: '3.23.0', title: en('Edit a picture on your computer'), steps: [en('With ComfyUI running, open a picture in the Library.'), en('Press Edit picture… and upscale it 2×.')], view: '#view=library', expect: en('A new Library item with a before/after slider. The original picture is unchanged.') },
  // 3.22.1
  { id: 'windows-open', release: '3.22.1', title: en('Every window opens'), steps: [en('Open Money, then Settings, Health and Family.')], view: '#view=money', expect: en('Each window shows its own content. None of them is empty.') },
  // 3.22.0
  { id: 'extension-pair', release: '3.22.0', title: en('Pair the browser extension'), steps: [en('Load the extension in Chrome, Edge or Firefox.'), en('Approve its short code on this page.')], view: '#view=settings:dh-devices', expect: en('The extension is listed here, and Ask Sara about this page answers in its popup.') },
  { id: 'money-import', release: '3.22.0', title: en('Add your bank exports'), steps: [en('In Money, add a CSV or OFX export from your bank.'), en('Add the next month’s export too.')], view: '#view=money', expect: en('Spending by category, and a purchase in both files is counted once.') },
  { id: 'family-meals', release: '3.22.0', title: en('Plan a week of dinners'), steps: [en('In Family → Meals, pick a dinner for each night.'), en('Press Add to the grocery list.')], view: '#view=family', expect: en('The ingredients are added up and sorted by aisle. A dinner that clashes with an allergy says so.') },
  { id: 'health-medicine', release: '3.22.0', title: en('A medicine reminder'), steps: [en('In Health, add a medicine with a dose time.'), en('When the reminder comes, press Taken.')], view: '#view=health', expect: en('The dose is logged as Taken and the refill estimate counts it.') },
  { id: 'study-set', release: '3.22.0', title: en('Make study cards'), steps: [en('Make a study set from a Library document.'), en('Study a few cards with Again, Hard, Good or Easy.')], view: '#view=study', expect: en('Flashcards and questions from that document. Cards you knew come back on later days.') },
  // 3.21.0
  { id: 'flight-free', release: '3.21.0', title: en('Free flight status'), steps: [en('Under flight status, pick OpenSky Network.'), en('Open a trip with a flight today.')], view: '#view=trips', expect: en('Whether the plane is in the air, on the ground or landed, without a key.') },
  { id: 'word-comment', release: '3.21.0', title: en('A comment in Word'), steps: [en('Have a Word contract in the Library, then send this message.')], ask: en('Add a comment to my contract asking about the payment terms'), expect: en('A note in the margin on those words. The words themselves are unchanged.') },
  { id: 'team-recipe', release: '3.21.0', title: en('Save a team recipe'), steps: [en('After a team run finishes, press Save as a team recipe.'), en('Run the recipe again with a new job.')], view: '#view=team', expect: en('The plan comes back with the same helpers and still waits for your OK.') },
  { id: 'ask-meeting', release: '3.21.0', title: en('Ask about a meeting'), steps: [en('Record or upload a meeting.'), en('Ask about anything: what was decided in that meeting?')], view: '#view=meetings', expect: en('An answer with a source that opens the meeting at the line where it was said.') },
  // 3.20.0
  { id: 'phone-connect', release: '3.20.0', title: en('Connect an iPhone'), steps: [en('Open this page on an iPhone in Safari.')], view: '#view=settings:co-phone', expect: en('It explains Add to Home Screen and never sends you to Google Play.') },
  { id: 'taskbar-count', release: '3.20.0', title: en('Unread count on the taskbar'), steps: [en('In the Windows app, have a linked friend send you a message.'), en('Read it in Messages.')], view: '#view=settings:desktop-app', expect: en('A small red number on Sara’s taskbar button that goes away once you read it.') },
  // 3.19.0
  { id: 'try-these-report', release: '3.19.0', title: en('Mark a check and export'), steps: [en('Mark one item here Worked and add a note.'), en('Press Export as Markdown.')], view: '#view=try', expect: en('The progress counts it, and the file lists it with your note.') },
  { id: 'stock-project', release: '3.19.0', title: en('Alerts into a new project'), steps: [en('Send this message in a new chat.'), en('Say yes when she offers to make the project.')], ask: en('Put my stock alerts in a project called Stock Alerts'), expect: en('A Stock Alerts project is made and the alerts go there, not to this chat.') },
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
