// Phase 51: reads a ChatGPT data export (Settings → Data controls → Export data). The zip holds
// conversations.json (newer exports may split it into conversations-000.json, -001.json …): an
// array of conversations, each { id / conversation_id, title, create_time, update_time,
// current_node, mapping }. `mapping` is a tree keyed by node id; each node is
// { id, parent, children, message: { author: { role }, create_time, content: { content_type,
// parts | text }, recipient, metadata: { is_visually_hidden_from_conversation, attachments } } }.
// The conversation as it was shown is the path from `current_node` up its parents, reversed
// (edited and regenerated branches are left out). Format as publicly described, e.g.
// https://github.com/getaifs/chatgpt-export/blob/main/SCHEMA.md and
// https://www.chatexports.com/blog/chatgpt-conversations-json-format-developer-guide (checked 2026-10).
import { clipText, type ImportedConversation, type ImportedMessage, isoTime, noSkips, type ParsedExport, type SkipCounts } from './types.ts';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined);

/** Tool and browsing output, code runs: not part of what was said. */
const TOOLISH = new Set(['code', 'execution_output', 'tether_browsing_display', 'tether_quote', 'computer_output', 'system_error', 'sonic_webpage', 'super_widget']);
/** Model reasoning and app context: hidden in the ChatGPT window too. */
const HIDDEN = new Set(['thoughts', 'reasoning_recap', 'model_editable_context']);

/** ChatGPT's inline citation markers (private-use characters around "cite…turn0search1"). */
const stripCitations = (s: string) => s.replace(/\ue200[^\ue201]*\ue201/g, '').replace(/[\ue200-\ue2ff]/g, '');

export function looksLikeChatGPT(list: unknown): boolean {
  return Array.isArray(list) && list.some((c) => Boolean(obj(obj(c)?.mapping)));
}

/** The node ids of the shown conversation, oldest first. */
function shownPath(mapping: Obj, current: unknown): string[] {
  let id = typeof current === 'string' && mapping[current] ? current : undefined;
  if (!id) {
    // No current node: follow the last child from the root down.
    const root = Object.keys(mapping).find((k) => !obj(mapping[k])?.parent || !mapping[String(obj(mapping[k])?.parent)]);
    id = root;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const kids = obj(mapping[id])?.children;
      const next = Array.isArray(kids) && kids.length ? String(kids.at(-1)) : undefined;
      if (!next || !mapping[next]) break;
      id = next;
    }
  }
  const out: string[] = [];
  const seen = new Set<string>();
  while (id && mapping[id] && !seen.has(id)) {
    seen.add(id);
    out.push(id);
    const p = obj(mapping[id])?.parent;
    id = typeof p === 'string' ? p : undefined;
  }
  return out.reverse();
}

function readMessage(m: Obj, fallbackTime: string, skipped: SkipCounts, bio?: string[]): ImportedMessage | undefined {
  const role = String(obj(m.author)?.role ?? '');
  const meta = obj(m.metadata) ?? {};
  const content = obj(m.content) ?? {};
  // V1.1: a memory the model saved during the chat (the "bio" tool): a note, not a skipped step.
  if (role === 'assistant' && m.recipient === 'bio' && bio) {
    const parts = Array.isArray(content.parts) ? content.parts : typeof content.text === 'string' ? [content.text] : [];
    for (const p of parts) if (typeof p === 'string' && p.trim()) bio.push(p.trim());
    return undefined;
  }
  const type = String(content.content_type ?? 'text');
  if (meta.is_visually_hidden_from_conversation === true || type === 'user_editable_context') {
    if (type === 'user_editable_context' || role === 'system') skipped.system++;
    else skipped.hidden++;
    return undefined;
  }
  if (role === 'system') return void skipped.system++;
  if (role === 'tool') return void skipped.tool++;
  if (role !== 'user' && role !== 'assistant') return void skipped.hidden++;
  if (HIDDEN.has(type)) return void skipped.hidden++;
  if (TOOLISH.has(type) || (role === 'assistant' && typeof m.recipient === 'string' && m.recipient !== 'all')) return void skipped.tool++;
  const texts: string[] = [];
  const attachments: string[] = [];
  const parts = Array.isArray(content.parts) ? content.parts : typeof content.text === 'string' ? [content.text] : [];
  for (const p of parts) {
    if (typeof p === 'string') texts.push(p);
    else {
      const po = obj(p);
      if (!po) continue;
      const pt = String(po.content_type ?? '');
      if (pt === 'image_asset_pointer' || pt.includes('image')) {
        skipped.images++;
        attachments.push('an image');
      } else if (typeof po.text === 'string') texts.push(po.text); // e.g. an audio transcription
    }
  }
  if (Array.isArray(meta.attachments)) {
    for (const a of meta.attachments) {
      const name = String(obj(a)?.name ?? 'a file').slice(0, 120);
      // A picture shows up both as a part and as an attachment: count it once.
      if (/\.(png|jpe?g|gif|webp|heic)$/i.test(name) && attachments.includes('an image')) continue;
      skipped.attachments++;
      attachments.push(name);
    }
  }
  const text = stripCitations(texts.join('\n')).trim();
  if (!text && !attachments.length) return void skipped.hidden++;
  return {
    role,
    text: clipText(text || `[${attachments.join(', ')}]`),
    createdAt: isoTime(m.create_time) ?? fallbackTime,
    ...(attachments.length ? { attachments } : {}),
  };
}

/** Turns the parsed conversations.json array(s) into conversations. */
export function parseChatGPT(lists: unknown[], now: Date): ParsedExport {
  const skipped = noSkips();
  const conversations: ImportedConversation[] = [];
  const seen = new Set<string>();
  const bio: string[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const c = obj(raw);
      const mapping = obj(c?.mapping);
      if (!c || !mapping) continue;
      const created = isoTime(c.create_time) ?? now.toISOString();
      const sourceId = String(c.conversation_id ?? c.id ?? '').trim() || `untitled-${created}-${String(c.title ?? '')}`;
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      const messages: ImportedMessage[] = [];
      let last = created;
      for (const id of shownPath(mapping, c.current_node)) {
        const m = obj(obj(mapping[id])?.message);
        if (!m) continue;
        const msg = readMessage(m, last, skipped, bio);
        if (!msg) continue;
        // Keep times in order (regenerated replies can carry an earlier stamp).
        if (msg.createdAt < last) msg.createdAt = last;
        last = msg.createdAt;
        messages.push(msg);
      }
      if (!messages.some((m) => m.role === 'user')) {
        skipped.emptyConversations++;
        continue;
      }
      conversations.push({
        sourceId,
        title: String(c.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || messages.find((m) => m.role === 'user')!.text.replace(/\s+/g, ' ').slice(0, 60),
        createdAt: created,
        updatedAt: isoTime(c.update_time) ?? messages.at(-1)!.createdAt,
        messages,
      });
    }
  }
  return { source: 'chatgpt', conversations, skipped, bio };
}
