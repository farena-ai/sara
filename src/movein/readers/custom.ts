// Phase 105 (MI2, docs/design/MOVE_IN.md §4.2 step 5, §8): the reader for a custom agent (the
// collector's --scan). Persona-shaped files (SOUL, IDENTITY, PERSONA, CHARACTER) become a reviewed
// draft of her sheet, MEMORY.md / USER.md become notes, SKILL.md folders skills. Its SQLite stores
// and Postgres databases are not read here: they become mapping cards (src/movein/custom.ts) that the
// owner confirms one by one, for any bundle (a Hermes or OpenClaw plugin store is the same).
import { classifyNote, draftPersona, isoDay, markdownItems, personaRefusal, type PersonaFile } from '../text.ts';
import type { MoveInReader } from '../types.ts';
import { note, readLater, readSkills } from './common.ts';

const PERSONA = /^(SOUL|IDENTITY|PERSONA|CHARACTER)\.md$/i;

export const customReader: MoveInReader = {
  id: 'custom',
  detect(b) {
    return { ok: b.manifest.source.kind === 'custom', facts: b.manifest.source.detected?.layout ?? [] };
  },
  async read(b, emit, _signal, ctx) {
    const skipped: Record<string, number> = {};
    const facts: string[] = [];
    const today = ctx.now.toISOString().slice(0, 10);
    const items = b.manifest.items.filter((it) => it.kind === 'persona-extra' && it.path.startsWith('files/'));
    const persona: PersonaFile[] = [];
    for (const it of items) {
      const name = it.path.split('/').at(-1)!;
      const text = await b.text(it.path, 1024 * 1024).catch(() => '');
      if (!text) continue;
      if (PERSONA.test(name)) persona.push({ path: it.path, name, text });
      else if (/^MEMORY\.md$/i.test(name) || /^USER\.md$/i.test(name)) {
        const section = /^USER/i.test(name) ? 'profile' : 'memories';
        for (const m of markdownItems(text)) note(emit, skipped, ctx, { section, ref: `${it.path}#L${m.line}`, text: m.text, kind: section === 'profile' ? 'fact' : classifyNote(m.text, { agentNotes: true }), happenedOn: isoDay(it.mtime, today) });
        facts.push(name);
      }
    }
    if (persona.length) {
      const refusal = personaRefusal(persona);
      const name = b.manifest.source.displayName;
      const drafts = refusal ? [] : [draftPersona(persona.map((p) => p.name).join(' + '), persona, ctx.current, { name: name && name !== 'custom' ? name : undefined, adultOn: ctx.adultOn, ownerName: ctx.ownerName, scrub: ctx.scrub })];
      emit({ section: 'persona', kind: 'persona', ref: persona[0].path, title: drafts[0]?.sheet.name ?? persona[0].name, data: { drafts, history: [], ...(refusal ? { refused: refusal } : {}) } });
      facts.push('persona');
    }
    const roots = [...new Set(b.manifest.items.filter((it) => it.path.startsWith('files/')).map((it) => it.path.split('/').slice(0, 2).join('/') + '/'))];
    if ((await readSkills(b, roots, emit, ctx, 'your old agent')) > 0) facts.push('skills');
    readLater(b, emit, { hooks: [], plugins: [] });
    return { facts, skipped };
  },
};
