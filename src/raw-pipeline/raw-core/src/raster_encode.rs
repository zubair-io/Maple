//! Alpha-aware encode for `RasterImage` (#3505).
//!
//! `export::encode_raster_rgb` flattened every raster to RGB before encoding,
//! so a 4-channel input and the alpha item of a decoded AVIF were both thrown
//! away at the last step. Here PNG, WebP and AVIF write the alpha channel, and
//! JPEG and TIFF — containers with no alpha — composite over black, which is
//! what libvips/sharp do when an alpha channel reaches a JPEG encoder.

use crate::error::Result;
use crate::export::ExportFormat;
use crate::icc;
use crate::raster::RasterImage;
use crate::view::encode::TargetPrimaries;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{ExtendedColorType, ImageEncoder};

/// Background a JPEG/TIFF encode composites transparent pixels over when the
/// caller did not run `flatten`. Black, matching libvips.
pub const JPEG_FLATTEN_BACKGROUND: [u8; 3] = [0, 0, 0];

/// Everything the raster encoders get to choose in Tier 2's PR-A. PR-F widens
/// this into per-format option structs; the field set here is what the Tier 1
/// FFI surface already exposed.
#[derive(Clone, Copy, Debug)]
pub struct RasterEncodeOptions {
    pub format: ExportFormat,
    /// 1..=100; 0 means "encoder default" and is normalised by the caller.
    pub quality: u8,
    /// rav1e speed 1 (slowest) ..= 10 (fastest).
    pub avif_speed: u8,
}

/// Composite a raster over an opaque background, returning a 3-channel
/// raster. A 3-channel input is returned unchanged (cloned) — there is
/// nothing to flatten. Uses straight (non-premultiplied) source alpha, which
/// is how `RasterImage` stores it.
///
/// `pub(crate)` and shared with `raster_alpha::flatten` (A2, #3505): the same
/// composite arithmetic backs both this encoder's implicit JPEG/TIFF flatten
/// and the export pipeline's explicit "flatten to background" step, so the
/// two paths can never disagree on how a transparent pixel blends.
pub(crate) fn composite_over_background(raster: &RasterImage, background: [u8; 3]) -> RasterImage {
    if raster.channels == 3 {
        return raster.clone();
    }
    let rgb: Vec<u8> = raster
        .data
        .chunks_exact(4)
        .flat_map(|px| {
            let a = px[3] as u32;
            [0usize, 1, 2].map(|i| {
                let blended = px[i] as u32 * a + background[i] as u32 * (255 - a);
                // Round-to-nearest division by 255 without a float round-trip.
                (((blended + 128) * 257) >> 16) as u8
            })
        })
        .collect();
    RasterImage {
        width: raster.width,
        height: raster.height,
        channels: 3,
        data: rgb,
        orientation: raster.orientation,
    }
}

/// `true` when this container can carry an alpha channel at all.
///
/// `pub(crate)`: shared with `raster_recipe_exec::encode` (#3505 fix-round-1)
/// so the recipe executor's reported `RecipeResult::channels` never disagrees
/// with what this function actually wrote to the container.
pub(crate) fn container_supports_alpha(format: ExportFormat) -> bool {
    matches!(
        format,
        ExportFormat::Png | ExportFormat::Webp | ExportFormat::Avif
    )
}

/// Encode `raster` per `opts`, keeping its alpha channel when the container
/// supports one (PNG, WebP, AVIF) and compositing over
/// [`JPEG_FLATTEN_BACKGROUND`] first when it does not (JPEG, TIFF) or the
/// raster has no alpha to begin with.
pub fn encode_raster_opts(raster: &RasterImage, opts: &RasterEncodeOptions) -> Result<Vec<u8>> {
    let keeps_alpha = raster.channels == 4 && container_supports_alpha(opts.format);
    let quality = if opts.quality == 0 {
        85
    } else {
        opts.quality.clamp(1, 100)
    };
    if !keeps_alpha {
        let flat = composite_over_background(raster, JPEG_FLATTEN_BACKGROUND);
        return crate::export::encode_raster_rgb(&flat, opts.format, quality, opts.avif_speed);
    }
    match opts.format {
        ExportFormat::Png => encode_png_rgba(raster, icc::profile_for(TargetPrimaries::Srgb)),
        ExportFormat::Webp => encode_webp_rgba(raster),
        ExportFormat::Avif => crate::export::encode_avif_rgba_with_speed(
            raster.width,
            raster.height,
            &raster.data,
            quality,
            opts.avif_speed,
        ),
        // `container_supports_alpha` gated the arms above; anything else took
        // the flatten path already.
        other => Err(crate::error::Error::UnsupportedFormat(format!(
            "{other:?} cannot carry an alpha channel"
        ))),
    }
}

fn encode_png_rgba(raster: &RasterImage, profile: Vec<u8>) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = PngEncoder::new(&mut out);
    encoder
        .set_icc_profile(profile)
        .map_err(|e| crate::error::Error::Png(e.to_string()))?;
    encoder
        .write_image(
            &raster.data,
            raster.width,
            raster.height,
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| crate::error::Error::Png(e.to_string()))?;
    Ok(out)
}

fn encode_webp_rgba(raster: &RasterImage) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    WebPEncoder::new_lossless(&mut out)
        .encode(
            &raster.data,
            raster.width,
            raster.height,
            ExtendedColorType::Rgba8,
        )
        .map_err(|e| crate::error::Error::Png(e.to_string()))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 2x1 RGBA: opaque red, then fully transparent green.
    fn rgba_pair() -> RasterImage {
        RasterImage::new_rgba(2, 1, vec![255, 0, 0, 255, 0, 255, 0, 0])
    }

    fn opts(format: ExportFormat) -> RasterEncodeOptions {
        RasterEncodeOptions {
            format,
            quality: 90,
            avif_speed: 10,
        }
    }

    #[test]
    fn png_keeps_the_alpha_channel() {
        let bytes = encode_raster_opts(&rgba_pair(), &opts(ExportFormat::Png)).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
        assert_eq!(decoded.channels, 4, "PNG dropped the alpha channel");
        assert_eq!(decoded.data[3], 255);
        assert_eq!(decoded.data[7], 0);
    }

    #[test]
    fn webp_keeps_the_alpha_channel() {
        let bytes = encode_raster_opts(&rgba_pair(), &opts(ExportFormat::Webp)).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("webp")).unwrap();
        assert_eq!(decoded.channels, 4, "WebP dropped the alpha channel");
        assert_eq!(decoded.data[7], 0);
    }

    #[test]
    fn jpeg_flattens_transparent_pixels_over_black() {
        let bytes = encode_raster_opts(&rgba_pair(), &opts(ExportFormat::Jpeg)).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
        assert_eq!(decoded.channels, 3);
        // The transparent green pixel must arrive as black, not as green.
        let (r, g, b) = (decoded.data[3], decoded.data[4], decoded.data[5]);
        assert!(
            r < 24 && g < 24 && b < 24,
            "transparent pixel encoded as ({r},{g},{b}), expected near-black"
        );
    }

    /// AVIF's alpha item is a separate code path from PNG/WebP's interleaved
    /// alpha channel (`encode_avif_rgba_with_speed` → `ravif::Encoder::encode_rgba`,
    /// #3505), so it needs its own round-trip pin rather than relying on the
    /// PNG/WebP coverage above.
    #[cfg(feature = "avif")]
    #[test]
    fn avif_round_trips_the_alpha_channel() {
        let bytes = encode_raster_opts(&rgba_pair(), &opts(ExportFormat::Avif)).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("avif")).unwrap();
        assert_eq!(decoded.channels, 4, "AVIF dropped the alpha channel");
        assert_eq!(
            decoded.data[7], 0,
            "the fully-transparent pixel's alpha byte"
        );
    }

    #[test]
    fn an_rgb_raster_is_unchanged_by_the_alpha_path() {
        let rgb = RasterImage::new_rgb(2, 1, vec![10, 20, 30, 40, 50, 60]);
        let bytes = encode_raster_opts(&rgb, &opts(ExportFormat::Png)).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("png")).unwrap();
        assert_eq!(decoded.channels, 3);
        assert_eq!(decoded.data, vec![10, 20, 30, 40, 50, 60]);
    }
}
