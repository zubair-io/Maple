#!/bin/bash
# test_film_looks.sh — golden ratchet for the film-look pipeline (epic #2683).
#
# Sibling of test_color_pipeline.sh, scoped to the film-look feature: renders
# a fixed RAW through a small pinned set of `papp:FilmLook` ids (one per
# catalog category) and diffs each candidate against a committed golden PNG.
# Self-consistency, not ACR parity — this only asks "does this look still
# render the way it did last time", so the budgets are tight (mean <= 0.5,
# max <= 2.0 DeltaE00).
#
# Per-look flow:
#   1. Write a temp XMP carrying papp:FilmLook="<id>" (strength omitted —
#      the XMP schema's silence-on-default convention means 100).
#   2. `maple-cli render test-fixtures/raws/test_0017.dng --params <xmp>
#      --out <png>` (full resolution — maple-cli's `render` subcommand has
#      no size flag; compare_images.py Lanczos-resizes the candidate down
#      to the (small, committed) golden's dimensions, same as
#      test_color_pipeline.sh's down/ references).
#   3. Missing golden -> downscale the candidate to a 1024px-long-edge PNG,
#      write it as the golden, FAIL with "baseline written" (UITest harness
#      convention — eyeball then re-run).
#   4. Golden present -> compare_images.py candidate vs golden; gate on the
#      budgets above.
#
# Also renders one no-look control and asserts every look's mean DeltaE00
# against it exceeds 0.5 — a look LUT that resolves to a no-op (wrong id,
# missing .mlut, identity lattice) fails loud instead of silently passing
# the self-consistency gate against its own inert baseline.
#
# Missing fixture RAW, or missing resources/film-luts/ (no .mlut pack
# committed), or missing DNG entirely -> "skipping", exit 0 (CI without the
# gitignored RAWs is a soft pass, same as test_color_pipeline.sh).
#
# Env overrides:
#   MAPLE_CLI   override path to a pre-built maple-cli binary
#   KEEP_TMP    non-empty -> leave the candidate workdir on disk

set -euo pipefail

# ----- repo root -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

RAW="$REPO_ROOT/test-fixtures/raws/test_0017.dng"
LUT_DIR="$REPO_ROOT/resources/film-luts"
GOLDEN_DIR="$REPO_ROOT/test-fixtures/references/film"
COMPARE_PY="$REPO_ROOT/src/scripts/compare_images.py"
MAPLE_CLI_RELEASE="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
DESKTOP_OUT="$HOME/Desktop/maple-color-tests/2683"

# One id per FilmCategory (BlackWhite, CinemaPrint, ColorNegative,
# ConsumerVintage, Instant, Slide) — see raw-core/src/film_catalog.rs.
LOOKS="black_white_kodak_tri_x_400 cinema_print_kodak_2383_constlclip color_negative_kodak_portra_400 consumer_vintage_fuji_superia_400 instant_polaroid_px_680 slide_fuji_velvia_50"

MEAN_BUDGET="0.5"
MAX_BUDGET="2.0"
IDENTITY_MIN_MEAN="0.5"

err() { printf "test_film_looks: %s\n" "$*" >&2; }

# ----- preflight / soft-skip --------------------------------------------
if ! command -v python3 >/dev/null 2>&1; then
  err "python3 not found — skipping"
  exit 0
fi

if [[ ! -f "$RAW" ]]; then
  echo "test_film_looks: fixture not found at $RAW — skipping"
  echo "test_film_looks: (gitignored RAW; CI without fixtures is a soft pass)"
  exit 0
fi

if [[ ! -d "$LUT_DIR" ]]; then
  echo "test_film_looks: film-lut pack not found at $LUT_DIR — skipping"
  exit 0
fi

if [[ ! -f "$COMPARE_PY" ]]; then
  err "compare_images.py not found at $COMPARE_PY"
  exit 2
fi

if [[ -n "${MAPLE_CLI:-}" ]]; then
  echo "test_film_looks: using caller-provided MAPLE_CLI=$MAPLE_CLI (no rebuild)"
  if [[ ! -x "$MAPLE_CLI" ]]; then
    err "MAPLE_CLI override is not an executable: $MAPLE_CLI"
    exit 2
  fi
else
  if ! command -v cargo >/dev/null 2>&1; then
    err "cargo not found — skipping"
    exit 0
  fi
  echo "test_film_looks: building maple-cli (release; cargo rebuilds only if stale) ..."
  (cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >/dev/null)
  MAPLE_CLI="$MAPLE_CLI_RELEASE"
fi

mkdir -p "$GOLDEN_DIR" "$DESKTOP_OUT"

WORKDIR="$(mktemp -d -t maple-film-looks-XXXXXX)"
cleanup() {
  if [[ -z "${KEEP_TMP:-}" ]]; then
    rm -rf "$WORKDIR"
  else
    echo "test_film_looks: KEEP_TMP set — candidates left at $WORKDIR"
  fi
}
trap cleanup EXIT

write_xmp() {
  # $1 = out path, $2 = film-look id ("" for no-look control)
  local out="$1" look="$2"
  local look_attr=""
  if [[ -n "$look" ]]; then
    look_attr=" papp:FilmLook=\"$look\""
  fi
  cat >"$out" <<XMP
<?xml version="1.0"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="maple:papp/1.0/"${look_attr}/></rdf:RDF></x:xmpmeta>
XMP
}

render_look() {
  # $1 = look id ("" for no-look control), $2 = out png path
  local look="$1" out="$2"
  local xmp="$WORKDIR/${look:-no_look}.xmp"
  write_xmp "$xmp" "$look"
  "$MAPLE_CLI" render "$RAW" --params "$xmp" --out "$out" --format png \
    --film-lut-dir "$LUT_DIR" >/dev/null
}

downscale_to_golden() {
  # $1 = src png, $2 = dst png, long edge 1024 (matches SliderMatrix/UITest
  # golden convention — keeps committed goldens small; compare_images.py
  # Lanczos-resizes the full-res candidate down to whatever the golden is).
  python3 - "$1" "$2" <<'PY'
import sys
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert("RGB")
long_edge = max(im.size)
scale = 1024.0 / long_edge
if scale < 1.0:
    new_size = (max(1, round(im.size[0] * scale)), max(1, round(im.size[1] * scale)))
    im = im.resize(new_size, Image.LANCZOS)
im.save(dst)
PY
}

echo "test_film_looks: rendering no-look control ..."
NO_LOOK_PNG="$WORKDIR/no_look.png"
render_look "" "$NO_LOOK_PNG"
cp "$NO_LOOK_PNG" "$DESKTOP_OUT/test_0017-no_look.png"

overall_exit=0
baseline_written=0

printf "%-42s %8s %8s %8s  %s\n" "look" "mean" "p95" "max" "verdict"

for look in $LOOKS; do
  candidate="$WORKDIR/$look.png"
  render_look "$look" "$candidate"
  cp "$candidate" "$DESKTOP_OUT/test_0017-$look.png"

  golden="$GOLDEN_DIR/test_0017-$look.png"

  # Identity guard: this look must actually move pixels vs the no-look
  # render — a LUT that resolves to a no-op would otherwise sail through
  # the self-consistency gate below by matching its own inert baseline.
  identity_json="$(python3 "$COMPARE_PY" "$candidate" "$NO_LOOK_PNG")"
  identity_mean="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['mean_deltaE'])" "$identity_json")"
  if python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) > float(sys.argv[2]) else 1)" "$identity_mean" "$IDENTITY_MIN_MEAN"; then
    identity_verdict="ok"
  else
    identity_verdict="FAIL(identity)"
    overall_exit=1
  fi

  if [[ ! -f "$golden" ]]; then
    downscale_to_golden "$candidate" "$golden"
    printf "%-42s %8s %8s %8s  %s\n" "$look" "--" "--" "--" "baseline written"
    err "baseline written: $golden — eyeball then re-run"
    baseline_written=1
    continue
  fi

  diff_json="$(python3 "$COMPARE_PY" "$candidate" "$golden")"
  mean="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['mean_deltaE'])" "$diff_json")"
  p95="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['p95_deltaE'])" "$diff_json")"
  max="$(python3 -c "import json,sys; print(json.loads(sys.argv[1])['max_deltaE'])" "$diff_json")"

  verdict="PASS"
  if ! python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)" "$mean" "$MEAN_BUDGET"; then
    verdict="FAIL(mean)"
    overall_exit=1
  fi
  if ! python3 -c "import sys; sys.exit(0 if float(sys.argv[1]) <= float(sys.argv[2]) else 1)" "$max" "$MAX_BUDGET"; then
    verdict="FAIL(max)"
    overall_exit=1
  fi
  if [[ "$identity_verdict" != "ok" ]]; then
    verdict="$verdict,$identity_verdict"
  fi

  printf "%-42s %8.3f %8.3f %8.3f  %s\n" "$look" "$mean" "$p95" "$max" "$verdict"
done

if [[ "$baseline_written" -ne 0 ]]; then
  err "one or more goldens were missing — baselines written, re-run to gate against them"
  exit 1
fi

if [[ "$overall_exit" -ne 0 ]]; then
  err "budget breach — see table above (mean <= $MEAN_BUDGET, max <= $MAX_BUDGET, identity mean > $IDENTITY_MIN_MEAN)"
fi

exit "$overall_exit"
