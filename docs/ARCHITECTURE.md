# KaleidoMind architecture

KaleidoMind is the agent engine. The host application supplies a model provider,
tool connections, storage and the user interface. Kaleido MCP is a separate
server that exposes wallet and trading operations to Mind or another MCP client.

## Components and responsibilities

| Component | Responsibility | Entry point |
|---|---|---|
| `Funnel` | Route a request to a fast path, recipe or agentic loop | [funnel.ts](../packages/core/src/funnel.ts) |
| `Engine` | Run model/tool turns and request confirmation for classified tools | [engine.ts](../packages/core/src/engine.ts) |
| `ToolRegistry` | Discover tools and dispatch calls to their source | [registry.ts](../packages/core/src/tools/registry.ts) |
| `SkillRegistry` | Select playbooks and limit the tools shown to the model | [registry.ts](../packages/core/src/skills/registry.ts) |
| Model provider | Perform inference; the host owns model loading and unloading | [Provider interface](../packages/core/src/providers/types.ts) |
| Host | Display confirmations, manage credentials and select available capabilities | [Integration guide](./INTEGRATION.md) |

```text
Host: user interface, configuration, confirmation callback
  └─ Funnel
       ├─ fast path: deterministic reads
       ├─ recipe: predefined steps with resolved arguments
       └─ Engine: model → tool → model
            └─ ToolRegistry
                 ├─ in-process wallet handlers
                 ├─ MCP client → kaleido-mcp → wallet / node / maker
                 └─ CLI or paid-HTTP source
```

A fast path avoids inference. Recipes reduce planning work for small models.
Other requests use the agentic loop with a skill-scoped tool list. See
[function calling](./FUNCTION_CALLING.md) for provider details.

## Contracts and transport compatibility

Core defines in-process wallet and domain contracts. MCP discovers the names and
JSON schemas supplied by the connected server. These are separate implementations;
MCP does not import a shared contract package from Mind today.

Do not assume that a tool's arguments are identical across hosts. For example,
RGB integrations may use `asset_id` / `recipient_id` or an adapter's `asset` / `to`.
Use the discovered schema and test the actual adapter your host exposes.

The next Mind release normalizes Kaleido MCP's Spark invoice collision:

| Mind name | Kaleido MCP wire operation |
|---|---|
| `spark_pay_invoice` | `spark_pay_lightning_invoice` — BOLT11 |
| `spark_pay_spark_invoice` | Spark invoice payment — `invoices[]` |

This normalization applies to `McpToolSource`, not raw MCP clients. See the
[package integration guide](../packages/core/README.md#connecting-an-mcp-server)
for filtering and unsupported amount overrides. CI checks a pinned MCP release's
catalog and confirmation classifications without sending funds.

## Confirmation boundary

Tools marked `requiresConfirmation` are denied if the host supplies no
`onConfirm` callback. The host decides whether to approve; an auto-approving host
removes the human review step. Custom tools must declare their risk explicitly.

Recipes also gate classified intermediate operations. The engine does not infer
arbitrary handler side effects, replace wallet authorization, or provide a
transaction rollback mechanism. Raw MCP clients must provide their own approvals.

## Host integrations

| Host | Integration |
|---|---|
| Rate | In-process wallet adapters and local QVAC inference |
| Desktop app | Provider sidecar → Mind → a filtered Kaleido MCP catalog |
| Examples and tests | Scripted providers and fake wallets, or an explicitly configured live node |
| KaleidoAgent | Separate runtime; reuses Mind skill playbooks rather than its Engine |

The library's supported providers are broader than any individual application's
settings. `@kaleidorg/mind/openai` can connect a custom host to an OpenAI-compatible
server. Automatic phone/desktop pairing is not a current capability.

## Other subsystems

- [Memory and RAG](./MEMORY_RAG.md): injected storage and embeddings.
- [Model management](./MODEL_MANAGEMENT.md): runtime requirements and host responsibilities.
- [Product evaluation](./EVALUATION_V3.md): route, arguments, confirmation and side effects.
- [Roadmap](./ROADMAP.md): work proposed beyond the current implementation.
