// Phase 128 PL2c (docs/design/POLISH2.md N13, N14): what a plugin's review card warns about. Amber on
// everything teaches people to ignore amber, so Sara's OWN plugins (proven by the server:
// Review.firstParty, the 2.61.0 rule; the fingerprint check still runs at every approve) get one calm
// line where this computer can't fence plugins in, and the scan's "sends data to <host>" lines fold
// into What it can do when that host is one the plugin declares. Every other plugin (third-party,
// reviewed or not, an update that asks for more, a pulled version, any other scan finding) keeps
// every amber line. No DOM work at import time, so this can be checked in Node.
import { t } from './naming.js';

export const FINDING = {
  injection: (f) => t('In {file}: “{text}” looks like an attempt to change her instructions.', { file: f.file, text: f.text }),
  egress: (f) => t('In {file}: sends data to {host}.', { file: f.file, host: f.host ?? '?' }),
  secret: (f) => t('In {file}: contains what looks like a key or password.', { file: f.file }),
  binary: (f) => t('{file} is not a text file.', { file: f.file }),
};

const declared = (r) => (r.manifest?.permissions?.network ?? []).map((h) => String(h).toLowerCase());
const hostOk = (host, list) => {
  const h = String(host ?? '').toLowerCase().replace(/\.$/, '');
  return list.some((a) => (a.startsWith('*.') ? h.endsWith(a.slice(1)) : h === a));
};

/** True when the card may use the calm wording: Sara's own plugin, nothing new asked, nothing odd found. */
export function calmReview(r) {
  if (r?.firstParty !== true) return false;
  if (r.kind === 'update' && (r.added ?? []).length) return false;
  if (r.store?.yanked || r.unknownCallTools?.length) return false;
  const hosts = declared(r);
  return (r.findings ?? []).every((f) => f.kind === 'egress' && hostOk(f.host, hosts));
}

/** The card's notices: `calm` (one plain line, or null) and `warn` (the amber lines), and whether the fence chip is amber. */
export function reviewNotices(r, o = {}) {
  const calm = calmReview(r);
  const warn = [];
  if (r.fence === 'node-only' && !calm) warn.push(t("This computer can't fence the plugin in. Only add plugins you trust."));
  if (!calm) for (const f of r.findings ?? []) warn.push(FINDING[f.kind] ? FINDING[f.kind](f) : f.text);
  if (r.store?.yanked) warn.push(t('This version was pulled from the store: {reason}', { reason: r.store.yanked }));
  if (r.unknownCallTools?.length) warn.push(t('It asks for tools this server does not have: {names}', { names: r.unknownCallTools.join(', ') }));
  const windows = o.windows ?? r.os === 'win32';
  const line = r.fence === 'node-only' ? (windows ? t('Runs with Node’s permission limits; no sandbox on Windows. Made and checked by the Sara team.') : t('Runs with Node’s permission limits; no sandbox on this computer. Made and checked by the Sara team.')) : null;
  return { calm: calm ? line : null, warn, amberChip: r.fence === 'node-only' && !calm };
}
