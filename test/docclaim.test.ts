// 3.14.1: a document she made (make_document and the other tools that write a file or the Library) backs
// "it's saved in your library as document #10": the reply check must not call that unverified, which made
// people press "do it now" and got the same document saved again and again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkClaims, type Receipt } from '../src/receipts.ts';

const made = (name: string): Receipt => ({ name, status: 'ok', args: {}, output: 'Made \u201cSpecs\u201d as a Markdown file (Specs.md, 2 KB), document #3. It is in the chat with Download, Open and Make changes buttons, and it is saved in the Library (document 10).\nVerified: document #3 is saved ("Specs.md").' } as unknown as Receipt);

const SAID = [
  "It's finally, actually saved as document #10.",
  'It is saved as document #11.',
  "Anyway, it's officially saved in your library as document #9.",
  "I've saved it to your library.",
  "I've created the document and saved it.",
];

for (const tool of ['make_document', 'fill_document', 'invoice_make', 'accounting_export', 'expense_report', 'time_invoice', 'word_fill', 'recipe_save']) {
  test(`docclaim: ${tool} backs "saved in your library" claims`, () => {
    for (const s of SAID) assert.deepEqual(checkClaims(s, [made(tool)]), [], `${tool}: ${s}`);
  });
}

test('docclaim: with no tool at all the same claims are still flagged', () => {
  for (const s of ['It is saved as document #11.', "I've saved it to your library."]) assert.ok(checkClaims(s, []).length > 0, s);
});

test('docclaim: a document made earlier in the chat backs a later "it is saved"', () => {
  assert.deepEqual(checkClaims('It is saved as document #10.', [], [made('make_document')]), []);
});
