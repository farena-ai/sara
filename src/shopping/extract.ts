// E2 (docs/SHOPPING.md): what a retailer's page says about a product, read from the page itself.
// Pure functions only (no network): the product finder and product watches hand in the HTML her
// browser (or the guarded reader) got. Structured data first: schema.org JSON-LD Product/Offer
// (price, priceCurrency, availability), then the page's own embedded product data (a search page's
// item list, e.g. __NEXT_DATA__), then Amazon's search results, then price meta tags. Nothing is
// guessed: a field the page doesn't state stays empty. A bot check or refusal is 'blocked'.
import { isBotWall } from '../web-guard.ts';

export type Availability = 'in_stock' | 'limited' | 'preorder' | 'out_of_stock' | 'unknown';
export type OfferHow = 'json-ld' | 'page-data' | 'page' | 'meta';

export interface Offer {
  title: string;
  price?: number;
  currency?: string;
  availability: Availability;
  /** What the page said, in its words ("In stock", "OutOfStock"). */
  availabilityText?: string;
  url?: string;
  /** "pickup" / "delivery" / "shipping" when the page lists them. */
  fulfillment?: string[];
  /** A delivery line as the page shows it ("FREE delivery Sat, Nov 15"). */
  delivery?: string;
  shipping?: number;
  sku?: string;
  gtin?: string;
  model?: string;
  brand?: string;
  seller?: string;
  sponsored?: boolean;
  how: OfferHow;
}

export interface PageRead {
  blocked?: string;
  offers: Offer[];
  /** Product pages a list (JSON-LD ItemList, a search page) points to, without prices. */
  productLinks: string[];
}

const MAX_OFFERS = 40;

/** "$1,234.50", "8.38", 8.38 → 8.38 (undefined when it isn't a price). */
export function parsePrice(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : undefined;
  if (typeof v !== 'string') return undefined;
  const m = /(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/.exec(v.replace(/\s/g, ''));
  if (!m) return undefined;
  const n = Number(`${m[1].replace(/,/g, '')}.${m[2] ?? '0'}`);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : undefined;
}

/** schema.org availability (URL or word) or a retailer's own words → one of five. */
export function availabilityOf(v: unknown): Availability {
  const s = String(v ?? '').replace(/^https?:\/\/schema\.org\//i, '').replace(/[\s_-]/g, '').toLowerCase();
  if (!s) return 'unknown';
  if (/outofstock|soldout|discontinued|unavailable|notavailable|outofstockonline/.test(s)) return 'out_of_stock';
  if (/limited|onlyafewleft|lowstock|fewleft/.test(s)) return 'limited';
  if (/preorder|presale|backorder/.test(s)) return 'preorder';
  if (/instock|instoreonly|onlineonly|available|instockonline/.test(s)) return 'in_stock';
  return 'unknown';
}

const decode = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();

const rec = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const text = (v: unknown, max = 300): string | undefined => {
  if (typeof v === 'number') return String(v);
  if (typeof v !== 'string') return undefined;
  const s = decode(v).slice(0, max);
  return s || undefined;
};
const typeIs = (n: Record<string, unknown>, t: string) => list(n['@type']).some((x) => String(x).toLowerCase() === t.toLowerCase());

function absolute(u: unknown, base: string): string | undefined {
  if (typeof u !== 'string' || !u.trim()) return undefined;
  try {
    const url = new URL(decode(u), base);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** The JSON-LD blocks of a page, parsed (a block that isn't JSON is skipped). */
export function jsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/^\/\*[\s\S]*?\*\//, '');
    try {
      out.push(JSON.parse(raw));
    } catch {
      /* not JSON: skipped */
    }
    if (out.length > 30) break;
  }
  return out;
}

/** Every node of the JSON-LD (arrays, @graph and ItemList items flattened). */
function ldNodes(blocks: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const visit = (v: unknown, depth: number) => {
    if (depth > 6 || out.length > 200) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    const n = rec(v);
    if (!n) return;
    out.push(n);
    if (n['@graph']) visit(n['@graph'], depth + 1);
    if (typeIs(n, 'ItemList')) for (const el of list(n.itemListElement)) visit(rec(el)?.item ?? el, depth + 1);
    if (typeIs(n, 'ProductGroup')) visit(n.hasVariant, depth + 1);
  };
  visit(blocks, 0);
  return out;
}

function ldOffers(n: Record<string, unknown>, base: string): Offer[] {
  const title = text(n.name) ?? '';
  const brand = text(rec(n.brand)?.name ?? n.brand, 80);
  const common = {
    title,
    ...(text(n.sku, 60) ? { sku: text(n.sku, 60) } : {}),
    ...(text(n.gtin13 ?? n.gtin12 ?? n.gtin ?? n.gtin14 ?? n.gtin8, 20) ? { gtin: text(n.gtin13 ?? n.gtin12 ?? n.gtin ?? n.gtin14 ?? n.gtin8, 20) } : {}),
    ...(text(n.mpn ?? n.model, 60) ? { model: text(rec(n.model)?.name ?? n.mpn ?? n.model, 60) } : {}),
    ...(brand ? { brand } : {}),
  };
  const offers = list(n.offers).map(rec).filter((o): o is Record<string, unknown> => Boolean(o));
  const url = absolute(n.url, base) ?? base;
  if (!offers.length) return title ? [{ ...common, availability: 'unknown', url, how: 'json-ld' }] : [];
  const out: Offer[] = [];
  for (const o of offers.flatMap((x) => (typeIs(x, 'AggregateOffer') && x.offers ? list(x.offers).map(rec).filter((y): y is Record<string, unknown> => Boolean(y)) : [x]))) {
    const spec = rec(list(o.priceSpecification)[0]);
    const price = parsePrice(o.price ?? o.lowPrice ?? spec?.price);
    const ship = parsePrice(rec(rec(list(o.shippingDetails)[0])?.shippingRate)?.value);
    const shipZero = rec(rec(list(o.shippingDetails)[0])?.shippingRate)?.value;
    const availabilityText = text(o.availability, 60);
    out.push({
      ...common,
      ...(price !== undefined ? { price } : {}),
      ...(text(o.priceCurrency ?? spec?.priceCurrency, 3) ? { currency: text(o.priceCurrency ?? spec?.priceCurrency, 3) } : {}),
      availability: availabilityOf(o.availability),
      ...(availabilityText ? { availabilityText: availabilityText.replace(/^https?:\/\/schema\.org\//i, '') } : {}),
      url: absolute(o.url, base) ?? url,
      ...(ship !== undefined ? { shipping: ship } : shipZero === 0 || shipZero === '0' ? { shipping: 0 } : {}),
      ...(text(rec(o.seller)?.name, 80) ? { seller: text(rec(o.seller)?.name, 80) } : {}),
      how: 'json-ld',
    });
  }
  return out;
}

/** Product data a page embeds for its own scripts (e.g. a search page's item list): name + price objects. */
function embeddedOffers(html: string, base: string): Offer[] {
  const out: Offer[] = [];
  for (const m of html.matchAll(/<script\b[^>]*(?:id="__NEXT_DATA__"|type="application\/json")[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (m[1].length < 50) continue;
    let data: unknown;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    let seen = 0;
    const visit = (v: unknown, depth: number) => {
      if (depth > 14 || out.length >= MAX_OFFERS || ++seen > 300_000) return;
      if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
      const n = rec(v);
      if (!n) return;
      const name = typeof n.name === 'string' ? n.name : undefined;
      const link = n.canonicalUrl ?? n.productUrl ?? n.url;
      const priceLine = list(rec(rec(n.priceInfo)?.priceDetails)?.priceLines).map(rec).find((l) => l?.lineType === 'CURRENT_PRICE');
      const price = parsePrice(n.price) ?? parsePrice(rec(rec(n.priceInfo)?.currentPrice)?.price) ?? parsePrice(rec(list(priceLine?.values)[0])?.value);
      if (name && typeof link === 'string' && price !== undefined) {
        const avail = rec(n.availabilityStatusV2)?.value ?? n.availabilityStatusDisplayValue ?? n.availabilityStatus ?? n.availability;
        const ful = [...new Set(list(n.fulfillmentSummary).map((f) => String(rec(f)?.fulfillment ?? '').toLowerCase()).filter((f) => /^(pickup|delivery|shipping)$/.test(f)))];
        const url = absolute(link, base);
        out.push({
          title: decode(name).slice(0, 300),
          price,
          ...(rec(rec(n.priceInfo)?.priceDetails)?.currency ? { currency: String(rec(rec(n.priceInfo)?.priceDetails)?.currency).slice(0, 3) } : {}),
          availability: availabilityOf(avail),
          ...(text(rec(n.availabilityStatusV2)?.display ?? n.availabilityStatusDisplayValue, 60) ? { availabilityText: text(rec(n.availabilityStatusV2)?.display ?? n.availabilityStatusDisplayValue, 60) } : {}),
          ...(url ? { url } : {}),
          ...(ful.length ? { fulfillment: ful } : {}),
          ...(text(n.sellerName, 80) ? { seller: text(n.sellerName, 80) } : {}),
          ...(n.isSponsoredFlag === true || rec(n.sponsoredProduct) ? { sponsored: true } : {}),
          how: 'page-data',
        });
        return;
      }
      for (const k of Object.keys(n)) visit(n[k], depth + 1);
    };
    visit(data, 0);
  }
  return out;
}

/** Amazon's search results as the page shows them (title, price, delivery line, sponsored). */
function amazonResults(html: string, base: string): Offer[] {
  const out: Offer[] = [];
  const parts = html.split(/data-component-type="s-search-result"/).slice(1);
  for (const seg0 of parts) {
    const seg = seg0.slice(0, 60_000);
    const asin = /data-asin="([A-Z0-9]{10})"/.exec(seg)?.[1] ?? /\/dp\/([A-Z0-9]{10})/.exec(seg)?.[1];
    const title = /<h2\b[^>]*aria-label="([^"]+)"/.exec(seg)?.[1] ?? /<h2\b[^>]*>(?:\s*<[^>]+>)*\s*([^<]{4,})</.exec(seg)?.[1];
    const priceText = /<span class="a-price"[^>]*>\s*<span class="a-offscreen">([^<]+)</.exec(seg)?.[1];
    const price = parsePrice(priceText);
    if (!asin || !title || price === undefined) continue;
    const delivery = /aria-label="((?:FREE )?delivery[^"]{0,80})"/i.exec(seg)?.[1];
    const host = new URL(base).origin;
    out.push({
      title: decode(title).replace(/^Sponsored Ad - /i, '').slice(0, 300),
      price,
      currency: 'USD',
      availability: /currently unavailable/i.test(seg) ? 'out_of_stock' : 'unknown',
      url: `${host}/dp/${asin}`,
      ...(delivery ? { delivery: decode(delivery).slice(0, 80), fulfillment: ['delivery'] } : {}),
      ...(/puis-sponsored|>Sponsored</.test(seg) ? { sponsored: true } : {}),
      how: 'page',
    });
    if (out.length >= MAX_OFFERS) break;
  }
  return out;
}

/** An Amazon product page: its title, the price in its price box and its availability line. */
function amazonProduct(html: string, base: string): Offer | undefined {
  const title = /<span id="productTitle"[^>]*>([^<]{3,400})</.exec(html)?.[1];
  const box = /id="(?:corePrice_feature_div|corePriceDisplay_desktop_feature_div|apex_desktop)"[\s\S]{0,4000}?<span class="a-offscreen">([^<]+)</.exec(html)?.[1];
  const price = parsePrice(box);
  if (!title || price === undefined) return undefined;
  const avail = /<div id="availability"[\s\S]{0,600}?<span[^>]*>\s*([^<]{2,80}?)\s*</.exec(html)?.[1];
  const asin = /\/dp\/([A-Z0-9]{10})/.exec(base)?.[1];
  return { title: decode(title).slice(0, 300), price, currency: 'USD', availability: availabilityOf(avail), ...(avail ? { availabilityText: decode(avail).slice(0, 60) } : {}), url: asin ? `${new URL(base).origin}/dp/${asin}` : base, how: 'page' };
}

function metaOffer(html: string, base: string): Offer | undefined {
  const meta = (name: string) => new RegExp(`<meta\\b[^>]*(?:property|name|itemprop)=["']${name}["'][^>]*content=["']([^"']+)["']`, 'i').exec(html)?.[1] ?? new RegExp(`<meta\\b[^>]*content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${name}["']`, 'i').exec(html)?.[1];
  const price = parsePrice(meta('product:price:amount') ?? meta('og:price:amount') ?? meta('price'));
  const title = meta('og:title') ?? /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1];
  if (price === undefined || !title) return undefined;
  const avail = meta('product:availability') ?? meta('og:availability') ?? meta('availability');
  const cur = meta('product:price:currency') ?? meta('og:price:currency') ?? meta('priceCurrency');
  return { title: decode(title).slice(0, 300), price, ...(cur ? { currency: cur.slice(0, 3) } : {}), availability: availabilityOf(avail), ...(avail ? { availabilityText: decode(avail).slice(0, 60) } : {}), url: base, how: 'meta' };
}

const BLOCK_TITLE = /^(robot or human\??|access denied|error page|pardon our interruption|challenge validation|sorry! something went wrong!?|request rejected|blocked|forbidden|403 forbidden|just a moment\.{0,3})$/i;

/** A bot check, a refusal or an error page instead of the page: why, in a few words (else undefined). */
export function blockedReason(p: { status: number; title?: string; html: string }): string | undefined {
  const title = decode(p.title ?? /<title[^>]*>([^<]*)<\/title>/i.exec(p.html)?.[1] ?? '');
  if (isBotWall({ status: p.status, text: p.html.slice(0, 20_000), title })) return 'the site showed a bot check';
  if (BLOCK_TITLE.test(title)) return `the site refused automated access (${title.slice(0, 60)})`;
  if (p.status === 403 || p.status === 401) return `the site refused automated access (HTTP ${p.status})`;
  if (p.status === 429) return 'the site asked to slow down (HTTP 429)';
  if (p.status >= 500) return `the site answered with an error (HTTP ${p.status})`;
  if (p.status === 404 || p.status === 410) return `page not found (HTTP ${p.status})`;
  return undefined;
}

/** Everything a retailer page states about products: offers (structured first) and product links. */
export function readProductPage(p: { url: string; status: number; title?: string; html: string }): PageRead {
  const blocked = blockedReason(p);
  if (blocked) return { blocked, offers: [], productLinks: [] };
  const html = p.html;
  const nodes = ldNodes(jsonLdBlocks(html));
  const offers: Offer[] = [];
  const productLinks: string[] = [];
  for (const n of nodes) {
    if (typeIs(n, 'Product') || typeIs(n, 'IndividualProduct')) offers.push(...ldOffers(n, p.url));
    else if (typeIs(n, 'WebPage') || typeIs(n, 'ListItem')) {
      const u = absolute(n.url ?? n['@id'], p.url);
      if (u && !/#webpage$/.test(u) && u !== p.url) productLinks.push(u);
      else if (u && /#webpage$/.test(u)) productLinks.push(u.replace(/#webpage$/, ''));
    }
  }
  if (!offers.some((o) => o.price !== undefined)) offers.push(...embeddedOffers(html, p.url));
  if (!offers.some((o) => o.price !== undefined) && /amazon\./i.test(new URL(p.url).hostname)) {
    const one = /\/dp\//.test(new URL(p.url).pathname) ? amazonProduct(html, p.url) : undefined;
    if (one) offers.push(one);
    else offers.push(...amazonResults(html, p.url));
  }
  if (!offers.some((o) => o.price !== undefined)) {
    const m = metaOffer(html, p.url);
    if (m) offers.push(m);
  }
  return { offers: offers.filter((o) => o.title).slice(0, MAX_OFFERS), productLinks: [...new Set(productLinks)].slice(0, 20) };
}

// ---------- matching what was asked ----------

const STOP = new Set(['a', 'an', 'the', 'of', 'for', 'and', 'with', 'in', 'to', 'buy', 'cheap', 'cheapest', 'best', 'near', 'me', 'price', 'store', 'can', 'where', 'i']);

/** Words of a product name, folded so "12oz", "12 Ounce" and "12 fl. oz" agree, as do "24-Pack", "24 ct" and "24 count". */
export function productWords(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/(\w)-(\d)/g, '$1$2')
    .replace(/(\d)\s*(?:fl\.?\s*)?(oz|ounces?|ounce)\b/g, '$1 oz')
    .replace(/(\d)\s*-?\s*(pk|pack|packs|count|ct|pc|pcs|pieces?)\b/g, '$1 pack')
    .replace(/(\d)\s*(lb|lbs|pounds?)\b/g, '$1 lb')
    .replace(/(\d)\s*(in|inch|inches|")(?=\s|$)/g, '$1 in')
    .replace(/(\d)(oz|pack|lb)\b/g, '$1 $2')
    .replace(/[^a-z0-9.]+/g, ' ')
    .split(' ')
    .map((w) => w.replace(/^\.+|\.+$/g, ''))
    .filter((w) => w && !STOP.has(w));
}

/** 0..1: how well a product title matches what was asked (sizes and pack counts must agree). */
export function matchScore(query: string, title: string): number {
  const q = productWords(query);
  if (!q.length) return 0;
  const t = productWords(title);
  const tset = new Set(t);
  const tjoin = ` ${t.join(' ')} `;
  let hit = 0;
  for (const w of q) if (tset.has(w) || (w.length > 3 && [...tset].some((x) => x.startsWith(w) || w.startsWith(x)))) hit++;
  let score = hit / q.length;
  // A size or pack count he named ("12 oz", "24 pack") must be the one on the product.
  const qs = ` ${q.join(' ')} `;
  for (const m of qs.matchAll(/ (\d+(?:\.\d+)?) (oz|pack|lb|in) /g)) if (!tjoin.includes(` ${m[1]} ${m[2]} `)) score *= 0.5;
  // A bundle, combo or multi-pack he didn't ask for ranks below the single item.
  if (!/ pack /.test(qs) && (/ (\d+) pack /.exec(tjoin)?.[1] ?? '1') !== '1') score *= 0.8;
  if (/\b(bundle|combo|kit|set of)\b|&| \+ /i.test(title) && !/\b(bundle|combo|kit|set)\b/i.test(query)) score *= 0.8;
  return Math.round(score * 100) / 100;
}
