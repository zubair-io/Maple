//! Embedded-preview extraction — the shared core behind every platform's
//! "unedited preview" tier (epic #1993 / #2010).
//!
//! Every modern RAW container (DNG, CR3, ARW, NEF, RAF, ORF, RW2, …) embeds
//! a multi-MP JPEG preview captured alongside the sensor data. Reading that
//! out is a few MB and milliseconds; running the full decode → demosaic →
//! view-transform pipeline just to get a display-sized still is gigabytes
//! and seconds for no visual benefit — the point of this tier is exactly
//! the bytes the camera (or ACR/whatever wrote the DNG) already rendered,
//! not a re-render from raw sensor data. See `docs/architecture.md` §
//! "Scene-linear chain" for why the *edited* pipeline stays scene-referred;
//! this module is deliberately outside that chain.
//!
//! [`extract_embedded_preview`] is the ONE extraction implementation shared
//! by every caller:
//!   - `raw-ffi/src/thumbnail.rs` — the native (Apple + Bun server) C-FFI
//!     externs, which read a file path, extract, resize, JPEG/AVIF-encode,
//!     and write atomically to disk.
//!   - `raw-wasm/src/preview.rs` — the browser-safe wasm-bindgen entry
//!     (#2010), which takes bytes already in memory (no filesystem in a
//!     browser) and returns encoded bytes instead of writing a file.
//!
//! Originally lived only in `raw-ffi` (native-only, since it was the sole
//! consumer); moved here so raw-wasm doesn't reimplement the rawler
//! preview/full/thumbnail-slot hunt — per CLAUDE.md's "one Rust core"
//! principle, this kind of color/format logic is not supposed to fork
//! per-platform.

use std::panic::AssertUnwindSafe;

use crate::error::Error;
use crate::image::ExifOrientation;
use crate::Result;

/// Extract a RAW's embedded preview/thumbnail image plus its EXIF
/// orientation.
///
/// `ext` is a lowercase file extension (e.g. `"dng"`, `"cr2"`, `"arw"`) used
/// as a format hint, exactly like [`crate::decode::decode_bytes`] — it's
/// attached as a dummy `rawfile.<ext>` path on the rawler `RawSource` so
/// format detection can key off it when the file's internal magic is
/// ambiguous.
///
/// Tries rawler's `preview_image` slot first (the largest embedded JPEG,
/// used by most non-DNG decoders — CR3, ARW, NEF, RAF), then `full_image`
/// (the DNG SubIFD preview, `NewSubFileType=1` — the multi-MP one most DNG
/// converters embed), then `thumbnail_image` (the tiny ~160px root-IFD
/// thumb) as a last resort. Returns [`Error::Preview`] if none exists —
/// callers may fall through to a full pipeline render, or (browser/no
/// filesystem) surface the error to the user.
///
/// Also returns the source's EXIF orientation so the caller can bake the
/// rotation into the pixels: embedded preview JPEGs (and the rawler decode
/// path that delivers them as a `DynamicImage`) are typically in sensor
/// orientation with no EXIF carried through, so a portrait shot ends up
/// sideways on disk unless the caller applies this (see
/// [`crate::image::apply_orientation`]).
///
/// The whole extraction runs under `catch_unwind`: rawler can panic on
/// malformed RAWs, and an unwind crossing an FFI or WASM boundary is UB /
/// an opaque trap respectively — this turns either into a normal `Err`.
pub fn extract_embedded_preview(
    raw_bytes: &[u8],
    ext: &str,
) -> Result<(image::DynamicImage, ExifOrientation)> {
    let hint_path = format!("rawfile.{}", ext);
    let extract = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let source = rawler::rawsource::RawSource::new_from_slice(raw_bytes)
            .with_path(std::path::Path::new(&hint_path));
        let decoder = rawler::get_decoder(&source)
            .map_err(|e| Error::Preview(format!("get_decoder: {}", e)))?;
        let params = rawler::decoders::RawDecodeParams::default();

        // EXIF orientation. Pull from `raw_metadata().exif.orientation` — the
        // raw TIFF tag — same source the full decode path uses
        // (`decode::decode_bytes` § 1a). Works across DNG/CR2/ARW/NEF;
        // defaults to Normal when missing.
        let orientation = decoder
            .raw_metadata(&source, &params)
            .ok()
            .and_then(|md| md.exif.orientation)
            .map(ExifOrientation::from_u16)
            .unwrap_or(ExifOrientation::Normal);

        // Embedded preview hunt — different decoders put the largest
        // embedded JPEG in different rawler slots (see doc comment above
        // for the priority rationale).
        let try_slot = |result: std::result::Result<Option<image::DynamicImage>, _>| -> Option<
            image::DynamicImage,
        > {
            match result {
                Ok(Some(img)) => Some(img),
                Ok(None) | Err(_) => None,
            }
        };
        let img = try_slot(decoder.preview_image(&source, &params))
            .or_else(|| try_slot(decoder.full_image(&source, &params)))
            .or_else(|| try_slot(decoder.thumbnail_image(&source, &params)));
        match img {
            Some(i) => Ok((i, orientation)),
            None => Err(Error::Preview(
                "no embedded preview / thumbnail in RAW".into(),
            )),
        }
    }));
    match extract {
        Ok(inner) => inner,
        Err(_) => Err(Error::Preview(
            "rawler panicked during preview extraction".into(),
        )),
    }
}

/// Resize `img` so the long edge is at most `max_px`, preserving aspect
/// ratio, never upscaling. Triangle filter: cheap and visually fine at
/// thumbnail/preview resolutions; Lanczos would be sharper but ~3× slower
/// with no perceptible win at these sizes.
pub fn resize_long_edge(img: image::DynamicImage, max_px: u32) -> image::DynamicImage {
    use image::GenericImageView;
    let (w, h) = img.dimensions();
    let long_edge = w.max(h);
    if long_edge <= max_px {
        return img;
    }
    let scale = max_px as f32 / long_edge as f32;
    let new_w = ((w as f32) * scale).round().max(1.0) as u32;
    let new_h = ((h as f32) * scale).round().max(1.0) as u32;
    img.resize_exact(new_w, new_h, image::imageops::FilterType::Triangle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synth_dng_has_no_embedded_preview() {
        use crate::test_support::synth_dng::SyntheticGreyDng;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synth-no-preview.dng");
        SyntheticGreyDng::default().write_to(&path).unwrap();
        let bytes = std::fs::read(&path).unwrap();
        let err = extract_embedded_preview(&bytes, "dng").unwrap_err();
        match err {
            Error::Preview(msg) => assert!(
                msg.contains("no embedded preview"),
                "unexpected message: {msg}"
            ),
            other => panic!("expected Error::Preview, got {other:?}"),
        }
    }

    #[test]
    fn garbage_bytes_return_preview_error_not_panic() {
        let bytes = b"not a real raw file, just some bytes";
        let err = extract_embedded_preview(bytes, "dng").unwrap_err();
        assert!(matches!(err, Error::Preview(_)));
    }

    #[test]
    fn resize_long_edge_never_upscales() {
        let img = image::DynamicImage::new_rgb8(10, 20);
        let resized = resize_long_edge(img, 1000);
        use image::GenericImageView;
        assert_eq!(resized.dimensions(), (10, 20));
    }

    #[test]
    fn resize_long_edge_caps_and_preserves_aspect() {
        let img = image::DynamicImage::new_rgb8(2000, 1000);
        let resized = resize_long_edge(img, 500);
        use image::GenericImageView;
        let (w, h) = resized.dimensions();
        assert_eq!(w, 500);
        assert_eq!(h, 250);
    }

    /// Fixture-gated happy path: a real DNG's embedded preview extracts
    /// successfully with non-zero dimensions. Skip-passes without
    /// `--features fixtures` (visible `ignored`, per
    /// `test_support::fixtures`'s doc); panics on a missing fixture WITH the
    /// feature (fail-closed provisioning check).
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn fixture_round_trip_extracts_real_embedded_preview() {
        let path = crate::test_support::fixtures::require_raw("test_0002.dng");
        let bytes = std::fs::read(&path).unwrap();
        let (img, _orientation) = extract_embedded_preview(&bytes, "dng").unwrap();
        use image::GenericImageView;
        let (w, h) = img.dimensions();
        assert!(w > 0 && h > 0);
    }
}
