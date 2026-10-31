// Phase 91 test double: a tiny stand-in for the Bitwarden CLI (`bw`), the 1Password CLI (`op`) and
// KeePassXC's CLI (`keepassxc-cli`, kind `kpx`; the tests also run the real one with a new test database),
// answering the documented command shapes Sara's hands use, for ONE fixture vault in a scratch folder.
// It never talks to a network or a real vault. Run as `node fake-pm.mjs bw <args>` or `node fake-pm.mjs op
// <args>` (the launchers written by make.ts do that). Its folder is BITWARDENCLI_APPDATA_DIR (bw) or
// OP_CONFIG_DIR (op), which holds fixture.json; for kpx the "database" file named on the command line is
// the fixture itself (the test's obviously fake entries and master password)
// and state.json (hashes of the sessions it handed out; `bw lock` / `op signout` clear them).
//
// Prompts go to stderr and the master password is read from stdin, like the real tools; the session key
// (bw unlock --raw) or token (op signin --raw) goes to stdout. `bw list items --url` matches loosely (by
// host name, any port, like Bitwarden's default \"base domain\" matching), so the device's own exact-origin
// check is what keeps look-alikes out. Every call is appended to calls.log (arguments only, never input).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [kind, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(s);
const err = (s) => process.stderr.write(s);
if (args[0] === '--version') {
  out(kind === 'bw' ? '2026.9.0\n' : kind === 'op' ? '2.32.0\n' : 'keepassxc-cli 2.8.0\n');
  process.exit(0);
}
if (kind === 'kpx') {
  // keepassxc-cli export -f csv <database>: the prompt on stderr, the password from stdin, CSV on stdout.
  const db = args.at(-1);
  if (args[0] !== 'export' || !db || !existsSync(db)) {
    err('fake keepassxc-cli: only `export -f csv <database>`\n');
    process.exit(1);
  }
  const fx = JSON.parse(readFileSync(db, 'utf8'));
  appendFileSync(`${db}.calls.log`, `${new Date().toISOString()} keepassxc-cli ${args.slice(0, -1).join(' ')} <database>\n`);
  err(`Enter password to unlock ${db}: `);
  const typed = readLine();
  if (typed !== fx.master) {
    err('\nError while reading the database: Invalid credentials were provided, please try again.\n');
    process.exit(1);
  }
  const q = (v) => `"${String(v).replace(/"/g, '""')}"`;
  out(`${['Group', 'Title', 'Username', 'Password', 'URL', 'Notes', 'TOTP', 'Icon', 'Last Modified', 'Created'].map(q).join(',')}\r\n`);
  for (const e of fx.entries) out(`${['Passwords', e.title, e.username, e.password, e.url, '', '', '0', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z'].map(q).join(',')}\r\n`);
  process.exit(0);
}
const dir = kind === 'bw' ? process.env.BITWARDENCLI_APPDATA_DIR : process.env.OP_CONFIG_DIR;
if (!dir || !existsSync(join(dir, 'fixture.json'))) {
  err(`fake ${kind}: no fixture.json in its config folder\n`);
  process.exit(2);
}
appendFileSync(join(dir, 'calls.log'), `${new Date().toISOString()} ${kind} ${args.join(' ')}\n`);
const fx = JSON.parse(readFileSync(join(dir, 'fixture.json'), 'utf8'));
const statePath = join(dir, 'state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { sessions: [] };
const save = () => writeFileSync(statePath, JSON.stringify(state));
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const valid = (s) => Boolean(s) && state.sessions.includes(hash(s));

/** One line from stdin (the person typing into the prompt), without its line end. */
function readLine() {
  const buf = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let n = 0;
    try {
      n = readSync(0, buf, 0, 1, null);
    } catch (e) {
      if (e.code === 'EAGAIN') continue;
      if (e.code === 'EOF') break;
      throw e;
    }
    if (n === 0) break;
    const c = buf.toString('utf8');
    if (c === '\n') break;
    if (c !== '\r') line += c;
  }
  return line;
}
const hostOf = (u) => {
  try {
    return new URL(/^[a-z]+:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase();
  } catch {
    return '';
  }
};

if (kind === 'bw') {
  const [cmd, sub] = args;
  if (cmd === 'unlock') {
    err('? Master password: [input is hidden] ');
    const typed = readLine();
    err('\n');
    if (typed !== fx.master) {
      err('Invalid master password.\n');
      process.exit(1);
    }
    const key = randomBytes(32).toString('base64');
    state.sessions.push(hash(key));
    save();
    out(args.includes('--raw') ? key : `Your vault is now unlocked!\n\nexport BW_SESSION="${key}"\n`);
    process.exit(0);
  }
  if (cmd === 'status') {
    out(JSON.stringify({ serverUrl: null, lastSync: null, userEmail: fx.email ?? 'alex@example.test', status: valid(process.env.BW_SESSION) ? 'unlocked' : 'locked' }));
    process.exit(0);
  }
  if (cmd === 'lock') {
    state.sessions = [];
    save();
    out('Your vault is locked.\n');
    process.exit(0);
  }
  if (cmd === 'list' && sub === 'items') {
    if (!valid(process.env.BW_SESSION)) {
      err('Vault is locked.\n');
      process.exit(1);
    }
    const i = args.indexOf('--url');
    const want = i > 0 ? hostOf(args[i + 1]) : '';
    const items = fx.items
      .filter((it) => !want || want.includes(hostOf(it.uri)) || hostOf(it.uri).includes(want))
      .map((it, n) => ({ object: 'item', id: `item-${n}`, organizationId: null, folderId: null, type: 1, reprompt: 0, name: it.name, notes: null, favorite: false, login: { uris: [{ match: null, uri: it.uri }], username: it.username, password: it.password, totp: null, passwordRevisionDate: null }, collectionIds: [], revisionDate: '2026-10-01T00:00:00.000Z' }));
    out(JSON.stringify(items));
    process.exit(0);
  }
  err(`fake bw: not supported: ${args.join(' ')}\n`);
  process.exit(1);
}

if (kind === 'op') {
  const acct = fx.account ?? { shorthand: 'my', email: 'alex@example.test', url: 'my.1password.example', user_uuid: 'TESTUSER0001' };
  const session = process.env[`OP_SESSION_${acct.shorthand}`];
  const [cmd, sub, id] = args;
  const signedIn = valid(session);
  if (cmd === 'signin') {
    err(`Enter the password for ${acct.email} at ${acct.url}: `);
    const typed = readLine();
    err('\n');
    if (typed !== fx.master) {
      err('[ERROR] 2026/10/30 12:00:00 Unauthorized: You aren\u2019t authorized to sign in. Check your password.\n');
      process.exit(1);
    }
    const token = randomBytes(32).toString('base64url');
    state.sessions.push(hash(token));
    save();
    out(args.includes('--raw') ? token : `export OP_SESSION_${acct.shorthand}="${token}"\n`);
    process.exit(0);
  }
  if (cmd === 'signout') {
    state.sessions = [];
    save();
    process.exit(0);
  }
  if (cmd === 'account' && sub === 'list') {
    out(JSON.stringify([{ url: acct.url, email: acct.email, user_uuid: acct.user_uuid, account_uuid: 'TESTACCT0001', shorthand: acct.shorthand }]));
    process.exit(0);
  }
  if (!signedIn) {
    err('[ERROR] 2026/10/30 12:00:00 You are not currently signed in. Please run `op signin --help` for instructions\n');
    process.exit(1);
  }
  if (cmd === 'whoami') {
    out(JSON.stringify({ url: acct.url, email: acct.email, user_uuid: acct.user_uuid, account_uuid: 'TESTACCT0001', user_type: 'HUMAN' }));
    process.exit(0);
  }
  if (cmd === 'item' && sub === 'list') {
    out(JSON.stringify(fx.items.map((it) => ({ id: it.id, title: it.title, version: 1, vault: { id: 'TESTVAULT001', name: 'Private' }, category: 'LOGIN', urls: [{ primary: true, href: it.url }], created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z' }))));
    process.exit(0);
  }
  if (cmd === 'item' && sub === 'get') {
    const it = fx.items.find((x) => x.id === id);
    if (!it) {
      err(`[ERROR] 2026/10/30 12:00:00 "${id}" isn't an item.\n`);
      process.exit(1);
    }
    out(JSON.stringify({ id: it.id, title: it.title, version: 1, category: 'LOGIN', fields: [{ id: 'username', type: 'STRING', purpose: 'USERNAME', label: 'username', value: it.username }, { id: 'password', type: 'CONCEALED', purpose: 'PASSWORD', label: 'password', value: it.password }], urls: [{ primary: true, href: it.url }] }));
    process.exit(0);
  }
  err(`fake op: not supported: ${args.join(' ')}\n`);
  process.exit(1);
}
err('fake-pm: say bw or op\n');
process.exit(2);
