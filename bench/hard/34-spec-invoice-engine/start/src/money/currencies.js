// The currencies the engine knows (SPEC rule 3). `digits` is the number of minor-unit decimals;
// `cashIncrement`, where present, is the smallest cash step in minor units (rule 38).

export const CURRENCIES = Object.freeze({
  JPY: { digits: 0 },
  KRW: { digits: 0 },
  ISK: { digits: 0 },
  USD: { digits: 2 },
  EUR: { digits: 2 },
  GBP: { digits: 2 },
  CHF: { digits: 2, cashIncrement: 5 },
  SEK: { digits: 2, cashIncrement: 100 },
  KWD: { digits: 3 },
  BHD: { digits: 3 },
  OMR: { digits: 3 },
});

export function currencyInfo(code) {
  return Object.prototype.hasOwnProperty.call(CURRENCIES, code) ? CURRENCIES[code] : undefined;
}
