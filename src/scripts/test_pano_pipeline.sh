#!/bin/bash
# test_pano_pipeline.sh — end-to-end regression gate for Maple Pano (M0b, #1120).
#
# House-pattern sibling of test_color_pipeline.sh: fixture-gated, budget-
# ratcheted, skip-passes when fixtures are absent so CI without the
# gitignored corpus stays green.
#
# What runs TODAY (always, fixtures or not):
#   1. Budgets validation — test-fixtures/pano-budgets.json (TRACKED — the CI
#      ratchet) must parse and carry the expected {version, fixtures} shape.
#   2. Metrics self-test — pano_metrics.py --self-test (identical-pair ~zero,
#      perturbed-pair clearly non-zero, wrap-shift recovery). Uses the real
#      pano_01 reference when fixtures are present, a procedural image
#      otherwise, so it runs everywhere numpy + Pillow are installed.
#
# What runs when fixtures are present:
#   3. Set discovery — pano sets under test-fixtures/raws/pano_*/ (>= 2
#      *.dng frames, case-insensitive; extend the extension list when the
#      corpus gains other container types) with references at
#      test-fixtures/references/<set>/<set>.png. Prints the inventory and
#      writes the effective manifest into the workdir.
#
# What activates when the candidate generator lands (ACTIVATION CONTRACT):
#   4. Candidate generation + per-set budget gates. Candidates come from
#      `maple-cli pano stitch`, which DOES NOT EXIST YET (Maple Pano M1+,
#      spec: docs/superpowers/specs/2026-06-10-maple-pano-*.md on PR #1095).
#      The harness probes for the subcommand (`maple-cli pano --help`); while
#      absent it prints "candidate generator not available — skipping
#      candidate gates" and exits 0. The moment a `pano` subcommand exists,
#      the harness invokes:
#          maple-cli pano stitch --manifest <manifest.json> --out-dir <dir>
#      and expects, per manifest case: <out-dir>/<set>.png (stitched canvas)
#      and <out-dir>/<set>.report.json (StitchReport, stitching-spec §6).
#      A missing candidate or report-only metrics under a budgeted key then
#      FAIL — they do not skip. If the landed CLI interface differs from the
#      contract above, the harness fails loudly (clap rejects the flags) and
#      MUST be updated in the same PR that lands the subcommand.
#
# Manifest convention (mirrors the color harness): the manifest ships WITH
# the gitignored fixtures at test-fixtures/references/pano-manifest.json
# (absolute paths, exactly like references/manifest.json does for the color
# gate). Until one is authored, discovery derives an equivalent manifest
# from the directory layout and writes it to the workdir:
#   { "cases": [ { "name": "pano_01",
#                  "frames": ["<abs>/PANO0001.DNG", ...],   # sorted
#                  "reference": "<abs>/pano_01.png" | null,
#                  "options": {} } ] }
# A shipped manifest, when present, is authoritative (it can pin frame
# subsets / stitch options); FILTER applies to either source.
#
# Budgets (test-fixtures/pano-budgets.json, TRACKED): per-set × per-case
# ceilings over the pano_metrics.py outputs. Case label is "stitch" (one
# case per set today). Gateable keys — any subset of:
#   rmse              size-normalized RMSE vs reference        (see metrics doc)
#   seam_energy       seam-line gradient-energy metric
#   wrap_closure_px   360° wrap-edge closure error, native px  (360 sets only)
#   mean_reproj_px    StitchReport passthrough
#   max_reproj_px     StitchReport passthrough
#   horizon_tilt_deg  StitchReport passthrough, gated on |deg|
# Only keys present in an entry gate. A set with NO entry FAILS with
# "no-budget-entry" and the observed numbers printed, so ceilings can be
# added: run once → fail → set ceilings 5–10% above observed → commit the
# entry together with the change. BUDGETS ARE A ONE-WAY RATCHET — ceilings
# only go down, in the same commit that delivers the improvement.
# (The eng spec names test-fixtures/pano/budgets.json; that directory is
# wholesale-gitignored corpus, so the tracked ratchet lives at the flat
# test-fixtures/pano-budgets.json, mirroring test-fixtures/budgets.json.)
#
# CI-style soft skip: missing fixtures, zero discovered sets, or a missing
# `pano` subcommand all exit 0 with an explicit notice — after the always-on
# validations (budgets parse + metrics self-test) have run.
#
# Env overrides:
#   MAPLE_CLI            override path to a pre-built maple-cli binary
#   MANIFEST             default test-fixtures/references/pano-manifest.json
#   BUDGETS              default test-fixtures/pano-budgets.json
#   FILTER               substring filter on set name (FILTER=pano_01)
#   KEEP_TMP             non-empty → leave the workdir on disk
#   ALLOW_MISSING_BUDGET non-empty → sets not in budgets warn instead of fail
#   NORM_LONG_EDGE       long edge for size-normalized metrics (default 2048)
#
# Usage:
#   src/scripts/test_pano_pipeline.sh
#   FILTER=pano_01 src/scripts/test_pano_pipeline.sh

set -euo pipefail

# ----- repo root -----------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

METRICS_PY="$REPO_ROOT/src/scripts/pano_metrics.py"
RAWS_DIR="$REPO_ROOT/test-fixtures/raws"
REFS_DIR="$REPO_ROOT/test-fixtures/references"
MANIFEST="${MANIFEST:-$REFS_DIR/pano-manifest.json}"
BUDGETS="${BUDGETS:-$REPO_ROOT/test-fixtures/pano-budgets.json}"
MAPLE_CLI_RELEASE="$REPO_ROOT/src/raw-pipeline/target/release/maple-cli"
FILTER="${FILTER:-}"
ALLOW_MISSING_BUDGET="${ALLOW_MISSING_BUDGET:-}"
NORM_LONG_EDGE="${NORM_LONG_EDGE:-2048}"

# ----- preflight -----------------------------------------------------------
err() { printf "test_pano_pipeline: %s\n" "$*" >&2; }

# NORM_LONG_EDGE feeds int(...) in the python gate — validate up front so a
# bad override fails with a clear message instead of a traceback mid-run.
case "$NORM_LONG_EDGE" in
  '' | *[!0-9]*)
    err "NORM_LONG_EDGE must be a positive integer (got '$NORM_LONG_EDGE')"
    exit 2
    ;;
esac
if [[ "$NORM_LONG_EDGE" -le 0 ]]; then
  err "NORM_LONG_EDGE must be a positive integer (got '$NORM_LONG_EDGE')"
  exit 2
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "required command not found: $1"
    exit 2
  fi
}

require_cmd python3

if [[ ! -f "$METRICS_PY" ]]; then
  err "pano_metrics.py not found at $METRICS_PY"
  exit 2
fi

# ----- 1. Budgets validation (always) --------------------------------------
if [[ ! -f "$BUDGETS" ]]; then
  echo "test_pano_pipeline: budgets file not found at $BUDGETS — skipping"
  echo "test_pano_pipeline: (test-fixtures/pano-budgets.json is tracked; restore it from git)"
  exit 0
fi

python3 - "$BUDGETS" <<'PY'
import json
import sys

path = sys.argv[1]
try:
    with open(path) as f:
        b = json.load(f)
except Exception as e:
    print(f"test_pano_pipeline: budgets file {path} is not valid JSON: {e}",
          file=sys.stderr)
    sys.exit(2)

ok = isinstance(b, dict) and isinstance(b.get("version"), int) \
    and isinstance(b.get("fixtures"), dict)
if not ok:
    print(f"test_pano_pipeline: budgets file {path} must be an object with "
          'integer "version" and object "fixtures"', file=sys.stderr)
    sys.exit(2)
for fixture, cases in b["fixtures"].items():
    if not isinstance(cases, dict):
        print(f"test_pano_pipeline: budgets fixture {fixture!r} must map "
              "case labels to ceiling objects", file=sys.stderr)
        sys.exit(2)
    for case, entry in cases.items():
        if not isinstance(entry, dict) or not all(
                isinstance(v, (int, float)) for k, v in entry.items()
                if not k.startswith("_")):
            print(f"test_pano_pipeline: budgets entry {fixture}/{case} must "
                  "be an object of numeric ceilings", file=sys.stderr)
            sys.exit(2)
n = sum(len(c) for c in b["fixtures"].values())
print(f"test_pano_pipeline: budgets OK ({path}, version {b['version']}, "
      f"{n} case entr{'y' if n == 1 else 'ies'})")
PY

# ----- workspace ------------------------------------------------------------
WORKDIR="$(mktemp -d -t maple-pano-XXXXXX)"
if [[ -z "${KEEP_TMP:-}" ]]; then
  trap 'rm -rf "$WORKDIR"' EXIT
else
  echo "test_pano_pipeline: KEEP_TMP set — workdir at $WORKDIR"
fi
EFFECTIVE_MANIFEST="$WORKDIR/pano-manifest.json"
CANDIDATES_DIR="$WORKDIR/candidates"
mkdir -p "$CANDIDATES_DIR"

# ----- 2. Set discovery / manifest (stdlib python — no numpy needed) -------
echo ""
echo "test_pano_pipeline: discovering pano sets ..."
[[ -n "$FILTER" ]] && echo "test_pano_pipeline: filter=$FILTER"
python3 - "$RAWS_DIR" "$REFS_DIR" "$MANIFEST" "$FILTER" "$EFFECTIVE_MANIFEST" <<'PY'
import glob
import json
import os
import sys

raws_dir, refs_dir, manifest_path, name_filter, out_path = sys.argv[1:6]
RAW_EXTS = (".dng",)  # case-insensitive; extend when the corpus grows

cases = []
if os.path.isfile(manifest_path):
    print(f"  manifest: shipped ({manifest_path})")
    with open(manifest_path) as f:
        shipped = json.load(f)
    for c in shipped.get("cases", []):
        name = c.get("name", "")
        frames = c.get("frames", [])
        if not name or not isinstance(frames, list) or len(frames) < 2:
            print(f"  WARN: manifest case {name!r} needs a name and >= 2 "
                  "frames — skipped", file=sys.stderr)
            continue
        missing = [p for p in frames if not os.path.isfile(p)]
        if missing:
            print(f"  WARN: {name}: {len(missing)} listed frame(s) missing "
                  f"on disk (first: {missing[0]}) — set skipped",
                  file=sys.stderr)
            continue
        ref = c.get("reference")
        if ref and not os.path.isfile(ref):
            print(f"  WARN: {name}: listed reference missing on disk "
                  f"({ref}) — treating as no-reference", file=sys.stderr)
            ref = None
        cases.append({"name": name, "frames": frames, "reference": ref,
                      "options": c.get("options", {})})
else:
    print("  manifest: derived from directory discovery "
          "(no shipped pano-manifest.json — see script header)")
    for d in sorted(glob.glob(os.path.join(raws_dir, "pano_*", ""))):
        name = os.path.basename(os.path.dirname(d))
        frames = sorted(
            p for p in glob.glob(os.path.join(d, "*"))
            if os.path.isfile(p)
            and os.path.splitext(p)[1].lower() in RAW_EXTS)
        if len(frames) < 2:
            print(f"  note: {name}: {len(frames)} raw frame(s) (< 2) — not "
                  "a stitchable set, skipped")
            continue
        ref = os.path.join(refs_dir, name, f"{name}.png")
        cases.append({"name": name, "frames": frames,
                      "reference": ref if os.path.isfile(ref) else None,
                      "options": {}})

discovered = len(cases)
if name_filter:
    cases = [c for c in cases if name_filter in c["name"]]

print(f"  {'set':<12} {'frames':>6}  reference")
for c in cases:
    ref = c["reference"] if c["reference"] else "(none — stitch smoke + report gates only)"
    print(f"  {c['name']:<12} {len(c['frames']):>6}  {ref}")
if not cases:
    print(f"  (no sets{' matching filter' if name_filter else ''}; "
          f"{discovered} discovered before filtering)")

with open(out_path, "w") as f:
    json.dump({"cases": cases}, f, indent=2)
print(f"  effective manifest: {out_path}")
PY

N_SETS="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["cases"]))' "$EFFECTIVE_MANIFEST")"

# ----- 3. Metrics self-test (always-on validation) --------------------------
echo ""
if ! python3 -c "import numpy, PIL" >/dev/null 2>&1; then
  if [[ "$N_SETS" -gt 0 ]]; then
    err "pano fixtures are present but the metric deps (numpy, Pillow) are not installed"
    err "install them (see src/scripts/requirements.txt) to run the gates"
    exit 2
  fi
  echo "test_pano_pipeline: python deps (numpy, Pillow) not available — skipping metrics self-test"
  echo "test_pano_pipeline: (fixture-less environment; CI without fixtures is a soft pass)"
  exit 0
fi

echo "test_pano_pipeline: running metrics self-test (pano_metrics.py --self-test) ..."
if ! python3 "$METRICS_PY" --self-test --fixture-root "$REPO_ROOT/test-fixtures"; then
  err "metrics self-test FAILED"
  exit 1
fi

# ----- 4. Skip-pass when there is nothing to stitch -------------------------
if [[ "$N_SETS" -eq 0 ]]; then
  echo ""
  if [[ -n "$FILTER" ]]; then
    echo "test_pano_pipeline: no pano sets match FILTER=$FILTER — skipping candidate gates"
  else
    echo "test_pano_pipeline: no pano fixture sets under $RAWS_DIR/pano_*/ — skipping candidate gates"
    echo "test_pano_pipeline: (gitignored corpus; CI without fixtures is a soft pass)"
  fi
  exit 0
fi

# ----- 5. Candidate generator probe (activation gate — see header) ----------
MAPLE_CLI="${MAPLE_CLI:-$MAPLE_CLI_RELEASE}"
if [[ ! -x "$MAPLE_CLI" ]]; then
  if ! command -v cargo >/dev/null 2>&1; then
    echo ""
    echo "test_pano_pipeline: no prebuilt maple-cli at $MAPLE_CLI and cargo is not"
    echo "test_pano_pipeline: installed — skipping candidate gates (install Rust or"
    echo "test_pano_pipeline: point MAPLE_CLI at a prebuilt binary)"
    exit 0
  fi
  echo ""
  echo "test_pano_pipeline: building maple-cli (release) ..."
  ( cd "$REPO_ROOT/src/raw-pipeline" && cargo build --release --bin maple-cli >/dev/null )
  MAPLE_CLI="$MAPLE_CLI_RELEASE"
fi

if ! "$MAPLE_CLI" pano --help >/dev/null 2>&1; then
  echo ""
  echo "test_pano_pipeline: candidate generator not available — skipping candidate gates"
  echo "test_pano_pipeline: (maple-cli has no 'pano' subcommand yet; the gates activate"
  echo "test_pano_pipeline:  automatically once 'maple-cli pano stitch' lands — activation"
  echo "test_pano_pipeline:  contract in this script's header)"
  exit 0
fi

# ----- 6. Generate candidates ------------------------------------------------
echo ""
echo "test_pano_pipeline: rendering candidates via maple-cli pano stitch ..."
# Per-set failures surface as missing candidates below (gated as errors) —
# don't abort the whole run on one bad set.
"$MAPLE_CLI" pano stitch --manifest "$EFFECTIVE_MANIFEST" --out-dir "$CANDIDATES_DIR" 2>&1 | sed 's/^/  /' || true

# ----- 7. Per-set metrics + budget gate --------------------------------------
echo ""
echo "test_pano_pipeline: gating candidates against $BUDGETS ..."
gate_exit=0
python3 - "$EFFECTIVE_MANIFEST" "$CANDIDATES_DIR" "$METRICS_PY" "$BUDGETS" "$ALLOW_MISSING_BUDGET" "$NORM_LONG_EDGE" <<'PY' || gate_exit=$?
import json
import os
import sys

manifest_path, cand_dir, metrics_py, budgets_path, allow_missing_s, long_edge_s = sys.argv[1:7]
allow_missing = allow_missing_s not in ("", "0", "false", "False")
long_edge = int(long_edge_s)

sys.path.insert(0, os.path.dirname(os.path.abspath(metrics_py)))
import pano_metrics  # the one pano diff implementation
from PIL import Image

with open(manifest_path) as f:
    manifest = json.load(f)
with open(budgets_path) as f:
    budgets = json.load(f).get("fixtures", {})

CASE_LABEL = "stitch"
# Keys a budget entry may gate on. horizon_tilt_deg gates on |value|.
GATE_KEYS = ("rmse", "seam_energy", "wrap_closure_px",
             "mean_reproj_px", "max_reproj_px", "horizon_tilt_deg")
ABS_KEYS = {"horizon_tilt_deg"}


def fmt(v, spec):
    return "-" if v is None else format(v, spec)


print(f"{'verd':<4} {'set':<12} {'frames':>6}  {'rmse':>8} {'seam':>10} "
      f"{'wrap_px':>8}  {'reproj_m':>8} {'reproj_M':>8} {'tilt_deg':>8}")
print("-" * 96)

rows = []
errors = 0
for case in sorted(manifest["cases"], key=lambda c: c["name"]):
    name = case["name"]
    cand = os.path.join(cand_dir, f"{name}.png")
    report = os.path.join(cand_dir, f"{name}.report.json")
    report = report if os.path.exists(report) else None

    if not os.path.exists(cand):
        print(f"FAIL {name:<12} {len(case['frames']):>6}  "
              f"no-candidate ({name}.png was not produced)")
        errors += 1
        continue

    try:
        if case.get("reference"):
            m = pano_metrics.diff(cand, case["reference"],
                                  report_path=report, long_edge=long_edge)
        else:
            # No reference for this set (by design — e.g. pano_00): pixel
            # metrics are unavailable; wrap closure (candidate-only) and the
            # StitchReport passthrough still gate.
            with Image.open(cand) as im:
                wc = pano_metrics.wrap_closure(im.convert("RGB"))
            m = {"rmse": None, "seam_energy": None,
                 "wrap_closure_px": wc["px"], "wrap_closure_ncc": wc["ncc"],
                 "report": pano_metrics.report_block(report)}
    except Exception as e:
        print(f"FAIL {name:<12} {len(case['frames']):>6}  metrics failed: {e}")
        errors += 1
        continue

    rep = m["report"]
    observed = {
        "rmse": m.get("rmse"),
        "seam_energy": m.get("seam_energy"),
        "wrap_closure_px": m.get("wrap_closure_px"),
        "mean_reproj_px": rep.get("mean_reproj_px") if rep.get("available") else None,
        "max_reproj_px": rep.get("max_reproj_px") if rep.get("available") else None,
        "horizon_tilt_deg": rep.get("horizon_tilt_deg") if rep.get("available") else None,
    }

    bud = budgets.get(name, {}).get(CASE_LABEL)
    breach = []
    warn = ""
    if bud is None:
        if allow_missing:
            warn = "  WARN no-budget-entry (ALLOW_MISSING_BUDGET set)"
        else:
            breach.append("no-budget-entry")
    else:
        for key, ceiling in bud.items():
            if key.startswith("_"):
                continue
            if key not in GATE_KEYS:
                breach.append(f"unknown-budget-key {key}")
                continue
            v = observed[key]
            if v is None:
                breach.append(f"{key} unavailable (budgeted {ceiling:g})")
                continue
            gated = abs(v) if key in ABS_KEYS else v
            if gated > ceiling:
                breach.append(f"{key} {gated:.4g}>{ceiling:.4g}")

    rows.append({"name": name, "observed": observed, "breach": breach})
    verdict = "FAIL" if breach else "PASS"
    extra = ("  " + ", ".join(breach)) if breach else warn
    print(f"{verdict} {name:<12} {len(case['frames']):>6}  "
          f"{fmt(observed['rmse'], '8.4f'):>8} "
          f"{fmt(observed['seam_energy'], '10.3e'):>10} "
          f"{fmt(observed['wrap_closure_px'], '8.2f'):>8}  "
          f"{fmt(observed['mean_reproj_px'], '8.2f'):>8} "
          f"{fmt(observed['max_reproj_px'], '8.2f'):>8} "
          f"{fmt(observed['horizon_tilt_deg'], '8.2f'):>8}{extra}")

print("-" * 96)
breach_count = sum(1 for r in rows if r["breach"])
if any("no-budget-entry" in r["breach"] for r in rows):
    print("# no-budget-entry: add ceilings 5-10% above the observed numbers")
    print("# above to test-fixtures/pano-budgets.json and commit them with")
    print("# this change. Budgets are a one-way ratchet — they only go down.")
print(f"# stats: {len(rows)} gated, {breach_count} budget breach(es), "
      f"{errors} error(s)")

summary = {
    "gated": len(rows),
    "breaches": breach_count,
    "errors": errors,
}
print(json.dumps(summary))
sys.exit(1 if (errors > 0 or breach_count > 0) else 0)
PY

if [[ "$gate_exit" -ne 0 ]]; then
  exit 1
fi
exit 0
