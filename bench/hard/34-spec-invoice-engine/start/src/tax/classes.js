// Tax classes and their rates (SPEC rules 11 and 16).
import { fail } from '../errors.js';
import { normalizeDecimal, parseDecimal } from '../num/parse.js';
import { ZERO } from '../num/rational.js';

export const RATED_CLASSES = Object.freeze(['standard', 'reduced', 'super-reduced']);
export const TAX_CLASSES = Object.freeze([...RATED_CLASSES, 'zero', 'exempt']);

/**
 * The class a line (or the minimum charge) is taxed in:
 *   { name, rate: Rational | null, rateText: string | null, exempt: boolean }
 */
export function resolveTaxClass(name, taxRates, field = 'taxClass') {
  if (typeof name !== 'string' || !TAX_CLASSES.includes(name)) fail('UNKNOWN_TAX_CLASS', `${field}: unknown tax class ${JSON.stringify(name)}`);
  if (name === 'exempt') return { name, rate: null, rateText: null, exempt: true };
  if (name === 'zero') return { name, rate: ZERO, rateText: '0', exempt: false };
  const given = taxRates && Object.prototype.hasOwnProperty.call(taxRates, name) ? taxRates[name] : undefined;
  if (given === undefined) fail('UNKNOWN_TAX_CLASS', `${field}: no rate for tax class ${name}`);
  const rate = parseDecimal(given, `taxRates.${name}`, { min: 0, max: 100, maxDecimals: 4 });
  return { name, rate, rateText: normalizeDecimal(given), exempt: false };
}
