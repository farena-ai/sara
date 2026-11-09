'use strict';
// Fixed synthetic probes only. This file is never a supplied repository script.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const root = path.dirname(__dirname);
const out = path.join(root, 'output');
const mode = process.argv[2];
const result = { mode };
function denied(fn) {
  try { fn(); return false; } catch (e) { return e.code === 'EACCES' || e.code === 'EPERM'; }
}
async function main() {
  if (mode === 'memory') {
    try { const oversized = Buffer.alloc(600*1024*1024,1); result.memoryRefused = false; result.bytes = oversized.length; }
    catch(e) { result.memoryRefused = e instanceof RangeError; result.memoryError = e.message; }
    fs.writeFileSync(path.join(out,'done.json'),JSON.stringify(result)); setInterval(() => {},1000); return;
  }
  if (mode === 'timeout') { setInterval(() => {},1000); return; }
  if (['tree','child','grandchild'].includes(mode)) {
    const { spawn } = require('node:child_process');
    const start = next => spawn(process.execPath, ['--preserve-symlinks','--preserve-symlinks-main', __filename, next], {stdio:'ignore', windowsHide:true, env:process.env});
    if (mode === 'grandchild') {
      fs.writeFileSync(path.join(out,'grandchild.ready'), String(process.pid));
      setInterval(() => {},1000); return;
    }
    const child = start(mode === 'tree' ? 'child' : 'grandchild');
    child.on('error', e => { fs.writeFileSync(path.join(out,'spawn-error.txt'), e.code); });
    if (mode === 'child') { setInterval(() => {},1000); return; }
    const until = Date.now()+5000;
    while (!fs.existsSync(path.join(out,'grandchild.ready'))) { if(Date.now()>until) throw new Error('descendant readiness timeout'); await new Promise(r=>setTimeout(r,20)); }
    result.fixturePids = [process.pid, child.pid, Number(fs.readFileSync(path.join(out,'grandchild.ready'),'utf8'))];
    result.processLimitRefused = await new Promise(resolve => {
      try { const excess = start('grandchild'); excess.once('error', e => { result.processLimitError=e.code; resolve(true); });
      excess.once('spawn', () => resolve(false)); } catch(e) { result.processLimitError=e.code; resolve(e.code === 'UNKNOWN' || e.code === 'EAGAIN'); }
    });
    fs.writeFileSync(path.join(out,'done.json'),JSON.stringify(result)); setInterval(() => {},1000); return;
  }
  if (mode !== 'boundary') throw new Error('unknown fixed fixture operation');
  result.sourceReadAllowed = fs.readFileSync(path.join(root, 'source', 'canary.txt'), 'utf8') === 'synthetic-source';
  result.outsideReadDenied = denied(() => fs.readFileSync(path.join(root, 'outside', 'canary.txt')));
  result.outsideWriteDenied = denied(() => fs.writeFileSync(path.join(root, 'outside', 'write.txt'), 'unexpected'));
  result.sourceWriteDenied = denied(() => fs.writeFileSync(path.join(root, 'source', 'canary.txt'), 'unexpected'));
  fs.writeFileSync(path.join(out, 'allowed.txt'), 'synthetic-output');
  result.outputWriteAllowed = fs.readFileSync(path.join(out, 'allowed.txt'), 'utf8') === 'synthetic-output';
  result.loopbackDenied = await new Promise(resolve => {
    const socket = net.connect({host:'127.0.0.1', port: Number(process.argv[3])});
    socket.setTimeout(1500);
    socket.on('connect', () => { socket.destroy(); resolve(false); });
    socket.on('error', e => { result.loopbackError = {code:e.code, errno:e.errno}; socket.destroy(); resolve(['EACCES','EPERM','ETIMEDOUT','ECONNREFUSED'].includes(e.code)); });
    socket.on('timeout', () => { socket.destroy(); resolve(false); });
  });
  fs.writeFileSync(path.join(out, 'done.json'), JSON.stringify(result));
  setInterval(() => {}, 1000); // Runner must terminate and await, not just observe exit.
}
main().catch(e => { fs.writeFileSync(path.join(out, 'error.txt'), String(e.stack)); process.exitCode = 2; });
