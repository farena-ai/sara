// Phase 41: which settings have no "?" tip. A setting is a form control (input, select, textarea)
// inside a settings page or a settings-like window; it is covered when its label, its row, or the
// heading just above it has a tip button. Prints the uncovered ones (id or label text).
//   node scripts/tip-coverage.ts [--json]
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export interface Uncovered {
  page: string;
  id: string;
  label: string;
}

/** Very small HTML walk: enough for our own index.html (well formed, no scripts in the markup). */
export function tipCoverage(html: string, extra: Record<string, unknown> = {}): { total: number; uncovered: Uncovered[] } {
  const out: Uncovered[] = [];
  let total = 0;
  if (/<body\b[^>]*data-business/.test(html)) {
    for (const match of html.matchAll(/<(input|select|textarea)\b([^>]*)>/g)) {
      if (/type="(?:hidden|submit|button)"/.test(match[2])) continue;
      total++;
      const tip = /data-tip="([^"]+)"/.exec(match[2])?.[1];
      if (!tip?.trim() || tip.length > 260) out.push({ page: 'business', id: /id="([^"]+)"/.exec(match[2])?.[1] ?? '', label: '' });
    }
    return { total, uncovered: out };
  }
  // Sections that hold settings: settings pages and the settings-like dialogs.
  const blocks = [...html.matchAll(/<section class="settings-page" data-page="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g)].map((m) => ({ page: m[1], body: m[2] }));
  // Every other window (dialog) with choices in it, except the settings window (its pages are above).
  for (const m of html.matchAll(/<dialog id="([\w-]+)"[\s\S]*?<\/dialog>/g)) if (m[1] !== 'settings') blocks.push({ page: `#${m[1]}`, body: m[0] });
  for (const { page, body } of blocks) {
    // Rows: labels, .add-row / .route-row / .switch-row divs, and the text before each control.
    const controls = [...body.matchAll(/<(input|select|textarea)\b([^>]*)>/g)];
    for (const c of controls) {
      const attrs = c[2];
      if (/type="(hidden|file|submit|button)"/.test(attrs) || /\bhidden\b/.test(attrs.replace(/data-[\w-]+="[^"]*"/g, ''))) continue;
      const id = /id="([^"]+)"/.exec(attrs)?.[1] ?? '';
      if (!id && /type="radio"/.test(attrs)) continue; // a choice in a list explains itself
      if (/^(pair-|wz-|mem-q|note-q|tags-new|sb-joke|pp-task|pp-note|pd-name|report-note|team-goal|team-i-|team-h-name|team-h-instr|tog-|cmpx-|look-own|bd-try|st-|sd-search|settings-search|search)/.test(id)) continue; // free-text boxes with their own explanations, search boxes
      total++;
      const at = c.index!;
      // The enclosing label (if any) and a window of the row around it.
      const before = body.slice(Math.max(0, at - 700), at);
      const after = body.slice(at, Math.min(body.length, at + 500));
      const labelStart = before.lastIndexOf('<label');
      const labelEnd = before.lastIndexOf('</label>');
      const inLabel = labelStart > labelEnd;
      const labelText = inLabel ? before.slice(labelStart).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
      const rowStart = Math.max(before.lastIndexOf('<div class="add-row'), before.lastIndexOf('<div class="switch-row'), before.lastIndexOf('<label'), before.lastIndexOf('<h3'), before.lastIndexOf('<p class="muted small'));
      const row = before.slice(rowStart >= 0 ? rowStart : 0) + after.slice(0, after.search(/<\/label>|<\/div>/) + 8);
      const covered = (id && id in extra) || /class="tip"/.test(row) || /class="tip"/.test(before.slice(before.lastIndexOf('<h3') >= 0 ? before.lastIndexOf('<h3') : before.length));
      if (!covered) out.push({ page, id, label: labelText.slice(0, 60) });
    }
  }
  return { total, uncovered: out };
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/').replace(/^\//, '')}` || process.argv[1]?.endsWith('tip-coverage.ts')) {
  const html = readFileSync(join(ROOT, 'web', 'index.html'), 'utf8');
  const r = tipCoverage(html, (JSON.parse(readFileSync(join(ROOT, 'web', 'tips.json'), 'utf8')) as { tips: Record<string, unknown> }).tips);
  const business = tipCoverage(readFileSync(join(ROOT, 'web', 'business.html'), 'utf8'));
  r.total += business.total; r.uncovered.push(...business.uncovered);
  if (process.argv.includes('--json')) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.total - r.uncovered.length} of ${r.total} settings have a tip; ${r.uncovered.length} don't:`);
    const byPage = new Map<string, Uncovered[]>();
    for (const u of r.uncovered) byPage.set(u.page, [...(byPage.get(u.page) ?? []), u]);
    for (const [p, us] of byPage) console.log(`  ${p}: ${us.map((u) => u.id || u.label).join(', ')}`);
  }
}
