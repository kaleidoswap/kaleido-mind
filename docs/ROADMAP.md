# KaleidoMind roadmap

This page separates current capabilities from proposed work. It is not a release
schedule. See [CHANGELOG.md](../CHANGELOG.md) for released changes and the
[architecture](./ARCHITECTURE.md) for the implementation boundaries.

## Available building blocks

- Engine and tiered funnel, deterministic recipes and skill-scoped tool calling.
- In-process, MCP, CLI and paid-HTTP tool sources.
- QVAC and OpenAI-compatible model providers.
- Confirmation callbacks, mock wallets and scripted providers.
- Node examples, a project starter and the desktop provider sidecar.
- Injected memory/RAG and voice helpers; each host chooses which to enable.

Library support does not mean every host exposes a feature. Check the host's
configuration, package versions and connected tool catalog.

## Current hardening work — unreleased

- Consistent MCP confirmation classification for wallet aliases and node mutations.
- Explicit Spark invoice compatibility in the MCP adapter.
- Cross-package catalog checks in CI.
- In the MCP repository: HTTP session lifecycle and durable submarine funding attempts.

## Proposed next work

| Work | User outcome | Completion evidence |
|---|---|---|
| Shared versioned tool contracts | Fewer name, schema and unit differences across adapters | The same behavioral tests pass against each adapter |
| A diagnostic command | Understand missing tools, incompatible versions and node readiness | Useful diagnosis from a clean machine and broken-config fixtures |
| Persistent operation recovery | Resume or reconcile interrupted operations | Crash/restart and ambiguous-broadcast tests; explicit refund workflow |
| Capability profiles | Expose only the wallet, trading or administration tools needed | Host tests for each profile and its approval policy |
| Packaged-host testing | Catch failures hidden by developer workspaces | Install-and-run tests against packaged applications |
| Request traces | Explain route, calls, confirmations and failures | Redacted traces that let a developer reproduce an issue |

## Model and runtime work

Measure correctness and latency together on representative devices. Keep offline
logic tests separate from real-model evaluations; a passing mock run does not
measure model quality. See [BENCHMARK.md](./BENCHMARK.md).

Automatic paired-device inference is not implemented. A custom host can already
use an OpenAI-compatible endpoint. Any future pairing feature needs a separate
transport, authentication and UX design before it appears in setup guides.
