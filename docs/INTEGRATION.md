# Integration Architecture — one brain, many hosts

How `@kaleidorg/mind`, `kaleido-agent`, `rate`, and `desktop-app` fit together,
and how to converge them.

## TL;DR

- **`@kaleidorg/mind` is the portable brain** — a pure-TS library: `Engine`
  (the agentic loop), `ToolRegistry` + `ToolSource`s (InProcess / L402 / MCP),
  `SkillRegistry`, and an *injected* `LLMProvider`. It runs nowhere by itself.
- **Everything else is a host** that instantiates the Engine with a provider +
  tool sources: `rate` (React Native, on-device QVAC), the `desktop-app` Node
  **sidecar** (`apps/provider`), and `kaleido-agent` (a Node server).
- **`kaleido-agent` does not use the brain today.** It has its own `AIProvider`
  and its own multi-turn loop in `agent-runner.ts` — functionally a second copy
  of `Engine.runAgentic`. Collapsing that duplication is step 1.
- **Two integration shapes:** (A) *share the brain* — make every host run the
  same `Engine`; (B) *embed the agent as a service* — call the always-on
  `kaleido-agent` over its `127.0.0.1:4242` HTTP API or over P2P. They compose.

```
        ┌──────────────────── @kaleidorg/mind (LIBRARY) ────────────────────┐
        │  Engine.runAgentic · ToolRegistry · ToolSource (InProcess/L402/MCP)│
        │  SkillRegistry (loadSkillsDir / bundle) · injected LLMProvider     │
        └───────────────────────────────────────────────────────────────────┘
              ▲ runs inside          ▲ runs inside             ▲ runs inside
          ┌─────────┐         ┌──────────────────┐      ┌────────────────────┐
          │  rate   │         │   desktop-app    │      │   kaleido-agent    │
          │ RN host │         │ Tauri + Node     │      │ Node server: loop  │
          │ on-dev  │         │ sidecar host     │      │ + nanobot + cron   │
          │ QVAC    │         │ (apps/provider)  │      │ + telegram + :4242 │
          └─────────┘         └──────────────────┘      └────────────────────┘
```

## Current state

| Surface | Uses `@kaleidorg/mind`? | LLM | Tools | Skills |
|---|---|---|---|---|
| `rate` (mobile) | ✅ `Engine` + skills + L402 | QVAC on-device / delegated | InProcess wallet tools | bundled SKILL.md |
| `desktop-app` | ✅ via `apps/provider` sidecar | QVAC (local) | kaleido-mcp + bitrefill MCP + skill refs | `loadSkillsDir` |
| `kaleido-agent` | ❌ own loop | anthropic / openai / qvac | own `McpManager` (kaleido-mcp) | own `skill-loader` (`!cmd` injection) |

The `kaleido-agent` loop and `Engine.runAgentic` are the same idea twice:

```
agent-runner.ts                         @kaleidorg/mind Engine
─────────────────                       ──────────────────────
provider.runTurn(sys, tools, msgs)  ≈   provider.runTurn(TurnInput)
mcp.getToolsByNames(allowed)        ≈   ToolRegistry + allowedTools
mcp.callTool(name, input)           ≈   ToolSource.execute(name, args)
loop until stop_reason==end_turn    ≈   runAgentic multi-turn loop
```

---

## Pattern A — use `kaleido-mind` *inside* `kaleido-agent`

Goal: make the brain shared so skills / L402 / tool routing are authored once.
`kaleido-agent` keeps everything that makes it an agent *server* (nanobot, cron,
telegram, `:4242`); only its reasoning core changes.

### Steps

1. **Add the dependency** in `kaleido-agent/package.json`:
   ```jsonc
   "@kaleidorg/mind": "workspace:*"   // or "file:../kaleido-mind/packages/core"
   ```

2. **Adapt the existing provider to mind's `LLMProvider`.** `kaleido-agent`'s
   `AIProvider` manages provider-native message arrays (`initMessages`,
   `appendAssistant`, …); mind's `Engine` owns the message list and calls a
   stateless `runTurn(TurnInput)` per turn. Bridge them:

   ```ts
   import type { LLMProvider, TurnInput, TurnOutput as MindTurn } from '@kaleidorg/mind'
   import type { AIProvider } from './providers/types'

   export function toMindProvider(p: AIProvider, model: string, maxTokens: number): LLMProvider {
     return {
       name: 'kaleido-agent',
       async runTurn(input: TurnInput): Promise<MindTurn> {
         // Build provider-native messages from mind's Message[] each turn.
         const messages = p.initMessages('')            // start empty…
         // …then map input.messages (role/content[/rawContent]) into provider
         //   format via appendAssistant / appendToolResults as appropriate.
         const tools = input.tools.map(t => ({
           name: t.name, description: t.description, inputSchema: t.parameters,
         }))
         const out = await p.runTurn(model, maxTokens, input.system ?? '', tools, messages)
         return {
           text: out.text,
           rawContent: out.text,
           toolCalls: out.tool_calls.map(c => ({ id: c.id, name: c.name, arguments: c.input })),
         }
       },
     }
   }
   ```
   > The only real work is the `Message[] → provider messages` mapping. Keep it
   > in one helper; the Anthropic/OpenAI shapes are close to mind's already.

3. **Expose `McpManager` as a `ToolSource`** (it already lists + calls tools):

   ```ts
   import type { ToolSource } from '@kaleidorg/mind'
   const mcpSource = (mcp: McpManager): ToolSource => ({
     id: 'kaleido',
     listTools: () => mcp.rawTools.map(t => ({ name: t.name, description: t.description, parameters: t.inputSchema })),
     has: (n) => mcp.rawTools.some(t => t.name === n),
     execute: (n, args) => mcp.callTool(n, args),
   })
   ```
   *(Or drop `McpManager` entirely and use mind's `McpToolSource` from
   `@kaleidorg/mind/mcp` — same transport, less code. Migrate later.)*

4. **Replace the loop in `agent-runner.ts`** with `Engine.runAgentic`:

   ```ts
   import { Engine, ToolRegistry, SkillRegistry } from '@kaleidorg/mind'

   const engine = new Engine({
     provider: toMindProvider(provider, model, maxTokens),
     tools: new ToolRegistry([mcpSource(mcp)]),
     defaultSystem: AGENT_SYSTEM_PROMPT,
     defaultMaxTurns: config.maxToolCallsPerRun,
   })
   const res = await engine.runAgentic([{ role: 'user', content: userPrompt }], {
     allowedTools,                        // from the skill's tool list
     onToolCall: (c) => log(`tool ${c.name}`),
   })
   ```

5. **Skills.** Keep `kaleido-agent`'s `skill-loader` for skills that use the
   `!`​`cmd`​`` bash-injection feature (mind's `SkillRegistry` doesn't run shell
   injections). For the rest, you can route with mind's `SkillRegistry`
   (`select` → `compose` → `allowedTools`). Long term: add an injection hook to
   mind's loader and unify. Until then: agent = injection skills; mind = the
   portable SKILL.md skills (bitrefill, kaleido-wallet, kaleido-trading).

### Result
`kaleido-agent` becomes the **server deployment of the shared brain** —
scheduler + telegram + HTTP on top of the *same* `Engine` that `rate` and the
desktop run. The trading "agent" is then a **skill bundle + the kaleido-mcp
ToolSource**, not a separate codebase.

### Risks / notes
- nanobot mode (`agent.mode = "skill"`) runs the loop *inside nanobot*, not in
  `agent-runner.ts`. Pattern A targets the `mcp` mode runner first; converging
  nanobot is a later, larger step (or keep nanobot for cron/telegram and run
  mind for the reasoning).
- The provider message-mapping is the one fiddly bit — unit-test it.

---

## Pattern B — use *the agent as a service* in `rate` / `desktop-app`

The full `kaleido-agent` is a Node, always-on host (nanobot + Docker + cron).
You can't run it inside React Native or the Tauri webview — you **talk to it**.
It already serves `127.0.0.1:4242`: `GET /health`, `GET /status`,
`POST /chat`, `POST /chat/actions/swap`.

### desktop-app (best fit — already spawns Node sidecars)

Two options:

1. **Spawn it as a second sidecar** (mirror `src-tauri/src/mind.rs`): an
   `agent.rs` that runs `kaleido-agent` and a Tauri command that proxies HTTP:
   ```rust
   #[tauri::command]
   async fn agent_request(path: String, body: serde_json::Value) -> Result<serde_json::Value, String> {
     let url = format!("http://127.0.0.1:4242{path}");
     reqwest::Client::new().post(url).json(&body).send().await
       .map_err(|e| e.to_string())?.json().await.map_err(|e| e.to_string())
   }
   ```
   Add an **“Agent” tab** (sibling of the KaleidoMind page) that calls
   `/status` + `/chat`. The desktop drives the autonomous trading agent.

2. **Or don't** — the mind sidecar (`apps/provider`) *already is* an agent
   (skills + kaleido-mcp + bitrefill). Only add the separate `kaleido-agent`
   when you specifically want its **scheduler / telegram / portfolio-loop**.

### rate (RN — cannot host Node)

- **HTTP to a deployed agent.** You already run `kaleido-agent` on the core
  server; point the app at its public endpoint:
  ```ts
  // services/AgentService.ts
  export async function askAgent(prompt: string) {
    const r = await fetch(`${AGENT_URL}/chat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    })
    return r.json()   // ChatResponse — may include a swap action to confirm
  }
  ```
  Use for "ask my always-on agent to rebalance / what's my portfolio doing".
- **Or P2P-delegate** over Hyperswarm (the path already started for QVAC): the
  phone asks, the Node agent executes — no public endpoint needed.
- **Or run the brain on-device** (what `rate` does now). For an embedded agent
  that needs no server, that *is* "the agent inside the app" — minus the
  always-on autonomy.

---

## Per-surface summary

| Want | Do |
|---|---|
| One brain, authored once | **Pattern A**: refactor `agent-runner.ts` onto `Engine` |
| Desktop drives the autonomous trading agent | **Pattern B**: spawn `kaleido-agent` + proxy `:4242`, add an Agent tab |
| Phone asks the always-on agent | **Pattern B**: `rate` → HTTP `/chat` (or P2P delegate) |
| Phone/desktop agent with no server | Run `@kaleidorg/mind` in-host (already done) |

## Recommended sequencing

1. **Pattern A** — converge `kaleido-agent`'s reasoning onto `@kaleidorg/mind`
   (provider adapter + `mcpSource` + swap the `mcp`-mode loop). Foundational;
   makes the trading agent a skill bundle.
2. **Desktop “Agent” tab** (Pattern B option 1) — spawn + proxy `:4242`.
3. **rate `AgentService`** (Pattern B) — HTTP to the deployed agent, with the
   swap-confirmation action surfaced in the chat.
4. Unify skills (add a shell-injection hook to mind's loader) so the agent's
   `skill-loader` can retire.

## What stays unique to each piece

- **`@kaleidorg/mind`**: the loop, tools, skills, providers contract. No I/O,
  no scheduling, no network host.
- **`kaleido-agent`**: scheduling (cron/nanobot), telegram, Docker node mgmt,
  the `:4242` control surface, portfolio policy. The *deployment*.
- **`rate` / `desktop-app`**: the user-facing host — UI, wallet adapters,
  QVAC lifecycle, pairing. They *run* the brain and/or *call* the agent.
