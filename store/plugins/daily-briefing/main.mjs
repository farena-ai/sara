import { plugin } from './sara-plugin.mjs';
import { options, sources, lines, refine, result, schema, sourceSchema } from './workflow.mjs';
import translations from './labels.json' with { type: 'json' };
const title = 'Daily briefing';
const description = 'Assemble an on-demand briefing from explicitly supplied agenda, priorities and notes. No live account reads.';
const tools = [{ name: 'brief', description, permission: 'ask', parameters: schema({ sources: sourceSchema }, ['sources']), run: async (input, sara) => {
  const args = options(input, ['sources']);
  const context = sources(args.sources);
  const sections = Object.fromEntries(context.map((s) => [s.id, lines(s)]));
  const report = { status: 'assembled-from-supplied-context', sources: context.map(({ id, label }) => ({ id, label })), sections, unknowns: ['Live calendar, weather and inbox were not checked.', 'Dates, timezone, priorities and freshness are only as supplied; no current-day inference.'] };
  if (args.refine) report.model = await refine(sara, context, 'Daily briefing: propose priorities and identify missing context', args.language);
  return result(title, report, translations[sara.lang] ?? {});
} }];
plugin({ tools, init: (sara) => { tools[0].description = translations[sara.lang]?.[description] ?? description; } });
