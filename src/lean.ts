// Phase 123 part A (docs/design/LEAN.md §3.1 L1–L5, §4): a lean tool list per turn.
//
// The turn's gates in chat.ts decide which tools are ELIGIBLE (what she may use; the run gate keeps
// checking that list, so permissions, cards, the sandbox gate, unattended rules and the loop guard
// are unchanged). This file decides, by code only and never with a model call, which eligible tools
// are OFFERED as schemas: the core for the mode, the safety-pinned tools, his pins, what his message
// names (six languages), @-references, what was used lately in this chat, a loaded skill's tools and a
// goal's earlier rounds. One ordinary tool, `find_tools`, loads up to five more for her next step.
// Lean narrows what is sent; it never removes a tool and never widens the eligible list.
import type { AppContext } from './chat.ts';
import type { Conversation } from './store.ts';
import type { Tool } from './tools/types.ts';
import type { ToolSpec } from './providers/types.ts';
import type { DatabaseSync } from 'node:sqlite';
import { checkpointAllowed } from './project-checkpoints.ts';
import { continuityAllowed, continuityForTurn } from './session-continuity.ts';
import { SESSION_TOOLS } from './session-continuity-tools.ts';
import { SCENE_CANON_TOOL } from './shared-scenes-tools.ts';
import { sceneCanonPreview } from './shared-scenes-policy.ts';
import { policy } from './policy-profile.ts';

// ---------------------------------------------------------------------------------------------
// Settings (owner-only; `lean` in OWNER_SETTINGS), §3.3
// ---------------------------------------------------------------------------------------------

export interface LeanSettings {
  tools: { mode: 'auto' | 'always' | 'off'; aboveTokens: number; pins: string[]; stickyTurns: number; maxLoaded: number; perFind: number; findsPerTurn: number; localCore: boolean; codeMode: boolean };
  compact: { auto: boolean; at: number; keepTurns: number; model: 'auto' | 'local' | 'quick' | 'plain'; dailyCap: { runs: number; tokens: number }; crisisKeepHours: number; partners: boolean };
}

export const LEAN_CHOICES = {
  mode: ['auto', 'always', 'off'],
  aboveTokens: [3_000, 6_000, 12_000],
  stickyTurns: [5, 10, 20],
  maxLoaded: [10, 20, 40],
  perFind: [3, 5, 8],
  findsPerTurn: [2, 4, 6],
  at: [0.75, 0.85, 0.95],
  keepTurns: [3, 6, 10],
  model: ['auto', 'local', 'quick', 'plain'],
  runs: [20, 40, 100],
  tokens: [200_000, 500_000, 1_000_000],
  crisisKeepHours: [24, 72],
} as const;

export const DEFAULT_LEAN: LeanSettings = {
  tools: { mode: 'auto', aboveTokens: 6_000, pins: [], stickyTurns: 10, maxLoaded: 20, perFind: 5, findsPerTurn: 4, localCore: true, codeMode: false },
  compact: { auto: true, at: 0.85, keepTurns: 6, model: 'auto', dailyCap: { runs: 40, tokens: 500_000 }, crisisKeepHours: 24, partners: false },
};

const pick = <T>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** The owner's lean settings, every number on its list (unknown keys left out). */
export function normLean(raw: unknown, base: LeanSettings = DEFAULT_LEAN): LeanSettings {
  const r = rec(raw);
  const t = rec(r.tools);
  const c = rec(r.compact);
  const cap = rec(c.dailyCap);
  const b = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
  return {
    tools: {
      mode: pick(t.mode, LEAN_CHOICES.mode, base.tools.mode),
      aboveTokens: pick(t.aboveTokens, LEAN_CHOICES.aboveTokens, base.tools.aboveTokens as 6000),
      pins: Array.isArray(t.pins) ? [...new Set(t.pins.map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 60) : base.tools.pins,
      stickyTurns: pick(t.stickyTurns, LEAN_CHOICES.stickyTurns, base.tools.stickyTurns as 10),
      maxLoaded: pick(t.maxLoaded, LEAN_CHOICES.maxLoaded, base.tools.maxLoaded as 20),
      perFind: pick(t.perFind, LEAN_CHOICES.perFind, base.tools.perFind as 5),
      findsPerTurn: pick(t.findsPerTurn, LEAN_CHOICES.findsPerTurn, base.tools.findsPerTurn as 4),
      localCore: b(t.localCore, base.tools.localCore),
      // EC21: code mode (run_code), off unless the owner turns it on.
      codeMode: b(t.codeMode, base.tools.codeMode),
    },
    compact: {
      auto: b(c.auto, base.compact.auto),
      at: pick(c.at, LEAN_CHOICES.at, base.compact.at as 0.85),
      keepTurns: pick(c.keepTurns, LEAN_CHOICES.keepTurns, base.compact.keepTurns as 6),
      model: pick(c.model, LEAN_CHOICES.model, base.compact.model),
      dailyCap: { runs: pick(cap.runs, LEAN_CHOICES.runs, base.compact.dailyCap.runs as 40), tokens: pick(cap.tokens, LEAN_CHOICES.tokens, base.compact.dailyCap.tokens as 500_000) },
      crisisKeepHours: pick(c.crisisKeepHours, LEAN_CHOICES.crisisKeepHours, base.compact.crisisKeepHours as 24),
      partners: false, // §11 Q7: no folds in partner chats in 2.56
    },
  };
}

export function leanSettings(app: AppContext): LeanSettings {
  try {
    return normLean((app.settings.get() as { lean?: unknown }).lean);
  } catch {
    return DEFAULT_LEAN;
  }
}

/** PUT /api/lean: merged over the current settings; pins kept only when they name a tool or a family that exists. */
export function mergeLean(app: AppContext, body: unknown): LeanSettings {
  const cur = leanSettings(app);
  const b = rec(body);
  const next = normLean({ tools: { ...cur.tools, ...rec(b.tools) }, compact: { ...cur.compact, ...rec(b.compact), dailyCap: { ...cur.compact.dailyCap, ...rec(rec(b.compact).dailyCap) } } }, cur);
  const known = new Set<string>();
  for (const t of app.tools.list()) {
    known.add(t.spec.name);
    known.add(familyOf(t).id);
  }
  next.tools.pins = next.tools.pins.filter((p) => known.has(p));
  // EC5/EC21: the policy pin `codeMode: false` refuses turning code mode on (server side).
  if (rec(b.tools).codeMode === true) policy().guard('codeMode', true);
  if (!policy().codeModeOn) next.tools.codeMode = false;
  app.settings.update({ lean: next } as never);
  return next;
}

// ---------------------------------------------------------------------------------------------
// L1 · families and sizes
// ---------------------------------------------------------------------------------------------

export type FamilyKind = 'core' | 'cold' | 'mcp' | 'plugin' | 'a2a';
export interface Family {
  id: string;
  label: string;
  kind: FamilyKind;
}

/** Built-in families by name prefix (a tool may set `family` itself; this is the fallback). */
const PREFIX_FAMILIES: [RegExp, string, string][] = [
  [/^(list_dir|read_file|write_file|edit_file|search)$/, 'files', 'files'],
  [/^shell$/, 'shell', 'commands'],
  [/^(web_fetch|web_search|research_start)$/, 'web', 'web'],
  [/^(todo|note|remind|tasks|add_task|list_tasks|complete_task|update_task|delete_task|add_note|list_notes|read_note|update_note|delete_note)$/, 'planner', 'reminders and notes'],
  [/^(recall|search_memory|remember_fact|list_facts|scrapbook|moments|session_context|session_handoff|scene_canon)$/, 'memory', 'memory'],
  [/^ssh_/, 'ssh', 'SSH servers'],
  [/^code_/, 'code', 'code map'],
  [/^(skill_|recipe_)/, 'skills', 'skills and recipes'],
  [/^(person_|people_)/, 'people', 'people'],
  [/^(start_job|stop_job|job_status|delegate_task)$/, 'jobs', 'background jobs'],
  [/^git(_|$)/, 'git', 'git'],
  [/^preview_/, 'preview', 'preview'],
  [/^browser_/, 'browser', 'testing browser'],
  [/^pc_/, 'computer', 'your computer'],
  [/^phone_(camera|location|screen)$/, 'phone', 'your phone'],
  [/^team/, 'team', 'team'],
  [/^(board_|card_)/, 'board', 'board'],
  [/^(gmail_|mail_|calendar_|calendar$)/, 'google', 'Email and calendar'],
  [/^(github_|work_on_issue$)/, 'github', 'GitHub (built-in)'],
  [/^home_/, 'home', 'Home Assistant'],
  [/^(share_photo|take_photo|change_outfit)$/, 'photos', 'photos'],
  [/^tune_personality$/, 'personality', 'personality'],
  [/^(review_code|redteam_)/, 'review', 'code review'],
  [/^(starter_create|project_note)$/, 'starter', 'starters'],
  [/^shared_list$/, 'shared', 'shared lists'],
  [/^(safety_report|suggest_routine)$/, 'safety', 'safety'],
  [/^(settings_guide|find_tools)$/, 'help', 'help'],
  [/^change_setting$/, 'settings', 'everyday settings'],
  [/^(agenda_)/, 'agenda', 'plans'],
  [/^(library|search_library)$/, 'library', 'library'],
  [/^send_file$/, 'files-out', 'send a file'],
  [/^make_document$/, 'documents', 'make documents'],
];

const MCP_LABELS: Record<string, string> = { github: 'GitHub', playwright: 'Playwright browser', filesystem: 'files server', files: 'files server', memory: 'memory server', fetch: 'fetch server', everything: 'test server' };

export function familyOf(tool: Pick<Tool, 'spec' | 'source'> & { family?: string }): Family {
  const name = tool.spec.name;
  const src = tool.source ?? '';
  if (src.startsWith('MCP: ') || name.startsWith('mcp_')) {
    const server = src.startsWith('MCP: ') ? src.slice(5).trim() : (name.split('_')[1] ?? 'mcp');
    return { id: `mcp:${server}`, label: MCP_LABELS[server.toLowerCase()] ?? server, kind: 'mcp' };
  }
  if (src.startsWith('Plugin: ')) {
    const p = src.slice(8).trim();
    return { id: `plugin:${p}`, label: p, kind: 'plugin' };
  }
  if (name.startsWith('a2a_')) return { id: 'a2a', label: 'other agents', kind: 'a2a' };
  if (tool.family) return { id: tool.family, label: tool.family, kind: 'cold' };
  for (const [re, id, label] of PREFIX_FAMILIES) if (re.test(name)) return { id, label, kind: 'cold' };
  return { id: name, label: name.replace(/_/g, ' '), kind: 'cold' };
}

const sizeCache = new Map<string, number>();
/** Estimated tokens of a tool's schema: ceil(JSON chars / 4) (Sara's unit; no tokenizer). */
export function specTokens(tool: { spec: ToolSpec }): number {
  const json = JSON.stringify(tool.spec);
  const key = `${tool.spec.name}\u0000${json.length}`;
  let n = sizeCache.get(key);
  if (n === undefined) {
    n = Math.ceil(json.length / 4);
    if (sizeCache.size > 5000) sizeCache.clear();
    sizeCache.set(key, n);
  }
  return n;
}
/** McpManager.start: a server's list changed. */
export function clearSizes(prefix?: string): void {
  if (!prefix) return sizeCache.clear();
  for (const k of sizeCache.keys()) if (k.startsWith(prefix)) sizeCache.delete(k);
}
export const tokensOf = (tools: { spec: ToolSpec }[]): number => tools.reduce((n, t) => n + specTokens(t), 0);

// ---------------------------------------------------------------------------------------------
// §4.2 core, safety pins
// ---------------------------------------------------------------------------------------------

export const CORE_CHAT = ['todo', 'note', 'remind', 'recall', 'session_context', 'library', 'send_file', 'make_document', 'share_photo', 'person_lookup', 'skill_use', 'settings_guide', 'web_fetch', 'web_search', 'research_start'] as const;
export const CORE_CODING = ['list_dir', 'read_file', 'write_file', 'edit_file', 'search', 'shell', 'code_map', 'code_find', 'code_refs', 'git', 'git_commit', 'start_job', 'web_fetch', 'skill_use', 'todo', 'remind', 'session_context'] as const;
/** Tools whose absence could leave something running or reachable: always offered when eligible. */
export const SAFETY_PINS = ['stop_job', 'job_status', 'preview_stop', 'ssh_revoke_key', 'ssh_forget_password', 'safety_report'] as const;
const SAFETY_SET = new Set<string>(SAFETY_PINS);
/** Families offered whole once any working tool of theirs is offered (never half a remote session). */
const WHOLE_FAMILIES = new Set(['ssh', 'computer']);
export const FIND_TOOLS = 'find_tools';
/**
 * 3.6.x (do it for them): a doing word (remove, uninstall, clean, fix, delete, disable…) about something on the
 * computer (an extension, an app, startup, files, the browser…) or about a check-up suggestion (\"#3\", \"s2\") loads
 * her computer tools, so the desktop actions and approved commands are there to do it. Six languages, folded.
 */
export const DO_WORDS = /\b(?:remove|uninstall|clean|cleanup|clear|fix|delete|disable|turn off|switch off|get rid of|speed up|take care of|quitar|eliminar|desinstalar|limpiar|borrar|arreglar|desactivar|supprimer|desinstaller|nettoyer|effacer|reparer|desactiver|entfernen|deinstallieren|bereinigen|loschen|reparieren|deaktivieren|remover|limpar|apagar|consertar|rimuovere|disinstallare|pulire|cancellare|riparare|disattivare)\b/;
export const PC_THINGS = /\b(?:uninstall|desinstalar|desinstaller|deinstallieren|disinstallare|extensions?|add ?ons?|startup|startup apps|temp|temporary files|cache|browser|computer|pc|laptop|disk|disk space|downloads|recycle bin|trash|updates?|edge|chrome|firefox|brave|toolbar|antivirus|bloatware|webadvisor|extension(?:es)?|extensao|extensoes|estension[ei]|erweiterung(?:en)?|navegador|navigateur|ordinateur|ordenador|rechner|computador|descargas|telechargements|papelera|corbeille|papierkorb|lixeira|cestino|demarrage|autostart|inicio)\b/;
export const CHECKUP_REF = /#\s?\d{1,2}\b|\bs\d{1,2}\b|\b(?:number|suggestion|numero|nummer|vorschlag|sugerencia|suggestion|sugestao|suggerimento) \d{1,2}\b/i;

// ---------------------------------------------------------------------------------------------
// §4.4 words in six languages (folded, no accents)
// ---------------------------------------------------------------------------------------------

export const FAMILY_WORDS: Readonly<Record<string, readonly string[]>> = {
  github: ['github', 'issue', 'issues', 'pull request', 'pull requests', 'repo', 'repository', 'repositorio', 'depot', 'depot git', 'demande de tirage', 'ticket', 'probleme github', 'incidencia', 'solicitud de extraccion', 'problema', 'repositorium', 'repository', 'pr'],
  browser: ['browser', 'click', 'screenshot', 'web page', 'navegador', 'clic', 'captura', 'navigateur', 'cliquer', 'capture d ecran', 'klicken', 'bildschirmfoto', 'navegador', 'clicar', 'captura de tela', 'clicca', 'schermata', 'pagina web', 'webseite'],
  ssh: ['ssh', 'server', 'servers', 'servidor', 'servidores', 'serveur', 'serveurs', 'servidor', 'server remoto'],
  board: ['board', 'card', 'cards', 'kanban', 'tablero', 'tarjeta', 'tableau', 'carte', 'tafel', 'karte', 'quadro', 'cartao', 'bacheca', 'scheda'],
  google: ['email', 'emails', 'gmail', 'calendar', 'inbox', 'correo', 'calendario', 'courriel', 'calendrier', 'agenda google', 'outlook', 'hotmail', 'yahoo', 'icloud', 'e mail', 'kalender', 'posteingang', 'caixa de entrada', 'posta'],
  home: ['home assistant', 'lights', 'light', 'thermostat', 'luces', 'lumiere', 'lumieres', 'licht', 'lichter', 'luzes', 'luci', 'termostato'],
  // "look at my browser tabs" means the owner's own computer (computer use), not her testing browser on the server.
  computer: ['my computer', 'my pc', 'desktop', 'mi ordenador', 'mi computadora', 'mon ordinateur', 'mein computer', 'meu computador', 'il mio computer', 'computer use', 'my laptop', 'my mac', 'my screen', 'my browser', 'my tabs', 'browser tabs', 'open tabs', 'my windows', 'mi navegador', 'mis pestanas', 'mi pantalla', 'mon navigateur', 'mes onglets', 'mon ecran', 'mein browser', 'meine tabs', 'mein bildschirm', 'meu navegador', 'minhas abas', 'minha tela', 'il mio browser', 'le mie schede', 'il mio schermo',
    // 3.4.x: the owner's own open things and files on that computer (pc_my_tabs, pc_files).
    'what i have open', 'what do i have open', 'whats open', 'what s open', 'what is open', 'my open',
    // 3.5.x (reach): the screen, its apps, programs, windows and browsers, in six languages.
    'the computer', 'whole computer', 'your computer', 'her computer', 'his computer', 'the pc', 'the laptop', 'the screen', 'whole screen', 'on screen', 'my apps', 'open apps', 'apps that are open', 'programs', 'my programs', 'open programs', 'software', 'open windows', 'browsers', 'my browsers', 'tabs', 'what am i doing', 'what i m doing', 'this app', 'that app', 'this window', 'that window', 'this program', 'notepad', 'use chrome', 'use edge', 'use firefox', 'in chrome', 'in edge', 'in firefox', 'switch to the tab', 'switch tabs',
    'el ordenador', 'la computadora', 'la pantalla', 'ventanas', 'programas', 'aplicaciones', 'pestanas', 'l ordinateur', 'l ecran', 'fenetres', 'logiciels', 'les applications', 'onglets', 'den computer', 'den rechner', 'den bildschirm', 'fenster', 'programme', 'anwendungen', 'o computador', 'a tela', 'janelas', 'aplicativos', 'abas', 'il computer', 'lo schermo', 'finestre', 'programmi', 'applicazioni', 'schede', 'my files', 'my folders', 'my documents', 'my downloads', 'my desktop', 'on my desktop', 'my file', 'mis archivos', 'mis documentos', 'mis descargas', 'mi escritorio', 'mes fichiers', 'mes documents', 'mes telechargements', 'mon bureau', 'meine dateien', 'meine dokumente', 'meine downloads', 'mein desktop', 'meus arquivos', 'meus documentos', 'meus downloads', 'minha area de trabalho', 'i miei file', 'i miei documenti', 'i miei download', 'la mia scrivania'],
  preview: ['preview', 'vista previa', 'apercu', 'vorschau', 'pre visualizacao', 'anteprima'],
  team: ['team', 'equipo', 'equipe', 'squadra'],
  review: ['review', 'code review', 'red team', 'revision', 'revue', 'revisao', 'revisione', 'uberprufung'],
  photos: ['photo', 'selfie', 'picture', 'foto', 'photo de toi', 'bild'],
  people: ['person', 'people', 'persona', 'personne', 'pessoa'],
  // make_document: documents and files she makes (all six languages, folded, no accents).
  documents: ['document', 'documents', 'word', 'word document', 'docx', 'pdf', 'report', 'resume', 'cv', 'letter', 'cover letter', 'spreadsheet', 'excel', 'xlsx', 'slides', 'slide deck', 'powerpoint', 'pptx', 'presentation', 'invoice', 'table', 'csv', 'markdown', 'file', 'documento', 'informe', 'carta', 'curriculum', 'hoja de calculo', 'diapositivas', 'presentacion', 'factura', 'tabla', 'rapport', 'lettre', 'tableur', 'feuille de calcul', 'diaporama', 'facture', 'tableau', 'dokument', 'bericht', 'brief', 'lebenslauf', 'tabelle', 'prasentation', 'folien', 'rechnung', 'relatorio', 'planilha', 'apresentacao', 'fatura', 'tabela', 'relazione', 'lettera', 'foglio di calcolo', 'presentazione', 'fattura', 'tabella'],
  // 3.3.0 (ezplain): settings by asking (change_setting).
  settings: ['text', 'font', 'bigger', 'larger', 'smaller', 'zoom', 'dark mode', 'light mode', 'night mode', 'day mode', 'theme', 'color', 'colour', 'your voice', 'voice', 'mute', 'call me', 'my name', 'texto', 'letra', 'modo oscuro', 'tema', 'voz', 'llamame', 'texte', 'police', 'mode sombre', 'couleur', 'voix', 'appelle moi', 'schrift', 'grosser', 'dunkelmodus', 'farbe', 'stimme', 'nenn mich', 'fonte', 'maior', 'modo escuro', 'cor', 'me chame', 'testo', 'carattere', 'piu grande', 'tema scuro', 'colore', 'voce', 'chiamami'],
  personality: ['personality', 'personalidad', 'personnalite', 'personlichkeit', 'personalidade', 'personalita'],
  skills: ['skill', 'skills', 'recipe', 'habilidad', 'receta', 'competence', 'recette', 'fahigkeit', 'rezept', 'habilidade', 'receita', 'abilita', 'ricetta'],
  shared: ['shared list', 'shopping list', 'lista compartida', 'liste partagee', 'einkaufsliste', 'lista compartilhada', 'lista condivisa'],
  'mcp:playwright': ['playwright', 'browser', 'click', 'screenshot', 'navegador', 'navigateur', 'klicken', 'clicca'],
  'mcp:filesystem': ['files server', 'filesystem'],
  'mcp:memory': ['memory server', 'knowledge graph'],
};

/** Words a find_tools query maps to a family (synonyms; the same table). */
export const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const words = (s: string): string[] => fold(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
const hasPhrase = (text: string, phrase: string): boolean => ` ${text} `.includes(` ${phrase} `);
const STOP = new Set(['a', 'an', 'the', 'to', 'of', 'on', 'in', 'for', 'and', 'or', 'with', 'my', 'me', 'it', 'is', 'that', 'this', 'do', 'use', 'some', 'un', 'una', 'el', 'la', 'le', 'les', 'de', 'des', 'du', 'der', 'die', 'das', 'ein', 'eine', 'um', 'uma', 'o', 'il', 'lo', 'di', 'per', 'en', 'et', 'y', 'e', 'und', 'zu']);

// ---------------------------------------------------------------------------------------------
// tool_loads (§4.12)
// ---------------------------------------------------------------------------------------------

export type Reason = 'core' | 'safety' | 'pinned' | 'asked' | 'ref' | 'recent' | 'skill' | 'goal' | 'find' | 'used';

export function ensureLeanTables(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS tool_loads (
  conversation_id TEXT NOT NULL, tool TEXT NOT NULL, family TEXT NOT NULL, how TEXT NOT NULL,
  first_at TEXT NOT NULL, last_at TEXT NOT NULL, last_turn INTEGER NOT NULL, uses INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (conversation_id, tool));
CREATE INDEX IF NOT EXISTS tool_loads_recent ON tool_loads(conversation_id, last_turn DESC);`);
}

export interface LoadRow {
  tool: string;
  family: string;
  how: string;
  lastTurn: number;
  uses: number;
  pinned: boolean;
  lastAt: string;
}

export function loadRows(db: DatabaseSync, conversationId: string): LoadRow[] {
  return (db.prepare('SELECT tool, family, how, last_turn, uses, pinned, last_at FROM tool_loads WHERE conversation_id = ? ORDER BY last_turn DESC, last_at DESC').all(conversationId) as Record<string, unknown>[]).map((r) => ({ tool: String(r.tool), family: String(r.family), how: String(r.how), lastTurn: Number(r.last_turn), uses: Number(r.uses), pinned: Number(r.pinned) === 1, lastAt: String(r.last_at) }));
}

export function writeLoad(db: DatabaseSync, conversationId: string, tool: string, family: string, how: string, turn: number, at: string, used = false): void {
  db.prepare(`INSERT INTO tool_loads (conversation_id, tool, family, how, first_at, last_at, last_turn, uses, pinned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT(conversation_id, tool) DO UPDATE SET last_at = excluded.last_at, last_turn = MAX(last_turn, excluded.last_turn), uses = uses + excluded.uses, how = CASE WHEN excluded.how = 'used' THEN how ELSE excluded.how END`).run(conversationId, tool, family, how, at, at, turn, used ? 1 : 0);
}

/** /tools +x and -x: a chat's own pins (a tool name, a family id or a server name). */
export function setChatPin(db: DatabaseSync, conversationId: string, name: string, on: boolean, turn: number, at: string): void {
  if (on) db.prepare(`INSERT INTO tool_loads (conversation_id, tool, family, how, first_at, last_at, last_turn, uses, pinned) VALUES (?, ?, ?, 'pin', ?, ?, ?, 0, 1) ON CONFLICT(conversation_id, tool) DO UPDATE SET pinned = 1`).run(conversationId, name, name, at, at, turn);
  else db.prepare('UPDATE tool_loads SET pinned = 0 WHERE conversation_id = ? AND tool = ?').run(conversationId, name);
}

export function leanOff(db: DatabaseSync, conversationId: string): boolean {
  const r = db.prepare('SELECT lean_off FROM conversations WHERE id = ?').get(conversationId) as { lean_off?: number | null } | undefined;
  return Number(r?.lean_off ?? 0) === 1;
}
export function setLeanOff(db: DatabaseSync, conversationId: string, off: boolean): void {
  db.prepare('UPDATE conversations SET lean_off = ? WHERE id = ?').run(off ? 1 : null, conversationId);
}

// ---------------------------------------------------------------------------------------------
// L4 · search (code only)
// ---------------------------------------------------------------------------------------------

interface Scored {
  tool: Tool;
  score: number;
}

/** Scores eligible tools for a query: name words, family label/words, source, description start. */
export function searchTools(eligible: Tool[], query: string, recent: Map<string, number> = new Map()): Scored[] {
  const q = fold(query).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const qw = words(query).filter((w) => !STOP.has(w));
  if (!qw.length) return [];
  // Families whose words the query uses.
  const famHit = new Map<string, number>();
  for (const [fam, list] of Object.entries(FAMILY_WORDS)) for (const p of list) if (hasPhrase(q, p)) famHit.set(fam, (famHit.get(fam) ?? 0) + (p.includes(' ') ? 3 : 2));
  const out: Scored[] = [];
  for (const t of eligible) {
    if (t.spec.name === FIND_TOOLS) continue;
    const f = familyOf(t);
    const nameW = words(t.spec.name.replace(/_/g, ' '));
    const labelW = words(`${f.label} ${f.id.replace(/[:]/g, ' ')} ${t.source ?? ''}`);
    const desc = ` ${words((t.spec.description ?? '').slice(0, 300)).join(' ')} `;
    let s = 0;
    for (const w of qw) {
      const stem = w.length > 5 ? w.slice(0, w.length - 1) : w;
      if (nameW.includes(w)) s += 3;
      else if (nameW.some((n) => n.startsWith(stem) || (n.length > 3 && w.startsWith(n)))) s += 2;
      if (labelW.includes(w)) s += 2;
      if (desc.includes(` ${w} `)) s += 1;
      else if (stem.length >= 4 && desc.includes(` ${stem}`)) s += 0.5;
    }
    s += famHit.get(f.id) ?? famHit.get(f.id.replace(/^mcp:/, '')) ?? 0;
    if (s > 0) out.push({ tool: t, score: s });
  }
  return out.sort((a, b) => b.score - a.score || (recent.get(b.tool.spec.name) ?? 0) - (recent.get(a.tool.spec.name) ?? 0) || a.tool.spec.name.localeCompare(b.tool.spec.name));
}

// ---------------------------------------------------------------------------------------------
// L2/L3 · the turn's tools
// ---------------------------------------------------------------------------------------------

export interface LeanInput {
  /** His message (words and @-references are read from it). */
  text: string;
  mode: 'chat' | 'coding';
  /** The model runs on this computer (the smaller core with `localCore`). */
  local: boolean;
  /** The id of his message this turn (tool_loads.last_turn). */
  turnId: number;
  /** Ids of his last messages in this chat, newest first (stickiness counts his turns). */
  ownerTurnIds: number[];
  /** Text of skills loaded for this turn (tool names in them are offered). */
  skillText?: string;
  /** A goal round or loop tick: earlier rounds' tools are offered. */
  goal?: boolean;
  /** Forced: 'off' (today's list), 'on' (lean whatever the size). */
  force?: 'off' | 'on';
  /** The tool's permission as the owner has it (falls back to the tool's default). */
  permission?: (name: string) => string;
}

// B2: when only part of a big server's tools fit, read-only and status tools come first.
/** Tools that install, download, restart, remove or file things publicly (short names). */
const RISKY_TOOL = /^(install|download|restart|delete|uninstall|deploy|publish)_|^report_issue$|_(remove|delete)$/;
/** His message asks whether something is there or working. */
const STATUS_INTENT = /\b(check|checking|see|running|status|health|healthy|installed|installation|working|online|connected|reachable|alive|up)\b/;
const STATUS_NAME = /stat|health|status|system/;

/** A family's tools in the order to offer them: what his words name, read-only before ask, installers last. */
export function rankFamily(members: Tool[], text: string, permission?: (name: string) => string): string[] {
  const hit = new Map(searchTools(members, text).map((h) => [h.tool.spec.name, h.score]));
  const status = STATUS_INTENT.test(fold(text));
  const score = (t: Tool): number => {
    const short = t.spec.name.replace(/^mcp_[^_]+_/, '');
    let s = hit.get(t.spec.name) ?? 0;
    if ((permission?.(t.spec.name) ?? t.defaultPermission) === 'auto') s += 4;
    if (RISKY_TOOL.test(short)) s -= 4;
    if (status && STATUS_NAME.test(short)) s += 8;
    else if (status && STATUS_NAME.test(fold((t.spec.description ?? '').slice(0, 200)))) s += 2;
    return s;
  };
  return members.map((t, i) => ({ n: t.spec.name, s: score(t), i })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.n);
}

export class TurnTools {
  readonly lean: boolean;
  readonly eligible: Tool[];
  /** Offered names in order, with the first reason. */
  readonly offered = new Map<string, Reason>();
  /** Loads made during this turn (the run record and the step line). */
  readonly loaded: { name: string; why: Reason }[] = [];
  finds = 0;
  readonly #queries = new Set<string>();
  readonly #byName = new Map<string, Tool>();
  readonly #set: LeanSettings['tools'];
  readonly #recent: Map<string, number>;
  #sentBefore: string[] | undefined;

  constructor(eligible: Tool[], lean: boolean, set: LeanSettings['tools'], recent: Map<string, number> = new Map()) {
    this.eligible = eligible;
    this.lean = lean;
    this.#set = set;
    this.#recent = recent;
    for (const t of eligible) this.#byName.set(t.spec.name, t);
  }

  get eligibleTokens(): number { return tokensOf(this.eligible); }

  isEligible(name: string): boolean {
    return this.#byName.has(name);
  }
  /** Revocation narrows this turn permanently, including late explicit find_tools loads. */
  revoke(names: ReadonlySet<string>): void {
    for (const name of names) { this.#byName.delete(name); this.offered.delete(name); }
    for (let i = this.eligible.length - 1; i >= 0; i--) if (names.has(this.eligible[i].spec.name)) this.eligible.splice(i, 1);
  }
  isOffered(name: string): boolean {
    return !this.lean || this.offered.has(name);
  }
  get settings(): LeanSettings['tools'] {
    return this.#set;
  }

  /** Adds tools (eligible only), keeping order (appends). Whole families for SSH and the computer. */
  add(names: string[], why: Reason, record = false): string[] {
    const added: string[] = [];
    for (const n of names) {
      const t = this.#byName.get(n);
      if (!t || this.offered.has(n)) continue;
      this.offered.set(n, why);
      added.push(n);
      if (record) this.loaded.push({ name: n, why });
      const fam = familyOf(t).id;
      if (WHOLE_FAMILIES.has(fam) && !SAFETY_SET.has(n)) {
        for (const o of this.eligible) {
          if (familyOf(o).id !== fam || this.offered.has(o.spec.name)) continue;
          this.offered.set(o.spec.name, why);
          added.push(o.spec.name);
          if (record) this.loaded.push({ name: o.spec.name, why });
        }
      }
    }
    return added;
  }

  /** Loads for the next step (a find, a call to an eligible tool that wasn't offered). */
  load(names: string[], why: Reason): string[] {
    return this.add(names, why, true);
  }

  /** The specs to send now: offered ∩ the turn's current tools (a crisis or a pause can empty them). */
  offeredSpecs(current: Tool[]): ToolSpec[] {
    if (!this.lean) return current.map((t) => t.spec);
    const cur = new Set(current.map((t) => t.spec.name));
    return [...this.offered.keys()].filter((n) => cur.has(n)).map((n) => this.#byName.get(n)!.spec);
  }
  offeredNames(current?: Tool[]): string[] {
    if (!this.lean) return (current ?? this.eligible).map((t) => t.spec.name);
    const cur = current ? new Set(current.map((t) => t.spec.name)) : undefined;
    return [...this.offered.keys()].filter((n) => !cur || cur.has(n));
  }
  offeredTokens(): number {
    return this.lean ? tokensOf([...this.offered.keys()].map((n) => this.#byName.get(n)!)) : this.eligibleTokens;
  }

  /** Preview without consuming the delta; commit once at the actual provider boundary. */
  stepRecord(current = this.eligible, commit = true): { lean: boolean; offered: string[]; loaded: { name: string; why: Reason }[]; eligible: number; eligibleTokens: number; offeredTokens: number } {
    const specs = this.offeredSpecs(current);
    const now = specs.map(spec => spec.name);
    const prev = this.#sentBefore;
    if (commit) this.#sentBefore = now;
    const offered = prev ? [...now.filter(n => !prev.includes(n)).map(n => `+${n}`), ...prev.filter(n => !now.includes(n)).map(n => `-${n}`)] : now;
    return { lean: this.lean, offered, loaded: [...this.loaded], eligible: current.length, eligibleTokens: tokensOf(current), offeredTokens: tokensOf(specs.map(spec => ({ spec }))) };
  }

  /** Deferred families: eligible but not offered, with counts. */
  deferred(): { id: string; label: string; count: number; total: number; names: string[] }[] {
    const fams = new Map<string, { id: string; label: string; count: number; total: number; names: string[]; recent: number }>();
    for (const t of this.eligible) {
      const f = familyOf(t);
      const e = fams.get(f.id) ?? { id: f.id, label: f.label, count: 0, total: 0, names: [], recent: 0 };
      e.total++;
      if (!this.offered.has(t.spec.name)) {
        e.count++;
        e.names.push(t.spec.name);
      }
      e.recent = Math.max(e.recent, this.#recent.get(t.spec.name) ?? 0);
      fams.set(f.id, e);
    }
    return [...fams.values()].filter((f) => f.count > 0).sort((a, b) => b.recent - a.recent || b.count - a.count || a.label.localeCompare(b.label)).map(({ recent: _r, ...f }) => f);
  }

  /** L5: one line per family not (fully) offered, ≤ 600 characters. */
  directory(): string {
    const fams = this.deferred();
    const parts: string[] = [];
    let len = 0;
    for (let i = 0; i < fams.length; i++) {
      const f = fams[i];
      const sample = f.names.slice(0, 4).map((n) => shortName(n)).join(', ');
      const part = `${f.label} (${f.count < f.total ? `${f.count} more of ${f.total}` : f.count}: ${sample})`;
      if (len + part.length > 600) {
        parts.push(`… and ${fams.length - i} more groups`);
        break;
      }
      parts.push(part);
      len += part.length + 3;
    }
    return parts.join(' · ');
  }

  /** find_tools (§4.7). */
  find(args: Record<string, unknown>, owner: string): string {
    this.finds++;
    if (this.finds > this.#set.findsPerTurn) return `You've looked ${this.finds - 1} times this turn. Ask ${owner} which tool they mean, or carry on with what you have.`;
    const want = Array.isArray(args.load) ? args.load.map((x) => String(x)).filter((n) => this.#byName.has(n)) : [];
    const query = String(args.query ?? '').trim().slice(0, 200);
    if (want.length) {
      const got = this.load(want.slice(0, this.#set.perFind), 'find');
      return got.length ? `Loaded for your next step (${got.length}): ${got.map((n) => this.#line(n)).join(', ')}.` : 'Those are already loaded.';
    }
    if (!query) return 'Say what you want to do in a few words, like find_tools("create a GitHub issue").';
    const key = fold(query);
    if (this.#queries.has(key)) return `You already looked for '${query}' this turn; what it found is loaded. Use those tools, or ask ${owner}.`;
    this.#queries.add(key);
    const hits = searchTools(this.eligible, query, this.#recent).slice(0, 8);
    if (!hits.length) return `Nothing here matches '${query}'. These groups exist: ${this.directory() || 'none'}`;
    const toLoad = hits.filter((h) => !this.offered.has(h.tool.spec.name)).slice(0, this.#set.perFind).map((h) => h.tool.spec.name);
    const loaded = this.load(toLoad, 'find');
    const have = hits.filter((h) => this.offered.has(h.tool.spec.name) && !loaded.includes(h.tool.spec.name)).map((h) => h.tool.spec.name);
    const rest = hits.map((h) => h.tool.spec.name).filter((n) => !loaded.includes(n) && !have.includes(n));
    const lines: string[] = [];
    if (loaded.length) lines.push(`Loaded for your next step (${loaded.length}): ${loaded.map((n) => this.#line(n)).join(', ')}.`);
    if (have.length) lines.push(`Already yours: ${have.join(', ')}.`);
    if (rest.length) lines.push(`Also found (not loaded): ${rest.join(', ')}.`, 'Say find_tools with load: [...] to load any of these.');
    return lines.join('\n');
  }

  #line(n: string): string {
    const t = this.#byName.get(n)!;
    const d = (t.spec.description ?? '').replace(/^\[[^\]]+\]\s*/, '').replace(/\s+/g, ' ').split(/(?<=\.)\s/)[0].slice(0, 80);
    return d ? `${n} (${d})` : n;
  }
}

const shortName = (n: string): string => n.replace(/^mcp_[^_]+_/, '').replace(/^(pc|ssh|browser|board|card|gmail|calendar|github|home|team|redteam)_/, '').replace(/_/g, ' ');

/**
 * L2: whether this turn is lean, and its first offered set with a reason per tool. Pure apart from
 * reading tool_loads; code only.
 */
export function leanFor(set: LeanSettings['tools'], eligible: Tool[], input: LeanInput, loads: LoadRow[] = [], chatPins: string[] = []): TurnTools {
  const recentRank = new Map<string, number>();
  loads.forEach((r, i) => recentRank.set(r.tool, loads.length - i));
  const total = tokensOf(eligible.filter((t) => t.spec.name !== FIND_TOOLS));
  const on = input.force === 'off' ? false : input.force === 'on' ? true : set.mode === 'off' ? false : set.mode === 'always' ? true : total > set.aboveTokens;
  const usable = on ? eligible : eligible.filter((t) => t.spec.name !== FIND_TOOLS);
  const tt = new TurnTools(usable, on, set, recentRank);
  if (!on) return tt;
  const names = new Set(eligible.map((t) => t.spec.name));
  // 1. core, safety, pins
  let core: string[] = input.mode === 'coding' ? [...CORE_CODING] : [...CORE_CHAT];
  if (set.localCore && input.local) core = core.filter((n) => names.has(n)).slice(0, 7);
  tt.add(core, 'core');
  tt.add([...SAFETY_PINS], 'safety');
  const pinNames = (pins: string[]) => eligible.filter((t) => pins.includes(t.spec.name) || pins.includes(familyOf(t).id) || pins.includes(familyOf(t).id.replace(/^(mcp|plugin):/, ''))).map((t) => t.spec.name);
  tt.add(pinNames(set.pins), 'pinned');
  tt.add(pinNames(chatPins), 'pinned');
  // 2. asked: a tool, a server/plugin, a family by its words
  const text = fold(input.text).replace(/[^\p{L}\p{N}@:_]+/gu, ' ');
  const plain = text.replace(/[_:@]/g, ' ');
  const asked: string[] = [];
  const famAsked = new Set<string>();
  for (const t of eligible) {
    const n = t.spec.name;
    const short = n.replace(/^mcp_[^_]+_/, '');
    if (hasPhrase(text, n) || (short !== n && short.includes('_') && short.length >= 6 && hasPhrase(text, short))) asked.push(n);
    const f = familyOf(t);
    if (f.kind === 'mcp' || f.kind === 'plugin') {
      const server = fold(f.id.split(':')[1] ?? '');
      if ((server.length >= 3 && hasPhrase(plain, server)) || hasPhrase(plain, fold(f.label))) famAsked.add(f.id);
    }
  }
  for (const [fam, list] of Object.entries(FAMILY_WORDS)) if (list.some((p) => hasPhrase(plain, p))) famAsked.add(fam);
  if (DO_WORDS.test(plain) && (PC_THINGS.test(plain) || CHECKUP_REF.test(fold(input.text)))) famAsked.add('computer');
  tt.add(asked, 'asked');
  for (const fam of famAsked) {
    const members = eligible.filter((t) => familyOf(t).id === fam || (fam === 'github' && familyOf(t).id === 'mcp:github') || (fam === 'browser' && familyOf(t).id === 'mcp:playwright'));
    if (!members.length) continue;
    if (members.length <= 12) tt.add(members.map((t) => t.spec.name), 'asked');
    else tt.add(rankFamily(members, input.text, input.permission).slice(0, 12), 'asked');
  }
  // 3. @-references
  if (/@url:/i.test(input.text)) tt.add(['web_fetch'], 'ref');
  if (/@(file|folder|diff|branch|problem)\b/i.test(input.text)) tt.add(['read_file', 'list_dir', 'search', 'edit_file', ...(/@(diff|branch)\b/i.test(input.text) ? ['git'] : [])], 'ref');
  // 4. recent (sticky) / 6. goal
  const oldest = input.ownerTurnIds[Math.min(set.stickyTurns, input.ownerTurnIds.length) - 1] ?? 0;
  const recent = loads.filter((r) => !r.pinned && (input.goal || r.lastTurn >= oldest)).slice(0, set.maxLoaded).map((r) => r.tool);
  tt.add(recent, input.goal ? 'goal' : 'recent');
  // 5. skill
  if (input.skillText) {
    const sk = input.skillText;
    tt.add(eligible.filter((t) => t.spec.name.length >= 4 && new RegExp(`\\b${t.spec.name}\\b`).test(sk)).map((t) => t.spec.name), 'skill');
  }
  // 7. find_tools last
  tt.add([FIND_TOOLS], 'core');
  return tt;
}

/**
 * EC21: whether run_code is offered in this step: the setting is on (and no policy pin), not a
 * partner or group chat, and the turn needs many tool calls: a coding chat, or 2+ calls already.
 */
export function codeModeOffer(o: { on: boolean; mode: 'chat' | 'coding'; callsThisTurn: number; partner?: boolean; group?: boolean }): boolean {
  if (!o.on || o.partner || o.group) return false;
  return o.mode === 'coding' || o.callsThisTurn >= 2;
}

/** The find_tools tool (family help, runs on its own; offered only in lean turns). */
export function findToolsTool(): Tool {
  return {
    spec: {
      name: FIND_TOOLS,
      description: "Look up tools you don't have yet and load them for your next step. Use plain words for the job ('create a GitHub issue', 'click a button on a web page'). Only tools the owner allows here can be found.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What you want to do, in a few words.' },
          load: { type: 'array', items: { type: 'string' }, description: 'Exact tool names from an earlier find_tools result to load.' },
        },
      },
    },
    defaultPermission: 'auto',
    source: 'built-in',
    summarize: (a) => `Looked up tools: ${String(a.query ?? (Array.isArray(a.load) ? a.load.join(', ') : '')).slice(0, 80)}`,
    run: async (args, ctx) => (ctx.lean ? ctx.lean.find(args) : 'Every tool you may use here is already in your list.'),
  };
}

/** A schema line for an eligible tool she called without having it ("Here are the fields it takes"). */
export function schemaHint(tool: Tool): string {
  return `Here are the fields it takes: ${JSON.stringify(tool.spec.parameters ?? {}).slice(0, 1000)}`;
}

// B2: an argument error that lists allowed values (zod's "expected one of", JSON-schema enum errors).
const ENUM_ERROR = /expected one of|one of the allowed values|invalid enum value|must be one of|allowed values:/i;
export const ARG_RETRY = 'Your arguments were invalid and nothing ran. Fix them using the allowed values above and call the tool again, or use find_tools for a better tool, before answering.';

/** The failing field's allowed values from the tool's own schema, then the retry line ('' for other errors). */
export function argErrorHint(tool: Tool, output: string): string {
  if (!ENUM_ERROR.test(output)) return '';
  const path = (/\bat ([A-Za-z_][\w.]*)\s*$/m.exec(output)?.[1]?.split('.') ?? /(?:\bat |data|instancePath["': ]*)\/([\w/]+)/.exec(output)?.[1]?.split('/') ?? []).filter((k) => k && !/^\d+$/.test(k));
  let node = rec(tool.spec.parameters);
  for (const k of path) node = rec(rec(node.properties)[k] ?? rec(rec(node.items).properties)[k]);
  const allowed = Array.isArray(node.enum) ? node.enum : [];
  const line = path.length && allowed.length ? `Allowed values for "${path.join('.')}": ${allowed.map((v) => JSON.stringify(v)).join(', ')}.\n` : '';
  return `${line}${ARG_RETRY}`;
}

// ---------------------------------------------------------------------------------------------
// Outside a turn: /tools, GET /api/conversations/:id/tools, GET /api/lean/measure
// ---------------------------------------------------------------------------------------------

/** The eligible list for an owner chat, the main gates of runTurn applied (no model, no turn). */
export function eligibleFor(app: AppContext, conv: Pick<Conversation, 'private' | 'partner' | 'channel' | 'mode'> & Partial<Pick<Conversation, 'channelKey' | 'id'>>): Tool[] {
  if (conv.partner) return [];
  const s = app.settings.get();
  const OFF = (n: string) => n === 'send_file' || n === 'web_fetch' || n === 'web_search' || n === 'delegate_task' || n === 'git_push' || /^(home_|mcp_|gmail_|mail_|calendar_|github_)/.test(n);
  const work = conv.channel.endsWith('-work');
  let tools = app.tools.enabled(s.toolPermissions).filter((t) => !(conv.private && OFF(t.spec.name)));
  if (!checkpointAllowed(app, conv)) tools = tools.filter(t => t.spec.name !== 'project_checkpoint');
  if (!continuityAllowed(app, conv as Conversation) || conv.id && !continuityForTurn(app, conv.id)) tools = tools.filter(t => !SESSION_TOOLS.has(t.spec.name));
  // R1B2: the same owner-seat binding the turn uses (no seat, paused setting, adult off: not offered).
  if (!sceneCanonPreview(app, conv as Partial<Conversation>)) tools = tools.filter(t => t.spec.name !== SCENE_CANON_TOOL);
  if (conv.private || work) tools = tools.filter((t) => !t.spec.name.startsWith('ssh_'));
  if (work) tools = tools.filter((t) => !t.spec.name.startsWith('pc_') && t.spec.name !== 'moments');
  if (conv.private) tools = tools.filter((t) => !t.spec.name.startsWith('agenda_'));
  if (!app.tools.get(FIND_TOOLS)) tools.push(findToolsTool());
  return tools;
}

/** What this chat's turn would be offered now (no message): the /tools answer and the fill. */
export function planFor(app: AppContext, conv: Conversation, text = ''): TurnTools {
  const set = leanSettings(app).tools;
  ensureLeanTables(app.store.db);
  const loads = loadRows(app.store.db, conv.id);
  const ownerIds = app.store.messages(conv.id).filter((m) => m.role === 'user').map((m) => m.id).reverse();
  return leanFor(set, eligibleFor(app, conv), { text, mode: conv.mode === 'coding' ? 'coding' : 'chat', local: false, turnId: ownerIds[0] ?? 0, ownerTurnIds: ownerIds, force: leanOff(app.store.db, conv.id) ? 'off' : undefined }, loads, loads.filter((r) => r.pinned).map((r) => r.tool));
}

const kTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** /tools (zero model calls), §4.9. */
export function toolsReport(app: AppContext, conv: Conversation): string {
  const tt = planFor(app, conv);
  const all = tt.eligible.filter((t) => t.spec.name !== FIND_TOOLS);
  if (!all.length) return 'No tools in this chat.';
  if (!tt.lean) return `Tools here: all ${all.length} offered (about ${kTok(tt.eligibleTokens)} tokens a step).${leanOff(app.store.db, conv.id) ? '\n/tools lean: back to the short list' : ''}`;
  const byFam = (names: string[]) => {
    const m = new Map<string, string[]>();
    for (const n of names) {
      const t = all.find((x) => x.spec.name === n);
      if (!t) continue;
      const l = familyOf(t).label;
      m.set(l, [...(m.get(l) ?? []), shortName(n)]);
    }
    return [...m.entries()];
  };
  const offered = tt.offeredNames();
  const safety = offered.filter((n) => tt.offered.get(n) === 'safety');
  const main = offered.filter((n) => tt.offered.get(n) !== 'safety' && n !== FIND_TOOLS);
  const looked = loadRows(app.store.db, conv.id).filter((r) => (r.how === 'find' || r.how === 'used') && offered.includes(r.tool)).map((r) => r.tool);
  const lines = [
    `Tools here: ${offered.length} of ${all.length + 1} offered (about ${kTok(tt.offeredTokens())} of ${kTok(tt.eligibleTokens)} tokens a step).`,
    `Offered: ${byFam(main).map(([l]) => l).join(', ')}${safety.length ? ` · safety: ${safety.map(shortName).join(', ')}` : ''}`,
  ];
  if (looked.length) lines.push(`Looked up lately: ${byFam(looked).map(([l, n]) => `${l} (${n.join(', ')})`).join('; ')}.`);
  const more = tt.deferred().slice(0, 8).map((f) => `${f.label} (${f.count})`);
  if (more.length) lines.push(`More on request: ${more.join(', ')}${tt.deferred().length > 8 ? '…' : ''}`);
  lines.push('/tools all: every tool in this chat · /tools lean: back to the short list · /tools +github: always offer here');
  return lines.join('\n');
}

/** GET /api/conversations/:id/tools. */
export function toolsView(app: AppContext, conv: Conversation): Record<string, unknown> {
  const tt = planFor(app, conv);
  const loads = loadRows(app.store.db, conv.id);
  return {
    lean: tt.lean,
    leanOff: leanOff(app.store.db, conv.id),
    offered: tt.offeredNames().map((n) => {
      const t = tt.eligible.find((x) => x.spec.name === n)!;
      return { name: n, family: familyOf(t).label, familyId: familyOf(t).id, why: tt.offered.get(n) ?? 'core', tokens: specTokens(t) };
    }),
    deferred: tt.deferred().map((f) => ({ id: f.id, label: f.label, count: f.count })),
    pins: loads.filter((r) => r.pinned).map((r) => r.tool),
    eligible: tt.eligible.length,
    eligibleTokens: tt.eligibleTokens,
    offeredTokens: tt.offeredTokens(),
  };
}

/** GET /api/lean/measure: an everyday chat and a coding chat as they'd be now. */
export function measure(app: AppContext): Record<string, unknown> {
  const set = leanSettings(app).tools;
  const one = (mode: 'chat' | 'coding') => {
    const el = eligibleFor(app, { private: false, partner: null, channel: 'web', mode });
    const tt = leanFor(set, el, { text: '', mode, local: false, turnId: 0, ownerTurnIds: [] });
    const fams = new Map<string, { label: string; tools: number; tokens: number }>();
    for (const t of el) {
      const f = familyOf(t);
      const e = fams.get(f.id) ?? { label: f.label, tools: 0, tokens: 0 };
      e.tools++;
      e.tokens += specTokens(t);
      fams.set(f.id, e);
    }
    return { tools: el.filter((t) => t.spec.name !== FIND_TOOLS).length, tokens: tokensOf(el.filter((t) => t.spec.name !== FIND_TOOLS)), lean: tt.lean, offered: tt.offeredNames().length, offeredTokens: tt.offeredTokens(), families: [...fams.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.tokens - a.tokens) };
  };
  return { chat: one('chat'), coding: one('coding'), settings: set };
}
