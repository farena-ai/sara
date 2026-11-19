# Free and local models for each job

Sara keeps a short, tested list of free models that run on your own hardware, one or more per job.
Settings → Models & usage → On this computer → **Recommended for this computer** shows, for each job,
the best one that fits your graphics card (or, without one, your memory), with:

- its download size, the memory it needs and its license;
- how well it did: **Tested here** (the re-check below ran on your computer), **Tested in our results**
  (our own published evals, [RESULTS.md](RESULTS.md)), or **Untested**;
- **Why this one**, and the other listed models that also fit;
- one button: **Download** (Ollama models), **Set up in Voice** (hearing and voices use the local voice
  download on the Voice page), or a note for the phone model (the Android app offers its offline copy).

Nothing downloads until you press a button. Downloading a model for pictures, coding or meaning search
never changes the model she talks with; for talking, press **Use for talking** once it is downloaded.
Downloads need the internet, so they wait while *Nothing leaves this computer* is on.

## The jobs

| Job | What it is for | How it gets here |
|---|---|---|
| Talking | everyday chat and her tools | Ollama |
| Coding | coding-mode chats | Ollama |
| Looking at pictures | photos and screenshots you send | Ollama |
| Hearing you | your voice to text | Voice page (local voice) |
| Her voice | her spoken replies | Voice page (local voice) |
| Meaning search | memory and Library find things said in other words | Ollama |
| Offline copy on your phone | short answers when the server can't be reached | the Android app |

The talking picks are the same as the first-run guide's (`GPU_TIERS`/`CPU_TIERS` in
`src/local-models.ts`): from Qwen 3.5 2B on small computers to Qwen 3.8 27B on a 24 GB card.

## The monthly re-check

Switch on **Re-check downloaded models every month** (off by default), or press **Re-check now**. Sara
then gives every listed model that is downloaded in Ollama on this computer a few short tests and
updates its **Tested here** mark:

- talking: follow an instruction, a sum, an answer as JSON;
- coding: a small JavaScript function, run in a separate Node with no file, network or program rights;
- pictures: the color of a picture she makes herself;
- meaning search: two sentences that mean the same land closer than an unrelated one.

It only uses Ollama on this computer (never a cloud model, nothing paid), runs at most once a month and
only after nobody has talked to her for 20 minutes. Results stay in `<data>/model-recheck.json`.

The same check runs by hand with `node scripts/model-recheck.ts`; `--publish` writes
`docs/results/model-recheck.json` and the section *Free and local models* on the results page
(`docs/results/index.html`). Voice and phone models are not part of the re-check yet.

## The list itself

`src/free-models.json` (versioned: `version`, `updated`), checked by `validateList` in
`src/free-models.ts` and `test/w2-models.test.ts`. Each entry: job, name, Ollama name, graphics memory
(`minGb`), processor memory (`cpuRamGb`; missing = not suggested without a graphics card), download
size, license (as published on the model's page on the list date), why, and a link to our own result
when we have one. To add a model, add an entry, run the test, and re-check it.
