# rgb-agent

A local QVAC model that operates an RGB Lightning Node (RLN): it lists RGB
balances, creates an RGB invoice and sends an asset — with every spend read back
and confirmed by you first.

| Command | Tools | Model |
|---|---|---|
| `pnpm start` | [kaleido-mcp](https://www.npmjs.com/package/kaleido-mcp) over stdio, on signet | Qwen3.5 2B via `@qvac/sdk` |
| `pnpm start:mock` | in-process fake RLN (`MockWallet`) — no node needed | Qwen3.5 2B |
| `OPENAI_BASE_URL=… OPENAI_MODEL=… pnpm start:mock` | fake RLN | any OpenAI-compatible server (Ollama, LM Studio, …) |
| `pnpm start:offline` | fake RLN | scripted, no download (used in CI) |

```bash
# from the repo root
corepack enable
pnpm install --frozen-lockfile && pnpm build
cd examples/rgb-agent
pnpm start:offline       # first: simulated wallet and scripted responses
pnpm start:mock          # next: same fake wallet, real model download
```

## Against a real node (signet)

1. Run an RGB Lightning Node on signet and note its API URL.
2. Start the agent; it spawns the current `kaleido-mcp` package with `KALEIDO_NETWORK=signet`:

```bash
RLN_NODE_URL=http://localhost:3001 \
RECIPIENT_INVOICE='rgb:...' \
pnpm start
```

`RECIPIENT_INVOICE` is an RGB invoice created by another wallet; without it the
send step is skipped. Spends prompt `[y/N]` on the terminal; `--yes` approves
them automatically (mock runs only, please).

## Eval

`src/eval.ts` sends eight wallet requests through the full `Funnel` (fast path,
recipes, skills, agentic loop) with the local model and checks each result:
balance, asset list, asset issuance, RGB invoice, Lightning invoice, a
KaleidoSwap quote (live only), buying a channel from the KaleidoSwap LSP (live
only; any payment is declined) and a send that is declined at the confirmation
gate. It prints PASS/FAIL per request and exits 1 on any failure.

```bash
pnpm eval:mock                                   # fake RLN node, no node needed
RLN_NODE_URL=http://localhost:3001 pnpm eval     # your signet node
MODEL=QWEN3_5_2B_MULTIMODAL_Q4_K_M ONLY=issue,send OUT=eval.jsonl pnpm eval:mock
REPEAT=3 pnpm eval:mock                          # pass rate per scenario over 3 runs
```

The live run issues a new test asset (approved at the gate), so the node needs
a free colored UTXO and some signet sats. Each request takes from tens of
seconds to a few minutes on a laptop.

## How it is wired

- Tools: `McpToolSource` from `@kaleidorg/mind/mcp`, limited with `allow` to the tools named by the RGB and trading skills. The mock binds the
  canonical wallet contract (`bindWalletTools`) to `MockWallet` handlers.
- Skills: packaged playbooks loaded with `loadSkillsDir(packagedSkillsDir())`;
  the funnel selects the relevant skill for each request.
- Confirmation: `rln_send_asset` is a spend tool, so the `Engine` calls
  `onConfirm`; the prompt text comes from `confirmReadback()`.

kaleido-mcp and the in-app wallet contract name some arguments differently
(`asset_id` / `recipient_id` vs `asset` / `to`); the model always sees the schema
of the tool source it is connected to.

## If something fails

| Symptom | Next step |
|---|---|
| Offline mode fails | Reinstall with the repository's pinned pnpm version and rebuild before debugging a model or node. |
| The model cannot load | Check QVAC's native platform support and available storage/memory. Offline mode should still work. |
| MCP starts but wallet calls fail | Check the node URL, node readiness and unlock state. |
| No send happens | Supply a recipient invoice and approve the prompt; without an invoice the send example is skipped. |

For the generated standalone project, use `npm run …` instead of the repository's
`pnpm …` commands. Neither mock mode nor offline mode sends real funds.
