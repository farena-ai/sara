# Credits and third-party pieces

Sara's own code is under the [MIT license](../LICENSE). It has **no runtime npm dependencies**:
the server, the web app, and the phone and desktop apps are written for this project. The pieces
below are separate projects that Sara can download, call or run. Each keeps its own license and
terms; check the upstream page for the exact text before redistributing anything.

## Downloaded by the optional installers (never bundled in this repository)

| Piece | Used for | Installed by | License / terms |
|---|---|---|---|
| [Node.js](https://nodejs.org) 24 | Runs Sara | `deploy/install.sh` (checksum-verified) | MIT and others (see Node's LICENSE) |
| [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) | Local speech-to-text and voices | `deploy/install-voice.sh` | Apache-2.0 |
| NVIDIA Parakeet TDT-CTC 110M (sherpa-onnx export) | Local speech-to-text | `deploy/install-voice.sh` | See the model card (NVIDIA) |
| [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) v0.19 (sherpa-onnx export) | Local voices | `deploy/install-voice.sh` | Apache-2.0 |
| Piper voice `en_US-hfc_female-medium` (sherpa-onnx export) | Fast local fallback voice | `deploy/install-voice.sh` | See the voice's model card |
| [Claude Code](https://www.npmjs.com/package/@anthropic-ai/claude-code) | Claude subscription sign-in and delegated coding | `deploy/install-agents.sh` | Anthropic's terms |
| [Grok CLI](https://www.npmjs.com/package/@xai-official/grok) | Grok subscription sign-in, voice, pictures and delegated coding | `deploy/install-agents.sh` | xAI's terms |
| [Microsoft Edge WebView2](https://developer.microsoft.com/microsoft-edge/webview2/) SDK | The Windows desktop app's window | `desktop/windows/build.sh` | Microsoft's WebView2 SDK license |

## Downloaded by the benchmark scripts (never bundled in this repository)

| Piece | Used for | Downloaded by | License / terms |
|---|---|---|---|
| [HumanEval](https://github.com/openai/human-eval) (OpenAI) | The public coding benchmark in [docs/RESULTS.md](RESULTS.md) | `scripts/bench-coding.ts`, cached in `outputs/bench-cache/` | MIT |
| [MBPP sanitized](https://github.com/google-research/google-research/tree/master/mbpp) (Google Research), described in the [MBPP paper](https://arxiv.org/abs/2108.07732) | Optional sanitized coding benchmark in [docs/RESULTS.md](RESULTS.md) | `scripts/bench-coding.ts`, cached in `outputs/bench-cache/` | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), [dataset licensing](https://github.com/google-research/google-research#readme) |

## Online services Sara calls (only when you use the feature)

| Service | Used for | Terms |
|---|---|---|
| [Open-Meteo](https://open-meteo.com) | Weather in the briefing and for her outfits; the example tool in `examples/tools/` | Free for non-commercial use; data CC BY 4.0, attribution: "Weather data by Open-Meteo.com" |
| [OpenStreetMap Nominatim](https://nominatim.openstreetmap.org) | Turning addresses into places (leave-by, places) | Data © OpenStreetMap contributors, ODbL; [usage policy](https://operations.osmfoundation.org/policies/nominatim/) |
| [FOSSGIS routing](https://routing.openstreetmap.de) | Travel times for leave-by reminders | Data © OpenStreetMap contributors, ODbL; fair use |
| The model providers you connect (Ollama, OpenAI, Anthropic, xAI, OpenRouter, …) | Her thinking, voice and pictures | Each provider's own terms. Subscription sign-ins are used only where the provider allows it |
| Telegram, Discord, Google (Gmail, Calendar), GitHub, Home Assistant, Apple Push | Only when you connect them | Each service's own terms |

## Art

The default portrait and expressions of "Sara" were made for this project with Grok Imagine
(xAI). Pictures of your own companion are made on your own account and belong to you, under the
picture service's terms.

## Contributors

People who sent changes to Sara, newest first:

- [@Ehsan-hash](https://github.com/Ehsan-hash): the Python command-line starter, the testing browser in
  `sara doctor`, and every weather code in the example tool (2.8.2; [#20](https://github.com/farena-ai/sara/pull/20),
  [#21](https://github.com/farena-ai/sara/pull/21), [#22](https://github.com/farena-ai/sara/pull/22)), and ordered
  `.gitignore` negations in the code map (2.20; [#23](https://github.com/farena-ai/sara/pull/23)), previous and next links on
  the docs site and the sanitized MBPP benchmark option (2.22; [#24](https://github.com/farena-ai/sara/pull/24),
  [#25](https://github.com/farena-ai/sara/pull/25)).

## Thanks

To everyone behind the projects above.
