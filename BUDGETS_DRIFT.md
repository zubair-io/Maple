# Budgets drift log

Informational record of expected harness drift introduced by Wave 3
work that intentionally changes default pipeline behaviour. Budgets in
`test-fixtures/budgets.json` are a one-way ratchet — they only go down,
never up. This file records cases where the default rendering changed
in a way that DOES shift budget numbers, so future per-case drift can
be distinguished from regression.

## post-#429 mid-gray anchor

**Ticket:** #429 — auto-exposure becomes a real scene-anchor (was a
no-op).

**Default behaviour change:** `AdjustmentModel::auto_exposure` defaults
to `AutoExposureMode::On`. The stage now measures the geometric mean of
luma in the middle 50% percentile band of the post-DCP scene-linear
Rec.2020 image and multiplies pixels by `clamp(0.18 / midgrey, max=8.0)`
before AgX. Every scene lands at the same point on the AgX sigmoid by
default. User `exposure` stacks additively in EV on top.

**Expected drift direction:** Mid-toned reference scenes (anything with
a midgrey near 0.18 — the bulk of `test-fixtures/references/`) should
see negligible movement (anchor gain ≈ 1.0). Brighter scenes (sky-heavy,
beach, snow) anchor with a `gain < 1.0` and will render DARKER vs ACR;
darker scenes (interior, low-key portraits) anchor with `gain > 1.0` and
render BRIGHTER. ACR has its own implicit exposure baseline tied to its
view transform, so absolute parity-to-ACR will move in both directions
depending on the scene's stake position.

**Local harness runs:** the broad end-to-end gate skip-passes in this
environment (no `test-fixtures/raws/` present), so per-case ΔE/bias
deltas were not measured here. Numbers from the next CI run with
fixtures will be appended below.

**Unit / synthetic gates (run locally, all `cargo check`-equivalent
clean):**

- `cargo test -p raw-core --lib` — 601 passed, 0 failed (same as
  baseline).
- `test_synthetic_grey.sh` — 3 passed, 3 failed. Same set of failures
  as baseline (`neutral_display_srgb_005/018/050`); failure values for
  L=0.05 and L=0.50 change because both inputs now anchor to 0.18
  before AgX, but the test predicate (R == G == B at display) was
  already failing pre-change. **No new failures.**
- `test_grey_adjustments.sh` — 5 passed, 12 failed. Baseline was 4
  passed, 13 failed. **One predictor win: `exposure_minus1_predicts`
  now passes** (the user exposure is a clean −1 EV offset on top of
  the scene anchor, and at the anchored 0.18 mid-point the L=0.5
  display value crosses below the `EPS_DISPLAY_LSB=2` neutrality
  budget). `exposure_plus1_predicts` is still failing — display
  channel non-neutrality at the anchored `0.18 × 2 = 0.36` AgX
  position is larger than the budget. `highlights_compresses_above_knee`
  is unchanged — failure value identical to baseline (250/239/252 at
  L=0.95). No tests went from passing to failing; one went from
  failing to passing.
