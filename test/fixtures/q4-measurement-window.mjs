// Synthetic profile ordering probe. No production module imports this fixture.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
let restoreSeen = false;
const write = fs.writeFileSync;
fs.writeFileSync = function (path, ...args) {
  if (String(path).includes('restored-verification')) restoreSeen = true;
  return write.call(this, path, ...args);
};
syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  if (new URL(String(input)).pathname === '/api/operations') {
    const json = response.json.bind(response);
    response.json = async () => ({ ...await json(), fixtureRestoreSeen: restoreSeen });
  }
  return response;
};
