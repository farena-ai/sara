# Choosing a model

Sara doesn't come with a model: she uses one you connect. This page helps you pick. You can change
it any time, and you can use a different model for each job.

## The three ways to give her a model

| | What it is | Good for | What it costs |
|---|---|---|---|
| **On your own computer** (Ollama, vLLM, llama.cpp, LM Studio) | The model runs on a GPU you own | Privacy (nothing leaves your hardware), private conversations, adult content | The hardware and electricity |
| **In the cloud with an API key** (OpenAI, Anthropic, xAI, OpenRouter, Ollama Cloud) | You pay the provider per use | The strongest models, no GPU needed | Per token: see [COSTS.md](COSTS.md) |
| **A subscription you already pay for** (ChatGPT plan, Claude Pro/Max, SuperGrok / X Premium+) | Sara signs in with your plan | Using what you already pay for | Counts toward your plan's limits |

The setup guide finds Ollama on the same computer by itself. **Settings → Models → On this
computer** suggests a model from the table below for that computer's graphics card (or Mac memory)
and downloads it, and holds the switch **Nothing leaves this computer** ([PRIVATE_LOCAL.md](PRIVATE_LOCAL.md)). Everything else is in **Settings →
Models**: *Default model*, *Which model does what*, *Subscriptions* and *Model providers*.

## Running models yourself: how much GPU memory?

A model's size is counted in billions of parameters ("27B"). Ollama usually downloads a 4-bit
version, which needs roughly **0.6 GB of GPU memory (VRAM) per billion parameters**, plus a few GB
for the conversation (the "context"). Rough guide:

| Model size (4-bit) | GPU memory | What to expect |
|---|---|---|
| 3-4B | 4-6 GB | Fine for quick jobs (memory notes, short messages); weak at coding and tools |
| 7-9B | 8 GB | Usable chat; simple tools |
| 12-14B | 12-16 GB | Good chat, decent tools |
| 20-24B (for example `gpt-oss:20b`) | 16 GB | Good chat and tools |
| 27-32B (for example `qwen3.8` 27B, which the [published results](RESULTS.md) use) | 24-32 GB | Strong chat, coding and tools: the size we recommend for a coding partner |
| 70B and up | 48 GB or more (several GPUs) | Close to cloud models |

These are rules of thumb: the exact numbers depend on the model and how long the conversation is.
If a model doesn't fit, Ollama runs part of it on the CPU, which works but is much slower. On a
Mac with Apple silicon, the GPU shares the main memory, so the same table applies to the Mac's
memory, minus what macOS and your other apps need (roughly: a 32 GB Mac for a 14B model, 64 GB for
27-32B).

Good to know:

- Models whose name ends in `-cloud` on Ollama (Ollama Cloud) run on Ollama's servers, not yours,
  even through your local Ollama. Sara treats them as cloud models (not for private
  conversations).
- Pick models that support **tool calling** for coding and anything that uses her tools. Most
  recent models do; Ollama's model pages say so.
- Ollama on another computer (a gaming PC at home, for example) works too: point Sara at it with
  the *Ollama on my computer* template in Settings → Models → Model providers. Use Tailscale or
  your home network, not the open internet.

## How much of the chat she keeps in mind (the context window)

Every model can read a limited amount at once: its **context window**, counted in tokens (a token
is about ¾ of an English word). Since 3.4.1 Sara sets how much of a conversation she rereads each
turn from the model that conversation actually uses. Settings → Models → Default model → Long
conversations → *How much of the chat she keeps in mind*:

- **Auto: balanced** (the default). Follows the model. On pay-per-token cloud models it stops at
  about 128,000 tokens (about 96,000 words) of chat, because every reply sends that much again and
  you pay for it every turn (see [COSTS.md](COSTS.md#how-much-of-the-chat-she-keeps-in-mind)). On
  subscriptions and on your own hardware there is no per-token charge, so she uses the window.
- **Auto: use the model's full window.** Up to everything the model holds, also on pay-per-token
  models (more memory, higher cost per turn).
- **Fixed sizes** (Short, Normal, Long, Very long, Huge): one size for every model, as before 3.4.1.

The line under the setting says it in plain numbers for your default model ("With gpt-4.1: she
keeps about 96,000 words of this chat in mind (the model holds about 786,000)"). The ring in the
chat header and `/status` measure against the same number for the conversation's own model.

How she works it out: the window, minus room for her reply (up to 16,000 tokens), minus about
12,000 tokens for everything she sends besides the chat (her instructions, the tool list, notes and
skills), times 0.85 as a safety margin; then the cost guard above; at most about a million tokens.
Characters are counted at about 4 per token (fewer for Chinese, Japanese and Korean, which she
measures from the chat itself). When a backup model with a smaller window takes over for a reply,
that reply gets a shorter history.

Where the window comes from, best first:

1. **The provider's own model list**, checked once a day and kept for offline use
   (`model-windows.json` in the data folder): OpenRouter's `/models`, Ollama's `/api/tags` and
   `/api/show`, Google Gemini's models API, Anthropic's models API (`max_input_tokens`), and any
   OpenAI-compatible server that includes a window field (vLLM's `max_model_len`, LM Studio's
   loaded context, `context_length` / `context_window` elsewhere).
2. **A table of well-known model families** (checked 2026-11-11 against OpenRouter's public model
   list and the vendors' pages; conservative values):

   | Family | Window (tokens) |
   |---|---|
   | GPT-4.1 | 1,047,576 |
   | GPT-5.4 and later, GPT-6 | 1,050,000 |
   | GPT-5 to 5.3 | 400,000 (ChatGPT plan: 272,000) |
   | GPT-4o, gpt-oss | 128,000 / 131,072 |
   | Claude (API key or subscription) | 200,000; the opt-in 1M variants (`…[1m]`) 1,000,000 |
   | Gemini 1.5 to 4 | 1,048,576 |
   | Grok 4 / 5 | 256,000 (Grok 4.20: 2,000,000) |
   | Llama 3.1-3.3 / Llama 4 | 131,072 / 524,288 |
   | Qwen 3.5 and later / Qwen 3 | 262,144 / 40,960 |
   | Mistral Large/Medium/Small (2025-12 on), Devstral / older | 256,000 / 128,000 |
   | DeepSeek V3 / V4 | 163,840 / 1,048,576 |
   | Kimi K2 / K3, GLM 4.6-5.1 / 5.2+, MiniMax M2 / M3 | 262,144 / 1,048,576, 200,000 / 1,048,576, 196,608 / 1,000,000 |

3. **Anything else:** the old default, about 12,000 tokens (48,000 characters). Sara never guesses
   a bigger window for a model it doesn't know.

### Ollama on your own computer: num_ctx

Ollama loads a model with a small context unless the request asks for more (4,096 tokens on
machines with less than 24 GB of graphics memory), and it **silently cuts off** anything longer.
Its OpenAI-compatible endpoint can't ask for more, which is a quiet reason long chats used to go
wrong with local models. Sara now sends Ollama's own `num_ctx` option (through `/api/chat`) with
every call: **32,768 tokens** by default (65,536 with 24 GB of graphics memory or more, 131,072
from 48 GB; never past the model's own maximum); *full window*
asks for the model's maximum, bounded by the graphics memory (64k under 24 GB, 128k from 24 GB,
256k from 48 GB); a fixed size asks for enough room for that size. A bigger context uses more
graphics memory; if a model no longer fits, pick a smaller size. Cloud models through your Ollama
already get their full window from Ollama.

## Cloud models

Any current model from OpenAI, Anthropic or xAI works well for chat, coding and tools. The
cheaper "mini", "flash" or small models are fine for background jobs. Sara ships with list prices
for a few of them (checked on the providers' pricing pages on 2026-10-27; see [COSTS.md](COSTS.md)),
and the Usage and costs page lets you add your own.

Cloud providers apply their own content rules whatever Sara's settings say: adult content
usually needs a model on your own hardware or a provider that allows it.

## Model lists stay current by themselves

You never have to type a model name or hunt for a new one. Sara keeps every provider's model list
(Ollama, Ollama Cloud, OpenAI, Anthropic, xAI, OpenRouter, ChatGPT plan, Claude, Grok, any
OpenAI-compatible service) up to date:

- **Once a day** she checks each list by herself (*Settings → Models → Model providers → Keep the
  model list up to date*, on by default). **↻ Refresh** next to any model picker, on the *Default
  model* page and on each provider card checks right away. Adding a provider or changing its key
  checks it too.
- **New models** show **· New** in every picker for a week.
- **Retired models** disappear, but only after two checks in a row agree. A failed check, a
  time-out or an empty answer never removes anything.
- **Anything still set to a retired model** (the default model, a job in *Which model does what*,
  a companion's own model, a helper, a backup, the safety check) moves to the best replacement on
  the same provider: the same family with the highest version (Gemma 4 31B → Gemma 5 31B), else the
  model recommended for that job. Today and Health say what changed, e.g. "Gemma 4 31B was retired
  by Ollama Cloud; Talking now uses Gemma 5 31B." Turn off *Settings → Models → Default model →
  Switch to the replacement automatically* to only get a warning in Health instead.

### Every Ollama Cloud model through your Ollama

An Ollama on the server or on your computer that is signed in to ollama.com (`ollama signin` on
that computer) can run Ollama Cloud models. With **Include all Ollama Cloud models** on (the
default when that Ollama already has a cloud model), the pickers list the whole Ollama Cloud
catalog, not only the cloud models already added there. The ones not added yet sit in the
**Ollama Cloud (added when you pick one)** group. Pick one anywhere and Sara adds it to that
Ollama (`ollama pull`, a tiny download) right before its first use. If that Ollama isn't signed
in, you get a plain message saying to run `ollama signin`.

When Ollama Cloud retires a model, it is hidden. **Remove retired cloud models from Ollama** (off
by default) also removes it from that Ollama. Sara never removes models downloaded to your own
computer.

## What each job is

In **Settings → Models → Which model does what**, every job uses your default model unless you
pick another. **✨ Use recommended** fills in picks from what's connected (it looks at model names
only; nothing is sent anywhere). Each job also has *Test* (does it work, how fast) and *Compare…*
(a short side-by-side test where you pick the winner).

| Job | What it does | What to pick |
|---|---|---|
| **Talking** | Everyday conversation. The most important one | The model whose replies you like best |
| **Coding** | Coding-mode conversations: files, commands, git | A model that's good with code and tools |
| **Looking at pictures** | Photos and screenshots you send, and scanned pages in her library | A model that can see: `gemma4`, a "vl" or "vision" model, GPT, Claude or Grok |
| **Planning** | Morning briefing, weekly review, plans for her team | A careful, strong model |
| **Writing** | Her diary, her life story, character writing | A model with a nice way with words |
| **Web research** | When you ask her to look something up | Good with tools and sources |
| **Quick replies** | Short messages she sends by herself, notes about finished jobs | A small, fast model |
| **Memory and summaries** (the "background model") | Noting what matters from your conversations, summaries, learning from your library and imported history, other behind-the-scenes work | A fast, cheap model is fine. It runs often, so a local model saves money |
| **Meaning search** (under *More jobs*) | Lets her memory, library and code map find things said in other words | An **embedding model**, for example `ollama pull nomic-embed-text` (small: runs fine on a CPU). Off: she searches by words only |
| **Private conversations** | The model for conversations marked private | A model on your own hardware (not an Ollama cloud model) |
| **Adult** | Used when a conversation turns explicit, only with Adult mode on | One that allows it; cloud models often refuse |
| **Safety check** (optional) | A local model that double-checks messages for crisis or content involving minors, on top of the built-in checks | A small local model |
| **Double-check her claims** (optional, off by default) | Asked only when the built-in receipt check can't tell whether she claims something (saved, sent, ran) no tool did; it can only add a correction | A small local model (on the dev PC `qwen3.5:9b` answered in about 0.1 s; see [RESULTS](RESULTS.md#claim-check-in-six-languages)) |

Live voice calls don't use these: they run on the voice service you choose (Grok or OpenAI) in
Settings → Her → Voice. Pictures of her are made by xAI Grok Imagine (Settings → Her → Pictures
from her).

## A few setups that work

- **All local, one good GPU (24-32 GB):** a 27-32B model for everything, `nomic-embed-text` for
  meaning search. Nothing leaves your hardware. This is what the published results were measured
  with.
- **All local, smaller GPU (8-16 GB):** a 12-20B model for talking and coding, a 3-4B model for
  quick replies and memory, `nomic-embed-text`.
- **No GPU:** a cloud model or a subscription for talking and coding, a cheap cloud model for
  memory and quick replies. Add `nomic-embed-text` in Ollama on the server's CPU if you want
  meaning search without sending your memories anywhere.
- **Mixed:** a cloud model for talking and coding, local models for memory, meaning search and
  private conversations.

Next: [COSTS.md](COSTS.md) (what each choice costs) and [REQUIREMENTS.md](REQUIREMENTS.md) (the
server itself).
