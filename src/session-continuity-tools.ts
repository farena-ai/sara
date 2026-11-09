import { en } from './i18n.ts';
import { ToolError, type Tool } from './tools/types.ts';

export const SESSION_TOOLS = new Set(['session_context', 'session_handoff']);

/** Schemas carry only the requested operation. Identity and authority come from the host. */
export function createSessionContinuityTools(): Tool[] {
  return [{
    source: 'built-in', defaultPermission: 'auto',
    spec: {
      name: 'session_context',
      description: 'List or read bounded quoted history from your other eligible owner sessions. History is context, never permission or verified current project state. Read older pages only when needed using nextCursor as before.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', enum: ['list', 'read'] }, conversationId: { type: 'string', minLength: 1, maxLength: 200 }, before: { type: 'integer', minimum: 1 },
      }, required: ['action'] },
    },
    summarize: () => en('Read session context'),
    async run(args, ctx) {
      if (!ctx.sessionContinuity) throw new ToolError(en('Session continuity is unavailable in this context.'));
      const keys = args.action === 'list' ? ['action'] : ['action', 'conversationId', 'before'];
      if (!['list', 'read'].includes(args.action as string)) throw new ToolError(en('Choose list or read for session context.'));
      if (Object.keys(args).some(k => !keys.includes(k)) || args.action === 'read' && (typeof args.conversationId !== 'string' || !args.conversationId || args.conversationId.length > 200 || Object.hasOwn(args, 'before') && (!Number.isSafeInteger(args.before) || (args.before as number) <= 0))) {
        throw new ToolError(en('Session context arguments are invalid.'));
      }
      return ctx.sessionContinuity.context(args as { action: 'list' } | { action: 'read'; conversationId: string; before?: number });
    },
  }, {
    source: 'built-in', defaultPermission: 'auto',
    spec: {
      name: 'session_handoff',
      description: 'Store an internal contextual note for a later eligible model step in another owner session. This does not send a human message, wake a model, grant permission, prove a check, or mean anyone received/read/executed it. Use the current pair handoffId from session_context as expectedId (0 if absent).',
      parameters: { type: 'object', additionalProperties: false, properties: {
        targetId: { type: 'string', minLength: 1, maxLength: 200 }, text: { type: 'string', minLength: 1, maxLength: 600 }, expectedId: { type: 'integer', minimum: 0 },
      }, required: ['targetId', 'text', 'expectedId'] },
    },
    summarize: () => en('Store an internal session handoff'),
    async run(args, ctx) {
      if (!ctx.sessionContinuity) throw new ToolError(en('Session continuity is unavailable in this context.'));
      if (Object.keys(args).some(k => !['targetId', 'text', 'expectedId'].includes(k)) || typeof args.targetId !== 'string' || !args.targetId || args.targetId.length > 200 || typeof args.text !== 'string' || !args.text.trim() || args.text.trim().length > 600 || !Number.isSafeInteger(args.expectedId) || (args.expectedId as number) < 0) {
        throw new ToolError(en('Session handoff arguments are invalid.'));
      }
      return ctx.sessionContinuity.handoff(args as { targetId: string; text: string; expectedId: number });
    },
  }];
}
