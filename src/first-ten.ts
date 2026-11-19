// W2.2 the first ten minutes (docs/design/W2FIRST.md). Small, pure-ish helpers for the R2 guide
// (src/get-started.ts): which way to run a model on this hardware, whether anything was brought in
// (Bring everything / history import), which chat app is linked, and three quick wins tailored to
// what is connected. Nothing here connects, downloads or writes: the guide's buttons call the
// existing routes (/api/local-models/pull|use, /api/plugins/where/*, the Move-in page).
import type { AppContext } from './chat.ts';
import { chatModels, CPU_TIERS, detectHardware, detectOllama, GPU_TIERS, recommendModel, type Hardware, type ModelTier, type OllamaStatus } from './local-models.ts';

export type ModelPath = 'gpu' | 'cpu' | 'cloud';
export type ModelAction = 'use' | 'download' | 'get-ollama' | 'cloud';

export interface ModelPlan {
  /** The recommended way for this computer. */
  path: ModelPath;
  /** Every way offered, recommended first. */
  paths: ModelPath[];
  /** The local model for the recommended (or, for cloud, the fallback local) way. */
  model: ModelTier;
  /** What the main button does: use a model already here, download it, get Ollama, or a cloud model. */
  action: ModelAction;
  /** A chat model already on this computer that fits (action 'use'). */
  use?: string;
  /** Every offered way with its own model and button (the person may pick another way). */
  options: Partial<Record<ModelPath, { model: ModelTier; action: ModelAction; use?: string }>>;
}

/** Below this much RAM (or with fewer cores) the processor is too slow to be a good first model. */
const CPU_MIN_RAM = 8;
const CPU_MIN_CORES = 4;

/** Picks the way to run her model on this hardware. Never downloads: it only says what to offer. */
export function modelPlan(hw: Hardware, ollama: OllamaStatus, o: { privateLocal?: boolean } = {}): ModelPlan {
  const graphics = (hw.basis === 'gpu' || hw.basis === 'unified') && hw.budgetGb >= 4;
  const cpuOk = hw.ramGb >= CPU_MIN_RAM && (hw.cpu?.cores ?? CPU_MIN_CORES) >= CPU_MIN_CORES;
  let path: ModelPath = graphics ? 'gpu' : cpuOk ? 'cpu' : 'cloud';
  if (path === 'cloud' && o.privateLocal) path = 'cpu';
  const order: ModelPath[] = path === 'gpu' ? ['gpu', 'cpu', 'cloud'] : path === 'cpu' ? ['cpu', 'cloud', 'gpu'] : ['cloud', 'cpu'];
  // No graphics card: don't offer a GPU way that isn't there.
  const paths = order.filter((p) => (p === 'gpu' ? graphics : p === 'cloud' ? !o.privateLocal : true));
  const modelFor = (p: ModelPath) => (p === 'gpu' ? recommendModel(hw) : recommendModel({ budgetGb: hw.ramGb, basis: 'cpu' }));
  const options: ModelPlan['options'] = {};
  for (const p of paths) options[p] = { model: modelFor(p), ...localAction(modelFor(p), ollama, p) };
  const model = modelFor(path);
  return { path, paths, model, ...localAction(model, ollama, path), options };
}

/** What the button does for a local model: Use one that's here, Download, or Get Ollama. */
export function localAction(model: ModelTier, ollama: OllamaStatus, path: ModelPath = 'gpu'): { action: ModelAction; use?: string } {
  if (path === 'cloud') return { action: 'cloud' };
  if (!ollama.found) return { action: 'get-ollama' };
  const here = chatModels(ollama.models).map((m) => m.name);
  const exact = here.find((n) => n === model.model || n === `${model.model}:latest`);
  if (exact) return { action: 'use', use: exact };
  return { action: 'download' };
}

/** The table a path recommends from (shown as "or a smaller one"). */
export const tiersFor = (path: ModelPath): readonly ModelTier[] => (path === 'gpu' ? GPU_TIERS : CPU_TIERS);

/** Seams for tests (the real ones run nvidia-smi and ask Ollama on this computer). */
export const firstTenDeps: { hardware: () => Promise<Hardware>; ollama: (root: string) => Promise<OllamaStatus> } = {
  hardware: () => detectHardware(),
  ollama: (root) => detectOllama(root),
};

/** Something was brought in: an imported conversation (Bring everything, ChatGPT/Claude exports). */
export function broughtIn(app: Pick<AppContext, 'store'>): boolean {
  try {
    return app.store.importedConversationIds().length > 0;
  } catch {
    return false;
  }
}

/** The chat app the owner can text her on (linked, not just set up), or null. */
export function chatAppName(app: AppContext): string | null {
  const s = app.settings.get();
  if (s.telegram?.enabled && s.telegram.ownerChatId) return 'Telegram';
  if (s.discord?.enabled && s.discord.ownerUserId) return 'Discord';
  const pm = app.pluginManager;
  if (!pm) return null;
  try {
    const companion = String(app.companionId ?? 'main');
    for (const [id, name] of PLUGIN_APPS) {
      if (!pm.store.get(id) || !pm.enabledFor(id, companion)) continue;
      if (pm.settingsView(id, companion).bridge?.ownerChats?.length) return name;
    }
  } catch {
    /* a partial plugin manager in a fixture: nothing linked */
  }
  return null;
}
const PLUGIN_APPS: readonly [string, string][] = [
  ['imessage', 'iMessage'],
  ['whatsapp', 'WhatsApp'],
  ['signal', 'Signal'],
  ['matrix', 'Matrix'],
  ['slack', 'Slack'],
  ['teams', 'Microsoft Teams'],
  ['email', 'Email'],
];

/** A short line from a note that was brought in (newest active one), for "ask about it". */
export function importedNote(app: Pick<AppContext, 'store'>): string | null {
  let row: { content?: unknown } | undefined;
  try {
    row = app.store.db
      .prepare("SELECT m.content AS content FROM memories m JOIN conversations c ON c.id = m.conversation_id WHERE c.channel LIKE 'import-%' AND COALESCE(m.archived, 0) = 0 AND m.superseded_by IS NULL ORDER BY m.id DESC LIMIT 1")
      .get() as { content?: unknown } | undefined;
  } catch {
    return null;
  }
  const text = String(row?.content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= 60) return text;
  const cut = text.slice(0, 60);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 30 ? cut.slice(0, sp) : cut).replace(/[,.;:]+$/, '')}…`;
}

export type WinId = 'reminder' | 'checklist' | 'note' | 'mail' | 'week';
export interface Win {
  id: WinId;
  /** The chat app the reminder should come on (when one is linked). */
  app?: string;
  /** The imported note the question is about. */
  note?: string;
}

/** Three quick wins: a reminder, a checklist and a question (an imported note, the mail, or the week). */
export function quickWins(app: AppContext, connected: { mail?: boolean }): Win[] {
  const chat = chatAppName(app);
  const note = importedNote(app);
  const third: Win = note ? { id: 'note', note } : connected.mail ? { id: 'mail' } : { id: 'week' };
  return [{ id: 'reminder', ...(chat ? { app: chat } : {}) }, { id: 'checklist' }, third];
}
