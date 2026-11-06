import { plugin } from './sara-plugin.mjs';
import { options, sources, lines, refine, result, schema, sourceSchema } from './workflow.mjs';
import translations from './labels.json' with { type: 'json' };
const title = 'Project handoff';
const description = 'Build an evidence-tagged handoff from supplied changed, tested, pending and blocker context. Does not scan projects or award verification.';
const roles = ['changed', 'tested', 'pending', 'blockers'];
const tools = [{ name: 'snapshot', description, permission: 'ask', parameters: schema({ sources: { ...sourceSchema, items: { ...sourceSchema.items, properties: { ...sourceSchema.items.properties, role: { type: 'string', enum: roles } }, required: ['id', 'label', 'text', 'role'] } } }, ['sources']), run: async (input, sara) => {
  const args = options(input, ['sources']);
  const context = sources(args.sources, roles);
  const sections = Object.fromEntries(roles.map((role) => [role, context.filter((s) => s.role === role).flatMap(lines).map((e) => ({ ...e, verification: 'user-supplied; not independently verified' }))]));
  const report = { status: 'supplied-evidence-snapshot', independentlyVerified: false, sections, unknowns: roles.filter((role) => !sections[role].length).map((role) => `No ${role} context supplied.`), scope: 'Supplied context only. No workspace, Git, private session, checkpoint, deployment or test execution inspected.' };
  if (args.refine) report.model = await refine(sara, context, 'Project handoff: identify gaps and next steps; supplied test claims remain unverified, never certify completion', args.language);
  return result(title, report, translations[sara.lang] ?? {});
} }];
plugin({ tools, init: (sara) => { tools[0].description = translations[sara.lang]?.[description] ?? description; } });
