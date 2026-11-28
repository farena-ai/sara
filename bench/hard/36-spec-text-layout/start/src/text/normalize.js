/** Unifies line breaks so that the rest of the library only sees "\n". */
export function normalizeText(text) {
  return text.replace(/\r\n/g, '\n');
}

/** The words of one paragraph. */
export function words(paragraph) {
  return paragraph.split(' ').filter((w) => w !== '');
}

/** The paragraphs of a text. */
export function paragraphs(text) {
  return normalizeText(text).split('\n');
}

/** The text on one line. */
export function flatten(text) {
  return normalizeText(text).replace(/\n/g, ' ');
}
