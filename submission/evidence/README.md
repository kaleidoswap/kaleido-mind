# Submission evidence

Evidence is generated, not hand-edited.

> **Committed reference run:** [`desktop-2026-06-20T12-09-49-172Z/`](./desktop-2026-06-20T12-09-49-172Z/)
> — a real QVAC run (`mode: qvac`, mind 0.6.1) across qwen3-0.6b / 1.7b / 4b on
> the reference Apple M4, all tracks exit 0. Model SHA-256s, hardware and the
> exact commit are in its `manifest.json`. New runs are gitignored by default;
> this one is force-committed as the canonical artifact.

```bash
# Fast structural smoke test; no model is loaded.
pnpm submission:evidence:mock

# Real QVAC product sweep, sequential because the worker holds one model lock.
pnpm submission:evidence -- --models qwen3-0.6b,qwen3-1.7b,qwen3-4b

# One-model rehearsal before the long sweep.
pnpm submission:evidence -- --quick
```

Each run creates an immutable timestamped directory with:

- `manifest.json`: mode, exact parameters, hardware and per-track exit status.
- model filenames and SHA-256 hashes.
- `*.stdout.log` / `*.stderr.log`: unedited track output.
- `product.raw.json`: per-scenario outcome, safety and inference evidence.
- `reports/`: any new QVAC raw/matrix/HTML reports produced during the run.

The runner writes to a `.partial` directory while active. It renames the
directory only after every track passes. Interrupted or failed runs retain an
`INCOMPLETE` marker and must not be used as submission evidence.

Options:

```bash
pnpm submission:evidence -- --help
pnpm submission:evidence -- --models qwen3-0.6b,qwen3-4b

# Legacy research tracks remain available explicitly, but are not the default.
pnpm submission:evidence -- --tracks safety,multistep,quality,capability
```

The default submission run is the product evaluation v3: twelve realistic
scenarios executed through the production Funnel with canonical tool contracts,
stateful simulators, confirmation decisions and observable side-effect grading.
It does not repeat identical temperature-zero prompts.

Real evidence runs refuse uncommitted changes to the CLI, core, runner or
package manifests so benchmark behavior maps to one exact commit. Unrelated
worktree changes are allowed but listed in `manifest.json`.
Use `--allow-dirty` only for a rehearsal when benchmark inputs themselves are
modified; never submit that output.

Real results must state the exact commit, model filename/hash, OS, device,
temperature, context size and thermal/power conditions. Never replace a failed
run with estimated numbers.
