import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const ids = ['api-contract-guard', 'secret-scanner', 'license-auditor', 'sbom-builder', 'artifact-provenance-verifier', 'coverage-explorer', 'log-explorer', 'incident-workbench', 'environment-config-doctor', 'database-fixture-studio', 'data-contract-validator', 'change-impact-analyzer', 'architecture-guard', 'sql-migration-reviewer', 'visual-regression', 'localization-qa', 'accessibility-auditor', 'build-cache-inspector', 'http-webhook-workbench',
  'performance-regression-lab', 'code-migration-studio', 'build-reproducibility-inspector', 'test-doctor', 'flaky-test-lab', 'documentation-doctor', 'release-readiness', 'repository-onboarding'];
for (const id of ids) test(`${id}: standalone MIT package retains its license grant`, () => {
  const license = readFileSync(new URL(`../store/plugins/${id}/LICENSE`, import.meta.url), 'utf8');
  assert.match(license, /Permission is hereby granted, free of charge/);
  assert.match(license, /THE SOFTWARE IS PROVIDED/);
  assert.match(license, /copyright notice/);
});
