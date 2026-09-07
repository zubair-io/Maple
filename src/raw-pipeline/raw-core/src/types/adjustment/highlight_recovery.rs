//! `HighlightRecoveryMode` enum — split out of `adjustment/mod.rs` (#3413)
//! to stay under the 600-LOC hard budget, the same sibling-submodule +
//! re-export pattern as `hot_pixel_suppression.rs` (#1181),
//! `auto_exposure.rs` (#772) and `wb_method.rs` (#772). Pure move — the
//! enum, its docs and its `Default` impl are unchanged, and the public path
//! stays `crate::types::adjustment::HighlightRecoveryMode` via the
//! `pub use` in `mod.rs`.

/// Highlight reconstruction mode per spec § 3.3a.
///
/// Default is `ChromaticAdaptation` (Path C — `AsShotNeutral`-aware
/// reconstruction). #335 flipped the default after re-measuring the parity
/// harness: the original PR for #325 read the unchanged main-bias numbers
/// as a regression, but a per-case Off-vs-CA diff shows the algorithm is a
/// near-noop on the budget-gated baseline fixtures (ΔΔE ≤ 0.001, bias deltas
/// in the 5th decimal) — there was nothing to tune.
///
/// `Off` skips the stage entirely; users can opt out per-image via
/// `papp:HighlightRecoveryMode="Off"` in the XMP sidecar. `Blend` and
/// `Luminance` are kept for back-compat with XMP sidecars produced before
/// #325; both silently upgrade to `ChromaticAdaptation` at apply time. The
/// old implementations had a wrong-directional pull (`Blend` lerped clipped
/// channels DOWN, magnifying the magenta cast) and a partial single-channel
/// scope (`Luminance` ignored 2-channel clips), so silently fixing them was
/// preferred to preserving a known-broken behavior behind an enum variant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HighlightRecoveryMode {
    Off,
    /// Legacy — silently upgraded to `ChromaticAdaptation`. Kept so old XMPs
    /// continue to parse.
    Blend,
    /// Legacy — silently upgraded to `ChromaticAdaptation`. Kept so old XMPs
    /// continue to parse.
    Luminance,
    /// Path C: `AsShotNeutral`-aware reconstruction. Default since #335.
    ChromaticAdaptation,
    /// Post-DCP Oklab chroma reduction (ticket #471). Opt-in. Runs in
    /// scene-linear Rec.2020 D65 (where Oklab is well-defined) after
    /// `dcp::apply_colorimetry` — NOT in camera-native RGB. At each clipped
    /// pixel, scales Oklab `(a, b)` by a factor that brings the worst
    /// channel into gamut; hue (`atan2(b, a)`) is preserved by construction
    /// because both `a` and `b` are scaled by the same factor. The pre-DCP
    /// `apply()` call is a no-op for this variant — see
    /// `stages::highlight_recovery_oklab::apply_post_dcp`.
    OklabChromaReduction,
}

impl Default for HighlightRecoveryMode {
    fn default() -> Self {
        Self::ChromaticAdaptation
    }
}
