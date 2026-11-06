// E5: a small owner app with a Markdown document in her library (synthetic text, Alex as owner).
import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { LibraryStore } from '../src/library/store.ts';
import { ReadTogether } from '../src/read-together.ts';
import { makeApp, tempDir, type TestApp } from './helpers.ts';

export const hash = (s: string) => createHash('sha256').update(s.normalize('NFC')).digest('hex');

export const PARTS = [
  { where: 'part 1', heading: 'Setup', text: 'Plug the heater in and wait for the green light. Keep it a metre from curtains.' },
  { where: 'part 2', heading: 'Cleaning', text: 'Rinse the filter every month in warm water. Let it dry fully before putting it back.' },
  { where: 'part 3', heading: 'Storage', text: 'Store it upright in a dry place over the summer. Cover the grille.' },
  { where: 'part 4', heading: 'Warranty', text: 'The warranty lasts two years from the date on the receipt.' },
];

export function readFixture(t: TestContext, parts: { where: string; heading?: string; text: string }[] = PARTS, kind = 'markdown') {
  const { dir, cleanup } = tempDir();
  const clock = { now: new Date('2026-11-06T15:00:00Z') };
  const app: TestApp = makeApp(dir, clock);
  app.library = new LibraryStore(app.store.db, dir, () => clock.now);
  app.readTogether = new ReadTogether(() => clock.now);
  app.settings.update({ providers: [{ id: 'p', label: 'P', kind: 'openai-compatible', baseUrl: 'http://x' }], defaultProviderId: 'p', defaultModel: 'm', ownerName: 'Alex', timeZone: 'UTC', disclosureAcceptedAt: clock.now.toISOString() });
  const added = app.library.add({ name: kind === 'markdown' ? 'heater.md' : `heater.${kind}`, bytes: Buffer.from(parts.map((p) => p.text).join('\n')), keep: true });
  const doc = app.library.setRead(added.id, { kind, parts, warnings: [] })!;
  const passages = app.library.passages(doc.id, { limit: 100 });
  const conv = app.store.createConversation({ title: 'Reading' });
  t.after(() => {
    app.store.close();
    cleanup();
  });
  /** A body for one slice of one passage (what the web view sends: positions and hashes only). */
  const slice = (ord: number, start: number, end: number, extra: Record<string, unknown> = {}) => ({ docId: doc.id, sha: doc.sha.slice(0, 12), ordFrom: ord, ordTo: ord, start, end, textSha: hash(passages[ord].text.slice(start, end)), mode: 'passage', ...extra });
  return { app, dir, clock, doc, passages, conv, slice };
}
