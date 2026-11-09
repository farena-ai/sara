import { openBusinessProfile } from '../../src/business/profile.ts';
import { createBusinessRuntime } from '../../src/business/runtime.ts';
import { setNetTransport } from '../../src/net-guard.ts';

const [root, origin] = process.argv.slice(2);
setNetTransport(async () => { process.send?.({ event: 'model-called' }); return new Promise<Response>(() => {}); });
const runtime = createBusinessRuntime({ profile: openBusinessProfile(root), origin });
runtime.server.listen(Number(new URL(origin).port), '127.0.0.1', () => process.send?.({ event: 'ready' }));
