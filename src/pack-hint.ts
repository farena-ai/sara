// R2 (src/get-started.ts): a starter pack's one line for her system notes. Its own small module with
// no imports of the app's stores, so src/chat.ts can read it without an import cycle.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PACK_HINTS = {
  household: 'They use Sara for a household: bills, groceries, family dates, chores and deliveries. Keep suggestions practical and family-friendly.',
  business: 'They run a small business: clients, quotes, invoices, bookkeeping and follow-ups. Be concise and businesslike; offer an invoice or a follow-up when it fits.',
  sales: 'They work in sales: leads, meetings, follow-ups and a pipeline. Keep answers short and action-first; suggest the next step and a follow-up date.',
  student: 'They are a student: classes, assignments, exams, a budget and a part-time schedule. Explain clearly, help them plan, and never write graded work for them to hand in as their own.',
} as const;

/** The pack's line for her system notes (undefined without a pack). Reads the person's own get-started.json. */
export function packNote(app: { dataDir: string }): string | undefined {
  try {
    const id = (JSON.parse(readFileSync(join(app.dataDir, 'get-started.json'), 'utf8')) as { pack?: { id?: unknown } | null }).pack?.id;
    return typeof id === 'string' && id in PACK_HINTS ? `Starter pack (chosen by the person): ${PACK_HINTS[id as keyof typeof PACK_HINTS]}` : undefined;
  } catch {
    return undefined;
  }
}
