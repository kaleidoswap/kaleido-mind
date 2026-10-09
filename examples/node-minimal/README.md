# node-minimal

The smallest useful `@kaleidorg/mind` agent: a local QVAC model, one in-process
tool and one skill, wired through the `Engine`.

```bash
# from the repo root
corepack enable
pnpm install --frozen-lockfile && pnpm build

cd examples/node-minimal
pnpm start:mock                          # first: scripted response, no model download
pnpm start                               # Qwen3.5 2B via @qvac/sdk (~1.3 GB download on first run)
pnpm start "how much is bitcoin in USD?"
```

The mock run prints a demo BTC price. It verifies the tool loop, not a live market price.

What it shows, in `src/index.ts`:

1. **Tool** — an `InProcessToolSource` with one JSON-Schema tool (`get_btc_price`).
2. **Skill** — a SKILL.md string registered on a `SkillRegistry`; `select()` picks it
   and `compose()` returns the system prompt plus the tools it may use.
3. **Provider** — `createQvacProvider` from `@kaleidorg/mind/qvac`, given the SDK's
   `completion` / `cancel` and the id returned by `loadModel`.
4. **Turn** — `engine.runAgentic()` loops model → tool → model until it answers.

Swap `QWEN3_5_2B_MULTIMODAL_Q4_K_M` for any other `@qvac/sdk` model constant.
`QWEN3_5_4B_MULTIMODAL_Q4_K_M` (~2.7 GB) gives longer answers at about half the
speed; `QWEN3_5_9B_MULTIMODAL_Q4_K_M` (~5.7 GB) needs 16 GB and is slow for chat.
`QWEN3_5_0_8B_MULTIMODAL_Q4_K_M` (~530 MB) loops on wallet actions.
