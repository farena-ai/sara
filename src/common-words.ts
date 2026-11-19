// Common words in the app's six languages, shared by everything that matches a message on words:
// memory picks (memory-rank.ts queryWords → the FTS5 query), skill word search (skill-store.ts
// via ftsQuery), learned topics (learn.ts topicFits) and the title topic check (titles.ts).
// - STOP_SIX: function words and chat filler (moved here from titles.ts, unchanged).
// - COMMON_WORDS: STOP_SIX plus the very common verbs, numbers and turn words that matched
//   memories and a World of Warcraft topic skill in the owner's evidence ("need", "get",
//   "second", "said", "two", "see"). They never count as match words.
// - GENERIC: real content words that are too general to say what a note or topic is about
//   ("updated", "changes", "guide", "class"): a match on them alone is a weak one.
// Comparisons are on folded words (lower case, accents removed).

export function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

const set = (lists: string[]) => new Set(lists.join(' ').split(/\s+/).filter(Boolean).map(fold));

/** Function words and chat filler in en/es/fr/de/pt/it (the titles topic check's list). */
export const STOP_SIX = set([
  // en
  'the a an and or but if so of to in on at by for with from about into over after before is are was were be been being am do does did have has had i me my mine you your yours he him his she her it its we us our they them their this that these those what which who whom how why when where there here not no yes just very really also too can could would should will shall may might must get got make made like want need know think going go come let lets say said tell told talk chat thing things stuff something anything today tomorrow yesterday now then again more most some any all each other only well okay ok hey hi hello thanks thank please sure maybe still even much many one two',
  // es
  'el la los las un una unos unas y o pero si de del al a en con por para sobre es son era fue ser estar está están estoy eres soy yo tú tu te mi me mis nos nuestro su sus él ella ellos ellas esto eso este esta ese esa qué que quién cómo cuándo dónde no sí muy también ya hoy mañana ayer ahora luego más menos algo nada todo todos hola gracias vale bueno bien hacer tengo tienes tiene quiero puedo',
  // fr
  'le la les un une des et ou mais si de du au aux en dans sur avec pour par est sont était être avoir ai as a je tu il elle nous vous ils elles me te se mon ma mes ton ta tes son sa ses ce cet cette ces quoi que qui comment quand où non oui très aussi déjà aujourd hui demain hier maintenant plus moins rien tout tous bonjour salut merci bien faire veux peux',
  // de
  'der die das den dem des ein eine einen einem einer und oder aber wenn von zu im in an auf mit für über nach vor ist sind war waren sein bin bist hat habe haben ich du er sie es wir ihr mein meine dein deine sein seine unser was wer wie wann wo warum nicht nein ja sehr auch schon heute morgen gestern jetzt dann mehr weniger etwas nichts alles alle hallo danke gut machen will kann noch mal',
  // pt
  'o a os as um uma uns umas e ou mas se de do da dos das no na nos nas em com por para sobre é são era foi ser estar está estão estou sou eu tu você vocês ele ela eles elas me te meu minha seu sua nosso isso isto esse essa este esta que quem como quando onde não sim muito também já hoje amanhã ontem agora mais menos algo nada tudo todos oi olá obrigado obrigada bem fazer quero posso',
  // it
  'il lo la i gli le un uno una e o ma se di del della dei degli delle al alla a in con per su è sono era essere avere ho hai ha io tu lui lei noi voi loro mi ti ci mio mia tuo tua suo sua questo questa quello quella che chi come quando dove non no sì molto anche già oggi domani ieri adesso ora più meno qualcosa niente tutto tutti ciao grazie bene fare voglio posso',
]);

/** Extra common words: verbs, numbers, contractions and turn words (never match words). */
const EXTRA = set([
  // en (memory-rank's old list, then the very common verbs and words of a chat turn)
  'hers ours out such because yours with onto under than off between both few nor own same once while during above below whose myself yourself im ive id youre youve thats whats lets dont doesnt didnt cant cannot couldnt wont wouldnt shouldnt isnt arent wasnt werent hasnt havent hadnt remember',
  'needs needed needing gets getting gotten see sees seen saw seeing look looks looked looking says saying tells telling asks ask asked asking give gives gave given take takes took taken put puts went gone goes came comes coming want wants wanted try tries tried trying happen happens happened done doing makes making knows knew thinks thought keep keeps kept seem seems seemed',
  'way lot lots bit able ever every actually probably though although yet already else enough almost quite rather soon later ago around away back first second third three four five once twice another others instead without within anyway anymore sorry yeah yep nope hmm',
  // es
  'necesito necesitas necesita necesitamos ver veo vi visto dijo dije dijiste decir dime digo dar dame tener hay haber puede puedes podria quieres quiere hice hizo hecho voy vas va ir segundo segunda primero primera dos tres otra otro otros vez veces solo ahi aqui alli',
  // fr
  'besoin faut fallait voir vois vu dit dis dire donne donner fait fais avons avez ont vais va aller peut pouvez veut voulez deuxieme second seconde premier premiere deux trois autre autres fois juste ici voila',
  // de
  'brauche brauchst braucht brauchen muss musst muessen musste sehen sehe sieht gesehen gesagt sagen sag sagte gib geben gemacht mache macht gehe geht gehen hast hatte konnen kannst zweite zweiter zweites erste erster zwei drei andere anderen wieder hier nur bitte',
  // pt
  'preciso precisa precisamos precisar ver vejo vi visto disse dizer diz dar fiz feito vou vai ir pode pode podes tem temos segundo segunda primeiro primeira dois duas tres outra outro vez vezes so aqui ali',
  // it
  'bisogno serve devo deve dobbiamo vedere vedo visto vista detto dire dico dimmi dare fatto faccio vado va andare puoi puo vuoi vuole secondo seconda primo prima due tre altro altra altri volta volte solo qui li',
]);

export const COMMON_WORDS: ReadonlySet<string> = new Set([...STOP_SIX, ...EXTRA]);

/** Content words too general to say what something is about (a match on these alone is weak). */
const GENERIC = set([
  'read reads reading update updates updated updating change changes changed changing new newer newest latest news info information guide guides list lists check checked checking detail details specific general thing part parts step steps question questions answer answers help idea ideas plan plans note notes time times day days week weeks month months year years good best better great nice big small little long short last next old class classes type types kind sort place work works worked working stuff item items version proper real fine',
  'actualizar actualizado cambio cambios nuevo nueva guia lista dia semana mes ano',
  'mise jour changement changements nouveau nouvelle guide liste jour semaine mois annee',
  'aktualisiert aenderung aenderungen anderung anderungen neu neue neuer neues liste tag woche monat jahr',
  'atualizado atualizacao mudanca mudancas novo nova guia lista dia semana mes ano',
  'aggiornato aggiornamento cambio cambiamenti nuovo nuova guida lista giorno settimana mese anno',
]);

/** A word that never counts as a match word (folded compare). */
export const isCommonWord = (w: string): boolean => COMMON_WORDS.has(fold(w).replace(/['’]/g, ''));

/** A content word too general to carry a match alone (light plural/ed/ing forms included). */
export function isGenericWord(w: string): boolean {
  const f = fold(w).replace(/['’]/g, '');
  if (GENERIC.has(f) || COMMON_WORDS.has(f)) return true;
  for (const suf of ['ing', 'ed', 'es', 's', 'd']) if (f.length - suf.length >= 3 && f.endsWith(suf) && GENERIC.has(f.slice(0, -suf.length))) return true;
  return false;
}

/**
 * The distinctive words of a text for a topic check: folded, 4+ letters, not common, cut to
 * 5 letters (so "updates" ~ "updated" and plurals line up). Generic words are kept (callers ask
 * `isGenericWord` on the prefix map) but marked in the returned map's value.
 */
export function distinctWords(text: string): Map<string, { generic: boolean }> {
  const out = new Map<string, { generic: boolean }>();
  for (const raw of fold(text).match(/[\p{L}\d][\p{L}\d'’-]{3,}/gu) ?? []) {
    const w = raw.replace(/['’-]/g, '');
    if (w.length < 4 || COMMON_WORDS.has(w)) continue;
    const key = w.slice(0, 5);
    const generic = isGenericWord(w);
    const cur = out.get(key);
    out.set(key, { generic: cur ? cur.generic && generic : generic });
  }
  return out;
}
