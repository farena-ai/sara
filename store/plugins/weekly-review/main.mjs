import { plugin } from './sara-plugin.mjs';
import { options, object, identifier, text, lines, refine, result, schema, idSchema, textSchema } from './workflow.mjs';
import translations from './labels.json' with { type: 'json' };
const title = 'Weekly review';
const description = 'Turn supplied accomplishments and explicitly done, pending or blocked commitments into a proposed next plan. Never changes tasks or calendars.';
const tools = [{ name: 'review', description, permission: 'ask', parameters: schema({ accomplishments: textSchema(5000, 'At most 80 lines. Empty allowed only with commitments. Combined accomplishments and JSON-serialized commitments at most 5000 code units.', true), commitments: { type: 'array', minItems: 0, maxItems: 20, description: 'Unique IDs; supply accomplishments or commitments. Pending items keep supplied order.', items: { type: 'object', additionalProperties: false, properties: { id: idSchema, text: textSchema(300, 'Supplied commitment.'), status: { type: 'string', enum: ['done', 'pending', 'blocked'] } }, required: ['id', 'text', 'status'] } } }, ['accomplishments', 'commitments']), run: async (input, sara) => {
  const args = options(input, ['accomplishments', 'commitments']);
  text(args.accomplishments, 'accomplishments', 5000, true);
  if (!Array.isArray(args.commitments) || args.commitments.length > 20) throw new Error('commitments must be an array of at most 20 items.');
  const seen = new Set();
  const commitments = args.commitments.map((c) => {
    object(c, ['id', 'text', 'status'], 'commitment'); identifier(c.id); text(c.text, 'commitment text', 300);
    if (seen.has(c.id)) throw new Error('Duplicate commitment ID.'); seen.add(c.id);
    if (!['done', 'pending', 'blocked'].includes(c.status)) throw new Error('Commitment status must be done, pending or blocked.');
    return { ...c, source: 'commitments', quote: c.text, verification: 'user-reported status' };
  });
  if (!args.accomplishments.trim() && !commitments.length) throw new Error('Supply accomplishments or commitments; empty week is unknown, not completed.');
  const context = [{ id: 'accomplishments', label: 'User-reported accomplishments', text: args.accomplishments }, { id: 'commitments', label: 'User-supplied commitments and explicit statuses', text: JSON.stringify(args.commitments) }];
  if (context.reduce((n, s) => n + s.text.length, 0) > 5000) throw new Error('Combined weekly context exceeds 5000 characters. Split it explicitly; nothing was processed.');
  const report = { status: 'proposed-review-not-applied', accomplishments: lines(context[0]), done: commitments.filter((c) => c.status === 'done'), pending: commitments.filter((c) => c.status === 'pending'), blocked: commitments.filter((c) => c.status === 'blocked'), proposedPlan: commitments.filter((c) => c.status === 'pending').map((c, i) => ({ ...c, position: i + 1, proposal: 'Consider next week; not scheduled' })), tasksChanged: false, unknowns: ['No calendar, task system or private memory inspected.', 'No week dates, timezone, deadlines or completion were inferred. Plan follows supplied order; blocked items need a resolution before scheduling.'] };
  if (args.refine) report.model = await refine(sara, context, 'Weekly review: propose a feasible plan and blocker questions; keep done separate from pending; no task completion claims', args.language);
  return result(title, report, translations[sara.lang] ?? {});
} }];
plugin({ tools, init: (sara) => { tools[0].description = translations[sara.lang]?.[description] ?? description; } });
