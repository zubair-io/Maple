//! Camera-space white balance (#1726).
//!
//! ACR applies the temperature/tint sliders as per-channel multipliers in
//! CAMERA-NATIVE linear RGB, upstream of the DCP colorimetric transform.
//! Maple historically applied user WB as a CAT16 chromatic-adaptation matrix
//! in scene-linear Rec.2020, AFTER DCP (`stages::white_balance::apply`). At
//! extreme slider settings that post-DCP matrix can push saturated pixels
//! outside the Rec.2020 gamut; the pipeline's hard gamut clip then collapses
//! those pixels to a flat plate, producing visible posterization/banding —
//! reproduced at Temperature=12000K/Tint=+17 on a Canon 5DS R CR2, where
//! Maple rendered a flat "yellow filter" look with banded bokeh highlights
//! that ACR does not show.
//!
//! Moving the WB gain upstream of DCP bounds it to what the sensor can
//! physically report per channel, so the same slider extremes no longer
//! manufacture out-of-gamut scene-linear values.
//!
//! ## The gain is the SOLE carrier of the cast — DCP's Bradford source does
//! ## NOT move
//!
//! Per the design contract: `gain[c] = as_shot_neutral[c] /
//! target_neutral_camera[c]`, where `target_neutral_camera = G_norm(cm ·
//! target_xyz)` is the camera-native reading a scene patch that's neutral
//! UNDER THE TARGET ILLUMINANT would produce through the resolved DCP
//! `ColorMatrix` — exactly analogous to how `as_shot_neutral` is the
//! reading a neutral patch produced under the scene's actual illuminant.
//! `white_balance::apply_pre_gain` already divided the buffer by
//! `as_shot_neutral`, so this gain is what's left to multiply in to make a
//! reading of `target_neutral_camera` become `(1, 1, 1)` instead.
//!
//! This is a DIAGONAL (per-channel scalar) gain — by definition, since
//! "white balance" means picking which camera reading counts as neutral,
//! not rotating the color space.
//!
//! **The DCP profile passed to `dcp::apply_colorimetry` downstream of
//! [`apply`] MUST be the caller's ORIGINAL, unmodified profile — in
//! particular `scene_white_xyz` (DCP's Bradford-adaptation source) stays at
//! the profile's TRUE as-shot chromaticity, never at anything derived from
//! the user's target.** An earlier version of this module (attempt 1)
//! introduced a `retarget_profile` step that re-pointed `scene_white_xyz` at
//! `inv(CM) · gain` — the chromaticity the gain actually left the buffer's
//! neutral at — on the theory that DCP's Bradford step needed to "know"
//! where the gain had moved the neutral to. That reasoning was backwards:
//! Bradford-adapting FROM the exact point the buffer's neutral now sits AT,
//! TO D50, maps that point back to neutral — which is precisely what
//! undoes the WB shift [`apply`] just introduced. Probe evidence: as-shot
//! `[1.868, 1.515, 0.502]` vs a 50000K retarget-profile probe only reached
//! `[2.047, 1.538, 0.483]` (barely moved) and a 2000K probe distorted hue
//! instead of casting cool — a near-total, and at the cool end
//! direction-corrupting, cancellation. Leaving `scene_white_xyz` fixed at
//! the as-shot point means Bradford performs the SAME adaptation
//! regardless of the gain, so the gain's shift survives through DCP into
//! the rendered cast, exactly like ACR's pre-DCP slider.
//!
//! `color_matrix`, `forward_matrix`, and `wb_already_baked` are likewise
//! left untouched — the camera→working colorimetric transform (spec
//! invariant: "the pipeline's camera→working transform is unchanged by
//! user WB") depends only on the TRUE as-shot illuminant and the sensor's
//! calibration, never on where the user points the WB sliders.
//!
//! ## Tier split (why this isn't always the code path)
//!
//! This module needs a **real camera calibration matrix** (DNG `ColorMatrix`,
//! resolved by `color::dcp::profile_for_with_source` — `EmbeddedFull`,
//! `BundleConfident`, or `EmbeddedCmOnly`) to convert a target chromaticity
//! into a camera-native neutral. [`ProfileSource::RawlerFallback`] carries a
//! *synthetic* matrix (`M_XYZ_D65_TO_REC2020` — "pretend the sensor has
//! Rec.2020 primaries at D65"), not a real per-camera calibration, so
//! computing a camera-space target neutral from it would be meaningless.
//!
//! The develop chain therefore takes this stage only for the three
//! calibrated tiers, and falls through to the pre-existing post-DCP CAT16
//! path (`stages::white_balance::apply`) for `RawlerFallback` — see the
//! call sites in `pipeline::develop`, `pipeline::develop_sized`, and
//! `pipeline::tile::develop`.
//!
//! This split is also what keeps the grey-DNG test harnesses
//! (`test_synthetic_grey.sh`, `test_grey_adjustments.sh`, `test_grey_dcp.sh`)
//! green without modification: `test_support::synth_dng::SyntheticGreyDng`
//! defaults to an identity `ColorMatrix1`, which `color::dcp` never surfaces
//! as a real calibration (ticket #424's "never identity" guarantee) — so
//! those fixtures always resolve to `RawlerFallback` and keep exercising the
//! unchanged CAT16 closed-form path the grey predictors were written against.
//!
//! ## As-Shot seeding: resolving the identity reference point
//!
//! [`resolve_target`] answers "what `(temperature, tint)` does THIS
//! `AdjustmentModel` actually mean for this image?" before either [`apply`]
//! or its identity check runs. This reuses the `temperature_seen` /
//! `tint_seen` flags `AdjustmentModel` carries (#1730): `xmp::set_field`
//! sets a flag only when the corresponding `crs:Temperature` / `crs:Tint`
//! attribute is literally present in the sidecar (an authored Custom WB
//! component), and the FFI conversions (`raw-ffi::scene_linear_chain` /
//! `raw-ffi::scene_linear_chain_f32_entry`) force both flags `true` because
//! those callers always supply an explicit, already-resolved numeric value
//! (including the as-shot CCT itself for an unedited FFI render — see
//! `white_balance::resolve_wb`'s doc-comment). A `crs:WhiteBalance="As
//! Shot"` XMP (or one with no `crs:WhiteBalance` attribute at all, e.g. a
//! fresh image with no sidecar yet) leaves BOTH flags `false` and BOTH
//! values at the literal `AdjustmentModel::default()` numeric defaults
//! `(6500.0, 0.0)` — `xmp::wb_preset` returns `None` for "As Shot"/"Auto"/
//! "Custom" and the unrecognized-value branch leaves the model's existing
//! (i.e. still-default) value in place (see `xmp::set_field`'s
//! `crs:WhiteBalance` arm).
//!
//! [`resolve_target`] therefore treats `!temperature_seen && !tint_seen &&
//! model.temperature == 6500.0 && model.tint == 0.0` as the As-Shot signal
//! and substitutes the profile's own resolved as-shot reference point
//! (`profile.scene_cct`, tint 0 — DCP has no separate as-shot tint concept)
//! so unedited renders are exact no-ops regardless of how far the camera's
//! true as-shot CCT sits from 6500K. Checking the numeric pair in addition
//! to the flags (rather than the flags alone) is what correctly keeps a
//! named WB preset (e.g. Tungsten, 2850 K / 0 tint — which also leaves both
//! `_seen` flags `false`, since presets resolve to a `(temp, tint)` pair at
//! parse time rather than being authored as explicit numeric fields) OUT of
//! the As-Shot branch: no preset in `xmp::wb_preset`'s table resolves to
//! exactly `(6500.0, 0.0)`, so every preset's resolved value reaches
//! [`apply`] as an explicit target, same as `white_balance::resolve_wb`'s
//! neither-seen row.
//!
//! ## Tile-refine delta anchor ([`apply_delta`])
//!
//! #1725 (landed on `main` ahead of this ticket, reconciled here) gave the
//! CPU tile-refine path (`pipeline::tile::develop`) a `decoded_wb_anchor`
//! contract: an app that hydrates `model.temperature`/`model.tint` to the
//! camera's own ESTIMATED as-shot `(cct, tint)` (rather than leaving the
//! model at [`resolve_target`]'s numeric-default As-Shot sentinel) needs
//! the tile buffer's WB to match a GPU-live frame's own decoded anchor
//! point exactly, or the tile-vs-live-frame seam reappears (the original
//! #1725 "horizontal band" symptom, for the post-DCP CAT16 path).
//! [`apply`]'s own identity short-circuit only recognizes ONE reference
//! point, `(profile.scene_cct, 0.0)` — insufficient here because a real
//! camera's as-shot chromaticity can sit far enough off the blackbody
//! locus that no `(temperature, tint)` pair within the slider's ±100 tint
//! range reaches it at all (measured on a real Hasselblad H2D-39 bundle
//! profile: the true as-shot point's diagonal-convention tint projects to
//! +144, clamped to +100 — `apply` literally cannot reach identity for
//! that model shape via its single fixed reference point). [`apply_delta`]
//! solves this the same way `white_balance::apply_delta` does for the
//! post-DCP path: compare the TARGET's gain against the DECODED ANCHOR's
//! own gain (both computed by the same [`camera_wb_gain`]), so a target
//! that equals the anchor is a bit-exact no-op regardless of where either
//! point sits relative to the locus. `pipeline::tile::develop` dispatches
//! to [`apply_delta`] when the caller supplies a `decoded_wb_anchor` and
//! to [`apply`] (absolute, via [`resolve_target`]) otherwise — mirroring
//! the post-DCP path's own `Some`/`None` dispatch on the same parameter.
//!
//! ## GPU-live boundary (documented, not yet closed — tracked for #1727)
//!
//! The GPU-live / per-tick FFI path (`pipeline::scene_linear_chain::
//! apply_scene_linear_chain[_f32]`, and every `raw-gpu` chain —
//! `WhiteBalancePass`, `full_chain`, `live_chain`) receives an
//! **already-decoded, post-DCP** scene-linear Rec.2020 buffer: DCP itself
//! runs upstream, on the CPU, before any of those entry points see the data.
//! There is no camera-native buffer or `DcpProfile` available at that layer
//! to apply this module's math against. Those paths keep using the existing
//! Rec.2020-space CAT16 `wb_cat16_matrix` / `white_balance::apply_delta`
//! contract unchanged — [`apply_delta`] above closes the gap for the CPU
//! tile-refine path specifically, not for the GPU-live per-tick path.
//!
//! Net effect: a cold/refine render (this module, camera-space) and a
//! GPU-live slider tick (unchanged, scene-linear CAT16) compute user WB
//! differently for the same non-default `(temperature, tint)`. Closing that
//! gap means teaching the GPU chain to either (a) run DCP itself so it has a
//! camera-native buffer + `color_matrix` to work from, or (b) accept a
//! precomputed camera-space delta *matrix* through the FFI the way
//! `WhiteBalancePass` already accepts a precomputed Rec.2020 matrix today.
//! Both are real WGSL/FFI-surface changes, out of scope for this ticket —
//! #1727 is the tracking ticket.

use crate::{color::dcp::DcpProfile, math::Matrix3, xmp::AdjustmentModel};

use super::white_balance::{apply_tint_perpendicular, cct_to_xy, xy_to_xyz};

/// The literal numeric defaults `AdjustmentModel::default()` assigns to
/// `temperature`/`tint`. See the module doc's "As-Shot seeding" section for
/// why this pair, checked alongside `temperature_seen`/`tint_seen`, is the
/// As-Shot signal.
const MODEL_DEFAULT_TEMPERATURE: f32 = 6500.0;
const MODEL_DEFAULT_TINT: f32 = 0.0;

/// Resolve the effective `(temperature, tint)` target for camera-space WB.
///
/// As-Shot signal: NEITHER `temperature_seen` nor `tint_seen` is set (no
/// authored Custom-WB component — see the module doc) AND the model's
/// `(temperature, tint)` still sit at the exact `AdjustmentModel::default()`
/// numeric defaults `(6500.0, 0.0)` — the state parsing leaves an image
/// with no sidecar, or an explicit `crs:WhiteBalance="As Shot"`/absent
/// attribute, in. When that holds, substitutes the profile's own resolved
/// as-shot reference point (`profile.scene_cct`, tint `0.0`) instead of the
/// literal default, so unedited renders are exact no-ops regardless of how
/// far the camera's true as-shot CCT sits from 6500K.
///
/// Every other case — an authored Custom WB (either flag set), an FFI
/// caller (both flags forced `true`), or a named preset resolved by
/// `xmp::wb_preset` at parse time (neither flag set, but a non-default
/// value — no preset resolves to exactly `6500.0, 0.0`) — is an explicit
/// target and passes through, honoring the same temperature-only-Custom
/// tint-defaulting rule `white_balance::resolve_wb` uses: `crs:Tint`
/// absent alongside an authored `crs:Temperature` means ACR's "absent
/// tint" convention (0.0), not "carry over whatever `model.tint` happens
/// to hold".
pub fn resolve_target(model: &AdjustmentModel, profile: &DcpProfile) -> (f32, f32) {
    let is_as_shot = !model.temperature_seen
        && !model.tint_seen
        && (model.temperature - MODEL_DEFAULT_TEMPERATURE).abs() < 0.5
        && (model.tint - MODEL_DEFAULT_TINT).abs() < 0.5;
    if is_as_shot {
        return (profile.scene_cct, 0.0);
    }
    let tint = if model.temperature_seen && !model.tint_seen {
        0.0
    } else {
        model.tint
    };
    (model.temperature, tint)
}

/// G-normalise a camera-space triple so the green channel reads exactly 1.0
/// (matches DNG `AsShotNeutral` convention). Degenerate (near-zero) green
/// clamps the denominator so a malformed matrix can't produce Inf/NaN.
fn g_normalize(v: [f32; 3]) -> [f32; 3] {
    let g = v[1].max(1e-6);
    [v[0] / g, 1.0, v[2] / g]
}

/// Target chromaticity XYZ (Y=1) for the user's `(temperature, tint)`.
///
/// Uses the same CIE 1960 uv-perpendicular-to-locus axis as
/// `stages::white_balance::wb_gains` (`apply_tint_perpendicular`,
/// `tint_sign_positive_v = false`) — NOT a crude linear `y -= tint *
/// 0.001` offset off the locus. Matching `wb_gains`'s axis exactly matters
/// here specifically because `wb_gains`'s inverse,
/// `color::dcp::estimate_as_shot_cct_tint` /
/// `white_balance_auto::estimate_tint_from_scene_xyz`, is what recovers a
/// camera's as-shot `(cct, tint)` pair for the tile-refine delta-anchor
/// contract (`pipeline::tile::develop`'s `decoded_wb_anchor`) — a
/// round-trip through a DIFFERENT tint axis than the one that produced the
/// estimate would reintroduce exactly the kind of large, spurious cast a
/// mismatched convention produces (measured: a linear-offset axis put a
/// real fixture's as-shot tint at the -100 clamp rail and rendered a
/// [1.47, 1.0, 1.63] gain at what should have been the as-shot identity
/// point). Same sign convention as `wb_gains`: positive tint moves the
/// source chromaticity toward magenta (lower `y`-ish, precisely "lower v
/// in uv") so the corrective gain pushes the rendered image toward green.
fn target_xyz(temperature: f32, tint: f32) -> [f32; 3] {
    let (x, y) = cct_to_xy(temperature);
    let (tx, ty) = apply_tint_perpendicular(x, y, temperature, tint, false);
    xy_to_xyz(tx, ty, 1.0)
}

/// Camera-native neutral a scene lit by `(temperature, tint)` would produce
/// through calibration matrix `cm` (DNG `ColorMatrix`, XYZ→camera), G-
/// normalised.
fn camera_neutral_for(cm: Matrix3, temperature: f32, tint: f32) -> [f32; 3] {
    g_normalize(cm.mul_vec(target_xyz(temperature, tint)))
}

/// Compute the camera-native-space white-balance gain for the user's
/// `(temperature, tint)`.
///
/// `gain[c] = as_shot_neutral[c] / target_neutral_camera[c]` per the design
/// contract — see the module doc for the full derivation. This gain is the
/// SOLE carrier of the WB cast: DCP's profile (in particular
/// `scene_white_xyz`) is never modified to compensate for it.
///
/// Returns gain `[1.0, 1.0, 1.0]` (no-op) when `cm` is singular (defensive;
/// should not happen for a real calibration matrix).
pub fn camera_wb_gain(
    profile: &DcpProfile,
    as_shot_neutral: [f32; 3],
    temperature: f32,
    tint: f32,
) -> [f32; 3] {
    let cm = profile.color_matrix;
    let asn = g_normalize(as_shot_neutral);
    let target_neutral_camera = camera_neutral_for(cm, temperature, tint);

    let gain = [
        asn[0] / target_neutral_camera[0].max(1e-6),
        asn[1] / target_neutral_camera[1].max(1e-6),
        asn[2] / target_neutral_camera[2].max(1e-6),
    ];
    // G-normalise the gain itself so the pre-gain/highlight-recovery
    // convention (green channel untouched) holds for the composed multiply.
    let g = gain[1].max(1e-6);
    [gain[0] / g, 1.0, gain[2] / g]
}

/// Apply the camera-space WB gain in place to a `CameraNativeLinearRgb`
/// image. Called after `white_balance::apply_pre_gain` (so the buffer is
/// already scaled by `1 / as_shot_neutral`), before DCP.
///
/// Identity short-circuit when `(temperature, tint)` already matches the
/// resolved as-shot reference `(profile.scene_cct, 0)` within the same
/// tolerance `stages::white_balance::apply` uses. This is a real
/// short-circuit, not a redundant one: `camera_wb_gain` at that exact point
/// is only APPROXIMATELY `[1, 1, 1]` (a real scene's as-shot chromaticity
/// generally sits slightly off the pure blackbody locus that `cct_to_xy`
/// describes at `tint = 0` — that's the entire reason `tint` exists as a
/// second, perpendicular axis) — so without this short-circuit, opening an
/// image at its own as-shot default would NOT render pixel-identically to
/// today's pipeline.
///
/// Callers MUST pass `(temperature, tint)` through [`resolve_target`]
/// first so an As-Shot model (indistinguishable on this branch from the
/// literal numeric default — see the module doc) resolves to THIS image's
/// as-shot point rather than a fixed 6500K/0 sentinel.
///
/// The `profile` passed to the downstream `dcp::apply_colorimetry` call
/// must be the SAME, UNMODIFIED profile passed here — see the module doc
/// for why re-pointing `scene_white_xyz` at the gained target
/// double-corrects the cast almost back to nothing.
pub fn apply(
    img: &mut crate::image::Image,
    profile: &DcpProfile,
    as_shot_neutral: [f32; 3],
    temperature: f32,
    tint: f32,
) {
    img.assert_space(crate::image::ColorSpace::CameraNativeLinearRgb);
    if (temperature - profile.scene_cct).abs() < 0.5 && tint.abs() < 0.5 {
        return; // identity short-circuit: as-shot renders unchanged
    }
    let g = camera_wb_gain(profile, as_shot_neutral, temperature, tint);
    for p in &mut img.pixels {
        p[0] *= g[0];
        p[1] *= g[1];
        p[2] *= g[2];
    }
}

/// Delta-anchored variant of [`apply`], for the tile-refine / GPU-live
/// boundary (#1725's `decoded_wb_anchor` contract, `pipeline::tile::develop`).
///
/// Applies `(temperature, tint)` relative to `(decoded_temperature,
/// decoded_tint)` rather than as an absolute target — i.e. a tile rendered
/// at `temperature == decoded_temperature && tint == decoded_tint` is a
/// bit-exact no-op, matching `white_balance::apply_delta`'s contract for
/// the post-DCP CAT16 path. This matters specifically because
/// [`apply`]'s own identity short-circuit only recognizes ONE reference
/// point — `(profile.scene_cct, 0.0)` — and a real camera's as-shot
/// chromaticity can sit far enough off the blackbody locus that its
/// diagonal-convention tint (see [`target_xyz`]'s doc) exceeds the ±100
/// slider range entirely (measured on a real Hasselblad H2D-39 bundle
/// profile: the true as-shot tint projects to +144, clamped to +100 by
/// `estimate_tint_from_scene_xyz` before any sign-convention difference
/// even enters). An app that hydrates `model.temperature`/`model.tint`
/// to the camera's own estimated as-shot `(cct, tint)` (rather than
/// leaving the model at the literal numeric default, which is what
/// [`resolve_target`]'s As-Shot seeding is FOR) needs a decoded/live
/// buffer's own anchor to compare against directly — comparing to
/// `profile.scene_cct`'s idealized locus point can never reach identity
/// for a camera whose as-shot point doesn't sit near that locus.
///
/// `gain = camera_wb_gain(target) / camera_wb_gain(anchor)` — `as_shot_neutral`
/// cancels out of the ratio algebraically (both numerator and denominator
/// gains divide by the same `as_shot_neutral`), so passing it through is
/// for API symmetry with [`apply`] / [`camera_wb_gain`], not because the
/// ratio depends on its value.
pub fn apply_delta(
    img: &mut crate::image::Image,
    profile: &DcpProfile,
    as_shot_neutral: [f32; 3],
    temperature: f32,
    tint: f32,
    decoded_temperature: f32,
    decoded_tint: f32,
) {
    img.assert_space(crate::image::ColorSpace::CameraNativeLinearRgb);
    if (temperature - decoded_temperature).abs() < 0.5 && (tint - decoded_tint).abs() < 0.5 {
        return; // identity short-circuit: live == decoded, no shift to apply
    }
    let g_target = camera_wb_gain(profile, as_shot_neutral, temperature, tint);
    let g_decoded = camera_wb_gain(profile, as_shot_neutral, decoded_temperature, decoded_tint);
    let g_net = [
        g_target[0] / g_decoded[0].max(1e-6),
        g_target[1] / g_decoded[1].max(1e-6),
        g_target[2] / g_decoded[2].max(1e-6),
    ];
    for p in &mut img.pixels {
        p[0] *= g_net[0];
        p[1] *= g_net[1];
        p[2] *= g_net[2];
    }
}

#[cfg(test)]
#[path = "wb_camera_tests.rs"]
mod tests;
