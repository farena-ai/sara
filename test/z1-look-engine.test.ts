// Z1: her look is made with the picture engine the person picked (Settings → Pictures from her →
// Picture engine), not with Grok only. Owner (2026-11-23): the image tool "needs to be selectable by
// the user in their harness ... OpenAI, Grok, ComfyUI, etc."
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { LookBuilder } from '../src/look.ts';
import { lookTextEngine } from '../src/photos.ts';
import { tempDir } from './helpers.ts';

const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(tag)]);
const settings = (photos: Record<string, unknown>) => ({ get: () => ({ photos }) }) as never;

test('Z1 look: with another engine picked, the portrait comes from it and no Grok key is needed', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const prompts: string[] = [];
  let grokCalls = 0;
  const look = new LookBuilder({
    dataDir: dir,
    key: async () => undefined, // no xAI key, no Grok sign-in
    fetch: (async () => {
      grokCalls++;
      return new Response('{}', { status: 500 });
    }) as never,
    textEngine: () => ({
      label: 'ComfyUI',
      make: async (prompt: string) => {
        prompts.push(prompt);
        return png('comfy');
      },
    }),
  });
  await assert.rejects(look.draft('a 16 years old girl', 'photo'), /adult/, 'the adult rule comes first, whatever the engine');
  await look.draft('a woman in her 30s with red hair', 'photo');
  assert.equal(look.status.state, 'draft-ready');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /Head-and-shoulders portrait of a woman in her 30s with red hair\. An adult\./);
  assert.equal(grokCalls, 0, 'Grok is never called');
  // Accepting it: the look is that one portrait (an engine that draws from words can't keep her face for other expressions).
  await look.build(look.draftBytes()!);
  assert.equal(look.status.state, 'done');
  assert.equal(look.status.total, 1);
  assert.equal(readFileSync(look.fileFor('sara-portrait.jpg')!).subarray(4).toString(), 'comfy');
  assert.ok(existsSync(join(dir, 'look', 'sara-avatar.jpg')));
  assert.equal(look.missing('sara/frames/happy-talk.jpg'), true, 'no expression frames: the app shows the one picture');
  assert.equal(grokCalls, 0);
  // One change that keeps her face (an outfit) says plainly why not, and what to do.
  await assert.rejects(look.outfit(readFileSync(look.fileFor('sara-portrait.jpg')!), 'a red dress'), /ComfyUI makes a picture from words only[\s\S]*Grok Imagine/);
});

test('Z1 look: Grok Imagine stays as it was when it is the engine', async (t) => {
  const { dir, cleanup } = tempDir();
  t.after(cleanup);
  const paths: string[] = [];
  const look = new LookBuilder({
    dataDir: dir,
    key: async () => 'tok',
    fetch: (async (url: string) => {
      paths.push(new URL(url).pathname);
      return new Response(JSON.stringify({ data: [{ b64_json: png('grok').toString('base64') }] }));
    }) as never,
    textEngine: () => undefined,
  });
  await look.draft('a man in his 40s', 'photo');
  assert.deepEqual(paths, ['/v1/images/generations']);
});

test('Z1 look: which engine the setting gives', async () => {
  assert.equal(lookTextEngine({ settings: settings({}) }), undefined, 'nothing picked: Grok Imagine');
  assert.equal(lookTextEngine({ settings: settings({ engine: 'grok' }) }), undefined);
  const openai = lookTextEngine({ settings: settings({ engine: 'openai' }), engines: { openaiKey: () => undefined } })!;
  assert.equal(openai.label, 'OpenAI images');
  await assert.rejects(openai.make('a portrait'), /OpenAI/i, 'no key: it says so instead of falling back to another service');
  const comfy = lookTextEngine({ settings: settings({ engine: 'comfyui' }), engines: {} })!;
  assert.equal(comfy.label, 'ComfyUI');
  await assert.rejects(comfy.make('a portrait'), /Pick a ComfyUI workflow/);
  await assert.rejects(lookTextEngine({ settings: settings({ engine: 'tool' }), engines: {} })!.make('x'), /Pick an image tool/);
});
