# Color convergence — Phase 0: Unified gate + per-stage diagnostic

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`.archived-plans/specs/2026-04-30-color-convergence-design.md`](../specs/2026-04-30-color-convergence-design.md)

**Goal:** Make ACR-reference comparison the canonical CI color gate with a per-fixture × per-case ratchetable budget table, and add a feature-gated per-stage EXR dump + Python diff tool so we can localize divergence to a specific pipeline stage.

**Architecture:** Three independent deliverables on the same critical path. (1) Promote `calibrate_color_pipeline.sh` to canonical `test_color_pipeline.sh` with budget loading from a committed JSON table; retire the embedded-preview script to `tools/sanity-checks/`. (2) Add a `stage-dump` Cargo feature that writes f32 OpenEXR buffers between pipeline stages when `MAPLE_STAGE_DUMP=<dir>` is set, using a new `dump_stage()` helper called after every `stage()` invocation in `pipeline.rs`. (3) Build `src/scripts/stage_diff.py` that reads two trace directories and emits a per-stage ΔE table + heatmap PNGs.

**Tech stack:** Bash + Python 3 (PIL, numpy, colour-science, OpenEXR-via-imageio) for the harness and tools; Rust + `exr` crate (gated under `stage-dump` feature) for the buffer dumps.

**Subsequent plans (not in this plan):** Phase 1 (calibration foundations), Phase 2 (AgX hardening), Phase 3 (synthetic chart suite), Phase 4 (cross-app dashboard), Phase 5 (slider ratchet), Phase 6 (fixture expansion). Each gets its own plan when this one lands.

---

## File structure

**Created:**
- `tools/sanity-checks/test_embedded_preview.sh` — moved from `src/scripts/test_color_pipeline.sh`. Sanity-only, no CI gate.
- `test-fixtures/budgets.json` — per-fixture × per-case budget table; the one-way ratchet.
- `src/raw-pipeline/raw-core/src/stage_dump.rs` — feature-gated EXR writer; `dump_stage(name, &image, dir)`.
- `src/scripts/stage_diff.py` — reads two trace dirs, prints per-stage ΔE table, writes heatmap PNGs.
- `src/scripts/stage_diff_test.py` — pytest-style unit + integration tests for `stage_diff.py`.

**Modified:**
- `src/scripts/test_color_pipeline.sh` — replaced by the renamed-and-extended `calibrate_color_pipeline.sh`. Loads `budgets.json`, gates per case.
- `src/raw-pipeline/raw-core/Cargo.toml` — adds `stage-dump` feature + optional `exr` dep.
- `src/raw-pipeline/raw-core/src/lib.rs` — exposes `stage_dump` module under feature.
- `src/raw-pipeline/raw-core/src/pipeline.rs` — adds `dump_stage()` calls after each `stage()` site; reads `MAPLE_STAGE_DUMP` once at entry.
- `CLAUDE.md` — updates the "Objective color testing" section to point to the new canonical script and document the budget table workflow.

**Deleted:**
- `src/scripts/calibrate_color_pipeline.sh` — promoted to `test_color_pipeline.sh` (rename, not delete-and-create).

---

## Task 1: Move embedded-preview script out of CI gate position

**Files:**
- Create: `tools/sanity-checks/test_embedded_preview.sh`
- Delete: `src/scripts/test_color_pipeline.sh` (after move)

- [ ] **Step 1: Create the destination directory**

```bash
mkdir -p tools/sanity-checks
```

- [ ] **Step 2: Move the script**

```bash
git mv src/scripts/test_color_pipeline.sh tools/sanity-checks/test_embedded_preview.sh
```

- [ ] **Step 3: Update the script's header comment**

Edit `tools/sanity-checks/test_embedded_preview.sh`. Replace lines 1-37 (the existing comment block) with:

```bash
#!/bin/bash
# test_embedded_preview.sh — sanity check vs. the DNG embedded JPEG preview.
#
# NOT A CI GATE. The embedded preview is the camera's interpretation of the
# RAW (camera tone curve, camera WB, sometimes camera sharpening) — it varies
# across bodies and isn't a stable target for color correctness.
#
# Use this script to:
#   - Spot-check that maple-cli produces *something* in the right ballpark on a
#     new fixture before adding it to the ACR-reference set.
#   - Diagnose decode regressions where the rendered output is wildly off and
#     you want a quick "is the fixture decoding at all" answer.
#
# The canonical CI color gate is src/scripts/test_color_pipeline.sh, which
# diffs against the ACR-rendered references in test-fixtures/references/.
#
# Same usage and budget knobs as before:
#   tools/sanity-checks/test_embedded_preview.sh
#   BUDGET=5 tools/sanity-checks/test_embedded_preview.sh
```

- [ ] **Step 4: Verify the script still runs (no semantics changed)**

Run: `tools/sanity-checks/test_embedded_preview.sh`
Expected: same per-fixture pass/fail/skip output as before, prefixed with `test_color_pipeline:` (the internal echo prefix; we'll fix it in step 5).

- [ ] **Step 5: Update internal echo prefix**

In `tools/sanity-checks/test_embedded_preview.sh`, replace all occurrences of `test_color_pipeline:` with `test_embedded_preview:`:

```bash
sed -i '' 's/test_color_pipeline:/test_embedded_preview:/g' tools/sanity-checks/test_embedded_preview.sh
```

Verify: `grep -c 'test_embedded_preview' tools/sanity-checks/test_embedded_preview.sh` should print at least 6 (header + 5 echo statements).

- [ ] **Step 6: Re-run to confirm the prefix change works**

Run: `tools/sanity-checks/test_embedded_preview.sh`
Expected: output lines now use `test_embedded_preview:` prefix; final summary unchanged.

- [ ] **Step 7: Commit**

```bash
git add tools/sanity-checks/test_embedded_preview.sh
git rm src/scripts/test_color_pipeline.sh 2>/dev/null || true
git commit -m "refactor(scripts): move embedded-preview check to tools/sanity-checks

The canonical color gate is the ACR-reference harness. The embedded JPEG
preview varies per camera and isn't a stable target — keep the script
around for spot-checks but remove it from CI-gate position."
```

---

## Task 2: Promote calibrate_color_pipeline.sh to canonical test_color_pipeline.sh

**Files:**
- Modify: `src/scripts/calibrate_color_pipeline.sh` → `src/scripts/test_color_pipeline.sh` (rename)

- [ ] **Step 1: Rename the script**

```bash
git mv src/scripts/calibrate_color_pipeline.sh src/scripts/test_color_pipeline.sh
```

- [ ] **Step 2: Update the script's header comment**

Edit `src/scripts/test_color_pipeline.sh`. Replace lines 1-37 (the comment block) with:

```bash
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
# CI-style soft skip: missing test-fixtures/raws/, missing manifest, missing
# budgets.json, or manifest with zero matchable cases all exit 0 with a notice.
# Lets the script grow with the reference set as the user adds more fixtures.
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
```

- [ ] **Step 3: Update internal echo prefix from `calibrate_color:` to `test_color_pipeline:`**

```bash
sed -i '' 's/calibrate_color:/test_color_pipeline:/g' src/scripts/test_color_pipeline.sh
```

Verify: `grep -c 'test_color_pipeline:' src/scripts/test_color_pipeline.sh` should print ≥ 7.

- [ ] **Step 4: Run the renamed script to confirm it still works (no budget gate yet)**

Run: `src/scripts/test_color_pipeline.sh`
Expected: per-case ΔE table with grand-mean output ~13.4 (today's number); script exits 0 because budget gating isn't yet wired (we add it in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/test_color_pipeline.sh
git rm src/scripts/calibrate_color_pipeline.sh 2>/dev/null || true
git commit -m "refactor(scripts): promote calibrate_color_pipeline.sh to canonical test_color_pipeline.sh

ACR references are the canonical color truth. Renaming makes that
explicit. Budget loading + per-case gate come next."
```

---

## Task 3: Capture the current per-case ΔE numbers

**Files:**
- Create: `test-fixtures/budgets.json`

This task runs the new canonical script, captures all case numbers, and writes them to a JSON file as the starting budgets. The numbers we capture today become the "must beat or equal" baseline.

- [ ] **Step 1: Run the canonical script and dump the full table**

```bash
src/scripts/test_color_pipeline.sh > /tmp/budgets-raw.txt 2>&1
```

Expected: a multi-row table per fixture × case + per-fixture aggregates + grand mean + a one-line JSON summary. Inspect: `tail -20 /tmp/budgets-raw.txt`.

- [ ] **Step 2: Write a Python helper that converts the table into budgets.json**

Create `tools/budget_init.py`:

```python
#!/usr/bin/env python3
"""Convert the test_color_pipeline.sh table output into budgets.json.

Reads the column-aligned per-case rows from stdin, parses fixture/case/mean/p95/max/bR/bG/bB,
and emits a JSON budget table with each numeric ceiling rounded UP slightly to give a
small ratchet headroom (so a 0.1 ΔE noise wobble on a re-run doesn't flip a PASS to FAIL).

Headroom: ceil(mean * 1.05), ceil(p95 * 1.05), ceil(max * 1.05), abs(bias) * 1.1, all
clamped to {0.5, 1.0, 1.0, 0.005} as floors so a perfect-zero case still has *some* room.

Usage: tools/budget_init.py < /tmp/budgets-raw.txt > test-fixtures/budgets.json
"""

import json
import math
import re
import sys
from collections import defaultdict

# Match a case row from calibrate_color_pipeline.sh's output:
#   test_0000    baseline                 8.32M    8.41 12.34 27.50  -0.0431 +0.0042 -0.0301
ROW_RE = re.compile(
    r"^(?P<fixture>test_\d+)\s+"
    r"(?P<case>\S+)\s+"
    r"\S+\s+"  # n_pix
    r"(?P<mean>[\d.]+)\s+"
    r"(?P<p95>[\d.]+)\s+"
    r"(?P<max>[\d.]+)\s+"
    r"(?P<bR>[+-][\d.]+)\s+"
    r"(?P<bG>[+-][\d.]+)\s+"
    r"(?P<bB>[+-][\d.]+)\s*$"
)

def headroom(metric: str, value: float) -> float:
    """Round up + add a small floor so noise doesn't flip pass/fail."""
    if metric in ("mean", "p95", "max"):
        return max(round(value * 1.05 + 0.05, 1), 0.5 if metric == "mean" else 1.0)
    if metric == "bias":
        return max(round(abs(value) * 1.1 + 0.005, 4), 0.005)
    raise ValueError(metric)

def main() -> int:
    out: dict[str, dict[str, dict[str, float]]] = defaultdict(dict)
    for line in sys.stdin:
        m = ROW_RE.match(line)
        if not m:
            continue
        fixture = m["fixture"]
        case = m["case"]
        # Skip per-fixture aggregates which look like "(N cases)"
        if case.startswith("("):
            continue
        out[fixture][case] = {
            "mean": headroom("mean", float(m["mean"])),
            "p95":  headroom("p95",  float(m["p95"])),
            "max":  headroom("max",  float(m["max"])),
            "bias": max(
                headroom("bias", float(m["bR"])),
                headroom("bias", float(m["bG"])),
                headroom("bias", float(m["bB"])),
            ),
        }
    print(json.dumps({"version": 1, "fixtures": dict(sorted(out.items()))}, indent=2))
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: Generate budgets.json**

```bash
chmod +x tools/budget_init.py
tools/budget_init.py < /tmp/budgets-raw.txt > test-fixtures/budgets.json
```

- [ ] **Step 4: Sanity-check the output**

Run: `python3 -c "import json; d = json.load(open('test-fixtures/budgets.json')); print(f'fixtures: {len(d[\"fixtures\"])}, cases: {sum(len(c) for c in d[\"fixtures\"].values())}')"`
Expected: at least `fixtures: 4, cases: 60` (lower bound — the original spec mentions 4 RAWs × 43 cases; current usable subset may be different but should not be empty).

Run: `head -20 test-fixtures/budgets.json`
Expected: well-formed JSON with `{ "version": 1, "fixtures": { "test_0000": { "baseline": { "mean": ..., "p95": ..., "max": ..., "bias": ... }, ... }, ... } }`.

- [ ] **Step 5: Commit budgets.json + the init helper**

```bash
git add test-fixtures/budgets.json tools/budget_init.py
git commit -m "feat(test-fixtures): seed budgets.json from current ACR-reference deltas

Captures today's per-case mean/p95/max/bias as the budget ceilings, with
~5-10% headroom so a small noise wobble doesn't flip pass/fail. CI gates
on no-regression vs this table from now on. Budgets are a one-way
ratchet — to LOWER a budget, edit the file in the same commit that
delivers the improvement."
```

---

## Task 4: Wire budget enforcement into test_color_pipeline.sh

**Files:**
- Modify: `src/scripts/test_color_pipeline.sh:118-296` (the python heredoc that prints the table)

The current python heredoc inside the script reads the manifest, diffs each candidate vs. its reference, and prints a table. We extend it to also load `budgets.json` and check each row against the table, exit non-zero on any breach (or on missing-budget unless `ALLOW_MISSING_BUDGET=1`).

- [ ] **Step 1: Add BUDGETS env var to the script preamble**

In `src/scripts/test_color_pipeline.sh`, after the `FILTER` line (currently around line 48), add:

```bash
BUDGETS="${BUDGETS:-$REPO_ROOT/test-fixtures/budgets.json}"
ALLOW_MISSING_BUDGET="${ALLOW_MISSING_BUDGET:-}"
```

And in the preflight section (after the manifest existence check around line 67), add:

```bash
if [[ ! -f "$BUDGETS" ]]; then
  echo "test_color_pipeline: budgets file not found at $BUDGETS — skipping"
  echo "test_color_pipeline: (run after Task 3 to seed budgets.json from current numbers)"
  exit 0
fi
```

- [ ] **Step 2: Pass BUDGETS path + ALLOW_MISSING_BUDGET into the heredoc**

In `src/scripts/test_color_pipeline.sh`, find the heredoc invocation (currently line 118: `python3 - "$MANIFEST" "$CANDIDATES_DIR" "$COMPARE_PY" "$PREFERRED_RES" "$FILTER" <<'PY'`).

Change it to:

```bash
python3 - "$MANIFEST" "$CANDIDATES_DIR" "$COMPARE_PY" "$PREFERRED_RES" "$FILTER" "$BUDGETS" "$ALLOW_MISSING_BUDGET" <<'PY'
```

And update the argv unpacking line (currently `manifest_path, cand_dir, compare_py, preferred_res, name_filter = sys.argv[1:6]`):

```python
manifest_path, cand_dir, compare_py, preferred_res, name_filter, budgets_path, allow_missing = sys.argv[1:8]
allow_missing = bool(allow_missing)
```

- [ ] **Step 3: Load budgets.json inside the heredoc**

In the heredoc, after `with open(manifest_path) as f: manifest = json.load(f)`, add:

```python
with open(budgets_path) as f:
    budgets = json.load(f).get("fixtures", {})

def budget_for(fixture: str, case: str) -> Optional[dict]:
    return budgets.get(fixture, {}).get(case)
```

- [ ] **Step 4: Add per-case budget check inside the row loop**

In the heredoc, find the row-emission block (currently around `# Tabular row.` near line 234). Replace the immediate-after-row-emit code with:

```python
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
```

- [ ] **Step 5: Make script exit non-zero on any breach**

In the heredoc near the bottom (currently `sys.exit(1 if errors > 0 else 0)`), replace with:

```python
breach_count = sum(1 for r in all_rows if r.get("breach"))
print(f"# stats: {len(all_rows)} compared, {breach_count} budget breach(es), "
      f"{skipped_no_raw} skipped(no-raw), {skipped_no_cand} skipped(no-candidate), "
      f"{skipped_no_ref} skipped(no-reference), {errors} errors")

# (Update the JSON summary block immediately above this to also include "breaches": breach_count.)
sys.exit(1 if (errors > 0 or breach_count > 0) else 0)
```

Also add `"breaches": breach_count,` to the `summary = { ... }` dict that's already present.

- [ ] **Step 6: Run the gated script — expect all PASS (today's numbers ≤ today's budgets-with-headroom)**

Run: `src/scripts/test_color_pipeline.sh`
Expected: all rows print `PASS`; final line includes `0 budget breach(es)`; exit 0.

- [ ] **Step 7: Test the gate by intentionally tightening a budget**

```bash
python3 -c "
import json
b = json.load(open('test-fixtures/budgets.json'))
first_fixture = next(iter(b['fixtures']))
first_case = next(iter(b['fixtures'][first_fixture]))
b['fixtures'][first_fixture][first_case]['mean'] = 0.01  # impossible
json.dump(b, open('/tmp/budgets-tightened.json', 'w'), indent=2)
print(f'tightened {first_fixture}/{first_case}.mean to 0.01')
"
BUDGETS=/tmp/budgets-tightened.json src/scripts/test_color_pipeline.sh
```

Expected: at least one row prints `FAIL ... mean ...>0.01`; exit code non-zero.

Verify exit code: `echo $?` should be `1`.

- [ ] **Step 8: Test ALLOW_MISSING_BUDGET behavior**

```bash
echo '{"version":1,"fixtures":{}}' > /tmp/budgets-empty.json
BUDGETS=/tmp/budgets-empty.json src/scripts/test_color_pipeline.sh
```

Expected: every row prints `FAIL ... no-budget-entry`; exit non-zero.

```bash
ALLOW_MISSING_BUDGET=1 BUDGETS=/tmp/budgets-empty.json src/scripts/test_color_pipeline.sh
```

Expected: every row prints `PASS`; exit 0.

- [ ] **Step 9: Commit**

```bash
git add src/scripts/test_color_pipeline.sh
git commit -m "feat(scripts): test_color_pipeline.sh enforces per-case ratcheting budgets

Loads test-fixtures/budgets.json and gates each {fixture, case} pair on
mean/p95/max/bias ceilings. Missing entries fail by default (force the
team to add an entry when adding a new case); ALLOW_MISSING_BUDGET=1
opt-out for one-off iteration. Tightening a budget value lowers the
ceiling for that case forever (one-way ratchet)."
```

---

## Task 5: Update CLAUDE.md and references

**Files:**
- Modify: `CLAUDE.md` (the "Objective color testing" section)

- [ ] **Step 1: Read the current section**

Run: `grep -n 'test_color_pipeline\|calibrate_color_pipeline' CLAUDE.md`
Note all occurrences for the next step.

- [ ] **Step 2: Update the "Objective color testing" section**

In `CLAUDE.md`, find the `## Objective color testing — no eyeballing` section. Replace its body with:

```markdown
Every color-pipeline change must pass the perceptual harness against ACR-rendered references. Screenshot comparisons are not acceptable evidence.

The canonical CI color gate:

\`\`\`bash
src/scripts/test_color_pipeline.sh                # checks vs test-fixtures/budgets.json
\`\`\`

It runs `maple-cli batch` against every case in `test-fixtures/references/manifest.json`, diffs each candidate vs the ACR-rendered reference, and gates per-fixture × per-case mean/p95/max/bias against `test-fixtures/budgets.json`. **Budgets are a one-way ratchet — they can only go down.** Lowering a budget happens in the same commit that delivers the improvement.

Adding a new case:
1. Render the ACR reference and place under `test-fixtures/references/test_NNNN/down/<case>.png`.
2. Add the case to `test-fixtures/references/manifest.json`.
3. Run the harness once — it will FAIL with `no-budget-entry` for the new case.
4. Inspect the printed mean/p95/max/bias, add a budgets.json entry whose ceilings are roughly 5-10% above those numbers (or use `tools/budget_init.py` and merge).
5. Commit harness file + manifest entry + budgets.json entry together.

Spot-check a single fixture:

\`\`\`bash
FILTER=test_0000 src/scripts/test_color_pipeline.sh
FILTER=baseline src/scripts/test_color_pipeline.sh
\`\`\`

Sanity check vs the camera's embedded JPEG preview (NOT a CI gate, varies per body):

\`\`\`bash
tools/sanity-checks/test_embedded_preview.sh
\`\`\`
```

- [ ] **Step 3: Verify all old references are gone**

Run: `grep -c 'calibrate_color_pipeline' CLAUDE.md`
Expected: `0`.

Run: `grep -c 'tools/sanity-checks/test_embedded_preview.sh\|src/scripts/test_color_pipeline.sh' CLAUDE.md`
Expected: ≥ 2.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(claude): point to canonical test_color_pipeline.sh + budgets.json

Document the one-way ratchet, the new-case workflow, and the embedded-preview
sanity script's new home under tools/sanity-checks/."
```

---

## Task 6: Add `stage-dump` Cargo feature + `exr` dependency

**Files:**
- Modify: `src/raw-pipeline/raw-core/Cargo.toml`

- [ ] **Step 1: Add the `exr` crate as an optional dependency**

In `src/raw-pipeline/raw-core/Cargo.toml`, add to the `[dependencies]` section (alphabetically placed between `bytemuck` and `image`):

```toml
exr = { version = "1.73", optional = true }
```

- [ ] **Step 2: Add the `stage-dump` feature**

In the `[features]` section, add after `test-support = []`:

```toml
# When enabled, raw-core writes one OpenEXR file per pipeline stage to the
# directory named by the MAPLE_STAGE_DUMP env var (no-op when the env var is
# unset). Used by src/scripts/stage_diff.py to localize divergence to a
# specific stage. Adds ~2 MB to the binary; do NOT enable in shipping
# artifacts.
stage-dump = ["dep:exr"]
```

- [ ] **Step 3: Verify the feature builds**

Run: `cd src/raw-pipeline && cargo build -p raw-core --features stage-dump 2>&1 | tail -20`
Expected: clean build, no errors. (We haven't added any `#[cfg(feature = "stage-dump")]` code yet, so this only verifies the dependency resolves.)

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -20`
Expected: clean build without `exr` in the dep tree.

- [ ] **Step 4: Commit**

```bash
git add src/raw-pipeline/raw-core/Cargo.toml src/raw-pipeline/Cargo.lock
git commit -m "feat(raw-core): stage-dump feature flag + optional exr dep

Foundation for per-stage OpenEXR buffer dumps. No code change yet —
the feature compiles cleanly with no consumers."
```

---

## Task 7: Add stage_dump module with EXR writer

**Files:**
- Create: `src/raw-pipeline/raw-core/src/stage_dump.rs`
- Modify: `src/raw-pipeline/raw-core/src/lib.rs` (expose the module)

- [ ] **Step 1: Create the new module**

Create `src/raw-pipeline/raw-core/src/stage_dump.rs`:

```rust
//! Feature-gated per-stage OpenEXR buffer dumps. Active when the binary is
//! built with `--features stage-dump` AND the `MAPLE_STAGE_DUMP` env var
//! is set to a directory path. Used by `src/scripts/stage_diff.py` to
//! localize divergence to a specific pipeline stage.

#![cfg(feature = "stage-dump")]

use std::path::Path;

use crate::image::Image;
use exr::prelude::*;

/// Read MAPLE_STAGE_DUMP once. Returns Some(path) when set to a non-empty
/// value AND the directory exists (or can be created). Returns None
/// otherwise — pipeline.rs callers no-op when None.
pub fn dump_dir() -> Option<std::path::PathBuf> {
    let raw = std::env::var_os("MAPLE_STAGE_DUMP")?;
    let s = raw.to_string_lossy();
    if s.is_empty() {
        return None;
    }
    let p = std::path::PathBuf::from(s.as_ref());
    std::fs::create_dir_all(&p).ok()?;
    Some(p)
}

/// Write `image` to `<dir>/<name>.exr` as 32-bit RGB OpenEXR. Errors are
/// logged to stderr and swallowed — diagnostic dumping must never break a
/// render.
pub fn dump_image(name: &str, image: &Image, dir: &Path) {
    let path = dir.join(format!("{name}.exr"));
    let width = image.width as usize;
    let height = image.height as usize;
    if image.pixels.len() != width * height {
        eprintln!(
            "[stage-dump] {name}: pixel count {} != {}*{} = {}; skipping",
            image.pixels.len(), width, height, width * height
        );
        return;
    }
    let result = write_rgb_file(
        &path,
        width,
        height,
        |x, y| {
            let p = image.pixels[y * width + x];
            (p[0], p[1], p[2])
        },
    );
    if let Err(e) = result {
        eprintln!("[stage-dump] {name}: {e}");
    }
}
```

- [ ] **Step 2: Expose the module from lib.rs**

In `src/raw-pipeline/raw-core/src/lib.rs`, find the existing `pub mod` declarations. Add (alphabetically):

```rust
#[cfg(feature = "stage-dump")]
pub mod stage_dump;
```

- [ ] **Step 3: Verify the module compiles under the feature**

Run: `cd src/raw-pipeline && cargo build -p raw-core --features stage-dump 2>&1 | tail -10`
Expected: clean build.

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -10`
Expected: clean build (the `#[cfg]` gates strip the module entirely).

- [ ] **Step 4: Add a unit test**

At the bottom of `src/raw-pipeline/raw-core/src/stage_dump.rs`, add:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::image::ColorSpace;

    #[test]
    fn dump_image_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let mut img = Image::new(2, 2, ColorSpace::SceneLinearRec2020);
        img.pixels = vec![[1.0, 0.5, 0.25], [0.0, 1.0, 0.5], [0.5, 0.25, 1.0], [0.75, 0.5, 0.25]];
        dump_image("test", &img, dir.path());

        let path = dir.path().join("test.exr");
        assert!(path.exists(), "exr file should be written");

        // Read it back via exr's reader.
        let image = read_first_rgba_layer_from_file(
            path,
            |_resolution, _channels| Vec::<(f32, f32, f32, f32)>::new(),
            |buffer, position, (r, g, b, _a): (f32, f32, f32, f32)| {
                buffer.push((r, g, b, 0.0));
            },
        ).unwrap();
        let layer = image.layer_data.channel_data.pixels;
        assert_eq!(layer.len(), 4);
        assert!((layer[0].0 - 1.0).abs() < 1e-4);
        assert!((layer[3].2 - 0.25).abs() < 1e-4);
    }
}
```

- [ ] **Step 5: Run the unit test**

Run: `cd src/raw-pipeline && cargo test -p raw-core --features stage-dump --lib stage_dump 2>&1 | tail -20`
Expected: `test stage_dump::tests::dump_image_roundtrip ... ok`.

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/stage_dump.rs src/raw-pipeline/raw-core/src/lib.rs
git commit -m "feat(raw-core): stage_dump module — feature-gated EXR writer

Writes 32-bit RGB OpenEXR per Image. Used by the next commit's
pipeline.rs hooks to dump intermediate buffers to MAPLE_STAGE_DUMP when
the stage-dump feature is enabled. Errors are logged and swallowed so
diagnostic dumping never breaks a render."
```

---

## Task 8: Wire dump_image calls into pipeline.rs

**Files:**
- Modify: `src/raw-pipeline/raw-core/src/pipeline.rs:102-194`

We'll add a single helper that's a no-op when the feature is off, and call it after each stage that produces or modifies the in-flight `Image`. Stages that operate on the pre-demosaic mosaic (linearize, demosaic) don't have a 3-channel `Image` to dump until after demosaic — we add the first dump right after demosaic.

- [ ] **Step 1: Add a feature-gated helper at the top of pipeline.rs**

In `src/raw-pipeline/raw-core/src/pipeline.rs`, after the `stage()` function (around line 54) but before `pub fn render_from_raw`, add:

```rust
/// Per-stage diagnostic dump. No-op when the `stage-dump` feature is
/// disabled or the `MAPLE_STAGE_DUMP` env var is unset. Called after each
/// stage that produces or modifies the in-flight `Image`.
#[cfg(feature = "stage-dump")]
#[inline]
fn dump_after(name: &str, image: &crate::image::Image) {
    if let Some(dir) = crate::stage_dump::dump_dir() {
        crate::stage_dump::dump_image(name, image, &dir);
    }
}

#[cfg(not(feature = "stage-dump"))]
#[inline]
fn dump_after(_name: &str, _image: &crate::image::Image) {}
```

- [ ] **Step 2: Insert dump calls after each post-demosaic stage**

In `develop_scene_linear_from_raw_with_quality` (around lines 145-193), insert `dump_after` calls. Edit the function body so the post-demosaic block reads:

```rust
    if raw.baseline_exposure.abs() > 1e-4 {
        stage("baseline_exposure", || {
            let be_gain = raw.baseline_exposure.exp2();
            for p in &mut camera_rgb.pixels {
                p[0] *= be_gain;
                p[1] *= be_gain;
                p[2] *= be_gain;
            }
        });
    }
    dump_after("01_baseline_exposure", &camera_rgb);
    stage("highlight_recovery", || highlight_recovery::apply(&mut camera_rgb, model.highlight_recovery));
    dump_after("02_highlight_recovery", &camera_rgb);
    let profile = stage("dcp::profile_for", || dcp::profile_for(raw))?;
    let mut scene = stage("dcp::apply", || dcp::apply_with_plt_and_ptc(
        &camera_rgb, &profile, raw.plt.as_ref(), raw.profile_tone_curve.as_ref(),
    ))?;
    dump_after("03_dcp_apply", &scene);
    if let Some(pgtm) = raw.profile_gain_table_map.as_ref() {
        stage("profile_gain_table_map", || {
            crate::color::profile_gain_table_map::apply(&mut scene, pgtm)
        });
    }
    dump_after("04_profile_gain_table_map", &scene);
    stage("auto_exposure", || auto_exposure::apply(&mut scene, AUTO_EXPOSURE_CLIP_PCT));
    dump_after("05_auto_exposure", &scene);
    stage("white_balance", || white_balance::apply(&mut scene, model.temperature, model.tint));
    dump_after("06_white_balance", &scene);
    stage("scene_tone_controls", || scene_tone_controls::apply(&mut scene, model));
    dump_after("07_scene_tone_controls", &scene);
    stage("vibrance", || vibrance::apply(&mut scene, model.vibrance));
    dump_after("08_vibrance", &scene);
    stage("saturation", || saturation::apply(&mut scene, model.saturation));
    dump_after("09_saturation", &scene);
    stage("clarity", || clarity::apply(&mut scene, model.clarity));
    dump_after("10_clarity", &scene);
    stage("texture", || texture::apply(&mut scene, model.texture));
    dump_after("11_texture", &scene);
    stage("dehaze", || dehaze::apply(&mut scene, model.dehaze));
    dump_after("12_dehaze", &scene);
    stage("sharpen", || sharpen::apply(&mut scene, model.sharpen_amount, model.sharpen_radius, model.sharpen_detail, model.sharpen_masking));
    dump_after("13_sharpen", &scene);
    stage("nr_luminance", || noise_reduction::apply_luminance(&mut scene, model.nr_luminance));
    dump_after("14_nr_luminance", &scene);
    stage("nr_color", || noise_reduction::apply_color(&mut scene, model.nr_color));
    dump_after("15_nr_color", &scene);
    Ok(scene)
}
```

(The `dump_after("00_demosaic", &camera_rgb)` line just before `baseline_exposure` is intentionally omitted — `camera_rgb` post-demosaic is in `CameraNativeLinearRgb`, which is the conventional pre-stage starting point. Add only if the engineer needs it; keep this PR tight.)

- [ ] **Step 3: Verify the build is still green with the feature OFF**

Run: `cd src/raw-pipeline && cargo build -p raw-core 2>&1 | tail -10`
Expected: clean build (the `dump_after` no-op stub is used).

- [ ] **Step 4: Verify the build is still green with the feature ON**

Run: `cd src/raw-pipeline && cargo build -p raw-core --features stage-dump 2>&1 | tail -10`
Expected: clean build.

- [ ] **Step 5: Run the existing test suite under the feature to confirm no regression**

Run: `cd src/raw-pipeline && cargo test -p raw-core --features stage-dump --lib 2>&1 | tail -10`
Expected: all tests pass (the dump calls are no-ops when `MAPLE_STAGE_DUMP` is unset).

- [ ] **Step 6: Commit**

```bash
git add src/raw-pipeline/raw-core/src/pipeline.rs
git commit -m "feat(raw-core): pipeline.rs dumps Image after each post-demosaic stage

Calls dump_after(\"NN_<stage_name>\", &image) after every stage that
produces or modifies the in-flight Image. No-op when stage-dump feature
is off; no-op when MAPLE_STAGE_DUMP is unset; non-fatal when a write
fails. Stage names are zero-prefixed so a directory listing sorts in
pipeline order."
```

---

## Task 9: Smoke-test stage dumping end-to-end with maple-cli

**Files:** none — verification only.

- [ ] **Step 1: Build maple-cli with the feature**

Run:

```bash
cd src/raw-pipeline
cargo build --release -p maple-cli --features raw-core/stage-dump 2>&1 | tail -5
```

Expected: clean build.

(If `maple-cli/Cargo.toml` doesn't propagate the feature, edit `src/raw-pipeline/maple-cli/Cargo.toml` and add `stage-dump = ["raw-core/stage-dump"]` under `[features]`, then rebuild with `--features stage-dump`.)

- [ ] **Step 2: Run a render with MAPLE_STAGE_DUMP set**

Pick a fixture present in `test-fixtures/raws/` — `test_0017.dng` is the one the UITest harness uses, so it's reliable.

```bash
mkdir -p /tmp/maple-stage-trace
MAPLE_STAGE_DUMP=/tmp/maple-stage-trace \
  src/raw-pipeline/target/release/maple-cli render \
  test-fixtures/raws/test_0017.dng --out /tmp/test_0017_out.png
```

Expected: render succeeds; `/tmp/maple-stage-trace/` contains exactly 15 EXR files named `01_baseline_exposure.exr` through `15_nr_color.exr`. `04_profile_gain_table_map.exr` is always written; it's just identical to `03_dcp_apply.exr` when the fixture has no PGTM (the `dump_after` call is unconditional, the stage logic is conditional).

- [ ] **Step 3: Verify the EXRs are readable and have the right dimensions**

```bash
ls /tmp/maple-stage-trace/
python3 -c "
import imageio.v3 as iio
import os
for f in sorted(os.listdir('/tmp/maple-stage-trace')):
    arr = iio.imread(f'/tmp/maple-stage-trace/{f}')
    print(f'{f}: shape={arr.shape}, dtype={arr.dtype}, min={arr.min():.3f}, max={arr.max():.3f}')
"
```

Expected: each EXR has shape `(H, W, 3)`, dtype `float32`, with sensible min/max ranges (e.g. baseline_exposure post-DCP should have values mostly in [0, 1] with some highlights above; agX-equivalent stages don't exist in this dump because we dump pre-AgX scene-linear; the last dumped stage is `15_nr_color` in `SceneLinearRec2020`).

- [ ] **Step 4: Verify the no-op path (feature on, env unset)**

```bash
rm -rf /tmp/maple-stage-trace
mkdir /tmp/maple-stage-trace
unset MAPLE_STAGE_DUMP
src/raw-pipeline/target/release/maple-cli render \
  test-fixtures/raws/test_0017.dng --out /tmp/test_0017_out.png
ls /tmp/maple-stage-trace/
```

Expected: directory is empty (no dumps when env var is unset).

- [ ] **Step 5: No commit — this is verification only.**

---

## Task 10: Build stage_diff.py — per-stage ΔE table

**Files:**
- Create: `src/scripts/stage_diff.py`

- [ ] **Step 1: Write the script**

Create `src/scripts/stage_diff.py`:

```python
#!/usr/bin/env python3
"""Compare two stage-trace dirs and print a per-stage ΔE table.

Usage:
    stage_diff.py <dir_a> <dir_b> [--heatmaps <out_dir>]

For each EXR present in both <dir_a> and <dir_b>:
  1. Load both buffers as float32 RGB.
  2. Convert scene-linear Rec.2020 → Lab via colour-science.
  3. Compute CIEDE2000 per pixel; emit mean / p95 / max + per-channel bias.
  4. Optionally write a heatmap PNG per stage when --heatmaps is given.

Output: column-aligned table sorted by filename (which sorts in pipeline
order due to the NN_ prefix). Largest mean-ΔE row is annotated.

Exit code 0 always — this is a diagnostic, not a gate.
"""

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import imageio.v3 as iio
import colour


def load_exr_rec2020(path: Path) -> np.ndarray:
    """Load an EXR and return its pixels as (H, W, 3) float32 in
    scene-linear Rec.2020 D65 (the working colorspace of raw-core)."""
    arr = iio.imread(str(path))
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError(f"{path}: expected 3-channel EXR, got shape {arr.shape}")
    return arr[:, :, :3].astype(np.float32)


def diff_stage(a: np.ndarray, b: np.ndarray) -> dict:
    """Compute mean/p95/max ΔE₀₀ + per-channel bias between two
    scene-linear Rec.2020 buffers. Both must be the same shape."""
    if a.shape != b.shape:
        return {"error": f"shape mismatch: {a.shape} vs {b.shape}"}

    # Rec.2020 scene-linear → CIE XYZ → Lab. colour-science's RGB_to_XYZ
    # with Rec.2020 colourspace handles the matrix.
    cs = colour.RGB_COLOURSPACES["ITU-R BT.2020"]
    a_xyz = colour.RGB_to_XYZ(a.clip(0, None), cs.whitepoint, cs.whitepoint, cs.matrix_RGB_to_XYZ)
    b_xyz = colour.RGB_to_XYZ(b.clip(0, None), cs.whitepoint, cs.whitepoint, cs.matrix_RGB_to_XYZ)
    a_lab = colour.XYZ_to_Lab(a_xyz)
    b_lab = colour.XYZ_to_Lab(b_xyz)
    dE = colour.delta_E(a_lab, b_lab, method="CIE 2000")
    bias = (a - b).mean(axis=(0, 1))
    return {
        "mean_dE":  float(np.mean(dE)),
        "p95_dE":   float(np.percentile(dE, 95)),
        "max_dE":   float(np.max(dE)),
        "bias_r":   float(bias[0]),
        "bias_g":   float(bias[1]),
        "bias_b":   float(bias[2]),
        "dE_array": dE,  # used by heatmap writer
    }


def write_heatmap(stage: str, dE: np.ndarray, out_dir: Path) -> Path:
    """Write a viridis-style heatmap PNG. Caps at ΔE=10 for color stability."""
    cap = 10.0
    norm = np.clip(dE / cap, 0.0, 1.0)
    # Cheap viridis-ish: blue (low) → green → yellow → red (high).
    r = np.clip(norm * 2.0 - 0.5, 0, 1)
    g = np.clip(np.where(norm < 0.5, norm * 2, 2 - norm * 2), 0, 1)
    b = np.clip(1.0 - norm * 2.0, 0, 1)
    rgb = (np.stack([r, g, b], axis=-1) * 255).astype(np.uint8)
    out_path = out_dir / f"{stage}_dE.png"
    iio.imwrite(str(out_path), rgb)
    return out_path


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("dir_a", type=Path)
    p.add_argument("dir_b", type=Path)
    p.add_argument("--heatmaps", type=Path, help="optional output directory for ΔE heatmap PNGs")
    args = p.parse_args()

    if not args.dir_a.is_dir() or not args.dir_b.is_dir():
        print(f"error: both {args.dir_a} and {args.dir_b} must exist", file=sys.stderr)
        return 2

    if args.heatmaps:
        args.heatmaps.mkdir(parents=True, exist_ok=True)

    a_files = {f.name for f in args.dir_a.glob("*.exr")}
    b_files = {f.name for f in args.dir_b.glob("*.exr")}
    common = sorted(a_files & b_files)
    only_a = sorted(a_files - b_files)
    only_b = sorted(b_files - a_files)

    print(f"{'stage':<32} {'mean':>7} {'p95':>7} {'max':>8} {'bR':>9} {'bG':>9} {'bB':>9}")
    print("-" * 92)

    rows = []
    for name in common:
        try:
            a = load_exr_rec2020(args.dir_a / name)
            b = load_exr_rec2020(args.dir_b / name)
            res = diff_stage(a, b)
        except Exception as e:
            print(f"{name:<32} ERROR {e}")
            continue
        if "error" in res:
            print(f"{name:<32} {res['error']}")
            continue

        stage = name[:-4]  # strip .exr
        rows.append((stage, res))
        print(f"{stage:<32} {res['mean_dE']:7.3f} {res['p95_dE']:7.3f} {res['max_dE']:8.3f} "
              f"{res['bias_r']:+9.5f} {res['bias_g']:+9.5f} {res['bias_b']:+9.5f}")

        if args.heatmaps:
            write_heatmap(stage, res["dE_array"], args.heatmaps)

    if rows:
        worst_stage, worst = max(rows, key=lambda r: r[1]["mean_dE"])
        print("-" * 92)
        print(f"# worst-mean stage: {worst_stage} ({worst['mean_dE']:.3f})")

    if only_a:
        print(f"# only in {args.dir_a}: {', '.join(only_a)}")
    if only_b:
        print(f"# only in {args.dir_b}: {', '.join(only_b)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x src/scripts/stage_diff.py
```

- [ ] **Step 3: Verify imports resolve**

Run: `python3 -c "import imageio.v3, colour, numpy; print('ok')"`
Expected: `ok`. If `imageio` is missing, install: `pip3 install --user imageio[freeimage] colour-science`.

- [ ] **Step 4: Sanity-check the script's --help**

Run: `src/scripts/stage_diff.py --help`
Expected: usage text printed; exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/stage_diff.py
git commit -m "feat(scripts): stage_diff.py — per-stage ΔE between two stage-traces

Reads two MAPLE_STAGE_DUMP=<dir> outputs and prints mean/p95/max/bias
per stage. Optional --heatmaps writes a per-stage ΔE PNG. Diagnostic
only — exit code is always 0."
```

---

## Task 11: Integration test — diff a trace against itself

**Files:**
- Create: `src/scripts/stage_diff_test.py`

- [ ] **Step 1: Write the test**

Create `src/scripts/stage_diff_test.py`:

```python
#!/usr/bin/env python3
"""Integration test for stage_diff.py: diffing a trace against itself
must produce all-zero ΔE. Diffing two intentionally different traces
must produce non-zero ΔE on the differing stage.

Run: python3 src/scripts/stage_diff_test.py
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import imageio.v3 as iio


REPO_ROOT = Path(__file__).resolve().parents[2]


def write_synthetic_exr(path: Path, color: tuple[float, float, float]) -> None:
    arr = np.full((4, 4, 3), color, dtype=np.float32)
    iio.imwrite(str(path), arr)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        a = Path(tmp) / "a"
        b = Path(tmp) / "b"
        a.mkdir()
        b.mkdir()
        # Stage 1 same in both, stage 2 different.
        write_synthetic_exr(a / "01_same.exr", (0.5, 0.5, 0.5))
        write_synthetic_exr(b / "01_same.exr", (0.5, 0.5, 0.5))
        write_synthetic_exr(a / "02_different.exr", (0.5, 0.5, 0.5))
        write_synthetic_exr(b / "02_different.exr", (0.6, 0.5, 0.5))

        result = subprocess.run(
            ["python3", str(REPO_ROOT / "src/scripts/stage_diff.py"), str(a), str(b)],
            capture_output=True, text=True, check=True,
        )
        out = result.stdout
        print(out)

        # Parse the two stage rows.
        lines = [l for l in out.splitlines() if l.startswith("01_") or l.startswith("02_")]
        assert len(lines) == 2, f"expected 2 stage rows, got {len(lines)}: {lines}"

        same_row = next(l for l in lines if "01_same" in l)
        diff_row = next(l for l in lines if "02_different" in l)

        # Mean ΔE column is field index 1 (0-based) when split on whitespace.
        same_mean = float(same_row.split()[1])
        diff_mean = float(diff_row.split()[1])

        assert same_mean < 0.01, f"identical stages should have ΔE ≈ 0, got {same_mean}"
        assert diff_mean > 1.0, f"differing stages should have ΔE > 1, got {diff_mean}"

        # Worst-stage annotation
        assert "worst-mean stage: 02_different" in out, \
            f"expected '02_different' as worst stage, got: {out}"

    print("stage_diff_test: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: Run the test**

Run: `python3 src/scripts/stage_diff_test.py`
Expected: prints the diff table; final line `stage_diff_test: OK`; exit 0.

- [ ] **Step 3: Commit**

```bash
git add src/scripts/stage_diff_test.py
git commit -m "test(scripts): stage_diff_test.py — synthetic two-stage diff verification

Identical stages must produce ΔE ≈ 0; differing stages must produce
ΔE > 1; the worst-mean stage annotation must surface the difference."
```

---

## Task 12: Heatmap smoke test on real fixture data

**Files:** none — verification only.

- [ ] **Step 1: Generate two real stage-traces from the same fixture (should diff to ~0)**

```bash
rm -rf /tmp/trace-a /tmp/trace-b
mkdir -p /tmp/trace-a /tmp/trace-b

MAPLE_STAGE_DUMP=/tmp/trace-a \
  src/raw-pipeline/target/release/maple-cli render \
  test-fixtures/raws/test_0017.dng --out /tmp/test_0017_a.png

MAPLE_STAGE_DUMP=/tmp/trace-b \
  src/raw-pipeline/target/release/maple-cli render \
  test-fixtures/raws/test_0017.dng --out /tmp/test_0017_b.png
```

- [ ] **Step 2: Diff the two traces (deterministic pipeline → all stages should be ~0)**

```bash
src/scripts/stage_diff.py /tmp/trace-a /tmp/trace-b --heatmaps /tmp/heatmaps
```

Expected: every stage shows mean ΔE < 0.01 (deterministic pipeline; only float-rounding noise); per-stage `*_dE.png` heatmaps in `/tmp/heatmaps/` are uniformly black.

- [ ] **Step 3: Inspect a heatmap visually**

```bash
open /tmp/heatmaps/03_dcp_apply_dE.png  # macOS
```

Expected: solid black/dark image (no perceptible difference; ΔE ≈ 0 across the frame).

- [ ] **Step 4: No commit — verification only.**

---

## Self-review checklist

- [ ] **Spec coverage:**
  - Phase 0 deliverable 1 (unify color gate) → Tasks 1, 2, 4, 5 ✓
  - Phase 0 deliverable 2 (per-stage diagnostic) → Tasks 6, 7, 8, 9 ✓
  - Phase 0 deliverable 3 (stage-diff Python tool) → Tasks 10, 11, 12 ✓
  - Per-fixture × per-case budget table → Task 3 ✓
  - `MAPLE_STAGE_DUMP` env var → Task 7 (`dump_dir()`) + Task 8 (read once at first dump call) ✓
  - 8 EXRs minimum on a single fixture → Task 9 step 2 verifies ≥ 14 stages dumped ✓
  - Heatmap PNG generation → Task 10 (`write_heatmap`) + Task 12 (smoke test) ✓
  - Old script retired → Task 1 ✓

- [ ] **Placeholder scan:** No "TODO", "TBD", "implement later" anywhere. Each step has exact code or exact commands.

- [ ] **Type consistency:**
  - `dump_after(name, &image)` signature consistent across pipeline.rs (Task 8) and module-internal calls.
  - `dump_image(name, image, dir)` consistent in `stage_dump.rs` (Task 7) and called by `dump_after` (Task 8).
  - `dump_dir() -> Option<PathBuf>` matches the `if let Some(dir) = ...` consumer in `dump_after`.
  - `budgets.json` schema (`{"version": 1, "fixtures": { "<fixture>": { "<case>": { mean, p95, max, bias } } } }`) used identically by `tools/budget_init.py` (Task 3) and the Python heredoc in `test_color_pipeline.sh` (Task 4).
  - `breach` field on `row` dict added in Task 4 step 4; consumed in Task 4 step 5.
