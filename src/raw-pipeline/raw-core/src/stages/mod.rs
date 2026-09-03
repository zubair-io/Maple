pub mod auto_adjustments;
/// Tone-slider calibration for [`auto_adjustments`] (#1376). `pub(crate)` API
/// surface; the public entry point stays `compute_auto_adjustments`.
pub mod auto_adjustments_tone;
/// Auto white balance for [`auto_adjustments`] (#2247). `pub(crate)` API
/// surface; the public entry point stays `compute_auto_adjustments`.
pub(crate) mod auto_adjustments_awb;
pub mod auto_exposure;
pub mod auto_tone;
pub mod blur;
pub mod bm3d;
pub mod capture_sharpening;
pub mod chroma_prefilter;
pub mod clarity;
pub mod color_grade;
pub mod crop;
pub mod dehaze;
pub mod display_tone_curve;
pub mod film_look;
pub mod grain;
pub mod guided;
pub mod highlight_recovery;
pub mod highlight_recovery_oklab;
pub mod hot_pixel;
pub mod hsl;
pub mod inpaint_composite;
pub mod local_adjustments;
pub mod nlm;
pub mod noise_reduction;
pub mod saturation;
pub mod scene_tone_controls;
pub mod sharpen;
pub mod texture;
pub mod tone_curves;
pub mod vibrance;
pub mod vignette;
pub mod wb_camera;
pub mod white_balance;
pub mod white_balance_auto;
/// Neutral white-balance sampler (#2434): AUTO's probe and judgement, at a
/// user-picked point.
pub mod white_balance_sample;
