// S11 (docs/WRITING_STYLE.md): humanize_text, "Make it sound human" in chat. Rewrites a text (an email
// draft, a summary, a letter) in plain, natural words with the facts locked; `voice` applies the
// person's own style card. A child gets coaching on their own draft instead of a rewrite.
import type { AppContext } from '../chat.ts';
import { coachText, HUMANIZE_MAX_CHARS, humanize, isChild } from '../humanize.ts';
import { HttpError } from '../http.ts';
import { ToolError, type Tool } from './types.ts';

export const HUMANIZE_TEXT = 'humanize_text';

export function createHumanizeTool(getApp: () => AppContext): Tool {
  return {
    spec: {
      name: HUMANIZE_TEXT,
      description:
        "Make a text sound human: rewrite it in plain, everyday words with varied sentences and no stock AI phrases (delve, tapestry, in conclusion…), keeping every number, name, quote, citation and link exactly. Use it when the person asks to make something sound more natural, less stiff or more like them, for an email draft, summary, letter or any text. voice: true matches the person's own writing style (from their samples in Settings). For a child it gives suggestions on their own draft instead of rewriting it. Returns the new text and a 'reads natural' score before and after.",
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The whole text to rewrite.' },
          voice: { type: 'boolean', description: "Optional: match the person's own voice (their style card)." },
          words: { type: 'number', description: 'Optional: the length they asked for, in words (kept within 15%).' },
        },
        required: ['text'],
      },
    },
    defaultPermission: 'auto',
    interruptible: true,
    summarize: (a) => `Make it sound human (${String(a.text ?? '').split(/\s+/).filter(Boolean).length} words)`,
    run: async (args, ctx) => {
      const app = getApp();
      const text = String(args.text ?? '');
      if (!text.trim()) throw new ToolError('Send the text to rewrite.');
      if (text.length > HUMANIZE_MAX_CHARS) throw new ToolError('That text is too long to rewrite in one go (up to 40,000 characters): split it into parts.');
      if (isChild(app)) return coachText(text);
      try {
        const words = Number(args.words);
        const r = await humanize(app, text, { voice: args.voice === true, ...(words > 0 ? { targetWords: Math.round(words) } : {}), ...(ctx?.signal ? { signal: ctx.signal } : {}) });
        const score = `Reads natural: ${r.check.after.score}/100 (was ${r.check.before.score}/100).`;
        if (r.kept === 'original') return `I kept it as written (${r.reason ?? 'no better version'}). ${score}\n\n${r.before}`;
        return `${r.kept === 'repaired' ? 'Rewritten; a few sentences kept as written so every fact stays exact.' : 'Rewritten with every number, name, quote, citation and link kept.'}${r.voice ? ' Matched to their own voice.' : ''} ${score} Give them this text:\n\n${r.after}`;
      } catch (err) {
        if (err instanceof HttpError) throw new ToolError(err.message);
        throw err;
      }
    },
  };
}
