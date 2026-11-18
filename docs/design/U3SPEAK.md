# U3SPEAK: better meeting speakers on this computer (ROADMAP_U U3.13)

**Problem.** S2 tells speakers apart by channel (the desktop app's stereo: you vs. the call) or, for
uploads and one-microphone recordings, by pauses and pitch into at most two voices. Three people, two
alike voices or a hand-over without a pause all come out wrong.

**Built.** An optional *speaker add-on* that makes voice prints locally, and clustering in Sara's code.

| Part | Where | What |
|---|---|---|
| Add-on | `src/speaker-addon.ts` | Two pinned, SHA-256-checked, free files: the sherpa-onnx Node add-on `sherpa-onnx-<os>-<arch>@2.0.1` from npm (8–14 MB; win x64/arm64, linux x64/arm64, mac arm64/x64) and the 3D-Speaker ERes2Net VoxCeleb voice-print model (26 MB) from the sherpa-onnx releases. Both Apache-2.0, not gated (no Hugging Face token). Lives in `<data>/speaker-addon` (writable on Linux). Downloaded through `netFetch` (private local mode refuses), unpacked beside the target, moved in when whole. |
| Helper process | `src/speaker-worker.ts` | Loads the add-on + model and prints one 512-number voice print per window. Separate process: a native crash or a missing library never takes the server down (the part falls back). |
| Clustering | `src/speaker-cluster.ts` | Average-linkage agglomerative clustering on cosine similarity, merge while ≥ 0.45 (`SAME_VOICE`); stray groups (< 3% of windows) join the nearest voice; never more than 8 (`MAX_SPEAKERS`), the extra voices join the most alike one. Prior voices (earlier parts of one upload) keep their numbers; new voices take the next ones. A 3-wide vote smooths the windows. |
| Timeline | `src/meeting-audio.ts` `diarizeByVoice` | S2's pause-cut turns → 1.5 s windows every 0.75 s (longer steps beyond 1200 windows a part) → prints → clusters → a voice change inside a turn cuts it halfway into the overlap → S2's tidy (bridge, 45 s cap, padding). |
| Meetings | `src/meetings.ts` `#hearPart` | Voice prints when the add-on is ready and *Better speaker separation* is on, never for the app's stereo, never switching method in the middle of one upload. Notices: "told apart by their voices", "may be two people with very alike voices, kept as one", "more than 8 voices", "add-on stopped (this part by pauses and pitch)", "downloading … the next one uses it". The prints (8 × 512) are kept in `meetings.voices` as `{prints}` (S2 kept log pitches there). |
| Settings | Voice → Meetings | *Better speaker separation* (on by default; a tip), its state, *Download now*, *Remove*. `GET /api/meetings` → `speakerAddon`; `POST /api/meetings/speaker-addon {action: install|remove}` (owner only, audited). |

**First use.** The first upload or one-microphone recording that needs it starts the download in the
background (about 40 MB; refused in private local mode) and is split the S2 way with a notice; the next
recording uses voice prints. *Download now* fetches it ahead of time.

**Overlap (basic).** Two people at once go to whichever voice the window sounds most like; a change inside
a turn is cut halfway between windows. No separate "overlap" label.

**Why not…** pyannote 3.x (gated on Hugging Face, needs a token); `onnxruntime-node` (300 MB package, and
we'd have to write the fbank features); sherpa's own diarization CLI (its clustering is a black box: no
steady numbers across the parts of a 3-hour upload, no merge explanation). CAM++ (VoxCeleb) separated
SAPI David from Zira badly in a smoke test (0.90 between different voices); ERes2Net gave 0.86–0.91 same
voice vs. 0.05–0.10 different; WeSpeaker ResNet34 0.95 vs. 0.49 (CC BY 4.0 too). GPU not needed: a
10-minute part takes ~10–15 s on the CPU.

**Measured.** `node scripts/eval-speakers.ts` (Windows): 3 voices (SAPI David, SAPI Zira, Piper
hfc_female), 52 s, three hand-overs shorter than a pause: S2 found 2 speakers, 66.8% of speech time right,
8/13 lines; voice prints found 3, 97.5%, 13/13 lines; one voice alone stays 1 speaker. See
[RESULTS.md](../RESULTS.md#speakers-in-meetings). Synthetic voices are cleaner than people in a room.

**Limits.** English-trained model (works on other languages' voices, not measured); a one-word reply in a
long part may join a nearby voice (3% rule); very alike voices (same TTS voice, family members) can stay
one: rename by hand. The desktop app's right channel (everyone on the call) is still one speaker.
