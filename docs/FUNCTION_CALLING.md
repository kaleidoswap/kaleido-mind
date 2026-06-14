# Function Calling — design

How KaleidoMind turns "pay Alice 5000 sats" into a signed Lightning payment, whether the model runs on the phone or on a delegated desktop.

All findings below are verified against `@qvac/sdk@0.12.0` source in `rate/node_modules/@qvac/sdk`.

---

## 1. What the SDK already gives us

QVAC has **native tool calling** — not prompt-tag parsing. Confirmed in `services/QVACService.ts:369`:

```ts
const run = completion({
  modelId: this.llmModelId,
  history: params.messages,
  stream: true,
  tools: toolDefs.length ? toolDefs : undefined,  // Zod-schema tools
});
const final = await run.final;
// final.toolCalls: ToolCallWithCall[]   ← structured, model-extracted
// final.raw.fullText: string            ← raw assistant frame for history push-back
```

Requirements:
- Model loaded with `modelConfig: { tools: true }` (already set in `initializeLLM`).
- Tools defined as `{ name, description, parameters: ZodObject, handler }` (already in `qvacTools.ts`, 8 tools).

### The handler runs on the CONSUMER, always

`utils/tool-helpers.d.ts` → `attachHandlersToToolCalls(toolCalls, handlers)`. The handler map is **client-side**. `call.invoke()` executes the local handler **on the device that called `completion()`** — i.e. the phone — even when inference is delegated to a remote provider.

**This is the security model, and it's free:**

```
┌─────────────────┐   "pay alice 5000"        ┌──────────────────┐
│  iPhone         │ ────────────────────────► │  MacBook (P2P)   │
│  (consumer)     │   tools: [schemas only]   │  Qwen3-30B       │
│                 │ ◄──────────────────────── │  reasons, emits  │
│  keys + wallet  │   tool_call: pay_invoice  │  the tool call   │
│  handler runs   │      {addr, 5000}         └──────────────────┘
│  HERE, signs    │
└─────────────────┘
```

The desktop never sees keys, never signs, never holds the wallet. It only decides *which tool to call with what args*. The phone validates, confirms, signs, broadcasts. **Compromising the desktop cannot drain the wallet.** This is the headline for the hackathon "sovereign AI" narrative.

---

## 2. The gap today: single-shot, no loop

Current `chat()` (`QVACService.ts:343-423`):
1. `completion()` → `final.toolCalls`
2. For each call: if `requiresConfirmation` → return `pending`; else `call.invoke()` → collect result
3. **Return.** The model never sees the tool results.

So the user gets raw tool output rendered by the screen, not a natural-language answer, and the model can't chain (`get_balance` → reason → `pay`). For real agentic behavior we need the **multi-turn loop** the SDK documents in `examples/tools/llamacpp-tools-harmony-multiturn.js`:

```js
for (let turn = 1; turn <= MAX_TURNS; turn++) {
  const final = await completion({ modelId, history, tools, stream: true }).final;
  if (final.toolCalls.length === 0) break;            // model produced its answer
  history.push({ role: 'assistant', content: final.raw.fullText });  // raw frame, NOT .text
  for (const call of final.toolCalls) {
    const result = await execute(call);               // string
    history.push({ role: 'tool', content: result });  // feed result back
  }
}
```

Two non-obvious rules from the SDK:
- Push `final.raw.fullText` (the framed assistant output), **not** the cleaned `text` — the model needs its own framing to anchor the next turn.
- Tool results go as `{ role: 'tool', content: <string> }`. The llamacpp plugin detects `lastMsg.role === 'tool'` and continues the tool chain (`server/.../completion-stream.js:149`).

---

## 3. KaleidoMind-specific design

Wallet tools aren't like weather lookups — some move money. The loop must pause for human approval mid-chain.

### Tool taxonomy (canonical contracts in `packages/core/src/*/contract.ts`)

Three contracts ship in core today; the host binds them to whichever transport
it runs over (WDK on mobile, HTTP on desktop, stubs in eval). The model sees
identical names + schemas everywhere — only `bindXxxTools(handlers)` differs.

| Class | Tools | Confirmation |
|---|---|---|
| **Read — wallet** | `get_balances`, `get_price`, `fiat_to_sats`, `resolve_contact`, `*_get_balance`, `*_get_address`, `rln_list_channels`, `rln_get_node_info` | none — auto-invoke |
| **Write — receive (safe)** | `spark_create_invoice`, `rln_create_ln_invoice`, `rln_create_rgb_invoice` | none — receiving is safe |
| **Write — wallet spend** | `send_payment`, `spark_send`, `rln_pay_invoice`, `rln_send_asset`, `arkade_send` | **required** |
| **Read — merchant** | `find_merchant_locations`, `get_merchant_info` | none |
| **Read — KaleidoSwap** | `kaleidoswap_get_assets`, `kaleidoswap_get_pairs`, `kaleidoswap_get_quote`, `kaleidoswap_get_nodeinfo`, `kaleidoswap_get_order_status`, `kaleidoswap_get_order_history`, `kaleidoswap_atomic_status` | none |
| **Write — KaleidoSwap spend** | `kaleidoswap_place_order`, `kaleidoswap_atomic_init`, `kaleidoswap_atomic_execute` | **required** |
| **Read — LSPS1** | `lsp_get_info`, `lsp_get_network_info`, `lsp_estimate_fees`, `lsp_get_order` | none |
| **Write — LSPS1 spend** | `lsp_create_order` | **required** |
| **Ambient** | `remember`, `recall`, `search_knowledge`, `read_skill_reference`, `fetch_paid_resource` | none (L402 spend is auto-paid under a cap) |

The spend flag lives on the contract (`spend: true` → `requiresConfirmation`),
so the gate is structural — the model can't bypass it by choosing a different
transport.

### The agentic loop with confirmation

```
runAgentic(userMessage):
  history = [system, ...priorTurns, user]
  for turn in 1..MAX_TURNS:
    final = await completion({ history, tools, stream })   # stream tokens to UI
    if final.toolCalls is empty:
        return final answer                                # natural language, done
    history.push({role:'assistant', content: final.raw.fullText})
    for call in final.toolCalls:
        if call is read/safe:
            result = await call.invoke()                   # runs on phone
        else:                                              # money tool
            decision = await onConfirm(call)               # UI shows sheet, awaits user
            if decision.approved:
                result = await call.invoke()
            else:
                result = { declined: true, reason: decision.reason }
        history.push({role:'tool', content: stringify(result)})
  # MAX_TURNS hit → return best-effort text + a "stopped early" note
```

Key properties:
- **Streaming preserved** — tokens stream to the UI on every turn, so the user sees the model think between tool calls.
- **Confirmation is a promise** — `onConfirm(call) → Promise<{approved, reason?}>`. The screen shows the payment sheet and resolves it on tap. The loop awaits, then continues — so after a payment the model *summarizes* ("Sent 5,000 sats to Alice ⚡, your balance is now…").
- **Declines feed back too** — a declined payment becomes a tool result, so the model can react ("No problem, cancelled.") instead of hanging.
- **MAX_TURNS = 5** — backstop against loops. Logged, not silent.
- **Delegation-transparent** — identical code whether local or P2P; `call.invoke()` always runs on the phone.

### Logging (ties into the dataset plan)

Every turn is one `TurnLog` record (see `KALEIDO_MIND_DATASET.md`): the user input, available tool schemas, the model's chosen `tool_call`, the (hashed) result, the confirmation decision, latency. This is the APIGen-MT-compatible corpus we fine-tune on later. The confirmation decision is a free DPO signal (approved = good call, declined = the model misread intent).

---

## 4. Implementation plan

### Phase 1 — engine (non-breaking) ✅ this session
Add `chatAgentic()` to `QVACService` alongside the existing `chat()`:

```ts
async chatAgentic(params: {
  messages: ChatMessage[];
  tools?: QVACTool[];
  maxTurns?: number;                              // default 5
  onToken?: (t: string, turn: number) => void;
  onStart?: (requestId: string) => void;
  onToolCall?: (call: { name; arguments }) => void;       // UI: "calling get_balance…"
  onConfirm?: (call) => Promise<{ approved: boolean; reason?: string }>;
}): Promise<{ text: string; turns: number; toolCalls: ExecutedCall[]; requestId: string }>
```

Leaves `chat()` untouched so the current screen keeps working during migration.

### Phase 2 — screen migration
`AIAssistantScreen` swaps `qvac.service.chat(...)` → `chatAgentic(...)`:
- `onToolCall` → render a "🔧 checking balance…" chip in the message stream
- `onConfirm` → return a promise resolved by the existing `PaymentConfirmationModal`
- final `text` → the assistant's natural-language answer (now reflects tool results)

Removes the current `pending`-tool re-invocation dance (lines 435-449) — the loop handles it inline.

### Phase 3 — richer tools (later)
- Add `swap` tools (BTC↔USDT via maker) once RGB/maker is wired
- Add `open_channel` (LSPS1) as a confirmation tool
- Multi-step demos: "swap 50 USDT to BTC and pay this invoice" → quote → confirm → swap → pay → summarize

---

## 5. Open questions

1. **Per-turn cancel** — `cancelRequest(requestId)` cancels one `completion`. The loop generates a new requestId per turn; the stop button must cancel the *current* turn's id and break the loop. Track the live requestId in the loop.
2. **Context growth** — each turn appends assistant+tool messages. For long chains the history grows; rely on `kvCache` + a turn cap. Summarize/trim if we ever hit ctx limits on small mobile models.
3. **Small-model reliability** — Qwen3-0.6B may mis-call tools. The bench harness (`docs/BENCHMARK.md`) measures tool-selection accuracy; if 0.6B is weak, delegation to the desktop 14B/30B is the answer (and the demo).
4. **Tool errors** — a handler throw becomes `{ error }` fed back; the model should apologize/retry. Cap retries to avoid loops on a persistently failing tool.
