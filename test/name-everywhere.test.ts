// A renamed companion is named (and gendered) everywhere she is meant, in all six languages, and
// Sara ships a built-in look for he and for they that shows until the owner makes a look of their own.
// The scans at the end keep new screens from bypassing the mechanism (src/identity.ts, web/naming.js).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OwnerAuth } from '../src/auth.ts';
import { appearanceFor, BUILTIN_PATH, DEFAULT_LOOKS, defaultLookFile, defaultLookFor } from '../src/default-look.ts';
import { personalize, personalizeTranslation, selectPronoun, swapName } from '../src/identity.ts';
import { tr } from '../src/i18n.ts';
import { LookBuilder } from '../src/look.ts';
import { buildSystemPrompt, loadPersona, withOwnPronouns } from '../src/persona.ts';
import { createSaraServer } from '../src/server.ts';
import { makeApp, ROOT, tempDir } from './helpers.ts';

const fred = { name: 'Fred', pronouns: 'he' } as const;
const river = { name: 'River', pronouns: 'they' } as const;
const WEB = join(ROOT, 'web');

test('English: both pronouns of "her her own" change, product names keep "Sara"', () => {
  assert.equal(personalize('Her likes, limits and turn-offs make her her own.', fred), 'His likes, limits and turn-offs make him his own.');
  assert.equal(personalize('Update Sara to get the Sara app for Windows; Sara 3.3.0 is out.', fred), 'Update Sara to get the Sara app for Windows; Sara 3.3.0 is out.');
  assert.equal(personalize('Sara remembers it. Ask Sara.', fred), 'Fred remembers it. Ask Fred.');
  assert.equal(swapName('Restart Sara now; the Sara Store too', 'Fred'), 'Restart Sara now; the Sara Store too');
  assert.equal(personalize('She did 1 thing', river), 'They did 1 thing');
});

test('translations: {p, select, …} variants, strong pronouns only where the English speaks of her', () => {
  const sel = 'Elle est {p, select, she {prête} he {prêt} other {prêt·e}}.';
  assert.equal(selectPronoun(sel, 'she'), 'Elle est prête.');
  assert.equal(selectPronoun(sel, 'he'), 'Elle est prêt.');
  assert.equal(selectPronoun(sel, 'they'), 'Elle est prêt·e.');
  assert.equal(personalizeTranslation('Saved: she remembers what matters', 'Enregistrée : elle retient ce qui compte', fred, 'fr'), 'Enregistrée : il retient ce qui compte');
  assert.equal(personalizeTranslation('Talk with her', 'Parle avec elle', fred, 'fr'), 'Parle avec lui');
  assert.equal(personalizeTranslation('Saved: she remembers what matters', 'Enregistrée : elle retient ce qui compte', river, 'fr'), 'Enregistrée : River retient ce qui compte');
  // A feminine noun in a string that isn't about her stays as it is.
  assert.equal(personalizeTranslation('The update restarts the server.', 'La mise à jour : elle redémarre le serveur.', fred, 'fr'), 'La mise à jour : elle redémarre le serveur.');
  assert.equal(personalizeTranslation('What she remembered', 'O que ela lembrou', fred, 'pt-BR'), 'O que ele lembrou');
  assert.equal(personalizeTranslation('Her day', 'O dia dela', fred, 'pt-BR'), 'O dia dele');
  assert.equal(personalizeTranslation('Her day', 'O dia dela', river, 'pt-BR'), 'O dia de River');
  assert.equal(personalizeTranslation('She answers', 'Ella responde', fred, 'es'), 'Él responde');
  assert.equal(personalizeTranslation('She answers', 'Risponde lei', fred, 'it'), 'Risponde lui');
  assert.equal(personalizeTranslation('She answers in this chat.', 'Sie antwortet in diesem Chat.', fred, 'de'), 'Er antwortet in diesem Chat.');
  assert.equal(personalizeTranslation('Plan my day with her', 'Meinen Tag mit Sara planen', fred, 'de'), 'Meinen Tag mit Fred planen');
  // Agreement right after her name or pronoun.
  assert.equal(personalizeTranslation('What should Sara call you?', "Comment Sara doit-elle t'appeler ?", fred, 'fr'), "Comment Fred doit-il t'appeler ?");
  assert.equal(personalizeTranslation('The model kept failing, so she stopped.', "Le modèle a échoué, alors Sara s'est arrêtée.", fred, 'fr'), "Le modèle a échoué, alors Fred s'est arrêté.");
  assert.equal(personalizeTranslation('The model kept failing, so she stopped.', "Le modèle a échoué, alors Sara s'est arrêtée.", river, 'fr'), "Le modèle a échoué, alors River s'est arrêté·e.");
  assert.equal(personalizeTranslation('What she remembered', "Ce dont elle s'est souvenue", fred, 'fr'), "Ce dont il s'est souvenu");
  assert.equal(personalizeTranslation('Sara restarted', 'Sara si è riavviata', fred, 'it'), 'Fred si è riavviato');
  assert.equal(personalizeTranslation('Sara was updated.', 'Sara è stata aggiornata.', fred, 'it'), 'Fred è stato aggiornato.');
  assert.equal(personalizeTranslation('Sara is stuck', 'Sara está atascada', fred, 'es'), 'Fred está atascado');
  assert.equal(personalizeTranslation('she is busy answering right now.', 'ela está ocupada respondendo agora.', fred, 'pt-BR'), 'ele está ocupado respondendo agora.');
  // With only \"her\" in the English, a French subject \"elle\" is a noun (the task), not her.
  assert.equal(personalizeTranslation('How many tasks this agent may give her a day. One more and it is refused.', 'Combien de tâches cet agent peut lui donner par jour. Une de plus et elle est refusée.', fred, 'fr'), 'Combien de tâches cet agent peut lui donner par jour. Une de plus et elle est refusée.');
  assert.equal(personalizeTranslation("Sara looks at how she's set up.", 'Sara regarde comment elle est configurée.', fred, 'fr'), 'Fred regarde comment il est configuré.');
  assert.equal(personalizeTranslation('Sara files every session here by herself.', "Sara range ici d'elle-même chaque session.", fred, 'fr'), 'Fred range ici de lui-même chaque session.');
  assert.equal(swapName('Choisis Sara Classique', 'Fred'), 'Choisis Sara Classique');
  assert.equal(personalizeTranslation('Sara files every Telegram session here by itself.', "Sara range ici d'elle-même chaque session Telegram.", fred, 'fr'), 'Fred range ici de lui-même chaque session Telegram.');
  assert.equal(personalizeTranslation('Relaxed', '{p, select, she {Détendue} he {Détendu} other {Détendu}}', fred, 'fr'), 'Détendu');
  assert.equal(personalizeTranslation('Relaxed', '{p, select, she {Relajada} other {Relajado}}', river, 'es'), 'Relajado');
  // Her map (feminine noun) in French is not her: "Elle se met à jour toute seule" stays.
  assert.equal(personalizeTranslation('It stays up to date by itself.', 'Elle se met à jour toute seule.', fred, 'fr'), 'Elle se met à jour toute seule.');
  // The server's tr() resolves a select even without an identity (Sara).
  assert.equal(tr('Default (he)', 'de'), 'Standard (er)');
});

test('the shipped character lines follow a rename; lines the owner wrote are kept', () => {
  const sara = loadPersona(join(ROOT, 'persona', 'sara.json'));
  const p = withOwnPronouns({ ...sara, name: 'Fred', pronouns: 'he', background: [...sara.background, 'Her cat is called Biscuit.'] });
  assert.ok(p.background.some((l) => l.includes('spends his time')));
  assert.ok(p.background.includes('Her cat is called Biscuit.'), 'owner-written line untouched');
  const prompt = buildSystemPrompt({ ...sara, name: 'Fred', pronouns: 'he' }, { now: new Date('2026-11-10T12:00:00Z') });
  const who = prompt.slice(0, prompt.indexOf('## Boundaries'));
  assert.doesNotMatch(who, /\b(she|her|hers|herself)\b/i, 'no she/her in who he is');
  assert.match(prompt, /You are Fred/);
});

test('default looks: he and they have the same picture set as Sara, landmarks and a modest size', () => {
  const sara = ['sara-portrait.jpg', 'sara-avatar.jpg', 'sara/face.json', ...readdirSync(join(WEB, 'sara')).filter((f) => f.endsWith('.jpg')).map((f) => `sara/${f}`), ...readdirSync(join(WEB, 'sara', 'frames')).map((f) => `sara/frames/${f}`)];
  assert.equal(sara.length, 43);
  let bytes = 0;
  for (const id of ['he', 'they'] as const) {
    for (const rel of sara) {
      assert.ok(BUILTIN_PATH.test(rel), rel);
      const f = defaultLookFile(WEB, rel, id);
      assert.ok(f && existsSync(f), `${id}: ${rel}`);
      bytes += statSync(f).size;
    }
    const face = JSON.parse(readFileSync(join(WEB, 'looks', id, 'sara', 'face.json'), 'utf8')) as Record<string, { le: { x: number }; re: { x: number } }>;
    for (const m of ['default', 'happy', 'caring', 'sleepy', 'hurt', 'playful']) assert.ok(face[m] && face[m].le.x < face[m].re.x, `${id} ${m}`);
  }
  assert.ok(bytes < 4_000_000, `${bytes} bytes`);
  assert.equal(defaultLookFile(WEB, 'sara-portrait.jpg', 'she'), undefined, 'Sara is the web root');
  assert.equal(defaultLookFile(WEB, 'index.html', 'he'), undefined);
  assert.equal(defaultLookFor(undefined, 'he'), 'he');
  assert.equal(defaultLookFor('auto', 'they'), 'they');
  assert.equal(defaultLookFor('she', 'he'), 'she', 'a picked look wins over the pronouns');
  assert.equal(appearanceFor(DEFAULT_LOOKS.she.appearance, 'he'), DEFAULT_LOOKS.he.appearance);
  assert.equal(appearanceFor('a tall man with glasses', 'they'), 'a tall man with glasses');
});

const { dir, cleanup } = tempDir();
const app = makeApp(dir, { now: new Date('2026-11-10T12:00:00Z') });
app.persona = { ...app.persona, name: 'Fred', pronouns: 'he' };
app.look = new LookBuilder({ dataDir: dir, key: async () => undefined, builtin: (rel) => defaultLookFile(WEB, rel, defaultLookFor(app.settings.get().defaultLook, app.persona.pronouns)) }) as never;
const auth = new OwnerAuth(dir);
const token = auth.newToken!;
const server = createSaraServer({ app, auth, webDir: WEB });
let base = '';
before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => {
  server.close();
  app.store.close();
  cleanup();
});
const call = (p: string, init: RequestInit = {}) => fetch(base + p, { ...init, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
const bytesOf = async (p: string) => Buffer.from(await (await call(p)).arrayBuffer());

test('server: the matching default look shows; a pick by name or a custom look wins', async () => {
  assert.deepEqual(await bytesOf('/sara-portrait.jpg'), readFileSync(join(WEB, 'looks', 'he', 'sara-portrait.jpg')));
  assert.deepEqual(await bytesOf('/sara/frames/happy-blink.jpg'), readFileSync(join(WEB, 'looks', 'he', 'sara', 'frames', 'happy-blink.jpg')));
  const face = await call('/sara/face.json');
  assert.equal(face.headers.get('content-type'), 'application/json');
  // Signed out (the sign-in page): Sara.
  assert.deepEqual(Buffer.from(await (await fetch(base + '/sara-portrait.jpg')).arrayBuffer()), readFileSync(join(WEB, 'sara-portrait.jpg')));
  const l = (await (await call('/api/look')).json()) as { defaults: { id: string; label: string }[]; defaultLook: string; defaultShown: string };
  assert.deepEqual(l.defaults.map((d) => d.label), ['Default (she)', 'Default (he)', 'Default (they)']);
  assert.equal(l.defaultLook, 'auto');
  assert.equal(l.defaultShown, 'he');
  const put = (await (await call('/api/look/default', { method: 'PUT', body: JSON.stringify({ look: 'they', offered: 'he' }) })).json()) as { defaultShown: string; defaultOffered: string };
  assert.equal(put.defaultShown, 'they');
  assert.equal(put.defaultOffered, 'he');
  assert.deepEqual(await bytesOf('/sara-avatar.jpg'), readFileSync(join(WEB, 'looks', 'they', 'sara-avatar.jpg')));
  mkdirSync(join(dir, 'look'), { recursive: true });
  writeFileSync(join(dir, 'look', 'sara-portrait.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  assert.deepEqual(await bytesOf('/sara-portrait.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'a custom look is never replaced');
  assert.equal((await call('/sara/frames/happy-blink.jpg')).status, 404, 'a custom look never borrows a default frame');
});

// ---- Regression scans: companion words must go through the mechanism. ----
const COMPANION = /\b(Sara|she|her|hers|herself|She|Her|Hers|Herself)\b/;
// Product mentions that keep "Sara" after a rename, in raw (never personalized) markup.
const PRODUCT_OK = /Sara (?:Classic|Store|app|Hub)|Sara move-in collector/;

test('scan: raw markup in index.html holds no companion words (data-raw / data-noname bypass naming)', () => {
  const html = readFileSync(join(WEB, 'index.html'), 'utf8');
  const bad: string[] = [];
  for (const m of html.matchAll(/<(\w+)[^>]*\bdata-raw\b[^>]*>([^<]*)</g)) if (COMPANION.test(m[2]) && !PRODUCT_OK.test(m[2])) bad.push(m[0].slice(0, 120));
  for (const m of html.matchAll(/<select[^>]*\bdata-noname\b[^>]*>([\s\S]*?)<\/select>/g)) {
    for (const o of m[1].matchAll(/<option[^>]*>([^<]*)</g)) if (/\bSara\b/.test(o[1])) bad.push(o[0]);
  }
  assert.deepEqual(bad, []);
  // Every pronoun picker is marked so its "she / her" label isn't turned into the current pronouns.
  for (const m of html.matchAll(/<select[^>]*>(?:(?!<\/select>)[\s\S])*?she \/ her/g)) assert.match(m[0], /data-noname/, m[0].slice(0, 80));
});

test('scan: web code never swaps the name by hand or shows her words outside t()', () => {
  const bad: string[] = [];
  for (const f of readdirSync(WEB).filter((x) => x.endsWith('.js'))) {
    if (f === 'naming.js' || f === 'help-i18n.js' || f.startsWith('business')) continue;
    const src = readFileSync(join(WEB, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      // A hand-made rename skips pronouns and translations.
      if (/\.replace\(\/\\bSara\\b\//.test(line)) bad.push(`${f}:${i + 1} hand rename`);
      // Native notifications and the window title don't pass through the page's text rewriting.
      const m = /(new Notification\(|document\.title\s*=)\s*(['"`])([^'"`]*)\2/.exec(line);
      if (m && COMPANION.test(m[3])) bad.push(`${f}:${i + 1} ${m[3]}`);
    });
  }
  assert.deepEqual(bad, []);
});

test('scan: translations with pronoun variants are well formed; the help page is personalized', () => {
  for (const l of ['de', 'fr', 'es', 'it', 'pt-BR']) {
    const d = JSON.parse(readFileSync(join(WEB, 'i18n', `${l}.json`), 'utf8')) as Record<string, string>;
    for (const [en, v] of Object.entries(d)) {
      if (!v.includes(', select,')) continue;
      assert.match(v, /\{p, select,(?:\s*(?:she|he|they|other) \{[^{}]*\})+\s*\}/, `${l}: ${en}`);
      for (const p of ['she', 'he', 'they'] as const) assert.doesNotMatch(selectPronoun(v, p), /select,/, `${l} ${p}: ${en}`);
    }
  }
  const help = readFileSync(join(WEB, 'help-i18n.js'), 'utf8');
  assert.match(help, /import\('\/identity\.js'\)/);
  assert.match(help, /personalizeTranslation/);
  const naming = readFileSync(join(WEB, 'naming.js'), 'utf8');
  assert.match(naming, /personalizeTranslation/);
  // Text built in code with t() follows a rename too (re-rendered from what t() remembers).
  assert.match(naming, /function refreshBuilt\(\)/);
  assert.match(naming, /built\.set\(out, \(\) => t\(s, vars\)\)/);
});
