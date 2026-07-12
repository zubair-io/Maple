#!/bin/bash
# test_color_pipeline.sh — canonical color-parity gate for the Rust raw pipeline.
#
# Per CLAUDE.md § "Objective color testing — no eyeballing":
#   "Every color-pipeline change must pass the perceptual harness.
#    Screenshot comparisons are not acceptable evidence."
#
# Diffs maple-cli output against ACR-rendered references in
# test-fixtures/references/<stem>/{down,full}/<case>.png. Reads a per-fixture ×
# per-case budget table from test-fixtures/budgets.json and gates pass/fail
# accordingly. Budgets are a one-way ratchet — they only go down.
#
# Pipeline per case in test-fixtures/references/manifest.json:
#   1. maple-cli batch <manifest> --out-dir <tmp>      (one shot, all cases)
#   2. For each ManifestCase whose ManifestOutput[resolution=down].png exists:
#      - Resize the candidate PNG to the reference's dimensions (Lanczos)
#      - Diff (CIEDE2000 + per-channel bias) inline
#      - Compare against budgets.json for that fixture × case
#   3. Print column-aligned table sorted by fixture/case
#   4. Aggregate per-fixture and grand mean; non-zero exit on any budget breach
#
# CI-style soft skip: a missing manifest or missing budgets.json exits 0 with
# a notice (CI without the gitignored references is a soft pass). Once BOTH
# exist, the gate fails closed (#1082): zero comparisons in a diff pass —
# filter matching nothing, unresolvable RAW paths, or an empty candidate dir —
# exits non-zero instead of green-no-opping. maple-cli batch failures are
# surfaced (exit code + skipped(no-candidate) counts) rather than swallowed.
#
# Env overrides:
#   MAPLE_CLI            override path to a pre-built maple-cli binary
#   MANIFEST             default test-fixtures/references/manifest.json
#   BUDGETS              default test-fixtures/budgets.json
#   PREFERRED_RES        "down" (default) or "full"
#   FILTER               substring filter on case name
#   KEEP_TMP             non-empty → leave the candidate dir on disk
#   ALLOW_MISSING_BUDGET non-empty → cases not in budgets.json pass with a warn
#                        (default: missing budget = FAIL, force entry add)
#
# Usage:
#   src/scripts/test_color_pipeline.sh
#   FILTER=test_0000 src/scripts/test_color_pipeline.sh
#   FILTER=baseline src/scripts/test_color_pipeline.sh
#   PREFERRED_RES=full src/scripts/test_color_pipeline.sh

set -euo pipefail

# ----- repo root -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

MANIFEST="${MANIFEST:-$REPO_ROOT/test-fixtures/references/manifest.json}"
COMPARE_PY="$REPO_ROOT/src/scripts/compare_images.py"
MAPLE_CLI_RELEASE="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
PREFERRED_RES="${PREFERRED_RES:-down}"
FILTER="${FILTER:-}"
BUDGETS="${BUDGETS:-$REPO_ROOT/test-fixtures/budgets.json}"
ALLOW_MISSING_BUDGET="${ALLOW_MISSING_BUDGET:-}"
ZONES="${ZONES:-}"
HUE_BINS="${HUE_BINS:-12}"

# ----- preflight -----------------------------------------------------------
err() { printf "test_color_pipeline: %s\n" "$*" >&2; }

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 2
  fi
}

require_cmd python3

if [[ ! -f "$COMPARE_PY" ]]; then
  err "compare_images.py not found at $COMPARE_PY"
  exit 2
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "test_color_pipeline: manifest not found at $MANIFEST — skipping"
  echo "test_color_pipeline: (gitignored references; CI without references is a soft pass)"
  exit 0
fi

if [[ ! -f "$BUDGETS" ]]; then
  echo "test_color_pipeline: budgets file not found at $BUDGETS — skipping"
  echo "test_color_pipeline: (run after Task 3 to seed budgets.json from current numbers)"
  exit 0
fi

# Build maple-cli, rebuilding whenever it is stale — not only when missing
# (#1935). The old logic (`[[ ! -x "$MAPLE_CLI" ]]`) skipped the build entirely
# whenever the binary existed, so a run against a several-days-stale prebuilt
# binary silently reported results for OLD pipeline code with no signal that the
# binary was out of date. cargo's own fingerprint already tracks every source
# and Cargo input (the .rs / .bin / Cargo.lock / Cargo.toml set), so invoking
# `cargo build` unconditionally is the authoritative staleness check: it rebuilds
# iff an input moved and is a fast (~1s) no-op when the binary is current —
# strictly more precise than the hand-rolled mtime/hash stamp build-xcframework.sh
# needs (that stamp exists only because the .a → xcframework assembly happens
# OUTSIDE cargo, so cargo can't see that step's staleness; here cargo IS the
# whole build, so it can).
#
# A caller-pinned $MAPLE_CLI is treated as authoritative and used as-is (no
# build) — that override is how a machine without a Rust toolchain, or a
# deliberate A/B against a specific binary, opts out.
if [[ -n "${MAPLE_CLI:-}" ]]; then
  echo "test_color_pipeline: using caller-provided MAPLE_CLI=$MAPLE_CLI (no rebuild)"
  if [[ ! -x "$MAPLE_CLI" ]]; then
    err "MAPLE_CLI override is not an executable: $MAPLE_CLI"
    exit 2
  fi
else
  require_cmd cargo
  echo "test_color_pipeline: building maple-cli (release; cargo rebuilds only if stale) ..."
  ( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >/dev/null )
  MAPLE_CLI="$MAPLE_CLI_RELEASE"
fi

# ----- workspace -----------------------------------------------------------
WORKDIR="$(mktemp -d -t maple-calibrate-XXXXXX)"
if [[ -z "${KEEP_TMP:-}" ]]; then
  trap 'rm -rf "$WORKDIR"' EXIT
else
  echo "test_color_pipeline: KEEP_TMP set — candidates in $WORKDIR"
fi

CANDIDATES_DIR="$WORKDIR/candidates"
AUTO_CANDIDATES_DIR="$WORKDIR/auto_candidates"
mkdir -p "$CANDIDATES_DIR" "$AUTO_CANDIDATES_DIR"

echo "test_color_pipeline: manifest=$MANIFEST"
echo "test_color_pipeline: preferred_resolution=$PREFERRED_RES"
[[ -n "$FILTER" ]] && echo "test_color_pipeline: filter=$FILTER"
echo ""

# ----- 1. Render all cases via maple-cli batch -----------------------------
# `maple-cli batch` writes <out_dir>/<name.replace('/', '_')>.png per case.
# Filter is applied substring-on-case-name (matches the Rust `--cases-filter`
# arg) so partial-fixture iteration is fast.
echo "test_color_pipeline: rendering candidates (neutral) ..."
# Neutral pass — AgX-Neutral view transform, Maple-vs-ACR fidelity signal.
batch_args=( batch --manifest "$MANIFEST" --out-dir "$CANDIDATES_DIR" --profile neutral )
if [[ -n "$FILTER" ]]; then
  batch_args+=( --cases-filter "$FILTER" )
fi
# maple-cli batch returns non-zero if ANY case fails (e.g. unsupported X3F).
# That's expected with a heterogeneous fixture set — don't abort the script,
# but DO surface the exit code (#1082): failed cases show up below as
# skipped(no-candidate), and a batch that produced nothing at all is caught
# by the compared==0 fail-closed gate in the diff pass.
batch_neutral_exit=0
"$MAPLE_CLI" "${batch_args[@]}" 2>&1 | sed 's/^/  /' || batch_neutral_exit=$?
if [[ "$batch_neutral_exit" -ne 0 ]]; then
  echo "test_color_pipeline: WARNING — maple-cli batch (neutral) exited $batch_neutral_exit;"
  echo "test_color_pipeline: cases it failed to render are counted as skipped(no-candidate) below"
fi
echo ""

# Auto pass — same ACR reference images, Profile::Auto view transform.
# Budget keys are <fixture>/baseline_auto (see test-fixtures/budgets.json).
# This gate ensures Auto regressions vs ACR are caught immediately;
# test_auto_profile_match.sh gates Auto vs the camera-embedded JPEG
# separately (per-luma-band bias — different reference, different metric).
echo "test_color_pipeline: rendering candidates (auto) ..."
# Auto gate only covers baseline cases — scope the render so a full
# unfiltered run doesn't re-render all 774 cases (only ~18 baselines).
# "baseline" is a safe substring: it matches test_NNNN/baseline and
# nothing else in the manifest. If FILTER is already narrower (e.g.
# "test_0007"), honour it; otherwise default to "baseline".
auto_filter="${FILTER:-baseline}"
auto_batch_args=( batch --manifest "$MANIFEST" --out-dir "$AUTO_CANDIDATES_DIR" --profile auto --cases-filter "$auto_filter" )
batch_auto_exit=0
"$MAPLE_CLI" "${auto_batch_args[@]}" 2>&1 | sed 's/^/  /' || batch_auto_exit=$?
if [[ "$batch_auto_exit" -ne 0 ]]; then
  echo "test_color_pipeline: WARNING — maple-cli batch (auto) exited $batch_auto_exit;"
  echo "test_color_pipeline: cases it failed to render are counted as skipped(no-candidate) below"
fi
echo ""

# ----- 2. Walk manifest, diff each case vs its reference -------------------
# Single python invocation that reads manifest.json, diffs each candidate vs
# its expected reference (PREFERRED_RES first, falling back to whatever
# resolution exists), and prints two outputs:
#   * a tab-separated per-case row to stdout
#   * a one-line JSON summary on the LAST line (fixture/case rollups +
#     grand mean) so callers can grep it for CI assertions.
# The optional 10th arg (case_label_suffix) is appended to the case label
# for budget key lookup, e.g. "" → "baseline", "_auto" → "baseline_auto".
echo "test_color_pipeline: diffing neutral candidates vs ACR ..."
neutral_exit=0
python3 - "$MANIFEST" "$CANDIDATES_DIR" "$COMPARE_PY" "$PREFERRED_RES" "$FILTER" "$BUDGETS" "$ALLOW_MISSING_BUDGET" "$ZONES" "$HUE_BINS" "" <<'PY' || neutral_exit=$?
import json
import os
import sys
from collections import defaultdict
from typing import Optional

import numpy as np
from PIL import Image
import colour
# 4000x2667 (down) and 12288x8192 (full) ACR refs trip Pillow's
# decompression-bomb heuristic. They're our ground truth; suppress.
Image.MAX_IMAGE_PIXELS = None

manifest_path, cand_dir, compare_py, preferred_res, name_filter, budgets_path, allow_missing, zones_flag, hue_bins_s, case_label_suffix = sys.argv[1:11]
allow_missing = allow_missing not in ("", "0", "false", "False")
zones_on = zones_flag not in ("", "0", "false", "False")
hue_bins = int(hue_bins_s) if zones_on else 0


sys.path.insert(0, os.path.dirname(os.path.abspath(compare_py)))
import compare_images  # the one diff implementation (per-zone/per-hue aware)

with open(manifest_path) as f:
    manifest = json.load(f)

with open(budgets_path) as f:
    budgets = json.load(f).get("fixtures", {})

def budget_for(fixture: str, case: str) -> Optional[dict]:
    return budgets.get(fixture, {}).get(case)

cases = manifest.get("cases", [])
if name_filter:
    cases = [c for c in cases if name_filter in c["name"]]

# Header — column widths chosen so test_NNNN/<case>_max fits.
print(f"{'verd':<4} {'fixture':<12} {'case':<22} {'n_pix':>9}  "
      f"{'mean':>6} {'p95':>6} {'max':>6}  "
      f"{'bR':>8} {'bG':>8} {'bB':>8}")
print("-" * 100)

def pick_reference(outputs: list[dict]) -> Optional[dict]:
    """Strict: only use PREFERRED_RES. Falling back to `full` (typically
    12288x8192) blows the per-case diff time from ~50ms to ~10s. Cases
    that lack the preferred resolution are skipped."""
    by_res = {o["resolution"]: o for o in outputs}
    if preferred_res in by_res and os.path.exists(by_res[preferred_res]["png"]):
        return by_res[preferred_res]
    return None

per_fixture: dict[str, list[dict]] = defaultdict(list)
all_rows: list[dict] = []
skipped_no_ref = 0
skipped_no_cand = 0
skipped_no_raw = 0
errors = 0

for case in sorted(cases, key=lambda c: c["name"]):
    name = case["name"]
    fixture, case_label_base = (name.split("/", 1) + [""])[:2]
    # Budget key includes the profile suffix (e.g. "" → "baseline",
    # "_auto" → "baseline_auto"). The candidate filename uses the raw
    # manifest flat name (no suffix) since batch always writes by manifest name.
    case_label = case_label_base + case_label_suffix

    # Skip if RAW missing — maple-cli batch will already have errored
    # but we want to surface the skip cleanly.
    if not os.path.exists(case["raw"]):
        skipped_no_raw += 1
        continue

    flat = name.replace("/", "_")
    cand_path = os.path.join(cand_dir, f"{flat}.png")
    if not os.path.exists(cand_path):
        skipped_no_cand += 1
        continue

    ref = pick_reference(case.get("outputs", []))
    if ref is None:
        skipped_no_ref += 1
        continue
    ref_path = ref["png"]

    try:
        metrics = compare_images.diff(cand_path, ref_path,
                                      zones=zones_on, hue_bins=hue_bins)
    except Exception as e:
        print(f"{fixture:<12} {case_label:<22} {'DIFF':>9}  diff failed: {e}",
              file=sys.stderr)
        errors += 1
        continue

    row = {
        "fixture": fixture,
        "case": case_label,
        "n_pixels": metrics["n_pixels"],
        "mean": metrics["mean_deltaE"],
        "p95": metrics["p95_deltaE"],
        "max": metrics["max_deltaE"],
        "bR": metrics["bias_r"],
        "bG": metrics["bias_g"],
        "bB": metrics["bias_b"],
        "zones": metrics.get("zones"),
        "hue_bins": metrics.get("hue_bins"),
    }
    all_rows.append(row)
    per_fixture[fixture].append(row)

    # Per-case budget gate.
    bud = budget_for(fixture, case_label)
    breach: list[str] = []
    if bud is None:
        if not allow_missing:
            breach.append("no-budget-entry")
    else:
        if row["mean"] > bud["mean"]:
            breach.append(f"mean {row['mean']:.2f}>{bud['mean']:.2f}")
        if row["p95"]  > bud["p95"]:
            breach.append(f"p95 {row['p95']:.2f}>{bud['p95']:.2f}")
        if row["max"]  > bud["max"]:
            breach.append(f"max {row['max']:.2f}>{bud['max']:.2f}")
        for n, v in (("R", row["bR"]), ("G", row["bG"]), ("B", row["bB"])):
            if abs(v) > bud["bias"]:
                breach.append(f"bias_{n} {v:+.4f}>{bud['bias']:.4f}")
    row["breach"] = breach

    # Tabular row.
    n_pix_str = f"{row['n_pixels'] / 1e6:5.2f}M" if row["n_pixels"] >= 1e6 else f"{row['n_pixels']:>8}"
    verdict = "FAIL" if breach else "PASS"
    extra  = ("  " + ", ".join(breach)) if breach else ""
    print(f"{verdict} {fixture:<12} {case_label:<22} {n_pix_str:>9}  "
          f"{row['mean']:6.2f} {row['p95']:6.2f} {row['max']:6.2f}  "
          f"{row['bR']:+8.4f} {row['bG']:+8.4f} {row['bB']:+8.4f}{extra}")

# Per-fixture aggregate.
print("-" * 100)
for fixture in sorted(per_fixture.keys()):
    rows = per_fixture[fixture]
    if not rows:
        continue
    n = len(rows)
    mean_de = sum(r["mean"] for r in rows) / n
    mean_bR = sum(r["bR"] for r in rows) / n
    mean_bG = sum(r["bG"] for r in rows) / n
    mean_bB = sum(r["bB"] for r in rows) / n
    print(f"     {fixture:<12} {'(' + str(n) + ' cases)':<22} {'-':>9}  "
          f"{mean_de:6.2f} {'-':>6} {'-':>6}  "
          f"{mean_bR:+8.4f} {mean_bG:+8.4f} {mean_bB:+8.4f}")

# Zone / hue breakdown (diagnostic only — never gated; ZONES=1).
if zones_on:
    print("=" * 100)
    print("ZONE / HUE BREAKDOWN (diagnostic only — not gated)")
    for r in all_rows:
        if not r.get("zones"):
            continue
        print(f"\n  {r['fixture']}/{r['case']}")
        for zname, z in r["zones"].items():
            if z.get("n", 0) == 0:
                continue
            print(f"    zone {zname:<9} n={z['n']:>9}  mean={z['mean_deltaE']:6.2f} "
                  f"p95={z['p95_deltaE']:6.2f} max={z['max_deltaE']:6.2f}  "
                  f"bias=({z['bias_r']:+.4f},{z['bias_g']:+.4f},{z['bias_b']:+.4f})")
        hb = r.get("hue_bins") or {}
        for bn in hb.get("bins", []):
            if bn.get("n", 0) < 100:
                continue
            print(f"    hue {str(bn['bin_deg']):<14} n={bn['n']:>9}  "
                  f"mean={bn['mean_deltaE']:6.2f}  a*shift={bn['a_shift']:+6.2f} "
                  f"b*shift={bn['b_shift']:+6.2f}")
        neu = (hb.get("neutral") or {})
        if neu.get("n", 0):
            print(f"    hue {'neutral':<14} n={neu['n']:>9}  mean={neu['mean_deltaE']:6.2f}")

# Grand aggregate.
if all_rows:
    n = len(all_rows)
    grand_mean = sum(r["mean"] for r in all_rows) / n
    grand_bR = sum(r["bR"] for r in all_rows) / n
    grand_bG = sum(r["bG"] for r in all_rows) / n
    grand_bB = sum(r["bB"] for r in all_rows) / n
    print("=" * 100)
    print(f"     {'GRAND':<12} {'(' + str(n) + ' cases)':<22} {'-':>9}  "
          f"{grand_mean:6.2f} {'-':>6} {'-':>6}  "
          f"{grand_bR:+8.4f} {grand_bG:+8.4f} {grand_bB:+8.4f}")
    print()
    print(f"# Reading the bias columns:")
    print(f"#   bR/bG/bB are mean (candidate - reference) per channel in [0,1] sRGB-encoded units.")
    print(f"#   Positive = Maple has too much of that channel. Negative = too little.")
    print(f"#   Systematic bias (same sign across all fixtures) -> a calibration target.")
    print(f"#   Cast that grows with exposure_max -> AgX gain. Only on wb_* -> WB delta logic.")
    print(f"#   Cast on baseline only -> DCP / forward-matrix.")

# Skip / error summary.
breach_count = sum(1 for r in all_rows if r.get("breach"))
print(f"# stats: {len(all_rows)} compared, {breach_count} budget breach(es), "
      f"{skipped_no_raw} skipped(no-raw), {skipped_no_cand} skipped(no-candidate), "
      f"{skipped_no_ref} skipped(no-reference), {errors} errors")

# Fail closed on zero comparisons (#1082). The preflight already proved
# manifest + budgets exist, so comparing nothing means the gate was a
# no-op — a filter that matches nothing, every RAW path unresolvable
# (e.g. a manifest written for a different machine), or a maple-cli
# batch that produced no candidates. All of those used to exit 0.
fail_no_comparisons = len(all_rows) == 0
if fail_no_comparisons:
    if not cases:
        print("FAIL: 0 manifest cases match the filter — nothing was compared. "
              "A gate that compares nothing must not pass (#1082).")
    else:
        print(f"FAIL: 0 of {len(cases)} matching manifest cases were compared "
              f"({skipped_no_raw} no-raw, {skipped_no_cand} no-candidate, "
              f"{skipped_no_ref} no-reference). Manifest + budgets exist, so "
              "zero comparisons means broken fixture provisioning, not a pass (#1082).")

# One-line JSON summary on the very last line for CI scrapers.
summary = {
    "compared": len(all_rows),
    "breaches": breach_count,
    "skipped_no_raw": skipped_no_raw,
    "skipped_no_candidate": skipped_no_cand,
    "skipped_no_reference": skipped_no_ref,
    "errors": errors,
    "grand_mean_deltaE": (sum(r["mean"] for r in all_rows) / len(all_rows)) if all_rows else None,
    "grand_bias_r": (sum(r["bR"] for r in all_rows) / len(all_rows)) if all_rows else None,
    "grand_bias_g": (sum(r["bG"] for r in all_rows) / len(all_rows)) if all_rows else None,
    "grand_bias_b": (sum(r["bB"] for r in all_rows) / len(all_rows)) if all_rows else None,
}
print(json.dumps(summary))

sys.exit(1 if (errors > 0 or breach_count > 0 or fail_no_comparisons) else 0)
PY

# ----- 3. Auto pass: diff Profile::Auto candidates vs the same ACR refs ----
# Budget keys are <fixture>/baseline_auto in test-fixtures/budgets.json.
echo ""
echo "test_color_pipeline: diffing auto candidates vs ACR ..."
auto_exit=0
python3 - "$MANIFEST" "$AUTO_CANDIDATES_DIR" "$COMPARE_PY" "$PREFERRED_RES" "$FILTER" "$BUDGETS" "$ALLOW_MISSING_BUDGET" "$ZONES" "$HUE_BINS" "_auto" <<'PY_AUTO' || auto_exit=$?
import json
import os
import sys
from collections import defaultdict
from typing import Optional

import numpy as np
from PIL import Image
import colour
Image.MAX_IMAGE_PIXELS = None

manifest_path, cand_dir, compare_py, preferred_res, name_filter, budgets_path, allow_missing, zones_flag, hue_bins_s, case_label_suffix = sys.argv[1:11]
allow_missing = allow_missing not in ("", "0", "false", "False")
zones_on = zones_flag not in ("", "0", "false", "False")
hue_bins = int(hue_bins_s) if zones_on else 0

sys.path.insert(0, os.path.dirname(os.path.abspath(compare_py)))
import compare_images

with open(manifest_path) as f:
    manifest = json.load(f)

with open(budgets_path) as f:
    budgets = json.load(f).get("fixtures", {})

def budget_for(fixture: str, case: str) -> Optional[dict]:
    return budgets.get(fixture, {}).get(case)

cases = manifest.get("cases", [])
if name_filter:
    cases = [c for c in cases if name_filter in c["name"]]
# Auto pass only covers baseline cases (budget entries exist only for those).
cases = [c for c in cases if c["name"].endswith("/baseline")]

print(f"{'verd':<4} {'fixture':<12} {'case':<22} {'n_pix':>9}  "
      f"{'mean':>6} {'p95':>6} {'max':>6}  "
      f"{'bR':>8} {'bG':>8} {'bB':>8}")
print("-" * 100)

def pick_reference(outputs):
    by_res = {o["resolution"]: o for o in outputs}
    if preferred_res in by_res and os.path.exists(by_res[preferred_res]["png"]):
        return by_res[preferred_res]
    return None

per_fixture: dict = defaultdict(list)
all_rows = []
skipped_no_ref = 0
skipped_no_cand = 0
skipped_no_raw = 0
errors = 0

for case in sorted(cases, key=lambda c: c["name"]):
    name = case["name"]
    fixture, case_label_base = (name.split("/", 1) + [""])[:2]
    case_label = case_label_base + case_label_suffix

    if not os.path.exists(case["raw"]):
        skipped_no_raw += 1
        continue

    flat = name.replace("/", "_")
    cand_path = os.path.join(cand_dir, f"{flat}.png")
    if not os.path.exists(cand_path):
        skipped_no_cand += 1
        continue

    ref = pick_reference(case.get("outputs", []))
    if ref is None:
        skipped_no_ref += 1
        continue
    ref_path = ref["png"]

    try:
        metrics = compare_images.diff(cand_path, ref_path,
                                      zones=zones_on, hue_bins=hue_bins)
    except Exception as e:
        print(f"{fixture:<12} {case_label:<22} {'DIFF':>9}  diff failed: {e}",
              file=sys.stderr)
        errors += 1
        continue

    row = {
        "fixture": fixture,
        "case": case_label,
        "n_pixels": metrics["n_pixels"],
        "mean": metrics["mean_deltaE"],
        "p95": metrics["p95_deltaE"],
        "max": metrics["max_deltaE"],
        "bR": metrics["bias_r"],
        "bG": metrics["bias_g"],
        "bB": metrics["bias_b"],
    }
    all_rows.append(row)
    per_fixture[fixture].append(row)

    bud = budget_for(fixture, case_label)
    breach: list = []
    if bud is None:
        if not allow_missing:
            breach.append("no-budget-entry")
    else:
        if row["mean"] > bud["mean"]:
            breach.append(f"mean {row['mean']:.2f}>{bud['mean']:.2f}")
        if row["p95"]  > bud["p95"]:
            breach.append(f"p95 {row['p95']:.2f}>{bud['p95']:.2f}")
        if row["max"]  > bud["max"]:
            breach.append(f"max {row['max']:.2f}>{bud['max']:.2f}")
        for n, v in (("R", row["bR"]), ("G", row["bG"]), ("B", row["bB"])):
            if abs(v) > bud["bias"]:
                breach.append(f"bias_{n} {v:+.4f}>{bud['bias']:.4f}")
    row["breach"] = breach

    n_pix_str = f"{row['n_pixels'] / 1e6:5.2f}M" if row["n_pixels"] >= 1e6 else f"{row['n_pixels']:>8}"
    verdict = "FAIL" if breach else "PASS"
    extra   = ("  " + ", ".join(breach)) if breach else ""
    print(f"{verdict} {fixture:<12} {case_label:<22} {n_pix_str:>9}  "
          f"{row['mean']:6.2f} {row['p95']:6.2f} {row['max']:6.2f}  "
          f"{row['bR']:+8.4f} {row['bG']:+8.4f} {row['bB']:+8.4f}{extra}")

print("-" * 100)
for fixture in sorted(per_fixture.keys()):
    rows = per_fixture[fixture]
    if not rows:
        continue
    n = len(rows)
    mean_de = sum(r["mean"] for r in rows) / n
    mean_bR = sum(r["bR"] for r in rows) / n
    mean_bG = sum(r["bG"] for r in rows) / n
    mean_bB = sum(r["bB"] for r in rows) / n
    print(f"     {fixture:<12} {'(' + str(n) + ' cases)':<22} {'-':>9}  "
          f"{mean_de:6.2f} {'-':>6} {'-':>6}  "
          f"{mean_bR:+8.4f} {mean_bG:+8.4f} {mean_bB:+8.4f}")

breach_count = sum(1 for r in all_rows if r.get("breach"))
if all_rows:
    n = len(all_rows)
    grand_mean = sum(r["mean"] for r in all_rows) / n
    grand_bR = sum(r["bR"] for r in all_rows) / n
    grand_bG = sum(r["bG"] for r in all_rows) / n
    grand_bB = sum(r["bB"] for r in all_rows) / n
    print("=" * 100)
    print(f"     {'GRAND':<12} {'(' + str(n) + ' cases)':<22} {'-':>9}  "
          f"{grand_mean:6.2f} {'-':>6} {'-':>6}  "
          f"{grand_bR:+8.4f} {grand_bG:+8.4f} {grand_bB:+8.4f}")
    print()

print(f"# stats: {len(all_rows)} compared, {breach_count} budget breach(es), "
      f"{skipped_no_raw} skipped(no-raw), {skipped_no_cand} skipped(no-candidate), "
      f"{skipped_no_ref} skipped(no-reference), {errors} errors")

# Fail closed on zero comparisons (#1082), with one auto-pass nuance: this
# pass only covers `/baseline` cases, so a case-level FILTER (e.g.
# "dehaze_max") legitimately leaves zero baseline cases in scope — that is
# a vacuous pass, not a failure (the neutral pass above still gates the
# filtered cases). But if baseline cases ARE in scope and none compared,
# the gate was a silent no-op and must fail.
fail_no_comparisons = bool(cases) and len(all_rows) == 0
if fail_no_comparisons:
    print(f"FAIL: 0 of {len(cases)} matching baseline cases were compared "
          f"({skipped_no_raw} no-raw, {skipped_no_cand} no-candidate, "
          f"{skipped_no_ref} no-reference). Manifest + budgets exist, so "
          "zero comparisons means broken fixture provisioning, not a pass (#1082).")
elif not cases:
    print("# note: no /baseline manifest cases match the filter — auto pass is "
          "vacuous (case-level FILTER); the neutral pass above is the gate.")

summary = {
    "profile": "auto",
    "compared": len(all_rows),
    "breaches": breach_count,
    "skipped_no_raw": skipped_no_raw,
    "skipped_no_candidate": skipped_no_cand,
    "skipped_no_reference": skipped_no_ref,
    "errors": errors,
    "grand_mean_deltaE": (sum(r["mean"] for r in all_rows) / len(all_rows)) if all_rows else None,
}
print(json.dumps(summary))

sys.exit(1 if (errors > 0 or breach_count > 0 or fail_no_comparisons) else 0)
PY_AUTO

# Aggregate exit: fail if either diff pass had breaches, errors, or zero
# comparisons (fail-closed, #1082). Batch exit codes are surfaced above and
# echoed here for the log tail; they don't independently fail the gate —
# partially-renderable fixture sets (e.g. unsupported X3F cases) are expected,
# and a batch that produced nothing trips the compared==0 gate instead.
echo ""
echo "test_color_pipeline: batch exits: neutral=$batch_neutral_exit auto=$batch_auto_exit; diff passes: neutral=$neutral_exit auto=$auto_exit"
if [[ "$neutral_exit" -ne 0 ]] || [[ "$auto_exit" -ne 0 ]]; then
  exit 1
fi
exit 0
