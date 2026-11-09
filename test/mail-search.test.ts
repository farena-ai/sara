// M1: Sara's search words → Microsoft Graph and IMAP SEARCH (pure; no network).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyTerms, imapString, parseSearch, SearchWordsError, toGraph, toImap } from '../src/mail/search.ts';
import { narrow } from '../src/mail/organize.ts';

const now = new Date('2026-11-09T18:00:00Z');
const tz = 'America/Chicago';

test('parse: senders, subjects, words, flags, folders, labels and negation', () => {
  const t = parseSearch('from:ana@x.com to:me subject:"lunch plans" is:unread is:starred has:attachment in:spam label:Receipts -from:news@shop.com -promo invoice', { tz, now });
  assert.deepEqual(t.from, ['ana@x.com']);
  assert.deepEqual(t.to, ['me']);
  assert.deepEqual(t.subject, ['lunch plans']);
  assert.deepEqual(t.words, ['invoice']);
  assert.deepEqual(t.notFrom, ['news@shop.com']);
  assert.deepEqual(t.notWords, ['promo']);
  assert.equal(t.unread, true);
  assert.equal(t.flagged, true);
  assert.equal(t.attachment, true);
  assert.equal(t.folder, 'spam');
  assert.equal(t.label, 'Receipts');
  assert.equal(emptyTerms(parseSearch('', { tz, now })), true);
});

test('dates: before is exclusive at midnight in the owner zone; date words go through gmail-dates', () => {
  const t = parseSearch('before:2026/10/02', { tz, now });
  assert.equal(new Date(t.before!).toISOString(), '2026-10-02T05:00:00.000Z');
  const w = parseSearch('', { dates: 'Oct 1st, 2026 or older', tz, now });
  assert.equal(new Date(w.before!).toISOString(), '2026-10-02T05:00:00.000Z');
  assert.ok(w.dates);
  const rel = parseSearch('older_than:7d newer_than:30d', { tz, now });
  assert.equal(rel.before, now.getTime() - 7 * 86_400_000);
  assert.equal(rel.after, now.getTime() - 30 * 86_400_000);
  assert.throws(() => parseSearch('', { dates: 'whenever', tz, now }), SearchWordsError);
});

test('Gmail-only words are refused with a plain sentence, never dropped', () => {
  assert.throws(() => parseSearch('category:promotions', { tz, now }), /Gmail tab/);
  assert.throws(() => parseSearch('from:a OR from:b', { tz, now }), /only work in Gmail/);
  assert.throws(() => parseSearch('list:foo', { tz, now }), /only works in Gmail/);
  assert.throws(() => toGraph(parseSearch('larger:5M', { tz, now })), /larger/);
  assert.throws(() => toImap(parseSearch('is:important', { tz, now }), tz, true), /important/);
});

test('Graph: $filter for flags and dates; $search (KQL) for words, the rest checked per message', () => {
  const f = toGraph(parseSearch('is:unread is:starred label:Receipts before:2026/10/02 in:inbox', { tz, now }));
  assert.equal(f.search, undefined);
  assert.equal(f.folder?.wellKnown, 'inbox');
  assert.match(f.filter!, /receivedDateTime lt 2026-10-02T05:00:00.000Z/);
  assert.match(f.filter!, /isRead eq false/);
  assert.match(f.filter!, /flag\/flagStatus eq 'flagged'/);
  assert.match(f.filter!, /categories\/any\(c:c eq 'Receipts'\)/);
  const s = toGraph(parseSearch('from:ana subject:"o\'clock" -from:bob is:unread older_than:1y', { tz, now }));
  assert.equal(s.filter, undefined, '$search and $filter never together');
  assert.match(s.search!, /from:\\"ana\\"/);
  assert.match(s.search!, /NOT from:\\"bob\\"/);
  // The unread and date words are checked on each result.
  assert.equal(s.client({ isRead: true, receivedDateTime: '2020-01-01T00:00:00Z' }), false);
  assert.equal(s.client({ isRead: false, receivedDateTime: '2020-01-01T00:00:00Z', from: { emailAddress: { address: 'ana@x' } } }), true);
  assert.equal(s.client({ isRead: false, receivedDateTime: '2026-11-01T00:00:00Z' }), false);
  assert.equal(toGraph(parseSearch('in:"Receipts"', { tz, now })).folder?.name, 'Receipts');
  assert.equal(toGraph(parseSearch('in:trash', { tz, now })).folder?.wellKnown, 'deleteditems');
  assert.equal(toGraph(parseSearch('in:spam', { tz, now })).folder?.wellKnown, 'junkemail');
});

test('IMAP: SEARCH criteria, dates in the owner zone, 8-bit text as a non-synchronizing literal', () => {
  const q = toImap(parseSearch('from:ana@x.com subject:Lunch is:unread -is:starred after:2026/10/01 before:2026/10/02 larger:1M in:archive', { tz, now }), tz, true);
  assert.equal(q.folder, 'archive');
  assert.equal(q.criteria, 'FROM "ana@x.com" SUBJECT "Lunch" UNSEEN UNFLAGGED SINCE 1-Oct-2026 BEFORE 2-Oct-2026 LARGER 1048576');
  assert.equal(q.utf8, false);
  const u = toImap(parseSearch('from:Müller', { tz, now }), tz, true);
  assert.equal(u.utf8, true);
  assert.equal(u.criteria, `FROM {7+}\r\n${Buffer.from('Müller').toString('latin1')}`);
  assert.equal(imapString('say "hi"'), '"say \\"hi\\""');
  assert.equal(toImap(parseSearch('', { tz, now }), tz, true).criteria, 'ALL');
  assert.throws(() => toImap(parseSearch('label:x', { tz, now }), tz, false), /no labels/);
  assert.equal(toImap(parseSearch('label:"Tax 2026"', { tz, now }), tz, true).criteria, 'KEYWORD Tax_2026');
});

test('narrowing: only messages a change really changes are counted', () => {
  const base = parseSearch('from:a', { tz, now });
  assert.equal(narrow('archive', base).folder, 'inbox');
  assert.equal(narrow('read', base).unread, true);
  assert.equal(narrow('unread', base).unread, false);
  assert.equal(narrow('star', base).flagged, false);
  assert.equal(narrow('untrash', base).folder, 'trash');
  assert.equal(narrow('not_spam', base).folder, 'spam');
  assert.equal(narrow('label', base, 'X').notLabel, 'X');
  assert.equal(narrow('unlabel', base, 'X').label, 'X');
  assert.equal(narrow('trash', base).folder, undefined);
});
