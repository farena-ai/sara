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

## With Meaning search set by herself

`npm run eval:tools -- --embed bge-m3 --adopt` writes no Meaning search job: the throwaway Sara gets
a second provider "on this computer" that has the embedding model, and has to set the job herself
(src/meaning-auto.ts), as a fresh install with Ollama would. The run waits for that and fails if it
does not happen.

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

## Third run: for everyone, other languages, routing by meaning (2026-11-24, S1)

Four changes (docs/ROADMAP_AFTER_3.40.md, stage 1): Meaning search sets itself once when an
embedding model is on this computer; the floors in `MEANT` belong to the embedding model
(`meantFor`); a research ask is also found by what it means (`research()`, `ROUTE_MEANT`); and
her instructions say to look for a tool before answering without one. 40 cases were added: 20 in
five other languages in a person's own words (`x-`), 16 for routing (`r-`: 8 research asks without
the usual words, 8 messages that only sound like them), on top of the 77 non-coding ones.

The wanted tool in the list sent to the model, and where the message went (no model, 117 cases):

| | Words only | nomic-embed-text | bge-m3, set by herself |
|---|---|---|---|
| Tool offered, all (117) | 86 | 101 | 109 |
| Held-out (18) | 8 | 15 | 15 |
| Fresh (20) | 12 | 19 | 18 |
| Other languages (20) | 8 | 8 | 18 |
| Routed as expected (33) | 23 | 25 | 31 |
| Research asks without the words (8) | 0 | 1 | 6 |
| Look-alikes kept with the talking model (8) | 8 | 8 | 8 |
| Tools on a typical turn | 26 | 31 | 31 |

How the numbers were set, so they can be trusted as far as they go and no further:

- **bge-m3's floors** (0.45 for a tool, 0.42 for a family, against 0.55 and 0.52) were set looking
  at the held-out, fresh and other-language cases. With nomic's floors bge-m3 offered 75 of 87; its
  scores are simply lower. So the 18 of 20 in other languages is a tuned number, not a fresh one.
- **Routing:** the asks and their opposites (`RESEARCH_ASKS`, `NOT_RESEARCH`) and a margin of 0.08
  were set on the 93 older cases. The `r-` cases were then written and run once: 3 of 8 research
  asks found, 8 of 8 look-alikes kept, with bge-m3. Looking at the scores afterwards, bge-m3 keeps
  the two apart cleanly (of 111 messages that are not research asks the nearest came to +0.02), so
  its margin was lowered to 0.05: 6 of 8. That second number is tuned. nomic-embed-text stays at
  0.08 (its nearest wrong one came to +0.078): 1 of 8, English only.
- **A wrong yes is the costly mistake** (small talk sent to the research model), so both are set
  where no message of the 111 that are not research asks crosses.

With a model (qwen3.8:27b-mtp-q4_K_M, words only, all 129 cases): the first move was right in 95,
it looked for tools first in 20, called something else in 6, only wrote words in 8. With the tool
in the list it was right in 80 of 86; without it, in 4 of 31 (it went looking in 20 of those 31).

**The look-for-a-tool line** moved little, because this model already looked: on the 11 cases that
had no tool in the list both before the line (the Z6 run) and after, "looked" went from 5 to 6 and
"only wrote words" from 3 to 2. The six cases that want no tool were unchanged (5 right, 1 wrong),
so the line did not make her reach for tools when someone is just talking. A weaker model may gain
more; that is not measured.

**The same model with bge-m3 set by herself** (docs/results/2026-11-24-tool-evals-s1-bge-m3-model.md):
the first move was right in 103 of 129 against 95 with words only; "looked for tools first" fell
from 20 to 6. By group, right first moves, words only -> with meaning: other languages 7 -> 16 of
20, fresh 12 -> 18 of 20, held-out 10 -> 13 of 19. Twelve cases at the end failed on the model
server's side (Ollama on the build computer began updating itself), so the real total is higher
than 103.

**Routing by meaning did not fire in that run: 0 of 8, where the run without a model had 6 of 8.**
Tools were still picked by meaning in the same turns (107 of 117 offered), so the embedding model
answered, only not within the 1.5 seconds routing waits. The likely cause, not confirmed (Ollama
was updating when it was looked at): with a 27B chat model and the embedding model sharing one
graphics card, the embedding model is not ready when the turn's first call asks, and routing asks
first. **Cause found and fixed the same day (S3).** Ollama on the build computer runs with
`OLLAMA_MAX_LOADED_MODELS=1`: each vector unloads the chat model (the vector then takes 2.5 to 6
seconds, the chat model 7 to 14 seconds to come back). So it was not only routing: every turn with
Meaning search paid for two model loads. Now the message's vector is one call that routing and the
tools share and that is not cancelled when routing gives up (`MEANT.queryMs`), and after
`MEANT.lateLimit` messages in a row with a late vector, meaning rests for `MEANT.restMs` (ten
minutes; the reason is in `ToolMeaning.lastError`). Measured again with the embedding model kept
loaded (a second Ollama on the processor for the run), the same chat model, the 29 routing cases:
**routed as expected 27 of 29; research asks without the usual words 6 of 8; look-alikes kept 8 of
8**, the same as without a chat model. On a computer set up like the build computer was, she now
falls back to the words after three turns instead of paying on every turn; letting Ollama keep two
models loaded is the real cure there (docs/CHOOSING_A_MODEL.md).

What it does not do: nothing is downloaded, so a computer with no embedding model gets none of this
until someone pulls one (the Meaning search tip in Settings names both). The floors for an embedding
model other than these two are nomic's, unmeasured. And the adoption is local only: a person whose
only embedding model is a paid one sets the job by hand, as before.

## Fourth run: a second other-language set, two more research asks (2026-11-24, S6)

Twenty more messages in five languages (`y-`), written after bge-m3's floors were set and run once
as found: the wanted tool was in the list for 11 of 20 with words alone and 20 of 20 with bge-m3
(set by herself). All 137 cases with bge-m3: offered 129, routed as expected 32 of 33.

Two research asks were added to `RESEARCH_ASKS` ("what is the general consensus on…", "gather what
is out there on the web about…") and two look-alikes to `NOT_RESEARCH` ("sum up what we talked
about earlier", "find the note I wrote about this"): the first try of the new asks sent "Sum up
what we talked about yesterday" to the research model, which the measurement showed. With bge-m3:
research asks without the usual words 7 of 8, look-alikes kept 8 of 8, nearest wrong message
+0.03 against a margin of 0.05. The `r-` cases have now been looked at twice and are tuned, not
fresh. Result file: docs/results/2026-11-24-tool-evals-s6-bge-m3.md.
