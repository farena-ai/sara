// S6 (docs/TRAVEL.md): a small built-in table of large airports (city, time zone, country, place for
// the forecast) and airline home pages, so a plain-text itinerary's wall times get their zone and an
// alert can link to the airline. Unknown codes fall back to the person's own time zone and a web search.

export interface Airport {
  name: string;
  city: string;
  tz: string;
  country: string;
  lat: number;
  lon: number;
}

const A = (name: string, city: string, tz: string, country: string, lat: number, lon: number): Airport => ({ name, city, tz, country, lat, lon });

export const AIRPORTS: Readonly<Record<string, Airport>> = {
  ATL: A('Atlanta Hartsfield-Jackson', 'Atlanta', 'America/New_York', 'US', 33.64, -84.43),
  BOS: A('Boston Logan', 'Boston', 'America/New_York', 'US', 42.36, -71.01),
  BWI: A('Baltimore/Washington', 'Baltimore', 'America/New_York', 'US', 39.18, -76.67),
  CLT: A('Charlotte Douglas', 'Charlotte', 'America/New_York', 'US', 35.21, -80.94),
  DCA: A('Washington National', 'Washington', 'America/New_York', 'US', 38.85, -77.04),
  DTW: A('Detroit Metro', 'Detroit', 'America/Detroit', 'US', 42.21, -83.35),
  EWR: A('Newark Liberty', 'Newark', 'America/New_York', 'US', 40.69, -74.17),
  FLL: A('Fort Lauderdale', 'Fort Lauderdale', 'America/New_York', 'US', 26.07, -80.15),
  IAD: A('Washington Dulles', 'Washington', 'America/New_York', 'US', 38.95, -77.46),
  JFK: A('New York JFK', 'New York', 'America/New_York', 'US', 40.64, -73.78),
  LGA: A('New York LaGuardia', 'New York', 'America/New_York', 'US', 40.78, -73.87),
  MCO: A('Orlando', 'Orlando', 'America/New_York', 'US', 28.43, -81.31),
  MIA: A('Miami', 'Miami', 'America/New_York', 'US', 25.79, -80.29),
  PHL: A('Philadelphia', 'Philadelphia', 'America/New_York', 'US', 39.87, -75.24),
  TPA: A('Tampa', 'Tampa', 'America/New_York', 'US', 27.98, -82.53),
  AUS: A('Austin-Bergstrom', 'Austin', 'America/Chicago', 'US', 30.19, -97.67),
  BNA: A('Nashville', 'Nashville', 'America/Chicago', 'US', 36.12, -86.68),
  DFW: A('Dallas/Fort Worth', 'Dallas', 'America/Chicago', 'US', 32.9, -97.04),
  IAH: A('Houston Bush', 'Houston', 'America/Chicago', 'US', 29.99, -95.34),
  MCI: A('Kansas City', 'Kansas City', 'America/Chicago', 'US', 39.3, -94.71),
  MDW: A('Chicago Midway', 'Chicago', 'America/Chicago', 'US', 41.79, -87.75),
  MSP: A('Minneapolis-Saint Paul', 'Minneapolis', 'America/Chicago', 'US', 44.88, -93.22),
  MSY: A('New Orleans', 'New Orleans', 'America/Chicago', 'US', 29.99, -90.26),
  ORD: A("Chicago O'Hare", 'Chicago', 'America/Chicago', 'US', 41.98, -87.9),
  STL: A('St. Louis Lambert', 'St. Louis', 'America/Chicago', 'US', 38.75, -90.37),
  DEN: A('Denver International', 'Denver', 'America/Denver', 'US', 39.86, -104.67),
  SLC: A('Salt Lake City', 'Salt Lake City', 'America/Denver', 'US', 40.79, -111.98),
  PHX: A('Phoenix Sky Harbor', 'Phoenix', 'America/Phoenix', 'US', 33.43, -112.01),
  LAS: A('Las Vegas Harry Reid', 'Las Vegas', 'America/Los_Angeles', 'US', 36.08, -115.15),
  LAX: A('Los Angeles', 'Los Angeles', 'America/Los_Angeles', 'US', 33.94, -118.41),
  PDX: A('Portland', 'Portland', 'America/Los_Angeles', 'US', 45.59, -122.6),
  SAN: A('San Diego', 'San Diego', 'America/Los_Angeles', 'US', 32.73, -117.19),
  SEA: A('Seattle-Tacoma', 'Seattle', 'America/Los_Angeles', 'US', 47.45, -122.31),
  SFO: A('San Francisco', 'San Francisco', 'America/Los_Angeles', 'US', 37.62, -122.38),
  SJC: A('San Jose', 'San Jose', 'America/Los_Angeles', 'US', 37.36, -121.93),
  ANC: A('Anchorage', 'Anchorage', 'America/Anchorage', 'US', 61.17, -149.99),
  HNL: A('Honolulu', 'Honolulu', 'Pacific/Honolulu', 'US', 21.32, -157.92),
  YYZ: A('Toronto Pearson', 'Toronto', 'America/Toronto', 'CA', 43.68, -79.63),
  YVR: A('Vancouver', 'Vancouver', 'America/Vancouver', 'CA', 49.19, -123.18),
  YUL: A('Montréal-Trudeau', 'Montréal', 'America/Toronto', 'CA', 45.47, -73.74),
  MEX: A('Mexico City', 'Mexico City', 'America/Mexico_City', 'MX', 19.44, -99.07),
  CUN: A('Cancún', 'Cancún', 'America/Cancun', 'MX', 21.04, -86.87),
  GRU: A('São Paulo-Guarulhos', 'São Paulo', 'America/Sao_Paulo', 'BR', -23.43, -46.47),
  LHR: A('London Heathrow', 'London', 'Europe/London', 'GB', 51.47, -0.45),
  LGW: A('London Gatwick', 'London', 'Europe/London', 'GB', 51.15, -0.18),
  DUB: A('Dublin', 'Dublin', 'Europe/Dublin', 'IE', 53.42, -6.27),
  CDG: A('Paris Charles de Gaulle', 'Paris', 'Europe/Paris', 'FR', 49.01, 2.55),
  AMS: A('Amsterdam Schiphol', 'Amsterdam', 'Europe/Amsterdam', 'NL', 52.31, 4.76),
  FRA: A('Frankfurt', 'Frankfurt', 'Europe/Berlin', 'DE', 50.04, 8.56),
  MUC: A('Munich', 'Munich', 'Europe/Berlin', 'DE', 48.35, 11.79),
  MAD: A('Madrid-Barajas', 'Madrid', 'Europe/Madrid', 'ES', 40.47, -3.56),
  BCN: A('Barcelona', 'Barcelona', 'Europe/Madrid', 'ES', 41.3, 2.08),
  FCO: A('Rome Fiumicino', 'Rome', 'Europe/Rome', 'IT', 41.8, 12.25),
  LIS: A('Lisbon', 'Lisbon', 'Europe/Lisbon', 'PT', 38.77, -9.13),
  ZRH: A('Zurich', 'Zurich', 'Europe/Zurich', 'CH', 47.46, 8.55),
  DXB: A('Dubai', 'Dubai', 'Asia/Dubai', 'AE', 25.25, 55.36),
  NRT: A('Tokyo Narita', 'Tokyo', 'Asia/Tokyo', 'JP', 35.77, 140.39),
  HND: A('Tokyo Haneda', 'Tokyo', 'Asia/Tokyo', 'JP', 35.55, 139.78),
  SYD: A('Sydney', 'Sydney', 'Australia/Sydney', 'AU', -33.94, 151.18),
};

export const airportOf = (code: string | undefined): Airport | undefined => (code ? AIRPORTS[code.toUpperCase()] : undefined);

/** Airline home pages (check-in and changes live there). IATA code → name and site. */
export const AIRLINES: Readonly<Record<string, { name: string; url: string }>> = {
  AA: { name: 'American Airlines', url: 'https://www.aa.com' },
  UA: { name: 'United', url: 'https://www.united.com' },
  DL: { name: 'Delta', url: 'https://www.delta.com' },
  WN: { name: 'Southwest', url: 'https://www.southwest.com' },
  AS: { name: 'Alaska Airlines', url: 'https://www.alaskaair.com' },
  B6: { name: 'JetBlue', url: 'https://www.jetblue.com' },
  F9: { name: 'Frontier', url: 'https://www.flyfrontier.com' },
  NK: { name: 'Spirit', url: 'https://www.spirit.com' },
  HA: { name: 'Hawaiian Airlines', url: 'https://www.hawaiianairlines.com' },
  AC: { name: 'Air Canada', url: 'https://www.aircanada.com' },
  WS: { name: 'WestJet', url: 'https://www.westjet.com' },
  AM: { name: 'Aeroméxico', url: 'https://www.aeromexico.com' },
  BA: { name: 'British Airways', url: 'https://www.britishairways.com' },
  LH: { name: 'Lufthansa', url: 'https://www.lufthansa.com' },
  AF: { name: 'Air France', url: 'https://www.airfrance.com' },
  KL: { name: 'KLM', url: 'https://www.klm.com' },
  IB: { name: 'Iberia', url: 'https://www.iberia.com' },
  EI: { name: 'Aer Lingus', url: 'https://www.aerlingus.com' },
  EK: { name: 'Emirates', url: 'https://www.emirates.com' },
};

/** Where to change or check in: the airline's site when known, else a web search for it. */
export function airlineLink(code: string | undefined, name: string | undefined): { name: string; url: string; known: boolean } {
  const known = code ? AIRLINES[code.toUpperCase()] : undefined;
  if (known) return { ...known, known: true };
  const n = name?.trim() || code || 'airline';
  return { name: n, url: `https://duckduckgo.com/?q=${encodeURIComponent(`${n} manage booking`)}`, known: false };
}
