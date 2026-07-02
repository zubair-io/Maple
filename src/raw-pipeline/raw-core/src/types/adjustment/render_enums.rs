//! `Profile`, `WhiteBalancePreset`, and `ToneCurveMode` enums — split out of
//! `adjustment/mod.rs` to stay under the 600-LOC hard budget (PR #1730).
//! Same sibling-submodule + re-export pattern as `hot_pixel_suppression.rs`
//! (#1181), `auto_exposure.rs` (#772), and `crop.rs` (#772). Public paths
//! are unchanged — all three remain reachable at
//! `crate::types::adjustment::{Profile, WhiteBalancePreset, ToneCurveMode}`
//! via the `pub use` re-export in `mod.rs`.

/// Render-shaping profile applied at the view-transform stage (Auto
/// Profile Phase 1, ticket #536). `Auto` (default) fits a per-image curve
/// from the embedded JPEG preview at render time; `Neutral` runs the AgX
/// scene-referred view transform; `AcrMatch` runs the fitted ACR-match model
/// (#1722, epic #1710 slice 2). See the design spec at
/// `docs/superpowers/specs/2026-05-26-auto-profile-and-auto-setting-design.md`.
///
/// XMP wire: serialized as `papp:Profile="Auto"|"Neutral"|"AcrMatch"` (and
/// only when non-default — `Auto` is omitted by the serializer). Pre-#536
/// sidecars carrying `papp:Look="Default"|"Neutral"` migrate transparently
/// through the parser: `Default` → `Auto`, `Neutral` → `Neutral`. When both
/// attributes are present on the same element, `papp:Profile` wins
/// regardless of document order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Auto,
    Neutral,
    /// Fitted ACR-match view transform (#1722). Selectable but NOT the
    /// default — the default flip happens in a later commit once the
    /// full-range model (−2EV highlight-shoulder) is refitted.
    AcrMatch,
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
