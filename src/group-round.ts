// Phase 66: one round of a group chat: the owner's message and the replies it gets. Each reply is
// a normal turn of that companion (src/chat.ts runTurn with `group`): her own model and provider,
// personality, speech style, memories, mood and safety block. The round adds what concerns the
// whole room: each companion's AI notice (at the start and every 3 hours), the minors check for the
// room (a blocked message gets no replies at all), crisis help shown once with every companion
// answering supportively and no banter, who answers (turn style, @mentions, the router), banter
// and the hard cap of replies, and copying each reply to the other companions' copies.
import { classify, runTurn, type AppContext, type ChatEvent, type GroupTurn } from './chat.ts';
import { appLanguage } from './i18n.ts';
import { complete } from './life.ts';
import { adultModeOn } from './settings.ts';
import { CRISIS_RESOURCES, detectCrisis, disclosureDue, disclosureText, MINOR_BLOCK_REPLY, minorSexualMatch } from './safety.ts';
import { banterSpeaker, fallbackSpeaker, groupNote, MAX_DIRECT_REPLIES, otherLine, ownerLine, parseMentions, parseRouterAnswer, PASS_RE, planSpeakers, replyCap, ROUTER_SYSTEM, routerPrompt, type GroupRoom, type GroupRooms, type Speaker } from './group.ts';

/** One member of the room for this round: her app and her copy of the conversation. */
export interface RoundMember {
  id: string;
  app: AppContext;
  convId: string;
  speaker: Speaker;
}

export type GroupEvent =
  | (ChatEvent & { speaker?: Speaker })
  /** The next reply is from this companion (null: the app itself, e.g. a blocked message). */
  | { type: 'speaker'; speaker: Speaker | null }
  /** A banter reply that had nothing to add ("(pass)") was taken back. */
  | { type: 'retract' }
  /** The round is over (replies: how many companions answered). */
  | { type: 'group_done'; replies: number };

/** Hooks for tests: a scripted router answer instead of a model call. */
export interface RoundOptions {
  room: GroupRoom;
  rooms: GroupRooms;
  members: RoundMember[];
  /** The member whose copy the owner is looking at (her ids are the ones sent to the app). */
  viewerId: string;
  text: string;
  signal: AbortSignal;
  route?: (prompt: string) => Promise<string>;
}

const ownerOf = (m: RoundMember) => m.app.settings.get().ownerName?.trim() || 'the owner';

/** The last lines of the room as the router reads them. */
function recentLines(viewer: RoundMember, owner: string, limit = 8): string[] {
  return viewer.app.store
    .messagesPage(viewer.convId, { limit: 30 })
    .messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim() && !m.meta?.blocked)
    .slice(-limit)
    .map((m) => {
      const text = m.content.replace(/\s+/g, ' ').slice(0, 300);
      if (m.role === 'user') return ownerLine(owner, text);
      const from = (m.meta?.groupFrom as { name?: string } | undefined)?.name ?? viewer.speaker.name;
      return otherLine(from, text).replace(', another AI companion', '');
    });
}

export async function* runGroupRound(o: RoundOptions): AsyncGenerator<GroupEvent> {
  const { room, rooms, members, signal } = o;
  const viewer = members.find((m) => m.id === o.viewerId) ?? members[0];
  const host = viewer.app;
  const now = host.now();
  const owner = ownerOf(viewer);
  const lang = appLanguage(host.settings.get());
  const text = o.text.trim();
  const all = (fn: (m: RoundMember) => void) => members.forEach(fn);

  // 1. Each companion's AI notice: when the room starts and every 3 hours after.
  for (const m of members) {
    const last = room.disclosedAt[m.id];
    if (!disclosureDue(last ? new Date(last) : undefined, now)) continue;
    const notice = disclosureText(m.speaker.name, lang);
    all((x) => x.app.store.addMessage(x.convId, 'notice', `disclosure:${notice}`, { speaker: m.speaker }));
    rooms.markDisclosed(room.id, m.id, now);
    yield { type: 'notice', kind: 'disclosure', text: notice, speaker: m.speaker };
  }

  // 2. The minors block holds for the whole room: nobody answers such a message.
  const match = minorSexualMatch(text, { owner: true });
  const label = await classify(host, text);
  all((x) => x.app.store.addMessage(x.convId, 'user', text, { group: true }));
  if (match || label === 'MINOR_SEXUAL') {
    let viewerMsg = 0;
    for (const m of members) {
      m.app.store.recordSafetyEvent('minor_sexual_block', m.convId);
      const saved = m.app.store.addMessage(m.convId, 'assistant', MINOR_BLOCK_REPLY, { blocked: 'minor_sexual_message', blockedBy: match ? `words: ${match.minor} + ${match.sexual}` : 'classifier', groupSystem: true });
      if (m === viewer) viewerMsg = saved.id;
    }
    yield { type: 'speaker', speaker: null };
    yield { type: 'token', text: MINOR_BLOCK_REPLY };
    yield { type: 'done', messageId: viewerMsg };
    yield { type: 'group_done', replies: 0 };
    return;
  }

  // 3. Crisis: the help shows at once, every companion answers with care, no banter.
  const crisis = detectCrisis(text) || label === 'CRISIS';
  if (crisis) {
    // B4: each member's copy shows the notice once per conversation (every time for a child); the
    // event is recorded every time. The viewer sees it when their own copy showed it.
    let shown = false;
    all((x) => {
      if (!x.app.store.crisisFlag(x.convId, { every: Boolean(x.app.member?.child?.()) })) return;
      x.app.store.addMessage(x.convId, 'notice', `crisis:${CRISIS_RESOURCES}`);
      if (x === viewer) shown = true;
    });
    if (shown) yield { type: 'notice', kind: 'crisis', text: CRISIS_RESOURCES };
  }

  // 4. Who answers.
  const ids = members.map((m) => m.id);
  const names = members.map((m) => ({ id: m.id, name: m.speaker.name }));
  const mentioned = parseMentions(text, names);
  const plan = planSpeakers({ style: room.turnStyle, memberIds: ids, mentioned, next: room.next, crisis });
  if (plan.next !== room.next) rooms.update(room.id, { next: plan.next });
  let speakers = plan.speakers;
  if (!speakers) {
    const prompt = routerPrompt(owner, room.title, members.map((m) => ({ name: m.speaker.name, about: m.app.persona.summary })), recentLines(viewer, owner));
    let answer = '';
    try {
      answer = o.route ? await o.route(prompt) : await complete(host, host.store.getConversation(viewer.convId)!, [{ role: 'system', content: ROUTER_SYSTEM }, { role: 'user', content: prompt }], 24, 'quick');
    } catch (err) {
      console.warn(`group router: ${(err as Error).message}`);
    }
    const picked = parseRouterAnswer(answer, names);
    speakers = picked.length ? picked : [fallbackSpeaker(ids, recentSpeakers(viewer))];
  }
  speakers = speakers.slice(0, MAX_DIRECT_REPLIES);
  const adult = members.every((m) => adultModeOn(m.app.settings.get()));
  const cap = replyCap(crisis ? 0 : room.banter);
  const spoken: string[] = recentSpeakers(viewer);
  const reacted = new Set<string>();
  let replies = 0;
  let stop = false;
  let lastText = '';

  /** One reply from one companion; copies it to the others' copies. */
  async function* reply(m: RoundMember, mode: 'owner' | 'mentioned' | 'banter' | 'crisis'): AsyncGenerator<GroupEvent> {
    const others = members.filter((x) => x !== m).map((x) => x.speaker.name);
    const group: GroupTurn = { ownerTurn: !reacted.has(m.id) && mode !== 'banter', crisis, adult, others, note: groupNote({ name: m.speaker.name, owner, title: room.title, others, mode, lastSpeaker: members.find((x) => x.id === spoken.at(-1))?.speaker.name }) };
    reacted.add(m.id);
    yield { type: 'speaker', speaker: m.speaker };
    let doneId = 0;
    for await (const ev of runTurn(m.app, m.convId, text, signal, { group })) {
      if (ev.type === 'done') {
        doneId = ev.messageId;
        continue;
      }
      if (ev.type === 'error') {
        yield { ...ev, speaker: m.speaker };
        if (signal.aborted) stop = true;
        continue;
      }
      // Her own steps' ids are in her copy; the app redraws from its own copy when the round ends.
      yield ev.type === 'replace' || ev.type === 'claim_check' ? { ...ev, messageId: 0 } : ev;
    }
    const msg = doneId ? m.app.store.messageById(doneId) : undefined;
    if (!msg || msg.role !== 'assistant' || !msg.content.trim()) return;
    if (mode === 'banter' && PASS_RE.test(msg.content)) {
      m.app.store.deleteMessagesFrom(m.convId, msg.id);
      yield { type: 'retract' };
      stop = true;
      return;
    }
    m.app.store.updateMessageMeta(msg.id, { speaker: m.speaker });
    let viewerMsg = m === viewer ? msg.id : 0;
    for (const x of members) {
      if (x === m) continue;
      const copy = x.app.store.addMessage(x.convId, 'assistant', msg.content, { groupFrom: { id: m.id, name: m.speaker.name }, speaker: m.speaker, ...(msg.meta?.blocked ? { blocked: msg.meta.blocked } : {}), ...(msg.meta?.model ? { model: msg.meta.model } : {}) });
      if (x === viewer) viewerMsg = copy.id;
    }
    replies++;
    spoken.push(m.id);
    lastText = msg.content;
    yield { type: 'done', messageId: viewerMsg };
    // A reply that failed the minors check ends the round for everyone.
    if (msg.meta?.blocked) stop = true;
  }

  for (const id of speakers) {
    if (stop || signal.aborted || replies >= cap) break;
    const m = members.find((x) => x.id === id);
    if (m) yield* reply(m, crisis ? 'crisis' : mentioned.includes(id) ? 'mentioned' : 'owner');
  }
  // 5. Banter: a few companion-to-companion replies, never with a crisis, never past the cap.
  for (let i = 0; !crisis && i < room.banter && !stop && !signal.aborted && replies < cap && replies > 0; i++) {
    const next = banterSpeaker(ids, lastText, names, spoken);
    const m = next ? members.find((x) => x.id === next) : undefined;
    if (!m) break;
    yield* reply(m, 'banter');
  }
  yield { type: 'group_done', replies };
}

/** Who spoke recently in the room (oldest first), from the viewer's copy. */
function recentSpeakers(viewer: RoundMember): string[] {
  return viewer.app.store
    .messagesPage(viewer.convId, { limit: 40 })
    .messages.filter((m) => m.role === 'assistant' && m.content.trim())
    .map((m) => (m.meta?.speaker as Speaker | undefined)?.id ?? (m.meta?.groupFrom as { id?: string } | undefined)?.id ?? viewer.id);
}
