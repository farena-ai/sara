// Stdio MCP server for B2 fix 7: tools that return MCP image blocks (like ComfyUI's get_image).
import { createInterface } from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const img = (data = PNG, mimeType = 'image/png') => ({ type: 'image', data, mimeType });
const TOOLS = {
  get_image: () => [{ type: 'text', text: 'ComfyUI_00001_.png' }, img()],
  big: () => [img(Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(9 * 1024 * 1024)]).toString('base64'))],
  svg: () => [img(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64'), 'image/svg+xml')],
  many: () => [img(), img(), img(), img(), img()],
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') return send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'img', version: '1' } } });
  if (msg.method === 'tools/list') return send({ jsonrpc: '2.0', id: msg.id, result: { tools: Object.keys(TOOLS).map((name) => ({ name, description: `Returns ${name} pictures`, inputSchema: { type: 'object', properties: {} } })) } });
  if (msg.method === 'tools/call') return send({ jsonrpc: '2.0', id: msg.id, result: { content: TOOLS[msg.params.name]() } });
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
});
