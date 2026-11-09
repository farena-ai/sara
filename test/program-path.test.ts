// SARA_PROGRAM_PATH (2026-11-07, owner request): folders of extra programs an operator gives Sara
// alone (e.g. a newer Python on a cPanel server where the system python3 must stay 3.6). They come
// first in her command path, inside and outside the Linux sandbox; on Linux only folders under /usr
// count, because the sandbox shows /usr and nothing else of the host's program folders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commandPath } from '../src/tools/sandbox.ts';

test('extra program folders come first; on Linux only those under /usr; junk is ignored', () => {
  const was = process.env.SARA_PROGRAM_PATH;
  try {
    process.env.SARA_PROGRAM_PATH = '/usr/local/sara/bin:/opt/elsewhere/bin:relative/bin::/usr/../etc';
    const linux = commandPath('linux').split(':');
    assert.equal(linux.indexOf('/usr/local/sara/bin') >= 0, true);
    assert.ok(linux.indexOf('/usr/local/sara/bin') < linux.indexOf('/usr/local/bin'), 'before the system folders');
    assert.ok(!linux.includes('/opt/elsewhere/bin'), 'not visible inside the sandbox');
    assert.ok(!linux.some((d) => d.includes('relative') || d.includes('..') || d === ''));
    const mac = commandPath('darwin', '/Applications/Sara.app/node/bin/node').split(':');
    assert.equal(mac[0], '/Applications/Sara.app/node/bin', "Sara's own Node stays first");
    assert.equal(mac[1], '/usr/local/sara/bin');
    assert.ok(mac.includes('/opt/elsewhere/bin'));
    delete process.env.SARA_PROGRAM_PATH;
    assert.ok(!commandPath('linux').includes('/usr/local/sara/bin'), 'nothing extra without the setting');
  } finally {
    if (was === undefined) delete process.env.SARA_PROGRAM_PATH;
    else process.env.SARA_PROGRAM_PATH = was;
  }
});
