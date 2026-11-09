import { openBusinessProfile } from '../src/business/profile.ts';
import { configureBusinessModelsFile } from '../src/business/model-config.ts';

// Run locally as the installation operator; never exposed through business HTTP roles.
try {
  const [root, file] = process.argv.slice(2);
  if (!root || !file || process.argv.length !== 4) throw new Error('arguments');
  configureBusinessModelsFile(openBusinessProfile(root), file);
  process.stdout.write('Business model policy saved. Provider keys are encrypted in the business operator vault.\n');
} catch {
  process.stderr.write('Business configuration refused. Supply an isolated business data root and a valid local JSON file containing policy and optional provider keys.\n');
  process.exitCode = 1;
}
