// N4 (docs/MY_DETAILS.md): filling a web form in the person's own browser from My details (or values
// from the chat). Pure parts here, testable without a computer: which page field is which detail (by its
// label, its own id, its placeholder and, where the computer reports it, its autocomplete purpose),
// which fields are never touched (passwords, card fields, SSN / ID numbers, one-time codes), the one
// review list the person approves on their computer, and the read-back check. The typing itself goes
// through the existing desktop actions (src/tools/computer.ts pc_fill_form → DeskPort below), so every
// rule of the computer applies too. It always STOPS before Submit: the person presses it, or says
// "submit it" and approves a separate card (never automatic on payment or sign-in pages).
import type { DesktopItem } from './hands-desktop.ts';
import { detailLines, refusalFor, type Address, type MyDetails } from './my-details.ts';

export type FieldKey =
  | 'firstName' | 'lastName' | 'fullName' | 'email' | 'phone' | 'address1' | 'address2' | 'city' | 'state' | 'zip' | 'country'
  | 'birthDate' | 'shirtSize' | 'pantsSize' | 'dressSize' | 'shoeSize' | 'employer' | 'jobTitle'
  | 'vehicleMake' | 'vehicleModel' | 'vehicleYear' | 'plate' | 'vin' | 'insuranceCompany' | 'policyNumber' | 'loyaltyNumber'
  | 'emergencyName' | 'emergencyPhone';

/** Fields Sara never fills, and why (said on the card and in the reply). */
export type NeverKind = 'password' | 'card' | 'id-number' | 'code';
const NEVER_WHY: Record<NeverKind, string> = {
  password: 'a password field: never typed by Sara',
  card: 'a payment card field: you type it yourself',
  'id-number': 'an SSN or government ID number: never typed by Sara',
  code: 'a one-time code: you type it yourself',
};

const FIELD_ROLES = /^(edit|combobox|spinner|text field|textfield|textarea|searchbox)$/i;

/** autocomplete purposes (HTML) → a detail. */
const AUTO: Record<string, FieldKey | NeverKind> = {
  'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', email: 'email', tel: 'phone', 'tel-national': 'phone',
  'street-address': 'address1', 'address-line1': 'address1', 'address-line2': 'address2', 'address-level2': 'city', 'address-level1': 'state',
  'postal-code': 'zip', country: 'country', 'country-name': 'country', bday: 'birthDate', organization: 'employer', 'organization-title': 'jobTitle',
  'current-password': 'password', 'new-password': 'password', 'one-time-code': 'code',
};

/** Words in a field's label / id / placeholder → a detail (most specific first). */
const WORDS: [RegExp, FieldKey | NeverKind][] = [
  [/password|passcode|passwd|contrase|mot de passe|passwort|senha/, 'password'],
  [/card ?number|credit ?card|debit ?card|\bcc[-_ ]?(num|number|exp|csc|cvv)|\bcvv|\bcvc|\bcsc\b|security code|expir|name on card|cardholder/, 'card'],
  [/social security|\bssn\b|\bsin\b|tax ?id|\btin\b|passport|driver'?s? ?licen|national id|id number/, 'id-number'],
  [/one[- ]time|verification code|\botp\b|2fa|auth(entication)? code/, 'code'],
  [/emergency.*(phone|tel|number)/, 'emergencyPhone'],
  [/emergency/, 'emergencyName'],
  [/e-?mail|correo|courriel/, 'email'],
  [/first ?name|given ?name|\bfname\b|first_name|nombre(?! completo)|pr[eé]nom|vorname/, 'firstName'],
  [/last ?name|surname|family ?name|\blname\b|last_name|apellido|nachname/, 'lastName'],
  [/phone|mobile|\bcell|\btel\b|telephone|tel[eé]fono|telefon/, 'phone'],
  [/address ?(line)? ?2|address2|\bapt\b|apartment|suite|\bunit\b/, 'address2'],
  [/zip|postal|postcode|plz\b|c[oó]digo postal|code postal|\bcep\b/, 'zip'],
  [/\bcity\b|\btown\b|ciudad|ville|\bstadt\b|cidade|citt/, 'city'],
  [/\bstate\b|province|\bregion\b|estado|provincia/, 'state'],
  [/country|pa[ií]s|\bpays\b|\bland\b|paese/, 'country'],
  [/birth|\bdob\b|birthday|nacimiento|naissance|geburt|nascimento|nascita/, 'birthDate'],
  [/shoe/, 'shoeSize'],
  [/pants|trouser|waist|inseam/, 'pantsSize'],
  [/dress size/, 'dressSize'],
  [/shirt|\btop size|t-shirt|\bsize\b|talla|taille|gr[oö]ße|tamanho|taglia/, 'shirtSize'],
  [/license ?plate|\bplate\b|tag number|matr[ií]cula|kennzeichen|immatriculation|targa/, 'plate'],
  [/\bvin\b|vehicle identification/, 'vin'],
  [/(vehicle|car).*make|\bmake\b/, 'vehicleMake'],
  [/(vehicle|car).*model|\bmodel\b/, 'vehicleModel'],
  [/(vehicle|car).*year|model year/, 'vehicleYear'],
  [/insurance (company|provider|carrier)|insurer|aseguradora|assureur/, 'insuranceCompany'],
  [/policy/, 'policyNumber'],
  [/loyalty|rewards?|member(ship)? ?(number|no|#|id)|club card/, 'loyaltyNumber'],
  [/job ?title|position|occupation|\brole\b|cargo|poste\b/, 'jobTitle'],
  [/employer|company|organi[sz]ation|empresa|entreprise|firma|azienda/, 'employer'],
  [/street|address ?(line)? ?1|address1|^address$|\baddress\b|direcci[oó]n|adresse|endere[cç]o|indirizzo/, 'address1'],
  [/full ?name|your name|^name$|\bname\b|nombre completo|nom complet|\bnome\b/, 'fullName'],
];

const NEVER = new Set<string>(['password', 'card', 'id-number', 'code']);
const NEVER_WORDS = WORDS.filter(([, k]) => NEVER.has(k));
/** Fields that are not about the person (sign-in names, searches, codes, free text): left alone. */
const IGNORE = /user ?name|log ?in|search|captcha|coupon|promo|gift ?card|comment|message|subject|question/;

/** A field that isn't about the person (sign-in name, search, coupon, free text): never filled, never listed. */
export const ignoredField = (item: Pick<DesktopItem, 'name' | 'aid' | 'hint'>): boolean => IGNORE.test([item.name, item.aid, item.hint].filter(Boolean).join(' | ').toLowerCase());

/** What a page field asks for (or undefined when it's not one we know). Labels win over guesses; never-kinds win over details. */
export function fieldKind(item: Pick<DesktopItem, 'name' | 'aid' | 'hint' | 'auto' | 'secret'>): FieldKey | NeverKind | undefined {
  if (item.secret) return 'password';
  const auto = item.auto?.split(/\s+/).pop() ?? '';
  if (auto.startsWith('cc-')) return 'card';
  if (AUTO[auto]) return AUTO[auto];
  const said = [item.name, item.aid?.replace(/[_-]+/g, ' '), item.hint].filter(Boolean).join(' | ').toLowerCase();
  if (!said.trim()) return undefined;
  if (NEVER_WORDS.some(([re]) => re.test(said))) return NEVER_WORDS.find(([re]) => re.test(said))![1];
  if (IGNORE.test(said)) return undefined;
  for (const [re, k] of WORDS) if (re.test(said)) return k;
  return undefined;
}

export const LABEL: Record<FieldKey, string> = {
  firstName: 'First name', lastName: 'Last name', fullName: 'Name', email: 'Email', phone: 'Phone', address1: 'Street address', address2: 'Address line 2',
  city: 'City', state: 'State', zip: 'ZIP code', country: 'Country', birthDate: 'Date of birth', shirtSize: 'Shirt size', pantsSize: 'Pants size',
  dressSize: 'Dress size', shoeSize: 'Shoe size', employer: 'Employer', jobTitle: 'Job title', vehicleMake: 'Vehicle make', vehicleModel: 'Vehicle model',
  vehicleYear: 'Vehicle year', plate: 'License plate', vin: 'VIN', insuranceCompany: 'Insurance company', policyNumber: 'Policy number',
  loyaltyNumber: 'Loyalty number', emergencyName: 'Emergency contact', emergencyPhone: 'Emergency phone',
};

export type AddressPick = 'home' | 'work' | 'shipping';

/** One detail's value from My details (the address picked; the first vehicle / policy / loyalty card unless the page names the store). */
export function detailValue(d: MyDetails, key: FieldKey, o: { address?: AddressPick; pageText?: string } = {}): string | undefined {
  const a: Address | undefined = d[o.address ?? 'home'] ?? d.home ?? d.shipping ?? d.work;
  const v = d.vehicles?.[0];
  const page = (o.pageText ?? '').toLowerCase();
  switch (key) {
    case 'firstName': return d.firstName;
    case 'lastName': return d.lastName;
    case 'fullName': return [d.firstName, d.lastName].filter(Boolean).join(' ') || undefined;
    case 'email': return d.email ?? d.workEmail;
    case 'phone': return d.mobilePhone ?? d.homePhone ?? d.workPhone;
    case 'address1': return a?.line1;
    case 'address2': return a?.line2;
    case 'city': return a?.city;
    case 'state': return a?.state;
    case 'zip': return a?.zip;
    case 'country': return a?.country;
    case 'birthDate': return d.birthDate;
    case 'shirtSize': return d.shirtSize;
    case 'pantsSize': return d.pantsSize;
    case 'dressSize': return d.dressSize;
    case 'shoeSize': return d.shoeSize;
    case 'employer': return d.employer;
    case 'jobTitle': return d.jobTitle;
    case 'vehicleMake': return v?.make;
    case 'vehicleModel': return v?.model;
    case 'vehicleYear': return v?.year;
    case 'plate': return v?.plate;
    case 'vin': return v?.vin;
    case 'insuranceCompany': return d.insurance?.[0]?.company;
    case 'policyNumber': return d.insurance?.[0]?.policy;
    case 'loyaltyNumber': return (d.loyalty?.find((l) => l.store && page.includes(l.store.toLowerCase())) ?? d.loyalty?.[0])?.number;
    case 'emergencyName': return d.emergency?.name;
    case 'emergencyPhone': return d.emergency?.phone;
  }
}

export interface FillItem {
  ref: string;
  /** The field as the page names it. */
  label: string;
  role: string;
  name?: string;
  aid?: string;
  hint?: string;
  key?: FieldKey;
  value: string;
  from: 'details' | 'chat';
  /** What the field showed before (kept as-is when it already had the same value). */
  before?: string;
}
export interface FillPlan {
  fills: FillItem[];
  skipped: { ref: string; label: string; why: string }[];
  /** Fields with no matching detail (left empty). */
  unmatched: { ref: string; label: string }[];
}

const labelOf = (i: Pick<DesktopItem, 'name' | 'aid' | 'hint' | 'ref'>) => (i.name || i.hint || i.aid || i.ref).slice(0, 80);
const norm = (s: string) => s.toLowerCase().replace(/[\s\u00a0]+/g, ' ').trim();

/**
 * The plan for one page: every fillable field mapped to a detail (or to a value from the chat, by the
 * field's label, id or detail key). Values from the chat are checked like My details (no card numbers,
 * no SSNs). Fields that already show exactly that value are left alone.
 */
export function planFill(items: DesktopItem[], details: MyDetails, o: { values?: Record<string, string>; address?: AddressPick; pageText?: string; only?: string[] } = {}): FillPlan {
  const plan: FillPlan = { fills: [], skipped: [], unmatched: [] };
  const chat = Object.entries(o.values ?? {}).map(([k, v]) => ({ k: norm(k), v: String(v).trim() })).filter((x) => x.k && x.v);
  for (const x of chat) {
    const why = refusalFor(x.v);
    if (why) throw new FormFillError(`The value for \u201c${x.k}\u201d: ${why}`);
  }
  const only = o.only?.map(norm).filter(Boolean);
  const seen = new Set<string>();
  for (const it of items) {
    if (!FIELD_ROLES.test(it.role) || it.disabled) continue;
    const label = labelOf(it);
    const kind = fieldKind(it);
    if (kind && NEVER.has(kind)) {
      plan.skipped.push({ ref: it.ref, label, why: NEVER_WHY[kind as NeverKind] });
      continue;
    }
    // The browser's own address bar and the page's search boxes are never form fields.
    if (/address and search bar|search or (enter|type)|search the web|^search$/i.test(it.name ?? '')) continue;
    if (!kind && ignoredField(it)) continue;
    const key = kind as FieldKey | undefined;
    const words = [it.name, it.aid, it.hint, key].filter(Boolean).map((s) => norm(String(s)));
    if (only?.length && !only.some((w) => words.some((x) => x.includes(w)) || (key && norm(LABEL[key]).includes(w)))) continue;
    const said = chat.find((c) => words.some((w) => w === c.k) || (key && (c.k === norm(key) || c.k === norm(LABEL[key])))) ?? chat.find((c) => words.some((w) => w.includes(c.k)));
    const value = said?.v ?? (key ? detailValue(details, key, o) : undefined);
    if (!value) {
      plan.unmatched.push({ ref: it.ref, label });
      continue;
    }
    // One value per detail and field (a page that lists the same field twice gets it once).
    const sig = `${it.role}|${it.name ?? ''}|${it.aid ?? ''}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    plan.fills.push({ ref: it.ref, label, role: it.role, ...(it.name ? { name: it.name } : {}), ...(it.aid ? { aid: it.aid } : {}), ...(it.hint ? { hint: it.hint } : {}), ...(key ? { key } : {}), value, from: said ? 'chat' : 'details', ...(it.value ? { before: it.value } : {}) });
  }
  return plan;
}

export class FormFillError extends Error {}

/** The one review list on the computer's card (every field → value, and what is left for the person). */
export function reviewText(plan: FillPlan, max = 2200): string {
  const lines = plan.fills.map((f) => `${f.label} \u2192 ${f.value}`);
  if (plan.skipped.length) lines.push(`Not filled: ${plan.skipped.map((s) => `${s.label} (${s.why})`).join('; ')}`);
  let out = lines.join('\n');
  if (out.length > max) out = `${out.slice(0, max - 20)}\n\u2026 (more fields)`;
  return out;
}

/** Same element in a fresh look (refs may renumber after each action): role + name + id, else role + hint. */
export function findAgain(items: DesktopItem[], f: Pick<FillItem, 'role' | 'name' | 'aid' | 'hint' | 'ref'>): DesktopItem | undefined {
  const same = items.filter((i) => i.role === f.role && (i.name ?? '') === (f.name ?? '') && (i.aid ?? '') === (f.aid ?? '') && (!f.hint || (i.hint ?? '') === f.hint));
  if (same.length === 1) return same[0];
  if (same.length > 1) return same.find((i) => i.ref === f.ref) ?? same[0];
  return undefined;
}

/** Did the field take the value? (a picked option may show its own text: \"TX\" vs \"Texas\" counts when one holds the other). */
export function valueMatches(shown: string | undefined, want: string): boolean {
  if (shown === undefined) return false;
  const a = norm(shown);
  const b = norm(want);
  if (a === b) return true;
  const digits = (s: string) => s.replace(/\D/g, '');
  if (digits(b).length >= 7 && digits(a) === digits(b)) return true;
  return a.length > 0 && (a.includes(b) || (b.length > 3 && b.includes(a)));
}

// ------------------------------------------------------------------ doing it through the computer

export interface DeskView {
  viewId: string;
  window: string;
  title?: string;
  app?: string;
  items: DesktopItem[];
}
/** The desktop actions a form fill needs (computer.ts gives the real one; tests a fake). Each act returns a fresh look. */
export interface DeskPort {
  look(window: string): Promise<DeskView>;
  type(view: DeskView, ref: string, text: string, o: { review?: string; forceOnce?: boolean }): Promise<DeskView>;
}

export interface FillReport {
  typed: { label: string; value: string; verified: boolean; shown?: string }[];
  failed: { label: string; why: string }[];
  skipped: FillPlan['skipped'];
  unmatched: FillPlan['unmatched'];
  stoppedAt?: string;
}

/**
 * Types each planned field (the first carries the review list for the computer's one card; on a payment or
 * sign-in page every field asks again), then looks once more and checks each value. Never presses Submit.
 */
export async function runFill(port: DeskPort, view: DeskView, plan: FillPlan, o: { sensitive: boolean; review: string; gapMs?: number }): Promise<FillReport> {
  // The computer takes at most 4 actions a second: a short gap between fields, and one wait-and-retry when it says too fast.
  const gap = o.gapMs ?? 300;
  const wait = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
  const rep: FillReport = { typed: [], failed: [], skipped: plan.skipped, unmatched: plan.unmatched };
  let cur = view;
  let first = true;
  for (const f of plan.fills) {
    const target = findAgain(cur.items, f);
    if (!target) {
      rep.failed.push({ label: f.label, why: 'the field is not on the page any more' });
      continue;
    }
    if (target.secret) {
      rep.failed.push({ label: f.label, why: NEVER_WHY.password });
      continue;
    }
    if (target.value !== undefined && valueMatches(target.value, f.value) && norm(target.value) === norm(f.value)) {
      rep.typed.push({ label: f.label, value: f.value, verified: true, shown: target.value });
      first = false;
      continue;
    }
    try {
      const send = () => port.type(cur, target.ref, f.value, { ...(first ? { review: o.review } : {}), forceOnce: o.sensitive });
      if (!first) await wait(gap);
      cur = await send().catch(async (err: Error) => {
        if (!/too fast|rate.?limit/i.test(err.message)) throw err;
        await wait(Math.max(gap, 1100));
        return send();
      });
      first = false;
      rep.typed.push({ label: f.label, value: f.value, verified: false });
    } catch (err) {
      const why = (err as Error).message;
      rep.failed.push({ label: f.label, why: why.slice(0, 300) });
      // The person said no, stopped her or took over: stop here (never type the rest behind their back).
      if (/did not approve|Stopped|Paused|takeover|took over/i.test(why)) {
        rep.stoppedAt = f.label;
        break;
      }
    }
  }
  // The read-back: one fresh look, each typed field's value.
  const fresh = await port.look(cur.window).catch(() => undefined);
  if (fresh) {
    for (const t of rep.typed) {
      if (t.verified) continue;
      const f = plan.fills.find((x) => x.label === t.label && x.value === t.value)!;
      const now = findAgain(fresh.items, f);
      t.shown = now?.value;
      t.verified = valueMatches(now?.value, t.value);
    }
  }
  return rep;
}

/** The reply text: what was filled and verified, what was left, and the stop before Submit. */
export function reportText(rep: FillReport, o: { sensitive: boolean; page: string }): string {
  const lines: string[] = [];
  const ok = rep.typed.filter((t) => t.verified);
  const bad = rep.typed.filter((t) => !t.verified);
  lines.push(`Form on \u201c${o.page}\u201d: filled ${rep.typed.length} field${rep.typed.length === 1 ? '' : 's'}${rep.failed.length ? `, ${rep.failed.length} not filled` : ''}.`);
  if (ok.length) lines.push(`Verified: read back from the page: ${ok.map((t) => `${t.label} = \u201c${t.value}\u201d`).join('; ')}.`);
  if (bad.length) lines.push(`Could not verify: ${bad.map((t) => `${t.label} shows ${t.shown === undefined ? 'nothing I can read' : `\u201c${t.shown}\u201d`} (wanted \u201c${t.value}\u201d)`).join('; ')}.`);
  for (const f of rep.failed) lines.push(`Not filled: ${f.label} (${f.why}).`);
  if (rep.skipped.length) lines.push(`Left for them on purpose: ${rep.skipped.map((s) => `${s.label} (${s.why})`).join('; ')}.`);
  if (rep.unmatched.length) lines.push(`No saved detail for: ${rep.unmatched.map((u) => u.label).join(', ')} (ask them, then call again with values).`);
  if (rep.stoppedAt) lines.push(`Stopped at ${rep.stoppedAt}: the owner declined, stopped or took over on the computer. Don't go on unless they ask.`);
  lines.push(`STOPPED before Submit: nothing was submitted. Tell them to check the page and press Submit themselves, or to say \u201csubmit it\u201d${o.sensitive ? ' (this is a payment, account or sign-in page: they press it themselves; never press it for them)' : '; then pc_look and pc_click the Submit button (a separate approval on their computer)'}.`);
  return lines.join('\n');
}

/** My details as text for the model (my_details_get). */
export function detailsText(d: MyDetails): string {
  const l = detailLines(d);
  return l.length ? l.join('\n') : '';
}
