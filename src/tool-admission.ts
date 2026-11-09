import type { AppContext } from './chat.ts';
import type { Conversation } from './store.ts';
import type { Permission, Tool } from './tools/types.ts';

const SCOPE_FIELDS = ['id', 'createdAt', 'workspace', 'mode', 'private', 'partner', 'channel', 'channelKey', 'projectId', 'archivedAt', 'endedAt', 'sessionOf'] as const;
export type ToolScope = { conversation: Conversation; workspace: string; privateLocal: boolean };

/** Bind work before any model or approval wait; a later move never redirects it. */
export function captureToolScope(conversation: Conversation, workspace: string, privateLocal: boolean): ToolScope {
  return { conversation: { ...conversation }, workspace, privateLocal };
}

export class ToolAdmissionError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolAdmissionError'; }
}

export function assertCurrentScope(app: Pick<AppContext, 'store'>, scope: ToolScope, signal: AbortSignal, workspace: string, privateLocal: boolean): void {
  if (signal.aborted) throw new ToolAdmissionError('Cancelled.');
  const current = app.store.getConversation(scope.conversation.id);
  if (!current) throw new ToolAdmissionError('The original conversation is no longer available.');
  if (workspace !== scope.workspace || privateLocal !== scope.privateLocal || SCOPE_FIELDS.some(key => (current[key] ?? null) !== (scope.conversation[key] ?? null))) {
    throw new ToolAdmissionError('The conversation context changed while this action was pending. Please request it again in the current context.');
  }
}

/** Revalidation narrows authority; it never supplies an approval or changes the target. */
export function assertToolAdmission(app: Pick<AppContext, 'store' | 'settings' | 'tools'>, scope: ToolScope, tool: Tool, signal: AbortSignal, context: { workspace: string; privateLocal: boolean; offServer: boolean; network?: boolean }): Permission {
  assertCurrentScope(app, scope, signal, context.workspace, context.privateLocal);
  const name = tool.spec.name;
  if (app.tools.get(name) !== tool || (tool.isAvailable && !tool.isAvailable())) throw new ToolAdmissionError(`The ${name} tool is no longer available for this action.`);
  const permission = app.tools.permission(name, app.settings.get().toolPermissions);
  if (permission === 'never') throw new ToolAdmissionError(`The owner has disabled the ${name} tool.`);
  if (context.offServer && (scope.conversation.private || context.privateLocal)) throw new ToolAdmissionError('Tools that reach outside are paused by the current privacy policy.');
  if (tool.runsCommands && context.network && app.settings.get().shellNetwork === false) throw new ToolAdmissionError('Command network access changed while this action was pending. Please request it again with the current permissions.');
  return permission;
}
