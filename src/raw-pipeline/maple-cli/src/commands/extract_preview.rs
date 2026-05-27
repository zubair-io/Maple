//! `maple-cli extract-preview` — write the RAW's embedded JPEG preview to a PNG.
//!
//! Thin wrapper over [`raw_core::view::auto_profile::preview::extract_preview`].
//! Used by `src/scripts/test_auto_profile_match.sh` to obtain the
//! camera-baked reference image without round-tripping through Adobe Camera
//! Raw — the Auto Profile gate compares Maple's `Profile = Auto` render
//! against this embedded JPEG.
//!
//! Returns a non-zero exit code if the RAW has no embedded preview, so the
//! harness can `SKIP` those fixtures without false-failing.

use raw_core::view::auto_profile::preview::extract_preview;
use std::path::Path;

pub fn run(raw: &Path, out: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    let img =
        extract_preview(raw).ok_or_else(|| -> Box<dyn std::error::Error> {
            "no embedded preview in RAW".into()
        })?;
    img.save(out)?;
    Ok(0)
}
