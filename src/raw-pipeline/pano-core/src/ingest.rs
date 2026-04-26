//! Ingest helpers — convert raw-core's scene-linear `Image` (Vec<[f32; 3]>)
//! into the pano-core working buffer (`PanoImage`, interleaved RGB f32 with a
//! validity mask).
//!
//! Orientation is applied here so downstream stages see display-oriented
//! pixels — matters for feature matching, which is rotation-sensitive when
//! the camera was held portrait.
//!
//! See spec § 4.1 for the design rationale; the working color space is
//! Rec.2020 D65 linear (see `ColorSpace::rec2020_d65_linear`), not the
//! ProPhoto the spec text mentions.

use bitvec::vec::BitVec;
use raw_core::image::{ExifOrientation, Image};

use crate::color::ColorSpace;
use crate::error::PanoError;
use crate::types::PanoImage;

// ---------------------------------------------------------------------------
// Public input / format types
// ---------------------------------------------------------------------------

/// A panorama input, either pre-decoded or raw bytes to be sniffed and decoded.
pub enum PanoInput {
    /// In-memory bytes; format detected by sniffing the magic bytes.
    Bytes(Vec<u8>),
    /// Already-decoded PanoImage — passed through unchanged.
    Decoded(PanoImage),
    // Future: Path(PathBuf) once an FS arm is needed.
}

/// Format detected by byte-sniffing the first few bytes of an input buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PanoFormat {
    Png,
    Jpeg,
    /// TIFF-magic files: DNG, NEF, CR2, ARW, and any other rawler-supported
    /// sensor format that uses the TIFF container.
    Raw,
    /// HEIF/HEIC — gated behind the `heif` feature; currently unimplemented.
    Heif,
    Unknown,
}

// ---------------------------------------------------------------------------
// Format sniffer
// ---------------------------------------------------------------------------

/// Detect the container format from the first ≤16 bytes of a byte slice.
///
/// Detection is magic-byte–based, not extension-based:
/// - PNG:  `89 50 4E 47` (`\x89PNG`)
/// - JPEG: `FF D8 FF`
/// - TIFF/DNG/RAW: `49 49 2A 00` (little-endian) or `4D 4D 00 2A` (big-endian)
/// - HEIF: `ftyp` box at byte offset 4 (`66 74 79 70`)
///
/// Everything else is `Unknown`.
pub fn sniff_format(bytes: &[u8]) -> PanoFormat {
    if bytes.len() < 4 {
        return PanoFormat::Unknown;
    }
    // PNG: \x89 P N G
    if bytes.starts_with(b"\x89PNG") {
        return PanoFormat::Png;
    }
    // JPEG: FF D8 FF
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return PanoFormat::Jpeg;
    }
    // TIFF little-endian (II): 49 49 2A 00
    if bytes.starts_with(&[0x49, 0x49, 0x2A, 0x00]) {
        return PanoFormat::Raw;
    }
    // TIFF big-endian (MM): 4D 4D 00 2A
    if bytes.starts_with(&[0x4D, 0x4D, 0x00, 0x2A]) {
        return PanoFormat::Raw;
    }
    // HEIF/HEIC: offset-4 ftyp box marker
    if bytes.len() >= 8 && &bytes[4..8] == b"ftyp" {
        return PanoFormat::Heif;
    }
    PanoFormat::Unknown
}

// ---------------------------------------------------------------------------
// Decode dispatch
// ---------------------------------------------------------------------------

/// Decode a `PanoInput` into a `PanoImage`, routing to the appropriate
/// decoder based on the sniffed format.
pub fn decode_input(input: &PanoInput) -> Result<PanoImage, PanoError> {
    match input {
        PanoInput::Decoded(img) => Ok(img.clone()),
        PanoInput::Bytes(bytes) => decode_bytes(bytes),
    }
}

/// Decode in-memory bytes into a `PanoImage`.
///
/// Format is detected by sniffing; the appropriate decoder is invoked:
/// - PNG / JPEG → `image` crate (via `image::load_from_memory`)
/// - TIFF magic (DNG, NEF, CR2, ARW, …) → `raw_core::decode_for_pano`
/// - HEIF → error unless compiled with the `heif` feature
/// - Unknown magic → `PanoError::Decode`
pub fn decode_bytes(bytes: &[u8]) -> Result<PanoImage, PanoError> {
    match sniff_format(bytes) {
        PanoFormat::Png => decode_via_image_crate(bytes, image::ImageFormat::Png),
        PanoFormat::Jpeg => decode_via_image_crate(bytes, image::ImageFormat::Jpeg),
        PanoFormat::Raw => decode_via_raw_core(bytes),
        PanoFormat::Heif => {
            #[cfg(feature = "heif")]
            {
                // TODO(T-heif): implement via libheif-rs once dep is added.
                Err(PanoError::Other(
                    "HEIF decoding is not yet implemented (feature placeholder)".to_string(),
                ))
            }
            #[cfg(not(feature = "heif"))]
            {
                Err(PanoError::Other(
                    "HEIF not enabled — build with the `heif` feature".to_string(),
                ))
            }
        }
        PanoFormat::Unknown => Err(PanoError::Decode(
            "could not detect input format from magic bytes".to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Decoder back-ends (private)
// ---------------------------------------------------------------------------

/// Decode a PNG or JPEG via the `image` crate and convert into a `PanoImage`
/// in the Rec.2020 D65 linear working space.
///
/// The `image` crate returns sRGB data; we linearise via the sRGB EOTF and
/// then apply the sRGB→Rec.2020 primary matrix so the result sits in the same
/// working space as all RAW inputs.
fn decode_via_image_crate(bytes: &[u8], fmt: image::ImageFormat) -> Result<PanoImage, PanoError> {
    let img = image::load_from_memory_with_format(bytes, fmt)
        .map_err(|e| PanoError::Decode(e.to_string()))?;

    // `into_rgb32f` only normalises u8 → f32 in [0, 1]. It does NOT apply
    // the sRGB transfer function (the docs are silent on this; verified
    // empirically — passing sRGB-encoded PNG bytes through this path and
    // skipping srgb_decode produces ~+0.25 brightness bias on linear
    // round-trip). We apply the decode explicitly below.
    let rgb = img.into_rgb32f();
    let width = rgb.width();
    let height = rgb.height();
    let n_pixels = (width as usize) * (height as usize);

    use raw_core::color::matrices::M_REC2020_TO_SRGB;
    use std::sync::OnceLock;
    static M_SRGB_TO_REC2020: OnceLock<[[f32; 3]; 3]> = OnceLock::new();
    let m = M_SRGB_TO_REC2020.get_or_init(|| {
        M_REC2020_TO_SRGB
            .inverse()
            .expect("M_REC2020_TO_SRGB is always invertible")
            .0
    });

    let raw_pixels = rgb.into_raw(); // interleaved f32, sRGB-encoded in [0, 1]
    let mut pixels = vec![0.0f32; n_pixels * 3];

    for i in 0..n_pixels {
        // sRGB-encoded → linear sRGB (transfer decode).
        let r_lin = srgb_decode(raw_pixels[i * 3]);
        let g_lin = srgb_decode(raw_pixels[i * 3 + 1]);
        let b_lin = srgb_decode(raw_pixels[i * 3 + 2]);
        // Linear sRGB → linear Rec.2020.
        pixels[i * 3] = m[0][0] * r_lin + m[0][1] * g_lin + m[0][2] * b_lin;
        pixels[i * 3 + 1] = m[1][0] * r_lin + m[1][1] * g_lin + m[1][2] * b_lin;
        pixels[i * 3 + 2] = m[2][0] * r_lin + m[2][1] * g_lin + m[2][2] * b_lin;
    }

    Ok(PanoImage {
        pixels,
        width,
        height,
        color: ColorSpace::rec2020_d65_linear(),
        validity: BitVec::repeat(true, n_pixels),
    })
}

/// sRGB transfer function — encoded [0, 1] → linear [0, 1].
#[inline]
fn srgb_decode(x: f32) -> f32 {
    if x <= 0.040_45 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

/// Decode a TIFF/DNG/NEF/CR2/ARW byte slice via `raw_core::decode_for_pano`,
/// then convert the resulting scene-linear image into a `PanoImage`.
fn decode_via_raw_core(bytes: &[u8]) -> Result<PanoImage, PanoError> {
    // Use "dng" as the extension hint — rawler dispatches on file magic
    // internally for all supported TIFF-container formats (DNG, NEF, CR2, ARW,
    // etc.) when the container matches, so the hint is only a fallback.
    let ingest =
        raw_core::decode_for_pano(bytes, "dng").map_err(|e| PanoError::Decode(e.to_string()))?;
    Ok(from_raw_core_image(&ingest.image, ingest.orientation))
}

// ---------------------------------------------------------------------------
// Existing helper (unchanged)
// ---------------------------------------------------------------------------

/// Convert a raw-core `Image` (post-DCP, scene-linear Rec.2020 D65) into a
/// `PanoImage`, applying EXIF orientation in the same pass.
pub fn from_raw_core_image(src: &Image, orient: ExifOrientation) -> PanoImage {
    let (w, h) = (src.width as usize, src.height as usize);
    debug_assert_eq!(
        src.pixels.len(),
        w * h,
        "raw-core Image pixel count mismatch"
    );

    let (new_w, new_h) = if orient.swaps_wh() {
        (src.height, src.width)
    } else {
        (src.width, src.height)
    };

    let dw = new_w as usize;
    let dh = new_h as usize;
    let mut pixels = vec![0.0f32; dw * dh * 3];

    for yp in 0..dh {
        for xp in 0..dw {
            let (sx, sy) = match orient {
                ExifOrientation::Normal => (xp, yp),
                ExifOrientation::HorizontalFlip => (w - 1 - xp, yp),
                ExifOrientation::Rotate180 => (w - 1 - xp, h - 1 - yp),
                ExifOrientation::VerticalFlip => (xp, h - 1 - yp),
                ExifOrientation::Transpose => (yp, xp),
                ExifOrientation::Rotate90 => (yp, h - 1 - xp),
                ExifOrientation::Transverse => (w - 1 - yp, h - 1 - xp),
                ExifOrientation::Rotate270 => (w - 1 - yp, xp),
            };
            let src_pixel = src.pixels[sy * w + sx];
            let di = (yp * dw + xp) * 3;
            pixels[di] = src_pixel[0];
            pixels[di + 1] = src_pixel[1];
            pixels[di + 2] = src_pixel[2];
        }
    }

    PanoImage {
        pixels,
        width: new_w,
        height: new_h,
        color: ColorSpace::rec2020_d65_linear(),
        validity: BitVec::repeat(true, dw * dh),
    }
}
