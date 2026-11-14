// N4 (docs/MY_DETAILS.md): "My details", the facts a person types into forms again and again (name,
// emails, phones, addresses, sizes, vehicles, insurance and loyalty numbers, work, an emergency
// contact). Each person's own: kept in their space's own store.db (a household member's live in their
// space; nobody else reads them). Sara uses them to fill web forms in the person's own browser
// (pc_fill_form, src/form-fill.ts) and reads them with my_details_get.
//
// Never stored here, by design: passwords, payment card numbers, CVCs, Social Security numbers and full
// government ID numbers. The validators refuse values shaped like a card number (a Luhn-valid number
// with a card network's prefix) or an SSN, wherever they are typed, and there are no fields for them.
import type { DatabaseSync } from 'node:sqlite';
import { en } from './i18n.ts';

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}
export interface Vehicle {
  make?: string;
  model?: string;
  year?: string;
  plate?: string;
  vin?: string;
}
export interface Insurance {
  kind?: string;
  company?: string;
  policy?: string;
}
export interface Loyalty {
  store?: string;
  number?: string;
}
export interface MyDetails {
  firstName?: string;
  lastName?: string;
  email?: string;
  workEmail?: string;
  mobilePhone?: string;
  homePhone?: string;
  workPhone?: string;
  home?: Address;
  work?: Address;
  shipping?: Address;
  /** Optional, YYYY-MM-DD. */
  birthDate?: string;
  shirtSize?: string;
  pantsSize?: string;
  dressSize?: string;
  shoeSize?: string;
  vehicles?: Vehicle[];
  insurance?: Insurance[];
  loyalty?: Loyalty[];
  employer?: string;
  jobTitle?: string;
  emergency?: { name?: string; relation?: string; phone?: string };
}

export const DETAIL_LIMITS = { vehicles: 3, insurance: 4, loyalty: 8, chars: 120 } as const;

export class DetailError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

/** Luhn check over the digits of a number. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (d < 0 || d > 9) return false;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

/** A payment card number: 13-19 digits (spaces or dashes allowed), a card network's prefix, Luhn-valid. */
export function looksLikeCard(text: string): boolean {
  for (const m of text.matchAll(/\b\d(?:[ -]?\d){12,18}\b/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length < 13 || d.length > 19) continue;
    if (!/^(4|5[1-5]|2[2-7]|3[47]|3[068]|6011|65|64[4-9]|35|62)/.test(d)) continue;
    if (luhn(d)) return true;
  }
  return false;
}

/** A US Social Security number: 123-45-6789 / 123 45 6789 anywhere; bare nine digits only where a number isn't expected. */
export function looksLikeSsn(text: string, bareOk = false): boolean {
  if (/\b\d{3}[- ]\d{2}[- ]\d{4}\b/.test(text)) return true;
  return !bareOk && /^\s*\d{9}\s*$/.test(text);
}

/** Words that mean someone is about to store a secret. */
const SECRET_WORDS = /\b(?:password|passcode|passwd|pin ?(?:code|number|:)|cvv|cvc|security code|ssn|social security|passport (?:no|number|#)|driver'?s? licen[cs]e (?:no|number|#))(?![a-z])/i;

/** Why one value can't be kept (or undefined when it can). `numbered`: a field that holds an account-like number. */
export function refusalFor(value: string, numbered = false): string | undefined {
  if (looksLikeCard(value)) return en('That looks like a payment card number. Sara never keeps card numbers: you type those yourself on the payment page.');
  if (looksLikeSsn(value, numbered)) return en('That looks like a Social Security number. Sara never keeps SSNs or government ID numbers.');
  if (SECRET_WORDS.test(value)) return en('That looks like a password, PIN or ID number. Sara never keeps those here.');
  return undefined;
}

const text = (v: unknown, field: string, numbered = false, max: number = DETAIL_LIMITS.chars): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v).replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return undefined;
  if (s.length > max) throw new DetailError(field, en('That is too long.'));
  const why = refusalFor(s, numbered);
  if (why) throw new DetailError(field, why);
  return s;
};
const email = (v: unknown, field: string): string | undefined => {
  const s = text(v, field);
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new DetailError(field, en('That doesn’t look like an email address.'));
  return s;
};
const phone = (v: unknown, field: string): string | undefined => {
  const s = text(v, field, true, 40);
  if (s && !/^\+?[\d\s().-]{7,25}(?:\s*(?:x|ext\.?)\s*\d{1,6})?$/i.test(s)) throw new DetailError(field, en('That doesn’t look like a phone number.'));
  return s;
};
const address = (v: unknown, field: string): Address | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const a: Address = {};
  for (const k of ['line1', 'line2', 'city', 'state', 'zip', 'country'] as const) {
    const s = text(o[k], `${field}.${k}`, k === 'zip');
    if (s) a[k] = s;
  }
  if (a.zip && !/^[A-Za-z0-9 -]{3,10}$/.test(a.zip)) throw new DetailError(`${field}.zip`, en('That doesn’t look like a ZIP or postal code.'));
  return Object.keys(a).length ? a : undefined;
};
const list = <T extends object>(v: unknown, max: number, each: (o: Record<string, unknown>, i: number) => T | undefined): T[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const [i, x] of v.entries()) {
    if (!x || typeof x !== 'object') continue;
    const r = each(x as Record<string, unknown>, i);
    if (r && Object.keys(r).length) out.push(r);
  }
  return out.length ? out.slice(0, max) : undefined;
};

/** Checks and cleans everything a person typed; throws DetailError naming the field. */
export function cleanDetails(raw: Record<string, unknown>): MyDetails {
  const d: MyDetails = {};
  const put = <K extends keyof MyDetails>(k: K, v: MyDetails[K] | undefined) => {
    if (v !== undefined) d[k] = v;
  };
  put('firstName', text(raw.firstName, 'firstName'));
  put('lastName', text(raw.lastName, 'lastName'));
  put('email', email(raw.email, 'email'));
  put('workEmail', email(raw.workEmail, 'workEmail'));
  put('mobilePhone', phone(raw.mobilePhone, 'mobilePhone'));
  put('homePhone', phone(raw.homePhone, 'homePhone'));
  put('workPhone', phone(raw.workPhone, 'workPhone'));
  put('home', address(raw.home, 'home'));
  put('work', address(raw.work, 'work'));
  put('shipping', address(raw.shipping, 'shipping'));
  const bd = text(raw.birthDate, 'birthDate', true, 10);
  if (bd) {
    const ok = /^(\d{4})-(\d{2})-(\d{2})$/.exec(bd);
    const t = ok ? Date.UTC(Number(ok[1]), Number(ok[2]) - 1, Number(ok[3])) : NaN;
    if (!ok || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== bd || Number(ok[1]) < 1900 || t > Date.now()) throw new DetailError('birthDate', en('Use a date like 1985-04-23.'));
    d.birthDate = bd;
  }
  for (const k of ['shirtSize', 'pantsSize', 'dressSize', 'shoeSize'] as const) put(k, text(raw[k], k, true, 20));
  put('vehicles', list(raw.vehicles, DETAIL_LIMITS.vehicles, (o, i) => {
    const v: Vehicle = {};
    for (const k of ['make', 'model', 'year', 'plate', 'vin'] as const) {
      const s = text(o[k], `vehicles.${i}.${k}`, true, k === 'vin' ? 17 : 40);
      if (s) v[k] = s;
    }
    if (v.year && !/^(19|20)\d\d$/.test(v.year)) throw new DetailError(`vehicles.${i}.year`, en('Use a year like 2019.'));
    if (v.vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(v.vin)) throw new DetailError(`vehicles.${i}.vin`, en('A VIN has 17 letters and numbers (no I, O or Q).'));
    return v;
  }));
  put('insurance', list(raw.insurance, DETAIL_LIMITS.insurance, (o, i) => {
    const v: Insurance = {};
    for (const k of ['kind', 'company', 'policy'] as const) {
      const s = text(o[k], `insurance.${i}.${k}`, k === 'policy', 60);
      if (s) v[k] = s;
    }
    return v;
  }));
  put('loyalty', list(raw.loyalty, DETAIL_LIMITS.loyalty, (o, i) => {
    const v: Loyalty = {};
    for (const k of ['store', 'number'] as const) {
      const s = text(o[k], `loyalty.${i}.${k}`, k === 'number', 60);
      if (s) v[k] = s;
    }
    return v;
  }));
  put('employer', text(raw.employer, 'employer'));
  put('jobTitle', text(raw.jobTitle, 'jobTitle'));
  if (raw.emergency && typeof raw.emergency === 'object') {
    const o = raw.emergency as Record<string, unknown>;
    const e = { ...(text(o.name, 'emergency.name') ? { name: text(o.name, 'emergency.name')! } : {}), ...(text(o.relation, 'emergency.relation') ? { relation: text(o.relation, 'emergency.relation')! } : {}), ...(phone(o.phone, 'emergency.phone') ? { phone: phone(o.phone, 'emergency.phone')! } : {}) };
    if (Object.keys(e).length) d.emergency = e;
  }
  return d;
}

/** The details as short labelled lines (what my_details_get and the form review show). */
export function detailLines(d: MyDetails): string[] {
  const out: string[] = [];
  const add = (label: string, v: string | undefined) => {
    if (v) out.push(`${label}: ${v}`);
  };
  const addr = (a?: Address) => (a ? [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(', '), a.zip, a.country].filter(Boolean).join(', ') : undefined);
  add('Name', [d.firstName, d.lastName].filter(Boolean).join(' ') || undefined);
  add('Email', d.email);
  add('Work email', d.workEmail);
  add('Mobile phone', d.mobilePhone);
  add('Home phone', d.homePhone);
  add('Work phone', d.workPhone);
  add('Home address', addr(d.home));
  add('Work address', addr(d.work));
  add('Shipping address', addr(d.shipping));
  add('Date of birth', d.birthDate);
  add('Shirt size', d.shirtSize);
  add('Pants size', d.pantsSize);
  add('Dress size', d.dressSize);
  add('Shoe size', d.shoeSize);
  for (const [i, v] of (d.vehicles ?? []).entries()) add(`Vehicle ${i + 1}`, [v.year, v.make, v.model].filter(Boolean).join(' ') + (v.plate ? `, plate ${v.plate}` : '') + (v.vin ? `, VIN ${v.vin}` : ''));
  for (const [i, v] of (d.insurance ?? []).entries()) add(`Insurance ${i + 1}`, [v.kind, v.company].filter(Boolean).join(': ') + (v.policy ? `, policy ${v.policy}` : ''));
  for (const v of d.loyalty ?? []) add(`Loyalty (${v.store ?? 'store'})`, v.number);
  add('Employer', d.employer);
  add('Job title', d.jobTitle);
  if (d.emergency) add('Emergency contact', [d.emergency.name, d.emergency.relation ? `(${d.emergency.relation})` : '', d.emergency.phone].filter(Boolean).join(' '));
  return out;
}

/** Each person's details in their own space's store.db (one row). */
export class MyDetailsStore {
  readonly #db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.#db = db;
    db.exec('CREATE TABLE IF NOT EXISTS my_details (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS my_details_prefs (id INTEGER PRIMARY KEY CHECK (id = 1), leave_store_tab INTEGER NOT NULL DEFAULT 0)');
  }
  /** N4: after a store check in the person's own browser, leave the store's tab open (default: close it). */
  leaveStoreTab(): boolean {
    return (this.#db.prepare('SELECT leave_store_tab AS v FROM my_details_prefs WHERE id = 1').get() as { v: number } | undefined)?.v === 1;
  }
  setLeaveStoreTab(on: boolean): void {
    this.#db.prepare('INSERT INTO my_details_prefs (id, leave_store_tab) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET leave_store_tab = excluded.leave_store_tab').run(on ? 1 : 0);
  }
  get(): MyDetails {
    const r = this.#db.prepare('SELECT data FROM my_details WHERE id = 1').get() as { data: string } | undefined;
    if (!r) return {};
    try {
      return JSON.parse(r.data) as MyDetails;
    } catch {
      return {};
    }
  }
  updatedAt(): string | null {
    return (this.#db.prepare('SELECT updated_at FROM my_details WHERE id = 1').get() as { updated_at: string } | undefined)?.updated_at ?? null;
  }
  /** Replaces the details with the cleaned ones (throws DetailError on a refused value; nothing is saved then). */
  set(raw: Record<string, unknown>, now = new Date()): MyDetails {
    const d = cleanDetails(raw);
    this.#db.prepare('INSERT INTO my_details (id, data, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at').run(JSON.stringify(d), now.toISOString());
    return d;
  }
  clear(): void {
    this.#db.prepare('DELETE FROM my_details').run();
  }
}

const stores = new WeakMap<DatabaseSync, MyDetailsStore>();
/** The store for one space's database (one instance per database). */
export function myDetailsFor(db: DatabaseSync): MyDetailsStore {
  let s = stores.get(db);
  if (!s) {
    s = new MyDetailsStore(db);
    stores.set(db, s);
  }
  return s;
}
