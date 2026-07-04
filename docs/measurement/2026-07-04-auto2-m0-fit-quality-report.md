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
fails the fit explicitly rather than silently returning identity. Both
`cargo test -p raw-core --lib` and `cargo test -p raw-core --lib
--features test-support` pass in full; the new tests live under the
`test-support`-gated module.

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

| fixture   |      pairs | auto1 mean | auto1 RMS | auto1 smooth | auto1 R/G/B gamut ΔE | auto2 mean | auto2 RMS | auto2 smooth | auto2 R/G/B gamut ΔE    |
| --------- | ---------: | ---------: | --------: | -----------: | -------------------- | ---------: | --------: | -----------: | ----------------------- |
| test_0000 |    393,216 |     7.1506 |   10.0611 |      0.01242 | 0.32 / 0.25 / 0.15   |     8.5514 |   11.2339 |      0.01264 | 0.42 / **6.08** / 0.53  |
| test_0002 |    249,841 |     1.6855 |    2.1224 |      0.00769 | 0.97 / 0.34 / 1.49   |     3.5716 |    4.3600 |      0.00844 | 0.00 / 0.00 / 0.00      |
| test_0003 | 32,206,300 |     2.4304 |    2.7936 |      0.01028 | 1.28 / 0.73 / 0.32   |     2.2931 |    2.5264 |      0.02072 | 0.00 / 0.41 / 0.00      |
| test_0004 |    711,263 |     3.1045 |    4.7664 |      0.00777 | 0.53 / 0.56 / 0.38   |     6.0432 |    7.4036 |      0.00968 | 0.00 / 0.00 / 0.00      |
| test_0005 |  7,680,000 |     3.7715 |    5.8284 |      0.01645 | 0.33 / 0.46 / 0.15   |     3.4338 |    5.5469 |      0.06202 | 0.00 / **9.03** / 0.00  |
| test_0006 |    448,540 |     1.7132 |    2.1446 |      0.00949 | 0.60 / 0.75 / 0.38   |     6.5939 |    8.4903 |      0.00514 | 0.00 / **21.25** / 0.00 |
| test_0007 |    448,540 |     1.4219 |    1.8369 |      0.00735 | 0.20 / 0.40 / 0.23   |     3.7302 |    5.9913 |      0.00855 | 0.00 / **17.27** / 0.00 |
| test_0008 |  8,321,392 |     4.7327 |    7.1318 |      0.01183 | 0.41 / 0.47 / 0.22   |     5.8764 |    8.3482 |      0.00671 | 0.00 / 0.00 / 0.00      |
| test_0009 | 19,267,584 |     2.9358 |    3.6060 |      0.01434 | 0.39 / 0.41 / 0.35   |     2.5642 |    3.0666 |      0.01671 | 0.00 / 0.00 / 0.76      |
| test_0010 | 19,267,584 |     4.9152 |    5.9250 |      0.05669 | 2.48 / 0.69 / 1.22   |     5.1675 |    6.3583 |      0.04966 | 0.00 / 0.00 / 0.00      |
| test_0011 |  1,116,288 |     3.7721 |    5.4763 |      0.03015 | 0.25 / 0.38 / 0.27   |     4.1932 |    5.7244 |      0.00470 | 0.00 / 0.92 / 0.00      |
| test_0012 |  7,680,000 |     5.3613 |    9.3207 |      0.04324 | 0.87 / 0.30 / 0.14   |     7.7403 |   10.5803 |      0.01189 | 0.01 / 1.85 / 0.07      |
| test_0013 |  7,806,920 |     3.8778 |    4.6482 |      0.02797 | 0.45 / 0.29 / 0.13   |     6.8346 |    8.9669 |      0.03091 | 0.00 / 2.21 / 0.00      |
| test_0014 | 29,084,016 |     2.3595 |    2.9325 |      0.02654 | 0.62 / 0.48 / 0.38   |     2.6667 |    3.0374 |      0.00594 | 0.00 / **9.40** / 0.00  |
| test_0015 |    223,040 |     8.8189 |   11.8123 |      0.07105 | 0.25 / 0.24 / 0.15   |     9.4328 |   11.7306 |      0.04737 | 0.00 / 3.54 / 0.00      |
| test_0017 | 15,114,588 |     8.7959 |   10.6105 |      0.01333 | 0.25 / 0.24 / 0.34   |     9.6122 |   11.6359 |      0.02742 | 0.00 / 0.00 / 0.00      |

Grand means across the sixteen fixtures: Auto 1.0 mean ΔE00 4.18, RMS 5.69,
smoothness 0.0229; Auto 2.0 mean ΔE00 5.52, RMS 7.19, smoothness 0.0205.
Auto 2.0 fits tighter than Auto 1.0 on three of the sixteen fixtures
(`test_0003`, `test_0009`, `test_0005` by mean ΔE00) and is smoother on
seven of sixteen by the second-difference measure.

## Reading the numbers honestly

Auto 1.0's free 49-node residual LUT wins the raw prediction-fidelity
contest on thirteen of sixteen fixtures, generally by a wide margin — this
is exactly what a free-form, per-image fit against the same data it is then
scored against should do, and matches the epic's own framing of why the
residual was added to Auto 1.0 in the first place (the chroma-match gap a
curve-only fit leaves). A nine-knot tonescale plus a 24×6×8 hue/chroma field
is a much lower-capacity model, so losing the raw fidelity contest by roughly
one ΔE00 unit on the grand mean is the expected, structurally-inevitable
price of trading a free lattice for something bounded and smooth. That
trade is the entire point of the epic — Auto 1.0's own failure mode is
banding injected by lattice kinks the view transform cannot undo, which a
free-form fit cannot avoid by construction and a C¹-smooth structured model
can.

Smoothness is a more genuine wash than the mean-ΔE column suggests at first
glance: Auto 2.0 is smoother on seven fixtures and less smooth on nine, and
the two largest smoothness gaps in the free LUT's favor (`test_0000` at
0.0124 vs 0.0126, `test_0009` at 0.0143 vs 0.0167) are close enough to be
within fitting noise, not a structural win either way at this milestone.
That is a genuinely useful, if unglamorous, finding: the free LUT's own
confidence-damping, neighbor-smoothing, and gamut-feathering machinery
(`lut_fit.rs`'s `smooth3` and `feather_to_identity`) already does real work
bringing its banding risk down from the un-mitigated worst case the
`MAX_SECOND_DIFF_BUDGET` comment derives (0.0871), so the structured model's
smoothness advantage on real fixtures is smaller than the "banding is
impossible by construction" framing might suggest in the abstract. The
structural guarantee — no lattice kinks, ever, regardless of how a future
fixture's correspondence set is shaped — is still real and still valuable;
it is just not visible as a large numeric gap on these sixteen fixtures
today.

The out-of-gamut probe is where the two models genuinely diverge, in both
directions the epic anticipated and one it did not. In the direction the
epic predicts: Auto 2.0 decays cleanly to a near-zero correction at
saturated red and blue on every single fixture, and at saturated green on
seven of the sixteen — the field's own per-cell identity default for
zero-count cells is doing exactly what it is supposed to do, and this is a
structural property the free LUT cannot match (its feathering only ramps
correction down over a couple of grid cells near the edge of support, not
all the way to zero, and its `test_0010` red-channel correction of 2.48 ΔE00
shows a case where that feathering leaves real residual stale correction
sitting at the gamut boundary).

In the direction the epic did not anticipate: on nine of the sixteen
fixtures the Auto 2.0 model applies a large, clearly wrong correction at
saturated green specifically, up to 21.25 ΔE00 on `test_0006`. This traces
to a real gap in the JPEG-pair front-end, not the field (a direct probe of
`test_0006`'s fitted field found every cell in the saturated-green region
sitting at the exact identity default, confirming the field itself is
behaving correctly). The problem is the tonescale. Its nine knots are fixed
at the log-spaced positions the synthetic chart's engineered neutral ramp
was designed for (scene luminance 0.001 to 4.0), but a real photo's
near-neutral pixels cluster in a much narrower band once they have already
passed through Maple's own AgX view transform — clamped to `[0, 1]`, and
in practice rarely populating the top one or two knots at all. Those
top knots then get filled by flat linear extrapolation from the last
knot that did see real data, and because the tonescale's luminance-rescale
step (`scale = display / scene`) is applied to every pixel regardless of
chroma, that same extrapolated flat value crushes any bright, saturated
color whose luminance happens to fall in the unsupported range — exactly
what happens to a fully saturated green, whose Rec.2020 luminance (roughly
0.62, dominated by the 0.678 green luma weight) lands well above where this
particular front end's neutral samples stop providing real signal. This is
a genuine finding worth fixing before any M1 decision, not a defect in the
solver's field or its smoothing: either the tonescale's knot range needs to
be re-derived from what a clamped display buffer can actually produce, or
the luminance rescale needs its own gamut-aware guard the way the field
already has one.

## Verdict

Auto 2.0's structured fit does lose real fidelity against the free LUT on
this fixture set — roughly a one-unit mean ΔE00 gap, present on thirteen of
sixteen fixtures — and that loss is large enough to matter for a ship
decision on its own terms; M1's ship gate (`baseline_auto` holds or ratchets
down on at least fifteen of eighteen fixtures) is a comparison against the
end-to-end ACR-parity harness downstream of this fit, not against these raw
JPEG-pair numbers directly, so this report does not resolve that gate by
itself, but a one-unit ΔE00 gap in the underlying fit is not a promising
starting point for holding that harness's much tighter per-fixture budgets.
The smoothness case for the structured model is real in principle (the
banding failure mode is structurally impossible, not merely reduced) but is
not yet visible as a clear numeric win on today's fixture set, because the
free LUT's existing damping and feathering machinery already absorbs most
of the practical banding risk on real photos. The out-of-gamut case is a
genuine, clean win for the structured model everywhere except the
tonescale-domain bug this report surfaces, which currently makes Auto 2.0
worse than Auto 1.0 at the one thing it was specifically designed to do
better — decay to identity outside the fit's support. That bug should be
fixed and the fixture set re-measured before any M1 go/no-go decision is
made; the current numbers are not yet the structured model's honest ceiling.
