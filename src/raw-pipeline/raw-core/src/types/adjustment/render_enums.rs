//! `Profile`, `WhiteBalancePreset`, `WbScaleVersion`, and `ToneCurveMode`
//! enums — split out of `adjustment/mod.rs` to stay under the 600-LOC hard
//! budget (PR #1730). Same sibling-submodule + re-export pattern as
//! `hot_pixel_suppression.rs` (#1181), `auto_exposure.rs` (#772), and
//! `crop.rs` (#772). Public paths are unchanged — all remain reachable at
//! `crate::types::adjustment::{Profile, WhiteBalancePreset, WbScaleVersion,
//! ToneCurveMode}` via the `pub use` re-export in `mod.rs`.

/// Render-shaping profile applied at the view-transform stage (Auto
/// Profile Phase 1, ticket #536). `Auto` (default) fits a per-image curve
/// from the embedded JPEG preview at render time; `Neutral` runs the AgX
/// scene-referred view transform. See the design spec at
/// `docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md`.
///
/// A third variant, `AcrMatch` (#1722), applied a chart-fitted ACR-match
/// model. It was retired in #2312: `Auto` fits per-image against the
/// embedded JPEG — the same reference the chart fit approximated — without
/// the over-exposure the fitted transform showed on real bodies. Sidecars
/// carrying the retired value migrate to `Auto` in [`crate::xmp`].
///
/// XMP wire: serialized as `papp:Profile="Auto"|"Neutral"` (and only when
/// non-default — `Auto` is omitted by the serializer). Pre-#536 sidecars
/// carrying `papp:Look="Default"|"Neutral"` migrate transparently through
/// the parser: `Default` → `Auto`, `Neutral` → `Neutral`. When both
/// attributes are present on the same element, `papp:Profile` wins
/// regardless of document order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Auto,
    Neutral,
}

impl Default for Profile {
    fn default() -> Self {
        Self::Auto
    }
}

/// White balance preset name as recorded in `crs:WhiteBalance` in the XMP
/// sidecar. `AsShot`, `Auto`, and `Custom` carry no preset (temp,tint) pair —
/// the values stored on `AdjustmentModel` are authoritative when one of those
/// is selected. The named daylight presets map to fixed (temperature, tint)
/// per the reference renderer; see `crate::xmp::wb_preset` for the mapping table.
///
/// TypeScript already has a hand-rolled `WhiteBalancePreset` union; lifting
/// the enum into raw-core gives the codegen a single canonical declaration
/// to emit from in #119.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WhiteBalancePreset {
    AsShot,
    Auto,
    Daylight,
    Cloudy,
    Shade,
    Tungsten,
    Fluorescent,
    Flash,
    Custom,
}

impl Default for WhiteBalancePreset {
    fn default() -> Self {
        Self::AsShot
    }
}

/// WB slider-scale version carried by a parsed sidecar (#1780).
///
/// #1756 changed what stored `crs:Temperature` / `crs:Tint` numbers MEAN:
/// they are now interpreted in ACR's calibration frame
/// (`stages::wb_camera::SliderFrame`) instead of the pre-#1756 post-DCP
/// CAT16 scale anchored at 6500 K / 0. That is a schema-semantics change,
/// so the scale is versioned on the sidecar as `papp:WbScaleVersion`:
///
/// - [`WbScaleVersion::V1`] — pre-#1756 scale. Explicit temperature/tint
///   values mean "post-DCP CAT16 adaptation relative to a 6500 K / 0
///   identity" (`stages::white_balance::apply`'s contract). The develop
///   chain converts these into the V2 frame on use
///   (`stages::wb_camera::resolve_target_versioned`) so the rendered look
///   authored under the old scale is preserved.
/// - [`WbScaleVersion::V2`] — the #1756 scale: slider-frame coordinates,
///   but with the tint AXIS inverted relative to ACR (#1875 — dragging
///   toward the gradient's green end rendered magenta). Explicit authored
///   tint is negated AND rescaled on use so the authored look is preserved.
/// - [`WbScaleVersion::V3`] — the #1875 scale: slider-frame coordinates
///   with the tint axis in the ACR direction (tint+ = magenta image, the
///   direction the slider gradient and `crs:Tint` promise), at the legacy
///   1e-4 uv-per-unit magnitude. Authored tint rescales on use (#1893).
/// - [`WbScaleVersion::V4`] — the #1893 scale: ACR direction and ACR
///   magnitude (`kTintScale`), evaluated on the Hernández-Andrés daylight
///   locus (`white_balance::legacy_slider_source_xy`). Never shipped in a
///   release; its arm exists only for dev-window sidecars written between
///   #1893 and #1894.
/// - [`WbScaleVersion::V5`] — the #1894 scale: Robertson-native. A slider
///   pair is interpreted via `color::dng_temperature` — the exact mapping
///   ACR's own displayed temperature/tint pair uses — instead of the
///   Hernández-Andrés locus every earlier version evaluated on. This is
///   the new default and the ACR-authorship heuristic's verdict: ACR's
///   displayed WB values are natively Robertson, so an ACR/Lightroom
///   sidecar (no `papp:` namespace) is V5 without conversion. Values pass
///   through unconverted.
///
/// Explicit authored tints convert via `white_balance::authored_tint_to_v4`
/// (the fallback/legacy-locus tier — `white_balance::resolve_wb`) or
/// `white_balance::authored_pair_to_v5` (the camera-space tiers —
/// `wb_camera::resolve_target_versioned`), each shared by its tier's own
/// resolvers so they cannot drift. `authored_pair_to_v5` re-expresses ≤V4
/// pairs jointly through physical chromaticity: evaluate the pair on the
/// legacy locus at its version's axis/magnitude, then invert through
/// Robertson — so even a temperature-only authored value can move (legacy
/// (6500, 0) ≈ Robertson (6470, +10), the same physical point named in
/// ACR's coordinates).
///
/// Parse rule (see `xmp::parse`): an explicit `papp:WbScaleVersion`
/// attribute wins; otherwise a document that carries the Maple `papp:`
/// namespace (every Maple writer declares it) AND an explicit authored
/// `crs:Temperature`/`crs:Tint` predates this versioning and is V1.
/// Everything else — no `papp:` namespace at all (ACR/Lightroom-authored,
/// always expressed in ACR's own convention, which V5's Robertson mapping
/// matches exactly) or no authored WB (nothing to convert) — is V5.
/// Default (no sidecar) is V5.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WbScaleVersion {
    /// Pre-#1756 Maple scale: post-DCP CAT16, identity at 6500 K / 0.
    V1,
    /// #1756 scale: ACR calibration-frame slider coordinates with the
    /// tint axis inverted vs ACR (#1875), 1e-4 uv per tint unit.
    V2,
    /// #1875 scale: calibration-frame coordinates, ACR tint direction,
    /// legacy 1e-4 uv per tint unit. Authored tint scales by
    /// `white_balance::TINT_SCALE_V3_TO_V4` (0.3) on use (#1893).
    V3,
    /// #1893 scale: calibration-frame coordinates, ACR tint direction,
    /// ACR's own tint magnitude (`dng_temperature.cpp` `kTintScale` —
    /// 1/3000 uv per unit, `white_balance::TINT_UV_SCALE`), evaluated on
    /// the legacy Hernández-Andrés locus. Never shipped in a release.
    V4,
    /// #1894 scale: Robertson-native — a slider `(temperature, tint)` pair
    /// means EXACTLY what ACR's own displayed pair means, via
    /// `color::dng_temperature`. This is what `crs:Tint`/`crs:Temperature`
    /// mean in an ACR-authored sidecar (and in a fresh Maple model), so
    /// values pass through unconverted.
    V5,
}

impl Default for WbScaleVersion {
    fn default() -> Self {
        Self::V5
    }
}

/// Tone-curve application mode (ticket #436).
///
/// Per-channel RGB curves shift hue (classic problem): lifting only the red
/// curve at midtones pulls neutrals toward red. That is sometimes the desired
/// effect (cross-channel cast control), but other times the user just wants
/// the contrast shape without the hue shift.
///
/// - [`ToneCurveMode::PerChannel`] (default): each of
///   `tone_curve_red`/`tone_curve_green`/`tone_curve_blue` applies independently
///   to its lane. Hue is NOT preserved by construction. This is the pre-#436
///   behavior — backward-compatible.
/// - [`ToneCurveMode::RatioPreserving`]: the per-channel curves fold through
///   the Rec.2020 luma weights to produce a single luminance scale factor,
///   preserving R:G:B ratios. Concretely, given a pixel `(R, G, B)`:
///   `r' = R_curve(Y_in); g' = G_curve(Y_in); b' = B_curve(Y_in);`
///   `Y_out = 0.2627*r' + 0.6780*g' + 0.0593*b'; scale = Y_out / Y_in;`
///   `RGB' = RGB * scale`.
///
/// Canonical reference: Darktable's `iop/tonecurve.c` `preserve_colors`
/// branch — the `dt_rgb_norm(...) → curve_lum → ratio = curve_lum/lum →
/// rgb[c] *= ratio` loop near lines 520–547. Maple's variant differs in
/// that the curve is evaluated **separately on each of the three
/// per-channel curves** before the luma combine, rather than once on a
/// single norm; when all three per-channel curves are equal this collapses
/// to the Darktable formulation. The parametric curve and `tone_curve_luma`
/// are already luma-coupled and are unaffected by this mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToneCurveMode {
    /// Per-channel R/G/B curves apply independently to their lanes; hue
    /// shifts. Pre-#436 behavior; default for backward compatibility.
    PerChannel,
    /// Per-channel R/G/B curves fold into a single Rec.2020 luma scale
    /// factor; hue (R:G:B ratios) is preserved.
    RatioPreserving,
}

impl Default for ToneCurveMode {
    fn default() -> Self {
        Self::PerChannel
    }
}
