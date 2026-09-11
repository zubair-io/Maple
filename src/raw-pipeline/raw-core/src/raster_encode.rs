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
    /// Which ICC profile the container is tagged with. The pixels must
    /// already be in this space — `RasterImage::to_colourspace` moves them
    /// (#3503).
    pub primaries: TargetPrimaries,
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
    // Single source of truth for the AVIF+P3 rejection — see
    // `export::reject_untagged_avif_p3`'s doc comment. `encode_raster_rgb`
    // (below, via the flatten path) runs the same check again, so this call
    // is what makes the RGBA/alpha-keeping branch reject the combination too,
    // before it ever reaches `encode_avif_rgba_with_speed`.
    crate::export::reject_untagged_avif_p3(opts.format, opts.primaries)?;
    let keeps_alpha = raster.channels == 4 && container_supports_alpha(opts.format);
    let quality = if opts.quality == 0 {
        85
    } else {
        opts.quality.clamp(1, 100)
    };
    if !keeps_alpha {
        let flat = composite_over_background(raster, JPEG_FLATTEN_BACKGROUND);
        return crate::export::encode_raster_rgb(
            &flat,
            opts.format,
            quality,
            opts.avif_speed,
            opts.primaries,
        );
    }
    match opts.format {
        ExportFormat::Png => encode_png_rgba(raster, icc::profile_for(opts.primaries)),
        ExportFormat::Webp => encode_webp_rgba(raster, opts.primaries),
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

/// Mirrors `export::encode_webp`'s sRGB-stays-untagged rule: `set_icc_profile`
/// is only called for Display P3, so an sRGB-tagged RGBA WebP keeps the exact
/// bytes this crate shipped before #3503.
fn encode_webp_rgba(raster: &RasterImage, primaries: TargetPrimaries) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::new();
    let mut encoder = WebPEncoder::new_lossless(&mut out);
    if primaries == TargetPrimaries::P3 {
        encoder
            .set_icc_profile(icc::profile_for(primaries))
            .map_err(|e| crate::error::Error::Png(e.to_string()))?;
    }
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
            primaries: TargetPrimaries::Srgb,
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
    fn srgb_rgba_webp_stays_untagged() {
        let bytes = encode_raster_opts(&rgba_pair(), &opts(ExportFormat::Webp)).unwrap();
        assert!(
            !bytes.windows(4).any(|w| w == b"ICCP"),
            "sRGB RGBA WebP must stay untagged, matching pre-#3503 output"
        );
    }

    #[test]
    fn p3_rgba_webp_carries_the_display_p3_icc_profile() {
        let bytes = encode_raster_opts(
            &rgba_pair(),
            &RasterEncodeOptions {
                primaries: TargetPrimaries::P3,
                ..opts(ExportFormat::Webp)
            },
        )
        .unwrap();
        let profile = icc::profile_for(TargetPrimaries::P3);
        assert!(
            bytes.windows(4).any(|w| w == b"ICCP"),
            "Display P3 RGBA WebP is missing its ICCP chunk"
        );
        assert!(bytes
            .windows(profile.len())
            .any(|w| w == profile.as_slice()));
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

    #[test]
    fn a_transparent_red_pixel_encodes_as_black_not_red() {
        // Names the exact colour a compositing bug would leak: if alpha is
        // dropped instead of composited, a [255,0,0,0] pixel keeps its red
        // channel and comes out red, not black (#3501 — raw-ffi's
        // `render_into` did exactly this via `encode_raster_rgb` before it
        // was pointed at this function).
        let transparent_red = RasterImage::new_rgba(1, 1, vec![255, 0, 0, 0]);
        let bytes = encode_raster_opts(&transparent_red, &opts(ExportFormat::Jpeg)).unwrap();
        let decoded = crate::raster::decode_raster(&bytes, Some("jpeg")).unwrap();
        let (r, g, b) = (decoded.data[0], decoded.data[1], decoded.data[2]);
        assert!(
            r < 24 && g < 24 && b < 24,
            "transparent red pixel encoded as ({r},{g},{b}), expected near-black"
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

    #[test]
    fn the_encode_primaries_choose_the_embedded_profile() {
        let img = RasterImage::new_rgb(4, 4, vec![100; 48]);
        let srgb = encode_raster_opts(
            &img,
            &RasterEncodeOptions {
                primaries: crate::view::encode::TargetPrimaries::Srgb,
                ..opts(ExportFormat::Jpeg)
            },
        )
        .unwrap();
        let p3 = encode_raster_opts(
            &img,
            &RasterEncodeOptions {
                primaries: crate::view::encode::TargetPrimaries::P3,
                ..opts(ExportFormat::Jpeg)
            },
        )
        .unwrap();
        assert!(srgb.windows(12).any(|w| w == b"ICC_PROFILE\0"));
        assert_ne!(srgb, p3, "the two profiles must produce different bytes");
    }

    /// The ICC bytes embedded for a P3-tagged raster must actually describe
    /// Display P3, not merely differ from the sRGB profile by coincidence —
    /// `icc::profile_for` writes the description into a `desc` tag as plain
    /// ASCII, so a byte search for it is a direct check that the RIGHT
    /// profile landed in the container.
    #[test]
    fn the_p3_jpeg_embeds_a_profile_naming_display_p3() {
        let img = RasterImage::new_rgb(4, 4, vec![100; 48]);
        let bytes = encode_raster_opts(
            &img,
            &RasterEncodeOptions {
                primaries: crate::view::encode::TargetPrimaries::P3,
                ..opts(ExportFormat::Jpeg)
            },
        )
        .unwrap();
        assert!(
            bytes
                .windows(b"Display P3".len())
                .any(|w| w == b"Display P3"),
            "P3 JPEG's embedded ICC profile does not name Display P3"
        );
    }

    #[test]
    fn avif_rejects_display_p3_by_name_rather_than_shipping_it_untagged() {
        let img = RasterImage::new_rgb(2, 2, vec![10; 12]);
        let err = encode_raster_opts(
            &img,
            &RasterEncodeOptions {
                primaries: crate::view::encode::TargetPrimaries::P3,
                ..opts(ExportFormat::Avif)
            },
        )
        .unwrap_err();
        assert!(
            format!("{err}").to_lowercase().contains("avif"),
            "expected the AVIF/P3 combination to be named in the error, got: {err}"
        );
    }

    #[cfg(feature = "avif")]
    #[test]
    fn avif_still_encodes_when_tagged_srgb() {
        let img = RasterImage::new_rgb(2, 2, vec![10; 12]);
        assert!(encode_raster_opts(&img, &opts(ExportFormat::Avif)).is_ok());
    }
}
