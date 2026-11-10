// 3.1.2 (docs/RESEARCH.md): research_start, the chat's way into the research engine. Deep work
// (research, "find out everything about", a guide, learning a topic, a skill) used to happen as a
// long web_fetch loop inside the chat: guessed addresses, 404s, bot walls and a context that had to
// be compacted. This tool hands the question to a research run instead: it drafts a plan the owner
// approves with Start on the card, then works in the background with its own budget and context,
// and writes a cited report (goal "skill": also saved as a knowledge skill). The owner's only.
import type { AppContext } from '../chat.ts';
import { ResearchError } from '../research.ts';
import { str, ToolError, type Tool } from './types.ts';

export function createResearchTools(getApp: () => AppContext): Tool[] {
  return [
    {
      defaultPermission: 'auto',
      isAvailable: () => Boolean(getApp().research) && !getApp().research!.refusal(),
      spec: {
        name: 'research_start',
        description:
          'Start a research run for deep web work: when the owner asks you to research something, look into it properly, find out everything about it, compare options, make a guide, learn a topic or make a skill about it. It plans web searches (the owner sees the plan and presses Start), reads the pages the searches find in the background with its own budget, skips sites that block automated readers and writes a report where every sentence cites a page. Use it instead of many web_fetch calls. goal "skill" also saves what it learned as a knowledge skill she can answer from later. After calling it, tell the owner in one or two sentences that the plan is on the card; don\'t read pages yourself for the same question.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'What to research, as one clear question or topic in the owner\'s words.' },
            goal: { type: 'string', enum: ['report', 'skill'], description: '"report" (default): a cited report. "skill": the owner wants a guide or a skill; what is learned is saved as a knowledge skill too.' },
          },
          required: ['question'],
          additionalProperties: false,
        },
      },
      summarize: (a) => `research "${String(a.question ?? '').slice(0, 120)}"`,
      async run(args, ctx) {
        const app = getApp();
        if (!app.research) throw new ToolError('Research runs are not available here.');
        const goal = args.goal === 'skill' ? 'skill' : 'report';
        try {
          const run = app.research.create({ question: str(args, 'question'), goal, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) });
          return `Research run #${run.id} is drafting a plan for “${run.question}”${goal === 'skill' ? ' (skill)' : ''}. The plan appears on the card below in a moment; nothing is read until the owner presses Start. The run works in the background and its card shows progress and the report: don't fetch pages yourself for this question. Tell the owner the plan is ready to check.`;
        } catch (err) {
          if (err instanceof ResearchError) throw new ToolError(err.message);
          throw err;
        }
      },
    },
  ];
}
