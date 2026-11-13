// E6 (docs/BUSINESS_TOOLS.md): Today's "Money in" and "Owe a reply" tile. Shown only once the person
// uses those features (an invoice made, follow_ups asked once); no model call and no mail fetch here:
// money comes from their own invoices, the reply count from the last follow-ups check (with its time).
import type { PartCtx } from '../today.ts';
import { bizStore } from './store.ts';

export interface BusinessTile {
  moneyIn: { unpaidCents: number; unpaid: number; overdue: number; currency: string } | null;
  followUps: { count: number; at: string } | null;
}

export function businessPart(c: PartCtx): BusinessTile | undefined {
  if (c.demo) return undefined;
  const s = bizStore(c.app);
  const moneyIn = s.moneyIn(c.day) ?? null;
  const followUps = s.state<{ count: number; at: string }>('followups') ?? null;
  if (!moneyIn && !followUps) return undefined;
  return { moneyIn, followUps };
}
