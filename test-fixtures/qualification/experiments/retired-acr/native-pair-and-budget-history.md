# Retired ACR gate history

### Explicit native-pair comparison

A qualified nonbaseline case can declare
`"reference_protocol": "native-pair-lanczos-v1"` in its manifest entry (#4788).
This requires an `acr_xmp` Adobe authoring sidecar with every audited default
explicit, matching effective settings in the saved PNGs, a native `full`
reference, native candidate dimensions, and compatible full/down geometry.
Unknown protocol names, missing native pixels, and ignored Adobe settings fail
the comparison. Installing a full PNG does not switch an undeclared legacy
case. Full-resolution detail still compares every native pixel.

The corpus identity includes the protocol declaration, authoring bytes,
reference bytes, and comparison implementation, including its helper modules.
Capture qualification and old/new physical measurements remain prerequisites
for adopting this declaration. Protocol support does not complete the corpus
migration tracked by #3678 or represent a renderer improvement.

### The one-way ratchet

`test-fixtures/budgets.json` holds a `{version, fixtures: {<fixture>: {<case>: {mean, p95, max, bias}}}}` table. All four metrics are ceilings, so lower is stricter. **Budgets only go down**, and a budget drops in the same commit that delivers the improvement.

[`tools/check_budget_ratchet.py`](../tools/check_budget_ratchet.py) is the gate. Per cell present on the base branch: a raised ceiling fails, and a _removed_ cell fails too (dropping a budget silently drops its gate). New cells pass — adding coverage is the ratchet turning the right way. CI resolves the PR merge base, `git show`s that revision's `budgets.json`, and diffs:

```bash
python3 tools/check_budget_ratchet.py --self-test                    # runs unconditionally in CI
python3 tools/check_budget_ratchet.py --base <old.json> --head test-fixtures/budgets.json
```

[`test-fixtures/BUDGETS_DRIFT.md`](../test-fixtures/BUDGETS_DRIFT.md) is the log of budgets that are knowingly held rather than re-baselined — currently fourteen cases across `test_0013` and `test_0018` whose ceilings are frozen at values the harness still breaches, deliberately keeping those rows red rather than papering over a real systematic shift.

**Re-baselining (#2335).** A raise is not always a regression: a legitimate re-capture against a changed default pipeline can ratchet most cells down while genuinely raising a few (#814: 218 down, 41 up), and the gate above has no way to let those 41 through short of disabling the whole required check — which would leave no record at all. Instead, cover each raised cell with a `RE-BASELINE:` marker line, one per cell, in the PR body or the head commit's own message (either is scanned; the commit message is the one that survives "Rebase and merge" into `main`'s permanent history, since the PR body itself does not):

```
RE-BASELINE: test_0013/baseline.max: retuned AgX sigmoid, see #814
RE-BASELINE: test_0018/baseline_auto.p95: same retune, see #814
```

A marker with no justification text after the second colon does not count — the raise it would have covered still fails the gate. Every accepted marker is echoed to the CI log (`N audited RE-BASELINE raise(s)`) so the exception is visible next to the run, not just buried in the PR description; a raise still fails if no marker names its exact `<fixture>/<case>.<metric>` cell. Markers only ever excuse a _raise_ — a removed cell fails regardless, same as always.

### Adding a case

1. Save the native ACR capture to `test-fixtures/references/test_NNNN/full/<case>.png` and its down-resolution counterpart to `test-fixtures/references/test_NNNN/down/<case>.png`, with matching Camera Raw settings.
2. Add the case to `test-fixtures/references/manifest.json`.
3. Run the harness — it fails with `no-budget-entry`.
4. Take the printed `mean / p95 / max / bias` and add a budget entry with roughly 5–10% headroom, or pipe the captured table through [`tools/budget_init.py`](../tools/budget_init.py), which does exactly that (`ceil(x * 1.05)` with floors of 0.5 / 1.0 / 1.0 / 0.005) and emits JSON.
5. Commit the reference, the manifest entry, and the budgets entry together.

`budget_init.py` parses both PASS and FAIL rows, so it is usable on the red run a re-baseline is captured from.

### P3 primaries (#1339, P3 phase 3)

ACR references are sRGB. Once `maple-cli render --target-primaries p3` renders true Display P3 (#1337), the harness can't diff that candidate against an sRGB reference directly — saturated colours would read as "out of budget" everywhere purely from the primaries mismatch, not a real pipeline error. The strategy: render in the target colourspace, **rotate the candidate back to sRGB before the diff**. Same references, same metric — no separate P3 reference set, since the rotation is exact linear-algebra (not a perceptual step), so nothing is lost going through it.

The plumbing landed in this PR — `maple-cli render`/`batch --target-primaries {srgb,p3}` (default `srgb`, byte-identical to the historical behaviour) and `compare_images.py`'s `diff(..., source_primaries="srgb"|"p3")` / `--source-primaries` / `maple-cli diff --source-primaries` — but **no manifest cases or `budgets.json` entries were added**. `test-fixtures/BUDGETS_DRIFT.md` already carries fourteen cases held red pending #814's re-baseline; seeding P3 budgets before that lands would inherit the same unresolved baseline. Adding P3 cases to `test_color_pipeline.sh`'s manifest is a follow-up once #814 is closed, using the same [Adding a case](#adding-a-case) steps above with `--target-primaries p3` on the render side and `--source-primaries p3` on the diff side.

The rotation itself: `pixels_srgb = M_P3→sRGB · pixels_p3`, applied in linear light (decode the shared sRGB OETF, rotate, re-encode) via `compare_images.py`'s `p3_to_srgb_primaries`, where `M_P3→sRGB = inv(M_SRGB_TO_P3)` and `M_SRGB_TO_P3` is copied verbatim from [`raw-core/src/color/matrices.rs::M_SRGB_TO_P3`](../src/raw-pipeline/raw-core/src/color/matrices.rs) — the same matrix `rec2020_to_display(TargetPrimaries::P3)` rotates through, not an independently-derived equivalent. Verify the rotation in isolation, no fixtures or references needed:

```bash
python3 src/scripts/compare_images.py --self-test
```

It checks: the two matrices are true inverses; white round-trips exactly (P3 and sRGB share the D65 white point); a synthetic in-gamut patch round-trips sRGB → P3 → sRGB within float rounding noise; an out-of-sRGB-gamut P3 primary clips into `[0,1]` without NaN; and — through the real `diff()` entry, with two temporary PNGs — a P3-rotated candidate against its own sRGB source reads near-zero ΔE while the same pair diffed _without_ the rotation reads far worse, proving the flag is actually wired into the comparison, not just correct in isolation.
