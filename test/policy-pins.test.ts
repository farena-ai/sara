import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PIN_KEYS } from '../src/policy-profile.ts';
import { ROOT } from './helpers.ts';

// C2: one table for the policy pins (web/policy-pins.js). Six batches had patched three parallel lists
// (fill, read, locks) and meetings/phoneHelper/workMode were once mis-merged.
type Pin = { key: string; label: () => string; form: string; kind: string; value?: boolean; locks?: string[]; note?: string };
async function table() {
  const stub = 'const t = (s) => s;';
  const src = readFileSync(join(ROOT, 'web', 'policy-pins.js'), 'utf8').replace(/^import \{[^}]*\} from '\.\/naming\.js';$/m, stub);
  return (await import(`data:text/javascript;base64,${Buffer.from(src).toString('base64')}`)) as {
    PINS: Pin[];
    fillPins: (pins: Record<string, unknown>, q: (s: string) => any, qa: (s: string) => any[]) => void;
    readPins: (prev: Record<string, unknown>, q: (s: string) => any, qa: (s: string) => any[]) => Record<string, unknown>;
  };
}
const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
const policyPage = html.slice(html.indexOf('id="po-state"'), html.indexOf('id="po-save"'));
const textOf = (s: string) => s.replace(/<button[\s\S]*?<\/button>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ').trim();

test('policy pins: one row per PIN_KEY, in the same order, each with a label and a form control', async () => {
  const { PINS } = await table();
  assert.deepEqual(PINS.map((p) => p.key), [...PIN_KEYS]);
  for (const p of PINS) {
    assert.ok(p.label().length > 0, `${p.key} has a label`);
    assert.ok(p.form, `${p.key} has a form control`);
    if (p.kind === 'flag') assert.equal(typeof p.value, 'boolean', `${p.key}: a tick box says which value it pins`);
  }
});

test('policy pins: every form control sits in the row whose text is that pin\'s label (no control on the wrong key)', async () => {
  const { PINS } = await table();
  const ids = new Set<string>();
  for (const p of PINS) {
    if (p.kind === 'providers' || p.kind === 'tools') {
      // Section headings: the providers' tick boxes and the tool rows follow their own heading.
      const at = policyPage.indexOf(p.kind === 'providers' ? 'class="po-kinds"' : 'id="po-commands"');
      const heading = [...policyPage.slice(0, at).matchAll(/<h3>([\s\S]*?)<\/h3>/g)].at(-1)?.[1] ?? '';
      assert.equal(textOf(heading), p.label(), p.key);
      continue;
    }
    const id = p.form.replace(/^#/, '');
    assert.ok(!ids.has(id), `${id} is used by one pin only`);
    ids.add(id);
    const row = new RegExp(`<label[^>]*>((?:(?!</label>)[\\s\\S])*?id="${id}"(?:(?!</label>)[\\s\\S])*?)</label>`).exec(policyPage);
    assert.ok(row, `${p.key}: ${p.form} is on the policy page`);
    const text = textOf(row[1].replace(/<select[\s\S]*?<\/select>/g, ''));
    assert.equal(text, p.label(), `${p.key}: ${p.form} is the row "${p.label()}"`);
    if (p.kind === 'flag') assert.match(row[1], new RegExp(`<input id="${id}" type="checkbox"`));
    else if (p.kind !== 'egress') assert.match(row[1], new RegExp(`<select id="${id}"`));
  }
});

test('policy pins: every lock exists elsewhere in the app and belongs to one pin', async () => {
  const { PINS } = await table();
  const seen = new Map<string, string>();
  for (const p of PINS) {
    for (const sel of p.locks ?? []) {
      assert.ok(!seen.has(sel), `${sel} locked by ${seen.get(sel)} and ${p.key}`);
      seen.set(sel, p.key);
      const id = /^#([\w-]+)/.exec(sel)![1];
      assert.ok(html.includes(`id="${id}"`), `${p.key}: ${sel} exists`);
      assert.ok(!policyPage.includes(`id="${id}"`), `${p.key}: ${sel} is on another page, not the policy form`);
    }
    if (p.note) assert.ok(html.includes(`data-page="${p.note}"`), `${p.key}: page ${p.note} exists`);
  }
  // The three that were once mis-merged, spelled out.
  const by = Object.fromEntries(PINS.map((p) => [p.key, p]));
  assert.deepEqual([by.meetings.form, by.meetings.locks, by.meetings.value], ['#po-meetings', ['#lib-meetings-open'], false]);
  assert.deepEqual([by.phoneHelper.form, by.phoneHelper.locks, by.phoneHelper.value], ['#po-phone', ['#hd-on'], false]);
  assert.deepEqual([by.workMode.form, by.workMode.locks, by.workMode.value], ['#po-workmode', ['#atw-on'], true]);
});

test('policy pins: the form shows a policy and reads the same pins back', async () => {
  const { fillPins, readPins } = await table();
  const els = new Map<string, any>();
  const el = (s: string) => {
    if (!els.has(s)) els.set(s, { value: '', checked: false });
    return els.get(s);
  };
  const kinds = ['openai-compatible', 'anthropic'].map((k) => ({ dataset: { kind: k }, checked: false }));
  const q = (s: string) => el(s);
  const qa = (s: string) => (s.endsWith(':checked') ? kinds.filter((b) => b.checked) : kinds);
  const pins = {
    providers: ['anthropic'], tools: { 'group:commands': 'ask', shell: 'never' }, alwaysAllow: false, adultMode: false, shellNetwork: false,
    privateLocal: true, store: 'official', auditRetentionDays: 90, programInstalls: 'ask', containerSandbox: true,
    egressAllowlist: ['registry.npmjs.org'], sharing: false, crews: 'off', memoryTidy: 'local', externalSecrets: true, editors: false,
    legalHold: true, personDelete: false, codeMode: false, parallelReplies: 2, meetings: false, phoneHelper: false, workMode: true,
  };
  fillPins(pins, q, qa);
  assert.equal(el('#po-meetings').checked, true);
  assert.equal(el('#po-phone').checked, true);
  assert.equal(el('#po-workmode').checked, true);
  assert.equal(el('#po-retention').value, '90');
  assert.deepEqual(readPins({ tools: pins.tools }, q, qa), pins);
  // Nothing ticked or picked: nothing pinned.
  els.clear();
  for (const k of kinds) k.checked = false;
  fillPins({}, q, qa);
  assert.deepEqual(readPins({}, q, qa), {});
});
