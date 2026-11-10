// 3.3.0 easy mode (ezplain): the everyday words people type when they look for a setting ("bigger
// text", "how much does this cost", "delete a chat"). One list, read by the Settings search and Ctrl K
// (web/settings-search.js, web/app.js) and by her settings guide in the chat (src/settingsguide.ts),
// so "How do I…?" and the search box give the same first answer.
//
// An entry: { id, page | place, words, title, how }. `words` are phrases: a phrase matches when every
// one of its words is in the question (in any order; "bigger" also matches "big", "biggest"). The
// entry with the most matched words wins. `title` and `how` are English (the guide's answer; the app
// shows the page's own translated title). A page id here never takes over a page's own name: an
// exact page name or keyword still comes first (see rankPages).

export const EVERYDAY = [
  { id: 'text-size', page: 'you-appearance', title: 'Text size (Settings → You → Appearance)', how: 'Appearance → Text size in chat: Small, Normal, Large or Larger. Or just ask her: "make the text bigger".',
    words: ['bigger text', 'larger text', 'text bigger', 'text larger', 'big text', 'text size', 'font', 'zoom', 'letters small', 'small letters', 'bigger letters', 'larger letters', 'text small', 'small text', 'tiny text', 'hard to read', 'enlarge', 'magnify', 'read better',
      'letra grande', 'texto grande', 'tamano del texto', 'agrandar', 'texte plus grand', 'taille du texte', 'police', 'grossir', 'grossere schrift', 'schriftgrosse', 'schrift', 'texto maior', 'tamanho do texto', 'fonte', 'testo piu grande', 'dimensione del testo', 'carattere'] },
  { id: 'theme', page: 'you-appearance', title: 'Night or Day (Settings → You → Appearance)', how: 'Appearance → Night or Day (or Follow the system). Or ask her: "switch to dark mode".',
    words: ['dark mode', 'light mode', 'night mode', 'day mode', 'dark', 'too bright', 'theme', 'black background', 'white background', 'modo oscuro', 'mode sombre', 'dunkelmodus', 'dunkel', 'modo escuro', 'tema scuro'] },
  { id: 'color', page: 'you-appearance', title: 'Color (Settings → You → Appearance)', how: 'Appearance → Color: pick a dot. Or ask her: "change your color to green".',
    words: ['color', 'colour', 'colors', 'colours', 'pink', 'purple', 'green', 'blue', 'cambiar color', 'couleur', 'farbe', 'cor', 'colore'] },
  { id: 'voice', page: 'her-voice', title: 'Voice (Settings → Her → Voice)', how: 'The speaker button above the message box turns her spoken replies on or off; Settings → Her → Voice sets up how she sounds. Or ask her: "turn off your voice".',
    words: ['quiet', 'mute', 'silence', 'stop talking', 'voice off', 'turn off voice', 'turn off your voice', 'sound off', 'too loud', 'talk out loud', 'read aloud', 'silencio', 'silence', 'stumm', 'leise', 'silencioso', 'muto', 'silenzio'] },
  { id: 'delete-chat', place: 'howto:delete-chat', title: 'Delete a chat', how: 'In the list of chats on the left, point at the chat and press ⋯ (or press and hold it on a phone), then Delete. Deleted chats can\'t be brought back.',
    words: ['delete chat', 'delete conversation', 'remove chat', 'remove conversation', 'erase chat', 'erase conversation', 'get rid chat', 'clear chat', 'delete history', 'borrar chat', 'borrar conversacion', 'eliminar chat', 'supprimer conversation', 'supprimer chat', 'chat loschen', 'unterhaltung loschen', 'apagar conversa', 'excluir conversa', 'eliminare chat', 'cancellare chat'] },
  { id: 'cost', page: 'dh-usage', title: 'Usage and costs (Settings → Data & health)', how: 'Usage and costs shows what she spent today and this month, per model. A model on this computer costs nothing.',
    words: ['cost', 'costs', 'price', 'prices', 'bill', 'billing', 'spend', 'spent', 'spending', 'money', 'pay', 'paying', 'charge', 'charged', 'expensive', 'cheap', 'dollar', 'dollars', 'how much does', 'coste', 'cuesta', 'precio', 'dinero', 'gasto', 'cout', 'prix', 'argent', 'kosten', 'kostet', 'preis', 'geld', 'custo', 'preco', 'dinheiro', 'costo', 'prezzo', 'soldi'] },
  { id: 'language', page: 'you-about', title: 'Language (Settings → You → About you)', how: 'About you → Language: the app and her replies follow it.',
    words: ['language', 'english', 'spanish', 'french', 'german', 'italian', 'portuguese', 'translate', 'idioma', 'langue', 'sprache', 'lingua'] },
  { id: 'my-name', page: 'you-about', title: 'Your name (Settings → You → About you)', how: 'About you → Your name. Or ask her: "call me Pat".',
    words: ['my name', 'call me', 'what she calls me', 'mi nombre', 'mon nom', 'mein name', 'meu nome', 'il mio nome'] },
  { id: 'her-name', page: 'her-character', title: 'Her name (Settings → Her → Name and personality)', how: 'Name and personality → Name.',
    words: ['her name', 'rename her', 'change her name', 'su nombre', 'son nom', 'ihr name', 'nome dela', 'il suo nome'] },
  { id: 'password', page: 'dh-devices', title: 'Signing in (Settings → Connections → Devices and sign-in)', how: 'Devices and sign-in: add a phone or computer with a one-time code, or add a passkey.',
    words: ['password', 'sign in', 'log in', 'login', 'locked out', 'contrasena', 'mot de passe', 'passwort', 'senha', 'parola d ordine'] },
  { id: 'phone', page: 'co-phone', title: 'Phone and notifications (Settings → Connections)', how: 'Phone and notifications: get her on your phone and choose what she tells you about.',
    words: ['phone', 'mobile', 'cell', 'iphone', 'android', 'notification', 'notifications', 'telefono', 'movil', 'telephone', 'portable', 'handy', 'telefon', 'celular', 'cellulare'] },
  { id: 'email', page: 'ab-mail', title: 'Email and calendar (Settings → Add-ons)', how: 'Email and calendar: Add Gmail, Outlook or another provider (about 3 steps with an app password).',
    words: ['email', 'e mail', 'mail', 'gmail', 'inbox', 'correo', 'courriel', 'e-mail', 'posta'] },
  { id: 'backup', page: 'dh-backups', title: 'Backups (Settings → Data & health)', how: 'Backups: make a copy now, or have her keep one every day.',
    words: ['backup', 'back up', 'save a copy', 'keep a copy', 'copia de seguridad', 'sauvegarde', 'sicherung', 'copia di sicurezza'] },
  { id: 'update', page: 'dh-updates', title: 'Updates (Settings → Data & health)', how: 'Updates: see if a new Sara is ready and install it.',
    words: ['update', 'upgrade', 'new version', 'latest version', 'actualizar', 'actualizacion', 'mise a jour', 'aktualisieren', 'atualizar', 'aggiornare', 'aggiornamento'] },
];

const fold = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
/** "bigger" → "big", "letters" → "letter": enough to match the phrases above. */
const stem = (w) => w.replace(/(ies)$/, 'y').replace(/(ing|er|est|es|s)$/, '').replace(/(.)\1$/, '$1') || w;
const PREPARED = EVERYDAY.map((e) => ({ e, phrases: e.words.map((p) => fold(p).split(' ').filter(Boolean).map(stem)) }));

/** The everyday entries a question matches, best first (the most matched words, then list order). */
export function everydayMatches(question) {
  const q = new Set(fold(question).split(' ').filter(Boolean).map(stem));
  if (!q.size) return [];
  const hits = [];
  PREPARED.forEach(({ e, phrases }, i) => {
    let best = 0;
    for (const ws of phrases) if (ws.length && ws.every((w) => q.has(w))) best = Math.max(best, ws.length);
    if (best) hits.push({ e, best, i });
  });
  return hits.sort((a, b) => b.best - a.best || a.i - b.i).map((h) => h.e);
}
