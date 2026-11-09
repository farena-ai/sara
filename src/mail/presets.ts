// M1: the IMAP + SMTP providers Sara knows, with their servers and where each makes an app password
// (the email bridge's table in docs/EMAIL_BRIDGE.md, extended). Outlook.com is not here: Microsoft
// switched basic-auth IMAP off, so it is the Microsoft sign-in (src/mail/graph.ts).

export interface ImapPreset {
  id: string;
  name: string;
  imap: { host: string; port: number };
  smtp: { host: string; port: number };
  /** Where the app password is made (the setup page links it). */
  passwordUrl?: string;
  /** One plain sentence on making it. */
  passwordHow: string;
  /** Sign-in name forms to try, in order: the whole address, or the part before @. */
  user: ('address' | 'local')[];
  /** Copy a sent mail into Sent (some servers file it themselves: then no copy). */
  copySent: boolean;
  /** A program on this computer (Proton Mail Bridge): loopback, its own certificate pinned. */
  loopback?: boolean;
  /** IMAP must be switched on in the provider's web settings first. */
  enableImap?: string;
}

export const IMAP_PRESETS: readonly ImapPreset[] = [
  // Gmail with an app password (2-Step Verification on): how a household member adds Gmail, since
  // the Google sign-in (src/google.ts) is the owner's alone. Gmail files sent mail itself.
  { id: 'gmail', name: 'Gmail (app password)', imap: { host: 'imap.gmail.com', port: 993 }, smtp: { host: 'smtp.gmail.com', port: 465 }, passwordUrl: 'https://myaccount.google.com/apppasswords', passwordHow: 'Google Account → Security → 2-Step Verification must be on; then App passwords → name it "Sara" → Create.', user: ['address'], copySent: false },
  { id: 'yahoo', name: 'Yahoo Mail', imap: { host: 'imap.mail.yahoo.com', port: 993 }, smtp: { host: 'smtp.mail.yahoo.com', port: 465 }, passwordUrl: 'https://login.yahoo.com/account/security', passwordHow: 'Yahoo Account → Account security → Generate app password (name it "Sara").', user: ['address'], copySent: true },
  { id: 'aol', name: 'AOL Mail', imap: { host: 'imap.aol.com', port: 993 }, smtp: { host: 'smtp.aol.com', port: 465 }, passwordUrl: 'https://login.aol.com/account/security', passwordHow: 'AOL Account → Account security → Generate app password.', user: ['address'], copySent: true },
  { id: 'icloud', name: 'iCloud Mail', imap: { host: 'imap.mail.me.com', port: 993 }, smtp: { host: 'smtp.mail.me.com', port: 587 }, passwordUrl: 'https://account.apple.com', passwordHow: 'account.apple.com → Sign-In and Security → App-Specific Passwords → Generate.', user: ['address', 'local'], copySent: true },
  { id: 'fastmail', name: 'Fastmail', imap: { host: 'imap.fastmail.com', port: 993 }, smtp: { host: 'smtp.fastmail.com', port: 465 }, passwordUrl: 'https://app.fastmail.com/settings/security/apps', passwordHow: 'Settings → Privacy & Security → Manage app passwords → New app password (access: IMAP and SMTP).', user: ['address'], copySent: true },
  { id: 'zoho', name: 'Zoho Mail', imap: { host: 'imap.zoho.com', port: 993 }, smtp: { host: 'smtp.zoho.com', port: 465 }, passwordUrl: 'https://accounts.zoho.com/home#security/app_password', passwordHow: 'Zoho Accounts → Security → App Passwords → Generate New Password. IMAP access must be on (Mail Settings → Mail Accounts → IMAP).', user: ['address'], copySent: true, enableImap: 'Zoho Mail → Settings → Mail Accounts → IMAP Access' },
  { id: 'zoho-eu', name: 'Zoho Mail (EU)', imap: { host: 'imap.zoho.eu', port: 993 }, smtp: { host: 'smtp.zoho.eu', port: 465 }, passwordUrl: 'https://accounts.zoho.eu/home#security/app_password', passwordHow: 'Zoho Accounts → Security → App Passwords → Generate New Password.', user: ['address'], copySent: true, enableImap: 'Zoho Mail → Settings → Mail Accounts → IMAP Access' },
  { id: 'gmx', name: 'GMX (gmx.com)', imap: { host: 'imap.gmx.com', port: 993 }, smtp: { host: 'mail.gmx.com', port: 465 }, passwordHow: 'Switch on IMAP in GMX → E-mail settings → POP3 & IMAP. With two-factor sign-in on, make an application-specific password in Security.', user: ['address'], copySent: true, enableImap: 'GMX → E-mail settings → POP3 & IMAP' },
  { id: 'gmx-de', name: 'GMX (gmx.net / .de / .at / .ch)', imap: { host: 'imap.gmx.net', port: 993 }, smtp: { host: 'mail.gmx.net', port: 465 }, passwordHow: 'GMX → E-Mail-Einstellungen → POP3 & IMAP: "Zugriff erlauben". With two-factor sign-in on, make an application-specific password.', user: ['address'], copySent: true, enableImap: 'GMX → E-Mail-Einstellungen → POP3 & IMAP' },
  { id: 'webde', name: 'WEB.DE', imap: { host: 'imap.web.de', port: 993 }, smtp: { host: 'smtp.web.de', port: 587 }, passwordHow: 'WEB.DE → E-Mail-Einstellungen → POP3/IMAP Abruf: allow it. With two-factor sign-in on, make an application-specific password.', user: ['address'], copySent: true, enableImap: 'WEB.DE → E-Mail-Einstellungen → POP3/IMAP Abruf' },
  { id: 'proton', name: 'Proton Mail (Bridge)', imap: { host: '127.0.0.1', port: 1143 }, smtp: { host: '127.0.0.1', port: 1025 }, passwordUrl: 'https://proton.me/mail/bridge', passwordHow: 'Install Proton Mail Bridge on this computer and sign in there (a paid Proton plan). Bridge shows the mailbox password under your account → Mailbox details: use that, not your Proton password.', user: ['address'], copySent: false, loopback: true },
];

export const presetById = (id: string): ImapPreset | undefined => IMAP_PRESETS.find((p) => p.id === id);

/** A guess from the address (the form preselects it). */
export function guessPreset(address: string): string | undefined {
  const d = address.split('@')[1]?.toLowerCase() ?? '';
  if (/^(yahoo|ymail|rocketmail)\./.test(d)) return 'yahoo';
  if (/^(aol|aim|verizon)\./.test(d)) return 'aol';
  if (/^(icloud|me|mac)\.com$/.test(d)) return 'icloud';
  if (/^(fastmail\.|fastmail\.fm$)/.test(d)) return 'fastmail';
  if (/^zoho(mail)?\.eu$/.test(d)) return 'zoho-eu';
  if (/^zoho(mail)?\./.test(d)) return 'zoho';
  if (/^gmx\.(com|us|co\.uk|fr|es)$/.test(d)) return 'gmx';
  if (/^gmx\.(net|de|at|ch)$/.test(d)) return 'gmx-de';
  if (d === 'web.de') return 'webde';
  if (/^(proton\.me|protonmail\.(com|ch)|pm\.me)$/.test(d)) return 'proton';
  return undefined;
}

/** Microsoft's consumer domains: these go to the Microsoft sign-in, not IMAP. */
export const isMicrosoftAddress = (address: string): boolean => /@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(address);
/** Google's: the Gmail sign-in. */
export const isGoogleAddress = (address: string): boolean => /@(gmail|googlemail)\.com$/i.test(address);
