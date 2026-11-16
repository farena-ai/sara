// HANDSFREE 3b (docs/CALENDAR_LINKS.md → "Set up Google sign-in for me"): the guided errand that drives her
// browser through making the person's own Google app (a Cloud project, the Calendar and Gmail APIs, the
// Google Auth Platform branding and audience, a Web client with Sara's redirect address) in hands-free mode.
// Only signing in is the person's ("your turn"); copying the Client ID and secret into Sara is theirs too
// (she never reads a secret off a page into her model).
//
// Pure: a list of checkpoints, each with the page to open, what to do there and how to tell from a page
// (address, title, visible text) that it is done. pc_google_setup asks this "where am I, what next?".
// Google changes its console now and then: each step names the goal in plain words, so she can still find
// it when a button moved. Real Google can't be tested here; test/google-setup.test.ts uses fake pages.

export interface SetupPage {
  url: string;
  title?: string;
  text?: string;
}
export interface SetupStep {
  id: 'project' | 'apis' | 'branding' | 'audience' | 'client' | 'paste';
  title: string;
  open: string;
  how: string;
  /** This page shows the step finished. */
  done: (p: SetupPage) => boolean;
  /** This page is where the step is done (she is in the right place). */
  here: (p: SetupPage) => boolean;
}

const host = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return '';
  }
};
const path = (u: string): string => {
  try {
    const x = new URL(u);
    return `${x.pathname}${x.search}`;
  } catch {
    return '';
  }
};
const words = (p: SetupPage) => `${p.title ?? ''}\n${p.text ?? ''}`;
const CONSOLE = (p: SetupPage) => host(p.url) === 'console.cloud.google.com';

/** A Google sign-in page: the person's turn (never hers: she doesn't type passwords or codes). */
export function isGoogleSignIn(p: SetupPage): boolean {
  const h = host(p.url);
  return h === 'accounts.google.com' && /\/(?:v3\/)?signin|\/ServiceLogin|\/challenge|\/AccountChooser|\/InteractiveLogin/i.test(path(p.url));
}

export function setupSteps(redirect: string): SetupStep[] {
  return [
    {
      id: 'project',
      title: 'Make a Google Cloud project',
      open: 'https://console.cloud.google.com/projectcreate',
      how: 'Type the project name "Sara" (any name is fine), leave Location as it is, press Create, and wait until the notification says the project is ready. Then pick that project in the project list at the top if it isn\u2019t picked.',
      here: (p) => CONSOLE(p) && /projectcreate/.test(path(p.url)),
      done: (p) => CONSOLE(p) && !/projectcreate/.test(path(p.url)) && /[?&]project=[a-z][a-z0-9-]{4,}/i.test(path(p.url)),
    },
    {
      id: 'apis',
      title: 'Turn on the Google Calendar API and the Gmail API',
      open: 'https://console.cloud.google.com/apis/library/calendar-json.googleapis.com',
      how: 'Press Enable on the Google Calendar API page. Then open https://console.cloud.google.com/apis/library/gmail.googleapis.com and press Enable there too (both pages then show "API Enabled" or a Manage button).',
      here: (p) => CONSOLE(p) && /\/apis\/(?:library|api)\/(?:calendar-json|gmail)\.googleapis\.com/.test(path(p.url)),
      done: (p) => CONSOLE(p) && /gmail\.googleapis\.com/.test(path(p.url)) && /\bAPI enabled\b|\bManage\b|\bDisable API\b/i.test(words(p)),
    },
    {
      id: 'branding',
      title: 'Set up the Google Auth Platform (app name and contact)',
      open: 'https://console.cloud.google.com/auth/overview',
      how: 'Press Get started. App name "Sara"; User support email: the person\u2019s own address from the list; Next. Audience: External; Next. Contact information: the same address; Next. Tick "I agree to the Google API Services: User Data Policy"; Continue; Create.',
      here: (p) => CONSOLE(p) && /\/auth\/(?:overview|branding)/.test(path(p.url)),
      done: (p) => CONSOLE(p) && /\/auth\//.test(path(p.url)) && /OAuth configuration created|Create OAuth client|\bMetrics\b|Project configuration/i.test(words(p)) && !/\bGet started\b/i.test(p.text ?? ''),
    },
    {
      id: 'audience',
      title: 'Publish the app (or Google signs her out every 7 days)',
      open: 'https://console.cloud.google.com/auth/audience',
      how: 'Under Publishing status press "Publish app", then Confirm. Google will call it unverified: that is expected for the person\u2019s own app.',
      here: (p) => CONSOLE(p) && /\/auth\/audience/.test(path(p.url)),
      done: (p) => CONSOLE(p) && /\/auth\/audience/.test(path(p.url)) && /\bIn production\b/i.test(words(p)),
    },
    {
      id: 'client',
      title: 'Make the Web client with Sara\u2019s redirect address',
      open: 'https://console.cloud.google.com/auth/clients/create',
      how: `Application type: Web application. Name: "Sara". Under "Authorized redirect URIs" press Add URI and type exactly ${redirect} (nothing else). Press Create. Google then shows the Client ID and Client secret: don't read the secret out; leave that window open for the person.`,
      here: (p) => CONSOLE(p) && /\/auth\/clients|\/apis\/credentials\/oauthclient/.test(path(p.url)),
      done: (p) => CONSOLE(p) && /OAuth client created|Client secret/i.test(words(p)),
    },
    {
      id: 'paste',
      title: 'The person copies the Client ID and secret into Sara and signs in',
      open: '',
      how: 'Your turn for the person (pc_browser_your_turn, what: "copy the Client ID and Client secret into Sara → Settings → Gmail and Calendar, press Save, then Sign in with Google"). Tell them in one line which two values to copy. You never type or read the secret yourself.',
      here: () => false,
      done: () => false,
    },
  ];
}

export interface SetupNext {
  /** Steps already done (as far as the pages she saw show). */
  done: string[];
  step: SetupStep;
  signIn: boolean;
  text: string;
}

/**
 * Where she is and what to do next. `doneBefore` are the checkpoints she passed earlier in this chat (kept by
 * the tool); a page that shows a later step finished counts the earlier ones as done too.
 */
export function nextSetupStep(page: SetupPage, redirect: string, doneBefore: ReadonlySet<string> = new Set()): SetupNext {
  const steps = setupSteps(redirect);
  const done = new Set(doneBefore);
  steps.forEach((s, i) => {
    if (s.done(page)) for (const x of steps.slice(0, i + 1)) done.add(x.id);
  });
  const step = steps.find((s) => !done.has(s.id))!;
  const signIn = isGoogleSignIn(page);
  const n = steps.indexOf(step) + 1;
  const lines = [`Google sign-in setup: step ${n} of ${steps.length}: ${step.title}.`, done.size ? `Done so far: ${steps.filter((s) => done.has(s.id)).map((s) => s.title).join('; ')}.` : 'Nothing done yet.'];
  if (signIn) lines.push('This is Google\u2019s sign-in page: the person signs in themselves. Call pc_browser_your_turn with what "sign in to your Google account" now, then look again and call pc_google_setup again.');
  else if (!step.open) lines.push(step.how);
  else if (step.here(page)) lines.push(`You are on the right page. ${step.how}`);
  else lines.push(`Open ${step.open} (pc_browser_open), look, then: ${step.how}`);
  lines.push('After each step: pc_browser_look, then call pc_google_setup again with the page you see. If Google shows a different layout, look for the same goal in plain words; if something needs a payment or a phone number, stop and tell the person.');
  return { done: steps.filter((s) => done.has(s.id)).map((s) => s.id), step, signIn, text: lines.join('\n') };
}

/** Sara's redirect address from the person's message (the Settings button puts it there). */
export function redirectFrom(text: string): string | undefined {
  return /\bhttps?:\/\/[^\s"'<>]+\/api\/google\/callback\b/.exec(String(text ?? ''))?.[0];
}
