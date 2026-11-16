// N3 (docs/INBOX_HELPER.md): what a new email is about, by rules first. Airlines, hotels and shops
// put schema.org JSON-LD in their HTML mail (ParcelDelivery, FlightReservation, LodgingReservation,
// Invoice, Order, EventReservation); those are read as data. Plain-text mail goes through sender,
// subject and body patterns, and carrier tracking-number shapes (UPS, USPS, FedEx, DHL, Amazon).
// Nothing here calls a model or the network: an unclear mail is only flagged (`unclear`) so the
// helper may ask a small model when the person allows it (never in private local mode).
// Email text is other people's words: it is read as data and never followed.

import { schoolFindings } from './school.ts';

export const INBOX_KINDS = ['bill', 'receipt', 'shipping', 'trip', 'appointment', 'invoice_paid', 'file', 'school'] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];
/** Kinds that may run on their own once the person turns on "do it for me" (filing has its rules). */
export const AUTO_KINDS = ['bill', 'receipt', 'shipping', 'trip', 'appointment', 'invoice_paid', 'school'] as const;

/** One new email, the same for every mailbox. */
export interface InboxMail {
  /** The mailbox (its address). */
  account: string;
  id: string;
  from: string;
  subject: string;
  /** ISO time it arrived. */
  date: string;
  text: string;
  html?: string;
  attachments?: string[];
}

export interface Flight {
  flight: string;
  from?: string;
  to?: string;
  /** Local wall time as written, YYYY-MM-DDTHH:MM (or an ISO time with an offset from JSON-LD). */
  departs?: string;
  arrives?: string;
}
/** S6 (docs/TRAVEL.md): a rental car; places as written, times as local wall time (or ISO with an offset). */
export interface Car {
  company: string;
  pickup?: string;
  pickupAt?: string;
  dropoff?: string;
  dropoffAt?: string;
}
/** S6: a train (or a coach) ride. */
export interface Train {
  train: string;
  from?: string;
  to?: string;
  departs?: string;
  arrives?: string;
}
export interface Hotel {
  name: string;
  address?: string;
  checkIn?: string;
  checkOut?: string;
}

export interface Finding {
  kind: InboxKind;
  /** Short line for the card ("Bill from City Power: $84.20, due Nov 28"). Built by the helper. */
  source: 'jsonld' | 'rules' | 'model';
  /** Stable identity of the thing (tracking number, confirmation code, order or invoice number). */
  ref?: string;
  // bill / receipt / invoice
  payee?: string;
  vendor?: string;
  amount?: string;
  due?: string;
  date?: string;
  items?: string[];
  order?: string;
  invoice?: string;
  // shipping
  carrier?: string;
  tracking?: string;
  status?: PackageStatus;
  eta?: string;
  // trip
  confirmation?: string;
  flights?: Flight[];
  hotel?: Hotel;
  car?: Car;
  trains?: Train[];
  // appointment
  title?: string;
  start?: string;
  end?: string;
  place?: string;
  /** R8: school mail (src/inbox/school.ts): what kind of school date (title, start = the day, due for slips). */
  school?: import('./school.ts').SchoolType;
}

export type PackageStatus = 'ordered' | 'shipped' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'problem';

// ---------------------------------------------------------------- small text helpers

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** "Ana Bell <ana@x.com>" -> "Ana Bell"; a bare address -> its domain's first word, capitalized. */
export function senderName(from: string): string {
  const name = /^\s*"?([^"<]+?)"?\s*</.exec(from)?.[1]?.trim();
  if (name && !/@/.test(name)) return clip(name.replace(/\s+(team|support|notifications?|no-?reply)$/i, ''), 60);
  const domain = senderDomain(from);
  const word = domain.split('.').slice(-2, -1)[0] ?? domain;
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : from;
}
export function senderDomain(from: string): string {
  const addr = (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
  return addr.includes('@') ? addr.split('@').pop()!.replace(/[^a-z0-9.-]/g, '') : '';
}

/** HTML to plain text, enough to read (tags out, entities, line breaks kept). */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** A money amount ("$1,204.50", "USD 12", "12.00 EUR") -> "1204.50". */
export function amountOf(s: string): string | undefined {
  const m = /(?:[$€£]|USD|EUR|GBP)\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)|(\d{1,3}(?:,\d{3})*\.\d{2})\s?(?:USD|EUR|GBP|€)/i.exec(s);
  const v = (m?.[1] ?? m?.[2])?.replace(/,/g, '');
  return v && Number(v) > 0 ? (v.includes('.') ? v : `${v}.00`) : undefined;
}

/**
 * The first date in a piece of text, as YYYY-MM-DD (and HH:MM when a time follows it). Reads
 * "November 20, 2026", "Nov 20", "Fri, Nov 20 at 3:30 PM", "11/20/2026", "2026-11-20 14:05".
 * A date without a year is the next one on or after `now` (in the mail's own words, local time).
 */
export function findDate(text: string, now: Date): { day: string; time?: string } | undefined {
  const s = text.replace(/\s+/g, ' ');
  const year = now.getUTCFullYear();
  const pick = (y: number | undefined, mo: number, d: number): string | undefined => {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined;
    let yy = y ?? year;
    if (yy < 100) yy += 2000;
    if (y === undefined && Date.UTC(yy, mo - 1, d) < Date.UTC(year, now.getUTCMonth(), now.getUTCDate()) - 31 * 86_400_000) yy++;
    return `${yy}-${pad(mo)}-${pad(d)}`;
  };
  const cands: { at: number; day: string; end: number }[] = [];
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})/g)) {
    const day = pick(Number(m[1]), Number(m[2]), Number(m[3]));
    if (day) cands.push({ at: m.index!, day, end: m.index! + m[0].length });
  }
  for (const m of s.matchAll(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/gi)) {
    const day = pick(m[3] ? Number(m[3]) : undefined, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, Number(m[2]));
    if (day) cands.push({ at: m.index!, day, end: m.index! + m[0].length });
  }
  for (const m of s.matchAll(/\b(\d{1,2}) (jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,? (\d{4}))?\b/gi)) {
    const day = pick(m[3] ? Number(m[3]) : undefined, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[1]));
    if (day) cands.push({ at: m.index!, day, end: m.index! + m[0].length });
  }
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g)) {
    const day = pick(Number(m[3]), Number(m[1]), Number(m[2]));
    if (day) cands.push({ at: m.index!, day, end: m.index! + m[0].length });
  }
  const first = cands.sort((a, b) => a.at - b.at)[0];
  if (!first) return undefined;
  const after = s.slice(first.end, first.end + 24);
  const tm = /^(?:,|\s|at|from|@|T)*\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?/i.exec(after);
  let time: string | undefined;
  if (tm && (tm[2] || tm[3])) {
    let h = Number(tm[1]);
    const ap = tm[3]?.toLowerCase().replace(/\./g, '');
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h <= 23) time = `${pad(h)}:${tm[2] ?? '00'}`;
  }
  return { day: first.day, ...(time ? { time } : {}) };
}

/** The date written after one of the labels ("Due date: Nov 28"), else undefined. */
function dateAfter(text: string, label: RegExp, now: Date): { day: string; time?: string } | undefined {
  const m = label.exec(text);
  if (!m) return undefined;
  return findDate(text.slice(m.index + m[0].length, m.index + m[0].length + 80), now);
}
const at = (d: { day: string; time?: string } | undefined): string | undefined => (d ? (d.time ? `${d.day}T${d.time}` : d.day) : undefined);

// ---------------------------------------------------------------- carriers

/** Tracking-number shapes. The plain-digit ones need the carrier's name nearby. */
const CARRIERS: { carrier: string; re: RegExp; needs?: RegExp }[] = [
  { carrier: 'UPS', re: /\b(1Z[0-9A-Z]{16})\b/ },
  { carrier: 'Amazon', re: /\b(TBA\d{12})\b/ },
  { carrier: 'USPS', re: /\b((?:94|93|92|95|82)\d{20}|(?:94|93|92|95)\d{18})\b/ },
  { carrier: 'USPS', re: /\b([A-Z]{2}\d{9}US)\b/ },
  { carrier: 'FedEx', re: /\b(\d{12}|\d{15}|\d{20})\b/, needs: /fed\s?ex/i },
  { carrier: 'DHL', re: /\b(\d{10}|JJD\d{10,18}|JD\d{18})\b/, needs: /\bdhl\b/i },
];

export function trackingIn(text: string): { carrier: string; tracking: string } | undefined {
  const s = text.replace(/\b\d{4}(?: \d{2,4}){2,}\b/g, (g) => g.replace(/ /g, ''));
  for (const c of CARRIERS) {
    if (c.needs && !c.needs.test(text)) continue;
    const m = c.re.exec(s);
    if (m) return { carrier: c.carrier, tracking: m[1]! };
  }
  return undefined;
}

export function packageStatus(text: string): PackageStatus | undefined {
  const s = text.toLowerCase();
  if (/\b(was|has been|been) delivered\b|\bdelivered\b(?! by)|\bdelivery (complete|completed)\b/.test(s) && !/(will be|to be|expected|estimated|scheduled) delivered/.test(s)) return 'delivered';
  if (/out for delivery/.test(s)) return 'out_for_delivery';
  if (/delivery (exception|attempt)|could not be delivered|delayed|held at/.test(s)) return 'problem';
  if (/in transit|on (its|the) way|arriving/.test(s)) return 'in_transit';
  if (/\bshipped\b|has shipped|shipment|label created/.test(s)) return 'shipped';
  return undefined;
}

// ---------------------------------------------------------------- JSON-LD

/** Every schema.org object in the HTML's ld+json blocks (arrays and @graph flattened). */
export function jsonLd(html: string | undefined): Record<string, unknown>[] {
  if (!html) return [];
  const out: Record<string, unknown>[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v || typeof v !== 'object') return;
    if (Array.isArray(v)) return void v.slice(0, 20).forEach((x) => walk(x, depth + 1));
    const o = v as Record<string, unknown>;
    if (Array.isArray(o['@graph'])) walk(o['@graph'], depth + 1);
    if (o['@type']) out.push(o);
  };
  for (const m of html.slice(0, 500_000).matchAll(/<script[^>]+type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      walk(JSON.parse(m[1]!.replace(/&quot;/g, '"').trim()), 0);
    } catch {
      /* a broken block is skipped */
    }
  }
  return out.slice(0, 20);
}

const type = (o: Record<string, unknown>): string => String(Array.isArray(o['@type']) ? o['@type'][0] : o['@type']).replace(/^.*[/:]/, '');
const obj = (v: unknown): Record<string, unknown> => (Array.isArray(v) ? obj(v[0]) : v && typeof v === 'object' ? (v as Record<string, unknown>) : {});
const str = (v: unknown, n = 120): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'object') return str(obj(v).name ?? obj(v)['@id'], n);
  const s = clip(v, n);
  return s || undefined;
};
const money = (v: unknown): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'number') return v.toFixed(2);
  if (typeof v === 'string') return amountOf(v.startsWith('$') ? v : `$${v}`) ?? undefined;
  const o = obj(v);
  return money(o.price ?? o.value ?? o.totalPrice);
};
const addressOf = (v: unknown): string | undefined => {
  if (typeof v === 'string') return clip(v, 200);
  const o = obj(v);
  if (o.address) return addressOf(o.address);
  const parts = [o.streetAddress, o.addressLocality, o.addressRegion, o.postalCode].map((x) => clip(x, 80)).filter(Boolean);
  return parts.length ? parts.join(', ') : undefined;
};
/** "2026-11-20T08:05:00-06:00" stays as is; "2026-11-20" too. */
const when = (v: unknown): string | undefined => {
  const s = str(v, 40);
  return s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s : undefined;
};
const airport = (v: unknown): string | undefined => {
  const o = obj(v);
  return str(o.iataCode, 4) ?? str(o.name, 80);
};

function fromJsonLd(items: Record<string, unknown>[]): Finding[] {
  const out: Finding[] = [];
  const flights: Flight[] = [];
  let flightConf: string | undefined;
  for (const o of items) {
    const t = type(o);
    if (t === 'ParcelDelivery') {
      const order = obj(o.partOfOrder);
      const tracking = str(o.trackingNumber, 40);
      if (!tracking) continue;
      const ds = str(o.deliveryStatus, 80)?.toLowerCase() ?? '';
      const status: PackageStatus | undefined = /delivered/.test(ds) ? 'delivered' : /outfordelivery|out for/.test(ds.replace(/\s/g, '')) ? 'out_for_delivery' : /transit/.test(ds) ? 'in_transit' : /problem|exception/.test(ds) ? 'problem' : 'shipped';
      out.push({ kind: 'shipping', source: 'jsonld', ref: tracking, tracking, carrier: str(o.carrier ?? o.provider, 40) ?? trackingIn(tracking)?.carrier ?? 'Carrier', status, ...(when(o.expectedArrivalUntil ?? o.expectedArrivalFrom) ? { eta: when(o.expectedArrivalUntil ?? o.expectedArrivalFrom)!.slice(0, 10) } : {}), ...(str(order.merchant ?? o.provider, 60) ? { vendor: str(order.merchant, 60) ?? str(o.provider, 60) } : {}), ...(str(order.orderNumber, 40) ? { order: str(order.orderNumber, 40) } : {}) });
    } else if (t === 'FlightReservation') {
      const f = obj(o.reservationFor);
      const air = obj(f.airline);
      const num = str(f.flightNumber, 10);
      if (!num) continue;
      const code = str(air.iataCode, 4) ?? '';
      flights.push({ flight: `${code && !num.startsWith(code) ? code : ''}${num}`.replace(/\s+/g, ''), ...(airport(f.departureAirport) ? { from: airport(f.departureAirport) } : {}), ...(airport(f.arrivalAirport) ? { to: airport(f.arrivalAirport) } : {}), ...(when(f.departureTime) ? { departs: when(f.departureTime) } : {}), ...(when(f.arrivalTime) ? { arrives: when(f.arrivalTime) } : {}) });
      flightConf ??= str(o.reservationNumber, 20);
    } else if (t === 'LodgingReservation') {
      const h = obj(o.reservationFor);
      const name = str(h.name, 80);
      if (!name) continue;
      out.push({ kind: 'trip', source: 'jsonld', ref: str(o.reservationNumber, 20) ?? `${name}|${when(o.checkinTime) ?? ''}`, confirmation: str(o.reservationNumber, 20), hotel: { name, ...(addressOf(h.address) ? { address: addressOf(h.address) } : {}), ...(when(o.checkinTime ?? o.checkinDate) ? { checkIn: when(o.checkinTime ?? o.checkinDate) } : {}), ...(when(o.checkoutTime ?? o.checkoutDate) ? { checkOut: when(o.checkoutTime ?? o.checkoutDate) } : {}) } });
    } else if (t === 'RentalCarReservation') {
      // S6: a rental car (pickup and drop-off places and times).
      const company = str(obj(o.reservationFor).rentalCompany ?? o.provider ?? obj(o.reservationFor).brand, 60);
      if (!company) continue;
      const pick = addressOf(o.pickupLocation) ?? str(o.pickupLocation, 120);
      const drop = addressOf(o.dropoffLocation) ?? str(o.dropoffLocation, 120);
      out.push({ kind: 'trip', source: 'jsonld', ref: str(o.reservationNumber, 20) ?? `${company}|${when(o.pickupTime) ?? ''}`, ...(str(o.reservationNumber, 20) ? { confirmation: str(o.reservationNumber, 20) } : {}), car: { company, ...(pick ? { pickup: pick } : {}), ...(when(o.pickupTime) ? { pickupAt: when(o.pickupTime) } : {}), ...(drop ? { dropoff: drop } : {}), ...(when(o.dropoffTime) ? { dropoffAt: when(o.dropoffTime) } : {}) } });
    } else if (t === 'TrainReservation' || t === 'BusReservation') {
      // S6: a train or coach ride.
      const f = obj(o.reservationFor);
      const num = str(f.trainNumber ?? f.busNumber ?? f.name, 20);
      if (!num) continue;
      const from = str(obj(f.departureStation ?? f.departureBusStop).name, 80);
      const to = str(obj(f.arrivalStation ?? f.arrivalBusStop).name, 80);
      out.push({ kind: 'trip', source: 'jsonld', ref: str(o.reservationNumber, 20) ?? `${num}|${when(f.departureTime) ?? ''}`, ...(str(o.reservationNumber, 20) ? { confirmation: str(o.reservationNumber, 20) } : {}), trains: [{ train: num, ...(from ? { from } : {}), ...(to ? { to } : {}), ...(when(f.departureTime) ? { departs: when(f.departureTime) } : {}), ...(when(f.arrivalTime) ? { arrives: when(f.arrivalTime) } : {}) }] });
    } else if (t === 'Invoice') {
      const payee = str(o.provider ?? o.broker, 60);
      const amount = money(o.totalPaymentDue ?? o.minimumPaymentDue);
      const status = str(o.paymentStatus, 60)?.toLowerCase() ?? '';
      if (/paymentcomplete|paid/.test(status.replace(/\s/g, ''))) {
        out.push({ kind: 'invoice_paid', source: 'jsonld', ref: str(o.confirmationNumber ?? o.identifier ?? o.accountId, 40), invoice: str(o.confirmationNumber ?? o.identifier, 40), ...(payee ? { payee } : {}), ...(amount ? { amount } : {}) });
      } else if (payee || amount) out.push({ kind: 'bill', source: 'jsonld', ref: `${payee ?? ''}|${when(o.paymentDueDate) ?? ''}|${amount ?? ''}`, ...(payee ? { payee } : {}), ...(amount ? { amount } : {}), ...(when(o.paymentDueDate ?? o.paymentDue) ? { due: when(o.paymentDueDate ?? o.paymentDue)!.slice(0, 10) } : {}) });
    } else if (t === 'Order') {
      const offers = (Array.isArray(o.acceptedOffer) ? o.acceptedOffer : o.acceptedOffer ? [o.acceptedOffer] : []) as unknown[];
      const items = offers.map((x) => str(obj(obj(x).itemOffered).name, 80)).filter((x): x is string => Boolean(x)).slice(0, 10);
      const total = money(o.price ?? o.totalPaymentDue ?? obj(o.priceSpecification).price);
      out.push({ kind: 'receipt', source: 'jsonld', ref: str(o.orderNumber, 40), vendor: str(o.merchant ?? o.seller, 60), ...(total ? { amount: total } : {}), ...(when(o.orderDate) ? { date: when(o.orderDate)!.slice(0, 10) } : {}), ...(items.length ? { items } : {}), ...(str(o.orderNumber, 40) ? { order: str(o.orderNumber, 40) } : {}) });
    } else if (t === 'EventReservation' || t === 'FoodEstablishmentReservation' || t === 'Reservation') {
      const ev = obj(o.reservationFor);
      const title = str(ev.name, 100);
      const start = when(ev.startDate ?? o.startTime ?? o.startDate);
      if (!title || !start) continue;
      out.push({ kind: 'appointment', source: 'jsonld', ref: str(o.reservationNumber, 30) ?? `${title}|${start}`, title, start, ...(when(ev.endDate ?? o.endTime) ? { end: when(ev.endDate ?? o.endTime) } : {}), ...(addressOf(ev.location) ?? str(ev.location, 120) ? { place: addressOf(ev.location) ?? str(ev.location, 120) } : {}), ...(str(o.reservationNumber, 30) ? { confirmation: str(o.reservationNumber, 30) } : {}) });
    }
  }
  if (flights.length) out.unshift({ kind: 'trip', source: 'jsonld', ref: flightConf ?? flights.map((f) => `${f.flight}|${f.departs ?? ''}`).join(','), ...(flightConf ? { confirmation: flightConf } : {}), flights });
  // A flight and a hotel in one mail: one trip.
  const trips = out.filter((f) => f.kind === 'trip');
  if (trips.length > 1) {
    const one: Finding = { ...trips[0]!, flights: trips.flatMap((x) => x.flights ?? []), ...(trips.find((x) => x.hotel) ? { hotel: trips.find((x) => x.hotel)!.hotel } : {}), ...(trips.find((x) => x.car) ? { car: trips.find((x) => x.car)!.car } : {}), ...(trips.some((x) => x.trains) ? { trains: trips.flatMap((x) => x.trains ?? []) } : {}) };
    return [one, ...out.filter((f) => f.kind !== 'trip')];
  }
  return out;
}

// ---------------------------------------------------------------- plain-text rules

const NEWSLETTER = /\b(newsletter|unsubscribe from|webinar|sale ends|% off|deal of the day|recommended for you)\b/i;

function fromRules(m: InboxMail, text: string, now: Date): Finding[] {
  const subj = m.subject;
  const all = `${subj}\n${text}`;
  const out: Finding[] = [];
  const name = senderName(m.from);

  // E6 invoice paid: our own invoice number (INV-2026-0003) and a payment word.
  const inv = /\b(INV-\d{4}-\d{3,5})\b/.exec(all)?.[1];
  if (inv && /\b(paid|payment (received|sent|completed|confirmation)|you('ve| have) been paid|remittance)\b/i.test(all)) {
    out.push({ kind: 'invoice_paid', source: 'rules', ref: inv, invoice: inv, payee: name, ...(amountOf(all) ? { amount: amountOf(all) } : {}), ...(findDate(text, now) ? { date: findDate(text, now)!.day } : {}) });
    return out;
  }

  // Shipping: a tracking number plus shipping words.
  const tr = trackingIn(all);
  if (tr && /\b(ship|shipped|shipment|tracking|track (your|my) package|deliver|delivery|on (its|the) way|out for delivery|package|parcel)\b/i.test(all)) {
    const eta = dateAfter(all, /\b(arriving|expected (delivery|by|on)|estimated delivery( date)?|delivery date|arrives|will arrive)\b:?/i, now);
    const order = /\border\s*(?:#|no\.?|number)?:?\s*([A-Z0-9-]{5,30})/i.exec(all)?.[1];
    out.push({ kind: 'shipping', source: 'rules', ref: tr.tracking, ...tr, status: packageStatus(all) ?? 'shipped', vendor: name, ...(eta ? { eta: eta.day } : {}), ...(order ? { order } : {}) });
    return out;
  }

  // Flights: a flight number and a confirmation code (the airline's own mail).
  const conf = /\b(?:confirmation|booking|record locator|reservation)\s*(?:code|number|#|no\.?)?\s*(?:is)?:?\s*([A-Z0-9]{6})\b/i.exec(all)?.[1];
  const flightNos = [...all.matchAll(/\bflight\s*(?:#|number)?:?\s*([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/gi)].map((x) => `${x[1]!.toUpperCase()}${x[2]}`);
  if (flightNos.length && (conf || /\b(itinerary|boarding|departs?|departure)\b/i.test(all))) {
    // S6: each flight reads the route and times written after it (up to the next flight).
    const marks = [...all.matchAll(/\bflight\s*(?:#|number)?:?\s*([A-Z]{2}|[A-Z]\d|\d[A-Z])\s?(\d{1,4})\b/gi)];
    const seenNo = new Set<string>();
    const flights: Flight[] = [];
    marks.forEach((x, i) => {
      const f = `${x[1]!.toUpperCase()}${x[2]}`;
      if (seenNo.has(f) || flights.length >= 6) return;
      seenNo.add(f);
      const part = all.slice(x.index!, marks[i + 1]?.index ?? all.length);
      const dep = dateAfter(part, /\b(depart(s|ure|ing)?|leaves?)\b:?/i, now) ?? (i === 0 ? findDate(text, now) : undefined);
      const arr = dateAfter(part, /\b(arriv(es|al|ing)|lands?)\b:?/i, now);
      const route = /\b([A-Z]{3})\s*(?:→|->|to|–|-)\s*([A-Z]{3})\b/.exec(part) ?? (i === 0 ? /\b([A-Z]{3})\s*(?:→|->|to|–|-)\s*([A-Z]{3})\b/.exec(all) : null);
      flights.push({ flight: f, ...(route ? { from: route[1], to: route[2] } : {}), ...(at(dep) ? { departs: at(dep) } : {}), ...(at(arr) ? { arrives: at(arr) } : {}) });
    });
    out.push({ kind: 'trip', source: 'rules', ref: conf ?? flights.map((f) => `${f.flight}|${f.departs ?? ''}`).join(','), ...(conf ? { confirmation: conf.toUpperCase() } : {}), flights });
    return out;
  }
  // S6: rental cars: a pick-up and a return/drop-off with dates, and rental words.
  const carConf = /\b(?:confirmation|reservation|booking)[ \t]*(?:code|number|#|no\.?)?[ \t]*(?:is)?:?[ \t]*((?=[A-Z]*\d)[A-Z0-9]{5,12})\b/i.exec(all)?.[1];
  if (/\b(car rental|rental car|rent(?:ing|ed)? a car|renting with|your rental)\b/i.test(all)) {
    const pl = /\bpick[- ]?up\b(?: (?:location|date|time))*:?\s*([^\n]*)/i.exec(all);
    const dl = /\b(?:return|drop[- ]?off)\b(?: (?:location|date|time))*:?\s*([^\n]*)/i.exec(all);
    const pAt = pl ? findDate(pl[1]!, now) : undefined;
    const dAt = dl ? findDate(dl[1]!, now) : undefined;
    if (pAt) {
      const placeOf = (line: string) => clip(line.split(/,\s*(?=(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d|\d{1,2}\/\d|\d{4}-)/i)[0], 120) || undefined;
      const company = /\b(?:renting with|thanks for choosing)\s+([A-Z][\w&' -]{2,40}?)[.!,\n]/.exec(all)?.[1]?.trim() ?? name;
      out.push({ kind: 'trip', source: 'rules', ref: carConf ?? `${company}|${pAt.day}`, ...(carConf ? { confirmation: carConf.toUpperCase() } : {}), car: { company, ...(placeOf(pl![1]!) ? { pickup: placeOf(pl![1]!) } : {}), pickupAt: at(pAt)!, ...(dl && placeOf(dl[1]!) ? { dropoff: placeOf(dl[1]!) } : {}), ...(dAt ? { dropoffAt: at(dAt) } : {}) } });
      return out;
    }
  }
  // S6: trains: a train number and a departure.
  const trainNo = /\btrain\s*(?:#|no\.?|number)?:?\s*(\d{1,5})\b/i.exec(all);
  if (trainNo && /\b(depart(s|ure)?|tickets?|reservation|booking)\b/i.test(all)) {
    const part = all.slice(trainNo.index);
    const dep = dateAfter(part, /\b(depart(s|ure|ing)?|leaves?)\b:?/i, now);
    const arr = dateAfter(part, /\b(arriv(es|al|ing))\b:?/i, now);
    const route = /\bfrom\s+([A-Z][\w .'-]{1,40}?)\s+to\s+([A-Z][\w .'-]{1,40}?)\s*(?:\n|$|,|\.)/.exec(part);
    if (dep) {
      out.push({ kind: 'trip', source: 'rules', ref: carConf ?? `${trainNo[1]}|${dep.day}`, ...(carConf ? { confirmation: carConf.toUpperCase() } : {}), trains: [{ train: trainNo[1]!, ...(route ? { from: route[1]!.trim(), to: route[2]!.trim() } : {}), departs: at(dep)!, ...(arr ? { arrives: at(arr) } : {}) }] });
      return out;
    }
  }
  // Hotels: check-in and check-out dates.
  const cin = dateAfter(all, /\bcheck[- ]?in\b(?: date)?:?/i, now);
  const cout = dateAfter(all, /\bcheck[- ]?out\b(?: date)?:?/i, now);
  if (cin && cout && /\b(hotel|inn|resort|suites?|lodge|reservation|booking|stay)\b/i.test(all)) {
    const hname = /\b(?:at|stay at|welcome to)\s+(?:the\s+)?([A-Z][\w&' -]{2,50}?(?:Hotel|Inn|Resort|Suites|Lodge))\b/.exec(all)?.[1] ?? name;
    const addr = /\b(?:address|located at):?\s*([0-9][^\n]{5,120})/i.exec(text)?.[1]?.trim();
    out.push({ kind: 'trip', source: 'rules', ref: conf ?? `${hname}|${cin.day}`, ...(conf ? { confirmation: conf.toUpperCase() } : {}), hotel: { name: hname, ...(addr ? { address: addr } : {}), checkIn: at(cin)!, checkOut: at(cout)! } });
    return out;
  }

  if (NEWSLETTER.test(all) && !/\b(receipt|invoice|statement|order confirmation)\b/i.test(subj)) return out;

  // Bills: a statement or "amount due" with a due date.
  if (/\b(bill|statement|amount due|payment due|balance due|invoice)\b/i.test(subj) && !/\b(paid|receipt|thank you for your payment|payment received)\b/i.test(subj)) {
    const due = dateAfter(all, /\b(due( date| on| by)?|pay by|payment due( date)?)\b:?/i, now);
    const amount = amountOf(/\b(amount|balance|total|payment) due\b[^\n]{0,40}/i.exec(all)?.[0] ?? '') ?? amountOf(all);
    if (due || amount) {
      out.push({ kind: 'bill', source: 'rules', ref: `${senderDomain(m.from)}|${due?.day ?? ''}|${amount ?? ''}`, payee: name, ...(amount ? { amount } : {}), ...(due ? { due: due.day } : {}) });
      return out;
    }
  }

  // Receipts and orders: a total.
  if (/\b(receipt|your order|order confirm(ed|ation)|thanks for (your )?(order|purchase)|purchase confirmation|payment received)\b/i.test(subj)) {
    const total = amountOf(/\b(order total|grand total|total( charged| paid)?|amount (charged|paid))\b[^\n]{0,40}/i.exec(all)?.[0] ?? '') ?? amountOf(all);
    if (total) {
      const order = /\border\s*(?:#|no\.?|number)?:?\s*([A-Z0-9-]{5,30})/i.exec(all)?.[1];
      const items = [...text.matchAll(/^\s*(?:\d+\s*[x×]\s*)?([A-Za-z][^\n$]{2,60}?)\s+\$\d[\d,]*\.\d{2}\s*$/gm)].map((x) => clip(x[1], 60)).filter((x) => !/total|tax|shipping|subtotal|discount/i.test(x)).slice(0, 10);
      const d = findDate(text, now);
      out.push({ kind: 'receipt', source: 'rules', ref: order ?? `${senderDomain(m.from)}|${total}|${m.date.slice(0, 10)}`, vendor: name, amount: total, date: d?.day ?? m.date.slice(0, 10), ...(items.length ? { items } : {}), ...(order ? { order } : {}) });
      return out;
    }
  }

  // Appointments: "appointment" / "confirmed" with a date and a time.
  if (/\b(appointment|reservation|booking|visit|consultation|check-up|checkup)\b/i.test(subj) && /\b(confirm|scheduled|booked|reminder|upcoming)\w*\b/i.test(all)) {
    const d = dateAfter(all, /\b(on|date|when|time|scheduled for)\b:?/i, now) ?? findDate(text, now);
    if (d?.time) {
      const place = /\b(?:location|address|where):?\s*([^\n]{5,120})/i.exec(text)?.[1]?.trim();
      const title = clip(subj.replace(/^(re|fwd?):\s*/i, '').replace(/\b(your|is|has been)?\s*(confirmed|scheduled|booked|reminder:?)\b/gi, '').replace(/[:\-–\s]+$/, ''), 80) || `Appointment with ${name}`;
      out.push({ kind: 'appointment', source: 'rules', ref: `${senderDomain(m.from)}|${d.day}T${d.time}`, title: /\b(with|at)\b/i.test(title) ? title : `${title} (${name})`, start: `${d.day}T${d.time}`, ...(place ? { place } : {}) });
    }
  }
  return out;
}

/** Looks like a transaction the rules could not read: worth a small model call (when allowed). */
export function looksUnclear(m: InboxMail, text: string): boolean {
  if (NEWSLETTER.test(text)) return false;
  return /\b(receipt|invoice|statement|order|shipped|tracking|itinerary|reservation|booking|appointment|due)\b/i.test(m.subject) && /\d/.test(text);
}

/** Everything a new mail is about (usually one finding, often none), by rules and JSON-LD. */
export function classify(m: InboxMail, now: Date): { findings: Finding[]; unclear: boolean } {
  const text = m.text?.trim() ? m.text : htmlText(m.html ?? '');
  const ld = fromJsonLd(jsonLd(m.html));
  // R8: school mail (newsletters too) is read for its dates before the other rules skip newsletters.
  const school = ld.length ? [] : schoolFindings(m, now);
  const findings = ld.length ? ld : school.length ? school : fromRules(m, text.slice(0, 40_000), now);
  return { findings, unclear: !findings.length && looksUnclear(m, text) };
}

/** A model's JSON answer, cleaned to a finding (or nothing). Every field is checked like the rules'. */
export function findingFromModel(raw: string): Finding | undefined {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '') as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const kind = String(o.kind ?? '');
  const day = (v: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '')) ? String(v) : undefined);
  const dt = (v: unknown) => (/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(String(v ?? '').slice(0, 16)) ? String(v).slice(0, 16) : undefined);
  const amount = o.amount !== undefined ? amountOf(`$${String(o.amount).replace(/^\$/, '')}`) : undefined;
  if (kind === 'bill' && (amount || day(o.due))) return { kind, source: 'model', payee: clip(o.payee, 60) || undefined, ...(amount ? { amount } : {}), ...(day(o.due) ? { due: day(o.due) } : {}), ref: `${clip(o.payee, 60)}|${day(o.due) ?? ''}|${amount ?? ''}` };
  if (kind === 'receipt' && amount) return { kind, source: 'model', vendor: clip(o.vendor, 60) || undefined, amount, ...(day(o.date) ? { date: day(o.date) } : {}), ref: `${clip(o.vendor, 60)}|${amount}|${day(o.date) ?? ''}` };
  if (kind === 'shipping') {
    const tr = trackingIn(String(o.tracking ?? ''));
    if (tr) return { kind, source: 'model', ref: tr.tracking, ...tr, status: 'shipped', ...(day(o.eta) ? { eta: day(o.eta) } : {}) };
  }
  if (kind === 'appointment' && dt(o.start)?.includes('T') && clip(o.title, 80)) return { kind, source: 'model', title: clip(o.title, 80), start: dt(o.start)!, ...(clip(o.place, 120) ? { place: clip(o.place, 120) } : {}), ref: `${clip(o.title, 80)}|${dt(o.start)}` };
  return undefined;
}
