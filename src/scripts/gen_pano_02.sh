#!/usr/bin/env bash
# gen_pano_02.sh — regenerate the pano_02 synthetic rotation fixture (#1256).
#
# Produces test-fixtures/raws/pano_02/*.dng: 6 LinearRaw DNGs from a 180°
# partial ring (60° FOV, 50% overlap, 1280×960 px, 8192×4096 equirect source,
# seed 42). The DNGs are gitignored; CI regenerates them via this script.
#
# Usage:
#   src/scripts/gen_pano_02.sh
#   FORCE=1 src/scripts/gen_pano_02.sh   # regenerate even if already present
#
# Env overrides:
#   MAPLE_PANO_BIN   path to pre-built pano-gen-fixture binary
#   OUT_DIR          output directory (default: test-fixtures/raws/pano_02)
#   FORCE            non-empty -> regenerate even if DNGs already exist

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CARGO_TARGET="$REPO_ROOT/src/raw-pipeline/target/release/pano-gen-fixture"
MAPLE_PANO_BIN="${MAPLE_PANO_BIN:-$CARGO_TARGET}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/test-fixtures/raws/pano_02}"
FORCE="${FORCE:-}"

err() { printf "gen_pano_02: %s\n" "$*" >&2; }

# Check if already present (unless FORCE).
if [[ -z "$FORCE" && -d "$OUT_DIR" ]]; then
  # find (not ls *.dng) so an empty dir yields 0, not a pipefail exit.
  n="$(find "$OUT_DIR" -maxdepth 1 -name '*.dng' 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "$n" -ge 6 ]]; then
    echo "gen_pano_02: $n DNG(s) already present in $OUT_DIR — skipping"
    echo "gen_pano_02: (set FORCE=1 to regenerate)"
    exit 0
  fi
fi

# Build pano-gen-fixture if not available.
if [[ ! -x "$MAPLE_PANO_BIN" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    err "pano-gen-fixture not found at $MAPLE_PANO_BIN and cargo is not installed"
    err "install Rust (https://rustup.rs) or set MAPLE_PANO_BIN"
    exit 2
  fi
  echo "gen_pano_02: building pano-gen-fixture (release) ..."
  ( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin pano-gen-fixture )
  MAPLE_PANO_BIN="$CARGO_TARGET"
fi

mkdir -p "$OUT_DIR"
echo "gen_pano_02: generating pano_02 fixture in $OUT_DIR ..."
"$MAPLE_PANO_BIN" --out-dir "$OUT_DIR"
echo "gen_pano_02: done"
