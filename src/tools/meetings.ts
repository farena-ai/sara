// S2 (docs/MEETINGS.md): her meeting tools. Both only read: meeting_list shows recent meetings,
// meeting_summarize gives one meeting's notes (summary, decisions, action items with owners and
// dates, open questions, the calendar event, follow-up emails waiting). Recording, adding to-dos and
// sending follow-ups stay with the person on the Meetings page.
import { type AppContext } from '../chat.ts';
import { ToolError, type Tool } from './types.ts';

export function createMeetingTools(getApp: () => AppContext): Tool[] {
  const store = () => {
    const m = getApp().meetings;
    if (!m) throw new ToolError('Meetings are not available here (owner only).');
    return m;
  };
  return [
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: () => Boolean(getApp().meetings),
      summarize: () => 'List recent meetings',
      spec: { name: 'meeting_list', description: 'The person’s recent meetings (recorded, uploaded or meeting rooms): number, name, time, status, how many action items and the calendar event it matched.', parameters: { type: 'object', properties: {} } },
      async run() {
        return store().listText();
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      isAvailable: () => Boolean(getApp().meetings),
      summarize: (a) => (a.id ? `Read the notes of meeting #${String(a.id).replace(/^#/, '')}` : 'Read the latest meeting notes'),
      spec: {
        name: 'meeting_summarize',
        description: 'The notes of one meeting: summary, decisions, action items (owner and due date), open questions, the matching calendar event and follow-up emails waiting for the person. No id: the latest meeting with notes. Use it to answer "what did we decide", "what do I owe after the meeting". Only the person sends follow-ups or adds to-dos (Meetings page).',
        parameters: { type: 'object', properties: { id: { type: 'string', description: 'The meeting number from meeting_list.' } } },
      },
      async run(args) {
        const raw = String(args.id ?? '').replace(/^#/, '').trim();
        const id = raw ? Number(raw) : undefined;
        if (raw && (!Number.isInteger(id) || id! <= 0)) throw new ToolError('Which meeting? Give its number from meeting_list.');
        return store().summaryText(id);
      },
    },
  ];
}
