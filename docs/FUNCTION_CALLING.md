# Function calling

A model proposes a tool name and arguments. Mind validates the call, asks the host
for approval when required, executes the connected handler, and returns its result
to the model. The model itself does not execute wallet operations.

## Request flow

```text
User request
  → provider receives messages and available tool schemas
  → provider returns text and/or proposed calls
  → Engine validates each call
  → host approves tools marked requiresConfirmation
  → ToolRegistry executes the connected source
  → result returns to the model for the next turn
```

The loop stops when the model answers, the run is cancelled, or its configured
limits are reached. Duplicate-call guards and structured tool errors help avoid
repeating failed operations. These controls do not make a payment retry safe:
a timeout can occur after broadcast, so reconcile the operation first.

## Providers

| Provider | Entry point | Host responsibility |
|---|---|---|
| QVAC | `@kaleidorg/mind/qvac` | Load/unload a supported model with tool calling enabled; supply SDK functions |
| OpenAI-compatible | `@kaleidorg/mind/openai` | Configure the endpoint, model and optional credentials |
| Scripted | `@kaleidorg/mind/testing` | Supply planned turns for offline tests |

Use `@qvac/sdk >=0.20.0` for the current QVAC adapter. The implementation is tested
with 0.21.0. The QVAC adapter normalizes tool schemas and model outputs; the Engine
consumes the common [provider interface](../packages/core/src/providers/types.ts).
The host should use these adapters instead of invoking SDK tool handlers directly.

Relevant implementation:

- [QVAC provider](../packages/core/src/qvac/provider.ts)
- [QVAC tool schema conversion](../packages/core/src/qvac/tools.ts)
- [OpenAI-compatible provider](../packages/core/src/providers/openai.ts)
- [Engine](../packages/core/src/engine.ts)

## Tool execution and confirmation

Each tool source supplies a name, description, parameters and confirmation flag.
The registry dispatches to the first registered source owning that name. Avoid
accidental name collisions when combining sources.

`requiresConfirmation: true` makes the Engine await the host's `onConfirm`.
Without a callback, the call is denied. The host renders the resolved operation
and returns an approval or decline; declined calls do not execute. The callback
is an application policy boundary: automatically approving it is not human review.

Mark custom spending, signing and administrative operations explicitly. A name
or schema alone does not describe all possible handler side effects. Read-only
tool discovery is not proof that a wallet is unlocked or a transaction can settle.

MCP and in-process tools may have different argument names. Use their actual
schemas; see [transport compatibility](./ARCHITECTURE.md#contracts-and-transport-compatibility).
Automatic paired-device inference is not implemented.

## Try it

From the repository root:

```bash
pnpm --filter @kaleidorg/example-node-minimal run start:mock
pnpm --filter @kaleidorg/example-rgb-agent run start:offline
```

These commands use scripted responses and simulated tools. The
[RGB example](../examples/rgb-agent/README.md) explains how to add a real local
model and then a signet node.

## Debugging a turn

Check the selected source and schema, the arguments after validation, the
confirmation decision, and the tool result before investigating the final prose.
Use the Engine's `onToolCall` and `onConfirm` callbacks, and keep credentials and
wallet secrets out of logs. The [evaluation guide](./EVALUATION_V3.md) separates
routing, arguments, confirmation, side effects and answer quality.
