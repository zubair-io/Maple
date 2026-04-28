#!/usr/bin/env bash
# Synthetic grey neutrality + flatness gate.
#
# Sibling of test_color_pipeline.sh. Unlike that harness, inputs are
# synthesised in-memory — no test-fixtures/raws/ needed — so this script
# never skip-passes. Always runs, always asserts. The strictest pipeline
# regression net we have.
#
# Spec: docs/superpowers/specs/2026-04-28-synthetic-grey-dng-design.md

set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test grey_invariants -- --nocapture
