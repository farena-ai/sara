// N3 (docs/INBOX_HELPER.md): her inbox-helper tools. packages_list, trips_list and
// inbox_suggestions only read; inbox_file_rule saves a filing rule (it asks first). Accepting a
// suggestion is the person's own tap on Today (or "do it for me" per kind), not hers.
import type { AppContext } from '../chat.ts';
import { InboxError, inboxFor } from '../inbox/helper.ts';
import { ToolError, type Tool } from './types.ts';

const STATUS: Record<string, string> = { ordered: 'ordered', shipped: 'shipped', in_transit: 'on the way', out_for_delivery: 'out for delivery', delivered: 'delivered', problem: 'a delivery problem' };

export function createInboxTools(getApp: () => AppContext): Tool[] {
  const h = () => inboxFor(getApp());
  const connected = () => Boolean(getApp().mailAccounts?.list().length);
  return [
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'packages_list', description: 'The person’s packages found in their email (shipping and delivery mails): carrier, tracking number, who it is from, status and expected delivery day. Updated from later emails about the same order (no carrier website is checked).', parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Include delivered ones from before the last 3 days.' } } } },
      summarize: () => 'List packages',
      async run(args) {
        const list = h().packages({ all: args.all === true });
        if (!list.length) return connected() ? 'No packages are tracked. When a shipping email arrives she suggests tracking it on Today (Settings → Email and calendar → Inbox helper).' : 'No mailbox is connected, so there are no packages from email. Connect one in Settings → Email and calendar.';
        return list.map((p) => `#${p.id} ${p.vendor ? `${p.vendor} · ` : ''}${p.carrier} ${p.tracking} · ${STATUS[p.status] ?? p.status}${p.eta && p.status !== 'delivered' ? ` · expected ${p.eta}` : ''}${p.deliveredAt ? ` · delivered ${p.deliveredAt.slice(0, 10)}` : ''}`).join('\n');
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'trips_list', description: 'The person’s trips found in their email: flights (number, airports, times), hotel (dates, address) and confirmation codes, with the check-in and leave-by reminders she set.', parameters: { type: 'object', properties: {} } },
      summarize: () => 'List trips',
      async run() {
        const list = h().trips();
        if (!list.length) return 'No upcoming trips from email.';
        return list.map((t) => [`#${t.id} ${t.title}${t.confirmation ? ` · confirmation ${t.confirmation}` : ''}`, ...t.flights.map((f) => `  flight ${f.flight}${f.from && f.to ? ` ${f.from} → ${f.to}` : ''}${f.departs ? ` · departs ${f.departs.slice(0, 16).replace('T', ' ')}` : ''}${f.arrives ? ` · arrives ${f.arrives.slice(0, 16).replace('T', ' ')}` : ''}`), ...(t.hotel ? [`  hotel ${t.hotel.name}${t.hotel.checkIn ? ` · ${t.hotel.checkIn.slice(0, 10)}` : ''}${t.hotel.checkOut ? ` to ${t.hotel.checkOut.slice(0, 10)}` : ''}${t.hotel.address ? ` · ${t.hotel.address}` : ''}`] : []), `  ${t.reminders.length} reminder${t.reminders.length === 1 ? '' : 's'}, ${t.events.length} calendar entr${t.events.length === 1 ? 'y' : 'ies'}`].join('\n')).join('\n');
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'inbox_suggestions', description: 'What she found in the person’s new email and offers on Today (“From your inbox”): bills, receipts, packages, trips, appointments, paid invoices and attachments to file, each waiting for Accept, plus what was done on its own. She never accepts them herself: the person taps Accept, or turns on “do it for me” for a kind.', parameters: { type: 'object', properties: {} } },
      summarize: () => 'Inbox suggestions',
      async run() {
        const s = h();
        const pending = s.list({ status: 'pending', limit: 20 });
        const auto = Object.entries(s.settings().auto).filter(([, v]) => v).map(([k]) => k);
        const head = `Inbox helper ${s.settings().on ? 'on' : 'off'}; does on its own: ${auto.length ? auto.join(', ') : 'nothing (suggestions only)'}.`;
        if (!pending.length) return `${head}\nNothing waiting.`;
        return `${head}\nWaiting on Today (the person taps Accept or Dismiss):\n${pending.map((it) => `- ${s.line(it)} (email “${it.subject.slice(0, 80)}”)`).join('\n')}`;
      },
    },
    {
      defaultPermission: 'ask',
      spec: { name: 'inbox_file_rule', description: 'Save a filing rule for email attachments, e.g. “file PDFs from my insurer into Library/Insurance”: from = the sender address or domain (shieldmutual.com), folder = the Library folder, ext = file type (pdf by default, * for any). New matching attachments are then saved to that Library folder on their own.', parameters: { type: 'object', properties: { from: { type: 'string' }, folder: { type: 'string' }, ext: { type: 'string' } }, required: ['from', 'folder'] } },
      summarize: (a) => `File ${String(a.ext ?? 'pdf').toUpperCase()}s from ${String(a.from ?? '')} into Library/${String(a.folder ?? '')}`,
      async run(args) {
        try {
          const r = h().addRule({ from: args.from, folder: args.folder, ext: args.ext });
          return `Rule #${r.id} is on: ${r.ext === '*' ? 'attachments' : `${r.ext.toUpperCase()} attachments`} from ${r.from} go to Library/${r.folder}. It applies to new email from now on (Settings → Email and calendar → Inbox helper shows it).`;
        } catch (err) {
          if (err instanceof InboxError) throw new ToolError(err.message);
          throw err;
        }
      },
    },
  ];
}
