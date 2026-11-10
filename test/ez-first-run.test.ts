// 3.3.0 easy mode (ezfirst): the first run for someone who isn't technical. Start talking opens a
// chat with the cursor in the box; the guide survives Esc and reloads; Company is preselected; key
// help per service; one main button on the last step; the old-assistant offer is a quiet line; the
// mic is there from the start; Company mode's chat line talks about her AI service, not folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { billingOf } from '../src/usage.ts';

const web = (f: string) => readFileSync(new URL(`../web/${f}`, import.meta.url), 'utf8');
const fr = await import(new URL('../web/first-run.js', import.meta.url).href);
const t = (s: string, p: Record<string, unknown> = {}) => s.replace(/\{(\w+)\}/g, (_m, k: string) => String(p[k] ?? ''));

test('first run: key help per cloud service (where, what it looks like), nothing invented for others', () => {
  const o = fr.keyHelp('ollama-cloud', t);
  assert.equal(o.url, 'https://ollama.com/settings/keys');
  assert.equal(o.site, 'ollama.com');
  assert.match(o.looks, /letters and numbers/);
  assert.match(fr.keyHelp('openai', t).looks, /sk-/);
  assert.equal(fr.keyHelp('anthropic', t).url, 'https://console.anthropic.com/settings/keys');
  assert.equal(fr.keyHelp('xai', t).site, 'console.x.ai');
  assert.equal(fr.keyHelp('openrouter-2', t).url, 'https://openrouter.ai/keys', 'a second connection of the same service');
  assert.deepEqual(fr.keyHelp('something-else', t), { url: '', site: '', looks: '' });
  const w = web('setup-wizard.js');
  assert.match(w, /A key is like a password for Sara/);
  assert.match(web('index.html'), /id="su-key-help"/);
});

test('first run: the guide ignores Esc and outside clicks, comes back at its step, preselects Company', () => {
  const w = web('setup-wizard.js');
  assert.match(w, /\$\('#setup'\)\.dataset\.required = '1'/, 'required: Esc and outside clicks do nothing');
  assert.match(w, /delete \$\('#setup'\)\.dataset\.required/, 'Connect a brain later (recovery) can still be cancelled');
  assert.match(w, /localStorage\.setItem\(STEP_KEY/);
  assert.match(w, /localStorage\.removeItem\(STEP_KEY\)/);
  assert.match(w, /info\.usePathSet === false \? 'company'/);
  const d = readFileSync(new URL('../web/dialogs.js', import.meta.url), 'utf8');
  assert.match(d, /if \(dialog\.dataset\.required\) return e\.preventDefault\(\)/);
  assert.match(d, /!dialog\.dataset\.required\) requestClose\(dialog\)/);
});

test('first run: GET /api/setup says whether the use choice was picked yet', async () => {
  const src = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.match(src, /usePathSet: Boolean\(s\.usePath\)/);
  assert.match(src, /typeof body\.title === 'string'/, 'the first chat can be named');
});

test('first run: Start talking opens a chat with the cursor in it; the first chat is "Chat with Sara"', () => {
  const w = web('setup-wizard.js');
  assert.match(w, /await suOpenChat\(\)/);
  assert.match(w, /t\('Chat with \{name\}', \{ name: currentIdentity\(\)\.name \|\| 'Sara' \}\)/);
  assert.match(w, /closeToday\(\{ focus: false \}\)/);
  assert.match(w, /\$\('#input'\)\?\.focus\(\)/);
  assert.match(w, /ctx\.renderConvSummary\?\.\(\)/, 'the chat line shows the brain just set up');
});

test('first run: step 4 has one main button; the old assistant is a quiet line; Connected ✓ scrolls into view', () => {
  const w = web('setup-wizard.js');
  assert.doesNotMatch(w, /\$\('#su-starters'\)\.prepend/, 'no big Bring her over chip first');
  assert.match(w, /#su-movein-go/);
  assert.match(web('index.html'), /<p id="su-movein" class="small" hidden><button id="su-movein-go" type="button" class="linkish">/);
  const css = web('first-run.css');
  assert.match(css, /#setup \.hub-note-folded #hub-first-ok \{ display: none; \}/, 'no second purple Got it');
  assert.match(w, /\$\('#su-status'\)\.scrollIntoView/);
  assert.match(w, /su-next-ready/);
});

test('voice: the mic shows from the start and the first tap offers to set her voice up', () => {
  const a = web('app.js');
  assert.match(a, /\$\('#mic'\)\.hidden = !micOk \|\| \(!canHear && \(isMember\(\)/);
  assert.match(a, /if \(voice\.canHear === false && !voice\.mic\.recording\) return void offerVoiceSetup\(\)/);
  assert.match(a, /t\('Set up her voice \(one minute\)'\)/);
  assert.match(a, /\$\('#mic'\)\.addEventListener\('pointerdown'/, 'on a phone the offer shows on the press (the keyboard closing moves the box)');
  assert.match(a, /\$\('#composer'\)\.before\(n\)/, 'above the box, not in the messages that redraw');
});

test('cost labels: Ollama Cloud at ollama.com is paid (api), never "$0 (local)"', () => {
  assert.equal(billingOf({ id: 'ollama-cloud', label: 'Ollama Cloud (API key)', kind: 'openai-compatible', baseUrl: 'https://ollama.com/v1' } as never), 'api');
  assert.equal(billingOf({ id: 'ollama-local', label: 'Ollama', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', local: true } as never), 'local');
  // The walkthrough's fake rewrote the cloud address to 127.0.0.1, which is what made it "local".
  assert.equal(billingOf({ id: 'ollama-cloud', label: 'Ollama Cloud (API key)', kind: 'openai-compatible', baseUrl: 'http://127.0.0.1:8042/v1' } as never), 'local');
});

test('Company mode: the chat line names her AI service in plain words, no folders; "full" is explained', () => {
  const a = web('app.js');
  assert.match(a, /t\('Thinks with \{service\}', \{ service \}\)/);
  assert.match(a, /state\.usePath === 'company' && c\.mode !== 'coding'/);
  assert.match(web('look.js'), /Nothing is lost, keep talking/);
});
