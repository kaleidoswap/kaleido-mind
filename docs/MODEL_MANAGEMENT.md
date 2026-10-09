# Model management

The host application manages model downloads, selection and lifetime. Mind
receives an `LLMProvider`; it does not install a model or create a settings screen
on its own.

## Choose a provider

| Need | Provider | Setup |
|---|---|---|
| Verify application wiring without inference | Scripted provider | `@kaleidorg/mind/testing`; no model download |
| Run inference on the user's device | QVAC provider | `@qvac/sdk >=0.20.0`, tested with 0.21.0 |
| Use an existing model server | OpenAI-compatible provider | `@kaleidorg/mind/openai`; configure endpoint and model name |

Start with the [offline example](../examples/rgb-agent/README.md), then choose
inference. The [core package README](../packages/core/README.md#models) maintains
the model table and approximate memory/download budgets. Do not duplicate those
values in host setup screens; the exported catalog lives in
[models.ts](../packages/core/src/qvac/models.ts).

## QVAC lifecycle

1. Let the user select a model appropriate to their available memory and storage.
2. Load it with the QVAC SDK. The first load may download weights.
3. Create the Mind provider with the SDK functions and the loaded model ID.
4. Show loading, ready, running and failed states separately.
5. Cancel active work before switching models; unload the old model and close the
   runtime when the host no longer needs it.

The [quickstart](../packages/core/README.md#quickstart-5-minutes) contains the
concrete SDK calls. Model availability and native runtime support depend on the
host platform. A successful TypeScript build does not verify a native model load.

## What a useful settings screen should show

These are host UX recommendations, not a screen supplied by this library:

- Selected provider and model, with downloaded size and available storage.
- Download/loading progress, cancellation and an actionable failure message.
- Whether requests use local inference or the configured remote endpoint.
- Connected wallet tools and their readiness, separately from model readiness.
- A small read-only test request with elapsed time and the tool actually used.

Never infer model quality from download size alone. Use the
[product evaluation](./EVALUATION_V3.md) to measure correctness, confirmations and
latency on the target hardware.

## Remote inference

A custom host can configure an OpenAI-compatible server. This is an explicit
provider choice: requests and tool results may be sent to that endpoint.
Automatic pairing, desktop discovery and phone-to-desktop failover are not
implemented. Historical pairing plans are available in Git history; they are
not installation instructions.
