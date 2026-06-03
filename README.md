# kaleido-mind

> Sovereign AI for sovereign money. A local-first agent for Bitcoin, Lightning and RGB — voice-first, L402-native, fully private. Runs on your phone and laptop, never in someone else's cloud.

Built for the [QVAC Hackathon](https://dorahacks.io/hackathon/qvac-unleach-edge-ai-i/) by the [KaleidoSwap](https://kaleidoswap.com) team.

---

## What this is

`kaleido-mind` is the reasoning + function-calling engine that powers KaleidoSwap's local-first AI experience across:

- 📱 **`rate`** — React Native mobile wallet (Mobile track)
- 💻 **`kaleido-agent`** — Node.js desktop co-processor (General Purpose track)
- 🌐 **`rate-extension`** — browser extension (delegation only)
- 🐍 **`kaleido-cli`** — Python CLI (HTTP client)

All inference goes through the [QVAC SDK](https://www.npmjs.com/package/@qvac/sdk). No cloud calls. No API keys.

## Repo layout

```
kaleido-mind/
├── packages/
│   ├── core/                  @kaleido/mind  — engine, providers, tools, logger
│   ├── tools-kaleido/         @kaleido/mind-tools-kaleido — BTC / LN / RGB tools
│   ├── server/                @kaleido/mind-server — HTTP + MCP daemon
│   ├── client-ts/             @kaleido/mind-client — typed HTTP client
│   ├── adapter-react-native/  @kaleido/mind-rn — Expo/RN adapter
│   └── adapter-browser/       @kaleido/mind-browser — extension adapter
├── apps/
│   └── playground/            CLI for testing without rate/extension/agent
├── python/
│   └── kaleido_mind/          Python bridge for kaleido-cli
└── docs/
    ├── ARCHITECTURE.md
    ├── MODEL_MANAGEMENT.md    # UX spec for the rate model picker
    ├── BENCHMARK.md           # Function-calling bench harness
    └── LOGGING.md             # Log schema & fine-tune export
```

## Quickstart (once published)

```bash
pnpm install
pnpm build
pnpm play "what's my BTC balance?"
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
