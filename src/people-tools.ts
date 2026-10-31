// Phase 101 (ST6, docs/design/STAPLES.md §9.7): her tools for people cards, in the owner's own turns
// only (chat.ts takes them away from other apps, other agents and group chats; partner chats have no
// tools). person_lookup and people_list run on their own (read-only); person_note asks first, like
// the remember_fact tool other apps get.
import type { AppContext } from './chat.ts';
import { localDate } from './memory-worker.ts';
import { CIRCLES, fold, labelOf, type Person, type PersonFact } from './people.ts';
import type { Tool } from './tools/types.ts';
import { ToolError } from './tools/types.ts';

const TOPIC_HINT = /\b(health|sick|doctor|hospital|surgery|medication|therapy|pregnan\w*|money|loan|debt|lawyer|court|divorce|dating|relationship|sex)\b/i;

function cardText(app: AppContext, p: Person, facts: PersonFact[], opts: { private: boolean; topic: string }): string {
  const people = app.people!;
  const head = [`${p.name}${p.fullName && p.fullName !== p.name ? ` (${p.fullName})` : ''}`, p.relation ? `who: ${p.relation.replace(/^my\s+/i, 'your ')}` : '', `circle: ${p.circle}`, p.birthday ? `birthday: ${p.birthday}` : '', p.aliases.length ? `also called: ${p.aliases.join(', ')}` : '', p.lastMentioned ? `last mentioned: ${p.lastMentioned.slice(0, 10)}` : ''].filter(Boolean);
  const kept = facts.filter((f) => !f.pending && (!f.private || opts.private) && (!f.category || TOPIC_HINT.test(opts.topic)));
  const hidden = facts.length - kept.length;
  const lines = kept.slice(0, 12).map((f) => `- (${f.happenedOn}) ${f.content.replace(/\s+/g, ' ').trim()}`);
  const links = people.links(p.id).map((l) => `- ${l.person.name}: ${l.relation}`);
  return [
    head.join(' · '),
    ...(p.notes ? [`Notes the owner wrote: ${p.notes.replace(/\s+/g, ' ').slice(0, 600)}`] : []),
    lines.length ? `What you know:\n${lines.join('\n')}` : 'No facts on the card yet.',
    ...(links.length ? [`People linked:\n${links.join('\n')}`] : []),
    ...(hidden ? [`(${hidden} more not shown here: private or sensitive.)`] : []),
  ].join('\n');
}

export function createPeopleTools(app: () => AppContext): Tool[] {
  const conv = (id?: string) => (id ? app().store.getConversation(id) : undefined);
  const lastOwnerText = (id?: string) => (id ? (app().store.messages(id).filter((m) => m.role === 'user').at(-1)?.content ?? '') : '');
  return [
    {
      spec: {
        name: 'person_lookup',
        description: "Look up someone in the owner's life on their people card: who they are to the owner, birthday, what you know about them (dated) and people linked to them. Use it when a person comes up and you need more than your notes give. If the name fits more than one person, it lists them so you can ask which one.",
        parameters: { type: 'object', properties: { name: { type: 'string', description: "The person's name as the owner says it, e.g. 'Jamie' or 'Jeff from work'." } }, required: ['name'] },
      },
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().people),
      summarize: (a) => `Looking up ${String(a.name ?? '').slice(0, 40)}`,
      async run(args, ctx) {
        const a = app();
        const people = a.people;
        if (!people) throw new ToolError('People cards are not available here.');
        const name = String(args.name ?? '').trim();
        if (!name) throw new ToolError('Say whose card to look up.');
        const c = conv(ctx.conversationId);
        const opts = { private: Boolean(c?.private), topic: lastOwnerText(ctx.conversationId) };
        const r = people.find(name, { ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}) });
        const hits = r.found.length ? r.found : people.list({ q: name, status: 'active', limit: 5 });
        if (r.ambiguous.length && !r.found.length) return `"${name}" could be ${r.ambiguous[0].people.map(labelOf).join(' or ')}. Ask the owner which one before you go on.`;
        if (!hits.length) return `No people card for "${name}". If the owner tells you about them, you'll remember it as usual.`;
        return hits.slice(0, 3).map((p) => cardText(a, p, people.facts(p.id), opts)).join('\n\n');
      },
    },
    {
      spec: {
        name: 'people_list',
        description: "List the people in the owner's life you have cards for (name and who they are to the owner), optionally one circle: family, partner, friend, work, neighbour or other.",
        parameters: { type: 'object', properties: { circle: { type: 'string', enum: [...CIRCLES], description: 'Only this circle.' } } },
      },
      defaultPermission: 'auto',
      isAvailable: () => Boolean(app().people),
      summarize: (a) => `Looking at the people you know${a.circle ? ` (${String(a.circle)})` : ''}`,
      async run(args) {
        const people = app().people;
        if (!people) throw new ToolError('People cards are not available here.');
        const circle = typeof args.circle === 'string' && (CIRCLES as readonly string[]).includes(args.circle) ? args.circle : undefined;
        const list = people.list({ status: 'active', ...(circle ? { circle } : {}), limit: 80 });
        if (!list.length) return circle ? `No ${circle} people on cards yet.` : 'No people cards yet.';
        return list.map((p) => `- ${p.name}${p.relation ? ` (${p.relation.replace(/^my\s+/i, 'your ')})` : ''}${p.birthday ? `, birthday ${p.birthday}` : ''}`).join('\n');
      },
    },
    {
      spec: {
        name: 'person_note',
        description: "Write down something the owner just told you about a person in their life, on that person's card (it is saved as one of your memories too). Use it when the owner asks you to remember something about someone. The owner approves it first.",
        parameters: {
          type: 'object',
          properties: {
            person: { type: 'string', description: "Who it is about, as the owner says it ('Jamie', 'my sister Ana')." },
            fact: { type: 'string', description: "One short sentence starting with the owner's name, e.g. 'Alex's friend Jamie loves pottery.'" },
          },
          required: ['person', 'fact'],
        },
      },
      defaultPermission: 'ask',
      isAvailable: () => Boolean(app().people && app().memory),
      summarize: (a) => `Note about ${String(a.person ?? '').slice(0, 40)}: ${String(a.fact ?? '').slice(0, 100)}`,
      async run(args, ctx) {
        const a = app();
        const people = a.people;
        const mem = a.memory;
        if (!people || !mem) throw new ToolError('People cards are not available here.');
        const who = String(args.person ?? '').trim().slice(0, 80);
        const fact = a.redactor.redact(String(args.fact ?? '').trim()).slice(0, 300);
        if (!who || fact.length < 5) throw new ToolError('Say who it is about and the fact (one short sentence).');
        const c = conv(ctx.conversationId);
        const day = localDate(a.now().toISOString(), a.settings.get().timeZone);
        // "my sister Ana": the relation comes with the name.
        const said = people.aboutFromText(who).at(0);
        const name = said?.name ?? who.replace(/^(my|his|her)\s+\w+\s+/i, '').trim();
        // Who they are, from the fact itself when the name came alone ("Alex's brother Jeff…").
        const fromFact = said?.relation ? undefined : people.aboutFromText(fact).find((x) => x.name.split(/\s+/)[0].toLowerCase() === name.split(/\s+/)[0].toLowerCase());
        // The owner's message she is noting is the source (the card links to it).
        const last = ctx.conversationId ? a.store.messages(ctx.conversationId).filter((x) => x.role === 'user').at(-1) : undefined;
        const m = mem.add({ kind: 'fact', content: fact, conversationId: ctx.conversationId ?? null, sourceMessageId: last?.id ?? null, happenedOn: day, evidence: last ? last.content.slice(0, 300) : 'She noted this when you told her.' });
        const relation = said?.relation ?? fromFact?.relation;
        const r = people.linkMemory(m, [{ name: fromFact?.name ?? name, ...(relation ? { relation } : {}) }], { private: Boolean(c?.private), ...(ctx.conversationId ? { text: lastOwnerText(ctx.conversationId) } : {}) });
        a.events?.publish({ type: 'people', what: 'facts' });
        if (!r.personIds.length) return `Saved as a note (no card: "${name}" isn't a person you keep cards for).`;
        const p = people.get(r.personIds[0])!;
        return r.personIds.length > 1 ? `Saved. "${name}" fits more than one card, so it waits on each until the owner says which one.` : `Saved on ${labelOf(p)}'s card${p.status === 'proposed' ? ' (a new card the owner still has to check)' : ''}.`;
      },
    },
  ];
}

/** Matching helper for tests and the routes: does a card answer to this name? */
export function answersTo(p: Person, name: string): boolean {
  const f = fold(name);
  return [p.name, p.fullName ?? '', ...p.aliases].some((x) => fold(x) === f);
}
