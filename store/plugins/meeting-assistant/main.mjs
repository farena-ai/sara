import { plugin } from './sara-plugin.mjs';
import { options, text, lines, refine, result, schema, textSchema } from './workflow.mjs';
import translations from './labels.json' with { type: 'json' };
const title = 'Meeting assistant';
const description = 'Extract explicitly labelled decisions, actions and questions from a supplied transcript with line references. Never records or creates tasks.';
const tools = [{ name: 'extract', description, permission: 'ask', parameters: schema({ transcript: textSchema(5000, 'Supplied transcript, at most 80 lines including empty lines.') }, ['transcript']), run: async (input, sara) => {
  const args = options(input, ['transcript']);
  const source = { id: 'transcript', label: 'User-supplied transcript (not recorded by this plugin)', text: text(args.transcript, 'transcript') };
  const report = { status: 'labelled-extraction', recorded: false, tasksCreated: false, decisions: [], actions: [], questions: [], unclassified: [], unknowns: ['Only explicit Decision:, Action:, Question: prefixes are classified. Other lines are preserved for review.', 'Meeting attendance, consent and transcript accuracy are not verified.'] };
  for (const evidence of lines(source)) {
    const match = /^(Decision|Action|Question):\s*(.+)$/i.exec(evidence.quote);
    if (!match) { report.unclassified.push(evidence); continue; }
    const [body, ...metadata] = match[2].split('|').map((s) => s.trim());
    if (match[1].toLowerCase() === 'action') {
      const owners = metadata.filter((m) => m.startsWith('owner=')).map((m) => m.slice(6).trim());
      const dates = metadata.filter((m) => m.startsWith('due=')).map((m) => m.slice(4).trim());
      const owner = owners.length === 1 && owners[0] ? owners[0] : null;
      const dueRaw = dates.length === 1 ? dates[0] : null;
      const parsedDate = dueRaw && /^\d{4}-\d{2}-\d{2}$/.test(dueRaw) ? new Date(`${dueRaw}T00:00:00Z`) : null;
      const due = parsedDate && !Number.isNaN(parsedDate.valueOf()) && parsedDate.toISOString().slice(0, 10) === dueRaw ? dueRaw : null;
      if (owners.length > 1 || dates.length > 1 || (dates.length && !due)) report.unknowns.push(`${evidence.ref}: ambiguous owner/deadline metadata left unset; review the exact quote.`);
      if (!body) { report.unclassified.push(evidence); continue; }
      report.actions.push({ ...evidence, text: body, owner, due, status: 'proposed-action-not-created' });
    } else report[match[1].toLowerCase() === 'decision' ? 'decisions' : 'questions'].push({ ...evidence, text: match[2] });
  }
  if (args.refine) report.model = await refine(sara, [source], 'Meeting review: suggest decisions/actions/questions with exact transcript evidence; do not infer owners or dates', args.language);
  return result(title, report, translations[sara.lang] ?? {});
} }];
plugin({ tools, init: (sara) => { tools[0].description = translations[sara.lang]?.[description] ?? description; } });
