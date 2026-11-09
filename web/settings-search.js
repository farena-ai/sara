// Phase 128 (PL2b, docs/design/POLISH2.md §2.5 N30): the Settings search index, shared by the
// Settings window and Ctrl+K. Pure functions over plain page records, so test/phase128b.test.ts runs
// the same ranking in Node.
//
// A page record: { id, title, group, was, keywords, questions, head, body } (all text already folded
// with foldText). Ranking, best first: the page's name (title, group, its old group, its keywords and
// synonyms) → one of its "How do I…?" questions → its labels and tips → its text. *Elsewhere* lists
// the places outside Settings (Planner tabs, chat commands) that match.

export const foldText = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * Extra words people type for a page (English; titles and labels are matched in the app's language
 * too). Arrays, not sentences: these are search words, never shown.
 */
export const SETTINGS_KEYWORDS = {
  'dh-operations': ['monitoring', 'metrics', 'prometheus', 'grafana', 'opentelemetry', 'otel', 'otlp', 'traces', 'tracing', 'scrape', 'secret sources', 'secrets', 'hashicorp vault', 'openbao', '1password', 'keychain', 'environment variable'],
  'dh-recovery': ['readiness', 'ready', 'restore drill', 'drill', 'disaster', 'recovery', 'restart', 'interrupted', 'resume', 'outbox', 'delivery', 'unknown', 'held'],
  'dh-backups': ['backup', 'backups', 'restore', 'restore backup', 'keep a copy'],
  'her-character': ['personality', 'dials', 'sliders', 'name', 'character', 'archetype'],
  'her-hey': ['hey sara', 'wake word', 'wakeword', 'push to talk', 'push-to-talk', 'talk tile', 'hands free', 'hotword'],
  'her-voice': ['voice', 'voice notes', 'tts', 'speech', 'local voice', 'kokoro', 'piper', 'hearing'],
  'her-companions': ['companion packs', 'pack', 'packs', 'share her', 'character card', 'charx', 'tavern', 'store companions'],
  'her-import': ['character card', 'import her', 'bring her'],
  'you-about': ['use path', 'company or coding', 'language', 'time zone'],
  'you-appearance': ['appearance', 'theme', 'palette', 'dark mode', 'light mode', 'night', 'day', 'colour', 'color', 'accent', 'high contrast', 'classic', 'compact', 'density', 'font size', 'portrait', 'decoration', 'glass', 'glow', 'blur', 'text size', 'sessions shown', 'reset look', 'look and feel'],
  'ab-when': ['when it comes up', 'mention', 'mentions', 'person comes up', 'remind me when'],
  'models-default': ['connect model', 'connect an ai model', 'compact', 'tidy long chats', 'long conversations', 'summary', 'context'],
  'co-telegram': ['botfather', 'bot token', 'chat app', 'chat apps', 'progress message', 'voice notes'],
  'co-discord': ['bot token', 'server', 'chat app', 'chat apps', 'progress message'],
  'co-signal': ['signal-cli', 'chat app', 'chat apps', 'daemon', 'link qr'],
  'co-email': ['mail', 'smtp', 'chat app', 'chat apps', 'email her', 'write to her'],
  // M1: every mailbox provider finds Email and calendar (Ctrl+K uses the same index).
  'ab-mail': ['outlook', 'outlook.com', 'hotmail', 'live.com', 'msn', 'microsoft 365', 'office 365', 'exchange', 'outlook calendar', 'yahoo', 'yahoo mail', 'aol', 'icloud', 'icloud mail', 'fastmail', 'zoho', 'gmx', 'web.de', 'proton', 'proton mail', 'proton bridge', 'imap', 'app password', 'email account', 'email accounts', 'mail account', 'mailbox', 'mailboxes', 'add email', 'other email', 'default mailbox', 'inbox'],
  'co-whatsapp': ['meta', 'cloud api', 'tailscale', 'funnel', 'public address', 'chat app', 'chat apps', 'webhook'],
  'co-teams': ['teams', 'microsoft teams', 'azure bot', 'bot framework', 'microsoft 365'],
  'co-matrix': ['element', 'homeserver', 'tailscale', 'funnel', 'chat app', 'chat apps'],
  'co-imessage': ['bluebubbles', 'apple', 'imessages', 'chat app', 'chat apps', 'mac'],
  'co-pickup': ['continue', 'pick up', 'pickup', 'other app', 'carry on', 'switch apps'],
  'ab-store': ['store', 'sara store', 'add-on store', 'addon store', 'shop', 'get more', 'add-ons', 'addons', 'takedown', 'pulled', 'submit yours', 'my add-ons', 'tool servers', 'marketplace'],
  'ab-library': ['documents', 'document', 'pdf', 'files she knows', 'knowledge'],
  'ab-projects': ['projects', 'project', 'workspace', 'workspaces', 'repository'],
  'ab-skills': ['recipes', 'skill', 'skills', 'learned skills'],
  'ab-plugins': ['plugin', 'plugins', 'sdk', 'comes with sara'],
  'ab-mcp': ['mcp', 'tool server', 'tool servers', 'model context protocol'],
  'ab-precise': ['@', '@file', '@folder', '@diff', '@url', 'mention a file', 'reference', 'references', 'refs', 'attach a file', 'type errors', 'problems', 'lint', 'type checker'],
  'ab-persist': ['goal', 'goals', 'loop', 'loops', 'repeat', 'repeats', 'keep going', 'done when', 'until tests pass', 'stuck'],
  'ab-tools': ['approvals', 'ask me first', 'permissions', 'short tool list', 'lean', 'sandbox', 'tools'],
  'ab-budgets': ['budget', 'tokens', 'spending', 'cost limit'],
  'ab-ssh': ['ssh', 'server', 'servers', 'cpanel', 'deploy', 'host key'],
  'dh-safety': ['safety', 'check-up', 'checkup', 'security check'],
  'dh-usage-report': ['usage report', 'cost report', 'spending per person', 'csv export', 'monthly budget', 'budget alert'],
  'dh-trust': ['trust report', 'what she claimed', 'receipts', 'claims', 'failed tools', 'reviewer', 'export pdf'],
  'dh-shares': ['share', 'share link', 'shared links', 'revoke link', 'public link'],
  'dh-audit': ['audit', 'audit log', 'audit trail', 'who changed', 'export log', 'compliance'],
  'her-work': ['at work', 'work profile', 'work mode', 'work memory', 'office', 'colleagues', 'workplace', 'professional tone'],
  'dh-retention': ['retention', 'legal hold', 'litigation hold', 'delete my data', 'export person', 'gdpr', 'data deletion', 'keep chats'],
  'dh-policy': ['policy', 'admin', 'pinned', 'managed settings', 'lock settings'],
  'dh-privacy': ['privacy', 'store data', 'what leaves'],
  'dh-reports': ['report', 'bug', 'idea', 'takedown', 'report an add-on'],
  // 3.0.3: where a new phone or computer gets its sign-in code. Words in all six app languages (the
  // titles and labels are matched in the app's language already; these are what people type instead).
  'dh-devices': ['code', 'sign-in code', 'pairing', 'pair', 'pair a device', 'add device', 'add a device', 'add computer', 'add phone', 'add a phone or computer', 'new device', 'sign in another device', 'another device', 'desktop apps', 'qr', 'qr code', 'passkey', 'two-step',
    'codigo', 'emparejar', 'vincular', 'anadir dispositivo', 'otro dispositivo', 'jumeler', 'appairer', 'ajouter un appareil', 'autre appareil', 'koppeln', 'gerat hinzufugen', 'anderes gerat', 'codice', 'associa', 'abbina', 'aggiungi dispositivo', 'altro dispositivo', 'parear', 'emparelhar', 'adicionar dispositivo', 'outro dispositivo'],
  'co-phone': ['notifications', 'push', 'phone app', 'android', 'iphone', 'talk tile'],
  'desktop-app': ['windows app', 'desktop app', 'mac app', 'tray', 'shortcut'],
};

/**
 * Places outside Settings. `open` is handled by the app (planner:<tab> or command:<name>). Commands
 * come from the `/` menu's own list (GET /api/chat-menu), so the words stay with the commands.
 */
export const ELSEWHERE = [
  { id: 'planner:routines', label: ['Planner', 'Routines'], words: ['routine', 'routines', 'bedtime', 'morning routine', 'weekly review routine', 'gallery', 'watch a file', 'watch log', 'log alert', 'file alert', 'error alert'] },
  { id: 'planner:repeats', label: ['Planner', 'Repeats'], words: ['repeats', 'repeat', 'loop', 'loops', 'every 10 minutes'] },
  { id: 'planner:reminders', label: ['Planner', 'Reminders'], words: ['reminder', 'reminders', 'remind me', 'when it comes up', 'places'] },
  { id: 'planner:todos', label: ['Planner', 'To-dos'], words: ['to-do', 'todo', 'todos', 'task list'] },
];
/** Extra words for chat commands (the name and its own line are searched too). */
export const COMMAND_WORDS = {
  compact: ['compact', 'tidy', 'tidy this chat', 'summary', 'shorten'],
  goal: ['goal', 'keep going', 'until done', 'done when'],
  loop: ['loop', 'repeat', 'every'],
  btw: ['btw', 'side question', 'by the way'],
  steer: ['steer', 'tell her now'],
  queue: ['queue', 'after this'],
  when: ['when it comes up'],
  continue: ['continue', 'pick up'],
  tools: ['tools', 'tool list'],
  problems: ['problems', 'type errors'],
};

/** The search words: single letters drop out, except @, / and digits. */
export function searchWords(q) {
  const words = foldText(q).split(/\s+/).filter((w) => w.length > 1 || /[\d@/]/.test(w));
  // "backups" also finds "backup", "emails" finds "email".
  return words.map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w));
}

const nameText = (p) => [p.title, p.group, p.was ?? '', ...(p.keywords ?? [])].join(' | ');

/**
 * Ranked pages. Tiers: 1 name, 2 a How do I…? question, 3 labels and tips (every word). When none of
 * those has a hit: labels with any word, then the text with every word, then any word.
 */
export function rankPages(q, pages) {
  const stems = searchWords(q);
  if (!stems.length) return [];
  const all = (s) => stems.every((w) => s.includes(w));
  const any = (s) => stems.some((w) => s.includes(w));
  const phrase = foldText(q).trim();
  const tierOf = (p) => {
    const name = nameText(p);
    if (all(name) || (phrase && (p.keywords ?? []).includes(phrase))) return 1;
    if ((p.questions ?? []).some(all)) return 2;
    if (all(p.head ?? '')) return 3;
    return 0;
  };
  const scored = pages.map((p, i) => ({ p, i, tier: tierOf(p), exact: foldText(p.title) === phrase || (p.keywords ?? []).includes(phrase) }));
  const strong = scored.filter((x) => x.tier).sort((a, b) => a.tier - b.tier || Number(b.exact) - Number(a.exact) || a.i - b.i);
  if (strong.length) return strong.map((x) => x.p);
  for (const ok of [(p) => any(p.head ?? ''), (p) => all(p.body ?? ''), (p) => any(p.body ?? '')]) {
    const hits = pages.filter(ok);
    if (hits.length) return hits;
  }
  return [];
}

/**
 * The places outside Settings that match: [{ id, label (array of words for t()), detail? }].
 * `commands`: the / menu list ([{ name, line }]) when it is known.
 */
export function rankElsewhere(q, commands = []) {
  const phrase = foldText(q).trim().replace(/^\//, '');
  const stems = searchWords(phrase);
  if (!stems.length) return [];
  const all = (s) => stems.every((w) => s.includes(w));
  const out = [];
  for (const e of ELSEWHERE) if (e.words.some((w) => all(foldText(w))) || all(foldText(e.label[1]))) out.push({ id: e.id, label: e.label });
  for (const c of commands) {
    const words = [c.name, ...(COMMAND_WORDS[c.name] ?? [])].map(foldText);
    // A command name matches from 3 letters (\"/com\" → /compact); its extra words as a whole.
    const hit = (phrase.length >= 3 && foldText(c.name).startsWith(phrase)) || words.some((w) => w === phrase || (phrase.length >= 4 && w.startsWith(phrase)));
    if (hit) out.push({ id: `command:${c.name}`, label: [`/${c.name}`], detail: c.line });
  }
  return out;
}
