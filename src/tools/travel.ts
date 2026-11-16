// S6 (docs/TRAVEL.md): her travel tools. Both only read: trip_list (the person's trips from booking
// email, each with its timeline) and trip_status (one trip: every booking with its local time and
// zone, confirmation codes, flight status from the source the person turned on, rebooking options).
// Adding to the calendar and making the packing list are the person's taps on the Trips page; she
// never books, changes or pays for travel.
import type { AppContext } from '../chat.ts';
import { travelFor } from '../travel.ts';
import { ToolError, type Tool } from './types.ts';

export function createTravelTools(getApp: () => AppContext): Tool[] {
  const t = () => travelFor(getApp());
  return [
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'trip_list', description: 'The person’s trips, built from booking emails in all their mailboxes (flights, hotels, rental cars, trains, event tickets): each trip’s number, dates and bookings. Use trip_status for one trip’s times, confirmation codes and flight status.', parameters: { type: 'object', properties: { all: { type: 'boolean', description: 'Include past trips.' } } } },
      summarize: () => 'List trips',
      async run(args) {
        return t().listText(args.all === true);
      },
    },
    {
      defaultPermission: 'auto',
      interruptible: true,
      spec: { name: 'trip_status', description: 'One trip in order: each flight, hotel, car, train and event with its local time and time zone, confirmation codes, the latest flight status (delay, gate, cancelled) when a status source is on, and rebooking options after a cancellation. She never books or pays: for a change the person picks an option with the airline.', parameters: { type: 'object', properties: { id: { type: 'string', description: 'The trip number (trip_list). Without it: the next trip.' } } } },
      summarize: (a) => (a.id ? `Trip #${String(a.id)}` : 'Next trip'),
      async run(args) {
        const s = t();
        const raw = String(args.id ?? '').replace(/^#/, '').trim();
        const id = raw ? Number(raw) : s.trips()[0]?.id;
        if (!id || !Number.isInteger(id)) throw new ToolError(raw ? 'Which trip? Give its number (trip_list shows them).' : 'No upcoming trips found in email.');
        if (!s.trip(id)) throw new ToolError('No trip with that number.');
        return s.statusText(await s.checkNow(id));
      },
    },
  ];
}
