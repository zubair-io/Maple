# Per-zone ΔE diagnostics + test_0003 baseline hardening — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the color harness a per-tonal-zone and per-hue ΔE2000 breakdown (consolidated from existing scattered scripts into the canonical `compare_images.py`), then use it to diagnose and harden test_0003's `mean ΔE 6.26` baseline.

**Architecture:** `compare_images.py` becomes the one diff implementation, exposing `diff(cand, ref, *, zones, hue_bins) -> dict`. `test_color_pipeline.sh` stops inlining its own copy and imports it **in-process** (no per-case subprocess — that was the 15-min regression the inline copy exists to avoid), gaining a `ZONES=1` diagnostic mode. Gating stays on the existing global budgets. Then Component 2 renders test_0003 `--profile neutral`, runs the new breakdown + the existing `diff_heatmap.py`, and writes a findings note whose signature gates the (separately-planned) fix.

**Tech Stack:** Python 3 (numpy, Pillow, colour-science — already in `src/scripts/requirements.txt`; no matplotlib), bash, `maple-cli`.

**Source spec:** `docs/superpowers/specs/2026-06-03-perzone-deltae-harness-and-baseline-hardening-design.md`

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/scripts/compare_images.py` | Modify | Add `diff()`, `_zone_stats()`, `_hue_stats()`; `main()` calls `diff()`. The one diff implementation. |
| `src/scripts/compare_images_test.py` | Create | Plain-assert tests (run via `python3`): return-key stability, synthetic attribution, zone self-consistency. |
| `src/scripts/test_color_pipeline.sh` | Modify | Replace inlined `diff_inline` with in-process `import compare_images`; add `ZONES=1` breakdown printout. Gating unchanged. |
| `src/scripts/per_luma_band.py` | Modify (Task 3, optional) | Reduce to thin wrapper over `compare_images.diff(..., zones=True)` (DRY). |
| `src/scripts/per_band_hue.py` | Modify (Task 3, optional) | Reduce to thin wrapper over `compare_images.diff(..., zones=True, hue_bins=...)` (DRY). |
| `docs/superpowers/findings/2026-06-03-test_0003-baseline.md` | Create (Task 4) | The diagnosis signature that gates the fix. |

**Reused as-is (do NOT reimplement):** `src/scripts/diff_heatmap.py` (spatial ΔE heatmap + quadrants, ICC-aware) is used directly in Task 4.

---

## Task 1: Canonical `diff()` with zones + hue bins in `compare_images.py`

**Files:**
- Modify: `src/scripts/compare_images.py`
- Test: `src/scripts/compare_images_test.py`

Conventions to match: existing `*_test.py` files (`stage_stats_test.py`, `stage_diff_test.py`) are plain-assert scripts run via `python3 src/scripts/<name>_test.py`, not pytest. Binning is on the **reference** Lab (ground truth), candidate is Lanczos-resized to reference dims (matches the harness's current `diff_inline` and `per_band_hue.py`).

- [ ] **Step 1: Write the failing test**

Create `src/scripts/compare_images_test.py`:

```python
#!/usr/bin/env python3
"""Tests for compare_images.diff(). Run: python3 src/scripts/compare_images_test.py

Synthetic-image checks:
  * return-key stability (the harness depends on these exact keys)
  * identical images -> ~zero deltaE everywhere
  * a localized (red, highlight) shift surfaces in the right zone + hue bin
    and stays ~zero elsewhere (attribution)
  * population-weighted mean of zone means reconstructs the global mean
"""
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
import compare_images as ci


def _write(path, arr_u8):
    Image.fromarray(arr_u8, "RGB").save(path)


def _checker_highlight_red(h=64, w=64):
    """Neutral mid-grey background (L*~50, MID zone); a bright reddish block
    (L*~77, HIGHLIGHT zone, red/orange hue) in one quadrant. The block color
    is chosen so it lands in the highlight L* band AND carries real chroma —
    a pure bright red (230,40,40) is only L*~50 and would fall in MID."""
    img = np.full((h, w, 3), 120, dtype=np.uint8)        # neutral mid grey
    img[: h // 2, : w // 2] = (250, 170, 160)            # bright reddish (highlight)
    return img


def test_return_keys():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "a.png"
        _write(p, _checker_highlight_red())
        out = ci.diff(str(p), str(p))
        for k in ("mean_deltaE", "p95_deltaE", "max_deltaE",
                  "bias_r", "bias_g", "bias_b", "n_pixels"):
            assert k in out, f"missing key {k}"
        assert out["mean_deltaE"] < 1e-3, out["mean_deltaE"]


def test_attribution():
    with tempfile.TemporaryDirectory() as d:
        ref_p = Path(d) / "ref.png"
        cand_p = Path(d) / "cand.png"
        ref = _checker_highlight_red()
        cand = ref.copy()
        # Perturb ONLY the bright-red block (highlight zone, red hue).
        cand[:32, :32, 0] = 200          # pull red down -> color shift there
        _write(ref_p, ref)
        _write(cand_p, cand)
        out = ci.diff(str(cand_p), str(ref_p), zones=True, hue_bins=12)

        # The grey background (mid zone, neutral hue) must be ~untouched.
        assert out["zones"]["mid"]["mean_deltaE"] < 0.5, out["zones"]["mid"]
        # The highlight zone (where the red block lives) must light up.
        assert out["zones"]["highlight"]["mean_deltaE"] > 3.0, out["zones"]["highlight"]
        # Some chromatic hue bin must carry the error; the neutral bucket must not.
        max_bin = max((b for b in out["hue_bins"]["bins"] if b["n"] > 0),
                      key=lambda b: b["mean_deltaE"])
        assert max_bin["mean_deltaE"] > 3.0, max_bin
        assert out["hue_bins"]["neutral"]["mean_deltaE"] < 0.5, out["hue_bins"]["neutral"]


def test_zone_self_consistency():
    with tempfile.TemporaryDirectory() as d:
        ref_p = Path(d) / "ref.png"
        cand_p = Path(d) / "cand.png"
        ref = _checker_highlight_red()
        rng = np.random.default_rng(0)
        cand = np.clip(ref.astype(np.int16) + rng.integers(-15, 15, ref.shape),
                       0, 255).astype(np.uint8)
        _write(ref_p, ref)
        _write(cand_p, cand)
        out = ci.diff(str(cand_p), str(ref_p), zones=True)
        zones = [z for z in out["zones"].values() if z.get("n", 0) > 0]
        total = sum(z["n"] for z in zones)
        recon = sum(z["mean_deltaE"] * z["n"] for z in zones) / total
        assert abs(recon - out["mean_deltaE"]) < 1e-3, (recon, out["mean_deltaE"])


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
    print("all compare_images tests passed")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 src/scripts/compare_images_test.py`
Expected: FAIL — `AttributeError: module 'compare_images' has no attribute 'diff'`.

- [ ] **Step 3: Implement `diff()` + zone/hue helpers**

Edit `src/scripts/compare_images.py`. Keep the module docstring and imports. Replace the body (the `load_srgb`/`main` section) with:

```python
# L*-based tonal zones (perceptual; matches the Lab space ΔE lives in).
ZONE_NAMES = ("shadow", "mid", "highlight")
ZONE_EDGES = (0.0, 33.3, 66.6, 100.001)
NEUTRAL_CHROMA = 5.0  # C* below this -> hue is ill-defined, goes to neutral bucket


def _lab(srgb: np.ndarray) -> np.ndarray:
    return colour.XYZ_to_Lab(colour.sRGB_to_XYZ(srgb))


def _zone_stats(dE, ref_lab, cand, ref) -> dict:
    L = ref_lab[..., 0].ravel()
    dEf = dE.ravel()
    cf = cand.reshape(-1, 3)
    rf = ref.reshape(-1, 3)
    zones = {}
    for name, lo, hi in zip(ZONE_NAMES, ZONE_EDGES[:-1], ZONE_EDGES[1:]):
        m = (L >= lo) & (L < hi)
        n = int(m.sum())
        if n == 0:
            zones[name] = {"n": 0}
            continue
        b = (cf[m] - rf[m]).mean(axis=0)
        zones[name] = {
            "n": n,
            "mean_deltaE": float(dEf[m].mean()),
            "p95_deltaE": float(np.percentile(dEf[m], 95)),
            "max_deltaE": float(dEf[m].max()),
            "bias_r": float(b[0]), "bias_g": float(b[1]), "bias_b": float(b[2]),
        }
    return zones


def _hue_stats(dE, cand_lab, ref_lab, n_bins: int) -> dict:
    a = ref_lab[..., 1].ravel()
    b = ref_lab[..., 2].ravel()
    C = np.hypot(a, b)
    dEf = dE.ravel()
    da = (cand_lab[..., 1] - ref_lab[..., 1]).ravel()
    db = (cand_lab[..., 2] - ref_lab[..., 2]).ravel()

    neu = C < NEUTRAL_CHROMA
    if neu.any():
        neutral = {"n": int(neu.sum()), "mean_deltaE": float(dEf[neu].mean()),
                   "a_shift": float(da[neu].mean()), "b_shift": float(db[neu].mean())}
    else:
        neutral = {"n": 0}

    hue = np.degrees(np.arctan2(b, a)) % 360.0
    width = 360.0 / n_bins
    chromatic = ~neu
    bins = []
    for i in range(n_bins):
        lo, hi = i * width, (i + 1) * width
        m = chromatic & (hue >= lo) & (hue < hi)
        n = int(m.sum())
        if n == 0:
            bins.append({"bin_deg": [round(lo, 1), round(hi, 1)], "n": 0})
            continue
        bins.append({
            "bin_deg": [round(lo, 1), round(hi, 1)], "n": n,
            "mean_deltaE": float(dEf[m].mean()),
            "a_shift": float(da[m].mean()), "b_shift": float(db[m].mean()),
        })
    return {"neutral": neutral, "bins": bins}


def diff(cand_path: str, ref_path: str, *, zones: bool = False,
         hue_bins: int = 0) -> dict:
    """ΔE2000 + per-channel bias of candidate vs reference, optionally with
    per-tonal-zone and per-hue-angle breakdowns. Candidate is Lanczos-resized
    to the reference dims. All binning is on the reference's Lab."""
    ref_im = Image.open(ref_path).convert("RGB")
    cand_im = Image.open(cand_path).convert("RGB")
    if cand_im.size != ref_im.size:
        cand_im = cand_im.resize(ref_im.size, Image.LANCZOS)
    cand = np.asarray(cand_im, dtype=np.float32) / 255.0
    ref = np.asarray(ref_im, dtype=np.float32) / 255.0

    cand_lab = _lab(cand)
    ref_lab = _lab(ref)
    dE = colour.delta_E(cand_lab, ref_lab, method="CIE 2000")
    bias = (cand - ref).mean(axis=(0, 1))

    out = {
        "mean_deltaE": float(np.mean(dE)),
        "p95_deltaE": float(np.percentile(dE, 95)),
        "max_deltaE": float(np.max(dE)),
        "bias_r": float(bias[0]), "bias_g": float(bias[1]), "bias_b": float(bias[2]),
        "n_pixels": int(cand.shape[0] * cand.shape[1]),
    }
    if zones:
        out["zones"] = _zone_stats(dE, ref_lab, cand, ref)
    if hue_bins:
        out["hue_bins"] = _hue_stats(dE, cand_lab, ref_lab, hue_bins)
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("candidate")
    p.add_argument("reference")
    p.add_argument("--zones", action="store_true")
    p.add_argument("--hue-bins", type=int, default=0)
    args = p.parse_args()
    try:
        out = diff(args.candidate, args.reference,
                   zones=args.zones, hue_bins=args.hue_bins)
    except Exception as e:  # noqa: BLE001 — CLI surfaces error as JSON
        print(json.dumps({"error": str(e)}))
        return 2
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

Note: `Image.MAX_IMAGE_PIXELS = None` must be set so the 4000px/12288px ACR refs don't trip Pillow's decompression-bomb guard. Add `from PIL import Image` already present; add `Image.MAX_IMAGE_PIXELS = None` right after the imports.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 src/scripts/compare_images_test.py`
Expected: PASS — `ok test_attribution` / `ok test_return_keys` / `ok test_zone_self_consistency` / `all compare_images tests passed`.

- [ ] **Step 5: Sanity-check on a real pair (no-drift on the JSON CLI)**

Run:
```bash
python3 src/scripts/compare_images.py \
  test-fixtures/references/test_0003/down/baseline.png \
  test-fixtures/references/test_0003/down/baseline.png
```
Expected: `{"mean_deltaE": 0.0, ... "n_pixels": <int>}` (identical image → zero). Then run with `--zones --hue-bins 12` and confirm a `zones`/`hue_bins` block appears and is all-zero ΔE.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/compare_images.py src/scripts/compare_images_test.py
git commit -m "feat(scripts): per-zone + per-hue deltaE breakdown in compare_images.diff()"
```

---

## Task 2: Harness imports `compare_images` in-process + `ZONES=1` mode

**Files:**
- Modify: `src/scripts/test_color_pipeline.sh`

The harness's inlined `diff_inline` (lines ~153–177) and `compare_images.diff()` are now duplicate math. Replace the inline copy with an in-process import (the `compare_py` path is already passed as argv[3]). **Performance constraint:** import once, call per-case in-process — do **not** shell out per case.

- [ ] **Step 1: Capture the pre-refactor baseline (the no-drift gate)**

Run and save the grand-mean for one fixture:
```bash
FILTER=test_0003/baseline ALLOW_MISSING_BUDGET=1 src/scripts/test_color_pipeline.sh | tail -1
```
Expected: a JSON line; record its `grand_mean_deltaE` (≈ 6.26). Step 4 must reproduce it bit-for-bit.

- [ ] **Step 2: Edit the harness — env wiring**

In `src/scripts/test_color_pipeline.sh`, after the other env reads (near `ALLOW_MISSING_BUDGET=...`, ~line 54), add:
```bash
ZONES="${ZONES:-}"
HUE_BINS="${HUE_BINS:-12}"
```
Change the python invocation (line ~135) to pass them as two extra argv:
```bash
python3 - "$MANIFEST" "$CANDIDATES_DIR" "$COMPARE_PY" "$PREFERRED_RES" "$FILTER" "$BUDGETS" "$ALLOW_MISSING_BUDGET" "$ZONES" "$HUE_BINS" <<'PY'
```

- [ ] **Step 3: Edit the harness — replace `diff_inline` with the import**

In the heredoc, change the argv unpack (line ~149) to:
```python
manifest_path, cand_dir, compare_py, preferred_res, name_filter, budgets_path, allow_missing, zones_flag, hue_bins_s = sys.argv[1:10]
allow_missing = bool(allow_missing)
zones_on = bool(zones_flag)
hue_bins = int(hue_bins_s) if zones_flag else 0
```
Delete the entire `def diff_inline(...)` block (lines ~153–177) and replace with:
```python
sys.path.insert(0, os.path.dirname(os.path.abspath(compare_py)))
import compare_images  # the one diff implementation
```
At the call site (line ~237), change:
```python
        metrics = compare_images.diff(cand_path, ref_path,
                                      zones=zones_on, hue_bins=hue_bins)
```
Then store the breakdowns on the row so they can be printed when `zones_on`:
```python
    row["zones"] = metrics.get("zones")
    row["hue_bins"] = metrics.get("hue_bins")
```
(add these two lines where `row = {...}` is populated, ~line 254).

- [ ] **Step 4: Edit the harness — print the breakdown under `ZONES=1`**

Immediately after the per-fixture aggregate block (after line ~297, before the grand aggregate), add:
```python
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
```

- [ ] **Step 5: Run — confirm no-drift + the new mode**

Run (no-drift — must equal Step 1's grand mean):
```bash
FILTER=test_0003/baseline ALLOW_MISSING_BUDGET=1 src/scripts/test_color_pipeline.sh | tail -1
```
Expected: identical `grand_mean_deltaE` to Step 1.

Run (the new diagnostic):
```bash
ZONES=1 FILTER=test_0003/baseline ALLOW_MISSING_BUDGET=1 src/scripts/test_color_pipeline.sh
```
Expected: normal table, then a `ZONE / HUE BREAKDOWN` section with shadow/mid/highlight rows and per-hue rows for `test_0003/baseline`.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/test_color_pipeline.sh
git commit -m "feat(scripts): harness imports compare_images in-process + ZONES=1 breakdown"
```

---

## Task 3 (optional hygiene — DRY): fold `per_luma_band.py` / `per_band_hue.py` into wrappers

Skippable without affecting Component 2. Only `aligned_harness.sh` mentions `per_luma_band` (in a comment), so reducing these to wrappers preserves their CLIs while killing the duplicated math.

- [ ] **Step 1:** Rewrite `src/scripts/per_luma_band.py` body to call `compare_images.diff(cand, ref, zones=True)` and print the `zones` block as its current JSON shape; keep the `--bands` arg by mapping to the canonical zones (document that the canonical zones are L* terciles, not 10 luma bands — if 10 bands are still wanted by a caller, leave `per_luma_band.py` unchanged and skip this step).
- [ ] **Step 2:** Rewrite `src/scripts/per_band_hue.py` to call `compare_images.diff(..., zones=True, hue_bins=12)` and render its table from the returned dict.
- [ ] **Step 3:** Run each on a real pair; confirm output is sane.
- [ ] **Step 4: Commit** `chore(scripts): per_luma_band/per_band_hue delegate to compare_images (DRY)`.

---

## Task 4: Diagnose test_0003 (produces the signature that gates the fix)

**Files:**
- Create: `docs/superpowers/findings/2026-06-03-test_0003-baseline.md`

This task is an investigation, not a code change. Its deliverable is a written signature.

- [ ] **Step 1: Confirm the resolved profile source.** Run a stage trace / inspect to record what color path test_0003 actually takes (bundle hit for the Canon EOS 5DS R vs synthetic fallback; ForwardMatrix present or ColorMatrix-only/Bradford):
```bash
cd src/raw-pipeline && cargo run --release -p raw-core --example stage-trace -- \
  ../../test-fixtures/raws/test_0003.CR2 6000 4000
```
Record which profile/matrix path fires.

- [ ] **Step 2: Render + per-zone/per-hue breakdown.**
```bash
ZONES=1 FILTER=test_0003/baseline ALLOW_MISSING_BUDGET=1 \
  src/scripts/test_color_pipeline.sh | tee /tmp/test_0003_zones.txt
```

- [ ] **Step 3: Spatial localization (reuse the existing tool).**
```bash
KEEP_TMP=1 FILTER=test_0003/baseline src/scripts/test_color_pipeline.sh   # note the candidate dir it prints
python3 src/scripts/diff_heatmap.py \
  <candidates_dir>/test_0003_baseline.png \
  test-fixtures/references/test_0003/down/baseline.png \
  ~/Desktop/maple-color-tests/test_0003/
```
(Per saved-output convention, heatmaps land under `~/Desktop/maple-color-tests/test_0003/`.)

- [ ] **Step 4: Write the findings note.** Create `docs/superpowers/findings/2026-06-03-test_0003-baseline.md` recording: the resolved profile path (Step 1), the dominant zone(s)/hue bin(s) carrying the 6.26 (Step 2), the spatial concentration (Step 3), and the **classified signature** per the spec's decision tree:
  - **hue-specific (e.g. reds/oranges)** → missing per-camera 2D HSM → fix branch = source the 5DS R HSM + measure;
  - **broad uniform a*/b* cast** → matrix/profile-target mismatch → fix branch = ACR pinned re-render to identify the target;
  - **broad-in-highlights** → AgX view-transform floor → fix branch = document + ratchet to floor.

- [ ] **Step 5: Commit the findings.**
```bash
git add docs/superpowers/findings/2026-06-03-test_0003-baseline.md
git commit -m "docs(findings): test_0003 baseline diagnosis signature"
```

---

## Re-plan gate (the fix)

**STOP after Task 4.** The fix tasks are authored from the Task 4 signature, not before — pre-naming the fix would repeat the RFC's HueSatMap mistake (see spec). Bring the findings note back; the next planning pass writes the concrete fix tasks for the identified branch, ending in: re-measure with `ZONES=1`, ratchet `test_0003`'s `budgets.json` entry down to the achieved ceiling, and run the full `src/scripts/test_color_pipeline.sh` for no-regression across the other 15 fixtures. Per CONTRIBUTING, open the Files-board tickets (tooling + ACR-parity) before the fix PR; each PR carries `Closes #N`.

---

## Self-review

**Spec coverage:**
- Per-zone + per-hue instrument, reference-Lab binning, neutral bucket → Task 1. ✓
- Single source of truth (harness stops inlining) → Task 2. ✓
- `ZONES=1` diagnostic mode, gating unchanged → Task 2. ✓
- Three instrument self-checks (no-drift, self-consistency, attribution) → Task 1 (attribution, self-consistency) + Task 2 Step 1/5 (no-drift). ✓
- Spatial heatmap → reused `diff_heatmap.py` (Task 4 Step 3), not reimplemented (DRY). ✓
- Diagnose test_0003: render → localize → resolve profile target → classify → ratchet → no-regression → Task 4 + re-plan gate. ✓
- Fix not pre-named → re-plan gate. ✓
- No per-zone gates / no Apple-Web / no value-collapse → none added. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"; every code step has complete code. The fix being deferred is an explicit evidence-gate (spec-mandated), not a placeholder.

**Type consistency:** `diff()` returns keys `mean_deltaE/p95_deltaE/max_deltaE/bias_r/bias_g/bias_b/n_pixels` (unchanged from the old `diff_inline`, so the harness's `metrics["mean_deltaE"]` → `row["mean"]` mapping still holds), plus optional `zones` (dict keyed by `shadow/mid/highlight`, each with `n/mean_deltaE/p95_deltaE/max_deltaE/bias_r/bias_g/bias_b`) and `hue_bins` (`{neutral, bins[]}` with `bin_deg/n/mean_deltaE/a_shift/b_shift`). Task 2 reads exactly these. ✓
