// Phase 98 (ST3, docs/design/STAPLES.md §6.5): the first code that runs in a plugin's own process.
// Sara starts it as `node --permission --allow-fs-read=<plugin dir> --allow-fs-read=<its data dir>
// --allow-fs-write=<its data dir> plugin-host.mjs <main>` (no child processes, workers or addons),
// with a minimal environment and its data folder as the working folder. It only tidies the process
// up and then loads the plugin's main file, which talks to Sara over stdin/stdout (newline-delimited
// JSON, channel version 1; docs/PLUGINS.md). Plain JavaScript on purpose: no TypeScript stripping
// in the plugin's process, no imports from Sara.
import { pathToFileURL } from 'node:url';

const main = process.argv[2];
if (!main) {
  process.stderr.write('plugin-host: no main file\n');
  process.exit(2);
}

// stdout is the channel: anything a plugin prints with console.* becomes a log message instead of
// a broken line.
const send = (level, args) => {
  const text = args.map((a) => (typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ').slice(0, 2000);
  process.stdout.write(`${JSON.stringify({ v: 1, type: 'log', level, text })}\n`);
};
console.log = (...a) => send('info', a);
console.info = (...a) => send('info', a);
console.debug = (...a) => send('debug', a);
console.warn = (...a) => send('warn', a);
console.error = (...a) => send('error', a);

// Network goes through Sara (sara.fetch over the channel). Where the OS fences the process in
// (bubblewrap, Seatbelt) there is no network at all; without a fence this only removes the easy way.
const noNet = () => {
  throw new Error('Plugins reach the network only through sara.fetch (the hosts in their manifest).');
};
globalThis.fetch = noNet;
globalThis.WebSocket = undefined;
globalThis.EventSource = undefined;

process.on('uncaughtException', (err) => {
  send('error', [`uncaught: ${err?.stack ?? err}`]);
  process.exit(70);
});
process.on('unhandledRejection', (err) => {
  send('error', [`unhandled: ${err?.stack ?? err}`]);
  process.exit(70);
});

await import(pathToFileURL(main).href);
