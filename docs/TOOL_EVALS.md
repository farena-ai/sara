# Tool and routing evals

`npm run eval:tools` (scripts/eval-tools.ts) answers three questions about a message someone sends:

1. **Offer.** Is the tool for the job in the list she sends the model? She has about 150 tools on a
   fresh install and sends a short list of about 27 (src/lean.ts): a fixed core, plus the tool
   families the message's words point to. A tool that is not in the list can still be reached, but
   only if the model first asks for it (`find_tools`), which costs a step and does not always happen.
2. **Route.** Which model does the message go to: the chat model, the research model, the coding
   model (src/chat.ts)?
3. **Choice.** Given that list and her real instructions, what does a real model do first?

## How it works

The script starts a real, throwaway Sara (`node src/main.ts` on a temporary data folder, never the
owner's Sara) whose only model provider is the script itself. Every model request she makes lands
there, so the script sees exactly what a model would be sent: the tools offered, the model asked
for, the size of the instructions. For questions 1 and 2 the script answers "ok" itself: no model,
about a minute. For question 3 it passes the request to a real model, writes down the model's first
move, and still answers Sara "ok". **No tool ever runs**, nothing is sent anywhere, and the folder
is deleted afterwards.

```
npm run eval:tools                                    # offer and route, no model
npm run eval:tools -- --model qwen3.8:27b-mtp-q4_K_M  # also a model in Ollama on this computer
npm run eval:tools -- --model some-model --upstream https://host/v1   # any OpenAI-style server (key: EVAL_API_KEY)
npm run eval:tools -- --only remind-dentist,chat-math # some cases
npm run eval:tools -- --list-tools                    # every tool a fresh Sara has
```

Results go to `outputs/tool-evals/<date>/` (a JSON file with everything seen, and a report).
With Ollama the script uses the daemon's own endpoint so it can set the context size (`--ctx`,
32,768 by default); through the OpenAI-style endpoint her instructions would be cut off.

## With tools also picked by meaning

`npm run eval:tools -- --embed nomic-embed-text` gives the throwaway Sara a Meaning search job (the
vectors come from that embedding model in Ollama on this computer), so the list also holds the
tools nearest to what the message means (src/tool-meaning.ts). Run it with and without `--embed` to
see what meaning adds and what it costs.

## The cases

scripts/eval-tools-cases.ts: one message each, the tool that should do the job (`want`), other
first moves that are also fine (`alsoFine`), and where it matters the expected route. They are how
people ask, not the tool's own words; some are in Spanish, French, German, Portuguese and Italian;
some want no tool at all (someone just talking). Only tools a fresh Sara has are used (no connected
mailbox, calendar or computer).

**Held-out cases** (ids starting with `h-`) were written after the word lists were tuned on the
others and are never tuned on. When one misses, it stays a miss. Their score is the honest one; the
score on the rest mostly shows that the fixes took. When you add words to src/lean.ts because of a
held-out miss, move that case out of the held-out group and write a new one.

How a first move counts: **right** (a wanted or fine tool, or no tool where none is wanted),
**looked** (she asked for tools first: slower, not wrong), **none** (a tool was wanted and she only
wrote words), **wrong** (something else).

## First run (2026-11-23, 3.39.0 plus this change)

Model: qwen3.8:27b-mtp-q4_K_M in Ollama on the owner's computer. Full table:
docs/results/2026-11-23-tool-evals.md.

| | Before the fixes | After |
|---|---|---|
| Offer, the cases tuned on (49) | 43 | 48 |
| Route, the cases tuned on (14) | 11 | 14 |
| Offer, held-out (18) | 8 | 8 |
| Route, held-out (3) | 0 | 1 |

- **Adding words did not carry over.** The new words fixed the cases they were written for and moved
  the held-out offer score by nothing (8 of 18 before and after).
- **The model is not the weak part.** With the wanted tool in the list it was right in 53 of 56
  (95%). Without it: right in 3 of 11 (it found another way), looked for the tool in 5, and in 3
  just answered in words.
- **The short list is.** On phrasings nobody tuned for, the wanted tool was in the list less than
  half the time (8 of 18). The word lists catch what someone thought of; people say it another way.
  Often a fine substitute is there (web search for a score), which is why the model's overall first
  move was still right in 61 of 73, but "start tracking my time" or "stop sugarcoating things" found
  nothing.
- **Routing by words has the same limit:** "look into which air purifiers are worth buying" and
  "peux-tu te renseigner sur…" are research asks the pattern does not know.
- What these numbers are not: one model, one run each, a first move only (not whether the job got
  done; scripts/eval-real.ts does that), on a fresh install.

What to do about it was in docs/BACKLOG.md; the first step is done, below.

## Second run: tools also picked by meaning (2026-11-23, Z7)

Each tool and each tool family gets a vector once (the embedding model of the Meaning search job);
each message gets one; the nearest four tools and the best five of the nearest family are added to
what the words found (`MEANT` in src/tool-meaning.ts). Embedding model: nomic-embed-text. Full table
with the model: docs/results/2026-11-23-tool-evals-meaning.md.

The wanted tool in the list sent to the model:

| Cases | Words only | Words and meaning |
|---|---|---|
| Fresh (20): written after the numbers in `MEANT` were set, run once | 12 | 19 |
| Held-out (18): never tuned on by words, but looked at while setting `MEANT` | 8 | 14 or 15 (two runs) |
| Tuned on by words (49) | 48 | 49 |

With the same model (qwen3.8:27b-mtp-q4_K_M), on the 73 cases both runs share, the first move was
right in 61 before and 65 after, and "went looking for the tool first" fell from 5 to 1. On all 93
cases: right in 85; with the tool in the list 77 of 82, without it 2 of 5. One case failed on the
model server's side (a 500 from Ollama), not on hers.

What it costs: the typical list went from 27 to 31 tools, about 5,700 to 6,500 tokens (14% more),
on every turn where a list is sent, including small talk (the scores of a right tool and of
unrelated chatter overlap, so there is no floor that keeps the one and drops the other). One call
to the embedding model per message; a turn waits at most 1.5 seconds for it and goes on with the
words alone if it is late.

What it does not do: nomic-embed-text is an English model, so a message in another language gets
nothing from it (the word lists cover six languages; a multilingual embedding model in the Meaning
search job would). It does not touch routing. And it needs the Meaning search job, which is off
until someone sets it.
