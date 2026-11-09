// Example: talk to Sara through Open Responses (/v1/responses) and continue with previous_response_id.
//
//   npm run build            (once, in packages/sara-sdk)
//   SARA_SERVER=https://sara.example.com SARA_KEY=sara_dev.… node examples/responses.mjs
//
// SARA_KEY is an API key from Settings → Connections → Other apps. Any Open Responses client (the
// official `openai` package's responses.create with baseURL `<server>/v1`) works the same way.
import { Sara } from '../dist/index.js';

const env = process.env;
const sara = new Sara({ server: env.SARA_SERVER ?? 'http://127.0.0.1:3000', token: env.SARA_KEY });

const first = await sara.v1.responses.create({ model: 'sara', input: env.SARA_MESSAGE ?? 'Remember that my favourite colour is green.' });
console.log(first.output.filter((i) => i.type === 'message').map((i) => i.content.map((c) => c.text).join('')).join('\n'));

// The next turn continues from the stored one; stream its words as they come.
for await (const ev of sara.v1.responses.stream({ model: 'sara', previous_response_id: first.id, input: 'What is my favourite colour?' })) {
  if (ev.type === 'response.output_text.delta') process.stdout.write(ev.delta);
  else if (ev.type === 'sara:approval') console.log(`\n[waiting for your OK in Sara: ${ev.summary}]`);
  else if (ev.type === 'response.failed') console.error(`\nFailed: ${ev.response?.error?.message}`);
}
console.log();
