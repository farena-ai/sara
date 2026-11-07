// B2 fix 4: the ComfyUI recipe explains a ComfyUI on another computer (Sara on a server, ComfyUI on his
// PC over Tailscale) and that installers act where Sara runs; every installing, downloading,
// restarting or file-writing tool asks first.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recipeProblems } from '../src/store/checks.ts';
import { parseRecipe } from '../src/store/format.ts';
import { ROOT } from './helpers.ts';

const raw = JSON.parse(readFileSync(join(ROOT, 'store', 'mcp', 'comfyui.json'), 'utf8'));

test('B2 fix 4: the ComfyUI recipe stays valid, explains another computer, and asks before acting on this one', () => {
  assert.deepEqual(recipeProblems(raw.mcp), []);
  const r = parseRecipe(raw.mcp);
  const url = r.fields.find((f) => f.key === 'COMFYUI_URL')!;
  assert.match(url.tip, /another computer/);
  assert.match(url.tip, /Tailscale/);
  const guide = r.guide.join(' ');
  assert.match(guide, /install, download, restart or write files act on the computer where Sara runs, not where ComfyUI runs/);
  const risky = ['install_comfyui', 'install_custom_node', 'download_model', 'restart_comfyui', 'node_pack', 'apply_manifest', 'train_prepare_dataset', 'train_start', 'train_doctor', 'runpod', 'runpod_watch', 'report_issue', 'node_snapshot', 'bisect', 'save_workflow'];
  for (const n of risky) {
    assert.ok(r.tools.ask.includes(n), `${n} asks first`);
    assert.ok(!r.tools.readOnly.includes(n), `${n} is not read-only`);
  }
  // The health check stays read-only (it is what "can you see ComfyUI" should call).
  assert.ok(r.tools.readOnly.includes('get_system_stats'));
});
