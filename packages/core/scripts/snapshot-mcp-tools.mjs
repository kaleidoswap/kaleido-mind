#!/usr/bin/env node
// Refresh src/skills/mcp-tools.snapshot.json from a built kaleido-mcp checkout.
//
//   git clone https://github.com/kaleidoswap/kaleido-mcp && (cd kaleido-mcp && npm ci && npm run build)
//   node packages/core/scripts/snapshot-mcp-tools.mjs ../kaleido-mcp
//
// Boots kaleido-mcp over stdio with a throwaway test seed (so wallet tools
// register), lists every tool and stores its name, required args and argument
// schema. The skills test checks every skill against this file.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const mcpDir = resolve(process.argv[2] ?? '../kaleido-mcp')
const out = new URL('../src/skills/mcp-tools.snapshot.json', import.meta.url)
const TEST_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

const { listTools } = await import(pathToFileURL(resolve(mcpDir, 'tests/mcp-contract-test-utils.mjs')).href)
const { version } = JSON.parse(await readFile(resolve(mcpDir, 'package.json'), 'utf8'))
const listed = await listTools({
  cwd: mcpDir,
  env: { WDK_SEED: TEST_MNEMONIC, LIQUID_MNEMONIC: TEST_MNEMONIC, SPARK_NETWORK: 'REGTEST' },
})

const firstLine = (s) => String(s ?? '').split(/\n/)[0].trim()
const tools = {}
for (const t of [...listed].sort((a, b) => a.name.localeCompare(b.name))) {
  const props = t.inputSchema?.properties ?? {}
  tools[t.name] = {
    required: t.inputSchema?.required ?? [],
    properties: Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, { type: v.type ?? 'any', description: firstLine(v.description) }]),
    ),
  }
}

await writeFile(out, `${JSON.stringify({ source: 'kaleido-mcp', version, tools }, null, 2)}\n`)
process.stdout.write(`mcp-tools.snapshot.json: ${Object.keys(tools).length} tools from kaleido-mcp ${version}\n`)
