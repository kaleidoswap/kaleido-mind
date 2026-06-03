# Reproducing KaleidoMind

End-to-end steps to build and run KaleidoMind — the local-first AI engine for
KaleidoSwap — on consumer hardware. Everything below runs **fully on-device**;
no cloud inference, no API keys.

- Engine + tooling: this repo (`@kaleidorg/mind`, published on npm)
- Mobile wallet: `rate` (React Native / Expo)
- Desktop: `desktop-app` (Tauri) + the Node inference sidecar (`apps/provider`)

---

## 0. Hardware used for our results

| Surface | Machine |
|---|---|
| Desktop / engine / benchmark | Apple silicon Mac (M-series), 24 GB unified memory, macOS |
| Mobile | iPhone 13 (iOS) — physical device (QVAC needs real hardware) |

The benchmark numbers in `docs/BENCHMARK.md` were produced on the Mac above.

---

## 1. Prerequisites

```bash
node --version    # ≥ 20
pnpm --version    # ≥ 9   (npm i -g pnpm)

# Desktop app only:
#   Rust + Tauri toolchain   (https://tauri.app/start/prerequisites/)
# Mobile only:
#   Xcode (iOS) and/or Android Studio, plus the Expo CLI
```

The QVAC native runtime ships with `@qvac/sdk`. (Optionally build the
[`qvac-fabric-llm.cpp`](https://github.com/tetherto/qvac-fabric-llm.cpp) fork
with `cmake -B build -DGGML_METAL=ON` for Metal acceleration on macOS.)

---

## 2. Build the engine

```bash
git clone git@github.com:kaleidoswap/kaleido-mind.git
cd kaleido-mind
pnpm install
pnpm -r build        # builds @kaleidorg/mind + the sidecar
pnpm --filter @kaleidorg/mind test   # 8 unit tests for the agentic loop
```

`@kaleidorg/mind` is also on npm: `npm i @kaleidorg/mind`.

---

## 3. Get a model

```bash
mkdir -p ~/.kaleido/models
# fast mobile-class model (≈0.4 GB) — great for tool selection:
curl -L "https://huggingface.co/unsloth/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf" \
  -o ~/.kaleido/models/Qwen3-0.6B-Q4_K_M.gguf
# stronger desktop model (≈2.3 GB):
curl -L "https://huggingface.co/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf" \
  -o ~/.kaleido/models/Qwen3-4B-Q4_K_M.gguf
# a QVAC Psy model (medical), ≈2.5 GB:
curl -L "https://huggingface.co/qvac/MedPsy-4B-GGUF/resolve/main/medpsy-4b-q4_k_m-imat.gguf" \
  -o ~/.kaleido/models/medpsy-4b-q4_k_m-imat.gguf
```

---

## 4. Test the tools — the fastest proof (no phone, no MCP)

The playground runs the engine + a demo wallet toolset against a **real local
model** and writes a masked training-data record per run.

```bash
pnpm play "what's my balance?"
pnpm play "pay 5000 sats to alice@getalby.com"
QVAC_MODEL_PATH=~/.kaleido/models/Qwen3-4B-Q4_K_M.gguf pnpm play "show my last 3 transactions"
```

Expect: the model emits a `<tool_call>`, the engine executes it, feeds the
result back, and answers in natural language. Money tools pause for
confirmation (auto-approved in the playground). Each run logs to
`~/.kaleido/mind/logs/<date>/`.

---

## 5. Benchmark a model

```bash
pnpm --filter @kaleidorg/mind-bench start -- ~/.kaleido/models/Qwen3-0.6B-Q4_K_M.gguf qwen3-0.6b
pnpm --filter @kaleidorg/mind-bench start -- ~/.kaleido/models/Qwen3-4B-Q4_K_M.gguf   qwen3-4b
pnpm --filter @kaleidorg/mind-bench start -- ~/.kaleido/models/medpsy-4b-q4_k_m-imat.gguf medpsy-4b
```

Scores tool selection + param following (by value) + latency on a 10-case
wallet eval set → `apps/bench/results/<label>.json`. Our numbers are in
`docs/BENCHMARK.md` (tool selection was 100% on all three models).

---

## 6. Desktop app (General Purpose track)

```bash
cd ../desktop-app
pnpm install
pnpm tauri:dev
```

In the app: **KaleidoMind** (sidebar) → **Models** (download a GGUF) →
**Status** (Start provider — loads the model, advertises on Hyperswarm P2P,
prints a public key) → **Pair** (QR for the phone) → **Playground** (chat).

To turn the desktop chat into a full 64-tool agent, build `kaleido-mcp` and
set a seed; the sidecar auto-detects it:
```bash
cd ../kaleido-mcp && npm i && npm run build
echo "your twelve word bip39 mnemonic" > ~/.kaleido/mind/wdk_seed && chmod 600 ~/.kaleido/mind/wdk_seed
# next "Start provider" connects kaleido-mcp automatically
```

---

## 7. Mobile app (Mobile track) — physical device required

```bash
cd ../rate
pnpm install
expo run:ios --device     # or: expo run:android
```

In the app: **AI Assistant** → download the model in **AI Settings** → chat or
hold-to-talk. To delegate inference to your desktop: **Settings → Connect to
desktop brain** → scan the QR from the desktop's Pair tab. The header shows
`<model> · via <desktop>` when delegating; wallet tools always execute on the
phone (keys never leave the device).

---

## 8. What to capture as artifacts

- `apps/bench/results/*.json` — benchmark evidence (committed).
- `~/.kaleido/mind/logs/*.jsonl` — sample agent turns (masked).
- A screen recording of: desktop provider start + QR, phone pairing, a voice
  command → tool call → result, and an airplane-mode segment.
- `docs/BENCHMARK.md` — performance numbers with hardware noted.
