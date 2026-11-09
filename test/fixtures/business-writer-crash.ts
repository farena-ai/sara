import { openBusinessProfile } from '../../src/business/profile.ts';
import { acquireBusinessWriter } from '../../src/business/lifecycle.ts';
const lease = acquireBusinessWriter(openBusinessProfile(process.argv[2]));
process.stdout.write('writer-ready\n');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => { lease.release(); process.exit(0); });
