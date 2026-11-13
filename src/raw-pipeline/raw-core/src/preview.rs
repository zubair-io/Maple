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
/// thumb), then — for non-TIFF containers only (Sigma X3F; see
/// [`crate::view::auto_profile::preview::is_tiff_container`]) — a byte scan
/// for the largest embedded color JPEG (#2413: X3F's rawler decoder
/// implements none of the three slots above, so this tier is the only one
/// that ever produces a preview for it). When rawler has no decoder for the
/// body at all (an unknown camera model, #5499), the preview is read straight
/// from the container instead — see [`decoder_free_preview`]. Returns
/// [`Error::Preview`] if none exists — callers may fall through to a full
/// pipeline render, or
/// (browser/no filesystem) surface the error to the user.
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
    // The X3F decoder's metadata implementation is a `todo!()` in rawler
    // 0.7. Native unwind builds can catch that panic, but Maple's production
    // WASM uses `panic_abort`, where invoking it terminates the extraction
    // before the byte-scan fallback can run. X3F is a non-TIFF container with
    // a camera-rendered JPEG, so take the same bounded scan directly and never
    // enter the incomplete decoder. Full Foveon sensor decode remains #417.
    if ext.eq_ignore_ascii_case("x3f") {
        return crate::view::auto_profile::preview::largest_embedded_jpeg(raw_bytes)
            .map(|image| (image, ExifOrientation::Normal))
            .ok_or_else(|| Error::Preview("no embedded preview / thumbnail in X3F".into()));
    }
    let hint_path = format!("rawfile.{}", ext);
    let extract = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let source = rawler::rawsource::RawSource::new_from_slice(raw_bytes)
            .with_path(std::path::Path::new(&hint_path));
        let decoder = match rawler::get_decoder(&source) {
            Ok(decoder) => decoder,
            Err(e) => {
                return decoder_free_preview(raw_bytes)
                    .ok_or_else(|| Error::Preview(format!("get_decoder: {}", e)))
            }
        };
        let params = rawler::decoders::RawDecodeParams::default();

        // EXIF orientation. Pull from `raw_metadata().exif.orientation` — the
        // raw TIFF tag — same source the full decode path uses
        // (`decode::decode_bytes` § 1a). Works across DNG/CR2/ARW/NEF;
        // defaults to Normal when missing.
        //
        // Best-effort, isolated behind its own `catch_unwind`: some rawler
        // decoders (X3F — Sigma Foveon) have `raw_metadata` implemented as
        // `todo!()`, since only the preview/thumbnail slots are supported
        // for that format (full Foveon decode is out of scope, #417). A
        // panic here must degrade to the default orientation rather than
        // fail the whole preview extraction — the embedded JPEG preview is
        // still perfectly extractable even when metadata isn't.
        let orientation = std::panic::catch_unwind(AssertUnwindSafe(|| {
            decoder.raw_metadata(&source, &params).ok()
        }))
        .ok()
        .flatten()
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
            .or_else(|| try_slot(decoder.thumbnail_image(&source, &params)))
            .or_else(|| {
                // Last-resort byte scan, non-TIFF containers only — see the
                // doc comment above and `is_tiff_container`'s own doc for
                // why this can never go circular on a TIFF-based RAW.
                (!crate::view::auto_profile::preview::is_tiff_container(raw_bytes))
                    .then(|| crate::view::auto_profile::preview::largest_embedded_jpeg(raw_bytes))
                    .flatten()
            });
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

/// The embedded preview of a RAW whose body rawler does not know (#5499).
///
/// A camera definition only matters for decoding the sensor data; the
/// camera-rendered preview sits in the container regardless. For a TIFF-based
/// RAW, every IFD (chained and SubIFDs) is considered and the largest 8-bit RGB
/// or YCbCr image wins — a sensor IFD is CFA or linear-raw, so it can never be
/// mistaken for a preview. A best image smaller than a grid thumbnail is
/// refused: a NEF or ARW keeps its large JPEG behind `JPEGInterchangeFormat`,
/// so only its ~160 px IFD0 strip is reachable here, and publishing that would
/// leave a permanently blurry thumbnail and preview once the body is supported.
/// Other containers take the existing byte scan.
const MIN_FALLBACK_LONG_EDGE: u32 = 256;

fn decoder_free_preview(raw_bytes: &[u8]) -> Option<(image::DynamicImage, ExifOrientation)> {
    if !crate::view::auto_profile::preview::is_tiff_container(raw_bytes) {
        return crate::view::auto_profile::preview::largest_embedded_jpeg(raw_bytes)
            .map(|image| (image, ExifOrientation::Normal));
    }
    use rawler::formats::tiff::reader::TiffReader;
    use rawler::tags::TiffCommonTag;
    let tiff =
        rawler::formats::tiff::GenericTiffReader::new_with_buffer(raw_bytes, 0, 0, None).ok()?;
    let orientation = tiff
        .root_ifd()
        .get_entry(TiffCommonTag::Orientation)
        .map(|entry| ExifOrientation::from_u16(entry.force_u16(0)))
        .unwrap_or(ExifOrientation::Normal);
    let source = rawler::rawsource::RawSource::new_from_slice(raw_bytes);
    tiff.find_ifds_with_filter(|_| true)
        .into_iter()
        .filter_map(|ifd| ifd_display_image(ifd, &source))
        .max_by_key(|image| u64::from(image.width()) * u64::from(image.height()))
        .filter(|image| image.width().max(image.height()) >= MIN_FALLBACK_LONG_EDGE)
        .map(|image| (image, orientation))
}

/// Decode one IFD when it holds a display image: a single strip of 3-sample
/// RGB/YCbCr, either uncompressed 8-bit or baseline JPEG.
fn ifd_display_image(
    ifd: &rawler::formats::tiff::IFD,
    source: &rawler::rawsource::RawSource<'_>,
) -> Option<image::DynamicImage> {
    use rawler::tags::TiffCommonTag;
    const PHOTOMETRIC_RGB: u16 = 2;
    const PHOTOMETRIC_YCBCR: u16 = 6;
    const UNCOMPRESSED: u16 = 1;
    let tag = |t: TiffCommonTag| ifd.get_entry(t).map(|entry| entry.force_u32(0));
    let photometric = tag(TiffCommonTag::PhotometricInt)? as u16;
    let displayable = matches!(photometric, PHOTOMETRIC_RGB | PHOTOMETRIC_YCBCR)
        && tag(TiffCommonTag::SamplesPerPixel) == Some(3)
        && ifd.contains_singlestrip_image();
    if !displayable {
        return None;
    }
    let strip = ifd.singlestrip_data_rawsource(source).ok()?;
    if tag(TiffCommonTag::Compression).map_or(UNCOMPRESSED, |c| c as u16) != UNCOMPRESSED {
        return image::load_from_memory_with_format(strip, image::ImageFormat::Jpeg).ok();
    }
    let width = tag(TiffCommonTag::ImageWidth)?;
    let height = tag(TiffCommonTag::ImageLength)?;
    let len = usize::try_from(u64::from(width) * u64::from(height) * 3).ok()?;
    let eight_bit = tag(TiffCommonTag::BitsPerSample) == Some(8);
    (photometric == PHOTOMETRIC_RGB && eight_bit && strip.len() >= len)
        .then(|| image::RgbImage::from_raw(width, height, strip[..len].to_vec()))
        .flatten()
        .map(image::DynamicImage::ImageRgb8)
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
    fn unknown_body_falls_back_to_the_container_preview() {
        use crate::test_support::synth_unknown_body::*;
        let bytes = unknown_body_3fr();
        let source = rawler::rawsource::RawSource::new_from_slice(&bytes);
        let rawler_err = rawler::get_decoder(&source)
            .err()
            .expect("the synthetic body must be unknown to rawler");
        assert!(rawler_err.to_string().contains("Unknown camera"));

        let (img, orientation) = extract_embedded_preview(&bytes, "3fr").unwrap();
        assert_eq!(orientation, ExifOrientation::Rotate90);
        let rgb = img.to_rgb8();
        assert_eq!(rgb.dimensions(), (PREVIEW_WIDTH, PREVIEW_HEIGHT));
        assert_eq!(rgb.as_raw(), &preview_rgb());
    }

    #[test]
    fn unknown_body_refuses_a_preview_smaller_than_a_thumbnail() {
        use crate::test_support::synth_unknown_body::unknown_body_3fr_with_preview;
        let err = extract_embedded_preview(&unknown_body_3fr_with_preview(160, 120), "nef");
        assert!(matches!(err, Err(Error::Preview(_))));
    }

    #[test]
    fn unknown_body_develop_is_a_typed_unsupported_camera_error() {
        use crate::test_support::synth_unknown_body::*;
        match crate::decode::decode_bytes(&unknown_body_3fr(), "3fr").unwrap_err() {
            error @ Error::UnsupportedCamera { .. } => {
                assert_eq!(
                    error.to_string(),
                    format!(
                        "{}Hasselblad {MODEL}",
                        Error::UNSUPPORTED_CAMERA_MESSAGE_PREFIX
                    )
                );
            }
            other => panic!("expected Error::UnsupportedCamera, got {other:?}"),
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

    /// Regression for #2413: X3F bypasses rawler's incomplete decoder so the
    /// production WASM `panic_abort` build can reach its embedded JPEG.
    #[test]
    #[cfg_attr(not(feature = "fixtures"), ignore)]
    fn fixture_x3f_orientation_panic_degrades_not_fails() {
        let path = crate::test_support::fixtures::require_raw("test_0016.X3F");
        let bytes = std::fs::read(&path).unwrap();
        let (img, orientation) = extract_embedded_preview(&bytes, "x3f").unwrap();
        use image::GenericImageView;
        let (w, h) = img.dimensions();
        assert!(w > 0 && h > 0);
        assert_eq!(orientation, ExifOrientation::Normal);
    }
}
