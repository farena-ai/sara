// R9 "Polish for everyone": document facts in six languages. The N6 rules (src/facts.ts) read
// renewal, expiry, due, lease-end and warranty dates, deductibles, premiums, rent and deposits in
// Spanish, French, German, Brazilian Portuguese and Italian too; dates follow the document's own
// order (day-month outside English, found cheaply from stopwords), money keeps its own format
// (1.234,56 €). English stays exactly as before (US order for 03/04/2027).
import assert from 'node:assert/strict';
import test from 'node:test';
import { extractFacts, isoDate } from '../src/facts.ts';
import { detectDocLang, isoDateIn, moneyIn } from '../src/facts-lang.ts';
import { N6_DOCS } from './n6-fixtures.ts';
import { R9_DOCS } from './r9-facts-fixtures.ts';

const facts = (d: { name: string; pages: readonly string[] }) => extractFacts({ name: d.name }, d.pages.map((text, i) => ({ text, page: i + 1, place: `page ${i + 1}` })));
const pick = (d: { name: string; pages: readonly string[] }) => Object.fromEntries(facts(d).map((f) => [f.label, f.value]));

test('R9.1 language from stopwords; English is the default', () => {
  assert.equal(detectDocLang(R9_DOCS.es.pages.join('\n')), 'es');
  assert.equal(detectDocLang(R9_DOCS.esPolicy.pages.join('\n')), 'es');
  assert.equal(detectDocLang(R9_DOCS.fr.pages.join('\n')), 'fr');
  assert.equal(detectDocLang(R9_DOCS.frLease.pages.join('\n')), 'fr');
  assert.equal(detectDocLang(R9_DOCS.de.pages.join('\n')), 'de');
  assert.equal(detectDocLang(R9_DOCS.deBill.pages.join('\n')), 'de');
  assert.equal(detectDocLang(R9_DOCS.pt.pages.join('\n')), 'pt');
  assert.equal(detectDocLang(R9_DOCS.it.pages.join('\n')), 'it');
  for (const d of Object.values(N6_DOCS)) assert.equal(detectDocLang(d.pages.join('\n')), 'en', d.name);
  assert.equal(detectDocLang('12/03/2027'), 'en');
});

test('R9.2 dates: day-month order and month names per language; English unchanged', () => {
  assert.equal(isoDateIn('03/04/2027', 'es'), '2027-04-03');
  assert.equal(isoDateIn('31.08.2027', 'de'), '2027-08-31');
  assert.equal(isoDateIn('1. März 2027', 'de'), '2027-03-01');
  assert.equal(isoDateIn('1er mars 2027', 'fr'), '2027-03-01');
  assert.equal(isoDateIn('31 de mayo de 2027', 'es'), '2027-05-31');
  assert.equal(isoDateIn('10 de março de 2027', 'pt'), '2027-03-10');
  assert.equal(isoDateIn('15 marzo 2028', 'it'), '2028-03-15');
  assert.equal(isoDateIn('30 février 2027', 'fr'), null);
  assert.equal(isoDateIn('13/13/2027', 'it'), null);
  assert.equal(isoDate('03/04/2027'), '2027-03-04');
  assert.equal(isoDateIn('03/04/2027', 'en'), '2027-03-04');
});

test('R9.3 money keeps its own format', () => {
  assert.equal(moneyIn('Renta mensual: 1.250,00 € pagaderos'), '1.250,00 €');
  assert.equal(moneyIn('Kaution: 3.360,00 EUR auf'), '3.360,00 EUR');
  assert.equal(moneyIn('Franquia: R$ 2.450,00 por'), 'R$ 2.450,00');
  assert.equal(moneyIn('Cotisation annuelle : 1 024,50 €'), '1 024,50 €');
  assert.equal(moneyIn('Franchise : € 300'), '€ 300');
  assert.equal(moneyIn('nothing here 2027'), null);
});

test('R9.4 Spanish lease and home policy', () => {
  const a = pick(R9_DOCS.es);
  assert.equal(a['Lease ends'], '2027-05-31');
  assert.equal(a.Rent, '1.250,00 €');
  assert.equal(a['Security deposit'], '2.500,00 EUR');
  assert.equal(a.Tenant, 'Lucía Gómez');
  assert.match(a.Landlord, /^Inmobiliaria Sol/);
  const b = pick(R9_DOCS.esPolicy);
  assert.equal(b['Renewal date'], '2027-04-03', 'day-month order');
  assert.equal(b['Due date'], '2026-12-15');
  assert.equal(b.Premium, '312,40 €');
  assert.equal(b.Deductible, '150 €');
  assert.equal(b['Policy number'], '\u2022\u2022\u2022\u20220877');
});

test('R9.5 French auto policy and lease', () => {
  const a = pick(R9_DOCS.fr);
  assert.equal(a['Renewal date'], '2027-03-01');
  assert.equal(a['Due date'], '2027-01-05');
  assert.equal(a.Deductible, '300,00 €');
  assert.equal(a.Premium, '1 024,50 €');
  assert.equal(a['Policy number'], '\u2022\u2022\u2022\u20222345');
  const b = pick(R9_DOCS.frLease);
  assert.equal(b['Lease ends'], '2027-09-30');
  assert.equal(b.Rent, '980,00 €');
  assert.equal(b['Security deposit'], '980 €');
});

test('R9.6 German lease and bill', () => {
  const a = pick(R9_DOCS.de);
  assert.equal(a['Lease ends'], '2027-08-31');
  assert.equal(a.Rent, '1.120,00 EUR');
  assert.equal(a['Security deposit'], '3.360,00 €');
  const b = pick(R9_DOCS.deBill);
  assert.equal(b['Due date'], '2026-12-12');
  assert.equal(b['Warranty ends'], '2029-03-01');
});

test('R9.7 Brazilian Portuguese auto policy', () => {
  const a = pick(R9_DOCS.pt);
  assert.equal(a['Due date'], '2026-12-05');
  assert.equal(a['Renewal date'], '2027-02-10');
  assert.equal(a.Deductible, 'R$ 2.450,00');
  assert.equal(a.Premium, 'R$ 1.980,35');
  assert.equal(a['Policy number'], '\u2022\u2022\u2022\u20221870');
});

test('R9.8 Italian warranty', () => {
  const a = pick(R9_DOCS.it);
  assert.equal(a['Warranty ends'], '2028-03-15');
  assert.equal(a['Due date'], '2027-01-20');
  assert.equal(a['Serial number'], '\u2022\u2022\u2022\u20221234');
});

test('R9.9 English documents read exactly as before', () => {
  const lease = pick(N6_DOCS.lease);
  assert.equal(lease['Lease ends'], '2027-05-31');
  assert.equal(lease.Rent, '$1,450.00 (monthly rent)');
  const pol = pick(N6_DOCS.policy);
  assert.equal(pol['Renewal date'], '2027-03-01');
  assert.equal(pol['Due date'], '2026-12-05');
  assert.equal(pol['Passport number'], undefined);
  const pass = pick(N6_DOCS.passport);
  assert.equal(pass['Passport expires'], '2031-03-09');
});
