import { plugin } from './sara-plugin.mjs';
import { options, text, sources, lines, refine, result, schema, sourceSchema, textSchema } from './workflow.mjs';
import translations from './labels.json' with { type: 'json' };
const title = 'Document desk';
const description = 'Compare two supplied texts by exact lines or extract literal query matches, keeping source labels and line references. No file conversion.';
const requirements = "compare requires exactly two sources and forbids query; extract requires query and 1–12 sources.";
const tools = [{ name: 'inspect', description: `${requirements} ${description}`, permission: 'ask', parameters: schema({ sources: sourceSchema, mode: { type: 'string', enum: ['compare', 'extract'] }, query: textSchema(200, 'Required only for extract; forbidden for compare.') }, ['mode', 'sources']), run: async (input, sara) => {
  const args = options(input, ['sources', 'mode', 'query']);
  const context = sources(args.sources);
  const report = { status: 'literal-text-analysis', sources: context.map(({ id, label }) => ({ id, label })), unknowns: ['Only supplied text inspected; no original file, hidden content, pages, formatting or external facts verified.'] };
  if (args.mode === 'compare') {
    if (context.length !== 2) throw new Error('Compare requires exactly two labelled sources.');
    if (args.query !== undefined) throw new Error('query is only valid in extract mode.');
    const [left, right] = context.map(lines);
    report.onlyLeft = left.filter((l) => !right.some((r) => r.quote === l.quote));
    report.onlyRight = right.filter((r) => !left.some((l) => r.quote === l.quote));
    report.shared = left.filter((l) => right.some((r) => r.quote === l.quote));
    report.method = 'Exact line set comparison; not semantic or ordered diff. Duplicate occurrences retain their own line references.';
  } else if (args.mode === 'extract') {
    const query = text(args.query, 'query', 200).toLocaleLowerCase();
    report.matches = context.flatMap(lines).filter((l) => l.quote.toLocaleLowerCase().includes(query));
    report.method = 'Case-insensitive literal substring match, not a regular expression or semantic search.';
    if (!report.matches.length) report.unknowns.push('No supplied line matched; absence outside supplied text is unknown.');
  } else throw new Error('mode must be compare or extract.');
  if (args.refine) report.model = await refine(sara, context, `Document ${args.mode}: propose source-grounded observations; no invented page citations`, args.language);
  return result(title, report, translations[sara.lang] ?? {});
} }];
plugin({ tools, init: (sara) => { tools[0].description = `${translations[sara.lang]?.[requirements] ?? requirements} ${translations[sara.lang]?.[description] ?? description}`; } });
