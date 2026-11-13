// E2 (docs/SHOPPING.md): the retailers the product finder knows how to check: their public search
// page (an ordinary address anyone can open), what their product pages look like, and the OSM
// brand that marks one of their stores. No logins, no private APIs, no store cookies: a site's
// own default store and prices are what it shows to anyone.
import type { NearbyStore } from './places.ts';

export interface Retailer {
  id: string;
  name: string;
  /** Host name without www. */
  host: string;
  /** OSM name/brand of their stores (none: online only). */
  brand?: RegExp;
  online: boolean;
  search: (q: string) => string;
  /** A product page's path. */
  product: RegExp;
}

const q = encodeURIComponent;

export const RETAILERS: readonly Retailer[] = [
  { id: 'walmart', name: 'Walmart', host: 'walmart.com', brand: /^walmart\b/i, online: true, search: (s) => `https://www.walmart.com/search?q=${q(s)}`, product: /^\/ip\// },
  { id: 'amazon', name: 'Amazon', host: 'amazon.com', online: true, search: (s) => `https://www.amazon.com/s?k=${q(s)}`, product: /\/dp\/[A-Z0-9]{10}/ },
  { id: 'target', name: 'Target', host: 'target.com', brand: /^target\b/i, online: true, search: (s) => `https://www.target.com/s?searchTerm=${q(s)}`, product: /^\/p\/.*\/-\/A-\d+/ },
  { id: 'homedepot', name: 'The Home Depot', host: 'homedepot.com', brand: /home depot/i, online: true, search: (s) => `https://www.homedepot.com/s/${q(s)}`, product: /^\/p\// },
  { id: 'lowes', name: "Lowe's", host: 'lowes.com', brand: /^lowe'?s\b/i, online: true, search: (s) => `https://www.lowes.com/search?searchTerm=${q(s)}`, product: /^\/pd\// },
  { id: 'bestbuy', name: 'Best Buy', host: 'bestbuy.com', brand: /^best ?buy\b/i, online: true, search: (s) => `https://www.bestbuy.com/site/searchpage.jsp?st=${q(s)}`, product: /^\/site\/.+\.p$/ },
  { id: 'walgreens', name: 'Walgreens', host: 'walgreens.com', brand: /^walgreens\b/i, online: true, search: (s) => `https://www.walgreens.com/search/results.jsp?Ntt=${q(s)}`, product: /^\/store\/c\// },
  { id: 'cvs', name: 'CVS', host: 'cvs.com', brand: /^cvs\b/i, online: true, search: (s) => `https://www.cvs.com/search?searchTerm=${q(s)}`, product: /^\/shop\// },
  { id: 'autozone', name: 'AutoZone', host: 'autozone.com', brand: /^autozone\b/i, online: true, search: (s) => `https://www.autozone.com/searchresult?searchText=${q(s)}`, product: /\/p\/|_\d+_0$/ },
  { id: 'acehardware', name: 'Ace Hardware', host: 'acehardware.com', brand: /\bace hardware\b/i, online: true, search: (s) => `https://www.acehardware.com/search?query=${q(s)}`, product: /^\/departments\/.+\/\d+$/ },
  { id: 'harborfreight', name: 'Harbor Freight', host: 'harborfreight.com', brand: /harbor freight/i, online: true, search: (s) => `https://www.harborfreight.com/search?q=${q(s)}`, product: /-\d+\.html$/ },
  { id: 'menards', name: 'Menards', host: 'menards.com', brand: /^menards\b/i, online: true, search: (s) => `https://www.menards.com/main/search.html?search=${q(s)}`, product: /\/p-\d+/ },
];

/** Big general stores first when several chains are near (more likely to carry an everyday item). */
export const GENERAL = ['walmart', 'target', 'homedepot', 'lowes', 'bestbuy', 'menards', 'acehardware', 'harborfreight', 'walgreens', 'cvs', 'autozone'];
/** Online by default (any place): the biggest general retailers. */
export const ONLINE_DEFAULT = ['amazon', 'walmart', 'target'];

const bare = (h: string) => h.toLowerCase().replace(/^www\./, '');

export function retailerForUrl(url: string): Retailer | undefined {
  try {
    const h = bare(new URL(url).hostname);
    return RETAILERS.find((r) => h === r.host || h.endsWith(`.${r.host}`));
  } catch {
    return undefined;
  }
}

/** A retailer by name or id as a person says it ("home depot", "Lowes", "amazon.com"). */
export function retailerByName(name: string): Retailer | undefined {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '').replace(/com$/, '');
  return RETAILERS.find((r) => r.id === n || r.name.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/^the/, '') === n || r.host.replace(/\.com$/, '').replace(/[^a-z0-9]/g, '') === n);
}

/** The retailer one of the nearby stores belongs to (by its brand or name). */
export function retailerForStore(s: Pick<NearbyStore, 'name' | 'brand'>): Retailer | undefined {
  return RETAILERS.find((r) => r.brand && (r.brand.test(s.brand ?? '') || r.brand.test(s.name)));
}

/** True when the address is one of the retailer's product pages. */
export function isProductUrl(r: Retailer, url: string): boolean {
  try {
    const u = new URL(url);
    return bare(u.hostname).endsWith(r.host) && r.product.test(u.pathname);
  } catch {
    return false;
  }
}
