// Example: stream Sara's reply and answer her approval cards.
//
//   npm run build            (once, in packages/sara-sdk)
//   SARA_SERVER=https://sara.example.com node examples/stream-and-approve.mjs
//
// Without SARA_TOKEN it signs in with a device code first (approve the code in Sara) and prints
// the token to keep. SARA_MESSAGE is what to say; SARA_CONVERSATION reuses a conversation;
// SARA_APPROVE=yes|no answers every card without asking (otherwise it asks on the terminal).
import { createInterface } from 'node:readline/promises';
import { Sara } from '../dist/index.js';

const env = process.env;
const sara = new Sara({ server: env.SARA_SERVER ?? 'http://127.0.0.1:3000', token: env.SARA_TOKEN });

if (!sara.token) {
  await sara.auth.signIn({
    name: 'Sara SDK example',
    onCode: (c) => console.log(`Approve this code in Sara: ${c.code}  (${c.verifyUrl}, or ${c.approveIn})`),
  });
  console.log(`Signed in. Keep this token as SARA_TOKEN: ${sara.token}`);
}

const conversationId = env.SARA_CONVERSATION ?? (await sara.conversations.create({ title: 'SDK example' })).id;
const ask = async (question) => {
  if (env.SARA_APPROVE) return /^y(es)?$/i.test(env.SARA_APPROVE);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
};

for await (const ev of sara.chat(conversationId, env.SARA_MESSAGE ?? 'Hello! What can you do?')) {
  if (ev.type === 'token') process.stdout.write(ev.text);
  else if (ev.type === 'tool_call') console.log(`\n· ${ev.summary}`);
  else if (ev.type === 'approval') {
    console.log(`\nSara wants to: ${ev.summary}`);
    const ok = await ask('Allow it? [y/N] ');
    await sara.approvals.answer(ev.approvalId, ok);
    console.log(ok ? '→ allowed' : '→ denied');
  } else if (ev.type === 'error') console.error(`\n${ev.message}`);
  else if (ev.type === 'done') process.stdout.write('\n');
}
