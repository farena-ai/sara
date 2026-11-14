// N6 fixture documents (invented content, fake numbers): a lease, an auto policy, a warranty, a passport.
export const N6_DOCS = {
  lease: {
    name: 'Lease 2026 - 14 Elm St.pdf',
    pages: [
      'RESIDENTIAL LEASE AGREEMENT\nLandlord: Maple Street Properties LLC\nTenant: Alex Rivera\nPremises: 14 Elm St, Apt 3, Springfield\nThe term of this Lease begins on June 1, 2026 and ends on May 31, 2027.\nMonthly rent: $1,450.00, due on the first day of each month.',
      'Security deposit: $1,450.00 held by Landlord.\nTenant must give written notice 60 days before the lease ends if Tenant does not wish to renew.',
    ],
  },
  policy: {
    name: 'Lakeside auto policy.pdf',
    pages: [
      'Lakeside Mutual Auto Insurance - Declarations Page\nNamed Insured: Alex Rivera\nPolicy Number: LM-2207-48831\nPolicy period: March 1, 2026 to March 1, 2027\nVehicle: 2021 Honda Civic, VIN 2HGFC2F59MH512345',
      'Collision deductible: $500 per claim.\nComprehensive deductible: $250 per claim.\nSix-month premium: $612.40.\nPayment due date: December 5, 2026.\nCard on file: 4111-1111-1111-1111. Applicant SSN 123-45-6789.',
    ],
  },
  warranty: {
    name: 'Northwind dishwasher warranty.pdf',
    pages: ['Northwind Appliances Limited Warranty\nModel: NW-DW450 dishwasher. Serial number: SN88214477\nThis warranty is valid until August 15, 2028.'],
  },
  passport: {
    name: 'passport scan.pdf',
    pages: ['PASSPORT\nSurname: RIVERA Given names: ALEX\nPassport No.: X12345678\nDate of issue: 10 MAR 2021\nDate of expiry: 09 MAR 2031'],
  },
} as const;
