// V2.2 (docs/PURCHASES.md): Purchases in chat. purchases_list (what you bought and when each return
// window closes), purchase_add (a receipt she read from a photo or that you typed; the return-by and
// warranty dates are worked out by code from the receipt's words or the store's usual window) and
// purchase_return (opens a "Start a return" errand; asks first, nothing is sent until you start it).
import type { AppContext } from '../chat.ts';
import { fmtMoney } from '../biz/money.ts';
import { localDay } from '../biz/store.ts';
import { MoneyHubError } from '../money/hub.ts';
import { addPurchase, purchase, purchaseDay, purchaseLine, purchasesOverview, startReturn } from '../money/purchases.ts';
import { ToolError, type Tool } from './types.ts';

export const PURCHASE_TOOLS = ['purchases_list', 'purchase_add', 'purchase_return'] as const;
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

function wrap<R>(f: () => R): R {
  try {
    return f();
  } catch (err) {
    if (err instanceof MoneyHubError) throw new ToolError(err.message);
    throw err;
  }
}

export function createPurchaseTools(getApp: () => AppContext): Tool[] {
  const today = (app: AppContext) => localDay(app.now(), app.settings.get().timeZone);
  return [
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: () => true,
      spec: {
        name: 'purchases_list',
        description: "The person's purchases (from receipt mail, receipt photos in the Library and ones they added): item, store, price, date bought, return-by date and warranty end. Use it for \"can I still return…\", \"when does the warranty end\", \"what did I buy at…\".",
        parameters: obj({ open_only: { type: 'boolean', description: 'Only purchases whose return window is still open.' } }),
      },
      summarize: () => 'Looking at your purchases',
      run: async (a) => {
        const app = getApp();
        const o = purchasesOverview(app);
        const d = today(app);
        const list = o.purchases.filter((p) => !a.open_only || (p.status === 'open' && p.returnBy && p.returnBy >= d));
        if (!list.length) return a.open_only ? 'No purchases with an open return window.' : 'No purchases yet. Receipts from your mail and receipt photos in the Library show up in Money → Purchases.';
        return [`${list.length} purchase${list.length === 1 ? '' : 's'} (dates worked out by code; a store's usual window can differ for some items):`, ...list.slice(0, 40).map((p) => `- ${purchaseLine(p, d)}`)].join('\n');
      },
    },
    {
      defaultPermission: 'auto',
      isAvailable: () => true,
      spec: {
        name: 'purchase_add',
        description: 'Add a purchase to Money → Purchases, e.g. from a receipt photo you just read or what the person tells you. Give the receipt\'s words as text (return and warranty lines) and the return-by and warranty dates are worked out by code; give return_by / warranty_until only when the person says them.',
        parameters: obj(
          {
            item: { type: 'string', description: 'What was bought.' },
            store: { type: 'string' },
            price: { type: 'string', description: 'Total paid, like 49.99.' },
            date: { type: 'string', description: 'Date bought, YYYY-MM-DD (default today).' },
            text: { type: 'string', description: "The receipt's text, for its return and warranty terms." },
            return_by: { type: 'string', description: 'YYYY-MM-DD, only when the person says it.' },
            warranty_until: { type: 'string', description: 'YYYY-MM-DD, only when the person says it.' },
            order: { type: 'string', description: 'Order number, if any.' },
          },
          ['item'],
        ),
      },
      summarize: (a) => `Adding a purchase: ${String(a.item ?? '').slice(0, 60)}`,
      run: async (a) =>
        wrap(() => {
          const app = getApp();
          const p = addPurchase(app, a, 'hand');
          const ret = p.returnBy ? ` Return by ${purchaseDay(p.returnBy)}${p.returnFrom === 'store' ? ` (${p.store}'s usual window)` : p.returnFrom === 'receipt' ? ' (from the receipt)' : ''}.` : p.returnFrom === 'receipt' ? ' The receipt says it cannot be returned.' : ' No return window found: check the store.';
          const war = p.warrantyUntil ? ` Warranty until ${purchaseDay(p.warrantyUntil)}.` : '';
          const rem = p.reminderId ? ' A reminder is set before the window closes.' : '';
          return `Saved purchase #${p.id}: ${p.item}${p.store ? ` from ${p.store}` : ''}${p.priceCents !== null ? `, ${fmtMoney(p.priceCents)}` : ''}, ${purchaseDay(p.date)}.${ret}${war}${rem}`;
        }),
    },
    {
      defaultPermission: 'ask',
      isAvailable: () => true,
      spec: {
        name: 'purchase_return',
        description: 'Start a return for one purchase (its number from purchases_list): opens an errand that finds the receipt and how the store takes returns, and drafts the request. Nothing is sent without the person\'s OK.',
        parameters: obj({ id: { type: 'number', description: 'The purchase number.' } }, ['id']),
      },
      summarize: (a) => `Start a return for purchase #${Number(a.id)}`,
      run: async (a, ctx) =>
        wrap(() => {
          const app = getApp();
          if (ctx.conversationId && app.store.getConversation(ctx.conversationId)?.private) throw new ToolError('Errands can’t be started from a private chat.');
          const p = purchase(app, Number(a.id));
          if (!p) throw new ToolError(`There is no purchase #${Number(a.id)}. Use purchases_list.`);
          const e = startReturn(app, p.id);
          return `Opened errand #${e.id}: “${e.goal}”${e.deadline ? `, deadline ${purchaseDay(e.deadline)}` : ''}. It is waiting in Errands for the person to start it; nothing is sent without their OK.`;
        }),
    },
  ];
}
