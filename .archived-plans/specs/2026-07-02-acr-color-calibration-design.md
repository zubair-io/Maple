# ACR Color Calibration via Synthetic Charts — Design

Date: 2026-07-02. Status: approved in design review; implementation staged in three phases.

## Problem

Maple's color output is gated against ACR-rendered references, but the gap between
Maple's default rendering and ACR's remains large (test_0018 baseline mean ΔE00 ≈ 16,
neutrals ≈ 12.5). The synthetic 24-patch chart (`test_0018.dng`) was intended to give a
ground-truth calibration signal — known scene-linear Rec.2020 patch values rendered
through both pipelines — but analysis shows the fixture itself is currently measuring an
input-interpretation mismatch rather than a rendering difference.

The DNG embeds `ColorMatrix1 = identity` with a D65 calibration illuminant. Under the DNG
specification, ColorMatrix maps XYZ to camera space, so identity declares that camera
space _is_ XYZ. ACR therefore reads the stored Rec.2020 values as XYZ coordinates and
produces heavily oversaturated output (the dark-skin patch renders as [216, 26, 87]).
Maple ignores the embedded matrix — `dcp::profile_for` logs a generic D65→Rec.2020
fallback — and by coincidence that fallback matches the generator's intent. The colored
patches consequently carry a ΔC of up to −49 that has nothing to do with either
pipeline's look. Only the six neutral patches carry a clean signal today: ACR's tone
rendering is 12–20 L* brighter than Maple's AgX at equal input.

## Goal

Full ACR parity for Maple's default rendering (per the standing ACR-baseline decision,
issue #368), calibrated from synthetic charts whose scene-linear values are known
exactly, with the perceptual harness budgets ratcheting down as evidence.

## Design

The calibration decomposes into a shared end-of-chain fit plus per-operator fits, with a
raw interpolated LUT retained purely as a diagnostic. The three previously considered
alternatives (structured view-transform fit, direct 3D LUT, AgX parameter tuning) are
combined where each is strong rather than chosen exclusively.

### Phase 1 — trustworthy fixtures

The synthetic chart generator gains correct colorimetric tags: `ColorMatrix1` set to the
XYZ(D65)→Rec.2020 matrix with `AsShotNeutral = [1,1,1]`, so ACR and Maple agree that
camera space is scene-linear Rec.2020. `raw-core` starts honoring an embedded
`ColorMatrix1` when no bundled profile matches (today it warns "neither bundled profile
nor embedded ColorMatrix available" even when the tag is present — the root cause gets
fixed, not worked around). A second fixture (`test_0019`) encodes the same 24 patches
through a real camera's dual ColorMatrix/ForwardMatrix pair and a realistic
AsShotNeutral, with raw values synthesized through the inverse transform; it gates the
DCP and white-balance chain end to end. The ACR references for the corrected `test_0018`
(33 slider presets plus auto) and a `test_0019` baseline are re-rendered in ACR by the
operator, after which the harness budgets are re-seeded at the corrected numbers.

### Phase 2 — dense sweep chart and fitted ACR-match view transform

A third generator emits a dense-grid DNG of roughly 3,000 patches sweeping hue × chroma ×
luminance, including exposure planes above 1.0 scene-linear so ACR's highlight rolloff is
observable. Its baseline is rendered once through ACR. A new `maple-cli fit-acr`
subcommand reads the ACR PNG plus the known scene-linear inputs and solves a structured
model: a neutral-derived tonescale curve plus a hue-twist and chroma-taper field
(DCP-HSM-shaped). Clipped and near-clipped samples are masked out of the solve; 8-bit
quantization is treated as noise, not signal. The solved model is baked through the
existing LUT/codegen infrastructure (the `agx_lut.bin` path emitting Rust, WGSL, Swift,
and TypeScript artifacts), so the per-pixel cost is one LUT sample and cross-platform
parity is preserved by construction. The fitted transform ships as the default view
transform; AgX remains available as the Neutral profile; the per-image Auto Profile still
takes precedence when an embedded JPEG exists. The two 24-patch charts act as held-out
validation, and real-camera fixture budgets ratchet down in the same commit that lands
the transform.

### Phase 3 — per-operator slider calibration

With the baseline transform matched, each preset case isolates one operator, and each
operator's response is fitted to ACR's: exposure (a linear multiply, expected to already
match), temperature/tint and the wb_* presets against a proper illuminant model,
the parametric tone family (contrast, highlights, shadows, whites, blacks), then
saturation and vibrance. This extends the closed-form predictor machinery in
`test_grey_adjustments.sh` from grey ramps to colored patches. Budgets ratchet per case
as each operator lands. darktable's white-balance/illuminant math and RawTherapee's DCP
semantics serve as reference implementations where they clarify published behavior
(licensing was confirmed acceptable by the project owner; the repository should also gain
an explicit LICENSE file so the GPL-compatibility of such ports stays unambiguous).

### Diagnostics and stop condition

The dense-chart samples interpolate into a raw "ACR transform" 3D LUT used only for
residual attribution (together with `residual_diff.py` heat maps); it is never shipped
because its extrapolation above the sampled range is unsound. Success criterion:
`test_0018` baseline mean ΔE00 drops from ~16 to low single digits with neutrals near
zero, and no real-camera fixture regresses. All acceptance claims are CIEDE2000 numbers
from the harness, never visual judgment.

## Known risks

ACR references are display-referred 8-bit sRGB PNGs, so the fit works through the
display encoding and treats quantization as noise. ACR's default sharpening (amount 40)
is neutralized by flat patches and inner-crop sampling. The realistic-camera fixture may
surface the known HSM regression (issue #833 lineage); a fitted ACR-match tone curve is
the leading explanation for why HSM tables previously regressed, so this work may
unblock HSM-on-by-default. Phase boundaries are mergeable states with green parity
gates.

## Relationship to existing tickets

PR #1709 lands DCP LookTable and ProfileToneCurve application plus Auto Profile fitting
infrastructure (regularized Oklab LUT fitting, base-curve tone-mapping fit) that Phase 2
reuses for `fit-acr`. Issue #1691 (full DCP LookTable/ToneCurve support) is largely
delivered by that PR; the remaining gap, if any, is folded into Phase 3 scope. Issues
#1688, #1689, #1693 are the Auto Profile counterparts of this calibration and share the
solver machinery.
