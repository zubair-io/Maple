//! `maple-cli extract-preview` — write the RAW's embedded JPEG preview to an
//! image file (format inferred from the `--out` extension via `img.save`).
//!
//! Thin wrapper over [`raw_core::view::auto_profile::preview::extract_preview`].
//! Used by `src/scripts/test_auto_profile_match.sh` to obtain the
//! camera-baked reference image without round-tripping through Adobe Camera
//! Raw — the Auto Profile gate compares Maple's `Profile = Auto` render
//! against this embedded JPEG.
//!
//! Exit-code contract (see `run_or_exit` in `main.rs` for the i32→process
//! mapping):
//!   * `Ok(0)` — preview extracted and written.
//!   * `Ok(3)` — RAW is readable but carries no embedded preview. Dedicated
//!     sentinel so the harness can `SKIP` the fixture without masking real
//!     errors.
//!   * `Err(_)` — a real I/O failure (missing / unreadable RAW, or a write
//!     error). Maps to a generic non-zero exit (`1`, never `3`).

use raw_core::view::auto_profile::preview::extract_preview;
use std::path::Path;

/// Sentinel exit code: the RAW was readable but had no embedded preview.
pub const NO_PREVIEW_EXIT: i32 = 3;

pub fn run(raw: &Path, out: &Path) -> Result<i32, Box<dyn std::error::Error>> {
    // Validate the RAW is readable FIRST so a missing / unreadable file
    // surfaces as a real I/O error (Err -> generic non-zero exit), not the
    // "no embedded preview" sentinel. `extract_preview` swallows decode
    // failures into `None`, so without this probe a missing path would be
    // indistinguishable from a genuinely preview-less RAW.
    std::fs::metadata(raw).map_err(|e| -> Box<dyn std::error::Error> {
        format!("cannot read RAW {}: {}", raw.display(), e).into()
    })?;

    match extract_preview(raw) {
        Some(img) => {
            img.save(out)?;
            Ok(0)
        }
        None => {
            eprintln!(
                "no embedded preview in RAW {} — nothing written",
                raw.display()
            );
            Ok(NO_PREVIEW_EXIT)
        }
    }
}
