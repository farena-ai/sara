// Z2 (polish): one plain line from text with Markdown marks (web/markdown.js plainLine), for her day on Today.
import assert from 'node:assert/strict';
import test from 'node:test';
// @ts-expect-error a browser module without types
import { plainLine } from '../web/markdown.js';

test('Z2 plain line: the marks go, every word stays', () => {
  assert.equal(plainLine('Here is a short answer with a list:\n\n- one\n- two\n- three\n\nAnd a line of `code` to finish.'), 'Here is a short answer with a list: one two three And a line of code to finish.');
  assert.equal(plainLine('## My day\n**Coffee**, then a *long* walk.\n1. Emails\n2) Lunch'), 'My day Coffee, then a long walk. Emails Lunch');
  assert.equal(plainLine('> Quiet morning.\n\n```js\nconst x = 1;\n```'), 'Quiet morning. const x = 1;');
  assert.equal(plainLine('Went to the farmers\u2019 market; 2 * 3 = 6 and snake_case stay as they are.'), 'Went to the farmers\u2019 market; 2 * 3 = 6 and snake_case stay as they are.');
  assert.equal(plainLine('  Plain already.  '), 'Plain already.');
  assert.equal(plainLine(undefined), '');
});
