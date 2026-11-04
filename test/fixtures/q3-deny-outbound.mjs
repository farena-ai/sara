import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
const denied = () => {
  if (process.env.Q3_OUTBOUND_LOG) appendFileSync(process.env.Q3_OUTBOUND_LOG, 'blocked-outbound-attempt\n');
  throw new Error('Outbound networking is disabled in the Q3 recovery fixture');
};
globalThis.fetch = async () => denied();
net.Socket.prototype.connect = denied;
http.request = denied; http.get = denied;
https.request = denied; https.get = denied;
syncBuiltinESMExports();
