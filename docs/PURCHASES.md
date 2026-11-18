# Purchases: receipts, returns, warranties (V2.2)

**Where:** Money → Purchases (the Money place, under Subscriptions). In chat: "can I still return
the headphones?", "when does the mixer's warranty end?", "start a return for the rug".

## What you get

- **One list of what you bought**: item, store, price, date, **Return-by** and **Warranty until**.
- **From your email**: every receipt or order confirmation the inbox helper reads becomes a row
  on its own (no tap needed; the Expenses card still works as before).
- **From a photo**: *Add a receipt photo* (camera on a phone, or a PDF) puts it in your Library;
  your picture model reads it like any document and it joins the list. Receipt photos and PDFs you
  add to the Library in other ways are picked up too. The same receipt by photo and by email shows once.
- **Return-by dates**, in this order: what the receipt says ("return by Dec 20", "within 30 days",
  "final sale"), else the store's usual window (Amazon 30, Walmart 90, Target 90, Best Buy 15,
  Costco 90, The Home Depot 90, Lowe's 90, Apple 14, IKEA 365 days), else "unknown: check the store".
  Each row says where its date came from. *Edit dates* changes it; your date always wins.
- **Warranty until**: from the receipt ("1-year limited warranty", "warranty until …") or a warranty
  date found in the document (the same reader that finds dates in your other documents).
- **Reminder**: a Planner reminder in the morning N days (1, 2, 3, 5 or 7; default 3) before the last
  day to return. *Keep it* or *Returned* stops it. Turn it off under the list.
- **Start a return**: opens an errand (Errands → "Return something you bought") that finds the
  receipt in your mail and how the store takes returns, and drafts a return request. It waits in
  Errands until you start it; nothing is sent without your OK.

Tracking only: Sara never contacts a store, pays or ships anything on her own.

## Design (one page)

- `src/money/purchases.ts`: the list in the person's own money store (`money_purchases`, plus
  `money_purchase_seen` so a mail or document is read once). Members have their own money store, so
  their own list. Reads `src/facts.ts` (`DATE_RE`, `isoDate`, `extractFacts` warranty dates); never
  edits it. Not `src/receipts.ts`, which is the claims checker for tool receipts.
- Sources: `observePurchaseMail` is called by `InboxHelper.#take` next to `observeMoneyMail`, with
  the receipt finding from `src/inbox/classify.ts`. `scanPurchaseDocs` reads Library documents that
  are kept and read (new ones only), using `parseReceipt` from `src/biz/expenses.ts`; it runs when
  the list is opened or asked for.
- Terms by code: `readReceiptTerms` (receipt words, then `STORE_POLICIES`), `receiptItems`.
- Reminders are ordinary Planner reminders (`morningOf(returnBy - days)`), moved when dates or
  prefs change, cancelled on Keep it / Returned / Remove.
- Errand: template `return` in `src/errands.ts` (steps: mail search, web search, message that asks
  first, wait 5 days); one errand per purchase.
- API: `GET/POST /api/money/purchases`, `PATCH/DELETE /api/money/purchases/:id`,
  `POST /api/money/purchases/:id/status`, `POST /api/money/purchases/:id/return`,
  `PUT /api/money/purchases/prefs`. Tools: `purchases_list`, `purchase_add`, `purchase_return` (asks).
- Web: `web/purchases.js`, drawn by `web/money.js`.

## Limits

- Return and warranty phrases are read in English; other languages fall back to the store table.
- Store windows are the usual ones for most items; some items (electronics, holiday buys, members)
  differ. The receipt's words and your own date win.
- A receipt photo needs a picture model (Settings → Models) to be read.
