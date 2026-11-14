// Leftover 12: the Windows app's icon (desktop/windows/src/sara.ico, made by scripts/make-app-icons.py)
// carries a drawn image for every scale Windows asks for, so nothing is stretched at 125%, 150% or
// 200%: small icons 16/20/24/32 px (title bar, tray), big ones 32/40/48/64 px (Alt+Tab, desktop),
// and 256 px (Explorer, installer).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './helpers.ts';

test('Leftover 12: sara.ico has the 100%-200% sizes (24 and 48 px for 150%)', () => {
  const b = readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'sara.ico'));
  assert.equal(b.readUInt16LE(2), 1, 'an icon file');
  const sizes = Array.from({ length: b.readUInt16LE(4) }, (_, i) => b[6 + 16 * i] || 256);
  for (const px of [16, 20, 24, 32, 40, 48, 64, 256]) assert.ok(sizes.includes(px), `${px} px in ${sizes.join(', ')}`);
  // The app and the service both embed it.
  for (const rc of ['sara.rc', 'service.rc']) assert.match(readFileSync(join(ROOT, 'desktop', 'windows', 'src', rc), 'utf8'), /IDI_SARA ICON "sara\.ico"/);
  // The window picks per-monitor sizes (not the 100% ones) when the DPI changes.
  assert.match(readFileSync(join(ROOT, 'desktop', 'windows', 'src', 'main.cpp'), 'utf8'), /GetSystemMetricsForDpi\(SM_CXICON, dpi\), smallPx = GetSystemMetricsForDpi\(SM_CXSMICON, dpi\)/);
});
