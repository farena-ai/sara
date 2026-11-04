// Phase 23: "Getting started" on the Today page. A short list of the steps that make Sara
// useful, each ticked off by itself when it's done (nothing to mark by hand), each opening the
// place where it's done. The owner can hide the list.
import type { AppContext } from './chat.ts';
import { usePathOf, type UsePath } from './settings.ts';
import { NOT_IMPORTED } from './store.ts';
import { GITHUB_VAULT } from './tools/coding.ts';
import { DEFAULT_VOICE, VOICE_VAULT } from './voice.ts';
import { routinesFor, ROUTINES_DIR } from './routines.ts';

/** Phase 121: any routine on (read from the engines: a briefing, a review, a repeating reminder, a watched repo, a repeat). */
function anyRoutineOn(app: AppContext): boolean {
  try {
    return routinesFor(app, ROUTINES_DIR).anyOn();
  } catch {
    return false;
  }
}

export interface ChecklistItem {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  /** Settings page (or view) that does it. */
  open: string;
}

export interface ChecklistInput {
  /** Signed-in device labels (e.g. "Sara app on iPhone"). */
  devices: string[];
  /** Browsers/phones that get notifications. */
  pushDevices: number;
  personaCustom: boolean;
  /** Phase 114 (PL1b): a household member's own list (no owner-only steps: brain, tools, GitHub, budgets, backups). */
  member?: boolean;
}

/**
 * Phase 114 (PL1b, docs/design/POLISH.md §5): the order of Getting started for each use choice. Every
 * list has 7 steps; company follows the beginner path, coding the coder path; both (also when never
 * chosen) keeps the list from before the choice existed, so nobody's progress moves around.
 */
export const CHECKLIST_ORDER: Record<UsePath, readonly string[]> = {
  company: ['brain', 'talk', 'yours', 'voice', 'phone', 'morning', 'backup'],
  coding: ['brain', 'project', 'tools', 'github', 'editor', 'budgets', 'backup'],
  both: ['brain', 'talk', 'yours', 'phone', 'voice', 'morning', 'backup'],
};
/** Steps on owner-only pages: a household member never sees them. */
export const OWNER_STEPS: readonly string[] = ['brain', 'tools', 'github', 'budgets', 'backup'];
/** Signed-in apps that are an editor or a terminal (the VS Code extension, the terminal client, an MCP client). */
const EDITOR_APP = /VS ?Code|Code\b|terminal|cli\b|Zed|JetBrains|Cursor|MCP|Neovim|Emacs/i;

/** M6: her voice counts as picked only when the chosen engine can really speak. */
export function voiceWorks(app: AppContext): boolean {
  const v = app.speech?.settings() ?? { ...DEFAULT_VOICE, ...app.settings.get().voice };
  if (!app.settings.get().voice || v.tts === 'off') return false;
  if (v.tts === 'local') return Boolean(app.voice?.voices().length);
  if (v.tts === 'xai') return app.speech?.hasXai() ?? Boolean(app.vault.get(VOICE_VAULT.xai));
  return Boolean(app.vault.get(v.tts === 'openai' ? VOICE_VAULT.openai : VOICE_VAULT.elevenlabs));
}

export function checklist(app: AppContext, input: ChecklistInput): { hidden: boolean; path: UsePath; items: ChecklistItem[]; readiness: { modelConfigured: boolean; firstReply: boolean } } {
  const s = app.settings.get();
  const subs = app.subscriptions;
  const brain = Boolean(s.defaultProviderId && s.defaultModel) || (!input.member && Boolean(subs?.grokStatus().signedIn || subs?.claudeStatus().signedIn || subs?.chatgpt?.status().signedIn));
  const talked = Boolean(app.store.db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'user' AND c.partner IS NULL AND ${NOT_IMPORTED} LIMIT 1`).get());
  const firstReply = Boolean(app.store.db.prepare(`SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.role = 'assistant' AND length(trim(m.content)) > 0 AND coalesce(json_extract(m.meta, '$.partial'), 0) = 0 AND json_extract(m.meta, '$.blocked') IS NULL AND c.partner IS NULL AND ${NOT_IMPORTED} LIMIT 1`).get());
  const coded = Boolean(app.store.db.prepare("SELECT 1 FROM conversations c WHERE (c.mode = 'coding' OR c.workspace != 'main') AND c.partner IS NULL LIMIT 1").get());
  const all: ChecklistItem[] = [
    { id: 'brain', label: 'Connect a brain', hint: 'The AI model she thinks with: on this computer, in the cloud, or your subscription.', done: brain, open: 'settings:models-default' },
    { id: 'talk', label: 'Say hello', hint: 'Just type: ask her anything, or tell her about your day.', done: talked, open: 'chat' },
    { id: 'yours', label: 'Make Sara your own', hint: 'Her name, personality and look.', done: input.personaCustom || Boolean(app.look?.custom), open: 'settings:her-character' },
    { id: 'phone', label: 'Put her on your phone', hint: 'Install the app or add her to your home screen, and get notifications.', done: input.pushDevices > 0 || input.devices.some((d) => /Sara app|iPhone|Android/i.test(d)), open: 'settings:co-phone' },
    { id: 'voice', label: 'Pick her voice', hint: 'For voice notes, read-aloud and calls.', done: voiceWorks(app), open: 'settings:her-voice' },
    // Phase 121 (BEGIN §4.9): the morning step became *Turn on a routine* (id kept; a briefing still ticks it).
    { id: 'morning', label: 'Turn on a routine', hint: 'A morning briefing, a weekly review, a reminder…', done: Boolean(s.briefing?.enabled) || anyRoutineOn(app), open: 'routines' },
    { id: 'backup', label: 'Keep a copy somewhere else', hint: 'An encrypted backup off this server, in case the server is lost, or run the safety check-up.', done: Boolean(s.offsite?.kind && s.offsite.kind !== 'off'), open: 'settings:dh-backups' },
    // Phase 114 (PL1b): the coder path's steps.
    { id: 'project', label: 'Open a project', hint: 'Point a conversation at a project folder and switch it to coding.', done: coded, open: 'settings:ab-projects' },
    { id: 'tools', label: 'Choose how she runs code', hint: 'Tools and approvals: a sandbox for commands, and what she must ask you first.', done: Object.keys(s.toolPermissions ?? {}).length > 0 || s.sandboxGate !== undefined, open: 'settings:ab-tools' },
    { id: 'github', label: 'Add a GitHub token', hint: 'So she can clone, open pull requests and review them.', done: Boolean(app.vault.get(GITHUB_VAULT)), open: 'settings:ab-github' },
    { id: 'editor', label: 'Use her from your editor', hint: 'The VS Code extension, the terminal client or any MCP or OpenAI-compatible app.', done: input.devices.some((d) => EDITOR_APP.test(d)), open: 'settings:co-apps' },
    { id: 'budgets', label: 'Set a budget', hint: 'How many tokens a coding reply or a background job may use before she stops.', done: s.turnBudgets !== undefined || s.jobBudget !== undefined, open: 'settings:ab-budgets' },
  ];
  const path = usePathOf(s.usePath);
  const byId = new Map(all.map((i) => [i.id, i]));
  const items = CHECKLIST_ORDER[path].filter((id) => !input.member || !OWNER_STEPS.includes(id)).map((id) => byId.get(id)!);
  return { hidden: Boolean(s.checklistHidden), path, items, readiness: { modelConfigured: brain, firstReply } };
}
