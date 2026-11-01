// Phase 106 (MI3, docs/design/MOVE_IN.md §10): the move-in report. Four lists (imported, translated,
// needs you, left behind), each line with a count, where it came from and a reason or a next step; a
// "where it lives now" note per old feature; her message in the "Moving in" conversation (first
// person, her own name); the downloadable Markdown file; and "Rebuild as a Sara plugin" (§9.3): a
// coding conversation with the plan and the old code as reference text. Nothing in it runs until the
// owner says go, and then only through her normal coding mode (approvals, sandbox gate, plan check).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppContext } from '../chat.ts';
import { writeFileAtomic } from '../fs-util.ts';
import { workspaceDir } from '../tools/workspace.ts';
import { batch, type BatchRow, type LivesLine, type Report, type ReportLine, UNDO_DAYS } from './batch.ts';
import type { CodeCard } from './code-read.ts';
import type { Proposal } from './config.ts';

/** One line per old feature: where it lives in Sara now (§10). */
export function livesLines(counts: Record<string, number>, config: Proposal[], code: CodeCard[], board: boolean, people: boolean): LivesLine[] {
  const out: LivesLine[] = [];
  const add = (old: string, now: string, page?: string) => out.push({ old, now, ...(page ? { page } : {}) });
  if (counts.persona) add('SOUL.md / persona files', 'Settings → Her (her character sheet)', 'her');
  if (counts.memories || counts.profile) add('MEMORY.md / USER.md', 'Settings → Memory (her notes; archived ones are searchable)', 'memory');
  if (counts.conversations) add('Sessions', 'Past conversations (archived, original dates)');
  if (counts.skills) add('Skills', 'Settings → Abilities → Skills', 'skills');
  if (counts.tasks || counts.reminders) add('Cron jobs', 'Your planner (tasks and reminders)', 'planner');
  if (counts.cards) add('Kanban', board ? 'The board' : 'Your planner');
  if (counts.people) add('People tables', people ? 'People' : 'Her notes, tagged with the name');
  if (counts.goals) add('Goals and intentions', 'Settings → Her → Her own plans (paused)', 'agenda');
  for (const p of config) {
    if (p.kind === 'knob' && p.state !== 'confirmed') continue;
    add(`${p.title} (${p.from.split('#').at(-1)})`, p.lives, p.page);
  }
  for (const c of code) {
    const t = c.translation;
    const now = t.type === 'rule' ? 'Settings → Her → How she talks (a rule line)' : t.type === 'guard' ? `Settings → Abilities → Tools (${t.tool} asks first)` : t.type === 'rebuild' ? 'A rebuild plan (Rebuild as a Sara plugin)' : t.type === 'flag' ? 'Needs you (not translated)' : (t.where ?? t.feature ?? 'Left behind');
    add(`${c.kind} "${c.name}"`, now, t.page);
  }
  return out.slice(0, 400);
}

/** Her message in the "Moving in" conversation: first person, her name, the four lists in short. */
export function herMessage(name: string, agent: string, r: Report): string {
  const sum = (l: ReportLine[]) => l.reduce((n, x) => n + (x.count || 0), 0);
  const lines = [
    `${name} here. I've moved in${agent ? ` from ${agent}` : ''}, and I unpacked everything I could. Here's how it went:`,
    '',
    `Came with me (${sum(r.imported)}):`,
    ...r.imported.map((l) => `• ${l.text}`),
  ];
  if (r.translated.length) lines.push('', `Translated into how things work here (${sum(r.translated)}):`, ...r.translated.slice(0, 20).map((l) => `• ${l.text}`));
  if (r.needsYou.length) lines.push('', `I need you for these (${sum(r.needsYou)}):`, ...r.needsYou.slice(0, 15).map((l) => `• ${l.text}`), ...(r.needsYou.length > 15 ? [`• …and ${r.needsYou.length - 15} more on the Move in page.`] : []));
  lines.push('', `Left behind on purpose (${sum(r.leftBehind)}): ${r.leftBehind.slice(0, 8).map((l) => l.text).join('; ') || 'nothing'}${r.leftBehind.length > 8 ? '; and more on the Move in page' : ''}.`);
  lines.push('', 'None of the old hooks or plugins ran: I read them as text. Keys never moved with me, so the services that need one are waiting for you.', `You can undo this move-in for ${UNDO_DAYS} days in Settings → Data & health → Move in from another agent.`);
  return lines.join('\n');
}

const LIST_TITLES: [keyof Pick<Report, 'imported' | 'translated' | 'needsYou' | 'leftBehind'>, string][] = [['imported', 'Imported'], ['translated', 'Translated'], ['needsYou', 'Needs you'], ['leftBehind', 'Left behind']];
const md = (s: string) => s.replace(/([\\`*_[\]<>|])/g, '\\$1');

/** The report as a Markdown file (§10: "exportable as Markdown"). Names and counts only; no keys. */
export function reportMarkdown(b: BatchRow): string {
  const r = b.report;
  const out = [`# Move-in report: ${md(b.agentName)} (${b.sourceKind === 'openclaw' ? 'OpenClaw' : b.sourceKind === 'hermes' ? 'Hermes Agent' : 'custom agent'})`, '', `Moved in ${b.createdAt.slice(0, 10)} · state: ${b.state}${b.state === 'done' || b.state === 'partial' ? ` · Undo possible until ${new Date(Date.parse(b.createdAt) + UNDO_DAYS * 86_400_000).toISOString().slice(0, 10)}` : ''}`, ''];
  if (!r) return [...out, 'No report was written for this move-in.', ''].join('\n');
  for (const [k, title] of LIST_TITLES) {
    const l = r[k] ?? [];
    out.push(`## ${title} (${l.reduce((n, x) => n + (x.count || 0), 0)})`, '');
    if (!l.length) out.push('- nothing', '');
    for (const x of l) out.push(`- ${md(x.text)}${x.examples?.length ? ` — from ${x.examples.slice(0, 3).map((e) => `\`${e.replace(/`/g, '')}\``).join(', ')}` : ''}`);
    out.push('');
  }
  if (r.lives?.length) {
    out.push('## Where your old features live now', '', '| On the old agent | In Sara now |', '|---|---|');
    for (const x of r.lives) out.push(`| ${md(x.old)} | ${md(x.now)} |`);
    out.push('');
  }
  out.push('Hooks and plugins were read as text and never run. Keys and passwords never moved; paste them again in Sara.', '');
  return out.join('\n');
}

/**
 * §9.3 "Rebuild this as a Sara plugin": a fresh workspace with the plan (REBUILD.md), a draft
 * sara-plugin.json and the old code as .txt reference files, and a coding conversation that asks the
 * owner to say go. The result is an ST3 plugin that goes through ST3's own install and permission
 * review; nothing about the old plugin is trusted on the way.
 */
export function rebuildTask(app: AppContext, batchId: string, key: string): { conversationId: string } {
  const b = batch(app.store.db, batchId);
  if (!b?.report) throw new Error('No such move-in.');
  if (b.state === 'undone') throw new Error('This move-in was undone.');
  const line = b.report.needsYou.find((l) => l.key === 'rebuild' && l.ref === key);
  const plan = b.report.plans?.[key];
  if (!line || !plan) throw new Error('That rebuild plan is gone.');
  const slug = String(plan.manifest.id ?? 'moved-in').replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'moved-in';
  let ws = `rebuild-${slug}`;
  for (let k = 2; existsSync(join(app.rootDir ?? app.dataDir, 'workspaces', ws)); k++) ws = `rebuild-${slug}-${k}`;
  const dir = workspaceDir(app.rootDir ?? app.dataDir, ws);
  // The old code as reference text (the .txt copies the batch kept), never as runnable files.
  const src = join(app.dataDir, 'movein', batchId, 'code', `${plan.kind}-${plan.name.replace(/[^\w.-]/g, '_')}`);
  let copied = 0;
  const walk = (from: string, to: string) => {
    if (!existsSync(from)) return;
    for (const f of readdirSync(from)) {
      const p = join(from, f);
      if (statSync(p).isDirectory()) walk(p, join(to, f));
      else if (f.endsWith('.txt') && copied < 200) {
        mkdirSync(to, { recursive: true });
        writeFileAtomic(join(to, f), readFileSync(p), 0o600);
        copied++;
      }
    }
  };
  walk(src, join(dir, 'old-code'));
  const brief = [
    `# Rebuild "${plan.name}" as a Sara plugin`,
    '',
    `What it did on the old agent: ${plan.did}`,
    '',
    `Hosts it talked to: ${plan.hosts.join(', ') || 'none found'}`,
    `Secrets it needed (names only; the owner pastes them in the plugin settings): ${plan.secrets.join(', ') || 'none'}`,
    '',
    'The old code is in old-code/ as .txt files: reference text only. Do not run it, rename it or copy it in.',
    'Write a new ST3 plugin from scratch: sara-plugin.json (start from the draft below) and its main file. Ask only for the permissions it really needs.',
    'It is installed through Settings → Abilities → Plugins, with the permission review card.',
    '',
    '```json',
    JSON.stringify(plan.manifest, null, 2),
    '```',
    '',
  ].join('\n');
  writeFileAtomic(join(dir, 'REBUILD.md'), brief, 0o600);
  writeFileAtomic(join(dir, 'sara-plugin.draft.json'), JSON.stringify(plan.manifest, null, 2) + '\n', 0o600);
  const conv = app.store.createConversation({ title: `Rebuild ${plan.name} as a Sara plugin`.slice(0, 120), mode: 'coding', workspace: ws });
  app.store.addMessage(conv.id, 'assistant', `I've set up a workspace to rebuild "${plan.name}" as one of my plugins. The plan is in REBUILD.md and the old code is in old-code/ as text (${copied} files), only for reference: nothing of it has run.\n\n${plan.summary}\n\nSay "go ahead" when you want me to start. Every step asks you as usual, and the finished plugin goes through the plugin review before it can do anything.`, { moveIn: batchId });
  return { conversationId: conv.id };
}
