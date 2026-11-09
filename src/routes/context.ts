// What the route modules (src/routes/*.ts) share with createSaraServer() in src/server.ts.
// Built once per server from the closure's own values; each module destructures what it uses,
// so the code moved there reads exactly as it did in server.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AlexaService } from '../alexa.ts';
import type { OwnerAuth } from '../auth.ts';
import type { AppContext, ChatEvent, TurnOptions } from '../chat.ts';
import type { DemoCallGate } from '../demo-calls.ts';
import type { AppInfo } from '../health.ts';
import type { LiveCall } from '../live.ts';
import type { Project } from '../planner.ts';
import type { ServerOptions } from '../server.ts';
import type { Speech } from '../speech.ts';
import type { Store } from '../store.ts';
import type { Updater } from '../updates.ts';
import type { VideoSessions } from '../video.ts';

export interface ActiveTurn {
  controller: AbortController;
  startedAt: string;
  status: 'thinking' | 'writing' | 'running' | 'waiting';
  detail: string;
  approvals: Map<string, Extract<ChatEvent, { type: 'approval' }>>;
}

/** A route module's answer for a request that isn't one of its routes: api() tries the next one. */
export const NEXT = Symbol('next route');
/** A route module: handles the request (any other value) or answers NEXT. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, method: string, parts: string[]) => Promise<unknown>;

/** The closure values the route modules use (see createSaraServer). */
export interface RouteCtx {
  active: Map<string, ActiveTurn>;
  app: AppContext;
  me: (t: string) => string;
  offStore: Store;
  opts: ServerOptions;
  projectOrThrow: (raw: unknown) => Project;
  rootDir: string;
  alexa: AlexaService;
  auth: OwnerAuth;
  ctxOf: (id: string) => AppContext;
  demoOwner: Map<string, string>;
  spaceId: string;
  visitorKey: (req: IncomingMessage) => string;
  webRoot: string;
  prunePush: () => void;
  requireDisclosure: (req: IncomingMessage) => void;
  runBackground: (conversationId: string, content: string, opts?: TurnOptions) => Promise<void>;
  streamChat: (req: IncomingMessage, res: ServerResponse, conversationId: string, content: string, opts?: TurnOptions) => Promise<void>;
  info: AppInfo;
  updater: Updater;
  demoCalls: DemoCallGate;
  grokSignedIn: () => ReturnType<Speech['grokSignedIn']>;
  speech: Speech;
  videos: VideoSessions;
  xaiKey: () => ReturnType<Speech['xaiKey']>;
  xaiKeySync: () => ReturnType<Speech['xaiKeySync']>;
  /** The live call going on (read and set through the closure). */
  liveCall: LiveCall | undefined;
  demoAccepted: Set<string>;
  isAuthed: (req: IncomingMessage) => boolean;
  /** C15: throws 428 (with a code) when a remote device asks for a sensitive action not approved yet. */
  askFirst: (req: IncomingMessage, action: import('../device-approval.ts').SensitiveAction) => void;
  /** Phase 57 / C3: an approval card for a change another app (or an MCP App) asked for. */
  requestApproval: (conversationId: string, name: string, summary: string, args: Record<string, unknown>, run: () => Promise<string>, onDone?: (r: { ok: boolean; status: string; text: string }) => void) => void;
  offApp: AppContext;
}
