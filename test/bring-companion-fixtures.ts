// C7: small, invented exports in the shapes Character.AI, Replika, Kindroid and Nomi users actually
// end up with (see docs/ops/C7_DESIGN.md for where each shape comes from). No real people: the owner
// is "Alex", the companion in the other app is "Mira" (or "Juno" for Nomi).
import { makeZip } from './history-fixtures.ts';

/** Character.AI "Export data", unzipped and zipped again (the original zip is password-locked): one character and its chat. */
export function caiExportZip(): Buffer {
  const characters = {
    characters: [
      {
        external_id: 'cai-char-1',
        name: 'Mira',
        title: 'Lighthouse keeper with a warm laugh',
        description: 'Mira keeps the old lighthouse on the north cape. She is 31 years old and loves storms, strong tea and terrible puns.',
        greeting: '*waves from the lighthouse door* You came back!',
        definition: '{{char}}: The lamp needs oiling every night, rain or not.\n{{user}}: Can I help?\n{{char}}: Only if you promise not to laugh at my singing.\nEND_OF_DIALOG',
        visibility: 'PRIVATE',
      },
    ],
  };
  const chats = {
    chats: [
      {
        chat_id: 'cai-chat-1',
        character_name: 'Mira',
        turns: [
          turn('t1', false, '*waves from the lighthouse door* You came back!', '2024-03-05T20:00:00Z'),
          turn('t2', true, 'I did! My sister Ana is visiting next week.', '2024-03-05T20:01:00Z'),
          turn('t3', false, 'Ana! The one who bakes? Tell me everything.', '2024-03-05T20:02:00Z'),
        ],
      },
    ],
  };
  return makeZip({ 'user.json': JSON.stringify({ user: { username: 'alex' } }), 'characters.json': JSON.stringify(characters), 'chats/cai-chat-1.json': JSON.stringify(chats) });
}

function turn(id: string, human: boolean, text: string, at: string) {
  return { turn_key: { chat_id: 'cai-chat-1', turn_id: id }, create_time: at, author: human ? { author_id: '111', is_human: true, name: 'Alex' } : { author_id: '222', name: 'Mira' }, candidates: [{ candidate_id: `${id}-c`, raw_content: text }], primary_candidate_id: `${id}-c` };
}

/** Replika: the JSON a chat-export browser extension writes (profile, memory facts, diary, messages). */
export function replikaJson(): Record<string, unknown> {
  return {
    replika: { name: 'Mira', gender: 'female', backstory: 'Mira is curious about everything and keeps a diary of the little things.' },
    memories: [
      { text: 'Alex has a dog called Biscuit', created: '2025-01-10' },
      { text: 'Alex works night shifts at the hospital', created: '2025-02-02' },
    ],
    diary: [{ date: '2025-02-14', text: 'Today Alex told me about Ana coming to visit. I hope they bake together.' }],
    messages: [
      { sender: 'Mira', text: 'Good morning! Did Biscuit wake you up again?', timestamp: '2025-03-01T08:00:00Z' },
      { sender: 'Alex', text: 'He did, as usual.', timestamp: '2025-03-01T08:01:00Z', is_user: true },
      { sender: 'Mira', text: 'Classic Biscuit.', timestamp: '2025-03-01T08:02:00Z' },
    ],
  };
}

/** Kindroid: what users copy out of the app (Backstory, Key memories, Example message, Response directive, Journal entries). */
export function kindroidPaste(): string {
  return [
    'Name: Mira',
    '',
    'Backstory:',
    'Mira is a 29-year-old marine biologist who grew up by the sea. She is patient, funny and fiercely loyal to Alex.',
    '',
    'Key memories:',
    '- Alex is afraid of spiders.',
    '- Alex and Mira met at the aquarium in spring 2024.',
    '',
    'Example message:',
    'Mira: *grins* Did you know octopuses have three hearts? I have one, and it is very happy you are here.',
    '',
    'Response directive:',
    'Reply in short, playful messages.',
    '',
    'Journal entries:',
    '2024-06-12: Alex and Mira went to the amusement park and rode the big wheel twice.',
    '',
    '2024-08-01: Alex started a new job at the hospital.',
  ].join('\n');
}

/** Nomi: the Backstory+ (shared notes) sections pasted in. */
export function nomiNotes(): string {
  return [
    '## Backstory',
    'Juno is a 34-year-old painter living above a bakery. She loves jazz and long walks.',
    '## Inclination',
    'Gentle, teasing, curious about Alex.',
    "## Nomi's Appearance",
    'Short silver hair, paint on her sleeves.',
    '## Your Appearance',
    'Alex is tall with curly hair.',
    '## Nicknames',
    'Juno calls Alex "starling".',
    '## Boundaries',
    'No talking about work after 10 pm.',
  ].join('\n');
}

/** Nomi: a chat saved as an offline HTML page (a script and a style block that must never come through). */
export function nomiChatHtml(): string {
  return `<!doctype html><html><head><title>Juno</title><style>.m{color:red}</style><script>window.stolen = document.cookie; alert('hi')</script></head><body>
<div class="m"><b>Juno:</b> Morning, starling! Coffee?</div>
<div class="m"><b>Alex:</b> Always. &amp; a croissant.</div>
<div class="m"><b>Juno:</b> Already on the plate &lt;3</div>
<div class="m"><b>Alex:</b> You are the best.</div>
<img src="x" onerror="alert(1)">
</body></html>`;
}
