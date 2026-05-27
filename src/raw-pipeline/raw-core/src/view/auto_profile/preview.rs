//! Embedded JPEG preview extraction via rawler.
//!
//! Returns `None` on any extraction error (file missing, format unsupported,
//! decoder stub, no preview embedded). Callers fall back to AgX-neutral
//! when this returns `None`.

use std::path::Path;

use image::DynamicImage;
use rawler::analyze::extract_preview_pixels;
use rawler::decoders::RawDecodeParams;

/// Extract the embedded JPEG preview from a RAW file at `path`.
///
/// Returns `None` for any failure (including formats without embedded
/// previews). Never panics.
pub fn extract_preview<P: AsRef<Path>>(path: P) -> Option<DynamicImage> {
    let params = RawDecodeParams::default();
    extract_preview_pixels(path, &params).ok()
}
