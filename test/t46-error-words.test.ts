// T46 (E3): plain errors people see (voice, voice install, mail accounts, model providers) are
// marked for translation. Each test makes the real error, then reads it in the five languages the
// way the app does: the English text (or its template and values) looked up in web/i18n.
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { readWav } from '../src/briefing-audio.ts';
import { HttpError, send } from '../src/http.ts';
import { keyedText, tr } from '../src/i18n.ts';
import { ProviderError, reach } from '../src/providers/types.ts';
import { elevenlabsSpeak, openaiSpeak, openaiTranscribe, VoiceError, xaiSpeak } from '../src/voice.ts';
import { downloadPinned, installJob, startInstall, VoiceInstallError } from '../src/voice-install.ts';
import { tempDir } from './helpers.ts';

const LANGS = ['es', 'fr', 'de', 'pt-BR', 'it'] as const;
const closers: (() => void)[] = [];
after(() => {
  for (const c of closers.reverse()) c();
});

async function thrown(f: () => unknown): Promise<Error> {
  try {
    await f();
  } catch (err) {
    return err as Error;
  }
  throw new Error('nothing was thrown');
}

/** The message as the app shows it in one language (web/naming.js serverText does the same lookup). */
function shown(message: string, lang: string): string {
  const k = keyedText(message);
  return k ? tr(k.key, lang, k.params) : tr(message, lang);
}
function translatedEverywhere(message: string, mustKeep: string[] = []): void {
  const seen = new Set<string>([message]);
  for (const lang of LANGS) {
    const text = shown(message, lang);
    assert.notEqual(text, message, `${lang}: still English: ${message}`);
    for (const keep of mustKeep) assert.ok(text.includes(keep), `${lang}: lost "${keep}" in: ${text}`);
    assert.ok(!/\{\w+\}/.test(text), `${lang}: an unfilled placeholder in: ${text}`);
    seen.add(text);
  }
  assert.ok(seen.size >= 5, `the languages differ from each other: ${message}`);
}

test('voice errors with fixed words read in every language', async () => {
  const cfg = { sttModel: 'x', ttsModel: 'x', voice: 'x', baseUrl: 'http://127.0.0.1:9' } as never;
  const errors = [
    await thrown(() => openaiTranscribe(cfg, undefined, Buffer.alloc(0))),
    await thrown(() => openaiSpeak(cfg, undefined, 'hello', 1)),
    await thrown(() => elevenlabsSpeak({ voiceId: '', model: 'm' } as never, undefined, 'hello')),
    await thrown(() => elevenlabsSpeak({ voiceId: '', model: 'm' } as never, 'a-key', 'hello')),
    await thrown(() => xaiSpeak('ara' as never, undefined, 'hello', 1)),
    await thrown(() => readWav(Buffer.from('not a wav file at all'))),
  ];
  for (const e of errors) {
    assert.ok(e instanceof VoiceError, e.message);
    translatedEverywhere(e.message);
  }
  assert.equal(new Set(errors.map((e) => e.message)).size, 5, 'five different messages (the speech key one twice)');
  assert.match(shown(errors[0].message, 'de'), /Einstellungen → Stimme/);
  assert.match(shown(errors[5].message, 'es'), /WAV/);
});

test('an error with values keeps them and still translates; the English stays as it was', async () => {
  const dir = tempDir();
  closers.push(dir.cleanup);
  const fetch503 = (async () => new Response('busy', { status: 503 })) as typeof fetch;
  const e = await thrown(() => downloadPinned('https://downloads.example.test/voice.tar', 'ab'.repeat(32), join(dir.dir, 'v.tar'), { fetch: fetch503 }));
  assert.ok(e instanceof VoiceInstallError);
  assert.equal(e.message, 'Download failed (HTTP 503).');
  assert.deepEqual(keyedText(e.message), { key: 'Download failed (HTTP {status}).', params: { status: 503 } });
  translatedEverywhere(e.message, ['503']);
  assert.equal(shown(e.message, 'fr'), 'Le téléchargement a échoué (HTTP 503).');
});

test('an HTTP error made from a voice error carries its template, so the app can show it translated', async () => {
  const dir = tempDir();
  closers.push(dir.cleanup);
  const e = await thrown(() => downloadPinned('https://downloads.example.test/voice.tar', 'ab'.repeat(32), join(dir.dir, 'v.tar'), { fetch: (async () => new Response('', { status: 404 })) as typeof fetch }));
  const http = new HttpError(400, e.message);
  let body = '';
  const res = { writeHead: () => res, end: (s: string) => void (body = s) } as unknown as ServerResponse;
  send(res, http.status, { error: http.message });
  const data = JSON.parse(body) as { error: string; errorKey: string; params: Record<string, unknown> };
  assert.equal(data.error, 'Download failed (HTTP 404).');
  assert.equal(data.errorKey, 'Download failed (HTTP {status}).');
  assert.equal(tr(data.errorKey, 'it', data.params), 'Download non riuscito (HTTP 404).');
});

test('a failed voice install keeps the template on its job, so Settings shows the reason translated', async () => {
  const dir = tempDir();
  closers.push(dir.cleanup);
  startInstall(join(dir.dir, 'voice'), () => assert.fail('it must not finish'), { platform: 'win32', arch: 'x64', fetch: (async () => new Response('', { status: 502 })) as typeof fetch } as never);
  for (let i = 0; i < 200 && installJob()?.state === 'running'; i++) await new Promise((r) => setTimeout(r, 10));
  const j = installJob() as { state: string; error?: string; errorKey?: string; params?: Record<string, unknown> };
  assert.equal(j.state, 'failed');
  assert.equal(j.error, 'Download failed (HTTP 502).');
  assert.equal(j.errorKey, 'Download failed (HTTP {status}).');
  assert.equal(tr(j.errorKey!, 'es', j.params), 'La descarga falló (HTTP 502).');
});

test('a model server that cannot be reached says so in every language, with its name and address', async () => {
  // Port 9 on this computer: nothing listens there, so the connect fails at once.
  const e = await thrown(() => reach({ label: 'Garage PC' } as never, 'http://127.0.0.1:9/v1/chat/completions', { method: 'POST' }));
  assert.ok(e instanceof ProviderError, e.message);
  assert.equal(e.message, "Couldn't reach Garage PC at 127.0.0.1:9. Is that computer on and its model server running?");
  translatedEverywhere(e.message, ['Garage PC', '127.0.0.1:9']);
});

test('mail account errors read in every language', async () => {
  const { MailAccounts } = await import('../src/mail/accounts.ts');
  const { MicrosoftAuth } = await import('../src/mail/graph.ts');
  const { Vault } = await import('../src/vault.ts');
  const dir = tempDir();
  closers.push(dir.cleanup);
  const vault = new Vault(dir.dir);
  const ms = new MicrosoftAuth(vault, {});
  const m = new MailAccounts(vault, undefined, ms, { viewFile: join(dir.dir, 'mail-view.json') });
  const errors = [
    await thrown(() => m.resolve()),
    await thrown(() => m.imapDraft({ preset: 'other', address: 'not-an-address', password: 'abcd-efgh' })),
    await thrown(() => m.imapDraft({ preset: 'other', address: 'alex@example.test', password: '' })),
    await thrown(() => m.setDefault('nope')),
    await thrown(() => ms.setClient('not-an-id', 'x'.repeat(20))),
  ];
  for (const e of errors) translatedEverywhere(e.message);
  assert.equal(new Set(errors.map((e) => e.message)).size, 5);
});
