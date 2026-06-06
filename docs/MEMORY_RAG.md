# Memory, RAG & Context

How `@kaleidorg/mind` gives an agent a **soul**, **long-term memory**, **RAG**,
and a **hardware-aware context budget** — while staying pure-TS and zero-dep
(everything heavy is injected by the host, so it still bundles in Bare/RN).

## The four tool mechanisms

An agent reaches tools four ways; all are `ToolSource`s in one `ToolRegistry`:

| Mechanism | Source | Runs on | Use for |
|---|---|---|---|
| **Function calling** | `InProcessToolSource` | device (RN/Node) | on-device wallet ops — keys never leave |
| **MCP** | `McpToolSource` (`/mcp`) | Node | kaleido-mcp, Bitrefill, any MCP server |
| **Skills + CLI** | `SkillRegistry` + `createCliToolSource` | Node | documented CLI paths (`kaleido`, `@bitrefill/cli`) |
| **Knowledge / memory** | `createRagToolSource`, `createMemoryToolSource` | device/Node | recall + retrieval |

```ts
new ToolRegistry([
  walletTools,                       // function calling (in-process)
  kaleidoMcp,                        // MCP
  createCliToolSource({ runner, allow: ['kaleido'] }),   // CLI
  createMemoryToolSource(memory),    // remember / recall
  createRagToolSource(retriever),    // search_knowledge
])
```

## Memory — soul + recall

Two layers, mirroring nanobot's SOUL/AGENTS/memory split:

- **`AgentProfile`** — static identity, composed into every system prompt:
  ```ts
  const profile: AgentProfile = {
    name: 'KaleidoMind',
    soul: 'A sovereign, local-first Bitcoin assistant. Calm, precise, private.',
    instructions: 'Never reveal seeds. Confirm spends.',
  }
  ```
- **`MemoryStore`** — durable facts/preferences/events. `InMemoryMemoryStore`
  is the default; inject `MemoryIO` to persist (AsyncStorage on RN, fs on Node),
  and an `embed` fn for semantic recall:
  ```ts
  const memory = new InMemoryMemoryStore({ io, embed: (t) => embeddings.embed([t]).then(v => v[0]) })
  ```
  The agent uses it via the `remember` / `recall` tools, and the
  `ContextBuilder` auto-recalls the most relevant items each turn.

## RAG — injected embeddings + vector store

```ts
const retriever = new Retriever({ embeddings, /* store, chunkSize, chunkOverlap */ })
await retriever.ingest([{ id: 'faq', text: longMarkdown }])      // chunk → embed → index
const hits = await retriever.search('how do channels work', 4)   // embed → top-k
```

- `EmbeddingProvider` is injected — on QVAC it wraps the SDK `embed()`:
  ```ts
  const embeddings: EmbeddingProvider = {
    dimension: 768,
    embed: (texts) => qvac.embed({ modelId, texts }),   // host SDK call
  }
  ```
- `InMemoryVectorStore` is pure-JS cosine (good for thousands of chunks); swap a
  native/SQLite `VectorStore` for more. Persist via `VectorStoreIO`.
- Prefer the **`search_knowledge` tool** (agentic RAG) over always-injecting —
  it saves the small-model context window. Use auto-inject (`topKRag > 0`) only
  on roomy models.

## Context budget — the hardware-aware part

Small models have small windows; memory + skills + RAG + tool schemas all
compete for them. `ContextBuilder` assembles the system prompt in priority
order — **identity → instructions → skill → memory → knowledge** — and trims to
a token budget so it never overflows:

```ts
const builder = new ContextBuilder({ profile, memory, retriever, budgetTokens, topKMemory, topKRag })
const { system } = await builder.build({ query: userText, skillSystem })   // from SkillRegistry.compose
const res = await engine.runAgentic([{ role:'user', content: userText }], { allowedTools })
//                       ^ pass `system` as the engine's defaultSystem / first message
```

Budget math (`contextBudgetTokens(ctxSize)`) reserves room for the reply, tool
schemas, and the conversation, leaving the rest for injected context.

## Capability profiling — what to turn on

One call decides features from device RAM + the model's context window:

```ts
const caps = capabilityProfile({ ramBytes, modelCtxTokens: 2048, hasEmbeddings, delegated })
// → { memory, semanticMemory, rag, contextBudgetTokens, topKMemory, topKRag }
```

Rules of thumb:

| Device / model | memory | semantic recall | RAG |
|---|---|---|---|
| 2 GB phone, 0.6B @ 2k ctx | ✅ | only w/ embeddings | ❌ (too tight) |
| 6 GB+ phone, 1.7–4B @ 4k+ | ✅ | ✅ | ✅ if embeddings |
| Desktop / **delegated** | ✅ | ✅ | ✅ |

Wire the result straight into the `ContextBuilder` (`budgetTokens`,
`topKMemory`, `topKRag`) and gate whether you build a `Retriever` at all.

## Putting it together (host)

```ts
const caps = capabilityProfile({ ramBytes, modelCtxTokens, hasEmbeddings: !!embeddings, delegated })
const memory = new InMemoryMemoryStore({ io, embed: caps.semanticMemory ? embedOne : undefined })
const retriever = caps.rag ? new Retriever({ embeddings }) : undefined
const builder = new ContextBuilder({
  profile, memory, retriever,
  budgetTokens: caps.contextBudgetTokens, topKMemory: caps.topKMemory, topKRag: caps.topKRag,
})

// per turn:
const skill = skills.select(text)
const { system: skillSystem, allowedTools } = skills.compose('', skill)
const { system } = await builder.build({ query: text, skillSystem })
const engine = new Engine({ provider, tools, defaultSystem: system })
const res = await engine.runAgentic([{ role: 'user', content: text }], { allowedTools })
```

One brain that remembers, retrieves, and right-sizes itself to the device.
