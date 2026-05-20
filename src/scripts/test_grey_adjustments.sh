#!/usr/bin/env bash
# Closed-form + relational adjustment-validation gate.
#
# Sibling of test_synthetic_grey.sh and test_color_pipeline.sh. Inputs
# synthesised in-memory — no test-fixtures/raws/ needed — so this script
# never skip-passes.
#
# Spec: .archived-plans/specs/2026-04-28-grey-card-adjustment-tests-design.md

set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support --test grey_adjustments -- --nocapture
