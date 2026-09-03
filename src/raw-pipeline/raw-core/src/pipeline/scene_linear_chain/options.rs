//! [`ChainOptions`] — the per-render option bag for the per-tick
//! scene-linear chain, split out of `scene_linear_chain.rs` to keep that
//! module inside the file-size budget. Pure data: no behaviour beyond the
//! `Default` "plain re-render" configuration.

use crate::view::encode::TargetPrimaries;

/// Per-render options for [`apply_scene_linear_chain`] /
/// [`apply_scene_linear_chain_f32`] (and their `_with_patches` wrappers) —
/// everything about the render EXCEPT the buffer and the adjustment model.
///
/// [`Default`] is the "plain re-render" configuration: decode anchor
/// 6500 K / 0 (the "no sidecar applied at decode" bake), no WB frame, AgX
/// on, sRGB target, no noise profile, ISO 100.
#[derive(Clone, Copy)]
pub struct ChainOptions<'a> {
    /// WB temperature the cached buffer was decoded at by the Rust FFI
    /// (sidecar `Temperature` when an XMP was passed to `decodeSceneLinear`,
    /// else 6500). The chain applies the **delta**
    /// `wb_gains(live) / wb_gains(decoded)` so opening a saved sidecar
    /// doesn't double-apply WB.
    pub decoded_temp: f32,
    /// WB tint sibling of `decoded_temp` (0 for the no-sidecar decode).
    pub decoded_tint: f32,
    /// Decode-exported [`wb_camera::SliderFrameExport`] (#1781): when
    /// present, the WB delta is derived in the SAME camera-calibration
    /// frame the develop chain interprets the sliders in
    /// (`SliderFrameExport::apply_delta_rec2020`), instead of the generic
    /// Planckian CAT16 delta — closing the live-vs-refine WB seam. `None`
    /// (or an absent export) keeps the legacy `white_balance::apply_delta`
    /// bit-identical.
    pub wb_frame: Option<&'a crate::stages::wb_camera::SliderFrameExport>,
    /// Flips off the AgX view-transform tail. Set true for the non-RAW
    /// input path, where the JPEG / HEIF input already has a tone curve
    /// baked in by the camera and applying AgX would double-tone-map.
    pub skip_agx: bool,
    /// Output primaries when the display tail runs — see the per-function
    /// docs for the exact output color space per variant.
    pub target_primaries: TargetPrimaries,
    /// Per-camera noise profile from the decoded `RawImage` (typically two
    /// coefficients per channel in the DNG NoiseLevelFunction model).
    /// `None` disables the profile-aware path and falls back to the
    /// ISO-based estimate (the pre-#1709 behaviour). When present, passed
    /// through to `noise_reduction::apply_luminance` for
    /// scene-noise-adaptive NR.
    pub noise_profile: Option<&'a [f32]>,
    /// ISO speed at capture (`RawImage::iso`), used with `noise_profile`
    /// to derive the per-channel sigma. 100 = the hardcoded fallback that
    /// predates noise-profile plumbing.
    pub iso: u32,
    /// Full frame's long edge at this buffer's scale — the S/H detail-mask
    /// anchor (#2476). `None` = the buffer IS the whole frame (every FFI/WASM
    /// caller); a caller handing in a CROP (the live-vs-tile gate) sets it.
    pub mask_long_edge: Option<u32>,
}

impl Default for ChainOptions<'_> {
    fn default() -> Self {
        ChainOptions {
            decoded_temp: 6500.0,
            decoded_tint: 0.0,
            wb_frame: None,
            skip_agx: false,
            target_primaries: TargetPrimaries::Srgb,
            noise_profile: None,
            iso: 100,
            mask_long_edge: None,
        }
    }
}
