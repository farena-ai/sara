import { serve } from './protocol.mjs';
// Root authority is exactly the launcher's staged server home; no root/command flags.
if(process.argv.length!==2) {process.stderr.write('unsupported-arguments\n');process.exitCode=1;}
else serve(process.stdin,process.stdout,process.cwd(),process.env.DEVBENCH_LOCALE??'en');
