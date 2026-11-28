import { charWidth } from './width.js';

/** R4 and R5: line breaks, tabs and orphan combining marks. */
export function normalizeText(text) {
  const unified = text.replace(/\r\n|\r/g, '\n').replace(/\t/g, ' ');
  let out = '';
  let previous = '';
  for (const ch of unified) {
    if (charWidth(ch.codePointAt(0)) === 0 && (previous === '' || previous === ' ' || previous === '\n')) continue;
    out += ch;
    previous = ch;
  }
  return out;
}

/** The words of one paragraph (R8). */
export function words(paragraph) {
  return paragraph.split(' ').filter((w) => w !== '');
}

/** The paragraphs of a text with their words joined by single spaces (R7, R8). */
export function paragraphs(text) {
  return normalizeText(text).split('\n').map((p) => words(p).join(' '));
}

/** All words of the text joined by single spaces (R12). */
export function flatten(text) {
  return normalizeText(text).split(/[ \n]/).filter((w) => w !== '').join(' ');
}
