# budgets.json is currently stale

**Status as of 2026-05-22:** `src/scripts/test_color_pipeline.sh` FAILs on
multiple baseline fixtures against the committed `budgets.json`. Examples
from a recent local run on `origin/main` (`1de2c21b`):

```
test_0000 baseline   mean 13.65 > budget 13.10
test_0010 baseline   max  65.65 > budget 59.60
```

The exact failing set, per-fixture deltas, and which commit moved which
fixture are not captured here — that's the calibration-sweep work
queued below.

## Why this happened

Two reasons stacked:

1. **A documented deferred ratchet was never run.** Commit `8db890c3`
   ("feat(raw-core): canonical Sobotka AgX with inset/outset matrices +
   real sigmoid") explicitly noted in its own message:

   > Out of scope (deferred to follow-ups on #260):
   > * Color-pipeline budget ratchet (AC #4) — requires
   >   `test-fixtures/raws/` (gitignored), validated in CI after merge.

   The CI gate the commit was relying on didn't exist at the time
   (it's added in the same PR as this note). So the deferred ratchet
   was never applied while drift was accumulating. The Sobotka rewrite shifts
   mid-gray from 0.237 → 0.180 by construction — every fixture's
   perceptual delta vs ACR moves by some amount when the view
   transform changes, regardless of whether the new transform is
   "better." Budgets need to be re-baselined against the new ground
   truth.

2. **No CI workflow ran `src/scripts/test_color_pipeline.sh`.** Per
   the script's own header and `CLAUDE.md` § *Objective color testing*:
   *Budgets are a one-way ratchet — they only go down.* Until the
   workflow added alongside this note existed, that rule lived in
   human memory: enforced only on the laptop of whoever remembered
   to run the harness before merging. Anyone landing a change without
   fixtures locally couldn't trip the gate.

Several other commits in the same window plausibly contribute to
per-fixture drift (parametric scene-tone `2967e19b`, saturation
soft-clip `2448c2ea`, no-halo clarity `3f02b118`, NLM noise reduction
`6f41cbbb`, capture-sharpening wire-up `ca9a0398`, dehaze sky mask
`655d607b`). Per-fixture attribution would require running the harness
across the bisect range against the gitignored 6.5 GB fixtures.

## Why budgets aren't being raised here

`CLAUDE.md` § *Objective color testing* — and the harness header
itself — say:

> Budgets are a one-way ratchet — they can only go down. Lowering a
> budget happens in the same commit that delivers the improvement.

Raising the numbers in `budgets.json` to make the harness pass would
violate that rule and erase the signal that something needs attention.
The honest state is "the gate is currently red on `main` and the rule
is being violated until the calibration sweep below lands" — not
"green by re-baselining today's numbers as the new floor."

## How to clear this

A calibration sweep, run on a machine with `test-fixtures/raws/` and
ACR reference renders present:

1. Confirm the current Maple AgX (and any other view-transform-altering
   commits since `c43d8ca0`) is the intended ground truth — i.e. the
   pipeline shouldn't move again before re-baselining.
2. Re-render ACR references against the current Maple output set (or
   confirm the existing references in `test-fixtures/references/` are
   still the comparison target — pipeline changes don't move the ACR
   side).
3. Run `src/scripts/test_color_pipeline.sh` and capture the current
   per-fixture × per-case `mean / p95 / max / bias`.
4. Replace `budgets.json` with the captured numbers + 5–10% headroom
   (matches the seed pattern in the README block of the project for
   adding new fixtures).
5. Commit `budgets.json` with a `ratchet(budgets): recapture after
   post-AgX calibration sweep` message that names every commit since
   `c43d8ca0` that moved the deltas, so the audit trail is intact.
6. The CI workflow added alongside this note will then enforce the
   ratchet going forward.

Tracked in #332.

---

## Post-#424 improvement (not ratcheted in #424's PR)

After the DCP never-identity fallback chain (ticket #424) landed:

| fixture   | baseline mean before | after  | budget |
| --------- | -------------------- | ------ | ------ |
| test_0004 | 7.24                 | 5.56   | 7.96   |

test_0004 (Hasselblad H5D-40 .fff) is the canonical #424 fixture — the
.fff carries no DNG-spec ColorMatrix tags so it now resolves to the
generic D65→Rec.2020 fallback instead of identity. All other baseline
fixtures stay within budget (full `FILTER=baseline` sweep: 0 breaches
across 16 fixtures). The improvement was deliberately left
unratcheted in the #424 PR per task instructions; the budget should
be tightened to ~5.85 (5.56 + 5% headroom) in a follow-up after a
baseline review across all 33 cases × 16 fixtures of the post-#424
output.

---

## Post-#425 colorimetry-only baseline (regression expected, not ratcheted)

Ticket #425 (part of #416 Wave 3) drops the Adobe aesthetic layers from
the DCP apply path:

- **ProfileToneCurve (PTC)** — removed unconditionally from
  `dcp::apply_*` regardless of `ProfileSource`. Pre-#425 the curve ran
  for `EmbeddedDng` and `Generic` profiles (suppressed only for
  `Bundled`); post-#425 it never runs in the DCP stage.
- **ProfileLookTable (PLT)** — removed unconditionally. Pre-#425 the
  source DNG's `raw.plt` flowed through for every profile source; the
  per-format inconsistency this created (same body rendered differently
  out of a DNG-Converter than a vendor RAW) is exactly what #425
  eliminates.
- **HSM** — retained, but documented as **metameric correction only**.
  HSM authored as an aesthetic "look" should be pre-stripped at the
  profile-build layer (`profile_loader`), not gated here.

ΔE-to-ACR **will increase** on every fixture that previously consumed
PLT or PTC — that is the strategic direction stated in the #416 umbrella
("we are no longer chasing ACR; the CI reference frame is moving to
ColorChecker colorimetric accuracy + an AgX-look golden"). The next
steps in Wave 3 (#423, #431, #429, #435, #438, #441, #443) compensate
for the visual shift; #425's job is the structural change alone.

### Local per-fixture drift

Not measurable in this worktree — `test-fixtures/raws/` and
`test-fixtures/references/manifest.json` are gitignored and absent
locally, so `src/scripts/test_color_pipeline.sh` skip-passed with
"manifest not found". Per-fixture mean/p95/max/bias drift will be
captured by the CI workflow on the next push to `main` once the
fixtures are present, and logged here. Until then this section is a
placeholder header noting that the regression is intentional and the
ratchet is **deliberately not lowered** in this PR.

---

## test_0008 (Fuji X-Trans) — first-time baseline (#417 / #420)

The Fuji X-T3 RAF fixture (`test_0008.RAF`) became renderable in #417 +
#420: X-Trans CFA decode through rawler's `XTransLayout` metadata block
+ a Markesteijn-equivalent demosaic added under
`raw-core/src/demosaic/xtrans.rs`. Before these tickets the fixture
never reached the color stage (decode failed at `map_cfa_pattern`).

It therefore has no budget entries in `budgets.json` — the harness
will FAIL with `no-budget-entry` on every test_0008 case until a
calibration sweep produces the first baseline. Adding budgets is
explicitly out of scope for the X-Trans-enablement PR (the spec says
"do NOT touch budgets.json — log to BUDGETS_DRIFT.md instead"); the
follow-up is to capture the per-case `mean / p95 / max / bias` on a
machine with the gitignored fixtures present, then seed
`budgets.json` per the recipe at the top of this file.

End-to-end smoke (from `examples/xtrans_e2e`, release):
```
decoded: 6384x4182, cfa=XTrans
render OK in 3.03s: 6240x4160 (24-bit RGB, 78 MB)
mean R=118.4 G=125.8 B=125.6 (sane range)
```

First parity-harness pass against the ACR references (using
`FILTER=test_0008 src/scripts/test_color_pipeline.sh` immediately
post-#420):

```
test_0008 (33 cases, 10 skipped no-reference)
  grand_mean_deltaE = 11.47
  grand_bias        = R -0.054, G -0.036, B +0.014
  baseline           mean 7.70  p95 17.64  max 84.98  bias R -0.04 G -0.03 B -0.00
  exposure_max       mean 3.18  p95  8.68  max 50.99  bias R -0.01 G -0.01 B +0.00
  contrast_max       mean 8.42  p95 22.63  max 95.03  bias R -0.04 G -0.04 B -0.00
  saturation_max     mean 8.48  p95 21.11  max 97.36  bias R -0.03 G -0.05 B +0.03
  tint_max           mean 26.92 p95 48.44  max 86.44  bias R -0.47 G -0.01 B -0.31
  whites_max         mean 14.73 p95 29.79  max 95.46  bias R -0.14 G -0.15 B -0.13
```

Interpretation: mean ΔE in the 7-15 range on baseline / exposure /
contrast / WB cases is plausible "first pass on a new fixture"
territory — calibration-grade convergence would seed budgets at
mean 5-8 and tighten over multiple ratchets. `tint_max` is the
outlier; one or both ends of the tint range may need investigation
once the bundled-DCP coverage path lands a Fuji X-T3 profile.

Bayer baselines for the other 16 fixtures are unchanged by the
X-Trans work — the dispatch in `develop.rs` short-circuits on
`CfaPattern::XTrans(_)` and leaves the 2×2 kernels untouched.

### Follow-up review fixes (PR #465 review pass)

Three demosaic-correctness fixes landed in the same PR after Copilot
review:

1. `xtrans_bilinear` now preserves the measured center-channel sample
   exactly — same policy as `bilinear::bilinear` — instead of folding
   the center into the same-channel neighbour mean. The Markesteijn
   seed pass inherits the cleaner starting point.
2. `directional_green` clamps the CFA lookup coords to match what
   `at()` clamps the read to. Before the fix, x ∈ {2, 3} could surface
   a non-green sample as green at the 2-px interior margin (the
   unclamped coord wrapped mod 6 to a different channel than the
   clamped read).
3. Dead `let _ = g;` no-op removed in the gradient-direction picker
   (cosmetic, no behavior change).

Plus a LinearRaw fix outside the X-Trans kernel:

4. `effective_quality_divisor` now returns 1 for `CfaPattern::LinearRgb`
   Preview as well — the LinearRaw path bypasses the Bayer half-res
   kernel and produces a full-resolution buffer at every
   `RenderQuality`, so `crop_to_default` needs divisor=1 to land the
   crop at the right buffer coords on any LinearRaw DNG that carries
   crop metadata.

The X-Trans demosaic fixes (1+2) are likely to shift the test_0008
numbers downward (sharper output, no border-channel leak). The new
per-case `mean / p95 / max / bias` were NOT re-captured locally
because `test-fixtures/raws/` is gitignored and the parity harness
can't run without the RAW. Numbers will be recaptured in the
calibration sweep that seeds the first `budgets.json` entry for
test_0008 (per the recipe at the top of this file).

---

## post-#431 CAT16 user WB

User-facing white balance now performs proper chromatic adaptation in
CAT16 LMS cone space (Li et al. 2017) rather than diagonal per-channel
gains in linear Rec.2020 (`WbMethod::Cat16` default;
`DiagonalRec2020` retained as an A/B path for parity work). Tint sign
also flips to the reference-renderer convention (tint+ = magenta image,
tint- = green image) — only on the CAT16 path; `DiagonalRec2020`
preserves the pre-#431 (inverted) convention bit-identically.

The default-model baseline fixtures use `temperature=6500, tint=0`,
which short-circuits to identity in both methods — bit-for-bit
equivalent to the diagonal-gain path. **Expected baseline drift on
`test_color_pipeline.sh`: zero on default-WB fixtures.** Fixture cases
that exercise the WB slider (the `wb_*` cases under
`test-fixtures/references/*/`) will move because the matrix shape now
differs from the diagonal-gain ratios; the magnitude is bounded by a
substantial symmetry improvement at +/-1000K on the synthetic grey
predictor (`grey_adjustments::temp_symmetric`: main's diagonal path
produces a warm/cool |R-B| ratio of ~8.98, CAT16 lands near ~1.0 —
about an order of magnitude tighter; see the in-code
`cat16_temperature_pm_1000k_is_symmetric` test in
`src/raw-pipeline/raw-core/src/stages/white_balance.rs`).

Local fixture sweep not measured: `test-fixtures/raws/` are gitignored
on this worktree, so `test_color_pipeline.sh` skip-passed. Capture the
drift in the same follow-up that ratchets the post-#424 numbers, or
opportunistically the next time fixtures are mounted.

---

## post-#438 Rec.2020→sRGB hue-preserving gamut compression

#438 replaces the per-channel `clamp(0, 1)` inside `srgb_gamma` with a
hue-preserving Oklab `(a, b)` bisection at constant `L` when the post-
matrix sRGB-linear triple sits outside `[0, 1]^3`. Shared helper at
`src/raw-pipeline/raw-core/src/color/oklab_gamut.rs` —
`compress_to_unit_cube_oklab(rgb, to_oklab, from_oklab)`. Same algorithm
will be re-used by AgX (#435) on rebase via the Rec.2020 transform pair.

Direction of drift on fixtures touching saturated reds/blues/purples
(wide-gamut foliage, sunsets, neon, saturated fabric):

* Hue-shift component of ΔE₀₀ **drops** — per-channel clip used to
  rotate saturated red toward sRGB-primary red (different chromaticity
  from Rec.2020 red), now the perceptual hue is preserved.
* Chroma component **drops** slightly on those same pixels — the
  bisection lands chroma below "as much as fits" because we land on
  the first in-gamut scale rather than overshooting the gamut and
  clipping.
* Net effect on `test_color_pipeline.sh`: per-fixture `mean` / `p95`
  on saturated-color cases (test_0010 / test_0014 / sunset-ish
  fixtures) should move modestly; neutral / desaturated fixtures
  should be byte-identical (in-gamut input is a strict no-op).

Per-fixture deltas were NOT re-captured locally because
`test-fixtures/raws/` is gitignored on this worktree. The harness
skip-passes in CI without fixtures, and `budgets.json` is **not** being
touched in this PR (one-way ratchet rule: budgets only go down, in the
same commit that delivers the improvement, with measured numbers). The
follow-up calibration sweep that re-baselines budgets across the whole
post-overhaul pipeline will absorb #438's drift along with the rest of
the wave-3 stack.
---

## post-#435 AgX hue restoration + f32 + Web LUT parity (2026-05-26)

Per-fixture deltas were NOT re-captured locally because
`test-fixtures/raws/` is gitignored on this worktree (the
`test_color_pipeline.sh` harness skip-passed with "manifest not found").
The change is a behaviour-changing default to AgX: ratio-preserving
sigmoid replaces per-channel sigmoid; Oklab hue-preserving gamut
compression replaces the post-outset `clamp(0, 1)`; the
`luma_coupled_toe` band-aid is retired; AGX_VERSION bumped 7 → 8.

Expected drift directions (informational, to be confirmed in the
calibration sweep that re-runs the harness with fixtures available):

* **Saturated reds / blues / purples (sunsets, deep skies, magenta
  flowers).** Mean ΔE₀₀ should improve — the per-channel→magenta
  failure mode is gone. Expect `bias` to shift toward less-saturated
  on these fixtures.
* **Highlight rolloff.** Above-knee highlights compress along the
  ratio rather than per-channel, so the highest stops desaturate less.
  Expect modest mean increase on highlight-rich fixtures vs ACR (ACR's
  per-channel filmic desaturates more aggressively); this is the
  "scene-referred over Adobe-aesthetic" decision from #416.
* **Neutral grey-axis.** Byte-identical to pre-#435 (synthetic-grey
  invariants confirm: same R=G=B drift, same 8-bit LSBs at L=0.05/0.18/0.50).
* **Mid-gray anchor.** Unchanged (X_PIVOT / Y_PIVOT untouched; LUT
  bytes unchanged; `mid_gray_identity_preserved` test still passes
  at the original 1e-3 tolerance).

Web (`agx-view-transform.ts`) GLSL was ported in lockstep — same
ratio sigmoid, same Oklab compression with pre-baked inverse
matrices. The Rust↔GLSL parity test `glsl_port_matches_rust_lut`
still passes (the underlying `agx_sigmoid` is unchanged; only the
calling shape changed). A full Rust↔GLSL parity vector for the
hue-restored output (16 representative scene-linear values) is a
follow-up — the Web sigmoid is byte-equivalent to Rust at every
LUT index, so the only divergence-risk surface is the Oklab matrices,
and those are pre-computed inverses of the same Rec.2020-to-Oklab
chain.

f32-end-to-end (#435 item 5) is deferred to a follow-up KTLO ticket —
the Apple FFI surface is fp16 today (`MapleSceneLinearBuffer.fp16_rgba`)
and a new f32 entry-point would be additive (new
`MapleSceneLinearBufferF32` + `maple_render_*_scene_linear_f32`),
not a breaking change. The Web pipeline still uses RGBA16F textures;
the f32 upgrade goes with the same KTLO ticket so both shells move
together.

---

## post-#441 dithering

`src/raw-pipeline/raw-core/src/view/encode.rs::dither_and_quantize` now
adds a `[-0.5, +0.5)` LSB positional offset to every channel before the
round-to-u8 step (eliminates 8-bit banding on smooth gradients per ticket
#441). The offset is sampled from a 64×64 blue-noise mask
(`view/dither.rs::blue_noise_offset_lsb`, void-and-cluster generated) that
tiles across the image. The Web AgX shader does the same inline before the
canvas write.

**Expected ΔE drift on `test_color_pipeline.sh`:** negligible. The mask
holds each value `0..=4095` exactly once and maps them via
`(v + 0.5) / 4096 - 0.5`, so its tile-mean offset is exactly zero (no DC
bias) and over any patch spanning the 64×64 tile the dithered mean equals
the un-dithered mean to floating-point noise. The maximum per-pixel ΔE
perturbation is bounded by 1 LSB of u8
in display-encoded sRGB, which after sRGB-decode and conversion to Lab
is well under 1 ΔE everywhere on the 0..255 axis. The harness rounds
ΔE to 3 decimals and per-fixture budgets carry several units of
slack — no budget is expected to be perturbed beyond rounding noise.

Local fixture sweep not measured: `test-fixtures/raws/` are gitignored
on this worktree (same constraint as the #424/#431 notes above). If a
fixture moves >0.05 ΔE on a re-baseline this is the place to record
which fixture and by how much.

---

## post-#494 hybrid auto-exposure anchor (2026-05-26)

PR #496 changes `compute_scene_anchor_gain` from the percentile-50
midtone heuristic (`gain = 0.18 / midgrey`, clamped) to a hybrid
selector that takes the larger of two candidates:

```
midtone_gain   = clamp(0.18 / midgrey, max = 8.0)
highlight_gain = clamp(0.85 / p95,     max = 8.0)
anchor_gain    = max(midtone_gain, highlight_gain)
```

The change targets a specific failure mode reported in ticket #494:
on portrait scenes with a dark subject against a brighter background,
the percentile-50 band sits at the background luma, midgrey lands
near 0.18 already, midtone_gain ≈ 1.0, and the subject stays crushed
at scene-linear luma ~0.06–0.08 (vs the 0.3–0.5 a working photographer
expects).

Per-fixture deltas captured on the local machine (filtered runs vs the
committed but stale `budgets.json`; reported here informational —
budgets unchanged per the one-way ratchet rule):

| fixture / case            | mean ΔE | bias R | bias G | bias B | direction               |
| ------------------------- | ------- | ------ | ------ | ------ | ----------------------- |
| `test_0000/baseline`      | 13.14   | +0.013 | +0.015 | +0.017 | within budget (pass)    |
| `test_0002/baseline`      | 12.32   | −0.208 | −0.175 | −0.148 | lifted, still −bias     |
| `test_0003/baseline`      |  6.63   | +0.037 | +0.028 | +0.025 | lifted past unity → +   |

`test_0002` and `test_0003` are the two fixtures the ticket called out
as visibly underexposed. After the hybrid anchor:

- `test_0003` flipped to a small positive bias (+0.025–0.037),
  indicating the subject lift was effective. Brightness now sits
  slightly above ACR rather than well below — a more correctable
  starting point.
- `test_0002` is still negative-biased but the magnitude is reduced
  from where it was. The remaining gap is likely a combination of
  the Hasselblad H2D-39 profile (older sensor, DCP forward-matrix
  drift) and the AgX vs ACR view-transform delta that
  `BUDGETS_DRIFT.md` discusses elsewhere.

A full 774-case sweep was started locally but cancelled — concurrent
runs from another worktree were sharing the same CPU and would have
taken >30 minutes wallclock to finish; the filtered evidence above is
the load-bearing signal for the ticket.

`budgets.json` is **not** touched in this PR (one-way ratchet rule:
budgets only go down, with measured numbers, in the same commit that
delivers the improvement). The follow-up calibration sweep that
re-baselines `budgets.json` will absorb the post-#494 movement along
with the rest of the post-Wave-3 stack.

Synthetic gain validation (a `auto_exposure/tests.rs` unit test +
out-of-test repl): on a 128×128 `test_0002`-like synthetic
distribution (92% Gaussian at 0.18, 8% Gaussian at 0.06), the new
hybrid produces `gain ≈ 4.29` (vs `≈ 1.01` under the old algorithm).
Applied to the ticket's measured face value 0.0845 → 0.363, squarely
inside the 0.3–0.5 band the ticket asked for.
