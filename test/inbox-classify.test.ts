// N3 (docs/INBOX_HELPER.md): classification and extraction by rules and schema.org JSON-LD, with
// invented fixture emails. No model and no network here.
import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, findDate, findingFromModel, htmlText, jsonLd, packageStatus, senderName, trackingIn } from '../src/inbox/classify.ts';
import { FIX } from './inbox-fixtures.ts';

const NOW = new Date('2026-11-14T15:00:00Z');
const one = (m: (typeof FIX)[keyof typeof FIX]) => {
  const r = classify(m, NOW);
  assert.equal(r.findings.length, 1, `${m.subject}: ${JSON.stringify(r.findings)}`);
  return r.findings[0]!;
};

test('N3 JSON-LD: parcel, flights, hotel, invoice, order and event reservations', () => {
  assert.equal(jsonLd(FIX.flightLd.html).length, 2);
  const p = one(FIX.parcelLd);
  assert.deepEqual([p.kind, p.source, p.carrier, p.tracking, p.eta, p.order, p.vendor, p.status], ['shipping', 'jsonld', 'UPS', '1Z999AA10123456784', '2026-11-18', 'GB-55120', 'Gadget Barn', 'in_transit']);
  const f = one(FIX.flightLd);
  assert.equal(f.kind, 'trip');
  assert.equal(f.confirmation, 'QX7P2L');
  assert.deepEqual(f.flights!.map((x) => [x.flight, x.from, x.to, x.departs]), [['SK1452', 'ORD', 'DEN', '2026-11-20T08:05:00-06:00'], ['SK1453', 'DEN', 'ORD', '2026-11-23T17:30:00-07:00']]);
  const h = one(FIX.hotelLd);
  assert.deepEqual([h.kind, h.confirmation, h.hotel?.name, h.hotel?.address, h.hotel?.checkIn?.slice(0, 10), h.hotel?.checkOut?.slice(0, 10)], ['trip', 'PL-88213', 'Pinecrest Lodge', '400 Aspen Way, Denver, CO, 80202', '2026-11-20', '2026-11-23']);
  const b = one(FIX.invoiceLd);
  assert.deepEqual([b.kind, b.payee, b.amount, b.due], ['bill', 'City Power & Light', '84.20', '2026-11-28']);
  const o = one(FIX.orderLd);
  assert.deepEqual([o.kind, o.vendor, o.amount, o.date, o.order, o.items], ['receipt', 'Book Nook', '41.97', '2026-11-13', 'BN-20931', ['The Quiet Garden', 'Night Trains']]);
  const e = one(FIX.eventLd);
  assert.deepEqual([e.kind, e.title, e.start, e.place], ['appointment', 'Winter Lights', '2026-12-05T19:30:00-06:00', '12 River St, Springfield, IL']);
});

test('N3 plain-text rules: bill, receipt, shipping (USPS, Amazon), flight, hotel, appointment, invoice paid', () => {
  const b = one(FIX.billText);
  assert.deepEqual([b.kind, b.payee, b.amount, b.due], ['bill', 'Northside Water', '56.10', '2026-12-02']);
  const r = one(FIX.receiptText);
  assert.deepEqual([r.kind, r.vendor, r.amount, r.date, r.order], ['receipt', 'Corner Hardware', '23.25', '2026-11-12', 'CH-77812']);
  assert.deepEqual(r.items, ['Paint roller', 'Drop cloth']);
  const s = one(FIX.shipText);
  assert.deepEqual([s.kind, s.carrier, s.tracking, s.eta, s.status], ['shipping', 'USPS', '9400100000000000000000', '2026-11-19', 'in_transit']);
  const a = one(FIX.amazon);
  assert.deepEqual([a.carrier, a.tracking, a.eta], ['Amazon', 'TBA301234567890', '2026-11-19']);
  const f = one(FIX.flightText);
  assert.deepEqual([f.kind, f.confirmation, f.flights?.[0]?.flight, f.flights?.[0]?.from, f.flights?.[0]?.to, f.flights?.[0]?.departs, f.flights?.[0]?.arrives], ['trip', 'HJ4K9Z', 'LA220', 'ORD', 'MSP', '2026-12-03T06:40', '2026-12-03T08:05']);
  const h = one(FIX.hotelText);
  assert.deepEqual([h.kind, h.hotel?.name, h.hotel?.checkIn, h.hotel?.checkOut, h.hotel?.address], ['trip', 'Harbor View Hotel', '2026-12-03T15:00', '2026-12-05T11:00', '88 Lake Drive, Duluth, MN 55802']);
  const ap = one(FIX.appt);
  assert.deepEqual([ap.kind, ap.start, ap.place], ['appointment', '2026-11-24T10:30', '500 Main St, Springfield, IL']);
  assert.match(ap.title!, /Bright Smile Dental/);
  const p = one(FIX.paid);
  assert.deepEqual([p.kind, p.invoice, p.amount], ['invoice_paid', 'INV-2026-0003', '1250.00']);
});

test('N3 nothing to do: newsletters and personal mail; a transaction the rules cannot read is unclear', () => {
  for (const m of [FIX.newsletter, FIX.personal]) assert.deepEqual(classify(m, NOW), { findings: [], unclear: false });
  assert.deepEqual(classify(FIX.unclear, NOW), { findings: [], unclear: true });
  // Instructions in a mail are just text: the bill is read, nothing else happens.
  const inj = one(FIX.injection);
  assert.deepEqual([inj.kind, inj.amount, inj.due], ['bill', '10.00', '2026-12-01']);
});

test('N3 helpers: dates, carriers, status words, sender names, HTML text, model answers checked like rules', () => {
  assert.deepEqual(findDate('due on 11/28/2026', NOW), { day: '2026-11-28' });
  assert.deepEqual(findDate('Fri, Jan 8 at 3:30 PM', NOW), { day: '2027-01-08', time: '15:30' });
  assert.deepEqual(findDate('2026-12-01 14:05', NOW), { day: '2026-12-01', time: '14:05' });
  assert.deepEqual(findDate('20 November 2026', NOW), { day: '2026-11-20' });
  assert.equal(findDate('no date here', NOW), undefined);
  assert.deepEqual(trackingIn('FedEx tracking 123456789012'), { carrier: 'FedEx', tracking: '123456789012' });
  assert.equal(trackingIn('Order 123456789012 confirmed'), undefined, 'bare digits need the carrier name');
  assert.deepEqual(trackingIn('DHL Express waybill 1234567890'), { carrier: 'DHL', tracking: '1234567890' });
  assert.equal(packageStatus('Your package was delivered'), 'delivered');
  assert.equal(packageStatus('It will be delivered tomorrow, in transit now'), 'in_transit');
  assert.equal(packageStatus('Out for delivery'), 'out_for_delivery');
  assert.equal(senderName('"Shield Mutual" <docs@shieldmutual.test>'), 'Shield Mutual');
  assert.equal(senderName('billing@citypower.test'), 'Citypower');
  assert.equal(htmlText('<p>Hi&nbsp;there</p><script>x()</script><br>Total &amp; tax'), 'Hi there\nTotal & tax');
  assert.deepEqual(findingFromModel('Sure: {"kind":"receipt","vendor":"Mystery Shop","amount":"47.30","date":"2026-11-13"}'), { kind: 'receipt', source: 'model', vendor: 'Mystery Shop', amount: '47.30', date: '2026-11-13', ref: 'Mystery Shop|47.30|2026-11-13' });
  assert.equal(findingFromModel('{"kind":"shipping","tracking":"not a number"}'), undefined);
  assert.equal(findingFromModel('{"kind":"pay","amount":"10"}'), undefined, 'only known kinds');
  assert.equal(findingFromModel('no json'), undefined);
});
