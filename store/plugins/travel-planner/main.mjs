import { plugin } from './native.mjs';
import { only, text, list, number, result, tool } from './workflow.mjs';
// Explicit, deliberately bounded currency contract; all arithmetic is integer minor units.
const precision = { USD: 2, EUR: 2, GBP: 2, CAD: 2, AUD: 2, BRL: 2, CHF: 2, JPY: 0, KRW: 0, KWD: 3, BHD: 3, OMR: 3 };
function minor(value, name, digits) {
  number(value, name);
  const [whole, fraction = ''] = String(value).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > digits) throw new Error(`${name}: unsupported currency precision (maximum ${digits} decimal places).`);
  const units = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, '0'));
  if (!Number.isSafeInteger(units)) throw new Error('Money exceeds safe integer minor units.');
  return units;
}
function date(x, name) { const s = text(x, name, 10); if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s) throw new Error(`${name}: use a real YYYY-MM-DD date.`); return s; }
plugin({ tools: [tool('Arrange owner-confirmed source options into a dated travel plan with deterministic budget arithmetic. Supplied estimates only, never live quotes or bookings.', async args => {
  only(args, ['start', 'end', 'currency', 'budget', 'preferences', 'options']);
  const start = date(args.start, 'start'), end = date(args.end, 'end'), days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
  if (days < 1 || days > 31) throw new Error('Trip must run forward and cover 1 to 31 calendar days.');
  const currency = text(args.currency, 'currency', 3); if (!Object.hasOwn(precision, currency)) throw new Error('Unsupported currency. No currency conversion.');
  const budget = number(args.budget, 'budget'), preferences = text(args.preferences, 'preferences', 300);
  const digits = precision[currency], scale = 10 ** digits, budgetUnits = minor(budget, 'budget', digits);
  const ids = new Set();
  const itinerary = list(args.options, 'options', 8).map(o => {
    only(o, ['id', 'date', 'title', 'amount', 'source', 'checked', 'confirmed']);
    if (o.confirmed !== true) throw new Error('Only owner-confirmed source options are accepted.');
    const id = text(o.id, 'option.id', 60), day = date(o.date, 'option.date');
    if (day < start || day > end) throw new Error('An option lies outside the trip dates.');
    if (ids.has(id)) throw new Error('Option IDs must be unique.'); ids.add(id);
    minor(o.amount, 'amount', digits);
    return { sourceId: id, date: day, title: text(o.title, 'title', 100), amount: number(o.amount, 'amount'), source: text(o.source, 'source', 180), checked: date(o.checked, 'checked') };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const totalUnits = itinerary.reduce((s, o) => s + minor(o.amount, 'amount', digits), 0);
  if (!Number.isSafeInteger(totalUnits)) throw new Error('Total exceeds safe integer minor units.');
  const suppliedTotal = totalUnits / scale;
  const occupied = new Set(itinerary.map(o => o.date));
  const unplannedDates = Array.from({ length: days }, (_, i) => new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10)).filter(d => !occupied.has(d));
  return result({ start, end, days, currency, budget, preferences, itinerary, suppliedTotal, remainingBudget: (budgetUnits - totalUnits) / scale, overBudget: totalUnits > budgetUnits, unplannedDates, priceStatus: 'Owner-supplied estimates, not live quotes. Confirm availability, taxes, transport and accommodation separately.', booked: false, unknowns: ['No transport routing or opening-hours verification.', 'Dates are calendar dates, not timezone-aware departure times.', 'Preferences are recorded, not proof an option satisfies them.'] });
})] });
