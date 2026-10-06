---
name: kaleido-node
description: "Run the RGB Lightning Node itself: list environments, start/stop/tear down the Docker stack, check reachability, initialise the wallet once, unlock it after every restart, and recover from a down or locked node. Triggers when the user wants to start, stop, unlock or set up their node, or when node calls fail with 'unreachable' or 'wallet locked'. Uses kaleido-mcp's kaleido_node_* tools (or the kaleido CLI)."
tools: kaleido_node_list, kaleido_node_up, kaleido_node_ps, kaleido_node_status, kaleido_node_info, kaleido_node_use, kaleido_node_init, kaleido_node_unlock, kaleido_node_lock, kaleido_node_stop, kaleido_node_down, rln_get_node_info, rln_create_utxos
triggers: start node, stop node, start my node, stop my node, node up, node down, unlock, unlock node, lock node, wallet locked, init node, initialise node, initialize node, docker, environment, node status, node unreachable, mnemonic, seed phrase
metadata:
  author: kaleidoswap
  version: "0.1.0"
---

# Kaleido node lifecycle

Operate the node process, not the wallet. For balances, invoices, payments and
channels use the `rgb-lightning-node` skill.

These tools come from kaleido-mcp and wrap the `kaleido` CLI, which must be
installed on the machine running the MCP server. In-app wallets don't have
them. If a tool is not in your list, say what the user should run instead
(CLI column below).

## Tools

| Step | MCP tool | CLI equivalent |
|---|---|---|
| List environments | `kaleido_node_list()` | `kaleido --json --agent node list` |
| Start | `kaleido_node_up({ name? })` | `kaleido --agent node up <NAME>` |
| Container status | `kaleido_node_ps({ name? })` | `kaleido --agent node ps <NAME>` |
| Reachability | `kaleido_node_status()` | `kaleido --json --agent node info` |
| Node + network info | `kaleido_node_info()` | `kaleido --json --agent node info` |
| Select active node | `kaleido_node_use({ name, node? })` | — |
| First-time wallet init | `kaleido_node_init({ password, mnemonic? })` | `kaleido --agent node init` |
| Unlock after restart | `kaleido_node_unlock({ password, announce_alias?, announce_address? })` | `kaleido --agent node unlock <PASSWORD>` |
| Lock | `kaleido_node_lock()` | — |
| Stop (keep data) | `kaleido_node_stop({ name? })` | `kaleido --agent node stop <NAME>` |
| Tear down (keep volumes) | `kaleido_node_down({ name? })` | `kaleido --agent node down <NAME>` |

`name` can be omitted when only one environment exists.

## Flows

- **First run:** `kaleido_node_up` → `kaleido_node_init` → `kaleido_node_unlock`
  → create colored UTXOs (`rln_create_utxos`, or
  `kaleido --agent wallet create-utxos`). Until UTXOs exist, issuing or
  receiving RGB assets fails.
- **After a restart:** `kaleido_node_up` (if containers are down) →
  `kaleido_node_unlock`. Unlock is needed after every restart.
- **Node unreachable** (`rln_get_node_info` fails): `kaleido_node_status`, then
  `kaleido_node_up` and `kaleido_node_unlock`.
- **"wallet locked" errors:** `kaleido_node_unlock`.
- **Stuck pending RGB transfers:** `kaleido --json asset fail-transfers` marks
  them failed (CLI only).

## Safety

1. **Passwords:** ask the user for the password at the moment it is needed.
   Never store, repeat or log it.
2. **Mnemonic:** `kaleido_node_init` shows the seed phrase once. Tell the user
   to write it down offline before continuing. It cannot be recovered.
   Never paste it back into the chat.
3. **State changes need a yes:** `up`, `stop`, `down`, `init`, `unlock` and
   `lock` change the node; confirm first. `down` removes containers (volumes
   stay); say so.
4. **Dry run:** describe the steps only; call no state-changing tool.
