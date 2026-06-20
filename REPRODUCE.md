# Reproducing KaleidoMind

These instructions separate deterministic CI checks from real QVAC inference.
AI inference is local or runs on an explicitly paired user-controlled device.
Optional remote tools are documented in
[`submission/remote-apis.yaml`](./submission/remote-apis.yaml).

## Reference hardware

| Surface | Hardware |
|---|---|
| Desktop and benchmark | MacBook Air `Mac16,12`; Apple M4, 10 cores, 24 GB; macOS 26.5.1 |
| Mobile | Standard iPhone 17; exact iOS/storage/thermal state recorded with the run |

## Clean build and deterministic checks

```bash
git clone https://github.com/kaleidoswap/kaleido-mind.git
cd kaleido-mind
git rev-parse HEAD

corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
pnpm submission:check
pnpm submission:evidence:mock
```

Node 20 or 22 and pnpm 9 are supported. The mock benchmark validates datasets,
grading, reporting and evidence packaging; it is not a model-performance claim.

## Install and inspect models

```bash
cd apps/cli
pnpm exec tsx src/index.ts setup
pnpm exec tsx src/index.ts status
```

Model weights download from Hugging Face only when requested. Record the exact
filename and SHA-256:

```bash
shasum -a 256 ~/.kaleido/models/*.gguf
```

## Real QVAC benchmark

The QVAC worker holds a single model lock, so tracks and models are deliberately
run sequentially:

```bash
# Short rehearsal.
pnpm submission:evidence -- --quick

# Standard submission sweep.
MODELS=qwen3-0.6b,qwen3-1.7b,qwen3-4b REPEATS=3 PER=2 \
  pnpm submission:evidence
```

The command creates `submission/evidence/desktop-<timestamp>/` containing an
environment manifest plus unedited stdout/stderr for safety, multistep, quality
and capability. The CLI's HTML/CSV/raw reports are written under
`~/.kaleido/mind/logs/`; review for personal data before copying the selected
run into the repository.

Before the recorded run:

1. Connect power or record battery state.
2. Close other model processes.
3. Record ambient/thermal conditions.
4. Record the submission commit and model hashes.
5. Do not edit or merge output from separate runs.

## Desktop product

```bash
cd ../desktop-app
pnpm install --frozen-lockfile
pnpm tauri:dev
```

Open KaleidoMind, load a local model, start the provider and run the standard
demo prompt. Development-mode sibling-repository discovery is the supported
hackathon path; packaging the large sidecar is not required for reproduction.

## Rate mobile product

```bash
cd ../Rate
pnpm install --frozen-lockfile
npx expo run:ios --device "iPhone 17"
```

QVAC requires a physical device for local AI. Enable KaleidoMind, select a
model and run the same prompt. Use Chat settings → **Export hackathon evidence**
to share the sanitized JSONL file. For delegation, pair with the desktop
provider; wallet tools and keys remain on the phone.

## Artifact checklist

- exact repository commit and public URL;
- dependency lockfiles;
- benchmark manifest and unedited logs;
- selected QVAC raw/CSV/HTML report;
- desktop and mobile JSONL evidence;
- model hashes;
- privacy-scrubbed hardware screenshots;
- unlisted demo video under five minutes.
