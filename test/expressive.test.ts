// R2d: expressive speech per voice engine. Each engine only gets the tags its provider documents;
// everything else falls back to plain words, and captions never show a tag.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTags, engineTags, forEngine, stripTags } from '../src/expressive.ts';
import { tagged } from '../src/speech.ts';

const LINE = "Haha, okay. *sighs* Honestly… I needed that. *whispers* Don't tell anyone.";
const TAG = /\[[a-z-]+\]|<\/?[a-z-]+>/i;

test('no tags for engine without sample', () => {
  const t = tagged(LINE, 'lively', { soft: true }, 'warm');
  assert.match(t, TAG, 'the tagged text has tags to strip');
  for (const [engine, model] of [['openai', 'gpt-4o-mini-tts'], ['local', ''], ['elevenlabs', 'eleven_multilingual_v2'], ['off', '']] as const) {
    assert.equal(engineTags(engine, model), undefined, engine);
    const out = forEngine(t, engine, model);
    assert.doesNotMatch(out, TAG, `${engine} gets plain words`);
    assert.match(out, /okay/);
    assert.match(out, /Don't tell anyone/);
  }
  // Grok voice keeps only the tags xAI documents (laugh-speak is not one of them).
  const grok = forEngine(`[laugh] <laugh-speak>so</laugh-speak> [sigh] <whisper>hi</whisper> [cry]`, 'xai');
  assert.equal(grok, '[laugh] so [sigh] <whisper>hi</whisper>');
  // ElevenLabs v3 gets its own audio-tag words.
  const el = forEngine(addTags('Haha. *sighs* *whispers* a secret.', 'lively'), 'elevenlabs', 'eleven_v3');
  assert.match(el, /\[laughs\]/);
  assert.match(el, /\[sighs\]/);
  assert.match(el, /\[whispers\] a secret/);
  assert.doesNotMatch(el, /<\/?[a-z-]+>|\[(?:laugh|sigh|pause|breath|chuckle)\]/);
});

test('captions stripped', () => {
  for (const [engine, model] of [['xai', ''], ['elevenlabs', 'eleven_v3']] as const) {
    const said = forEngine(tagged(LINE, 'lively', { soft: true }, 'warm'), engine, model);
    const caption = stripTags(said);
    assert.doesNotMatch(caption, TAG, engine);
    assert.doesNotMatch(caption, /\*|sighs\b|whispers\b/i, engine);
    assert.match(caption, /Don't tell anyone\./);
  }
});
