#!/usr/bin/env bash
# Run the full KaleidoMind tool-use eval across your installed models and open
# the graphical report. Live progress on screen; verbose QVAC engine logs go to
# qvac-eval.log so the matrix stays readable.
#
#   ./run-eval.sh                                  # default: 0.6B, 4B, MedPsy-4B (full)
#   ./run-eval.sh qwen3-0.6b                        # one model
#   ./run-eval.sh qwen3-0.6b,qwen3-4b --per 3       # fewer cases (faster)
#   ./run-eval.sh "" --mock                         # no models, pipeline check
set -uo pipefail
cd "$(dirname "$0")"

MODELS="${1:-qwen3-0.6b,qwen3-4b,medpsy-4b}"
shift || true
ARGS=("$@")
[ -n "$MODELS" ] && ARGS=(--models "$MODELS" "${ARGS[@]}")

echo "▸ KaleidoMind eval — models: ${MODELS:-<installed>}  (engine logs → qvac-eval.log)"
echo "  this loads each model and runs 48 cases × 4 mechanisms; it can take a while."
echo ""

# stdout = live progress + final matrix; stderr (QVAC engine spam) = logfile.
npx tsx src/index.ts eval "${ARGS[@]}" 2> qvac-eval.log
status=$?

if [ $status -eq 0 ]; then
  REPORT="$(ls -dt "$HOME"/.kaleido/mind/logs/eval-*/ 2>/dev/null | head -1)report.html"
  echo ""
  echo "▸ Report: $REPORT"
  echo "  also: npx tsx src/index.ts serve   (interactive dashboard of all runs)"
  command -v open >/dev/null 2>&1 && open "$REPORT" 2>/dev/null || true
else
  echo "eval exited with status $status — see qvac-eval.log"
fi
