#!/usr/bin/env bash
# Synthetic 24-patch ColorChecker known-color gate (#1521).
#
# Sibling of test_synthetic_grey.sh, but for CHROMA. Inputs are synthesised
# in-memory (no test-fixtures/raws/ needed), so this never skip-passes — always
# runs, always asserts. Pins that the 24 known scene-linear Rec.2020 colors
# survive the full decode -> demosaic -> WB -> DCP -> scene-linear path with no
# hue/chroma distortion (up to a single exposure gain), that patches stay flat,
# that the neutral axis stays neutral, and that the saturation slider moves
# color chroma but not neutrals.
#
# Spec: .archived-plans/specs/2026-04-29-grey-card-dcp-coverage-design.md

set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test color_chart_invariants -- --nocapture
