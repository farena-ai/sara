// S10 (docs/CHOICES.md): pick-an-answer cards. At a real decision point she calls ask_choice; the
// call ends her turn with a card (the question, 2-8 options, her recommended one first and marked,
// "Other, type it out" last). The card is stored on her final message (`meta.choice`) whose text is
// the plain numbered list, so history, memory, A2A and chat apps without buttons read naturally.
// A pick is sent as the person's own message; the next message (a pick, a number, or anything they
// type) closes the card. Telegram and Discord draw it as buttons in the owner's DM (`ch:` data).
// Never an approval: those keep their own cards. Everything here is pure or works on the store.
import type { AppContext } from './chat.ts';
import { en } from './i18n.ts';
import type { Store } from './store.ts';
import { ToolError, type Tool } from './tools/types.ts';

export const ASK_CHOICE = 'ask_choice';
export const CHOICE_MIN = 2;
export const CHOICE_MAX = 8;

export interface ChoiceOption {
  label: string;
  detail?: string;
}
export interface Choice {
  question: string;
  options: ChoiceOption[];
  multi: boolean;
  /** Index of her recommended option (always 0: it is moved first). */
  recommended?: number;
  /** Multi-select picks so far (chat-app buttons toggle them). */
  picked?: number[];
  /** What closed it: the pick(s), or what they typed instead (`typed`). */
  answered?: string;
  typed?: boolean;
}

const clip = (v: unknown, n: number): string => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

/** Checks and tidies the tool's arguments (recommended moved first). */
export function parseChoice(args: Record<string, unknown>): Choice | { error: string } {
  const question = clip(args.question, 300);
  if (!question) return { error: 'ask_choice needs a question.' };
  const raw = Array.isArray(args.options) ? args.options : [];
  const options: ChoiceOption[] = raw.map((o) => {
    const r = (o && typeof o === 'object' ? o : { label: o }) as Record<string, unknown>;
    const detail = clip(r.detail, 120);
    return { label: clip(r.label, 80), ...(detail ? { detail } : {}) };
  });
  if (options.length < CHOICE_MIN || options.length > CHOICE_MAX) return { error: `ask_choice needs ${CHOICE_MIN} to ${CHOICE_MAX} options (got ${options.length}).` };
  if (options.some((o) => !o.label)) return { error: 'Every option needs a label.' };
  if (new Set(options.map((o) => fold(o.label))).size !== options.length) return { error: 'Two options have the same label.' };
  let rec: number | undefined;
  const want = args.recommended === undefined || args.recommended === null ? '' : String(args.recommended).trim();
  if (want) {
    const byLabel = options.findIndex((o) => fold(o.label) === fold(want));
    rec = byLabel >= 0 ? byLabel : /^\d{1,2}$/.test(want) && Number(want) >= 1 && Number(want) <= options.length ? Number(want) - 1 : undefined;
  }
  if (rec !== undefined) options.unshift(...options.splice(rec, 1));
  return { question, options, multi: args.multi === true, ...(rec !== undefined ? { recommended: 0 } : {}) };
}

/** The plain-text card: the question, the numbered options, how to answer (`tr` translates app words). */
export function choiceText(c: Choice, tr: (s: string) => string): string {
  const lines = c.options.map((o, i) => `${i + 1}. ${o.label}${c.recommended === i ? ` ${tr(en('(recommended)'))}` : ''}${o.detail ? `: ${o.detail}` : ''}`);
  return [c.question, ...lines, tr(c.multi ? en('Reply with one or more numbers (like 1, 3) or type your own.') : en('Reply with a number or type your own.'))].join('\n');
}

/** The message a pick sends (multi: the labels in the card's order). */
export function pickText(c: Choice, picks: number[]): string {
  return [...new Set(picks)].sort((a, b) => a - b).map((i) => c.options[i]?.label).filter(Boolean).join(', ');
}

/** The newest card in a conversation that still waits (no later message from them, not answered). */
export function openChoice(store: Store, conversationId: string): { message: { id: number }; choice: Choice } | undefined {
  const page = store.messagesPage(conversationId, { limit: 40 }).messages;
  const at = page.findLastIndex((m) => m.role === 'assistant' && m.meta?.choice);
  if (at < 0) return undefined;
  const m = page[at];
  const choice = m.meta!.choice as Choice;
  if (choice.answered !== undefined || page.slice(at + 1).some((x) => x.role === 'user')) return undefined;
  return { message: { id: m.id }, choice };
}

/** What a typed answer picks: "2", "1, 3", or an option's label; otherwise nothing. */
export function picksOf(c: Choice, text: string): number[] | undefined {
  const t = text.trim();
  if (/^\d{1,2}(\s*(,|and|\s)\s*\d{1,2})*\.?$/i.test(t)) {
    const nums = t.match(/\d{1,2}/g)!.map((n) => Number(n) - 1);
    if (nums.every((n) => n >= 0 && n < c.options.length) && (c.multi || nums.length === 1)) return nums;
    return undefined;
  }
  const parts = c.multi ? t.split(/\s*,\s*/) : [t];
  const idx = parts.map((p) => c.options.findIndex((o) => fold(o.label) === fold(p)));
  return idx.length && idx.every((i) => i >= 0) ? idx : undefined;
}

/** A new message from them closes the open card: a pick (by label or number) or something else typed. */
export function settleChoice(store: Store, conversationId: string, text: string): void {
  const open = openChoice(store, conversationId);
  if (!open) return;
  const picks = picksOf(open.choice, text);
  const answered = picks ? pickText(open.choice, picks) : clip(text, 200);
  store.updateMessageMeta(open.message.id, { choice: { ...open.choice, answered, ...(picks ? {} : { typed: true }) } });
}

/** Chat-app buttons for a card (`ch:<message id>:<n | o (other) | s (send, multi)>`). */
export function choiceButtons(messageId: number, c: Choice, tr: (s: string) => string): { label: string; data: string }[] {
  const picked = new Set(c.picked ?? []);
  return [
    ...c.options.map((o, i) => ({ label: `${c.multi && picked.has(i) ? '✓ ' : ''}${o.label}${c.recommended === i ? ` ${tr(en('(recommended)'))}` : ''}`, data: `ch:${messageId}:${i}` })),
    { label: tr(en('Other, type it out')), data: `ch:${messageId}:o` },
    ...(c.multi ? [{ label: tr(en('Send')), data: `ch:${messageId}:s` }] : []),
  ];
}

/**
 * A chat-app button press (the bridge checked it's the owner). `send`: run a turn with this as his
 * message; `edit`: the card's new text (buttons removed); `buttons`: redraw them (multi toggles).
 */
export function choiceButton(app: AppContext, data: string, tr: (s: string) => string = (s) => s): { text: string; send?: string; edit?: string; buttons?: { label: string; data: string }[] } | undefined {
  const m = /^ch:(\d{1,12}):(\d|o|s)$/.exec(data);
  if (!m) return undefined;
  const msg = app.store.messageById(Number(m[1]));
  const open = msg ? openChoice(app.store, msg.conversationId) : undefined;
  if (!open || open.message.id !== msg!.id) return { text: tr(en('No longer waiting')) };
  const c = open.choice;
  if (m[2] === 'o') return { text: tr(en('Type your answer.')) };
  const close = (answered: string) => {
    app.store.updateMessageMeta(open.message.id, { choice: { ...c, answered } });
    return { text: `✓ ${answered}`, send: answered, edit: `${c.question}\n✓ ${answered}` };
  };
  if (m[2] === 's') return c.picked?.length ? close(pickText(c, c.picked)) : { text: tr(en('Pick at least one first.')) };
  const n = Number(m[2]);
  if (n >= c.options.length) return { text: tr(en('No longer waiting')) };
  if (!c.multi) return close(c.options[n].label);
  const picked = new Set(c.picked ?? []);
  if (picked.has(n)) picked.delete(n);
  else picked.add(n);
  const next = { ...c, picked: [...picked].sort((a, b) => a - b) };
  app.store.updateMessageMeta(open.message.id, { choice: next });
  return { text: picked.has(n) ? `✓ ${c.options[n].label}` : c.options[n].label, buttons: choiceButtons(open.message.id, next, tr) };
}

/** The model tool. Its run only checks the arguments; chat.ts ends the turn with the card. */
export function createAskChoiceTool(): Tool {
  return {
    spec: {
      name: ASK_CHOICE,
      description: 'Ask the person to pick from a few clear options: they see buttons (one, or several with multi) and "Other, type it out". Put your recommended option in recommended. Ends your turn; their pick comes back as their next message. Only at real decision points, sparingly; never for approvals of your own actions (those have their own cards).',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'The question, short.' },
          options: { type: 'array', minItems: CHOICE_MIN, maxItems: CHOICE_MAX, items: { type: 'object', properties: { label: { type: 'string', description: 'A few words.' }, detail: { type: 'string', description: 'Optional short note.' } }, required: ['label'] } },
          multi: { type: 'boolean', description: 'They may pick more than one.' },
          recommended: { type: 'string', description: 'The label of the option you recommend.' },
        },
        required: ['question', 'options'],
      },
    },
    defaultPermission: 'auto',
    interruptible: true,
    summarize: (a) => `Ask: ${clip(a.question, 80)}`,
    async run(args) {
      const c = parseChoice(args);
      if ('error' in c) throw new ToolError(c.error);
      return `Shown as a card with ${c.options.length} options. Stop here: their answer comes as their next message.`;
    },
  };
}
