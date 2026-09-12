#!/usr/bin/env bash
# Per-luma-band tone-slider gate (companion to test_color_pipeline.sh).
# Renders baseline + tone cases with maple-cli (Neutral profile, RCD demosaic,
# 1600 px long edge) and compares each slider's per-band ΔL* effect with ACR's.
#   FILTER=whites src/scripts/test_tone_bands.sh     # subset by case/fixture substring
#   WRITE_ACR=path.json ...                            # also dump ACR band effects
#   PARALLEL=4 ...                                      # shard count for maple-cli batch (default 4)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MANIFEST="$REPO_ROOT/test-fixtures/references/manifest.json"
REFS="$REPO_ROOT/test-fixtures/references"
BUDGETS="$REPO_ROOT/test-fixtures/tone_band_budgets.json"
CASES_RE='/(baseline|exposure_max|exposure_min|highlights_max|highlights_min|whites_max|whites_min|shadows_max|shadows_min|blacks_max|blacks_min)$'
PARALLEL="${PARALLEL:-4}"
if [ ! -d "$REPO_ROOT/test-fixtures/raws" ] || [ ! -f "$MANIFEST" ]; then
  echo "test_tone_bands: no fixtures, skipping"; exit 0
fi
( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >/dev/null )
CLI="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
WORK="$(mktemp -d)"
python3 - "$MANIFEST" "$WORK/mini.json" "${FILTER:-}" "$CASES_RE" <<'PY'
import json, re, sys
src, dst, flt, cases_re = sys.argv[1:5]
m = json.load(open(src))["cases"]
by_name = {c["name"]: c for c in m}
selected, fixtures_with_match = [], set()
for c in m:
    if not re.search(cases_re, c["name"]): continue
    fixture, case = c["name"].split("/", 1)
    if case == "baseline": continue  # baseline is never matched by the slider-name test; added below
    if flt and flt not in c["name"]: continue
    selected.append(c)
    fixtures_with_match.add(fixture)
for fixture in sorted(fixtures_with_match):
    b = by_name.get(f"{fixture}/baseline")
    if b is not None:
        selected.append(b)
keep = []
for c in selected:
    c["outputs"] = [dict(o, long_edge=1600) for o in c["outputs"] if o["resolution"] == "down"]
    keep.append(c)
json.dump({"cases": keep}, open(dst, "w"))
print(f"test_tone_bands: {len(keep)} cases")
PY
python3 - "$WORK/mini.json" "$WORK" "$PARALLEL" <<'PY'
import json, sys
mini, work, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
cases = json.load(open(mini))["cases"]
shards = [[] for _ in range(n)]
for i, c in enumerate(cases):
    shards[i % n].append(c)
for i, shard in enumerate(shards):
    json.dump({"cases": shard}, open(f"{work}/shard{i}.json", "w"))
    print(f"test_tone_bands: shard{i} {len(shard)} cases")
PY
for i in $(seq 0 $((PARALLEL - 1))); do
  "$CLI" batch --manifest "$WORK/shard$i.json" --out-dir "$WORK/out" --profile neutral --demosaic full \
    > "$WORK/shard$i.log" 2>&1 &
done
wait
fail=0
for i in $(seq 0 $((PARALLEL - 1))); do
  want="$(python3 -c "import json;print(len(json.load(open('$WORK/shard$i.json'))['cases']))")"
  got="$(grep -c '^ok' "$WORK/shard$i.log" || true)"
  if [ "$got" != "$want" ]; then
    echo "test_tone_bands: shard$i incomplete ($got/$want ok) — log:"
    cat "$WORK/shard$i.log"
    fail=1
  fi
done
if [ "$fail" != "0" ]; then
  echo "test_tone_bands: one or more shards failed to render"; exit 1
fi
python3 "$REPO_ROOT/tools/tone_band_gate.py" gate --candidates "$WORK/out" --references "$REFS" \
  --manifest "$WORK/mini.json" --budgets "$BUDGETS" --filter "${FILTER:-}" \
  ${WRITE_ACR:+--write-acr "$WRITE_ACR"}
