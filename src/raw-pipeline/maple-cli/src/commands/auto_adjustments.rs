//! `maple-cli auto-adjustments` — compute all eight Auto slider values for a
//! RAW file and print them as JSON.
//!
//! Decodes the RAW, runs the AE-Off/D65 probe develop (Preview quality for
//! speed), and prints a single JSON object on stdout. All eight fields are
//! populated in phase M0:
//!
//!   ```json
//!   {
//!     "exposure": <f32>,
//!     "temperature": <f32>,
//!     "tint": <f32>,
//!     "contrast": <f32>,
//!     "highlights": <f32>,
//!     "shadows": <f32>,
//!     "whites": <f32>,
//!     "blacks": <f32>
//!   }
//!   ```
//!
//! # AE-Off probe / exposure-replaces-anchor contract
//!
//! The returned `exposure` is relative to the AE-Off base. Any consumer that
//! writes the result back to an XMP sidecar **must** also set
//! `papp:AutoExposure="Off"` — otherwise the scene anchor will stack with the
//! recommended exposure and blow out the image.
//!
//! Models on `commands/auto_tone.rs`.

use raw_core::decode::decode_bytes;
use raw_core::stages::auto_adjustments::compute_auto_adjustments;
use raw_core::xmp;
use std::path::Path;

pub fn run(raw_path: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    let bytes = std::fs::read(raw_path)?;
    let ext = raw_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let raw = decode_bytes(&bytes, ext)?;
    let model = xmp::AdjustmentModel::default();
    let r = compute_auto_adjustments(&raw, &model)?;
    // Use {:?} on f32 to guarantee a decimal point so JSON parsers don't
    // accidentally see integers for whole-number values.
    println!(
        "{{\"exposure\":{:?},\"temperature\":{:?},\"tint\":{:?},\"contrast\":{:?},\"highlights\":{:?},\"shadows\":{:?},\"whites\":{:?},\"blacks\":{:?}}}",
        r.exposure, r.temperature, r.tint, r.contrast,
        r.highlights, r.shadows, r.whites, r.blacks,
    );
    Ok(0)
}
