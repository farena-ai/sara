# sara-sdk

A small TypeScript client for [Sara](https://github.com/farena-ai/FrankWeather)'s HTTP API.
Zero dependencies, ESM, typed. It uses only `fetch`, streams, `TextDecoder` and WebCrypto, so it runs
in Node 18+, Deno, Bun, workers and browsers.

- Sign in with a device code (the person approves the code in Sara)
- Conversations; send a message and **stream her reply**
- **Answer approval cards** (allow or deny what she wants to do)
- Upload a document and send it with a message
- The OpenAI-compatible `/v1` (models, chat, streamed chat) with an API key
- Verify Sara's outgoing **webhooks** (Standard Webhooks signatures)

The REST reference is [`docs/API.md`](../../docs/API.md) (generated from this package's route table).

## Install

From this repository (the package is not on npm yet):

```sh
cd packages/sara-sdk
npm run build        # tsc → dist/
npm pack             # sara-sdk-0.1.0.tgz, then: npm install ./sara-sdk-0.1.0.tgz
```

## Sign in

```ts
import { Sara } from 'sara-sdk';

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
SARA_SERVER=https://sara.example.com SARA_MESSAGE="Save a note: buy milk" node examples/stream-and-approve.mjs
```

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
import { verifyWebhook } from 'sara-sdk';

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

## License

MIT
