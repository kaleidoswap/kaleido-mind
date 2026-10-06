# node-minimal

The smallest useful `@kaleidorg/mind` agent: a local QVAC model, one in-process
tool and one skill, wired through the `Engine`.

```bash
# from the repo root
pnpm install && pnpm build

cd examples/node-minimal
pnpm start                               # Qwen3 1.7B via @qvac/sdk (~1 GB download on first run)
pnpm start "how much is bitcoin in USD?"
pnpm start:mock                          # no model: a scripted provider replays the turn
```

What it shows, in `src/index.ts`:

1. **Tool** — an `InProcessToolSource` with one JSON-Schema tool (`get_btc_price`).
2. **Skill** — a SKILL.md string registered on a `SkillRegistry`; `select()` picks it
   and `compose()` returns the system prompt plus the tools it may use.
3. **Provider** — `createQvacProvider` from `@kaleidorg/mind/qvac`, given the SDK's
   `completion` / `cancel` and the id returned by `loadModel`.
4. **Turn** — `engine.runAgentic()` loops model → tool → model until it answers.

Swap `QWEN3_1_7B_INST_Q4` for any other `@qvac/sdk` model constant
(`QWEN3_600M_INST_Q4` is ~380 MB and faster, but weaker at tool calling).
