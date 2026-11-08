// C5: the Helm chart (deploy/helm/sara) stays single-replica and in step with the release. `helm lint`
// and kubeconform were run by hand (docs/ops/C5_DESIGN.md); this keeps the rules that matter from
// drifting without needing helm on the machine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

const chart = join(ROOT, 'deploy', 'helm', 'sara');
const read = (p: string) => readFileSync(join(chart, p), 'utf8');

test('helm chart: appVersion follows package.json; image is the published GHCR one', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  assert.match(read('Chart.yaml'), new RegExp(`^appVersion: "${pkg.version.replace(/\./g, '\\.')}"$`, 'm'));
  assert.match(read('values.yaml'), /^ {2}repository: ghcr\.io\/farena-ai\/sara$/m);
});

test('helm chart: one replica with Recreate (never two pods on her database), no replica value to change', () => {
  const dep = read('templates/deployment.yaml');
  assert.match(dep, /^ {2}replicas: 1$/m);
  assert.match(dep, /strategy:\n {4}type: Recreate/);
  assert.doesNotMatch(dep, /\.Values\.replica/i);
  assert.doesNotMatch(read('values.yaml'), /replica(Count|s):/i);
  assert.ok(!/HorizontalPodAutoscaler/.test(dep));
});

test('helm chart: data volume at SARA_DATA, health probes, non-root, secrets only by reference', () => {
  const dep = read('templates/deployment.yaml');
  const values = read('values.yaml');
  assert.match(values, /^dataDir: \/var\/lib\/sara$/m);
  assert.match(dep, /name: SARA_DATA\n\s+value: \{\{ \.Values\.dataDir \| quote \}\}/);
  assert.match(dep, /mountPath: \{\{ \.Values\.dataDir \}\}/);
  assert.equal((dep.match(/path: \/api\/health/g) ?? []).length, 2, 'liveness and readiness');
  assert.match(values, /runAsNonRoot: true/);
  assert.match(values, /allowPrivilegeEscalation: false/);
  assert.match(values, /drop: \[ALL\]/);
  assert.match(values, /requests:\n\s+cpu: \S+\n\s+memory: \S+/);
  assert.match(dep, /secretRef:\n\s+name: \{\{ \.Values\.existingSecret \}\}/);
  assert.ok(!/kind: Secret\b/.test(dep), 'the chart never carries secret values');
  assert.match(read('templates/pvc.yaml'), /helm\.sh\/resource-policy: keep/);
});
