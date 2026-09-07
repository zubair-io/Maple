//! `DemosaicChoice` enum — the manual override for the Bayer demosaic
//! kernel (#3413). Split into its own submodule, like
//! `hot_pixel_suppression.rs` (#1181) and `auto_exposure.rs` (#772), to keep
//! `adjustment/mod.rs` under the 600-LOC hard budget. Reachable as
//! `crate::types::adjustment::DemosaicChoice` via the `pub use` in `mod.rs`.

/// Which Bayer demosaic kernel a full-resolution render uses.
///
/// `Auto` (the default) hands the decision to
/// `crate::demosaic::policy`, which reads the frame's noise profile and
/// size: a noisy frame gets LMMSE, a large clean one the AMaZE + VNG4 dual,
/// and a small clean one AMaZE alone. Every other variant pins one kernel
/// for this image, for the rare frame where the automatic answer is wrong —
/// astro work that wants no smoothing at all, or a shot whose reported ISO
/// badly misrepresents how noisy it is.
///
/// The override applies wherever a full-resolution Bayer kernel runs — the
/// on-screen full render, the deep-zoom tiles, and export — so what the
/// screen shows is what the file gets. It does **not** apply to the binned
/// fit-view path, which halves resolution before demosaicing and has no
/// kernel choice to make.
///
/// This is a **decode-product** parameter, like `chroma_prefilter` and
/// `hot_pixel_suppression`: changing it re-runs the decode rather than a
/// per-tick GPU stage, and the decoded-image caches carry it in their keys.
///
/// XMP wire: `papp:Demosaic="Amaze"|"Rcd"|"DualAmaze"|"DualRcd"|"Lmmse"`,
/// omitted by the serializer at the default (`Auto`). Adobe has no
/// equivalent key — ACR exposes no kernel choice — so this lives in Maple's
/// own namespace.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum DemosaicChoice {
    /// Noise- and size-adaptive selection. The default.
    #[default]
    Auto,
    /// AMaZE everywhere: maximum resolved detail and moiré resistance.
    Amaze,
    /// RCD everywhere: close to AMaZE on detail, materially cheaper, and
    /// better on smooth gradients.
    Rcd,
    /// AMaZE in detailed regions, VNG4 in flat ones.
    DualAmaze,
    /// RCD in detailed regions, VNG4 in flat ones — the cheaper dual.
    DualRcd,
    /// LMMSE everywhere: the high-ISO kernel, with an explicit noise model.
    Lmmse,
}
