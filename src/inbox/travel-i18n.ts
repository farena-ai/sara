// U3.12 (docs/LANGUAGES_TEXT.md): S6 travel emails in Spanish, French, German, Brazilian Portuguese
// and Italian. Booking words per language (vuelo/vol/Flug/voo/volo, localizador, Abfahrt, check-in...),
// day-first dates with month names and 24-hour times. A mail is read with its own language's words
// only; English mail keeps the English rules in classify.ts.
import { dayMonthRe, monthNumber, words, type TextLang } from '../lang-text.ts';
import type { Finding, Flight } from './classify.ts';

export type OtherLang = Exclude<TextLang, 'en'>;
const r = String.raw;
const pad = (n: number) => String(n).padStart(2, '0');
const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Case-insensitive letters without the `i` flag (so codes like "IB 3456" stay upper case). */
const ci = (s: string) => s.replace(/\\[a-zA-Z](?:\{[^}]*\})?|\p{L}/gu, (c) => (c.length === 1 && c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : c));

interface Vocab {
  flight: string;
  conf: string;
  dep: string;
  arr: string;
  itin: string;
  train: string;
  route: string;
  car: string;
  pick: string;
  drop: string;
  cin: string;
  cout: string;
  stay: string;
  addr: string;
  ticket: string;
}
const V: Record<OtherLang, Vocab> = {
  es: { flight: 'vuelo', conf: r`localizador|código\s+de\s+reserva|número\s+de\s+reserva|código\s+de\s+confirmación|reserva`, dep: r`salida|sale|despega`, arr: r`llegada|llega|aterriza`, itin: r`itinerario|tarjeta\s+de\s+embarque|embarque|salida`, train: 'tren', route: r`de\s+(X)\s+a\s+(X)`, car: r`alquiler\s+de\s+(?:coche|vehículo|auto)|coche\s+de\s+alquiler`, pick: r`recogida`, drop: r`devolución|entrega`, cin: r`fecha\s+de\s+entrada|entrada|llegada|check-in`, cout: r`fecha\s+de\s+salida|salida|check-out`, stay: r`hotel|hostal|alojamiento|estancia|reserva|habitación`, addr: r`dirección`, ticket: r`billete|billetes|reserva|salida` },
  fr: { flight: 'vol', conf: r`référence\s+de\s+(?:réservation|dossier)|code\s+de\s+réservation|numéro\s+de\s+réservation|numéro\s+de\s+dossier|réservation`, dep: r`départ|décollage`, arr: r`arrivée`, itin: r`itinéraire|carte\s+d['’]embarquement|embarquement|départ`, train: 'train', route: r`de\s+(X)\s+(?:à|a)\s+(X)`, car: r`location\s+de\s+voiture|voiture\s+de\s+location|location\s+de\s+véhicule`, pick: r`prise\s+en\s+charge|retrait`, drop: r`restitution|retour`, cin: r`arrivée|check-in`, cout: r`départ|check-out`, stay: r`hôtel|hotel|séjour|hébergement|réservation|chambre`, addr: r`adresse`, ticket: r`billet|billets|e-billet|réservation|départ` },
  de: { flight: 'flug', conf: r`buchungscode|buchungsnummer|buchungsreferenz|reservierungsnummer|auftragsnummer|bestätigungsnummer|buchung`, dep: r`abflug|abfahrt`, arr: r`ankunft|landung`, itin: r`reiseplan|bordkarte|abflug|flugplan`, train: 'zug', route: r`von\s+(X)\s+nach\s+(X)`, car: r`mietwagen|autovermietung|fahrzeugmiete`, pick: r`abholung`, drop: r`rückgabe`, cin: r`anreise|check-in`, cout: r`abreise|check-out`, stay: r`hotel|unterkunft|aufenthalt|buchung|zimmer|pension`, addr: r`adresse|anschrift`, ticket: r`fahrkarte|ticket|buchung|reservierung|abfahrt` },
  pt: { flight: 'voo', conf: r`código\s+de\s+reserva|localizador|número\s+da\s+reserva|código\s+de\s+confirmação|reserva`, dep: r`partida|saída`, arr: r`chegada`, itin: r`itinerário|cartão\s+de\s+embarque|partida`, train: 'trem', route: r`de\s+(X)\s+(?:para|a)\s+(X)`, car: r`aluguel\s+de\s+(?:carro|veículo)|carro\s+alugado|locação\s+de\s+veículo`, pick: r`retirada`, drop: r`devolução`, cin: r`check-in|entrada`, cout: r`check-out|saída`, stay: r`hotel|pousada|hospedagem|estadia|reserva|quarto`, addr: r`endereço`, ticket: r`passagem|bilhete|reserva|partida` },
  it: { flight: 'volo', conf: r`codice\s+di\s+prenotazione|codice\s+pnr|numero\s+di\s+prenotazione|codice\s+(?:di\s+)?conferma|prenotazione`, dep: r`partenza|decollo`, arr: r`arrivo`, itin: r`itinerario|carta\s+d['’]imbarco|imbarco|partenza`, train: 'treno', route: r`da\s+(X)\s+a\s+(X)`, car: r`noleggio\s+auto|auto\s+a\s+noleggio`, pick: r`ritiro`, drop: r`riconsegna|restituzione`, cin: r`arrivo|check-in`, cout: r`partenza|check-out`, stay: r`hotel|albergo|soggiorno|struttura|prenotazione|camera`, addr: r`indirizzo`, ticket: r`biglietto|biglietti|prenotazione|partenza` },
};
const NUMBER = r`\s*(?:#|n[º°o]?\.?|nr\.?|número|numéro|numero|nummer)?\s*:?\s*`;
const TRAIN_BRANDS = r`ICE|IC|EC|TGV|INOUI|AVE|Alvia|Avlo|Frecciarossa|Frecciargento|Frecciabianca|Italo|Intercity|RE|RB|Ouigo|TER|Regionale`;
const PLACE = r`(\p{Lu}[\p{L}\d .'’-]{1,40}?)`;
const HOTEL_NAME = /((?:Hotel|Hôtel|Hostal|Albergo|Pousada|Pension|Gasthof)\s+\p{Lu}[\p{L}'’&-]+(?:\s+\p{Lu}[\p{L}'’&-]+){0,3})/u;
const ROUTE3 = /\b([A-Z]{3})\s*(?:→|->|–|-)\s*([A-Z]{3})\b/;

/** The first date in a text written day first ("20 de noviembre de 2026", "20.11.2026 um 08:34"). */
export function findDateIn(text: string, now: Date, lang: OtherLang): { day: string; time?: string } | undefined {
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
  const add = (m: RegExpMatchArray, day: string | undefined) => day && cands.push({ at: m.index!, day, end: m.index! + m[0].length });
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})/g)) add(m, pick(Number(m[1]), Number(m[2]), Number(m[3])));
  for (const m of s.matchAll(dayMonthRe(lang))) add(m, pick(m[3] ? Number(m[3]) : undefined, monthNumber(m[2]!, lang), Number(m[1])));
  for (const m of s.matchAll(/(?<![\d.\/])(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?![\d])/g)) add(m, pick(Number(m[3]), Number(m[2]), Number(m[1])));
  const first = cands.sort((a, b) => a.at - b.at)[0];
  if (!first) return undefined;
  const after = s.slice(first.end, first.end + 24);
  const tm = /^(?:,|\s|um|à|a\s+las|a\s+la|às|alle|ore|dès|ab|desde|vers|at|@|T)*\s*(\d{1,2})[:h](\d{2})/iu.exec(after);
  const time = tm && Number(tm[1]) <= 23 ? `${pad(Number(tm[1]))}:${tm[2]}` : undefined;
  return { day: first.day, ...(time ? { time } : {}) };
}

const at = (d: { day: string; time?: string } | undefined): string | undefined => (d ? (d.time ? `${d.day}T${d.time}` : d.day) : undefined);

/** Bookings (flights, rental cars, trains, hotels) in a mail written in another language. */
export function travelIn(subject: string, text: string, now: Date, lang: OtherLang, sender: string): Finding[] {
  const v = V[lang];
  const all = `${subject}\n${text}`;
  const W = (src: string) => words(src);
  const dateAfter = (t: string, label: RegExp) => {
    const m = label.exec(t);
    return m ? findDateIn(t.slice(m.index + m[0].length, m.index + m[0].length + 80), now, lang) : undefined;
  };
  const conf = new RegExp(`(?<![\\p{L}])(?:${ci(v.conf)})${NUMBER}([A-Z0-9]{6})(?![A-Za-z0-9])`, 'u').exec(all)?.[1];
  const carConf = new RegExp(`(?<![\\p{L}])(?:${ci(v.conf)})${NUMBER}((?=[A-Z]*\\d)[A-Z0-9]{5,12})(?![A-Za-z0-9])`, 'u').exec(all)?.[1];
  const dep = W(`${v.dep}`);
  const arr = W(`${v.arr}`);

  // Flights: "Vuelo IB 3456", "Flug LH 400" and a booking code or departure words.
  const flightRe = new RegExp(`(?<![\\p{L}])${ci(v.flight)}(?![\\p{L}])${NUMBER}([A-Z]{2}|[A-Z]\\d|\\d[A-Z])\\s?(\\d{1,4})(?!\\d)`, 'gu');
  const marks = [...all.matchAll(flightRe)];
  if (marks.length && (conf || W(v.itin).test(all))) {
    const seen = new Set<string>();
    const flights: Flight[] = [];
    marks.forEach((x, i) => {
      const f = `${x[1]}${x[2]}`;
      if (seen.has(f) || flights.length >= 6) return;
      seen.add(f);
      const part = all.slice(x.index!, marks[i + 1]?.index ?? all.length);
      const d = dateAfter(part, dep) ?? (i === 0 ? findDateIn(text, now, lang) : undefined);
      const a = dateAfter(part, arr);
      const route = ROUTE3.exec(part) ?? (i === 0 ? ROUTE3.exec(all) : null);
      flights.push({ flight: f, ...(route ? { from: route[1], to: route[2] } : {}), ...(at(d) ? { departs: at(d) } : {}), ...(at(a) ? { arrives: at(a) } : {}) });
    });
    return [{ kind: 'trip', source: 'rules', ref: conf ?? flights.map((f) => `${f.flight}|${f.departs ?? ''}`).join(','), ...(conf ? { confirmation: conf } : {}), flights }];
  }
  // Rental cars: rental words with a pick-up date.
  if (W(v.car).test(all)) {
    const pl = new RegExp(`(?<![\\p{L}])(?:${v.pick})(?![\\p{L}])[^:\\n]{0,30}:?\\s*([^\\n]*)`, 'iu').exec(all);
    const dl = new RegExp(`(?<![\\p{L}])(?:${v.drop})(?![\\p{L}])[^:\\n]{0,30}:?\\s*([^\\n]*)`, 'iu').exec(all);
    const pAt = pl ? findDateIn(pl[1]!, now, lang) : undefined;
    const dAt = dl ? findDateIn(dl[1]!, now, lang) : undefined;
    if (pAt) {
      const placeOf = (line: string) => clip(line.split(/,\s*(?=\d)/)[0], 120) || undefined;
      return [{ kind: 'trip', source: 'rules', ref: carConf ?? `${sender}|${pAt.day}`, ...(carConf ? { confirmation: carConf } : {}), car: { company: sender, ...(placeOf(pl![1]!) ? { pickup: placeOf(pl![1]!) } : {}), pickupAt: at(pAt)!, ...(dl && placeOf(dl[1]!) ? { dropoff: placeOf(dl[1]!) } : {}), ...(dAt ? { dropoffAt: at(dAt) } : {}) } }];
    }
  }
  // Trains: "Zug ICE 578", "Treno Frecciarossa 9541" and a departure.
  const trainNo = new RegExp(`(?<![\\p{L}])${ci(v.train)}(?![\\p{L}])${NUMBER}(?:(?:${TRAIN_BRANDS})\\s*)?(\\d{1,5})(?!\\d)`, 'u').exec(all);
  if (trainNo && W(v.ticket).test(all)) {
    const part = all.slice(trainNo.index);
    const d = dateAfter(part, dep);
    const a = dateAfter(part, arr);
    const route = new RegExp(`(?<![\\p{L}])${v.route.replace(/X/g, PLACE.slice(1, -1))}\\s*(?:\\n|$|,|\\.)`, 'u').exec(part);
    if (d) return [{ kind: 'trip', source: 'rules', ref: carConf ?? `${trainNo[1]}|${d.day}`, ...(carConf ? { confirmation: carConf } : {}), trains: [{ train: trainNo[1]!, ...(route ? { from: route[1]!.trim(), to: route[2]!.trim() } : {}), departs: at(d)!, ...(a ? { arrives: at(a) } : {}) }] }];
  }
  // Hotels: arrival and departure days, and stay words.
  const cin = dateAfter(all, new RegExp(`(?<![\\p{L}])(?:${v.cin})(?![\\p{L}])\\s*:?`, 'iu'));
  const cout = dateAfter(all, new RegExp(`(?<![\\p{L}])(?:${v.cout})(?![\\p{L}])\\s*:?`, 'iu'));
  if (cin && cout && W(v.stay).test(all)) {
    const name = HOTEL_NAME.exec(all)?.[1] ?? sender;
    const addr = new RegExp(`(?<![\\p{L}])(?:${v.addr})\\s*:?\\s*([0-9][^\\n]{5,120})`, 'iu').exec(text)?.[1]?.trim();
    return [{ kind: 'trip', source: 'rules', ref: conf ?? `${name}|${cin.day}`, ...(conf ? { confirmation: conf } : {}), hotel: { name, ...(addr ? { address: addr } : {}), checkIn: at(cin)!, checkOut: at(cout)! } }];
  }
  return [];
}
