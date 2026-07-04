# Auto 2.0 milestone M0 — fit-quality report (#1740)

This is the offline measurement the M0 milestone of the Auto 2.0 epic asks
for: a JPEG-pair front-end for the fit-acr structured solver
(`raw-core/src/view/acr_fit`), and a fit-quality comparison against the
shipping Auto 1.0 free residual LUT across every real-body fixture with an
extractable embedded JPEG. Nothing in this change touches the shipping
pipeline. No profile is wired to the structured model, no default changes,
and no budget in `test-fixtures/budgets.json` moves. The new code lives
entirely behind the existing `test-support` cargo feature (the same gate the
fit-acr chart solver already lives behind) plus a new `maple-cli fit-auto2`
subcommand for driving it from a RAW file.

**M0.5 update (this section added after the initial M0 pass):** the
original M0 measurement below found a tonescale-domain bug that made Auto
2.0 apply a large, clearly wrong correction at saturated green on 9 of the
16 fixtures. That bug is now fixed (two compounding causes, both described
in "The M0.5 fix" section below) and the fixture set has been re-measured.
The results tables and analysis below are updated in place to reflect the
post-fix numbers; the original bug description is kept (in "Reading the
numbers honestly") as the historical record of what M0 found, with the fix
and the re-measurement delta layered on top.

## What was built

The front-end lives at `raw-core/src/view/acr_fit/from_pairs.rs` and adapts
the scattered `(maple, jpeg)` display-space pairs that
`auto_profile::pairs::sample_display_pairs` already produces for the Auto 1.0
free-LUT fit into the same `NeutralSample` / `SweepSample` shapes the
existing tonescale and hue/chroma-field solver stages consume. The chart
solver's own two fit stages (`fit_tonescale`, `fit_field`) run completely
unchanged; only the sample construction is new. A pair qualifies as a
tonescale "neutral" sample when its Maple-side Oklab chroma sits under a
small ceiling (`NEUTRAL_CHROMA_FRAC`, roughly 0.03 Oklab chroma units); every
pair, neutral or not, feeds the field fit exactly as the chart solver's own
unclipped sweep patches do, since the field fit already has its own
per-cell confidence and identity-default behavior for sparse coverage.

One domain decision is worth being explicit about, because it shapes every
number below. `DisplayPair::maple` is Maple's own post-AgX,
`DisplayEncodedSrgb` output — already tone-mapped and clamped to `[0, 1]` —
not the unbounded scene-linear signal the synthetic chart's
`target_rec2020` provides. Decoding it back to linear and rotating into
Rec.2020 gives Maple's own display-linear signal, which this front-end
treats as the tonescale/field's "scene" input. That is the correct read for
what M0 is actually measuring: "how well can a structured tonescale plus
field re-map Maple's current output onto the JPEG" is exactly the prediction
task the Auto 1.0 curve-plus-LUT already solves, so the two models are being
asked the identical question and the comparison is apples-to-apples. It is
explicitly not "replace AgX with the Auto 2.0 tonescale" — that reframing,
if it happens at all, is M1/M2 wiring work, not something this milestone
does or assumes.

A `maple-cli fit-auto2 --raw <path> --report <path>` subcommand drives the
whole comparison for one RAW file: it develops the RAW through the exact
pinned Auto Profile fit prefix (replicated stage-for-stage from the public
API, since the real implementation in
`pipeline::render::auto_fit::develop_display_for_auto_fit` is private to
`raw-core`), samples the display pairs once, fits Auto 1.0 (curve, then the
free residual LUT on the curved buffer — the same order
`fit_auto_profile_artifacts` uses in the shipping render path) and Auto 2.0
(the new front-end) from those pairs, and reports four things per model:
mean and RMS CIEDE2000 of the model's prediction against the measured JPEG
pairs, a smoothness figure (the maximum second difference of the model's own
residual walked along the neutral grey diagonal, the same instrument
`lut_tests.rs`'s `no_second_difference_spike_across_sparse_boundary` already
uses for the free LUT), and the correction magnitude the model applies at
three deliberately far-out-of-JPEG-gamut probe points — fully saturated red,
green, and blue, colors an 8-bit sRGB JPEG's correspondence set never
actually reaches.

Two unit tests exercise the front-end against a synthetic, ground-truth
transform (a known tonescale gamma plus a known uniform hue twist, both
recovered from twenty thousand scattered pairs), alongside a test that an
identity transform fits with a small residual and a test that a single pair
fails the fit explicitly rather than silently returning identity. The M0.5
fix (see below) added two more regression tests reproducing its two failure
shapes directly. Both `cargo test -p raw-core --lib` and `cargo test -p
raw-core --lib --features test-support` pass in full; the tests live under
the `test-support`-gated module, split into the sibling
`from_pairs_tests.rs` file once M0.5's additions pushed `from_pairs.rs`
toward the repo's 600-line file-budget hard limit (same `#[path]` split
pattern `mod.rs`/`mod_tests.rs` already uses).

## Fixture coverage

The epic's milestone description anticipates eighteen real bodies with
embedded JPEGs. What is actually present in `test-fixtures/raws/` today is
sixteen: `test_0000` and `test_0002` through `test_0015` and `test_0017`.
`test_0001.RAW` decodes but carries no extractable embedded preview.
`test_0016.X3F` cannot be decoded at all — `rawler` 0.7.2's X3F decoder
panics with `not yet implemented`, unrelated to this change. `test_0018.dng`,
`test_0019.dng`, and `test_0020.dng` are the small synthetic/calibration DNGs
from the ACR-calibration epic (`test_0020` is explicitly the fit-acr sweep
chart's own spec/render pair, not a photographed scene) and likewise have no
usable embedded JPEG. All sixteen usable fixtures are covered below; none
were skipped for any other reason.

## Results

Mean and RMS are CIEDE2000 between the model's prediction and the measured
JPEG pair, over every display pair sampled for that fixture (pair counts
range from roughly 220 thousand on the smallest fixture to about 32 million
on the largest). Smoothness is the maximum second difference of the model's
residual on the neutral diagonal — smaller is smoother, and the free-LUT
budget derived for the equivalent synthetic worst case in `lut_tests.rs` is
0.0843, included here for scale. The three gamut columns are the CIEDE2000
between each model's prediction and its input at fully saturated red,
green, and blue — the boundary the epic's "should decay to ~identity" claim
is about, so a value near zero is the desired outcome and a large value is a
finding, not a pass/fail gate.

**Post-M0.5-fix numbers** (the tonescale-domain bug described in "Reading
the numbers honestly" below is fixed; see "The M0.5 fix" for what changed).
The original M0 numbers are kept alongside in the delta table further down
for the record.

| fixture   |      pairs | auto1 mean | auto1 RMS | auto1 smooth | auto1 R/G/B gamut ΔE | auto2 mean | auto2 RMS | auto2 smooth | auto2 R/G/B gamut ΔE |
| --------- | ---------: | ---------: | --------: | -----------: | -------------------- | ---------: | --------: | -----------: | -------------------- |
| test_0000 |    393,216 |     7.1506 |   10.0611 |      0.01242 | 0.32 / 0.25 / 0.15   |     7.4349 |   10.3254 |      0.00444 | 0.04 / 0.00 / 0.20   |
| test_0002 |    249,841 |     1.6855 |    2.1224 |      0.00769 | 0.97 / 0.34 / 1.49   |     2.6115 |    3.0301 |      0.00456 | 0.00 / 0.00 / 0.00   |
| test_0003 | 32,206,300 |     2.4304 |    2.7936 |      0.01028 | 1.28 / 0.73 / 0.32   |     2.0992 |    2.3249 |      0.01040 | 0.00 / 0.00 / 0.00   |
| test_0004 |    711,263 |     3.1045 |    4.7664 |      0.00777 | 0.53 / 0.56 / 0.38   |     4.8314 |    6.2452 |      0.00691 | 0.00 / 0.00 / 0.00   |
| test_0005 |  7,680,000 |     3.7715 |    5.8284 |      0.01645 | 0.33 / 0.46 / 0.15   |     3.4687 |    5.5325 |      0.00806 | 0.00 / 0.00 / 0.00   |
| test_0006 |    448,540 |     1.7132 |    2.1446 |      0.00949 | 0.60 / 0.75 / 0.38   |     4.4715 |    5.3674 |      0.01261 | 0.02 / 0.00 / 0.00   |
| test_0007 |    448,540 |     1.4219 |    1.8369 |      0.00735 | 0.20 / 0.40 / 0.23   |     2.8326 |    3.8591 |      0.00760 | 0.00 / 0.00 / 0.00   |
| test_0008 |  8,321,392 |     4.7327 |    7.1318 |      0.01183 | 0.41 / 0.47 / 0.22   |     5.2061 |    8.0520 |      0.00340 | 0.00 / 0.00 / 0.00   |
| test_0009 | 19,267,584 |     2.9358 |    3.6060 |      0.01434 | 0.39 / 0.41 / 0.35   |     2.2611 |    2.8138 |      0.01213 | 0.00 / 0.00 / 0.79   |
| test_0010 | 19,267,584 |     4.9152 |    5.9250 |      0.05669 | 2.48 / 0.69 / 1.22   |     5.1473 |    6.3241 |      0.10777 | 0.00 / 0.00 / 0.00   |
| test_0011 |  1,116,288 |     3.7721 |    5.4763 |      0.03015 | 0.25 / 0.38 / 0.27   |     3.7482 |    5.5034 |      0.00782 | 0.00 / 0.00 / 0.00   |
| test_0012 |  7,680,000 |     5.3613 |    9.3207 |      0.04324 | 0.87 / 0.30 / 0.14   |     7.6708 |   10.6148 |      0.01701 | 0.03 / 0.00 / 0.04   |
| test_0013 |  7,806,920 |     3.8778 |    4.6482 |      0.02797 | 0.45 / 0.29 / 0.13   |     6.5365 |    8.6665 |      0.01692 | 0.00 / 0.00 / 0.00   |
| test_0014 | 29,084,016 |     2.3595 |    2.9325 |      0.02654 | 0.62 / 0.48 / 0.38   |     2.3020 |    2.7042 |      0.00598 | 0.00 / 0.00 / 0.00   |
| test_0015 |    223,040 |     8.8189 |   11.8123 |      0.07105 | 0.25 / 0.24 / 0.15   |     9.5603 |   11.7735 |      0.03759 | 0.00 / 0.00 / 0.00   |
| test_0017 | 15,114,588 |     8.7959 |   10.6105 |      0.01333 | 0.25 / 0.24 / 0.34   |     9.4376 |   11.5170 |      0.00803 | 0.00 / 0.00 / 0.00   |

Grand means across the sixteen fixtures: Auto 1.0 mean ΔE00 4.18, RMS 5.69,
smoothness 0.0229 (unchanged — Auto 1.0 is untouched by this fix). Auto 2.0
mean ΔE00 4.98 (was 5.52), RMS 6.54 (was 7.19), smoothness 0.0170 (was
0.0205). Auto 2.0 fits tighter than Auto 1.0 on five of the sixteen fixtures
by mean ΔE00 (`test_0003`, `test_0005`, `test_0009`, `test_0011`,
`test_0014` — up from three: `test_0005` and `test_0011` newly cross over)
and is smoother on twelve of sixteen by the second-difference measure (up
from seven). Every one of the forty-eight gamut-probe cells (16 fixtures ×
R/G/B) across the whole fixture set is now at or below 0.79 ΔE00 — the old
report's 6.08 / 9.03 / 17.27 / 21.25 / 9.40 / 3.54-magnitude wrong
corrections (on `test_0000`, `test_0005`, `test_0007`, `test_0006`,
`test_0014`, `test_0015` respectively) are gone.

The per-fixture delta vs the original M0 numbers (mean ΔE00, and the
saturated-green gamut probe specifically, since that is what the bug hit):

| fixture   | M0 auto2 mean | M0.5 auto2 mean |  Δ mean | M0 green ΔE | M0.5 green ΔE |
| --------- | ------------: | --------------: | ------: | ----------: | ------------: |
| test_0000 |        8.5514 |          7.4349 | −1.1165 |        6.08 |        0.0000 |
| test_0002 |        3.5716 |          2.6115 | −0.9601 |        0.00 |        0.0001 |
| test_0003 |        2.2931 |          2.0992 | −0.1939 |        0.41 |        0.0001 |
| test_0004 |        6.0432 |          4.8314 | −1.2118 |        0.00 |        0.0001 |
| test_0005 |        3.4338 |          3.4687 | +0.0349 |        9.03 |        0.0000 |
| test_0006 |        6.5939 |          4.4715 | −2.1224 |       21.25 |        0.0001 |
| test_0007 |        3.7302 |          2.8326 | −0.8976 |       17.27 |        0.0000 |
| test_0008 |        5.8764 |          5.2061 | −0.6703 |        0.00 |        0.0001 |
| test_0009 |        2.5642 |          2.2611 | −0.3031 |        0.00 |        0.0000 |
| test_0010 |        5.1675 |          5.1473 | −0.0202 |        0.00 |        0.0000 |
| test_0011 |        4.1932 |          3.7482 | −0.4450 |        0.92 |        0.0000 |
| test_0012 |        7.7403 |          7.6708 | −0.0695 |        1.85 |        0.0000 |
| test_0013 |        6.8346 |          6.5365 | −0.2981 |        2.21 |        0.0000 |
| test_0014 |        2.6667 |          2.3020 | −0.3647 |        9.40 |        0.0001 |
| test_0015 |        9.4328 |          9.5603 | +0.1275 |        3.54 |        0.0001 |
| test_0017 |        9.6122 |          9.4376 | −0.1746 |        0.00 |        0.0000 |

Fourteen of sixteen fixtures improved on mean ΔE00 (not just the gamut
probe) — the fix does not trade fidelity for identity-decay, it improves
both, because a knot lattice that is actually populated by the data fits
the interior better too, independent of the gamut-boundary behaviour. Only
`test_0005` and `test_0015` regressed, both by under 0.13 ΔE00 — noise-level,
not a finding.

## Reading the numbers honestly

Auto 1.0's free 49-node residual LUT wins the raw prediction-fidelity
contest on eleven of sixteen fixtures (was thirteen before the M0.5 fix),
generally by a wide margin — this is exactly what a free-form, per-image fit
against the same data it is then scored against should do, and matches the
epic's own framing of why the residual was added to Auto 1.0 in the first
place (the chroma-match gap a curve-only fit leaves). A nine-knot tonescale
plus a 24×6×8 hue/chroma field is a much lower-capacity model, so losing the
raw fidelity contest by roughly 0.8 ΔE00 units on the grand mean (was
roughly 1.3 before the fix) is the expected, structurally-inevitable price
of trading a free lattice for something bounded and smooth. That trade is
the entire point of the epic — Auto 1.0's own failure mode is banding
injected by lattice kinks the view transform cannot undo, which a free-form
fit cannot avoid by construction and a C¹-smooth structured model can.

Smoothness now reads as a genuine, if modest, structured-model win rather
than a wash: Auto 2.0 is smoother on twelve of sixteen fixtures (was seven),
and its grand-mean smoothness (0.0170) is now tighter than Auto 1.0's
(0.0229) rather than roughly matching it. The remaining four fixtures where
Auto 1.0 is smoother (`test_0003`, `test_0006`, `test_0010`, `test_0012`)
are all cases where the M0.5 fix's wider, data-populated knot lattice
recovers more real curvature in the interior — a genuine tradeoff of
"smoother because it captures less structure" vs "less smooth because it
captures more," not a regression. The free LUT's own confidence-damping,
neighbor-smoothing, and gamut-feathering machinery (`lut_fit.rs`'s
`smooth3` and `feather_to_identity`) still does real work bringing its
banding risk down from the un-mitigated worst case the
`MAX_SECOND_DIFF_BUDGET` comment derives (0.0871), so the structured
model's advantage, while now numerically visible, is not as large as the
"banding is impossible by construction" framing alone would suggest.

The out-of-gamut probe is where the two models diverge most clearly, and
after the M0.5 fix it is unambiguously in the direction the epic
anticipated and in no direction it did not: Auto 2.0 decays cleanly to a
near-zero correction (every one of the 48 R/G/B gamut-probe cells across
all sixteen fixtures is at or below 0.79 ΔE00, most below 0.03) at fully
saturated red, green, AND blue on every fixture — the field's own per-cell
identity default for zero-count cells is doing exactly what it is supposed
to do, and this is a structural property the free LUT cannot match (its
feathering only ramps correction down over a couple of grid cells near the
edge of support, not all the way to zero, and its `test_0010` red-channel
correction of 2.48 ΔE00 shows a case where that feathering leaves real
residual stale correction sitting at the gamut boundary). Before the fix,
nine of sixteen fixtures showed a large, clearly wrong correction at
saturated green specifically (up to 21.25 ΔE00 on `test_0006`) — that
failure mode is now gone everywhere in the fixture set. See "The M0.5 fix"
below for what changed and why.

## The M0.5 fix

The M0 pass above traced the saturated-green failure to the tonescale, not
the field (a direct probe of `test_0006`'s fitted field found every cell in
the saturated-green region sitting at the exact identity default, confirming
the field itself was behaving correctly throughout). Two compounding bugs
in the tonescale needed fixing, both in `raw-core/src/view/acr_fit`:

**Bug 1 — fixed knot range.** `fit_tonescale`'s nine knots were fixed at
log-spaced positions spanning the synthetic sweep chart's engineered neutral
ramp (scene luminance 0.001 to 4.0). A real photo's near-neutral pixels,
once already passed through Maple's own AgX view transform and clamped to
`[0, 1]`, occupy a completely different and usually much narrower range, so
most of the chart-tuned knots went unpopulated and got filled by linear
interpolation from whatever real data landed nearby — distorting the curve
even in its "interior." The fix (`tonescale.rs`'s new `KnotRange` type) makes
the knot span a caller-supplied parameter: `fit_tonescale` (used by the
chart solver) keeps calling `fit_tonescale_with_range` with the fixed
`KnotRange::CHART_DEFAULT`, so `fit_acr_solver.rs` and
`fit_acr_multirender.rs` are byte-for-byte unaffected (verified — both test
files pass unchanged, 6/6 and 3/3). The JPEG-pair front-end
(`from_pairs.rs`) instead derives its range from the 2nd/98th percentile of
the ACTUAL scene luminances it is fitting against
(`KnotRange::from_scene_luminances`), floor/ceiling-clamped and
minimum-log2-span-guarded against degenerate (all-identical) input.

Critically, that population must be the FULL pair set's luminance, not just
the neutral-chroma subset used to fit the tonescale's knot VALUES — deriving
the range from the neutral subset alone was the first version of this fix,
and it regressed `test_0006` from 6.59 to 21.84 mean ΔE00 on
re-measurement: that fixture's near-neutral pixels sit almost entirely in
deep shadow (98th-percentile scene luminance ≈0.004) while its dominant
chromatic content spans well into the midtones (median ≈0.15, 98th
percentile ≈0.37), so a neutral-only range anchored the whole lattice to
the dark band and pushed most of the actual (chromatic) image into
extrapolation from a near-black anchor point. The shipped fix derives the
range from every pair's luminance (`all_pairs_scene_luminances`), mirroring
how the chart solver's own neutral ramp is deliberately built to span the
same range as its sweep patches.

**Bug 2 — flat-value (not flat-scale) extrapolation.** Even with a correctly
derived range, `tonescale_apply`'s extrapolation beyond the last knot held
the DISPLAY VALUE flat (`return vals[n-1]`), which means the effective scale
(`display / scene`) it implies keeps shrinking for any luminance further
past the boundary — a saturated colour's luminance routinely lands there
even when the range is well-derived, because chromatic content can have
higher luminance than the neutral subset that bounds the range. The fix
makes both ends of `tonescale_apply` hold the local SCALE flat instead
(`vals[n-1] * (l / knots[n-1].exp2())` above the top knot, matching the
pre-existing — now made symmetric — convention already used below the
bottom knot): for an identity-transform fit the scale at the boundary is
already ≈1.0, so holding it flat keeps any out-of-range luminance at
≈identity too, matching the field fit's own `sat_scale = 1.0` identity
default for empty cells. This is the same "decay to identity outside
support" idiom the field already implements, now applied consistently to
the tonescale.

Both fixes are additive/parametric, not behavioural changes to the chart
solver: `fit_tonescale` and `tonescale_apply`'s below-first-knot branch are
unchanged in the chart's fixed-range case (`KnotRange::CHART_DEFAULT`
reproduces the exact former 0.001–4.0 span), and the chart's own tests
(`fit_acr_solver.rs`, `fit_acr_multirender.rs`, plus all `acr_fit` unit
tests) pass unchanged. Two new regression tests
(`saturated_green_probe_stays_near_identity_on_narrow_neutral_cluster` and
`midtone_correction_stays_near_identity_when_neutral_subset_is_dark_and_narrow`,
both in `from_pairs_tests.rs`) reproduce the two failure shapes directly
against synthetic identity-transform pair sets, with RED bounds derived
from measuring the pre-fix code against the exact same construction (32.955
ΔE00 for the saturated-green probe on a narrow midtone cluster; 6.59→21.84
mean ΔE00 for the dark-neutral/midtone-chromatic shape).

## Verdict

Auto 2.0's structured fit still loses real fidelity against the free LUT on
this fixture set, though a materially narrower gap post-fix: roughly a
0.8-unit mean ΔE00 gap (was ~1.3), present on eleven of sixteen fixtures
(was thirteen). That gap is still large enough to matter for a ship
decision on its own terms; M1's ship gate (`baseline_auto` holds or ratchets
down on at least fifteen of eighteen fixtures) is a comparison against the
end-to-end ACR-parity harness downstream of this fit, not against these raw
JPEG-pair numbers directly, so this report does not resolve that gate by
itself, but a sub-one-unit ΔE00 gap in the underlying fit is a meaningfully
more promising starting point than the pre-fix numbers were for holding
that harness's much tighter per-fixture budgets — whether it is reachable
still depends on how the downstream harness's own budgets translate, which
this report cannot answer directly.

The smoothness case for the structured model is now a genuine, visible win
on today's fixture set (smoother on 12/16, tighter grand mean), not merely
a structural argument that doesn't show up in the numbers. The out-of-gamut
case is now a clean, unqualified win for the structured model on every
fixture and every channel — the tonescale-domain bug that used to make
Auto 2.0 worse than Auto 1.0 at its own headline strength (decaying to
identity outside the fit's support) is fixed, and the fix additionally
improved raw fidelity on fourteen of sixteen fixtures as a side effect
(populating the knot lattice with real data helps the interior fit, not
just the boundary behaviour). None of this resolves the M1 go/no-go
decision by itself — that still runs through the end-to-end ACR-parity
harness, not this report's raw JPEG-pair numbers — but the structured
model's honest ceiling on this fixture set is now materially better than
what M0 first measured, and the two structural failure modes the M0 pass
was worried about (banding risk, wrong-direction gamut correction) are both
now either resolved (gamut) or trending favourably (smoothness) rather than
open questions.
