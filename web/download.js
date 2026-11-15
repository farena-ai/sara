// R2: /download, the public download page (no sign-in). It picks this device's system
// (web/download-os.js), links the right installer from the latest public release (the server asks
// GitHub at most once an hour: GET /api/public/release) and says how to install it in plain steps.
// Windows builds aren't code-signed yet, so the SmartScreen note is part of the Windows steps.
// iPhone: no App Store app; Add to Home Screen from Safari (R4 adds Apple Shortcuts).
import { savedLang, setLanguage, t } from './naming.js';
import { detectOs, LINUX_COMMAND, OSES, primaryLink, RELEASES_PAGE } from './download-os.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** A forced system for checks and links: /download?os=mac. */
const forced = new URLSearchParams(location.search).get('os');
let os = OSES.includes(forced) ? forced : detectOs(navigator.userAgent, navigator.maxTouchPoints);
let assets = null;

const names = () => ({ windows: t('Windows'), mac: t('Mac'), linux: t('Linux'), android: t('Android'), iphone: t('iPhone') });

function words(which) {
  const w = {
    windows: {
      lead: t('The Sara app for Windows: Sara on this computer, in its own window.'),
      button: t('Download for Windows'),
      steps: [t('Open the file you downloaded (Sara-Setup).'), t('If Windows says "Windows protected your PC", choose More info, then Run anyway.'), t('Sara opens when it is installed. Sign in, or let the guide set her up.')],
      note: t('The installer is not code-signed yet, so Windows SmartScreen warns about it. It is the same file as on the release page, with its checksum in SHA256SUMS.'),
    },
    mac: {
      lead: t('The Sara app for Mac: Sara on this computer, in the menu bar and her own window.'),
      button: t('Download for Mac'),
      steps: [t('Open the file you downloaded (Sara.dmg).'), t('Drag Sara into Applications.'), t('Open Sara from Applications. Sign in, or let the guide set her up.')],
      note: '',
    },
    linux: {
      lead: t('Sara on a Linux computer or server, with one command.'),
      button: t('Open the installer'),
      steps: [t('Open a terminal.'), t('Paste this command and press Enter:'), t('When it finishes it shows her address. Open it in a browser.')],
      note: '',
    },
    android: {
      lead: t('The Sara app for Android phones and tablets.'),
      button: t('Get it on Google Play'),
      steps: [t('Install Sara from Google Play.'), t('Open it and scan the code from Settings → Connections → Phone and notifications on your computer.'), t('Allow notifications when it asks.')],
      note: '',
    },
    iphone: {
      lead: t('On iPhone and iPad, Sara is a web app you add to your Home Screen.'),
      button: '',
      steps: [t('Open your Sara address in Safari (scan the code from Settings → Connections → Phone and notifications on your computer).'), t('Tap Share, then Add to Home Screen.'), t('Open Sara from the Home Screen and allow notifications when it asks.')],
      note: t('There is no App Store app. The Home Screen app gets notifications and works like an app.'),
    },
  };
  return w[which];
}

function paint() {
  const w = words(os);
  const n = names();
  $('#dl-title').textContent = t('Get Sara for {system}', { system: n[os] });
  $('#dl-lead').textContent = w.lead;
  const main = $('#dl-main');
  main.replaceChildren();
  const link = primaryLink(os, assets);
  if (w.button && link) {
    const a = el('a', 'button-link dl-go', w.button);
    a.href = link;
    a.rel = 'noopener';
    const file = assets?.[os];
    if (file?.size && os !== 'android') a.title = `${file.name} · ${Math.round(file.size / 1e6)} MB`;
    main.append(a);
  }
  const steps = $('#dl-steps');
  steps.replaceChildren(...w.steps.map((s) => el('li', '', s)));
  if (os === 'linux') {
    const code = el('code', 'dl-cmd', LINUX_COMMAND);
    code.dataset.raw = '';
    steps.children[1]?.append(el('br'), code);
  }
  $('#dl-note').hidden = !w.note;
  $('#dl-note').textContent = w.note;
  $('#dl-other-h').textContent = t('Other devices');
  const other = $('#dl-other');
  other.replaceChildren(
    ...OSES.filter((x) => x !== os).map((x) => {
      const b = el('button', 'ghost small', n[x]);
      b.type = 'button';
      b.addEventListener('click', () => {
        os = x;
        paint();
      });
      return b;
    }),
  );
  const all = el('a', 'small dl-all', t('Every file of this release'));
  all.href = assets?.page || RELEASES_PAGE;
  all.rel = 'noopener';
  other.append(all);
  $('#dl-version').textContent = assets?.version ? t('Sara {version}, the latest release.', { version: assets.version }) : t('The release page lists every file.');
  document.title = $('#dl-title').textContent;
}

async function load() {
  const r = await fetch('/api/public/release').then((x) => (x.ok ? x.json() : null)).catch(() => null);
  assets = r?.assets ?? { page: RELEASES_PAGE, version: '' };
  paint();
}

void setLanguage(savedLang())
  .catch(() => {})
  .then(() => {
    paint();
    return load();
  });
