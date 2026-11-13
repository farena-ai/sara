// E2 (docs/SHOPPING.md): stores near the person, from OpenStreetMap. Free, no key: Overpass for
// the shops (hardware, DIY, electronics, supermarkets, department stores, pharmacies, auto parts,
// sports, variety stores, and the big chains by their brand tag) and Nominatim to find a place by
// name. Both are public services with usage rules: a proper User-Agent, at most one request a
// second, results cached (stores a day, places 30 days, in her own store.db). Overpass mirrors are
// tried in turn when one is busy (HTTP 429/502/503/504 are common). Everything goes through
// netFetch (src/net-guard.ts), so private local mode refuses it like any other outside request.
import type { DatabaseSync } from 'node:sqlite';
import { netFetch } from '../net-guard.ts';

export const SHOP_UA = 'Sara/1 (self-hosted AI companion; product finder; https://github.com/farena-ai/sara)';
export const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
export const STORES_TTL_MS = 24 * 3600_000;
export const PLACE_TTL_MS = 30 * 24 * 3600_000;
export const SHOP_TYPES = ['hardware', 'doityourself', 'electronics', 'supermarket', 'department_store', 'chemist', 'car_parts', 'sports', 'variety_store', 'general', 'wholesale', 'mobile_phone', 'computer', 'appliance', 'houseware', 'pet', 'toys', 'garden_centre', 'trade', 'outdoor', 'office_supplies'] as const;
/** The big chains by their OSM brand tag (they are also found by shop type; this catches pharmacies tagged as amenities). */
export const BRANDS = ['The Home Depot', "Lowe's", 'Walmart', 'Target', 'Best Buy', 'Walgreens', 'CVS Pharmacy', 'AutoZone', "O'Reilly Auto Parts", 'Advance Auto Parts', 'Ace Hardware', 'True Value', 'Menards', 'Harbor Freight Tools', 'Costco', "Sam's Club", 'Kroger', 'Staples', 'Office Depot', 'Dollar General', 'Dollar Tree', 'Family Dollar', 'Tractor Supply Company', "Dick's Sporting Goods", 'Academy Sports + Outdoors', 'Kohl\'s', "Macy's", 'Rite Aid', 'Meijer', 'H-E-B', 'Publix'] as const;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface GeoPlace {
  name: string;
  lat: number;
  lon: number;
}

export interface NearbyStore {
  id: string;
  name: string;
  brand?: string;
  kind: string;
  lat: number;
  lon: number;
  miles: number;
  address?: string;
  hours?: string;
  phone?: string;
  website?: string;
}

const MILE_M = 1609.344;

/** Miles between two points (great-circle). */
export function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const dLat = r(b.lat - a.lat);
  const dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return (2 * 6371_000 * Math.asin(Math.min(1, Math.sqrt(h)))) / MILE_M;
}

const esc = (s: string) => s.replace(/[\\"]/g, (c) => `\\${c}`).replace(/[.*+?^${}()|[\]]/g, (c) => `\\\\${c}`);

/** The Overpass query: shops by type and the chains by brand within `radiusMiles` of a point. */
export function overpassQuery(lat: number, lon: number, radiusMiles: number): string {
  const m = Math.round(Math.min(25, Math.max(0.5, radiusMiles)) * MILE_M);
  const around = `around:${m},${lat.toFixed(5)},${lon.toFixed(5)}`;
  const brands = BRANDS.map(esc).join('|');
  return `[out:json][timeout:25];(nwr(${around})[shop~"^(${SHOP_TYPES.join('|')})$"];nwr(${around})[brand~"^(${brands})$",i];);out center tags 400;`;
}

interface OsmElement {
  type: string;
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** Overpass's answer → stores with a name, nearest first. */
export function parseStores(body: unknown, from: { lat: number; lon: number }): NearbyStore[] {
  const els = ((body as { elements?: OsmElement[] })?.elements ?? []).filter((e) => e && e.tags);
  const out: NearbyStore[] = [];
  const seen = new Set<string>();
  for (const e of els) {
    const t = e.tags!;
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    const name = (t.name ?? t.brand ?? '').trim();
    if (lat === undefined || lon === undefined || !name) continue;
    const id = `${e.type}/${e.id}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
    const address = [street, t['addr:city'], t['addr:state'], t['addr:postcode']].filter(Boolean).join(', ');
    const phone = (t.phone ?? t['contact:phone'] ?? '').split(';')[0].trim();
    const website = t.website ?? t['contact:website'] ?? t['brand:website'];
    out.push({
      id,
      name: name.slice(0, 120),
      ...(t.brand ? { brand: t.brand.slice(0, 80) } : {}),
      kind: (t.shop ?? t.amenity ?? 'shop').slice(0, 40),
      lat,
      lon,
      miles: Math.round(milesBetween(from, { lat, lon }) * 10) / 10,
      ...(address ? { address: address.slice(0, 200) } : {}),
      ...(t.opening_hours ? { hours: t.opening_hours.slice(0, 160) } : {}),
      ...(phone ? { phone: phone.slice(0, 40) } : {}),
      ...(website && /^https?:\/\//.test(website) ? { website: website.slice(0, 300) } : {}),
    });
  }
  return out.sort((a, b) => a.miles - b.miles);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** OpenStreetMap lookups with the services' manners: one request a second, cached, mirrors in turn. */
export class OsmPlaces {
  readonly #db: DatabaseSync;
  readonly #fetch: FetchLike;
  readonly #now: () => number;
  readonly #pace: number;
  #last = 0;

  constructor(db: DatabaseSync, o: { fetch?: FetchLike; now?: () => number; paceMs?: number } = {}) {
    this.#db = db;
    this.#fetch = o.fetch ?? ((u, i) => netFetch(u, i));
    this.#now = o.now ?? Date.now;
    this.#pace = o.paceMs ?? 1100;
    db.exec('CREATE TABLE IF NOT EXISTS shop_cache (key TEXT PRIMARY KEY, at INTEGER NOT NULL, body TEXT NOT NULL)');
  }

  #cached<T>(key: string, ttl: number): T | undefined {
    const r = this.#db.prepare('SELECT at, body FROM shop_cache WHERE key = ?').get(key) as { at: number; body: string } | undefined;
    if (!r || this.#now() - r.at > ttl) return undefined;
    try {
      return JSON.parse(r.body) as T;
    } catch {
      return undefined;
    }
  }

  #keep(key: string, value: unknown): void {
    this.#db.prepare('INSERT OR REPLACE INTO shop_cache (key, at, body) VALUES (?, ?, ?)').run(key, this.#now(), JSON.stringify(value));
    // Old entries go (the cache stays small).
    this.#db.prepare('DELETE FROM shop_cache WHERE at < ?').run(this.#now() - PLACE_TTL_MS);
  }

  async #paced(): Promise<void> {
    const wait = this.#last + this.#pace - Date.now();
    if (wait > 0) await sleep(wait);
    this.#last = Date.now();
  }

  /** A place by name (a city, a ZIP code, an address) via Nominatim; undefined when not found. */
  async geocode(q: string, signal?: AbortSignal): Promise<GeoPlace | undefined> {
    const key = `geo:${q.trim().toLowerCase()}`;
    const hit = this.#cached<GeoPlace | null>(key, PLACE_TTL_MS);
    if (hit !== undefined) return hit ?? undefined;
    await this.#paced();
    const res = await this.#fetch(`https://nominatim.openstreetmap.org/search?${new URLSearchParams({ q: q.trim(), format: 'jsonv2', limit: '1' })}`, { headers: { 'user-agent': SHOP_UA, accept: 'application/json' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`OpenStreetMap place search failed (HTTP ${res.status})`);
    const r = (await res.json()) as { lat: string; lon: string; display_name: string; name?: string }[];
    const place = r[0] ? { name: String(r[0].display_name).slice(0, 160), lat: Number(r[0].lat), lon: Number(r[0].lon) } : null;
    this.#keep(key, place);
    return place ?? undefined;
  }

  /** Stores within `radiusMiles` (nearest first). `cached` says whether it came from the day's cache. */
  async stores(at: { lat: number; lon: number }, radiusMiles: number, signal?: AbortSignal): Promise<{ stores: NearbyStore[]; cached: boolean; checkedAt: string }> {
    const r = Math.min(25, Math.max(0.5, radiusMiles));
    const key = `stores:${at.lat.toFixed(3)},${at.lon.toFixed(3)},${r}`;
    const hit = this.#cached<{ stores: NearbyStore[]; checkedAt: string }>(key, STORES_TTL_MS);
    if (hit) return { ...hit, cached: true };
    const body = new URLSearchParams({ data: overpassQuery(at.lat, at.lon, r) }).toString();
    let last = '';
    for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length + 1; attempt++) {
      const url = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
      await this.#paced();
      if (attempt >= OVERPASS_ENDPOINTS.length) await sleep(this.#pace * 2);
      try {
        const res = await this.#fetch(url, { method: 'POST', headers: { 'user-agent': SHOP_UA, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(40_000)]) : AbortSignal.timeout(40_000) });
        if (!res.ok) {
          last = `HTTP ${res.status}`;
          if ([429, 502, 503, 504].includes(res.status)) continue;
          break;
        }
        const json = await res.json();
        const stores = parseStores(json, at);
        const checkedAt = new Date(this.#now()).toISOString();
        this.#keep(key, { stores, checkedAt });
        return { stores, cached: false, checkedAt };
      } catch (err) {
        if (signal?.aborted) throw err;
        last = (err as Error).message;
        if ((err as { code?: string }).code === 'PRIVATE_LOCAL') throw err;
      }
    }
    throw new Error(`OpenStreetMap's store list is busy right now (${last || 'no answer'}); try again in a minute.`);
  }
}
