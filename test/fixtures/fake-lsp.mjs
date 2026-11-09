// A tiny language server for test/c13-lsp.test.ts: LSP framing over stdio, initialize, didOpen
// (publishes one diagnostic), definition, references, hover. FAKE_LSP_MODE=hang never answers
// requests after initialize; FAKE_LSP_MODE=crash exits on didOpen.
let buf = Buffer.alloc(0);
const mode = process.env.FAKE_LSP_MODE ?? '';
const send = (m) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m }), 'utf8');
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const docs = new Map();
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) return;
    const len = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, end).toString())?.[1] ?? 0);
    if (buf.length < end + 4 + len) return;
    const msg = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8'));
    buf = buf.subarray(end + 4 + len);
    handle(msg);
  }
});
function handle(m) {
  const p = m.params ?? {};
  if (m.method === 'initialize') return send({ id: m.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true, textDocumentSync: 1 }, serverInfo: { name: 'fake-lsp', version: process.env.SARA_SECRET_PROBE ?? 'clean' } } });
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') process.exit(0);
  if (m.method === 'textDocument/didOpen' || m.method === 'textDocument/didChange') {
    if (mode === 'crash') process.exit(3);
    const uri = p.textDocument.uri;
    const text = p.textDocument.text ?? p.contentChanges?.[0]?.text ?? '';
    docs.set(uri, text);
    const line = text.split('\n').findIndex((l) => l.includes('oops'));
    return send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: line < 0 ? [] : [{ range: { start: { line, character: 0 }, end: { line, character: 4 } }, severity: 1, source: 'fake', message: 'oops is not defined' }] } });
  }
  if (m.id === undefined) return;
  if (mode === 'hang') return;
  const uri = p.textDocument?.uri;
  if (m.method === 'textDocument/definition') return send({ id: m.id, result: [{ uri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } } }] });
  if (m.method === 'textDocument/references') return send({ id: m.id, result: [{ uri, range: { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } } }, { uri, range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }] });
  if (m.method === 'textDocument/hover') return send({ id: m.id, result: { contents: { kind: 'markdown', value: `function greet(): string (at ${p.position.line}:${p.position.character})` } } });
  send({ id: m.id, error: { code: -32601, message: 'no' } });
}
