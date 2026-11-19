// W1.5 (docs/HER_WEEK.md): "How am I doing?" in six languages. Dependency-free so chat.ts can check
// a message before it loads the check-in itself. Only the whole message counts (an optional
// "Sara," in front and punctuation around it): "how am I doing on my diet?" is a normal question.
const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’`´]/g, "'")
    .replace(/[¿¡?!.,;:…"“”«»()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const ASKS: readonly RegExp[] = [
  // English
  /^(so )?how am i doing( so far| this week)?$/,
  /^how are you doing for me( this week)?$/,
  /^how did you do( for me)? this week$/,
  /^(weekly )?check ?-?in$/,
  /^how('s| is) (it|she|sara) doing for me$/,
  // Spanish
  /^(como lo estoy haciendo|como voy|como lo estas haciendo( por mi)?|como te fue esta semana)$/,
  // French
  /^(comment je m'en sors|comment tu t'en sors( pour moi)?|comment ca se passe|ca se passe comment|comment s'est passee la semaine)$/,
  // German
  /^(wie mache ich mich|wie schlagst du dich( fur mich)?|wie lauft('s| es)|wie war die woche)$/,
  // Portuguese
  /^(como (e que )?estou indo|como voce esta indo( por mim)?|como foi a semana)$/,
  // Italian
  /^(come sto andando|come te la cavi( per me)?|come e andata la settimana)$/,
];

/** True when the whole message asks for the weekly check-in. */
export function asksHowAmIDoing(text: string, name?: string): boolean {
  if (typeof text !== 'string' || text.length > 80) return false;
  let s = fold(text);
  const n = name ? fold(name) : '';
  if (n && s.startsWith(`${n} `)) s = s.slice(n.length + 1).trim();
  if (n && s.endsWith(` ${n}`)) s = s.slice(0, -n.length - 1).trim();
  return ASKS.some((r) => r.test(s));
}
