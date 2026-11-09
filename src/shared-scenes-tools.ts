// R1B2: the `scene_canon` model tool. The schema carries only the requested operation; the scene,
// conversation, author and source come from the host-bound `ToolContext.sceneCanon` capability
// (owner seats only, see sceneCanonForTurn). Missing capability denies. No model, network or child
// process calls: the capability is pure SQL.
import { en } from './i18n.ts';
import { CANON_KEY } from './shared-scenes.ts';
import { ToolError, type Tool } from './tools/types.ts';

export const SCENE_CANON_TOOL = 'scene_canon';
const FIELDS: Record<string, string[]> = { read: ['action'], set: ['action', 'key', 'text', 'expectedRevision'], retire: ['action', 'key', 'expectedRevision'] };

function valid(args: Record<string, unknown>): boolean {
  const action = args.action;
  if (typeof action !== 'string' || !Object.hasOwn(FIELDS, action)) return false;
  const keys = FIELDS[action];
  if (Object.keys(args).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(args, k))) return false;
  if (action === 'read') return true;
  if (typeof args.key !== 'string' || !CANON_KEY.test(args.key)) return false;
  if (!Number.isSafeInteger(args.expectedRevision) || (args.expectedRevision as number) < 1) return false;
  if (action === 'set' && (typeof args.text !== 'string' || !args.text.trim() || args.text.trim().length > 400)) return false;
  return true;
}

export function createSceneCanonTools(): Tool[] {
  return [{
    source: 'built-in', defaultPermission: 'auto',
    // Retiring removes a story fact from every linked chat: the owner approves each one.
    asksFirst: (args) => args.action === 'retire',
    spec: {
      name: SCENE_CANON_TOOL,
      description: "Read or change the canon of the shared roleplay scene this owner chat is linked to. Canon is fiction (story facts), never facts about a real person, instructions or permissions. read: title, premise, revision and current facts. set: save one fact under a short key (adds a version). retire: remove a fact (the owner approves). set and retire need the current revision from read as expectedRevision. Saving is not sending: nobody is told anything.",
      parameters: { type: 'object', additionalProperties: false, properties: {
        action: { type: 'string', enum: ['read', 'set', 'retire'] },
        key: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[a-z0-9][a-z0-9-]*$' },
        text: { type: 'string', minLength: 1, maxLength: 400 },
        expectedRevision: { type: 'integer', minimum: 1 },
      }, required: ['action'] },
    },
    summarize: (args) => args.action === 'retire' ? en('Retire a shared scene canon fact') : args.action === 'set' ? en('Save a shared scene canon fact') : en('Read the shared scene canon'),
    async run(args, ctx) {
      if (!ctx.sceneCanon) throw new ToolError(en('Shared scene canon is unavailable in this context.'));
      if (!['read', 'set', 'retire'].includes(args.action as string)) throw new ToolError('Choose read, set or retire for scene_canon.');
      if (!valid(args)) throw new ToolError('scene_canon arguments are invalid. read takes only action; set takes key, text and expectedRevision; retire takes key and expectedRevision.');
      if (args.action === 'read') return ctx.sceneCanon.read();
      if (args.action === 'set') return ctx.sceneCanon.set({ key: args.key as string, text: (args.text as string).trim(), expectedRevision: args.expectedRevision as number });
      return ctx.sceneCanon.retire({ key: args.key as string, expectedRevision: args.expectedRevision as number });
    },
  }];
}
