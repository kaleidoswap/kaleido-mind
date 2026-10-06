# Integrating `@kaleidorg/mind` into a host

`@kaleidorg/mind` is a pure-TypeScript library: the `Engine` (agentic loop),
the `Funnel` (fast path → recipe → agent), `ToolRegistry` + `ToolSource`s
(in-process, MCP, CLI, L402), `SkillRegistry`, and an **injected**
`LLMProvider`. It does nothing on its own; a *host* instantiates it with a
provider, tool sources and a confirm handler.

```
        ┌──────────────────── @kaleidorg/mind (library) ─────────────────────┐
        │  Funnel / Engine · ToolRegistry · ToolSource (InProcess/MCP/CLI/L402)│
        │  SkillRegistry (loadSkillsDir / bundle) · injected LLMProvider       │
        └─────────────────────────────────────────────────────────────────────┘
              ▲ runs inside                         ▲ runs inside
      ┌──────────────────┐                ┌──────────────────────────┐
      │  mobile (RN)     │                │  desktop / Node          │
      │  QVAC on-device  │                │  QVAC in a Node sidecar  │
      │  in-process tools│                │  MCP + CLI tool sources  │
      │  bundled skills  │                │  skills from disk        │
      └──────────────────┘                └──────────────────────────┘
```

## Existing hosts

| Host | LLM | Tools | Skills |
|---|---|---|---|
| [Rate](https://github.com/kaleidoswap/Rate) (React Native) | QVAC on-device | in-process wallet tools (`bindWalletTools` shape) + L402 | bundled `skills.bundle.json` |
| [desktop-app](https://github.com/kaleidoswap/desktop-app) (Tauri) | QVAC in the `@kaleidorg/mind-provider` sidecar | kaleido-mcp + Bitrefill MCP + skill references | `loadSkillsDir` |
| `apps/cli`, `apps/playground`, `examples/*` | QVAC in Node, or `scriptedProvider` | in-process, HTTP-backed or MCP | `loadSkillsDir` |

## What a host provides

1. **An `LLMProvider`.** For QVAC, `createQvacProvider` from
   `@kaleidorg/mind/qvac`, given the SDK's `completion` / `cancel` and a
   `getModelId()` for the loaded model. The host owns the model lifecycle
   (download, load, unload, GPU fallback); `LOCAL_LLM_CONFIG` /
   `LOCAL_LLM_CONFIG_GPU` are sensible starting points.
2. **Tool sources.** Bind the contracts below to your own handlers, or connect
   an MCP server with `McpToolSource` (Node only). Merge them in one
   `ToolRegistry`.
3. **Skills.** `loadSkillsDir(packagedSkillsDir())` on Node; on React Native,
   run `scripts/bundle-skills.mjs` at build time and load the JSON with
   `skillsFromBundle()`.
4. **A confirm handler.** `onConfirm(call)` is called before every
   `requiresConfirmation` tool. Show `confirmReadback(call)` and return
   `{ approved }`. Without a handler the gate fails closed.

## Platform notes

- **React Native:** import only `@kaleidorg/mind`, `/qvac`, `/testing` and
  `/logger`. `/mcp` and `/skills` use Node APIs (subprocesses, fs).
- **Desktop sidecar:** `@kaleidorg/mind-provider` speaks a line-delimited
  JSON protocol over stdio: commands on stdin, events on stdout (see
  `apps/provider/src/protocol.ts`). It loads the
  model, skills and MCP servers configured by the host and streams chat events
  back.
- **Delegated inference:** with `@qvac/sdk` 0.13–0.18 a phone can delegate
  inference to a paired desktop (`buildDelegateConfig`, `allowListFirewall`).
  QVAC 0.19 removed the P2P provider API; on newer SDKs hosts run inference
  locally.

## Binding tool contracts (the host side)

Core declares three contracts as pure data + a binder factory. The host injects
the handlers; the mind never reaches the network. Same pattern across all three.

```ts
// Mobile (rate) — WDK adapters
import {
  bindWalletTools,
  bindKaleidoswapTools,
  bindLsps1Tools,
  createBtcMapToolSource,
  ToolRegistry,
} from '@kaleidorg/mind';

const wallet = bindWalletTools({
  get_balances:   async () => protocolManager.totals(),
  send_payment:   async ({ to, amount_sats }) => router.send(to, amount_sats),
  // …one handler per WALLET_TOOLS entry
});

const kswap = bindKaleidoswapTools({
  kaleidoswap_get_quote: async (a) => swapProtocol.quote(a),
  kaleidoswap_place_order: async ({ quote_id }) => swapProtocol.placeOrder({ quoteId: quote_id }),
  kaleidoswap_atomic_init: async (a) => swapProtocol.atomicInit(a),
  // …one handler per KALEIDOSWAP_TOOLS entry
});

const lsp = bindLsps1Tools({
  lsp_get_info:     async () => lspClient.getInfo(),
  lsp_create_order: async (a) => lspClient.createOrder(a),
  // …one handler per LSPS1_TOOLS entry
});

const merchants = createBtcMapToolSource({
  location: { getCurrent: getUserLocation, geocode: geocodeAddress },
  fetch:    findNearbyMerchants,           // host wraps api.btcmap.org
  offlineMerchants: LUGANO_OFFLINE,        // bundled fallback
});

const tools = new ToolRegistry([wallet, kswap, lsp, merchants /*, memory, rag, l402*/]);
```

```ts
// Desktop / CLI / playground — fetch over HTTP
function fetchHandlers<Map extends Record<string, { method: 'GET'|'POST'; path: string }>>(
  baseUrl: string, routes: Map,
) {
  const handlers: Record<string, (a: any) => Promise<unknown>> = {};
  for (const [name, route] of Object.entries(routes)) {
    handlers[name] = async (args) => {
      const url = new URL(baseUrl + route.path);
      if (route.method === 'GET') {
        for (const [k, v] of Object.entries(args ?? {})) if (v != null) url.searchParams.set(k, String(v));
      }
      const res = await fetch(url.toString(), {
        method: route.method,
        headers: { 'content-type': 'application/json' },
        ...(route.method === 'POST' ? { body: JSON.stringify(args ?? {}) } : {}),
      });
      if (!res.ok) throw new Error(`${name} failed: ${res.status}`);
      return res.json();
    };
  }
  return handlers;
}
// Concrete example in apps/cli/src/kaleidoswapTools.ts +
// apps/cli/src/lsps1Tools.ts.
```

The contract files (`wallet/contract.ts`, `kaleidoswap/contract.ts`,
`lsps1/contract.ts`) carry the spend flags; binders preserve them, so the
Engine and recipe runner both pause for `onConfirm` on the same tools no
matter which host is running.
