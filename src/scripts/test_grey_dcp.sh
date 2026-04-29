#!/usr/bin/env bash
# DCP code-path coverage gate.
# Spec: docs/superpowers/specs/2026-04-29-grey-card-dcp-coverage-design.md.
#
# Phase 1 (single-patch + DCP scalars) is the active surface. Phase 2
# (multi-patch + DCP LUTs) infrastructure is in place (synth_chart,
# colorchecker, predict_radial_gain) but full HSM coverage is deferred.

set -euo pipefail
cd "$(dirname "$0")/../raw-pipeline"
cargo test -p raw-core --features test-support \
    --test grey_dcp_phase1 -- --nocapture
