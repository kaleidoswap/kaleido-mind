#!/usr/bin/env bash
# Run all three KaleidoMind eval tracks sequentially.
#
# The QVAC worker holds a single lock, so tracks MUST run one at a time — this
# script enforces that. Engine logs go to *.qvac.log; the clean result tables
# (stderr) go to *.log.
#
#   ./run-all-evals.sh                 # default models, background-friendly
#   MODELS=qwen3-0.6b ./run-all-evals.sh
#   nohup ./run-all-evals.sh > eval-all.out 2>&1 &   # detached
#
# Override via env: MODELS, REPEATS, PER.

cd "$(dirname "$0")" || exit 1

MODELS="${MODELS:-qwen3-0.6b,qwen3-4b,medpsy-4b}"
REPEATS="${REPEATS:-3}"
PER="${PER:-2}"
OUT="eval-results"
mkdir -p "$OUT"
TS="$(date +%Y%m%d-%H%M%S)"

echo "▸ KaleidoMind full eval"
echo "  models : $MODELS"
echo "  repeats: $REPEATS   (Track A --per $PER)"
echo "  logs   : $OUT/*-$TS.log   (engine noise → *.qvac.log)"
echo "  note   : tracks run one at a time (QVAC worker lock); this takes a while."
echo ""

run() {
  name="$1"; shift
  echo "→ $(date +%H:%M:%S)  $name …"
  npx tsx src/index.ts "$@" > "$OUT/$name-$TS.qvac.log" 2> "$OUT/$name-$TS.log"
  echo "  done ($?) → $OUT/$name-$TS.log"
}

run safety     safety    --models "$MODELS" --repeats "$REPEATS"
run multistep  multistep --models "$MODELS" --repeats "$REPEATS"
run quality    quality   --models "$MODELS" --repeats "$REPEATS"
run capability eval      --models "$MODELS" --per "$PER" --repeats "$REPEATS"

echo ""
echo "════════════════ SUMMARY ($TS) ════════════════"
for name in safety multistep quality capability; do
  f="$OUT/$name-$TS.log"
  echo ""
  echo "──────── $name ────────"
  [ -f "$f" ] && tail -18 "$f"
done
echo ""
report="$(grep -ho '/Users/.*report.html' "$OUT/capability-$TS.log" 2>/dev/null | tail -1)"
[ -n "$report" ] && echo "Track A report: $report"
echo ""
echo "✓ all tracks done — paste the SUMMARY above back to finalize BENCHMARK.md"
