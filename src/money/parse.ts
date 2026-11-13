// E3 (docs/MONEY.md): reading the person's own exports. A brokerage positions export (Fidelity,
// Schwab, Vanguard, Robinhood, E*TRADE and most others: CSV or Excel) or a plain list ("AAPL 10 @
// 150") becomes holdings; a bank or credit-card export (CSV, Excel, OFX/QFX) becomes transactions.
// Columns are found by their names (a table of common synonyms), the header row is the first row
// that has the needed columns (exports often start with a title or a summary block), and amounts are
// parsed into whole cents. Pure functions: the tests run them on invented fixture rows.
import { toCents } from '../biz/money.ts';
import { decodeText, parseCsv } from '../library/read.ts';
import { readTable, toDate } from '../table-query.ts';

export class MoneyParseError extends Error {}

export interface HoldingIn {
  account: string;
  symbol: string;
  name: string;
  /** Shares (4 decimals kept); 0 for cash. */
  qty: number;
  /** Total cost basis in cents, when the export has it. */
  costCents: number | null;
  /** Cash and money-market lines: their value in cents (no quote needed). */
  cashCents: number | null;
}

export interface TxIn {
  /** YYYY-MM-DD */
  date: string;
  description: string;
  /** Cents; negative is money out (a purchase), positive is money in. */
  amountCents: number;
  account: string;
  /** The bank's own category, when the export has one. */
  bankCategory: string;
}

/** "Qty (Quantity)" → "qty quantity"; "Price Paid $" → "price paid". */
export const headKey = (s: string): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const HOLDING_COLS = {
  symbol: ['symbol', 'ticker', 'symbol cusip', 'security symbol', 'stock symbol', 'ticker symbol', 'instrument'],
  name: ['description', 'name', 'security description', 'investment name', 'security name', 'security', 'company name'],
  qty: ['quantity', 'shares', 'qty', 'qty quantity', 'share quantity', 'units', 'shares held', 'quantity held'],
  costTotal: ['cost basis total', 'cost basis', 'total cost', 'total cost basis', 'cost basis cb', 'book value'],
  costPer: ['average cost basis', 'average cost', 'avg cost', 'price paid', 'cost share', 'cost per share', 'average price', 'avg price', 'unit cost', 'average cost per share'],
  value: ['current value', 'market value', 'value', 'total value', 'mkt val market value', 'mkt val', 'equity'],
  price: ['last price', 'price', 'share price', 'current price', 'last'],
  account: ['account', 'account name', 'account number', 'account name number', 'acct', 'account type'],
} as const;

const TX_COLS = {
  date: ['date', 'transaction date', 'trans date', 'posting date', 'post date', 'posted date', 'trade date', 'booking date', 'date posted'],
  description: ['description', 'payee', 'merchant', 'name', 'transaction description', 'details', 'original description', 'merchant name', 'memo'],
  amount: ['amount', 'transaction amount', 'amount usd', 'amt', 'net amount'],
  debit: ['debit', 'withdrawals', 'withdrawal', 'debit amount', 'money out', 'charges', 'withdrawal amount'],
  credit: ['credit', 'deposits', 'deposit', 'credit amount', 'money in', 'payments', 'deposit amount'],
  account: ['account', 'account name', 'account number', 'card no', 'card number', 'card'],
  category: ['category', 'transaction category'],
} as const;

type ColMap<K extends string> = Partial<Record<K, number>>;

/** Each wanted field → its column, synonyms in order of preference (\"Transaction Date\" before \"Post Date\"). */
export function mapHeader<K extends string>(row: string[], table: Record<K, readonly string[]>): ColMap<K> {
  const keys = row.map(headKey);
  const out: ColMap<K> = {};
  const used = new Set<number>();
  for (const field of Object.keys(table) as K[]) {
    for (const syn of table[field]) {
      const i = keys.findIndex((k, j) => k === syn && !used.has(j));
      if (i >= 0) {
        out[field] = i;
        used.add(i);
        break;
      }
    }
  }
  return out;
}

/** A file's bytes → rows of cells (CSV, TSV or Excel). */
export function gridOf(name: string, bytes: Buffer): string[][] {
  if (/\.(xlsx|xlsm)$/i.test(name)) {
    const t = readTable(name, bytes);
    return [t.columns, ...t.rows];
  }
  return parseCsv(decodeText(bytes), /\.tsv$/i.test(name) ? '\t' : undefined);
}

const cellAt = (r: string[], i: number | undefined) => (i === undefined ? '' : String(r[i] ?? '').trim());
/** Shares and prices: "2.123", "1,234.5", "$150.00", "(3)", "-1.5" (US number style; never a thousands dot). */
export const num = (raw: string): number | undefined => {
  let s = String(raw ?? '').trim();
  const neg = /^\(.*\)$/.test(s) || /^-|^\$-|^-\$/.test(s);
  s = s.replace(/[()$€£\s+-]/g, '').replace(/,(?=\d{3}(\D|$))/g, '');
  if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : undefined;
};

function findHeader<K extends string>(grid: string[][], table: Record<K, readonly string[]>, need: (m: ColMap<K>) => boolean): { at: number; map: ColMap<K> } | undefined {
  for (let i = 0; i < Math.min(grid.length, 40); i++) {
    const map = mapHeader(grid[i], table);
    if (need(map)) return { at: i, map };
  }
  return undefined;
}

const CASH = /^(cash|core|money market|pending|cash & cash investments|cash and cash investments|sweep)/i;
const TOTAL_ROW = /^(account total|total|totals|grand total|pending activity)\b/i;

/** Holdings from a positions export's rows. */
export function holdingsFromGrid(grid: string[][], defaultAccount = 'Brokerage'): HoldingIn[] {
  const h = findHeader(grid, HOLDING_COLS, (m) => m.symbol !== undefined && (m.qty !== undefined || m.value !== undefined));
  if (!h) throw new MoneyParseError('No holdings table found: I need a Symbol (or Ticker) column and a Quantity (or Shares) column.');
  const m = h.map;
  const out: HoldingIn[] = [];
  let account = defaultAccount;
  for (const r of grid.slice(h.at + 1)) {
    const rawSym = cellAt(r, m.symbol);
    const name = cellAt(r, m.name);
    if (m.account !== undefined && cellAt(r, m.account)) account = cellAt(r, m.account);
    // Vanguard puts a second (transactions) table under the positions: stop at the next header row.
    if (headKey(rawSym) === 'symbol' || headKey(rawSym) === 'ticker') break;
    if (!rawSym && !name) continue;
    if (TOTAL_ROW.test(rawSym) || (!rawSym && TOTAL_ROW.test(name))) continue;
    const value = num(cellAt(r, m.value));
    const qty = num(cellAt(r, m.qty));
    // Fidelity marks money market funds with ** (SPAXX**); Schwab writes "Cash & Cash Investments".
    if (/\*\*$/.test(rawSym) || CASH.test(rawSym) || (!rawSym && CASH.test(name))) {
      const cash = value ?? qty;
      if (cash !== undefined && cash !== 0) out.push({ account, symbol: 'CASH', name: name || rawSym.replace(/\*+$/, '') || 'Cash', qty: 0, costCents: null, cashCents: Math.round(cash * 100) });
      continue;
    }
    const symbol = rawSym.toUpperCase().replace(/^\$/, '').replace(/\s+/g, '');
    if (!/^[A-Z0-9][A-Z0-9.\-^=/]{0,14}$/.test(symbol) || qty === undefined || qty === 0) continue;
    let costCents: number | null = null;
    const total = toCents(cellAt(r, m.costTotal));
    const per = num(cellAt(r, m.costPer));
    if (total !== undefined && cellAt(r, m.costTotal) && !/^-+$|n\/?a/i.test(cellAt(r, m.costTotal))) costCents = Math.abs(total);
    else if (per !== undefined) costCents = Math.round(Math.abs(per * qty) * 100);
    out.push({ account, symbol: symbol.replace('/', '.'), name, qty: Math.round(qty * 10_000) / 10_000, costCents, cashCents: null });
  }
  if (!out.length) throw new MoneyParseError('The table had the right columns but no holdings rows.');
  return out;
}

const NOT_SYMBOL = new Set(['I', 'A', 'AT', 'OF', 'USD', 'ETF', 'MY', 'IN', 'AND', 'OR', 'THE']);

/** A plain list: "AAPL 10", "10 shares of MSFT @ 380.50", "VTI, 25, cost 5000". */
export function holdingsFromText(text: string, account = 'Brokerage'): HoldingIn[] {
  const out: HoldingIn[] = [];
  for (const raw of text.split(/\r?\n|;/)) {
    const line = raw.trim();
    if (!line) continue;
    const sym = [...line.matchAll(/(?:^|[\s,:(])\$?([A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?)(?=$|[\s,:)])/g)].find((x) => !NOT_SYMBOL.has(x[1]));
    if (!sym) continue;
    const rest = line.replace(sym[1], ' ');
    const nums = [...rest.matchAll(/(?<![A-Za-z])\$?(\d[\d,]*(?:\.\d+)?)/g)].map((x) => ({ n: Number(x[1].replace(/,/g, '')), at: x.index ?? 0 }));
    if (!nums.length || !(nums[0].n > 0)) continue;
    const qty = nums[0].n;
    let costCents: number | null = null;
    const second = nums[1];
    if (second) {
      const before = rest.slice(0, second.at).toLowerCase();
      const totalWord = /(cost basis|total|cost|paid)\s*[:=]?\s*\$?$/.test(before) && !/@|\bat\b|per share|each|avg|average/.test(before.slice(-14));
      costCents = Math.round((totalWord ? second.n : second.n * qty) * 100);
    }
    out.push({ account, symbol: sym[1], name: '', qty: Math.round(qty * 10_000) / 10_000, costCents, cashCents: null });
  }
  if (!out.length) throw new MoneyParseError('No holdings found in the text. Write one per line, like "AAPL 10 @ 150".');
  return out;
}

const isoOf = (raw: string): string | undefined => {
  const s = raw.trim();
  const ofx = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  if (ofx && !/[-/]/.test(s.slice(0, 8))) return `${ofx[1]}-${ofx[2]}-${ofx[3]}`;
  const t = toDate(s);
  return t === null ? undefined : new Date(t).toISOString().slice(0, 10);
};

/** Transactions from a bank or card export's rows. */
export function transactionsFromGrid(grid: string[][], defaultAccount: string): { rows: TxIn[]; skipped: number; flipped: boolean } {
  const h = findHeader(grid, TX_COLS, (m) => m.date !== undefined && m.description !== undefined && (m.amount !== undefined || m.debit !== undefined || m.credit !== undefined));
  if (!h) throw new MoneyParseError('No transactions table found: I need Date, Description and Amount (or Debit and Credit) columns.');
  const m = h.map;
  const rows: TxIn[] = [];
  let skipped = 0;
  for (const r of grid.slice(h.at + 1)) {
    const date = isoOf(cellAt(r, m.date));
    const description = cellAt(r, m.description).replace(/\s+/g, ' ');
    let amount: number | undefined;
    if (m.amount !== undefined && cellAt(r, m.amount)) amount = toCents(cellAt(r, m.amount));
    else {
      const d = toCents(cellAt(r, m.debit));
      const c = toCents(cellAt(r, m.credit));
      if (d !== undefined && cellAt(r, m.debit)) amount = -Math.abs(d);
      else if (c !== undefined && cellAt(r, m.credit)) amount = Math.abs(c);
    }
    if (!date || !description || amount === undefined || amount === 0) {
      if (r.some((c) => String(c ?? '').trim())) skipped++;
      continue;
    }
    rows.push({ date, description: description.slice(0, 200), amountCents: amount, account: cellAt(r, m.account) || defaultAccount, bankCategory: cellAt(r, m.category) });
  }
  if (!rows.length) throw new MoneyParseError('The table had the right columns but no transaction rows.');
  // Some card exports (American Express and others) write charges as positive numbers. When most
  // amounts are positive and the payments to the card are negative, flip the signs.
  let flipped = false;
  if (m.amount !== undefined) {
    const pos = rows.filter((x) => x.amountCents > 0).length;
    const paymentsNegative = rows.some((x) => x.amountCents < 0 && /payment|thank you|autopay/i.test(x.description));
    if (pos / rows.length > 0.6 && paymentsNegative) {
      for (const x of rows) x.amountCents = -x.amountCents;
      flipped = true;
    }
  }
  return { rows, skipped, flipped };
}

const ofxTag = (block: string, tag: string): string => {
  const m = new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i').exec(block);
  return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
};

/** OFX / QFX (SGML or XML): every STMTTRN, the account from ACCTID (last 4 digits). */
export function transactionsFromOfx(text: string, defaultAccount: string): { rows: TxIn[]; skipped: number; flipped: boolean } {
  if (!/<OFX>/i.test(text)) throw new MoneyParseError("This isn't an OFX/QFX file.");
  const rows: TxIn[] = [];
  let skipped = 0;
  // A file may hold several accounts (bank and card statements): each STMTRS / CCSTMTRS block.
  const stmts = text.split(/<(?:CC)?STMTRS>/i).slice(1);
  for (const st of stmts.length ? stmts : [text]) {
    const id = ofxTag(st, 'ACCTID');
    const account = id ? `${defaultAccount} …${id.replace(/\s/g, '').slice(-4)}` : defaultAccount;
    for (const b of st.split(/<STMTTRN>/i).slice(1)) {
      const date = isoOf(ofxTag(b, 'DTPOSTED') || ofxTag(b, 'DTUSER'));
      const amount = toCents(ofxTag(b, 'TRNAMT'));
      const description = (ofxTag(b, 'NAME') || ofxTag(b, 'PAYEE') || ofxTag(b, 'MEMO')).replace(/\s+/g, ' ');
      if (!date || amount === undefined || amount === 0 || !description) {
        skipped++;
        continue;
      }
      rows.push({ date, description: description.slice(0, 200), amountCents: amount, account, bankCategory: '' });
    }
  }
  if (!rows.length) throw new MoneyParseError('No transactions in this OFX/QFX file.');
  return { rows, skipped, flipped: false };
}

/** A bank export's bytes → transactions (CSV, TSV, Excel, OFX, QFX). */
export function readTransactions(name: string, bytes: Buffer, account?: string): { rows: TxIn[]; skipped: number; flipped: boolean } {
  const acct = (account ?? '').trim() || name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60);
  const head = bytes.subarray(0, 4096).toString('latin1');
  if (/\.(ofx|qfx|qbo)$/i.test(name) || /OFXHEADER|<OFX>/i.test(head)) return transactionsFromOfx(decodeText(bytes), acct);
  if (/\.pdf$/i.test(name)) throw new MoneyParseError('PDF statements are not read for budgets: download the CSV, Excel or OFX/QFX export from the bank\'s website (usually under Download or Export).');
  return transactionsFromGrid(gridOf(name, bytes), acct);
}

/** A positions export's bytes → holdings. */
export function readHoldings(name: string, bytes: Buffer, account?: string): HoldingIn[] {
  if (/\.pdf$/i.test(name)) throw new MoneyParseError('PDF statements are not read for holdings: download the positions as CSV (or Excel) from the brokerage, or paste a list like "AAPL 10 @ 150".');
  if (/\.(txt|md)$/i.test(name)) return holdingsFromText(decodeText(bytes), account || 'Brokerage');
  return holdingsFromGrid(gridOf(name, bytes), account || 'Brokerage');
}
