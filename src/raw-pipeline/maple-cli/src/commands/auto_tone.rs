//! `maple-cli auto-tone` — compute Auto Tone slider values for a RAW file
//! and print as JSON.
//!
//! Decodes the RAW, runs the standard scene-linear development chain
//! (`render_scene_linear_from_raw_with_quality_f32` against `--params`'
//! parsed sidecar when given, `AdjustmentModel::default()` otherwise), and
//! hands the resulting RGBA f32 buffer to
//! [`raw_core::stages::auto_tone::compute_auto_tone_from_rgba`]. The output
//! is a single JSON object on stdout. Phase 1a populates `exposure` only;
//! the other five fields are slider rest position (0.0) until Phase 1b/1c
//! expand the mapping.
//!
//! Hand-formatted JSON keeps `raw-core` and `maple-cli` free of a
//! `serde::Serialize` derive on `AutoTone` — the FFI surface is the source
//! of truth and the schema is small enough to format inline.

use raw_core::decode::decode_bytes;
use raw_core::pipeline::{render_scene_linear_from_raw_with_quality_f32, RenderQuality};
use raw_core::stages::auto_tone as auto_tone_stage;
use raw_core::xmp;
use std::path::Path;

pub fn run(raw_path: &Path, params: Option<&Path>) -> Result<i32, Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    // `RenderQuality::Full` matches the parity harness baseline and produces
    // a deterministic post-orientation RGBA f32 buffer. `--params` develops
    // against the CURRENT edits instead of the default state (#813), so the
    // recommendation reflects "re-auto on top of what's already applied".
    let model = match params {
        Some(p) => xmp::parse(&std::fs::read_to_string(p)?)?,
        None => xmp::AdjustmentModel::default(),
    };
    let (w, h, rgba) =
        render_scene_linear_from_raw_with_quality_f32(&raw, &model, RenderQuality::Full)?;
    let t = auto_tone_stage::compute_auto_tone_from_rgba(&rgba, w as usize, h as usize, 0.005);
    // Use {:?} on f32 so `0.0` round-trips through `serde_json::from_str`
    // as a plain number (it's the same Display path the default formatter
    // takes, but `{:?}` guarantees a decimal point so the JSON parser
    // doesn't accidentally see an integer).
    println!(
        "{{\"exposure\":{:?},\"contrast\":{:?},\"whites\":{:?},\"blacks\":{:?},\"highlights\":{:?},\"shadows\":{:?}}}",
        t.exposure, t.contrast, t.whites, t.blacks, t.highlights, t.shadows,
    );
    Ok(0)
}
