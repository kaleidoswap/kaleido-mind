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

### Consolidation — no-bloat memory (the one good `mem0` idea, kept sovereign)

Append-only memory drifts toward near-duplicates ("user likes EUR" ×5). Pass a
`consolidate` option to fold same-kind near-dups into one item. Two tiers, both
zero-dep — we deliberately did **not** add the `mem0` dependency (cloud /
OpenAI-coupled / won't bundle in RN); we ported only its useful behaviour:

- **Dedup** (embedding-only, *zero inference*) — a near-dup is detected by cosine
  similarity and the newer item supersedes the older. Cheap enough for a 0.6B
  phone, so it's on for **Mobile** too.
- **Merge** (optional, injected LLM) — set `consolidate.merge` to rewrite old +
  new into one consolidated fact. Costs an extra inference, so reserve it for
  **desktop / P2P-delegated** devices.

```ts
const merge = async (existing: string, incoming: string) =>
  (await completeOnQvac(`Merge into one short fact:\n- ${existing}\n- ${incoming}`)).trim()

const memory = new InMemoryMemoryStore({
  io,
  embed: caps.semanticMemory ? embedOne : undefined,
  consolidate: caps.dedupeMemory
    ? { threshold: 0.92, merge: caps.mergeMemory ? merge : undefined }  // merge only when capable
    : undefined,
})
```

`capabilityProfile` decides the tiers for you: `dedupeMemory` (≈ semanticMemory)
and `mergeMemory` (delegated, or ≥4 GB RAM @ ≥4k ctx). Omit `consolidate`
entirely for the original append-only behaviour.

## RAG — injected embeddings + vector store

```ts
const retriever = new Retriever({ embeddings, /* store, chunkSize, chunkOverlap */ })
await retriever.ingest([{ id: 'faq', text: longMarkdown }])      // chunk → embed → index
const hits = await retriever.search('how do channels work', 4)   // embed → top-k
```

- `EmbeddingProvider` is injected — on QVAC it wraps the SDK `embed()`
  (the hackathon mandates that RAG runs through the QVAC SDK):
  ```ts
  const embedModelId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelType: 'embeddings' })
  const embeddings: EmbeddingProvider = {
    dimension: 1024,                                 // GTE_LARGE_FP16
    async embed(texts) {
      const out: number[][] = []
      for (const text of texts) {
        const { embedding } = await embed({ modelId: embedModelId, text })  // QVAC, on-device
        out.push(embedding)
      }
      return out
    },
  }
  ```
  QVAC ships the embedder + the `ragChunk()` / `ragIngest()` / `ragSearch()`
  workflow but **not** a vector store ("bring your own DB") — so `Retriever` +
  `InMemoryVectorStore` (or a SQLite/native `VectorStore`) is exactly the
  intended pattern, with QVAC providing the vectors. A runnable end-to-end
  proof lives at `apps/playground/src/rag-demo.ts`.
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

## What to RAG (KaleidoMind, for the hackathon)

QVAC RAG is fully on-device (`embed` + `ragSearch`), so the corpora are things
that are useful *and* private:

| Corpus | The experience | Track fit |
|---|---|---|
| **Bitcoin / Lightning / RGB + KaleidoSwap docs** (BOLT specs, RGB, FAQs, glossary, app help, skill `references/`) | A private **Bitcoin copilot**: "I can send but not receive — what do I do?", "what's a submarine swap?", "explain this error" — answered offline | Mobile (personal tutor), General Purpose (advanced RAG over a large collection) |
| **Your own wallet history + contacts + notes** | A **personal finance knowledge base**: "what did I spend on coffee last month?", "who did I pay 50k sats to?", "summarise my swaps" — never leaves the device | Mobile / General Purpose (privacy-first, personal knowledge base) |
| **Merchant directory** (e.g. the Lugano dataset) | "where can I spend BTC near me for lunch?" (pairs well with the live `find_merchant_locations` tool + updated merchant-finder skill that lets the model interpret natural queries) | Mobile (travel assistant) |
| **Skill reference docs** | the model pulls the right CLI/MCP instructions on demand instead of holding all 60 tools in context | internal — multi-agent tool use |
| *(Psy track, separate product)* **personal health records + MedPsy** | a private on-device health assistant | Psy / Mobile |

**Recommended for our submission:** the **Bitcoin copilot** (docs RAG) + the
**personal wallet knowledge base** — they extend the locked hero flow (the
on-device agentic wallet that now also *knows things* and *remembers you*),
hit Mobile + General Purpose, and showcase privacy.

All three corpora ship as ready-to-ingest building blocks (zero-dep, RN-safe —
feed straight into `Retriever.ingest()`):

```ts
import {
  BITCOIN_COPILOT_DOCS,          // Bitcoin/Lightning/RGB/KaleidoSwap knowledge pack
  walletHistoryToDocuments,      // personal wallet knowledge (tx history → docs)
  contactsToDocuments,
  merchantsToDocuments,          // BTC map discovery (merchant directory → docs)
} from '@kaleidorg/mind'

await retriever.ingest(BITCOIN_COPILOT_DOCS)
await retriever.ingest(walletHistoryToDocuments(txs))
await retriever.ingest(merchantsToDocuments(places))
```

### Embedding model vs. track (hardware)

`GTE_LARGE_FP16` is 1024-dim (~670 MB) — fine on a flagship phone or a ≤32 GB
workstation, too heavy for a 4 GB Pi. Use `capabilityProfile` to gate it:

| Track / device | Embedding model | RAG |
|---|---|---|
| **General Purpose** (≤32 GB laptop/desktop) | `GTE_LARGE_FP16` (1024-d) | full corpus |
| **Mobile** (flagship phone) | `GTE_LARGE_FP16`, or a small gguf (`gte-small`/`bge-small`, ~30–130 MB) | docs subset |
| **Tinkerer** (≤4 GB Pi) | a tiny gguf embedder, or **delegate embeddings to a desktop over P2P** | small / delegated |

The P2P angle is a focus area in its own right: a **phone/Pi queries while a
32 GB workstation does the embeddings + RAG over P2P** — the workstation is then
the "main" device (General Purpose), and you've shown real-time local inference
+ P2P load distribution. `capabilityProfile({ delegated: true })` flips RAG on
regardless of the edge device's RAM.
