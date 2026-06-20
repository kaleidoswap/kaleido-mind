#!/usr/bin/env bash
# Compatibility wrapper for the submission-grade benchmark runner.
# Run from anywhere in the repository:
#
#   ./apps/cli/run-all-evals.sh
#   ./apps/cli/run-all-evals.sh --quick
#   MODELS=qwen3-0.6b,qwen3-1.7b REPEATS=5 ./apps/cli/run-all-evals.sh

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
exec pnpm submission:evidence -- "$@"
