//! Apply the per-image Auto Profile tail (#550 curve + residual 3D LUT) to a
//! developed display buffer. Shared by the `Path` and `Bytes` render arms so the
//! ordering/cache logic lives in exactly one place.

use std::path::Path;

use crate::image::ExifOrientation;

use super::cache::{self, CacheKey};
use super::curve::ProfileCurve;
use super::lut::{self, ColorLut};
use super::{apply_curve, fit_curve_from_bytes_display, fit_curve_from_raw_display};

/// Where the embedded JPEG comes from for the fit: a native file path (with the
/// exiftool fallback) or in-memory bytes (WASM, no subprocess).
#[derive(Clone, Copy)]
pub enum AutoSource<'a> {
    Path(&'a Path),
    Bytes { bytes: &'a [u8], ext: &'a str },
}

/// Apply the Auto Profile tail in place to `pixels` (interleaved RGB f32,
/// `DisplayEncodedSrgb`, `w × h`, sensor-oriented). Two layered stages:
///   1. the #550 per-channel tone curve — fit on the pre-curve buffer (or reused
///      from `cached_curve`), applied in place so `pixels` becomes `curve(maple)`
///      (owns tone + brightness);
///   2. the per-image residual 3D LUT — fit on the now-curved buffer (or reused
///      from `cached_lut`) so its pairs are `(curve(maple), jpeg)` and it carries
///      only the cross-channel residual the separable curve can't.
///
/// The LUT generalizes the curve (a per-channel curve is a diagonal LUT), so
/// `MAPLE_AUTO_LUT_STRENGTH=0` ⇒ identity residual ⇒ output is exactly the #550
/// curve (the accuracy floor); `MAPLE_DISABLE_AUTO_LUT` skips the residual.
/// A `None` fit (no embedded JPEG / too few pairs) is a no-op for that stage,
/// leaving the AgX-Neutral buffer. Successful fits insert into the shared `cache`
/// LRU keyed on `cache_key`.
pub fn apply_auto_profile(
    pixels: &mut [f32],
    w: usize,
    h: usize,
    orientation: ExifOrientation,
    source: AutoSource<'_>,
    cache_key: Option<&CacheKey>,
    cached_curve: Option<ProfileCurve>,
    cached_lut: Option<ColorLut>,
) {
    // 1. #550 per-channel curve.
    let curve = cached_curve.or_else(|| {
        let fitted = match source {
            AutoSource::Path(p) => fit_curve_from_raw_display(p, pixels, w, h, orientation),
            AutoSource::Bytes { bytes, ext } => {
                fit_curve_from_bytes_display(bytes, ext, pixels, w, h, orientation)
            }
        };
        if let (Some(key), Some(c)) = (cache_key, fitted.as_ref()) {
            cache::insert(key.clone(), c.clone());
        }
        fitted
    });
    if let Some(c) = &curve {
        apply_curve(pixels, c);
    }

    // 2. residual 3D LUT — fit on the now-curved buffer ⇒ pairs are
    //    (curve(maple), jpeg), so it corrects only the post-curve residual.
    let residual = cached_lut.or_else(|| {
        let fitted = match source {
            AutoSource::Path(p) => lut::fit_lut_from_raw_display(p, pixels, w, h, orientation),
            AutoSource::Bytes { bytes, ext } => {
                lut::fit_lut_from_bytes_display(bytes, ext, pixels, w, h, orientation)
            }
        };
        if let (Some(key), Some(l)) = (cache_key, fitted.as_ref()) {
            cache::insert_lut(key.clone(), l.clone());
        }
        fitted
    });
    if let Some(l) = residual {
        if std::env::var_os("MAPLE_DISABLE_AUTO_LUT").is_none() {
            l.apply(pixels);
        }
    }
}
