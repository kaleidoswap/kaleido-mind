# Submission evidence

Evidence is generated, not hand-edited.

```bash
# Fast structural smoke test; no model is loaded.
pnpm submission:evidence:mock

# Real QVAC sweep, sequential because the QVAC worker holds one model lock.
MODELS=qwen3-0.6b,qwen3-1.7b,qwen3-4b REPEATS=3 PER=2 \
  pnpm submission:evidence

# One-model rehearsal before the long sweep.
pnpm submission:evidence -- --quick
```

Each run creates an immutable timestamped directory with:

- `manifest.json`: mode, exact parameters, hardware and per-track exit status.
- model filenames and SHA-256 hashes.
- `*.stdout.log` / `*.stderr.log`: unedited track output.
- `reports/`: any new QVAC raw/matrix/HTML reports produced during the run.

The runner writes to a `.partial` directory while active. It renames the
directory only after every track passes. Interrupted or failed runs retain an
`INCOMPLETE` marker and must not be used as submission evidence.

Options:

```bash
pnpm submission:evidence -- --help
pnpm submission:evidence -- --models qwen3-0.6b,qwen3-4b --repeats 5 --per 3
```

Real evidence runs refuse a dirty worktree so the manifest maps to one exact
commit. Use `--allow-dirty` only for a rehearsal; never submit that output.

Real results must state the exact commit, model filename/hash, OS, device,
temperature, context size and thermal/power conditions. Never replace a failed
run with estimated numbers.
