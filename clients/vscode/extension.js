// Sara for VS Code (Phase 52). Plain JavaScript, no packages, no build step.
// The panel is the same Sara as the web app: it talks to your own server with a device token
// (Sara: Sign in shows a short code that you approve in Settings → Devices and sign-in). The
// open file's name and the selection go along as context, size-capped, and the panel shows
// exactly what was sent. The token is kept in VS Code's secret storage, never in settings.
// Phase 68: several servers, each with its own sign-in (profiles.js); the status bar shows the one
// in use and switches.
'use strict';
const vscode = require('vscode');
const P = require('./profiles.js');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const TOKEN_KEY = 'sara.deviceToken';
const VERSION = '1.0.2';
/** Files that are never sent (env files, keys, credentials). */
const SECRET_FILE = /(^\.env($|\.)|^\.npmrc$|^\.netrc$|^id_(rsa|dsa|ecdsa|ed25519)|\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|gpg)$|^credentials(\.\w+)?$|secret|password|\.tfstate$)/i;

/** @param {string} raw */
function normalizeServer(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `${/^(localhost|127\.)/.test(s) ? 'http' : 'https'}://${s}`;
  const u = new URL(s);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
}

/**
 * The saved sign-in: the device token together with the exact server it was issued by. A plain old
 * token (saved before 0.55) is bound to the user-level setting, never to a workspace's.
 * @returns {{ token: string, server: string } | undefined}
 */
function parseSaved(raw, legacyServer) {
  if (!raw) return undefined;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.token === 'string' && typeof j.server === 'string') return { token: j.token, server: normalizeServer(j.server) };
  } catch {
    /* an old plain token */
  }
  if (typeof raw === 'string' && raw.startsWith('sara_dev.') && legacyServer) return { token: raw, server: normalizeServer(legacyServer) };
  return undefined;
}

/**
 * The token to send to `server`, or undefined when it was saved for another server: a token never
 * goes to an address it wasn't issued by (a cloned repo's settings could point elsewhere).
 */
function tokenForServer(saved, server) {
  if (!saved || !server) return undefined;
  let a;
  let b;
  try {
    a = normalizeServer(saved.server);
    b = normalizeServer(server);
  } catch {
    return undefined;
  }
  return a && a === b ? saved.token : undefined;
}

/** Reads server-sent events: yields each `data:` JSON object. */
async function* sseEvents(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
      if (!data) continue;
      try {
        yield JSON.parse(data);
      } catch {
        /* skip */
      }
    }
  }
}

/**
 * What goes with a question from the editor: the file name (relative to the workspace), its
 * language, the lines, and the code itself, cut at `max` characters.
 */
function editorContext(editor, opts) {
  const doc = editor.document;
  const rel = vscode.workspace.asRelativePath(doc.uri, false);
  const name = path.basename(doc.fileName);
  if (SECRET_FILE.test(name)) return { refused: `${name} looks like a secret (keys, .env, passwords), so it isn't sent.` };
  const sel = editor.selection;
  const whole = opts.whole || sel.isEmpty;
  const range = whole ? new vscode.Range(0, 0, doc.lineCount, 0) : new vscode.Range(sel.start.line, 0, sel.end.line, doc.lineAt(Math.min(sel.end.line, doc.lineCount - 1)).text.length);
  let code = doc.getText(range);
  const max = opts.max;
  const cut = code.length > max;
  if (cut) code = code.slice(0, max);
  const first = range.start.line + 1;
  const last = Math.min(doc.lineCount, range.end.line + (whole ? 0 : 1));
  const lines = whole ? `the whole file (${doc.lineCount} lines)` : `lines ${first}-${last} of ${doc.lineCount}`;
  const fence = code.includes('```') ? '~~~~' : '```';
  const text = `[From VS Code: the owner shared this from the open editor.]\nFile: ${rel} (${doc.languageId}), ${lines}${cut ? `, cut at ${max} characters` : ''}\n${fence}${doc.languageId}\n${code}\n${fence}`;
  return { text, summary: `${rel} · ${lines} · ${code.length.toLocaleString()} characters${cut ? ' (cut)' : ''}` };
}

/** The saved servers (profiles.js), in secret storage; the old single sign-in is moved in once. */
class Servers {
  constructor(context) {
    this.context = context;
    this.state = undefined;
    this.listeners = [];
  }
  async load() {
    if (this.state) return this.state;
    const raw = await this.context.secrets.get(P.PROFILES_KEY);
    if (raw) return (this.state = P.migrate(raw));
    // Before 1.8: one token bound to the user-level sara.server setting.
    const c = vscode.workspace.getConfiguration('sara').inspect('server');
    const legacy = parseSaved(await this.context.secrets.get(TOKEN_KEY), c && c.globalValue);
    const state = P.migrate(undefined, legacy);
    if (state.servers.length) {
      await this.save(state);
      await this.context.secrets.delete(TOKEN_KEY);
      const conv = this.context.workspaceState.get('sara.conversationId');
      if (conv) await this.context.workspaceState.update(`sara.conversationId.${state.active}`, conv);
    }
    return (this.state = state);
  }
  async save(state) {
    this.state = state;
    await this.context.secrets.store(P.PROFILES_KEY, JSON.stringify(state));
    for (const f of this.listeners) f(state);
  }
  async active() {
    return P.active(await this.load());
  }
  onChange(f) {
    this.listeners.push(f);
  }
}

class SaraClient {
  constructor(context, servers) {
    this.context = context;
    this.servers = servers;
  }
  async profile() {
    return this.servers.active();
  }
  async token() {
    const p = await this.profile();
    return p ? P.tokenFor(p, p.url) : undefined;
  }
  /** `init.server`: an address being signed in to (no token is ever sent there). */
  async request(p, init = {}) {
    const profile = init.server ? undefined : await this.profile();
    const server = init.server || (profile && profile.url);
    if (!server) throw new Error('Add your Sara server first: run "Sara: Sign in".');
    // A profile's token only ever goes to that profile's own address.
    const token = init.noAuth || init.server ? undefined : P.tokenFor(profile, server);
    const headers = { 'user-agent': `SaraVSCode/${VERSION} (${os.platform()})` };
    if (token) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.bytes) headers['content-type'] = 'application/octet-stream';
    let res;
    try {
      res = await fetch(`${server}/api${p}`, { method: init.method || (init.body !== undefined || init.bytes ? 'POST' : 'GET'), headers, body: init.bytes || (init.body !== undefined ? JSON.stringify(init.body) : undefined), signal: init.signal, redirect: 'error' });
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      throw new Error(`Couldn't reach ${server}. Is the address right and the server running?`);
    }
    return res;
  }
  async json(p, init = {}) {
    const res = await this.request(p, init);
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'Not signed in (or this editor was signed out). Run "Sara: Sign in".' : data.error || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

class SaraPanel {
  constructor(context, client) {
    this.context = context;
    this.client = client;
    this.view = undefined;
    this.busy = undefined;
    this.queue = [];
    this.companion = 'Sara';
  }

  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    const nonce = crypto.randomBytes(16).toString('base64');
    const js = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js'));
    const css = view.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css'));
    // Strict: only this extension's own script (with its nonce) and stylesheet; no network at all
    // from the page (the extension talks to the server, the page only shows what it's given).
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${view.webview.cspSource}; connect-src 'none'; form-action 'none'; base-uri 'none'">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${css}"><title>Sara</title></head>
<body><div id="status" class="status" role="status"></div><div id="log" class="log" aria-live="polite"></div>
<form id="composer" class="composer"><textarea id="input" rows="3" placeholder="Message Sara (Enter sends, Shift+Enter for a new line)"></textarea>
<div class="row"><button id="send" type="submit">Send</button><button id="stop" type="button" class="ghost" hidden>Stop</button><button id="new" type="button" class="ghost">New conversation</button><button id="signin" type="button" class="ghost" hidden>Sign in</button><button id="switch" type="button" class="ghost" hidden>Switch server</button></div></form>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    void this.refresh();
  }

  post(msg) {
    if (this.view) void this.view.webview.postMessage(msg);
    else this.queue.push(msg);
  }

  async refresh() {
    const p = await this.client.profile();
    const token = await this.client.token();
    if (!token || !p) return this.post({ type: 'state', signedIn: false, server: p ? p.url : '' });
    try {
      const me = await this.client.json('/device/whoami');
      this.companion = me.companion || 'Sara';
      // Her name on that server names the profile until the user renames it.
      const state = await this.client.servers.load();
      const next = P.rename(state, p.id, this.companion, { herName: true });
      if (JSON.stringify(next) !== JSON.stringify(state)) await this.client.servers.save(next);
      const now = P.active(next);
      this.post({ type: 'state', signedIn: true, server: p.url, serverName: now ? now.name : p.name, servers: next.servers.length, companion: this.companion, device: me.device && me.device.label });
    } catch (err) {
      this.post({ type: 'state', signedIn: false, server: p.url, error: err.message });
    }
  }

  /** This workspace's conversation on the server in use (each server keeps its own). */
  async convKey() {
    const p = await this.client.profile();
    return `sara.conversationId.${p ? p.id : 'none'}`;
  }

  async onMessage(m) {
    if (m.type === 'send') return this.ask(String(m.text || ''));
    if (m.type === 'stop') return this.stop();
    if (m.type === 'new') {
      await this.context.workspaceState.update(await this.convKey(), undefined);
      return this.post({ type: 'notice', text: 'The next message starts a new conversation.' });
    }
    if (m.type === 'signIn') return vscode.commands.executeCommand('sara.signIn');
    if (m.type === 'switch') return vscode.commands.executeCommand('sara.switchServer');
    if (m.type === 'approve') {
      try {
        await this.client.json(`/approvals/${encodeURIComponent(m.approvalId)}`, { body: { approved: Boolean(m.approved) } });
      } catch (err) {
        this.post({ type: 'error', message: err.message });
      }
    }
  }

  async conversation() {
    const key = await this.convKey();
    const saved = this.context.workspaceState.get(key);
    if (saved) {
      try {
        await this.client.json(`/conversations/${encodeURIComponent(saved)}?limit=20`);
        return saved;
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    // A coding conversation in her default workspace (same memory and personality as everywhere).
    const c = await this.client.json('/conversations', { body: { mode: 'coding' } });
    await this.context.workspaceState.update(key, c.id);
    return c.id;
  }

  async disclosure() {
    const me = await this.client.json('/device/whoami');
    if (me.disclosureAccepted) return true;
    const ok = await vscode.window.showInformationMessage(me.disclosure, { modal: true }, 'I understand');
    if (ok !== 'I understand') return false;
    await this.client.json('/disclosure/accept', { body: {} });
    return true;
  }

  /** Shows the panel and asks; `context` is the editor context (shown to the owner as sent). */
  async ask(question, context) {
    question = question.trim();
    if (!question) return;
    if (this.busy) return this.post({ type: 'error', message: 'She is still answering. Press Stop first.' });
    await vscode.commands.executeCommand('sara.chat.focus');
    const token = await this.client.token();
    if (!token) return this.post({ type: 'error', message: 'Sign in first: run "Sara: Sign in".' });
    const ctl = new AbortController();
    this.busy = { ctl, convId: undefined };
    try {
      if (!(await this.disclosure())) throw new Error('Accept the disclosure to chat.');
      const convId = await this.conversation();
      this.busy.convId = convId;
      const p = await this.client.profile();
      this.post({ type: 'user', text: question, ...(context ? { context: `${context.summary} → ${p ? p.name : ''}`, sent: context.text } : {}) });
      const content = context ? `${question}\n\n${context.text}` : question;
      const res = await this.client.request(`/conversations/${encodeURIComponent(convId)}/messages`, { body: { content }, signal: ctl.signal });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(res.status === 401 ? 'Not signed in (or this editor was signed out). Run "Sara: Sign in".' : data.error || `HTTP ${res.status}`);
      }
      this.post({ type: 'start', name: this.companion });
      for await (const ev of sseEvents(res.body)) {
        if (ev.type === 'token') this.post({ type: 'token', text: ev.text });
        else if (ev.type === 'tool_call') this.post({ type: 'tool', text: ev.summary || ev.name });
        else if (ev.type === 'tool_result' && ev.status !== 'ok') this.post({ type: 'tool', text: `${ev.status === 'denied' ? 'not allowed' : 'failed'}: ${String(ev.output || '').split('\n')[0].slice(0, 160)}` });
        else if (ev.type === 'approval') this.post({ type: 'approval', approvalId: ev.approvalId, text: ev.summary || ev.name });
        else if (ev.type === 'notice') this.post({ type: 'notice', text: ev.text });
        else if (ev.type === 'replace') this.post({ type: 'replace', text: ev.text });
        else if (ev.type === 'error') this.post({ type: 'error', message: ev.message });
      }
    } catch (err) {
      if (!(err && err.name === 'AbortError')) this.post({ type: 'error', message: err.message });
    } finally {
      this.busy = undefined;
      this.post({ type: 'done' });
    }
  }

  async stop() {
    const b = this.busy;
    if (!b || !b.convId) return;
    // Stopping on the server keeps what she wrote so far; the stream then ends by itself.
    await this.client.json(`/conversations/${encodeURIComponent(b.convId)}/stop`, { body: {} }).catch(() => undefined);
  }
}

/** Signs in to a server (a new one, or the same address again) and makes it the one in use. */
async function signIn(context, client, panel, opts = {}) {
  const current = await client.profile();
  const server = normalizeServer(
    (await vscode.window.showInputBox({ title: opts.adding ? 'Sara: Add a server' : 'Sara: Sign in', prompt: "Your Sara server's address (each server keeps its own sign-in)", value: opts.adding || !current ? 'https://' : current.url, ignoreFocusOut: true, validateInput: (v) => (/^https?:\/\/[^/\s]+/i.test(v.trim()) ? undefined : 'An address like https://sara.example.com') })) || '',
  );
  if (!server) return;
  const name = `VS Code on ${os.platform() === 'win32' ? 'Windows' : os.platform() === 'darwin' ? 'Mac' : 'Linux'} (${os.hostname().slice(0, 30)})`;
  let start;
  try {
    start = await client.json('/device/start', { body: { name }, server });
  } catch (err) {
    return vscode.window.showErrorMessage(`Sara: ${err.message}`);
  }
  panel.post({ type: 'notice', text: `Approve the code ${start.code} in ${start.approveIn}, or open ${start.verifyUrl} where you're signed in and type the code.` });
  const open = 'Open the approval page';
  void vscode.window.showInformationMessage(`Sara: approve the code ${start.code} on ${P.hostOf(server)} (Settings → Devices and sign-in).`, open).then((pick) => {
    if (pick === open) void vscode.env.openExternal(vscode.Uri.parse(start.verifyUrl));
  });
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sara: waiting for you to approve ${start.code}…`, cancellable: true }, async (_p, cancel) => {
    const until = Date.parse(start.expiresAt);
    while (Date.now() < until && !cancel.isCancellationRequested) {
      await new Promise((r) => setTimeout(r, Math.max(1, start.interval || 2) * 1000));
      const res = await client.request('/device/poll', { body: { pollToken: start.pollToken }, server }).catch(() => undefined);
      if (!res) continue;
      const body = await res.json().catch(() => ({}));
      if (body.status === 'approved' && body.token) {
        await client.servers.save(P.upsert(await client.servers.load(), { url: server, token: body.token, deviceId: body.deviceId }));
        await panel.refresh();
        const p = await client.profile();
        void vscode.window.showInformationMessage(`Sara: signed in to ${p ? p.name : server}. ${(await client.servers.load()).servers.length > 1 ? 'Switch servers from the status bar.' : ''}`);
        return;
      }
      if (body.status === 'denied') return void vscode.window.showWarningMessage('Sara: the sign-in was denied.');
      if (res.status === 410) return void vscode.window.showWarningMessage('Sara: the code expired. Run "Sara: Sign in" again.');
    }
  });
}

/** Signs this editor out of one server and forgets only that server's token. */
async function removeServer(client, panel, id) {
  const state = await client.servers.load();
  const p = state.servers.find((x) => x.id === id);
  if (!p) return;
  if (p.token) await fetch(`${p.url}/api/device/logout`, { method: 'POST', headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' }, body: '{}', redirect: 'error' }).catch(() => undefined);
  await client.servers.save(P.remove(await client.servers.load(), id));
  const now = await client.profile();
  void vscode.window.showInformationMessage(`Sara: signed out of ${p.name}. This editor no longer has a token for it.${now ? ` Now using ${now.name}.` : ''}`);
  void panel.refresh();
}

/** Sara: Switch server: the saved servers, then Add, Rename and Remove. */
async function switchServer(context, client, panel) {
  const state = await client.servers.load();
  const items = state.servers.map((p) => ({ label: `${p.id === state.active ? '$(check) ' : ''}${p.emoji ? `${p.emoji} ` : ''}${p.name}`, description: P.hostOf(p.url), detail: p.id === state.active ? 'In use: Sara on this server can use the files you send from VS Code' : undefined, id: p.id }));
  const add = { label: '$(add) Add a Sara…', description: 'sign in to another server', action: 'add' };
  const ren = { label: '$(edit) Rename…', action: 'rename' };
  const rem = { label: '$(trash) Remove a server…', description: 'signs out of that one only', action: 'remove' };
  const pick = await vscode.window.showQuickPick([...items, add, ...(state.servers.length ? [ren, rem] : [])], { title: 'Sara: Switch server', placeHolder: 'Which Sara should this editor talk to?' });
  if (!pick) return;
  if (pick.action === 'add') return signIn(context, client, panel, { adding: true });
  if (pick.action === 'rename' || pick.action === 'remove') {
    const which = state.servers.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: pick.action === 'remove' ? 'Remove which server?' : 'Rename which server?' });
    if (!which) return;
    const p = state.servers.find((x) => x.id === which.id);
    if (pick.action === 'remove') {
      const yes = 'Sign out and remove';
      if ((await vscode.window.showWarningMessage(`Remove ${p.name} (${P.hostOf(p.url)})? This editor signs out of that server only; the others stay signed in.`, { modal: true }, yes)) === yes) await removeServer(client, panel, p.id);
      return;
    }
    const to = await vscode.window.showInputBox({ title: 'Rename server', value: p.name, ignoreFocusOut: true });
    if (to && to.trim()) await client.servers.save(P.rename(await client.servers.load(), p.id, to.trim()));
    return void panel.refresh();
  }
  await client.servers.save(P.use(await client.servers.load(), pick.id));
  panel.post({ type: 'clear' });
  void panel.refresh();
}

function activate(context) {
  const servers = new Servers(context);
  const client = new SaraClient(context, servers);
  const panel = new SaraPanel(context, client);
  // The status bar: the server in use ("Sara on <server> can use this computer"); click to switch.
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'sara.switchServer';
  const paint = (state) => {
    const st = P.statusText(state);
    bar.text = st.text;
    bar.tooltip = st.tooltip;
    bar.show();
  };
  servers.onChange(paint);
  void servers.load().then(paint);
  const max = () => Math.max(1000, Math.min(60000, Number(vscode.workspace.getConfiguration('sara').get('maxContextChars')) || 12000));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('sara.chat', panel, { webviewOptions: { retainContextWhenHidden: true } }),
    bar,
    vscode.commands.registerCommand('sara.signIn', () => signIn(context, client, panel)),
    vscode.commands.registerCommand('sara.addServer', () => signIn(context, client, panel, { adding: true })),
    vscode.commands.registerCommand('sara.switchServer', () => switchServer(context, client, panel)),
    vscode.commands.registerCommand('sara.signOut', async () => {
      const p = await client.profile();
      if (!p) return void vscode.window.showInformationMessage('Sara: this editor isn\'t signed in to any server.');
      await removeServer(client, panel, p.id);
    }),
    vscode.commands.registerCommand('sara.newConversation', async () => {
      await context.workspaceState.update(await panel.convKey(), undefined);
      panel.post({ type: 'notice', text: 'The next message starts a new conversation.' });
    }),
    vscode.commands.registerCommand('sara.askSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('Sara: open a file and select some code first.');
      const ctx = editorContext(editor, { max: max() });
      if (ctx.refused) return vscode.window.showWarningMessage(`Sara: ${ctx.refused}`);
      const q = await vscode.window.showInputBox({ title: 'Ask Sara about the selection', prompt: `Sent with it: ${ctx.summary}`, value: 'What does this do, and is anything wrong with it?', ignoreFocusOut: true });
      if (q) await panel.ask(q, ctx);
    }),
    vscode.commands.registerCommand('sara.explainFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return vscode.window.showWarningMessage('Sara: open a file first.');
      const ctx = editorContext(editor, { max: max(), whole: true });
      if (ctx.refused) return vscode.window.showWarningMessage(`Sara: ${ctx.refused}`);
      await panel.ask('Explain this file: what it is for, how it works, and anything that looks wrong.', ctx);
    }),
    vscode.commands.registerCommand('sara.sendToLibrary', async (uri) => {
      const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri;
      if (!target) return vscode.window.showWarningMessage('Sara: pick a file (right-click it in the Explorer) or open one.');
      const name = path.basename(target.fsPath || target.path);
      if (SECRET_FILE.test(name)) return vscode.window.showWarningMessage(`Sara: ${name} looks like a secret (keys, .env, passwords), so it isn't sent.`);
      try {
        const bytes = Buffer.from(await vscode.workspace.fs.readFile(target));
        const p = await client.profile();
        const r = await client.json(`/library?${new URLSearchParams({ name, keep: '1' })}`, { bytes });
        void vscode.window.showInformationMessage(`Sara: ${r.already ? 'already in' : 'added to'} her library on ${p ? p.name : 'your server'}: ${r.doc.name}. She reads it in the background.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Sara: ${err.message}`);
      }
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate, normalizeServer, parseSaved, tokenForServer, sseEvents, SECRET_FILE, profiles: P };
