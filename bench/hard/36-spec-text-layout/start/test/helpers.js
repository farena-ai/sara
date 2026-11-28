/** Joins lines into the text of one page (each line followed by "\n"). */
export function page(...lines) {
  return lines.map((l) => l + '\n').join('');
}
