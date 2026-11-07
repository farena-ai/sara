// Non-secret owner settings, stored as JSON in the data directory.
import type { BriefingSettings } from './briefing.ts';
import type { OffsiteSettings } from './offsite.ts';
import type { PhotoSettings } from './photos.ts';
import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from './fs-util.ts';
import { join } from 'node:path';
import type { ProviderConfig } from './providers/types.ts';
import type { MemorySettings } from './memory-worker.ts';
import type { ProactiveSettings } from './life.ts';
import type { VoiceSettings } from './voice.ts';
import type { TelegramSettings } from './bridges/telegram.ts';
import type { PushSettings } from './push.ts';
import type { BackupSettings } from './backup.ts';
import type { DiscordSettings } from './bridges/discord.ts';

/**
 * Jobs a model can be pointed at (Phase 38 added vision, planning, writing, research, quick and
 * embeddings). Pictures, hearing and her voice have their own pages (Pictures, Voice).
 */
export type RoutePurpose = 'chat' | 'coding' | 'background' | 'private' | 'adult' | 'vision' | 'planning' | 'writing' | 'research' | 'quick' | 'embeddings' | 'review' | 'screen';
/** Phase 81 added 'review' (Reviewing: the security pass's second look; falls back to Coding). */
export const ROUTE_PURPOSES: readonly RoutePurpose[] = ['chat', 'coding', 'background', 'private', 'adult', 'vision', 'planning', 'writing', 'research', 'quick', 'embeddings', 'review', 'screen'];
/** A model for a job, with up to two others to take over if it fails or is slow (Phase 38). */
export interface ModelRoute {
  providerId: string;
  model: string;
  fallbacks?: { providerId: string; model: string }[];
}
import type { McpServerConfig } from './tools/mcp.ts';
import type { SearchProvider } from './tools/search.ts';
import type { Permission } from './tools/types.ts';

/** Phase 114 (PL1b): the use choice: company, coding or both. */
export type UsePath = 'company' | 'coding' | 'both';
export const USE_PATHS: readonly UsePath[] = ['company', 'coding', 'both'];
/** A stored or sent value as a use choice ('both' when missing or unknown). */
export const usePathOf = (v: unknown): UsePath => (USE_PATHS.includes(v as UsePath) ? (v as UsePath) : 'both');

export interface Settings {
  providers: ProviderConfig[];
  defaultProviderId?: string;
  defaultModel?: string;
  /** What Sara should call the owner. */
  ownerName?: string;
  /** IANA time zone used for Sara's sense of time. */
  timeZone?: string;
  /** When the owner accepted the AI and content disclosure (ISO time). */
  disclosureAcceptedAt?: string;
  /** The first-run setup guide was finished or skipped (Phase 10). */
  setupDone?: boolean;
  /**
   * Phase 114 (PL1b): what the owner mostly does with this companion (wizard step 1, Settings → You →
   * About you). Changes only the order of Getting started, the tour offered and the starter chips; every
   * feature stays available. Missing = 'both'.
   */
  usePath?: UsePath;
  /** Per-tool permission overrides (tool name → auto/ask/never). */
  toolPermissions?: Record<string, Permission>;
  /** E7 (A2): one choice per tool server (Ask me first / safe ones / everything / Never). */
  mcpPolicy?: Record<string, import('./tool-policy.ts').ServerPolicy>;
  /** Allow shell commands network access inside the sandbox. Default true. */
  shellNetwork?: boolean;
  /** Web search backend (key, if any, is in the vault under search:<provider>). */
  search?: { provider: SearchProvider; url?: string };
  /** MCP servers (secrets for env/headers are in the vault under mcp:<name>). */
  mcpServers?: McpServerConfig[];
  /** Pictures from Sara (Phase 9). */
  photos?: Partial<PhotoSettings>;
  /** Phase 36: her closet (dress automatically, work hours, own scenarios, picked scenario). */
  wardrobe?: Partial<import('./wardrobe.ts').WardrobeSettings>;
  /** Phase 36: keep her face from the locked picture in every outfit and change (default on). */
  faceLock?: boolean;
  /** Off-server encrypted backup copies (Phase 8). */
  offsite?: Partial<OffsiteSettings>;
  /** Morning briefing (Phase 8). */
  briefing?: Partial<BriefingSettings>;
  /** How much of a conversation is sent to the model each turn (characters; ~4 per token). */
  historyBudgetChars?: number;
  /** Long-term memory settings (Phase 3). */
  memory?: Partial<MemorySettings>;
  /** Which model handles what (Phase 4). A conversation's own model choice still wins. */
  routes?: Partial<Record<RoutePurpose, ModelRoute>>;
  /** Phase 38: seconds to wait for a model's first word before the next one takes over (default 60). */
  fallbackAfterSec?: number;
  /** Phase 38: fallbacks for the default model (used for any job without its own route). */
  defaultFallbacks?: { providerId: string; model: string }[];
  /** Phase 40: GitHub repositories watched for new issues (off by default). */
  githubWatch?: import('./issues.ts').GitHubWatch;
  /** Phase 39: helpers the owner made (Team page). */
  helpers?: import('./team.ts').CustomHelper[];
  /** Phase 39: default limits for a team task. */
  teamLimits?: Partial<import('./team.ts').TeamLimits>;
  /** Phase 99 (ST4): the board (how many cards she works at once; 2 by default). */
  board?: { concurrent?: number };
  /** Phase 52: the owner's own model prices (USD per 1M tokens; they win over the shipped defaults). */
  prices?: import('./usage.ts').PriceRow[];
  /** Phase 52: default budget for a background job that uses a model (Claude Code / Grok Build). */
  jobBudget?: import('./usage.ts').Budget;
  /** Phase 38, per companion: the model she thinks with for conversation (else the chat job / default). */
  companionModel?: { providerId: string; model: string };
  /** Persona engine switches (Phase 4). */
  /** typing: on Telegram/Discord, wait like a person typing before each message (Phase 11). */
  /** inCharacter (Phase 34): the optional stays-in-character check (off, some replies, every reply). */
  persona?: { innerLife?: boolean; typing?: 'instant' | 'human'; inCharacter?: 'off' | 'some' | 'every' };
  /**
   * Adult mode (Phase 16, owner decision 2026-10-24). Off by default. Turned on only from a web
   * browser with the owner's 18+ confirmation (recorded). When on: no limits beyond the legal ones
   * (disclosure, honesty, crisis help, the minors block); the model's own rules are the gate.
   * `ask`: servers that had adult content before this switch existed ask the owner once.
   */
  adultMode?: { on: boolean; confirmedAt?: string; confirmedFrom?: string; ask?: boolean };
  /** Phase 20: leave-by reminders from calendar events with an address (see leaveby.ts). */
  leaveBy?: Partial<import('./leaveby.ts').LeaveBySettings>;
  /** Phase 22: weekly review (see review.ts). */
  weeklyReview?: Partial<import('./review.ts').ReviewSettings>;
  /** Phase 23: the owner hid "Getting started" on the Today page. */
  checklistHidden?: boolean;
  /** Optional local classifier backing the safety heuristics (adds protection only). */
  safetyClassifier?: { providerId: string; model: string };
  /**
   * Phase 62: optional claim judge (off when unset). A small model asked only about sentences the
   * receipt patterns are unsure about; it can only add a correction, never remove one.
   */
  claimJudge?: { providerId: string; model: string };
  /**
   * Phase 77: \"Check her plans against what you decided\" (on unless turned off) and how strict:
   * 'stop' = clear conflicts stop with an approval card in coding/work conversations; 'mention'.
   */
  contradict?: Partial<import('./contradict.ts').ContradictSettings>;
  /** Phase 78: how long run snapshots are kept (days; 0 = until deleted) and their size cap (MB). */
  /** Phase 84: the eval loop's "Re-check monthly" (off by default; owner-only). */
  evalSchedule?: Partial<import('./evals.ts').EvalSchedule>;
  /** Phase 97 (ST2): skills she learns (per companion; Settings → Add-ons → Skills). */
  skillLearning?: Partial<import('./skill-learning.ts').LearnSettings>;
  /** Phase 98 (ST3): plugins switched on for this companion, their settings (secrets live in the vault). */
  plugins?: import('./plugins/manager.ts').CompanionPluginSettings;
  runs?: Partial<import('./runs.ts').RunSettings>;
  /** Settings → Data & health: the log level (SARA_LOG_LEVEL, when set, wins). Missing = info. */
  logLevel?: import('./log.ts').LogLevel;
  /**
   * Phase 79: per-reply budgets (Settings → Coding → Budgets): coding chats and everyday chats
   * (tokens, steps, optional $ and minutes, on/off), the quick-model step and what happens at the limit.
   */
  turnBudgets?: Partial<Omit<import('./budget.ts').TurnBudgetSettings, 'coding' | 'chat'>> & { coding?: Partial<import('./budget.ts').TurnLimits>; chat?: Partial<import('./budget.ts').TurnLimits> };
  /**
   * Phase 80: "Try commands in a sandbox first" (Settings → Coding → Coding projects): off, only
   * risky commands (default) or every command; network for tries, the size and time limits, and the
   * Docker image used on Windows when Docker is present.
   */
  sandboxGate?: Partial<import('./sandbox-run.ts').SandboxGateSettings>;
  /**
   * Phase 81: the security pass (Settings → Coding → Coding projects): after coding turns /
   * only when asked / off, the Reviewing model's second look, live advisories from OSV.dev (off by
   * default), the pass's token budget and the fix loop's test run.
   */
  securityPass?: Partial<import('./security/pass.ts').SecuritySettings>;
  /**
   * Phase 82: the threat model after coding turns (Settings → Coding → Coding projects): Off /
   * Report only / Report and offer the fix pass (default). Uses the security pass's reviewer switch
   * and budget.
   */
  threatModel?: Partial<import('./security/threats.ts').ThreatSettings>;
  /**
   * Phase 86: red-team mode (Settings → Coding → Coding projects): before a push / PR / release
   * (Off / Ask me (default) / Always), attacker scripts per run, its own token budget and time limit.
   */
  redteam?: Partial<import('./redteam.ts').RedTeamSettings>;
  /**
   * Phase 87 (computer use, docs/design/COMPUTER_USE.md §0.7): server-wide choices. `members`: household
   * members may let Sara use their OWN computers (off by default; owner only).
   */
  /**
   * Phase 87/88 (computer use): the member switch; how her actions in the Sara browser are approved
   * (level: ask every time / once per task (default) / always allowed, with a one-time warning), and the
   * site + action kinds the owner chose "Always" for on a card. Payments and account settings ask every time.
   */
  computerUse?: { members?: boolean; level?: 'ask' | 'task' | 'always'; alwaysWarned?: boolean; always?: { site: string; kind: string; at: string }[]; /** Phase 94: include the owner's browser extensions in check-ups (default on). */ checkupExtensions?: boolean };
  /** Discord bridge (Phase 6). Bot token lives in the vault (bridge:discord). */
  discord?: Partial<DiscordSettings>;
  /** Automatic backups (Phase 6). */
  backup?: Partial<BackupSettings>;
  /** Web push notifications (Phase 6). */
  push?: Partial<PushSettings>;
  /** Telegram bridge (Phase 6). Bot token lives in the vault (bridge:telegram). */
  telegram?: Partial<TelegramSettings>;
  /** Phase 107 (CH1): chat commands in the bridges (menus, her name as a command, the "nearly full" offer). */
  chats?: import('./bridges/commands.ts').ChatsSettings;
  /** Voice (Phase 5). Keys live in the vault (voice:openai, voice:elevenlabs). */
  voice?: Partial<VoiceSettings>;
  /** Messages Sara starts herself (Phase 4). */
  proactive?: Partial<ProactiveSettings>;
  /** Phase 103 (ST8): her own agenda (per companion, off by default; src/agenda.ts). */
  agenda?: Partial<import('./agenda.ts').AgendaSettings>;
  /** Phase 26: what may make her call you. */
  calls?: Partial<import('./calls.ts').CallRules>;
  /** Phase 29: the owner's Home Assistant address (the access token is in the vault). */
  home?: { url: string };
  /** Phase 31: companions share the first one's planner (default) or each keeps her own. */
  companionPlanner?: 'shared' | 'separate';
  /** Phase 44: one library per companion (default) or one shared by all. */
  companionLibrary?: 'shared' | 'separate';
  /** Phase 74: the library's limits and background reading (owner only; members follow them). */
  libraryLimits?: { maxMb?: number; memberMaxMb?: number; ocr?: 'ask' | 'local' | 'off'; speed?: 1 | 2 | 3 };
  /** Phase 32: companions share facts about the owner they each learned (default: each her own). */
  memorySharing?: 'own' | 'shared';
  /** Phase 53: the app language ('auto' = the browser's language, or a code from src/i18n.ts). */
  language?: string;
  /** Phase 53: the browser language the app reported while the language is Automatic. */
  languageDetected?: string;
  /** Phase 53: the language she talks in ('auto' = the language the owner writes in, else the app language). */
  talkLanguage?: string;
  /** Phase 53, per companion: the yearly look back on the anniversary of the first message (off by default). */
  story?: { yearly?: boolean; lastYear?: number };
  /** V1: the look a new device starts from ("Use on all my devices"; src/appearance.ts). */
  appearance?: import('./appearance.ts').Appearance;
  /** Phase 70: "Our moments": which photos enter the album by themselves (per companion). */
  moments?: Partial<import('./moments.ts').MomentsSettings>;
  /**
   * Phase 56: per provider: keep its model list up to date (default on); Ollama daemons: offer every
   * Ollama Cloud model (default: on when it has a cloud model) and remove retired cloud models (off).
   */
  modelLists?: Record<string, { keepCurrent?: boolean; ollamaCloud?: boolean; removeRetired?: boolean }>;
  /** Phase 56: a retired model in use switches to its replacement (default on); off = only warn. */
  modelAutoSwitch?: boolean;
  /**
   * Phase 57: other apps with an API key (OpenAI-compatible /v1 and MCP /mcp). `tools`: her own tools
   * in their turns (off by default); `changes`: MCP write tools (off by default); `origins`: browser
   * apps on other addresses allowed to call her (CORS; none by default).
   */
  otherApps?: { tools?: boolean; changes?: boolean; origins?: string[] };
  /**
   * Phase 100 (STAPLES §8): other agents (A2A). `enabled`: let other agents reach her (the public card
   * and /a2a; off by default); `showName`: her name on the public card (off: "Sara"); `operator`: the
   * label she answers for ("answering for …"); `lanInPrivate`: agents on the home network in private
   * local mode.
   */
  a2a?: { enabled?: boolean; showName?: boolean; operator?: string; lanInPrivate?: boolean };
  /** Phase 102 (ST7): webhooks (server-wide, the owner's): days the delivery log is kept (3/7/14/30/90; default 14). */
  hooks?: { keepDays?: number };
  /** Phase 121 (BEGIN §3.3): show *Add a routine* on Today's empty state and the wizard's last step (default true; per space). */
  routines?: { suggest?: boolean };
  /**
   * Phase 121 (BEGIN §3.3, owner-only): the safety check-up. `weekly`: the quiet weekly check (the
   * *Backup check* routine turns it on); `last`: the last weekly run's statuses (only a change posts);
   * `accepted`: ambers the owner marked "I know, don't warn me" (red can't be hidden).
   */
  /** Phase 123 (LEAN §3.3): the short tool list and tidying long chats (src/lean.ts normLean). */
  lean?: Partial<import('./lean.ts').LeanSettings>;
  /**
   * Phase 124 (SARA_STORE.md §6.2, §11.1, owner-only): the Sara Store. `on` (default true): once a
   * day Sara downloads the store's public list; off: no store reads at all. `community` (default
   * false): show add-ons nobody at Sara has reviewed yet (the *Get more* switch, Phase 125).
   */
  store?: { on?: boolean; community?: boolean };
  /** Phase 126 (WAKE.md §3.3): Hey Sara for this person: their phrases, where turns go, follow-up, sensitivity for new devices. */
  wake?: import('./wake.ts').WakeSettings;
  /** Phase 126: owner only (OWNER_SETTINGS): may devices on this server listen at all, and members too. */
  wakeServer?: { allowed?: boolean; members?: boolean };
  safetyCheck?: { weekly?: boolean; last?: { at: string; statuses: Record<string, 'green' | 'amber' | 'red' | 'skip'> }; accepted?: Record<string, string> };
  /**
   * Phase 72: her Alexa skill (server-wide, the owner's): the skill id from the Alexa developer
   * console (requests for any other skill are refused) and whether her Alexa replies use the quick
   * model (Settings → Models → Which model does what). Linked Alexa accounts are in <data>/alexa.json.
   */
  alexa?: { skillId?: string; quick?: boolean };
  /** Phase 72: smart-home presence through Home Assistant (per companion; off by default). */
  presence?: import('./presence.ts').PresenceSettings;
}

const FILE = 'settings.json';

/** Provider names from earlier versions, renamed to say where the provider runs. */
const RENAMED_LABELS: Record<string, string> = { 'Ollama (this server)': 'Ollama on the server', 'Ollama on the Sara server': 'Ollama on the server', 'Ollama Cloud': 'Ollama Cloud (API key)' };

export function migrateProviderLabels(s: Settings): Settings | undefined {
  if (!s.providers.some((p) => RENAMED_LABELS[p.label])) return undefined;
  return { ...s, providers: s.providers.map((p) => (RENAMED_LABELS[p.label] ? { ...p, label: RENAMED_LABELS[p.label] } : p)) };
}

/** A problem at start-up that the owner can fix (shown as a plain message, not a stack trace). */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

export class SettingsStore {
  readonly #path: string;
  #settings: Settings;
  /** In-process authority observation; called synchronously only after a successful save. */
  onUpdated?: (before: Readonly<Settings>, after: Readonly<Settings>) => void;

  constructor(dataDir: string) {
    this.#path = join(dataDir, FILE);
    let saved: Partial<Settings> = {};
    if (existsSync(this.#path)) {
      try {
        saved = JSON.parse(readFileSync(this.#path, 'utf8')) as Partial<Settings>;
      } catch (err) {
        throw new StartupError(`Her settings file ${this.#path} is damaged (${(err as Error).message}).`);
      }
    }
    this.#settings = { providers: [], ...saved };
  }

  get(): Settings {
    return structuredClone(this.#settings);
  }

  update(patch: Partial<Settings>): Settings {
    // Saved first: if the disk refuses, the running server keeps what is really on disk.
    const before = this.#settings;
    const next = { ...before, ...patch };
    writeFileAtomic(this.#path, JSON.stringify(next, null, 2) + '\n', 0o666);
    this.#settings = next;
    this.onUpdated?.(before, next);
    return this.get();
  }
}

/** Adult mode is on only after the owner turned it on (with the 18+ confirmation). */
export const adultModeOn = (s: Settings): boolean => s.adultMode?.on === true && Boolean(s.adultMode.confirmedAt);
