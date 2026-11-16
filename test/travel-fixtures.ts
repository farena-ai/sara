// S6 (docs/TRAVEL.md): invented booking emails for the travel tests (no real people, airlines,
// hotels or bookings). Three airlines (one JSON-LD, two plain text, one with two flights), a hotel,
// a rental car, a train and an event ticket. Times are written the way each sender writes them.
import type { InboxMail } from '../src/inbox/classify.ts';

const ld = (o: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body><p>Your booking details are below.</p></body></html>`;
let n = 0;
const mail = (o: Partial<InboxMail> & Pick<InboxMail, 'from' | 'subject'>): InboxMail => ({ account: 'alex@mail.test', id: `t${++n}`, date: '2026-11-15T15:00:00.000Z', text: '', ...o });

export const TRAVEL = {
  // Airline 1 (JSON-LD, offsets in the times): Chicago -> Denver, Fri Nov 20.
  skyway: mail({
    from: 'Skyway Air <noreply@skyway.test>',
    subject: 'Your trip confirmation: Chicago to Denver',
    html: ld({ '@context': 'http://schema.org', '@type': 'FlightReservation', reservationNumber: 'QX7P2L', reservationFor: { '@type': 'Flight', flightNumber: '1452', airline: { '@type': 'Airline', name: 'Skyway Air', iataCode: 'SK' }, departureAirport: { '@type': 'Airport', name: "Chicago O'Hare", iataCode: 'ORD' }, departureTime: '2026-11-20T08:05:00-06:00', arrivalAirport: { '@type': 'Airport', name: 'Denver International', iataCode: 'DEN' }, arrivalTime: '2026-11-20T09:50:00-07:00' } }),
  }),
  // Airline 2 (plain text, local wall times): the way home, Mon Nov 23, 5:30 PM in Denver.
  prairie: mail({
    from: 'Prairie Jet <trips@prairiejet.test>',
    subject: 'Your Prairie Jet itinerary',
    text: 'Confirmation code: PJ7Q2W\nFlight PJ 88  DEN to ORD\nDeparts: Nov 23, 2026 at 5:30 PM\nArrives: Nov 23, 2026 at 9:05 PM\nCheck in online 24 hours before departure.',
  }),
  // Airline 3 (plain text, two flights in one mail): Chicago -> Minneapolis and back, Dec 3-5.
  lakeshore: mail({
    from: 'Lakeshore Airlines <itinerary@lakeshore.test>',
    subject: 'Itinerary for your trip',
    text: 'Confirmation number: LK4M8N\n\nFlight LK 220  ORD to MSP\nDeparts: Dec 3, 2026 at 6:40 AM\nArrives: Dec 3, 2026 at 8:05 AM\n\nFlight LK 221  MSP to ORD\nDeparts: Dec 5, 2026 at 7:15 PM\nArrives: Dec 5, 2026 at 8:40 PM',
  }),
  // Hotel (JSON-LD): Denver, Nov 20-23.
  hotel: mail({
    from: 'Mile High Inn <stay@milehigh.test>',
    subject: 'Reservation confirmed: Mile High Inn',
    html: ld({ '@context': 'http://schema.org', '@type': 'LodgingReservation', reservationNumber: 'MH5531', checkinTime: '2026-11-20T15:00:00-07:00', checkoutTime: '2026-11-23T11:00:00-07:00', reservationFor: { '@type': 'LodgingBusiness', name: 'Mile High Inn', address: { '@type': 'PostalAddress', streetAddress: '1200 Larimer St', addressLocality: 'Denver', addressRegion: 'CO', postalCode: '80202' } } }),
  }),
  // Rental car (plain text): picked up at DEN.
  car: mail({
    from: 'Peak Car Rental <res@peakcars.test>',
    subject: 'Your car rental confirmation',
    text: 'Thanks for renting with Peak Car Rental.\nConfirmation number: PC90210\nPick-up: Denver International Airport (DEN), Nov 20, 2026 at 10:30 AM\nReturn: Denver International Airport (DEN), Nov 23, 2026 at 3:00 PM\nCar: Compact SUV or similar',
  }),
  // Train (plain text) during the Minneapolis trip.
  train: mail({
    from: 'Northline Rail <tickets@northline.test>',
    subject: 'Your train tickets',
    text: 'Confirmation number: NR4471\nTrain 512 from Minneapolis to Duluth\nDeparts: Dec 4, 2026 at 9:10 AM\nArrives: Dec 4, 2026 at 11:45 AM',
  }),
  // Event ticket (JSON-LD) during the Denver trip.
  concert: mail({
    from: 'Foothills Tickets <orders@foothills.test>',
    subject: 'Your tickets: Foothills Amphitheater',
    html: ld({ '@context': 'http://schema.org', '@type': 'EventReservation', reservationNumber: 'FT8812', reservationFor: { '@type': 'Event', name: 'Evening concert at Foothills Amphitheater', startDate: '2026-11-21T19:30:00-07:00', location: { '@type': 'Place', name: 'Foothills Amphitheater', address: 'Morrison, CO' } } }),
  }),
} as const;
