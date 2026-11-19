// U4.23 (docs/LEARNING.md "Learning coach"): her study tools. study_make turns a Library document,
// one of its chapters or pasted text into a study set (one model call, capped). study_quiz asks the
// next due card: a multiple-choice card becomes an S10 choice card in the chat (chat.ts reads it with
// takeQuizChoice); other cards are asked as a question. study_answer grades what they said (kind
// feedback; in kid mode a hint before any answer). study_list shows the sets and what is due.
// Everything stays in the person's own space; nothing leaves the server but the one model call.
import { type AppContext } from '../chat.ts';
import type { Choice } from '../choices.ts';
import { StudyError, studyFor } from '../study.ts';
import { ToolError, type Tool } from './types.ts';

const quizChoices = new WeakMap<object, Choice>();
/** The choice card a study_quiz call asked (once), for chat.ts to show like ask_choice. */
export function takeQuizChoice(args: Record<string, unknown>): Choice | undefined {
  const c = quizChoices.get(args);
  quizChoices.delete(args);
  return c;
}
const guard = async <T>(f: () => Promise<T> | T): Promise<T> => {
  try {
    return await f();
  } catch (err) {
    if (err instanceof StudyError) throw new ToolError(err.message);
    throw err;
  }
};
const num = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  return Number.isInteger(n) && n > 0 ? n : undefined;
};

export function createStudyTools(getApp: () => AppContext): Tool[] {
  const study = () => studyFor(getApp());
  return [
    {
      defaultPermission: 'auto',
      spec: {
        name: 'study_make',
        description:
          'Make a study set (flashcards, cloze cards, quiz questions and a summary sheet) from a Library document, one of its chapters (section id from the library tool\'s contents action) or text the person pasted. Use when they want to study, learn, revise or be quizzed on something. Cards then come back by spaced repetition; the Study page (Library → Study) and the Today tile show what is due.',
        parameters: {
          type: 'object',
          properties: {
            doc: { type: 'number', description: 'Library document id.' },
            section: { type: 'number', description: 'A chapter/section id of that document (optional).' },
            text: { type: 'string', description: 'Pasted text to study (when there is no document).' },
            title: { type: 'string' },
          },
        },
      },
      summarize: (a) => `Make a study set${a.title ? `: ${String(a.title)}` : ''}`,
      run: async (a, ctx) =>
        guard(async () => {
          const s = study();
          const set = await s.make({ ...(num(a.doc) ? { docId: num(a.doc) } : {}), ...(num(a.section) ? { section: num(a.section) } : {}), ...(typeof a.text === 'string' ? { text: a.text } : {}), ...(typeof a.title === 'string' ? { title: a.title } : {}), signal: ctx.signal });
          const cards = s.cards(set.id);
          const kinds = ['basic', 'cloze', 'choice', 'short'].map((k) => `${cards.filter((c) => c.kind === k).length} ${k}`).join(', ');
          return `Made study set #${set.id} "${set.title}": ${cards.length} cards (${kinds}).${set.summary.length ? `\nSummary sheet:\n${set.summary.map((x) => `- ${x}`).join('\n')}` : ''}${set.coach ? '\nThis is their homework: the cards coach with guiding steps and never hold the answers. Never give the answers yourself.' : ''}\nOffer to quiz them now (study_quiz) or to study on the Study page.`;
        }),
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: {
        name: 'study_list',
        description: 'List their study sets with progress and how many cards are due today.',
        parameters: { type: 'object', properties: {} },
      },
      summarize: () => 'Study sets',
      run: async () =>
        guard(() => {
          const s = study();
          const sets = s.list();
          if (!sets.length) return 'No study sets yet. study_make makes one from a Library document or pasted text.';
          return sets.slice(0, 30).map((x) => {
            const p = s.progress(x.id);
            return `#${x.id} ${x.title}: ${p.cards} cards, ${p.learned} learned (${p.pct}%), ${p.due} due today${p.streak ? `, ${p.streak}-day streak` : ''}`;
          }).join('\n');
        }),
    },
    {
      defaultPermission: 'auto',
      changes: false,
      spec: {
        name: 'study_quiz',
        description: 'Ask them the next due card of a study set (or of all sets). A multiple-choice card is shown as a pick-an-answer card; for others ask the question in your words and wait. When they answer, call study_answer with the card number and their words. Never say the answer before they tried.',
        parameters: { type: 'object', properties: { set: { type: 'number', description: 'Study set id (optional: all sets).' } } },
      },
      summarize: () => 'Quiz',
      run: async (a) =>
        guard(() => {
          const s = study();
          const setId = num(a.set);
          if (setId && !s.get(setId)) throw new StudyError(404, 'Study set not found.');
          const c = s.next(setId);
          if (!c) return 'Nothing is due right now: every card is learned for today. Tell them when the next ones come back, or offer a new set.';
          const left = s.dueCount(setId);
          const hint = c.hint ? ` Hint if they are stuck (not before they tried): ${c.hint}` : '';
          if (c.kind === 'choice' && c.choices) {
            quizChoices.set(a, { question: c.front, options: c.choices.map((label) => ({ label })), multi: false });
            return `Asked card ${c.id} as a pick-an-answer card (${left} due). When they pick, call study_answer {card: ${c.id}, answer: <their pick>}.${hint}`;
          }
          return `Card ${c.id} (${c.kind}, ${left} due): ask them "${c.front}"${c.kind === 'cloze' ? ' (fill in the […])' : ''} and wait for their answer, then call study_answer {card: ${c.id}, answer: <their words>}.${hint}`;
        }),
    },
    {
      defaultPermission: 'auto',
      spec: {
        name: 'study_answer',
        description: 'Grade their answer to a study card (multiple choice by itself, a short answer against its rubric) and schedule the card again. Pass on the feedback kindly; then offer the next card (study_quiz).',
        parameters: { type: 'object', properties: { card: { type: 'number' }, answer: { type: 'string' } }, required: ['card', 'answer'] },
      },
      summarize: () => 'Check the answer',
      run: async (a) =>
        guard(async () => {
          const id = num(a.card);
          if (!id) throw new ToolError('Which card? Give its number from study_quiz.');
          const r = await study().answer(id, String(a.answer ?? ''));
          return `${r.correct ? 'Right.' : r.score === 1 ? 'Partly right.' : 'Not right yet.'} Feedback to pass on: ${r.feedback}${r.answer ? '' : ' (Do not give the answer: let them try again with the hint.)'}`;
        }),
    },
  ];
}
