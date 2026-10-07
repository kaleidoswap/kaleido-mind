---
name: kaleido-node
description: "Run the RGB Lightning Node process: list environments, start, stop or tear down the Docker stack, check reachability, initialise the wallet once and unlock it after every restart. Use when node calls fail with 'unreachable' or 'wallet locked'."
tools: kaleido_node_list, kaleido_node_up, kaleido_node_ps, kaleido_node_status, kaleido_node_info, kaleido_node_use, kaleido_node_init, kaleido_node_unlock, kaleido_node_lock, kaleido_node_stop, kaleido_node_down, rln_get_node_info, rln_create_utxos
requires-tools: kaleido_node_status
triggers: start node, stop node, node up, node down, unlock, unlock node, lock node, wallet locked, init node, initialise node, initialize node, docker, environment, node status, node unreachable
metadata:
  author: kaleidoswap
  version: "0.2.0"
---
# Kaleido node lifecycle

These tools wrap the `kaleido` CLI on the machine running kaleido-mcp. For
balances, invoices and channels use `rgb-lightning-node`. `name` can be
omitted when only one environment exists.

## Do
- First run: `kaleido_node_up` → `kaleido_node_init` → `kaleido_node_unlock` →
  `rln_create_utxos {}` (needed before issuing or receiving RGB assets).
- After a restart: `kaleido_node_up` if containers are down, then
  `kaleido_node_unlock`.
- Unreachable: `kaleido_node_status`, then up and unlock.
- Ask for the password when it is needed; never store or repeat it.
- `kaleido_node_init` shows the mnemonic once: tell the user to write it down
  offline and never echo it back.
- `up`, `stop`, `down`, `init`, `unlock`, `lock` change the node: confirm
  first. `down` removes containers; volumes stay.

## Examples
- "Is my node running?" → `kaleido_node_status {}`
- "Start my node" → `kaleido_node_up {}`
- "Unlock the node" → `kaleido_node_unlock {"password":"<password from the user>"}`
- "Use the signet environment" → `kaleido_node_use {"name":"signet"}`
