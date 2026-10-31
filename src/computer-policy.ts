// Phase 87 (computer use CU1, docs/design/COMPUTER_USE.md §6.4 and §7.3): the risk rows for
// looking and navigating in the Sara browser on the owner's computer. Pure (no I/O): the tool
// gathers the facts (the owner's message, her jobs' ports, the sites already allowed in this task)
// and this decides allow / ask / block. Phase 88 (CU2) adds the acting rows (actionVerdict below).
//
// Rows in CU1:
//   look (pc_browser_look/read/logs/tabs/request, pc_devices)             → allow
//   open a site the owner named in this task, or one allowed in this task → allow
//   localhost where one of her jobs listens (the OS check of previews)    → allow
//   a preview link of this server (/preview/<token>/)                     → allow
//   any other site, or another localhost port                             → ask once per site per task
//   private conversation or private local mode: anything but localhost    → block
//   anything that isn't http(s), credentials in the address               → block
// The device refuses on its own as well (the server's own origin, chrome://, file://…), whatever
// the server decides here.

export type Verdict = { act: 'allow'; why: string } | { act: 'ask'; site: string; why: string } | { act: 'block'; why: string };

export interface NavFacts {
  /** The owner's message this task answers (sites named there are allowed). */
  ownerText: string;
  /** Sites (origins) already allowed in this task. */
  granted: ReadonlySet<string>;
  /** A private conversation or private local mode: only this computer's own addresses. */
  localOnly: boolean;
  /** Does one of her jobs listen on this localhost port? */
  jobPort: (port: number) => boolean;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
export const isLoopback = (host: string): boolean => LOOPBACK.has(host.toLowerCase()) || /^127\.\d+\.\d+\.\d+$/.test(host);

/** The origin of an address as the owner would say it ("github.com", "localhost:5173"). */
export function siteOf(u: URL): string {
  return u.host.toLowerCase();
}

/** Sites named in the owner's words: full addresses, and bare host names like github.com. */
export function namedSites(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) {
    try {
      out.add(new URL(m[0]).host.toLowerCase());
    } catch {
      /* not an address */
    }
  }
  for (const m of text.matchAll(/\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(:\d{2,5})?\b/gi)) out.add(`${m[1]}${m[2] ?? ''}`.toLowerCase());
  for (const m of text.matchAll(/\b(localhost|127\.0\.0\.1):(\d{2,5})\b/gi)) out.add(`${m[1].toLowerCase()}:${m[2]}`);
  return out;
}

export function navigationVerdict(raw: string, facts: NavFacts): Verdict {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { act: 'block', why: 'That is not a web address. Give a full address like https://example.com/ or http://localhost:5173/.' };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { act: 'block', why: 'The Sara browser only opens web addresses (http or https).' };
  if (u.username || u.password) return { act: 'block', why: 'Addresses with a user name or password in them are not opened.' };
  const site = siteOf(u);
  const loop = isLoopback(u.hostname);
  if (facts.localOnly && !loop) return { act: 'block', why: 'Private: only addresses on this computer (localhost) are opened here.' };
  if (/^\/preview\/[0-9a-f]{32}(\/|$)/.test(u.pathname) && !loop) return { act: 'allow', why: 'a preview link' };
  if (loop) {
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    if (facts.jobPort(port)) return { act: 'allow', why: 'one of her jobs listens there' };
    if (facts.granted.has(site)) return { act: 'allow', why: 'allowed in this task' };
    // The owner gave this exact address ("my app at localhost:5173").
    const named = namedSites(facts.ownerText);
    if (named.has(site) || named.has(`localhost:${port}`) || named.has(`127.0.0.1:${port}`)) return { act: 'allow', why: 'the owner named it' };
    return { act: 'ask', site, why: `a program on this computer (port ${port}) that isn't one of her jobs` };
  }
  if (facts.granted.has(site)) return { act: 'allow', why: 'allowed in this task' };
  const named = namedSites(facts.ownerText);
  const bare = site.replace(/^www\./, '');
  if (named.has(site) || named.has(bare) || named.has(`www.${bare}`)) return { act: 'allow', why: 'the owner named it' };
  return { act: 'ask', site, why: 'a site you did not name' };
}

/** §7.5: text on a page that tries to give her orders is flagged (the page is data, never instructions). */
export function injectionHints(text: string): string[] {
  const out: string[] = [];
  const t = text.toLowerCase();
  for (const [re, what] of [
    [/ignore (?:all |any )?(?:previous|prior|above) (?:instructions|messages)/, 'asks her to ignore her instructions'],
    [/(?:type|enter|paste) (?:your|the) (?:password|passcode|token|api key)/, 'asks for a password or key'],
    [/open (?:the )?(?:settings|control panel|terminal|command prompt|powershell)/, 'asks her to open system settings or a terminal'],
    [/you are now|new instructions:|system prompt/, 'pretends to be her instructions'],
  ] as [RegExp, string][]) {
    if (re.test(t)) out.push(what);
  }
  return out;
}

// ---- Phase 88 (CU2): acting in the Sara browser (§7.3 with the owner's decisions in §0) ----
//
// Levels (Settings → Computer use → Her browser actions):
//   ask     every action asks (Allow once · Always on this site · Don't)
//   task    (default) the first action of a kind on a site asks; "Allow for this task" covers that
//           site for the rest of this task (this conversation's current request), never later ones
//   always  no cards (one-time warning when chosen), except the approve-once rows below
// Rows, whatever the level:
//   typing into a password / one-time-code field, or text shaped like a key or a Sara sign-in → block
//   payments and purchases (Pay, Buy, Place order, card fields)          → ask every time (approve-once)
//   account and security settings (delete account, password, 2FA…)      → ask every time (approve-once)
//   sending as the owner (Send, Post, Publish, Reply…)                   → ask every time, except Always
//   a site + action kind the owner chose "Always" for on a card          → allow
// The device refuses on its own as well (password fields, Sara's own server, keys outside its list).

export const ACT_LEVELS = ['ask', 'task', 'always'] as const;
export type ActLevel = (typeof ACT_LEVELS)[number];
export const actLevel = (v: unknown): ActLevel => (v === 'ask' || v === 'always' ? v : 'task');
export type ActKind = 'click' | 'type' | 'select' | 'keys' | 'upload';
export type ActRisk = 'normal' | 'send' | 'payment' | 'account';

export interface ActTarget {
  role?: string;
  name?: string;
  tag?: string;
  type?: string;
  secret?: boolean;
  card?: boolean;
  formText?: string;
}
export interface ActFacts {
  kind: ActKind;
  site: string;
  target: ActTarget;
  page: { url?: string; title?: string; hasCard?: boolean };
  /** The text she would type, or the keys she would press. */
  text?: string;
  level: ActLevel;
  /** Sites allowed for acting in this task ("Allow for this task"). */
  taskSites: ReadonlySet<string>;
  /** "Always on this site" choices: site + kind. */
  always: readonly { site: string; kind: string }[];
}
export type ActVerdict = { act: 'allow'; risk: ActRisk; why: string } | { act: 'ask'; risk: ActRisk; why: string; choices: ('once' | 'task' | 'always')[] } | { act: 'block'; risk: ActRisk; why: string };

const PAY = /\b(pay|pay now|place (?:your )?order|buy|buy now|purchase|check ?out|complete (?:the )?(?:order|purchase)|confirm (?:the )?(?:order|purchase|payment)|subscribe|donate|add (?:a )?card|submit payment|proceed to payment)\b/i;
const ACCOUNT = /\b(delete (?:my |your |the )?account|close (?:my |your )?account|deactivate|remove (?:my |your )?account|change (?:my |your )?(?:password|email|e-mail)|reset (?:my |your )?password|new password|two[- ]factor|2fa|recovery (?:code|email|phone)|security (?:settings|questions?)|privacy settings|sign out (?:of )?all|revoke|api keys?|access tokens?)\b/i;
const SEND = /\b(send|post|publish|tweet|reply|comment|share|submit (?:message|comment|post|review))\b/i;
/** Text shaped like a key, token or Sara sign-in: never typed by her. */
const SECRET_TEXT = [/\bsk-[A-Za-z0-9_-]{16,}/, /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/, /\bxox[abprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxai-[A-Za-z0-9]{20,}/, /\bsara_(?:dev|hands|m)\.[\w-]+\.[\w-]+/, /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/];
export const looksSecret = (t: string): boolean => SECRET_TEXT.some((re) => re.test(t));

/** What kind of action this is, from the target's role and words and the page (§7.3). */
export function actRisk(f: Pick<ActFacts, 'kind' | 'target' | 'page'>): ActRisk {
  const words = `${f.target.name ?? ''}`;
  const pageWords = `${f.page.title ?? ''} ${f.page.url ?? ''}`;
  const pressing = f.kind === 'click' || f.kind === 'keys';
  if (f.target.card) return 'payment';
  if (pressing && PAY.test(words)) return 'payment';
  if (pressing && f.page.hasCard && /\b(submit|continue|confirm|next|done|finish|complete)\b/i.test(words)) return 'payment';
  if (ACCOUNT.test(words)) return 'account';
  if (pressing && /\b(save|update|confirm|delete|remove|disable|turn off|apply)\b/i.test(words) && /\b(account|security|password|2fa|two-factor|privacy)\b/i.test(pageWords)) return 'account';
  if (pressing && SEND.test(words)) return 'send';
  return 'normal';
}

export function actionVerdict(f: ActFacts): ActVerdict {
  const risk = actRisk(f);
  if (f.kind === 'type' && f.target.secret) return { act: 'block', risk, why: 'That is a password field: Sara never types passwords. Ask the owner to type it themselves in the Sara browser, then go on.' };
  if (f.text && looksSecret(f.text)) return { act: 'block', risk, why: 'That text looks like a key or a sign-in token: Sara never types those (and never Sara\u2019s own sign-in).' };
  if (risk === 'payment') return { act: 'ask', risk, why: 'a payment or purchase (asks every time)', choices: ['once'] };
  if (risk === 'account') return { act: 'ask', risk, why: 'account or security settings (asks every time)', choices: ['once'] };
  if (f.always.some((a) => a.site === f.site && a.kind === f.kind)) return { act: 'allow', risk, why: 'always allowed on this site' };
  if (f.level === 'always') return { act: 'allow', risk, why: 'her browser actions are always allowed' };
  if (risk === 'send') return { act: 'ask', risk, why: 'sending something as you (asks every time)', choices: ['once'] };
  if (f.level === 'task' && f.taskSites.has(f.site)) return { act: 'allow', risk, why: 'allowed for this task' };
  return { act: 'ask', risk, why: f.level === 'ask' ? 'every action asks' : 'the first action on this site in this task', choices: f.level === 'task' ? ['once', 'task', 'always'] : ['once', 'always'] };
}

// ---- Phase 93 (CU6): desktop input -------------------------------------------------------------
// The server decides when to ask; the paired device still enforces the hard limits. Desktop
// approvals are local by default, so an answer from a phone cannot silently authorize a mouse or
// keyboard event on another computer.
export interface DesktopTarget {
  role?: string;
  name?: string;
  secret?: boolean;
  blocked?: boolean;
  elevated?: boolean;
}
export interface DesktopFacts {
  site: string;
  target: DesktopTarget;
  level: ActLevel;
  taskGranted?: boolean;
  kind?: 'click' | 'type' | 'keys' | 'scroll' | 'drag' | 'launch' | 'open_app';
  text?: string;
}
export type DesktopVerdict = { act: 'allow'; risk: ActRisk; why: string } | { act: 'ask'; risk: ActRisk; why: string; choices: ('once' | 'task' | 'always')[] } | { act: 'block'; risk: ActRisk; why: string };

const DESKTOP_NEVER = /admin(?:istrator)?|elevat(?:ed|ion)|uac|secure desktop|password manager|bank(?:ing)?|security settings|sara(?:'s)? (?:own )?(?:sign[- ]?in|server token)|(?:delete|remove|erase) (?:a )?(?:file|folder)|empty (?:the )?(?:trash|recycle)|move to trash|run as administrator|credential manager/i;
const DESKTOP_ACCOUNT = /account|password|2fa|two[- ]factor|recovery|security|privacy|sign out|revoke/i;
const DESKTOP_PAYMENT = /pay|purchase|buy|checkout|order|donate|card/i;

export function desktopActionVerdict(f: DesktopFacts): DesktopVerdict {
  const words = `${f.target.name ?? ''} ${f.text ?? ''}`;
  const risk: ActRisk = DESKTOP_PAYMENT.test(words) ? 'payment' : DESKTOP_ACCOUNT.test(words) ? 'account' : 'normal';
  if (f.target.secret || f.target.blocked || f.target.elevated) return { act: 'block', risk, why: f.target.secret ? 'That is a password field: Sara never types into those.' : f.target.elevated ? "I can't control windows running as administrator" : 'That window is blocked on the computer.' };
  if (DESKTOP_NEVER.test(words) || /\b(?:delete|remove|erase|trash|recycle|unlink)\b(?!\s+(?:my |your |this |the )?account\b)/i.test(f.target.name ?? '')) return { act: 'block', risk, why: 'The computer refuses that protected desktop action.' };
  if (risk === 'payment' || risk === 'account') return { act: 'ask', risk, why: `${risk === 'payment' ? 'payment or purchase' : 'account or security setting'} (asks once)`, choices: ['once'] };
  if (f.level === 'always' || (f.level === 'task' && f.taskGranted)) return { act: 'allow', risk, why: f.level === 'always' ? 'desktop actions are always allowed' : 'allowed for this task' };
  return { act: 'ask', risk, why: f.level === 'ask' ? 'every desktop action asks' : 'the first desktop action in this task asks', choices: f.level === 'task' ? ['once', 'task', 'always'] : ['once', 'always'] };
}

// ---- Phase 90 (CU4, §8.2): saved logins ----
//   using a saved login (pc_browser_login)                          → ask every time, at every level (approve-once)
//   offering to save one (pc_browser_save_login)                    → only when the owner said so in so many words
//                                                                     (the device's own consent window is the real yes)

/** A saved login is used only after a card, every time (no \"for this task\", no \"always\"). */
export function loginVerdict(): { act: 'ask'; risk: 'login'; why: string; choices: 'once'[] } {
  return { act: 'ask', risk: 'login', why: 'using a saved login (asks every time)', choices: ['once'] };
}

const SAVE_WORD = /\b(save|remember|keep|store)\b/i;
const LOGIN_WORD = /\b(log-?ins?|logon|sign-?ins?|passwords?|pass ?codes?|credentials?)\b/i;
const NOT_SAVE = /\b(don'?t|do not|never|no need to|stop)\s+(?:\w+\s+){0,2}(save|remember|keep|store)\b/i;
/**
 * The owner asked in so many words to save a login: a save word and a login word in the same sentence
 * of their message (\"save my GitHub login\", \"remember the password for this site\"), not a \"don't\".
 */
export function askedToSaveLogin(text: string): boolean {
  return String(text ?? '')
    .split(/[.!?\n]+/)
    .some((s) => SAVE_WORD.test(s) && LOGIN_WORD.test(s) && !NOT_SAVE.test(s));
}
