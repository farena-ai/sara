// S7 (docs/DOCUMENTS.md "Contracts, proposals and letters"): a clause checklist per kind of document.
// Code looks for each usual clause by its wording and quotes the sentence it found (with its page or
// section); a clause that reads unusually (automatic renewal, unlimited liability, a late fee above
// 1.5% a month) is flagged with the reason. Reuses the E6 contract reader (src/biz/contracts.ts) for
// sentences, places and flags. Information, not legal advice: every result says so.
import { CHECKLIST, sentencesOf, whereOf, type Sentence } from '../biz/contracts.ts';

export const DOC_TYPES = ['contract', 'nda', 'sow', 'proposal', 'letter', 'invoice'] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DOC_TYPE_LABEL: Record<DocType, string> = { contract: 'Contract', nda: 'NDA', sow: 'Statement of work', proposal: 'Proposal', letter: 'Letter', invoice: 'Invoice cover' };

export const NOT_ADVICE = 'Information, not legal advice: this checklist looks for common clauses by their wording and quotes what it found. For anything important, have a lawyer read the document.';

interface Rule {
  id: string;
  label: string;
  re: RegExp;
  /** Returns why a found clause is unusual (or nothing). */
  unusual?: (s: Sentence, all: Sentence[]) => string | undefined;
}

const flagRe = (id: string) => CHECKLIST.find((c) => c.id === id)!.re;
const RATE = /(\d+(?:\.\d+)?)\s*%\s*(?:per|a|each|every)?\s*(month|monthly|annum|annual(?:ly)?|year|yearly)?/i;

const R = {
  parties: { id: 'parties', label: 'Parties', re: /\b(?:by and )?between\s+.{2,160}?\s+and\s+\S|\bparties\b.{0,40}\bare\b/i },
  term: {
    id: 'term',
    label: 'Term',
    re: /\b(term of (?:this|the)|initial term|this (?:agreement|contract) (?:begins|commences|starts|is effective|shall commence|will commence)|effective (?:date|as of|on|from)|effective,?\s+(?:\p{Lu}\p{Ll}+\.? \d{1,2}|\d{1,2}[/.-]\d)|shall (?:continue|remain) in (?:full )?(?:force|effect)|for a (?:period|term) of)\b/iu,
    unusual: (s: Sentence) => (flagRe('auto_renewal').test(s.text) ? 'It renews automatically unless someone gives notice in time.' : undefined),
  },
  payment: {
    id: 'payment',
    label: 'Payment',
    re: /\b(shall pay|will pay|agrees to pay|payment|fees?\b|invoices?\b|compensation|price)\b/i,
    unusual: (_s: Sentence, all: Sentence[]) => {
      for (const x of all) {
        if (!/\b(late|interest|overdue|past due)\b/i.test(x.text)) continue;
        const m = RATE.exec(x.text);
        if (!m) continue;
        const pct = Number(m[1]);
        const unit = m[2] ?? (/per month|monthly/i.test(x.text) ? 'month' : /annum|annual|per year/i.test(x.text) ? 'year' : '');
        const monthly = /month/i.test(unit) ? pct : /annum|annual|year/i.test(unit) ? pct / 12 : undefined;
        if (monthly !== undefined && monthly > 1.5) return `The late fee (${m[0].trim()}) is about ${Math.round(monthly * 100) / 100}% a month, above the usual 1.5%: “${x.text.slice(0, 200)}”`;
      }
      return undefined;
    },
  },
  termination: { id: 'termination', label: 'Termination', re: /\bterminat\w*/i },
  liability_cap: {
    id: 'liability_cap',
    label: 'Liability cap',
    re: /\b(limitation of liability|liability[^.]{0,100}(?:shall not exceed|will not exceed|limited to|capped|cap\b|shall not be limited|is not limited|without limit)|unlimited liability|in no event shall[^.]{0,100}liab|total liability|aggregate liability)/i,
    unusual: (s: Sentence) => (flagRe('unlimited_liability').test(s.text) ? 'Liability is not limited.' : undefined),
  },
  indemnity: { id: 'indemnity', label: 'Indemnity', re: /\b(indemnif\w+|hold (?:\w+ )?harmless)/i },
  confidentiality: { id: 'confidentiality', label: 'Confidentiality', re: /\b(confidential\w*|non-?disclosure)\b/i },
  ip: { id: 'ip', label: 'Intellectual property', re: /\b(intellectual property|work product|copyrights?|work made for hire|ownership of (?:the )?(?:work|deliverables)|licen[sc]e to use)\b/i },
  governing_law: { id: 'governing_law', label: 'Governing law', re: /\b(governed by|governing law|laws of the (?:state|commonwealth|province) of|exclusive jurisdiction|venue)\b/i },
  signatures: { id: 'signatures', label: 'Signatures', re: /\b(in witness whereof|signatures?\b|signed by|executed (?:by|as of)|by:\s*_{3,})/i },
  exclusions: { id: 'exclusions', label: 'What is not confidential', re: /\b(publicly available|public domain|already known|independently developed|required by law|rightfully received)\b/i },
  scope: { id: 'scope', label: 'Scope', re: /\b(scope|deliverables?|services to be provided|we will (?:design|build|deliver|provide|redesign|create|write))\b/i },
  timeline: { id: 'timeline', label: 'Timeline', re: /\b(timeline|schedule|milestones?|deadline|completion date|(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve) (?:business )?(?:days|weeks|months) (?:from|after)|kick-?off|start date|delivery date)\b/i },
  price: { id: 'price', label: 'Price', re: /[$€£]\s?\d|\b(price|pricing|costs?|fees?|investment|budget|total|rate)\b/i },
  assumptions: { id: 'assumptions', label: 'Assumptions', re: /\b(assum\w+|out of scope|not included|exclusions?|client (?:will )?(?:provide|supply)s?)\b/i },
  acceptance: { id: 'acceptance', label: 'Acceptance', re: /\b(accept(?:ance|ed)|sign-?off|approv(?:al|ed) of (?:the )?deliverables?)\b/i },
  date: { id: 'date', label: 'Date', re: /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? \d{1,2},? \d{4}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/i },
  greeting: { id: 'greeting', label: 'Greeting', re: /^(dear|hello|hi|to whom)\b/i },
  closing: { id: 'closing', label: 'Closing', re: /\b(sincerely|kind regards|best regards|regards|yours (?:truly|faithfully)|respectfully)\b/i },
  invoice_no: { id: 'invoice_no', label: 'Invoice number', re: /\binvoice\s*(?:no\.?|number|#)\s*:?\s*\S/i },
  amount_due: { id: 'amount_due', label: 'Amount due', re: /\b(amount due|total due|balance due|total)\b[^.]{0,40}[$€£]?\s?\d/i },
  due_date: { id: 'due_date', label: 'Due date', re: /\b(due (?:date|on|by)|payable (?:by|within)|net \d+)\b/i },
  pay_how: { id: 'pay_how', label: 'How to pay', re: /\b(bank transfer|wire|ach|routing|iban|check payable|pay online|paypal|payment instructions)\b/i },
} satisfies Record<string, Rule>;

const LISTS: Record<DocType, Rule[]> = {
  contract: [R.parties, R.term, R.payment, R.termination, R.liability_cap, R.indemnity, R.confidentiality, R.ip, R.governing_law, R.signatures],
  nda: [R.parties, R.term, R.confidentiality, R.exclusions, R.termination, R.governing_law, R.signatures],
  sow: [R.parties, R.scope, R.timeline, R.payment, R.acceptance, R.termination, R.signatures],
  proposal: [R.scope, R.timeline, R.price, R.assumptions],
  letter: [R.date, R.greeting, R.closing],
  invoice: [R.invoice_no, R.date, R.amount_due, R.due_date, R.pay_how],
};

/** The kind of document, from its name first, then its first lines. */
export function guessDocType(name: string, text: string): DocType {
  const head = `${name}\n${text.slice(0, 600)}`;
  const n = name.replace(/\.[a-z0-9]+$/i, '');
  const test = (s: string): DocType | undefined =>
    /\b(nda|non-?disclosure|confidentiality agreement)\b/i.test(s) ? 'nda'
    : /\b(sow|statement of work)\b/i.test(s) ? 'sow'
    : /\b(proposal|quotation|estimate)\b/i.test(s) ? 'proposal'
    : /\binvoice\b/i.test(s) ? 'invoice'
    : /\b(agreement|contract|msa|lease|terms of service)\b/i.test(s) ? 'contract'
    : /\bletter\b/i.test(s) ? 'letter'
    : undefined;
  return test(n) ?? test(head) ?? (/^\s*(dear|to whom)\b/im.test(text.slice(0, 800)) ? 'letter' : 'contract');
}

export const isDocType = (v: unknown): v is DocType => (DOC_TYPES as readonly string[]).includes(String(v));

export interface ChecklistItem {
  id: string;
  label: string;
  status: 'present' | 'missing' | 'unusual';
  quote?: string;
  where?: string;
  note?: string;
}
export interface Checklist {
  type: DocType;
  items: ChecklistItem[];
  present: number;
  missing: number;
  unusual: number;
  /** Other clauses worth a second look (non-compete, exclusivity, one-sided changes, arbitration). */
  others: { label: string; quote: string; where: string }[];
  notice: string;
}

/** The checklist for a document's text (the Library's text, with its page markers). */
export function clauseChecklist(text: string, type: DocType): Checklist {
  const ss = sentencesOf(text);
  // A line that is only a heading ("Scope:") still counts with what follows it.
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const items: ChecklistItem[] = [];
  for (const rule of LISTS[type]) {
    // A real sentence beats a bare heading ("Payment") as the quote.
    const found = ss.filter((s) => rule.re.test(s.text)).sort((a, b) => Number(b.text.split(/\s+/).length > 4) - Number(a.text.split(/\s+/).length > 4));
    let hit = found[0];
    let note: string | undefined;
    if (rule.unusual) {
      for (const s of found.length ? found : []) {
        const why = rule.unusual(s, ss);
        if (why) {
          hit = s;
          note = why;
          break;
        }
      }
    }
    if (!hit && rule.id === 'greeting') {
      const l = lines.find((x) => rule.re.test(x));
      if (l) hit = { text: l, page: null, section: '' };
    }
    if (!hit) {
      items.push({ id: rule.id, label: rule.label, status: 'missing' });
      continue;
    }
    items.push({ id: rule.id, label: rule.label, status: note ? 'unusual' : 'present', quote: hit.text.slice(0, 400), where: whereOf(hit), ...(note ? { note } : {}) });
  }
  const others: Checklist['others'] = [];
  if (type === 'contract' || type === 'sow' || type === 'nda') {
    for (const id of ['non_compete', 'exclusivity', 'unilateral_changes', 'arbitration'] as const) {
      const c = CHECKLIST.find((x) => x.id === id)!;
      const s = ss.find((x) => c.re.test(x.text));
      if (s) others.push({ label: c.label, quote: s.text.slice(0, 400), where: whereOf(s) });
    }
  }
  const count = (st: ChecklistItem['status']) => items.filter((i) => i.status === st).length;
  return { type, items, present: count('present'), missing: count('missing'), unusual: count('unusual'), others, notice: NOT_ADVICE };
}

/** The checklist as text for the model (and chat apps). */
export function checklistText(c: Checklist, name: string): string {
  const mark = { present: '✓', missing: '✗ missing', unusual: '⚠ unusual' } as const;
  const rows = c.items.map((i) => `- ${i.label}: ${mark[i.status]}${i.quote ? ` (${i.where}): “${i.quote}”` : ''}${i.note ? ` ${i.note}` : ''}`);
  const others = c.others.length ? `\nWorth a second look:\n${c.others.map((o) => `- ${o.label} (${o.where}): “${o.quote}”`).join('\n')}` : '';
  return `Clause checklist for “${name}” (${DOC_TYPE_LABEL[c.type]}): ${c.present} present, ${c.missing} missing, ${c.unusual} unusual.\n${rows.join('\n')}${others}\n${c.notice}`;
}
