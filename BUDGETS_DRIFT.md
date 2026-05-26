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

## post-#443 Look LUT retired (final wave 3 step)

**Ticket:** #443 — Wave-3 closing step of #416. Retires the empirical 1D
per-channel u8→u8 DisplayLookCurve (`view::look::apply`) that ran on the
Rust CPU/CLI render path. Apple (CoreImage) and Web (WebGL) have never
applied the LUT, so the LUT was an asymmetry — the parity harness
gated on a path the shipping apps did not exercise.

**Default behaviour change:** `look::apply` is no longer called from
`render_from_raw_*`, `render_from_scene_linear[_with_chain]`, or
`maple-cli`'s tile preview. The `Look` enum + `papp:Look` XMP attribute
stay on `AdjustmentModel` for sidecar back-compat — both variants
(`Default`, `Neutral`) are now identical no-ops at the pipeline level.
Newly-written sidecars with a default-valued model omit `papp:Look`
entirely (the serializer already skipped it on the canonical default).

**Expected drift direction:** ACR ΔE will get worse on every fixture
that had a measurable LUT contribution — the LUT closed ~65% of the
bias-to-ACR gap on the 14 training fixtures (3× MAE reduction; 2× on
held-out). With the LUT removed, the per-fixture `mean` / `p95` / `max`
will rise across the board, particularly on scenes where the empirical
shift was large (deep shadows lifted by ~7 codes on R/G and ~19 codes
on B; highlights compressed by ~5 codes on R, ~3 codes on G, ~0 on B).
Bias-to-ACR moves UP toward zero on the channels where the LUT pushed
us PAST ACR's value, and AWAY from zero on the channels where it was
correcting toward ACR. **This is correct and intentional** — the CI
reference frame moves off ACR per #416's strategic direction. The
closing step of #416 (re-baseline against ColorChecker + AgX-look
golden) is the next follow-up and is out of scope here.

**Budgets.json untouched** per the one-way ratchet. Fixtures-present CI
runs will print `no-budget-entry` / numeric failures on a per-case basis
until the harness migration in the next ticket lands. Until then, any
CI failure on `test-fixtures/budgets.json` after this PR merges should
be read as expected post-#443 drift, not regression.

**Local harness runs (this branch):**

- `cargo test -p raw-core --lib` — **644 passed, 0 failed, 1 ignored.**
  The new `pipeline::render::tests::look_field_is_no_op_post_443`
  regression test passes (`Look::Default` and `Look::Neutral` now
  produce byte-identical output through the view-transform path).
  The retired `view::look::tests::*` (`default_look_is_default_variant`,
  `neutral_is_bit_identical_to_input`,
  `default_lut_changes_buffer_for_non_default_input`,
  `default_lut_per_channel_independent`,
  `lut_arrays_are_monotone_nondecreasing`, `lut_endpoints_are_plausible`,
  `buffer_with_partial_pixel_is_safe`) are gone with the module.
- `test_synthetic_grey.sh` — **6 passed, 0 failed.** Was 3 passed + 3
  failed before this PR; the three previously-failing
  `neutral_display_srgb_005/018/050` cases now pass because the per-
  channel display non-neutrality the LUT introduced (R/G/B floors of
  ~7/~7/~19 at L=0 and ceilings of ~250/~252/~255 at L=255) is gone.
  Removing the LUT is a strict improvement for the synthetic-grey
  invariant ("achromatic input renders as achromatic output").
- `test_grey_adjustments.sh` — **17 passed, 0 failed, 2 ignored.** Was
  5 passed + 12 failed before this PR. Every closed-form predictor
  (`temp_*`, `tint_*`, `exposure_±1`, `highlights_compresses`,
  `shadows_±50`, `whites_±50`, `blacks_±50`, `contrast_plus`,
  `saturation_no_op`, `vibrance_no_op`) now passes. The remaining
  failure (`highlights_compresses_above_knee`: 250/239/252 at L=0.95)
  noted in the #429 entry above is also gone — that asymmetric display
  channel triplet was a Look-LUT artifact at the shoulder. Strict
  improvement.
- `test_color_pipeline.sh` (end-to-end ACR ΔE gate) — **skip-passed**;
  no `test-fixtures/raws/` in this environment. CI run with fixtures
  will produce the visual ΔE drift numbers, which will all move UP per
  the expected-drift discussion above.
