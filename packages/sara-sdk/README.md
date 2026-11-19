# @farena-ai/sara-sdk

A small TypeScript client for [Sara](https://github.com/farena-ai/sara)'s HTTP API.
Zero dependencies, ESM, typed. It uses only `fetch`, streams, `TextDecoder` and WebCrypto, so it runs
in Node 18+, Deno, Bun, workers and browsers.

- Sign in with a device code (the person approves the code in Sara)
- Conversations; send a message and **stream her reply**
- **Answer approval cards** (allow or deny what she wants to do)
- Upload a document and send it with a message
- The OpenAI-compatible `/v1` (models, chat, streamed chat) with an API key
- Verify Sara's outgoing **webhooks** (Standard Webhooks signatures)

The REST reference is [`docs/API.md`](https://github.com/farena-ai/sara/blob/main/docs/API.md) (generated from this package's route table).

## Install

```sh
npm install @farena-ai/sara-sdk
```

Or from a checkout of the Sara repository: `cd packages/sara-sdk && npm run build && npm pack`, then
`npm install ./farena-ai-sara-sdk-<version>.tgz` in your project.

## Quick start

```ts
import { Sara } from '@farena-ai/sara-sdk';

const sara = new Sara({ server: 'https://sara.example.com', token: process.env.SARA_TOKEN });
const conv = await sara.conversations.create({ title: 'Hello from my app' });
const r = await sara.reply(conv.id, 'What is on my list today?');
console.log(r.text);
```

The token is a device token (below) or an API key from Settings → Connections → Other apps.

## Sign in

```ts
import { Sara } from '@farena-ai/sara-sdk';

const sara = new Sara({ server: 'https://sara.example.com' });
const token = await sara.auth.signIn({
  name: 'My app',
  onCode: (c) => console.log(`Approve ${c.code} in Sara (${c.verifyUrl})`),
});
// Keep the token (a secret) and pass it next time: new Sara({ server, token })
```

The person approves the code in Sara: Settings → Connections → Devices and sign-in. Sara asks
them to confirm it is really them. `sara.auth.signOut()` ends the token.

## Stream a reply and answer an approval

```ts
const sara = new Sara({ server, token });
const conv = await sara.conversations.create({ title: 'From my app' });

for await (const ev of sara.chat(conv.id, 'Save a note: buy milk')) {
  if (ev.type === 'token') process.stdout.write(ev.text);
  if (ev.type === 'approval') {
    // She wants to do something that asks first: allow or deny it.
    await sara.approvals.answer(ev.approvalId, confirm(`Allow: ${ev.summary}?`));
  }
  if (ev.type === 'error') console.error(ev.message);
}
```

Or wait for the whole reply:

```ts
const r = await sara.reply(conv.id, 'What is on my list?', { onApproval: (a) => a.name === 'todo' });
console.log(r.text, r.approvals);
```

Without `onApproval` a card waits for the person to answer it in Sara. Her own rules always apply:
tools set to ask still ask, tools that are off stay off, and an admin's policy can't be bypassed.
`sara.approvals.pending(conversationId)` lists cards still waiting (for example after a reconnect).

A full example is [`examples/stream-and-approve.mjs`](examples/stream-and-approve.mjs):

```sh
SARA_SERVER=https://sara.example.com SARA_MESSAGE="Save a note: buy milk" node node_modules/@farena-ai/sara-sdk/examples/stream-and-approve.mjs
```

The examples ship in the package (`examples/`); [`examples/responses.mjs`](examples/responses.mjs)
talks to Sara through Open Responses (`/v1/responses`).

## Files

```ts
const up = await sara.files.upload(bytes, { name: 'notes.md', conversationId: conv.id });
await sara.reply(conv.id, 'Read this please', { docs: [up.doc.id] });
```

`keep: true` adds it to her library instead of one conversation.

## OpenAI-compatible `/v1`

Make an API key in Sara (Settings → Connections → Other apps) and use it as the token:

```ts
const sara = new Sara({ server, token: apiKey });
const { data } = await sara.v1.models();            // her companions as models
const c = await sara.v1.chat({ model: 'sara', messages: [{ role: 'user', content: 'Hi' }] });
for await (const piece of sara.v1.chatStream({ model: 'sara', messages: [{ role: 'user', content: 'Hi' }] })) process.stdout.write(piece);
```

## Webhooks

Sara signs her outgoing webhook deliveries. Check them with the hook's secret and the **raw** body:

```ts
import { verifyWebhook } from '@farena-ai/sara-sdk';

const raw = await request.text();
const v = await verifyWebhook({ secret: process.env.SARA_HOOK_SECRET!, headers: request.headers, body: raw });
if (!v.ok) return new Response(v.why, { status: 401 });
// v.id: the delivery id (ignore repeats)
```

Timestamps more than 5 minutes off are refused (`toleranceS` to change it).

## Errors

Failed calls throw `SaraError` with `status`, `message` (Sara's words) and `code` (on `/v1`).
`status` 0 means the server could not be reached.

## Browsers

Use a device token in browsers only for the person's own app. Sara's `/v1` answers browsers from the
addresses allowed in Settings → Connections → Other apps → Browser apps that may call her.

## Add-on kit

Make your own Sara add-on (a tool she can use, its settings with ? tips, pages shown as cards),
test it against a real host and pack it for the Sara Store:

```bash
npx @farena-ai/sara-sdk create my-addon     # a working add-on folder with tests
cd my-addon
npx sara-addon test                          # your add-on in its own permission-limited process
npx sara-addon test --sara ~/sara            # a throwaway Sara (a checkout) with it installed
npx sara-addon pack                          # out/my-addon-0.1.0.sarapack.zip + .listing.json
```

```js
import { defineAddon, definePage, defineSetting, defineTool } from './sara-addon.mjs';

const greeting = defineSetting({ key: 'greeting', type: 'text', label: 'Greeting', tip: 'The word she starts each hello with.', default: 'Hello' });
const hello = definePage({ id: 'hello', title: 'Hello', render: (d) => ({ lines: [d.text] }) });
const greet = defineTool({
  name: 'greet',
  description: 'Say hello to someone by name.',
  parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  run: async ({ name }, sara) => {
    const text = `${sara.settings.greeting}, ${name}!`;
    return { content: text, card: hello.card({ text }) };
  },
});
export default defineAddon({ id: 'my-addon', name: 'My addon', version: '0.1.0', description: 'Says hello and shows it as a card.', tools: [greet], settings: [greeting], pages: [hello] });
```

The same typed helpers are importable from `@farena-ai/sara-sdk/addon` for TypeScript projects.
Packing sends nothing; submitting to the Sara Store is your own step on your Sara (`sara submit`).
The 10-minute tutorial and the reference: [docs/ADDON_KIT.md](https://github.com/farena-ai/sara/blob/main/docs/ADDON_KIT.md).

## License

MIT
