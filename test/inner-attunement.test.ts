import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { BASELINE_VALENCE, describeInner, InnerStore, signalsIn } from '../src/inner.ts';

const now = new Date('2026-11-05T15:00:00Z');
const labels = (text: string) => signalsIn(text).map(s => s.label);

test('E2 inner: task criticism, quoted and negated conflict cannot move legacy conflict state', () => {
  for (const text of ['This code is useless', 'This stupid build failed', 'The API was wrong', '"You are useless"', '`shut up`', 'My friend said you never listen', "I'm not mad at you", "I'm not sorry", 'If I were stressed', 'Are you useless?']) {
    assert.deepEqual(labels(text), [], text);
  }
});

test('E2 inner: distinct harsh, fight and apology keep their once-per-message weights and order', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inner = new InnerStore(db, () => now);
    inner.save({ ...inner.get(), irritation: 0.1, tension: 0.1 });
    const s = inner.onOwnerMessage("Shut up. You are useless. I'm mad at you. You never listen. I'm sorry. I apologize.", null, now);
    assert.ok(Math.abs(s.irritation - 0.4) < 1e-12);
    assert.ok(Math.abs(s.valence - (BASELINE_VALENCE - 0.25 - 0.15 + 0.08)) < 1e-12);
    assert.ok(Math.abs(s.tension - 0.4) < 1e-12);
    assert.equal(s.tensionAbout, null);
    assert.equal(s.tensionAt, now.toISOString());
    assert.deepEqual(s.causes, ['{owner} apologized', '{owner} and you argued', '{owner} was harsh with you']);
  } finally { db.close(); }
});

test('E2 inner: actual companion name is optional and never hardcoded', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inner = new InnerStore(db, () => now);
    const s = inner.onOwnerMessage('Nova is useless', null, now, 'Nova');
    assert.equal(s.irritation, 0.45);
    assert.deepEqual(labels('Sara is useless'), []);
  } finally { db.close(); }
});

test('E2 inner: fatigue alone leaves persistent concern, valence and causes untouched', () => {
  for (const text of ["I'm exhausted", "I'm burnt out", "I'm burned out"]) {
    const db = new DatabaseSync(':memory:');
    try {
      const inner = new InnerStore(db, () => now);
      const before = inner.get(); const after = inner.onOwnerMessage(text, null, now);
      assert.equal(after.concern, before.concern, text);
      assert.equal(after.valence, before.valence, text);
      assert.deepEqual(after.causes, before.causes, text);
      assert.ok(after.closeness > before.closeness, 'ordinary time together still progresses');
    } finally { db.close(); }
  }
});

test('E2 inner: retained stress/rough-day concern is attributable, nonnegated and deduplicated', () => {
  for (const text of ["I'm stressed", "I'm so stressed, rough day", "I'm exhausted and stressed", 'rough day', 'I had a rough day', "I've had a rough day", "No problem, I'm stressed", "I have no idea why I feel stressed", "She had a rough day, I'm stressed"]) {
    const db = new DatabaseSync(':memory:');
    try {
      const s = new InnerStore(db, () => now).onOwnerMessage(text, null, now);
      assert.equal(s.concern, 0.45, text); assert.equal(s.valence, BASELINE_VALENCE - 0.05, text);
      assert.deepEqual(s.causes, ['{owner} seemed down'], text);
    } finally { db.close(); }
  }
  for (const text of ['"I am stressed"', '`rough day`', 'My friend is stressed', "I'm not stressed", "I'm no longer stressed", 'This is not a rough day', 'No rough day today', 'I had no rough day', "I haven't been stressed", "I'm not feeling stressed", 'I never feel anxious']) {
    assert.deepEqual(labels(text), [], text);
  }
});

for (const text of ["I haven't been feeling stressed", 'She had a rough day', 'He had a rough day']) {
  test(`E2 inner: denied or third-person concern leaves persistent state untouched: ${text}`, () => {
    const db = new DatabaseSync(':memory:');
    try {
      const inner = new InnerStore(db, () => now);
      inner.save({ ...inner.get(), concern: 0.2, causes: ['existing synthetic cause'] });
      const before = inner.get();
      const after = inner.onOwnerMessage(text, null, now);
      assert.equal(after.concern, before.concern, text);
      assert.equal(after.valence, before.valence, text);
      assert.deepEqual(after.causes, before.causes, text);
      assert.deepEqual(signalsIn(text), [], text);
      assert.ok(after.closeness > before.closeness, 'ordinary time together still progresses');
    } finally { db.close(); }
  });
}

test('E2 inner: retained concern combines with distinct legacy conflict and apology weights', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inner = new InnerStore(db, () => now);
    inner.save({ ...inner.get(), irritation: 0.1, tension: 0.1 });
    const after = inner.onOwnerMessage("I'm exhausted and stressed. Shut up. I'm mad at you. I'm sorry.", null, now);
    assert.equal(after.concern, 0.45);
    assert.ok(Math.abs(after.valence - (BASELINE_VALENCE - 0.05 - 0.25 - 0.15 + 0.08)) < 1e-12);
    assert.ok(Math.abs(after.irritation - 0.4) < 1e-12);
    assert.ok(Math.abs(after.tension - 0.4) < 1e-12);
    assert.deepEqual(after.causes, ['{owner} apologized', '{owner} and you argued', '{owner} was harsh with you', '{owner} seemed down']);
  } finally { db.close(); }
});

test('E2 inner: historical private raw quotes are omitted without read mutation or history reset', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const inner = new InnerStore(db, () => now);
    const state = { ...inner.get(), valence: -0.2, irritation: 0.4, tension: 0.7,
      tensionAbout: 'synthetic private historic quote', tensionAt: '2026-11-05T08:00:00Z', causes: ['{owner} and you argued'] };
    inner.save(state);
    const raw = () => (db.prepare('SELECT state FROM sara_state').get() as { state: string }).state;
    const before = raw();
    const read = inner.get();
    const prompt = describeInner(read, now, 'UTC', 'Alex', { gapHours: null, daysKnown: null });
    assert.doesNotMatch(prompt, /synthetic private historic quote|they said:/);
    assert.match(prompt, /had a disagreement/);
    assert.equal(raw(), before);
    assert.ok(Math.abs(read.valence - state.valence) < 1e-12, 'existing decay arithmetic is preserved');
    assert.deepEqual({ ...read, valence: state.valence }, state);
    const unrelated = inner.onOwnerMessage('hello', null, now);
    assert.equal(unrelated.tensionAbout, state.tensionAbout); assert.equal(unrelated.tensionAt, state.tensionAt);
    const fight = inner.onOwnerMessage('You are useless', null, now);
    assert.equal(fight.tensionAbout, null); assert.equal(fight.tensionAt, now.toISOString());
  } finally { db.close(); }
});
