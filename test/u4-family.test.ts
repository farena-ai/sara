// U4.21 (docs/FAMILY.md): the home and family planner on top of R8 Family. Meal planner (week grid,
// recipes parsed from pasted text / a page's JSON-LD / the Library, allergy warnings per member, one
// tap to a grocery list merged with quantities by aisle), chores rota (rotates weekly, reminders per
// member outside quiet hours), school/activity calendar import (text, PDF text, iCal) as pending
// events a parent approves, shown on a family calendar with private events kept to their person,
// and Family Today (tonight's dinner, chores left, next family event). A fake clock; no network.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { FamilyStore, KID_TOOLS, setFamilyRuntime, type ChildProfile, type FamilyAccess } from '../src/family.ts';
import { eventsFromIcs, eventsFromText, familyPlanTick, inQuiet, mergeIngredients, parseIngredient, parseRecipeText, planOf, recipeFromHtml, weekStartOf } from '../src/family-plan.ts';
import { familyOf, FAMILY_WORDS } from '../src/lean.ts';
import { createSaraServer } from '../src/server.ts';
import { SharedBoardStore } from '../src/shared-boards.ts';
import { createFamilyTools } from '../src/tools/family.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const TZ = 'America/Chicago';
const KID: ChildProfile = { band: '10-12', since: '2026-11-01T00:00:00Z', bedtime: { from: '20:30', to: '07:00' }, minutesPerDay: 0, safeSearch: false, shopAllow: [] };
const MIA = 'kid0000001';
const LEO = 'kid0000002';
const SAM = 'adult00001';

function rig(t: TestContext, now = '2026-11-16T18:00:00Z') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date(now) };
  const store = new FamilyStore(join(dir, 'shared', 'family.db'), () => clock.now);
  const boards = new SharedBoardStore(join(dir, 'shared', 'boards.db'));
  const people = [{ id: 'owner', name: 'Alex' }, { id: MIA, name: 'Mia', child: KID }, { id: LEO, name: 'Leo', child: { ...KID, band: '6-9' as const } }, { id: SAM, name: 'Sam' }];
  for (const d of ['own', 'kid']) mkdirSync(join(dir, d), { recursive: true });
  const sent: { person: string; title: string; body: string }[] = [];
  const quiet = new Set<string>();
  const access = (person: string): FamilyAccess => ({ store, person, people: () => people, boards, tz: () => TZ, notifyPerson: (p, title, body) => sent.push({ person: p, title, body }), quietFor: (p) => quiet.has(p) });
  t.after(() => {
    store.close();
    boards.close();
    setFamilyRuntime({ store: undefined as never, tz: () => undefined, now: () => new Date() });
    cleanup();
  });
  return { dir, clock, store, boards, people, access, sent, quiet, known: people.map((p) => p.id), plan: planOf(store, () => clock.now) };
}

test('U4.21 recipes: ingredient lines, pasted recipe text, a page with JSON-LD, merged with quantities by aisle', () => {
  assert.deepEqual(parseIngredient('2 cups flour'), { qty: 2, unit: 'cup', name: 'flour', text: '2 cups flour' });
  assert.deepEqual(parseIngredient('1 1/2 lb chicken breast, diced'), { qty: 1.5, unit: 'lb', name: 'chicken breast', text: '1 1/2 lb chicken breast, diced' });
  assert.deepEqual(parseIngredient('½ tsp salt'), { qty: 0.5, unit: 'tsp', name: 'salt', text: '½ tsp salt' });
  assert.deepEqual(parseIngredient('3 eggs'), { qty: 3, unit: '', name: 'eggs', text: '3 eggs' });
  assert.equal(parseIngredient('Salt and pepper to taste').qty, null);
  const r = parseRecipeText('Chicken tacos\nServes 4\n\nIngredients\n- 1 lb chicken thighs\n- 8 tortillas\n- 1 cup shredded cheese\n\nMethod\n1. Cook the chicken.\n2. Fill the tortillas.');
  assert.equal(r.title, 'Chicken tacos');
  assert.deepEqual(r.ingredients.map((i) => i.name), ['chicken thighs', 'tortillas', 'shredded cheese']);
  assert.equal(r.steps.length, 2);
  const html = `<html><head><title>x</title><script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': [{ '@type': 'WebPage' }, { '@type': ['Recipe'], name: 'Lemon pasta', recipeYield: '4', recipeIngredient: ['12 oz spaghetti', '2 lemons', '1/2 cup parmesan cheese'], recipeInstructions: [{ '@type': 'HowToStep', text: 'Boil the pasta.' }, { '@type': 'HowToStep', text: 'Toss with lemon.' }] }] })}</script></head><body>hi</body></html>`;
  const page = recipeFromHtml(html)!;
  assert.equal(page.title, 'Lemon pasta');
  assert.deepEqual(page.ingredients.map((i) => i.name), ['spaghetti', 'lemons', 'parmesan cheese']);
  assert.deepEqual(page.steps, ['Boil the pasta.', 'Toss with lemon.']);
  assert.equal(recipeFromHtml('<html><body>no recipe</body></html>'), undefined);
  const merged = mergeIngredients([parseIngredient('1 lb chicken thighs'), parseIngredient('2 lbs chicken thighs'), parseIngredient('3 eggs'), parseIngredient('2 egg'), parseIngredient('1 cup milk'), parseIngredient('Salt to taste'), parseIngredient('1 tbsp salt')]);
  const line = (n: string) => merged.find((m) => m.name === n)!;
  assert.equal(line('chicken thighs').title, '3 lb chicken thighs');
  assert.equal(line('chicken thighs').aisle, 'meat');
  assert.equal(line('eggs').title, '5 eggs', 'singular and plural merge');
  assert.equal(line('milk').aisle, 'dairy');
  assert.equal(merged.filter((m) => m.name === 'salt').length, 1, 'salt once');
  const more = mergeIngredients(['1/4 cup peanut butter', '1 cup shredded cheese', '1 cup shredded cheese', '1 can tomato sauce', '12 oz spaghetti', '1 1/2 cups rice'].map(parseIngredient));
  const m2 = (n: string) => more.find((m) => m.name === n)!;
  assert.equal(m2('peanut butter').title, '1/4 cup peanut butter');
  assert.equal(m2('peanut butter').aisle, 'pantry', 'not dairy');
  assert.equal(m2('shredded cheese').title, '2 cups shredded cheese');
  assert.equal(m2('tomato sauce').aisle, 'pantry', 'a can is pantry, not produce');
  assert.equal(m2('spaghetti').aisle, 'pantry');
  assert.equal(m2('rice').title, '1 1/2 cups rice');
});

test('U4.21 meals: parents plan the week, allergy warnings per member, kids read only, one tap to a merged grocery list', (t) => {
  const r = rig(t);
  const { plan } = r;
  assert.equal(weekStartOf(r.clock.now, TZ), '2026-11-16');
  plan.setPrefs('owner', MIA, { likes: 'pasta, tacos', dislikes: 'mushrooms', allergies: 'peanuts' }, r.known);
  plan.setPrefs(SAM, SAM, { allergies: 'shellfish' }, r.known);
  assert.throws(() => plan.setPrefs(LEO, MIA, { allergies: 'x' }, r.known), /Only a parent/);
  assert.deepEqual(plan.prefs(LEO).map((p) => p.person), [], 'a kid sees only their own (none yet)');
  assert.equal(plan.prefs('owner').length, 2);
  assert.deepEqual(plan.prefs(SAM).map((p) => p.person), [SAM], 'a grown-up member sees only their own');
  const tacos = plan.addRecipe('owner', { text: 'Chicken tacos\nIngredients\n1 lb chicken thighs\n8 tortillas\n1 cup shredded cheese' });
  const satay = plan.addRecipe('owner', { title: 'Satay', ingredients: ['1 lb chicken thighs', '1/2 cup peanut butter'] });
  assert.throws(() => plan.addRecipe(MIA, { text: 'x\n1 egg' }), /Only a parent/);
  const a = plan.setMeal('owner', '2026-11-16', { recipeId: tacos.id }, r.people);
  assert.deepEqual(a.warnings, []);
  const b = plan.setMeal('owner', '2026-11-17', { recipeId: satay.id }, r.people);
  assert.match(b.warnings[0]!, /Mia.*peanut/i);
  plan.setMeal('owner', '2026-11-18', { title: 'Shrimp stir fry' }, r.people);
  assert.throws(() => plan.setMeal(MIA, '2026-11-19', { title: 'Ice cream' }, r.people), /Only a parent/);
  const week = plan.week(MIA, '2026-11-16', TZ, r.people);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0]!.meal!.title, 'Chicken tacos');
  assert.equal(week.days[2]!.meal!.title, 'Shrimp stir fry');
  assert.match(week.days[2]!.meal!.warnings.join(' '), /Sam.*shellfish/i, 'title words count too');
  const list = plan.shopping('2026-11-16');
  assert.equal(list.find((l) => l.name === 'chicken thighs')!.title, '2 lb chicken thighs', 'two dinners merged');
  // One tap: into a grocery list (made when there is none), grouped by aisle; again adds nothing twice.
  const res = plan.toGrocery('owner', '2026-11-16', r.boards, r.known);
  assert.equal(res.added, 4);
  const view = r.store.groceryView(r.boards, 'owner', res.listId)!;
  assert.deepEqual(view.aisles.map((x) => x.id).sort(), ['bakery', 'dairy', 'meat', 'pantry']);
  assert.equal(plan.toGrocery('owner', '2026-11-16', r.boards, r.known).added, 0, 'no doubles');
  assert.throws(() => plan.toGrocery(MIA, '2026-11-16', r.boards, r.known), /Only a parent/);
  plan.clearMeal('owner', '2026-11-18');
  assert.equal(plan.week('owner', '2026-11-16', TZ).days[2]!.meal, null);
});

test('U4.21 chores rota: rotates weekly on the rota day once, reminders per member outside quiet hours, once a day', (t) => {
  const r = rig(t, '2026-11-16T15:00:00Z');
  const { store, plan, known } = r;
  const dishes = store.addChore('owner', { title: 'Dishes', assignee: MIA, repeat: 'daily', dueAt: '2026-11-17T00:00:00Z', points: 2 }, known);
  assert.throws(() => plan.setRota(MIA, dishes.id, [MIA, LEO], known), /Only a parent/);
  assert.throws(() => plan.setRota('owner', dishes.id, [MIA, 'nobody'], known), /Pick who/);
  plan.setRota('owner', dishes.id, [MIA, LEO], known);
  assert.deepEqual(plan.rota(dishes.id), [MIA, LEO]);
  plan.setSettings('owner', { rotaDay: 1, remindAt: '16:00', reminders: true });
  // Monday 9:00 Chicago: the rota turns once (Mia -> Leo); later the same week nothing.
  assert.equal(plan.rotateDue(r.clock.now, TZ), 1);
  assert.equal(store.chore(dishes.id)!.assignee, LEO);
  assert.equal(plan.rotateDue(new Date('2026-11-17T15:00:00Z'), TZ), 0);
  assert.equal(plan.rotateDue(new Date('2026-11-23T15:00:00Z'), TZ), 1, 'next week: back to Mia');
  assert.equal(store.chore(dishes.id)!.assignee, MIA);
  // Reminders: at 16:00 local, the person with chores left; Mia is in quiet hours -> later.
  r.clock.now = new Date('2026-11-23T22:05:00Z');
  r.quiet.add(MIA);
  familyPlanTick(r.access('owner'), r.clock.now);
  assert.equal(r.sent.length, 0, 'quiet hours: not now');
  r.quiet.clear();
  familyPlanTick(r.access('owner'), new Date('2026-11-23T22:20:00Z'));
  assert.equal(r.sent.length, 1);
  assert.equal(r.sent[0]!.person, MIA);
  assert.match(r.sent[0]!.body, /Dishes/);
  familyPlanTick(r.access('owner'), new Date('2026-11-23T23:20:00Z'));
  assert.equal(r.sent.length, 1, 'once a day');
  plan.setSettings('owner', { reminders: false });
  familyPlanTick(r.access('owner'), new Date('2026-11-24T22:20:00Z'));
  assert.equal(r.sent.length, 1, 'off');
  assert.throws(() => plan.setSettings(SAM, { reminders: true }), /Only a parent/);
  assert.equal(inQuiet(23, 22, 7), true);
  assert.equal(inQuiet(12, 22, 7), false);
});

test('U4.21 calendar: school text and iCal become pending events a parent approves; private events stay with their person', (t) => {
  const r = rig(t);
  const { plan } = r;
  const text = 'Lincoln Elementary — December\nNo school Monday 11/30 (staff day).\nWinter concert December 10 at 6:30 pm in the gym.\nEarly release on 12/18.\nSoccer practice every Tuesday';
  const found = eventsFromText(text, r.clock.now);
  assert.deepEqual(found.map((e) => e.start), ['2026-11-30', '2026-12-10T18:30', '2026-12-18']);
  assert.match(found[1]!.title, /Winter concert/);
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:a1', 'SUMMARY:Swim meet', 'DTSTART:20261121T150000Z', 'DTEND:20261121T170000Z', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const fromIcs = eventsFromIcs(ics, r.clock.now);
  assert.deepEqual(fromIcs.map((e) => e.title), ['Swim meet']);
  assert.throws(() => plan.importEvents(MIA, found, 'School PDF'), /Only a parent/);
  const pending = plan.importEvents('owner', [...found, ...fromIcs], 'School PDF');
  assert.equal(pending.length, 4);
  assert.equal(plan.importEvents('owner', found, 'School PDF').length, 0, 'the same dates twice are not added again');
  assert.equal(plan.events('owner', '2026-11-16', '2026-12-31').length, 0, 'nothing shows before approval');
  assert.equal(plan.decide('owner', pending.slice(0, 3).map((e) => e.id), true), 3);
  assert.equal(plan.decide('owner', [pending[3]!.id], false), 1);
  const fam = plan.events(MIA, '2026-11-16', '2026-12-31');
  assert.deepEqual(fam.map((e) => e.title).length, 3, 'a kid sees family events');
  plan.addEvent(SAM, { title: 'Dentist', start: '2026-11-20T15:00', who: 'me' });
  plan.addEvent(MIA, { title: 'Sleepover at Ava’s', start: '2026-11-21', who: 'family' });
  assert.ok(plan.events(SAM, '2026-11-16', '2026-11-30').some((e) => e.title === 'Dentist'));
  assert.ok(!plan.events('owner', '2026-11-16', '2026-11-30').some((e) => e.title === 'Dentist'), 'private stays private, even from the owner');
  assert.ok(!plan.events('owner', '2026-11-16', '2026-11-30').some((e) => e.title.startsWith('Sleepover')), 'a kid’s family event waits for a parent');
  assert.equal(plan.pending('owner').length, 1);
  assert.deepEqual(plan.pending(MIA), [], 'only parents see what waits');
  const wk = plan.week(MIA, '2026-11-30', TZ);
  assert.match(wk.days[0]!.events.map((e) => e.title).join(), /No school/);
});

test('U4.21 Family Today: tonight’s dinner, chores left, next family event; on the existing Family tile', (t) => {
  const r = rig(t, '2026-11-16T18:00:00Z');
  const { plan, store, known } = r;
  store.addChore('owner', { title: 'Feed the cat', assignee: MIA, dueAt: '2026-11-16T23:00:00Z' }, known);
  plan.setMeal('owner', '2026-11-16', { title: 'Lemon pasta' }, r.people);
  const e = plan.addEvent('owner', { title: 'Swim meet', start: '2026-11-21T09:00', who: 'family' });
  assert.equal(e.status, 'ok');
  const p = plan.today(MIA, r.clock.now, TZ);
  assert.equal(p.dinner, 'Lemon pasta');
  assert.equal(p.choresLeft, 1);
  assert.equal(p.nextEvent!.title, 'Swim meet');
  const tile = store.todayTile(MIA, [{ id: MIA, name: 'Mia' }, { id: LEO, name: 'Leo' }], r.clock.now, TZ);
  assert.ok(tile, 'the kid tile shows');
});

test('U4.21 routes: the week, meals, recipe paste, import with approval, shopping; kids read only; members isolated', async (t) => {
  const r = rig(t);
  const app = makeApp(join(r.dir, 'own'), r.clock);
  app.settings.update({ ownerName: 'Alex', disclosureAcceptedAt: r.clock.now.toISOString() });
  app.family = r.access('owner');
  const auth = new OwnerAuth(join(r.dir, 'own'), () => r.clock.now);
  const srv = createSaraServer({ app, auth, webDir: join(ROOT, 'web') });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  t.after(() => {
    srv.close();
    app.store.close();
  });
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const req = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${auth.newToken}`, origin: base, 'content-type': 'application/json' }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const rec = await req('POST', '/api/family/recipes', { text: 'Pancakes\nIngredients\n2 cups flour\n2 eggs\n1 cup milk' });
  assert.equal(rec.status, 200);
  assert.equal(rec.body.recipe.ingredients.length, 3);
  assert.equal((await req('PUT', '/api/family/meals/2026-11-16', { recipeId: rec.body.recipe.id })).status, 200);
  const wk = await req('GET', '/api/family/week?start=2026-11-16');
  assert.equal(wk.body.week.days[0].meal.title, 'Pancakes');
  const imp = await req('POST', '/api/family/events/import', { text: 'Book fair on 11/19.', source: 'Newsletter' });
  assert.equal(imp.body.pending.length, 1);
  await req('POST', '/api/family/events/decide', { ids: [imp.body.pending[0].id], ok: true });
  assert.equal((await req('GET', '/api/family/week?start=2026-11-16')).body.week.days[3].events[0].title, 'Book fair');
  const shop = await req('POST', '/api/family/meals/shopping', { start: '2026-11-16' });
  assert.equal(shop.body.added, 3);
  const prefs = await req('PUT', `/api/family/prefs/${MIA}`, { allergies: 'eggs' });
  assert.equal(prefs.status, 200);
  assert.match((await req('GET', '/api/family/week?start=2026-11-16')).body.week.days[0].meal.warnings.join(), /Mia/);
  const set = await req('PUT', '/api/family/plan-settings', { dinnerTime: '18:30', remindAt: '17:00', reminders: true, rotaDay: 0 });
  assert.equal(set.body.settings.dinnerTime, '18:30');
  assert.equal((await req('GET', '/api/family')).body.plan.settings.remindAt, '17:00');
  // A kid's space: reads, but cannot change the plan.
  app.family = r.access(MIA);
  assert.equal((await req('PUT', '/api/family/meals/2026-11-17', { title: 'Cake' })).status, 403);
  assert.equal((await req('POST', '/api/family/events/import', { text: 'x on 11/20' })).status, 403);
  assert.equal((await req('GET', '/api/family/week?start=2026-11-16')).status, 200);
  assert.equal((await req('PUT', `/api/family/prefs/${LEO}`, { allergies: 'x' })).status, 403);
});

test('U4.21 tools and wiring: lean words, kid tool list, the tick, strings and docs', async (t) => {
  const r = rig(t);
  const app = makeApp(join(r.dir, 'own'), r.clock);
  app.family = r.access('owner');
  t.after(() => app.store.close());
  const tools = createFamilyTools(() => app);
  for (const tool of tools) assert.equal(familyOf(tool).id, 'family', tool.spec.name);
  const by = (n: string) => tools.find((x) => x.spec.name === n)!;
  assert.ok(by('meal_plan_get') && by('meal_plan_set') && by('meal_shopping') && by('family_calendar'));
  r.plan.setPrefs('owner', MIA, { allergies: 'peanuts' }, r.known);
  const got = String(await by('meal_plan_get').run({}, { signal: new AbortController().signal } as never));
  assert.match(got, /Mia.*peanuts/);
  const set = String(await by('meal_plan_set').run({ dinners: [{ day: '2026-11-17', title: 'Peanut noodles', ingredients: ['8 oz noodles', '1/4 cup peanut butter'] }, { day: '2026-11-18', title: 'Tacos' }] }, { signal: new AbortController().signal } as never));
  assert.match(set, /2 dinners/);
  assert.match(set, /Mia.*peanut/i, 'the allergy warning comes back to her');
  const shop = String(await by('meal_shopping').run({}, { signal: new AbortController().signal } as never));
  assert.match(shop, /noodles/);
  assert.ok(KID_TOOLS.has('family_calendar'));
  assert.ok(!KID_TOOLS.has('meal_plan_set'));
  assert.ok(FAMILY_WORDS.family?.includes('dinners'));
  const src = (p: string) => readFileSync(join(ROOT, p), 'utf8');
  assert.match(src('src/family.ts'), /familyPlanTick\(f, now\)/);
  assert.match(src('docs/FAMILY.md'), /## Home and family planner \(U4\.21\)/);
  for (const lang of ['es', 'fr', 'de', 'pt-BR', 'it']) {
    const tx = src(`web/i18n/${lang}.json`);
    for (const k of ['Meals', 'Calendar', 'Tonight: {meal}', 'Add to the grocery list']) assert.ok(tx.includes(`"${k}":`), `${lang}: ${k}`);
  }
});
