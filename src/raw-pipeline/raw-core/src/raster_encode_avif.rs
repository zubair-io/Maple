//! AVIF and WebP encode with the options #3506 asks for.
//!
//! AVIF goes through `ravif::Encoder` directly rather than `image`'s wrapper,
//! because the wrapper exposes only speed and quality — not the chroma
//! subsampling choice, the alpha quality, or the `Exif` item that
//! `withMetadata({ orientation })` needs for AVIF output.
//!
//! WebP is LOSSLESS ONLY. There is no pure-Rust lossy WebP encoder, so
//! `lossless: false` is a named error rather than a silent fallback to a
//! four-times-larger lossless file — see the plan's decision D6. ICC and XMP
//! for AVIF are likewise not writable by `avif-serialize` 0.8.8 and are out of
//! Tier 2 (decision D5).
//!
//! AVIF 4:2:0 chroma subsampling is likewise a named error, not a working
//! option: the vendored `ravif` 0.13 hard-codes `ChromaSampling::Cs444` in
//! every encode path, and its own `encode_raw_planes_8_bit` doc says chroma
//! subsampling isn't supported. `ColorModel::YCbCr` only changes the BT.601
//! colour-transform matrix, not the sampled chroma resolution, so requesting
//! `AvifChroma::Yuv420` fails loudly rather than silently returning a 4:4:4
//! file under a 4:2:0 label. 4:4:4 (sharp's own AVIF default) is the only
//! chroma mode this encoder actually produces today.
//!
//! AVIF `lossless: true` is a named error for the same reason: the vendored
//! `rav1e` never reaches true AV1 lossless mode. `ravif` maps quality 100 to
//! quantizer 0, but `rav1e::rate` clamps the resulting `base_q_idx` to a
//! minimum of 1 (`select_ac_qi(..).max(1)` in `rate.rs`), and
//! `segmentation.rs` documents the same floor as deliberate ("avoid going
//! into lossless mode by never bringing qidx below 1") — `encoder.rs`'s
//! `write_tx_blocks` even panics with "attempting to encode a lossless
//! block (not yet supported)" if that floor is ever bypassed. So quality 100
//! is rav1e's finest **lossy** step, not lossless, even though it happens to
//! round-trip exactly on smooth, low-frequency test images — it is not
//! exact in general. Requesting it fails loudly rather than silently
//! shipping a lossy file under a lossless label.

use crate::error::{Error, Result};
use crate::raster::RasterImage;

use imgref::Img;
use ravif::{ColorModel, Encoder};
use rgb::{RGB8, RGBA8};

/// AVIF chroma subsampling. sharp defaults AVIF to 4:4:4, unlike JPEG.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum AvifChroma {
    #[default]
    Yuv444,
    Yuv420,
}

impl AvifChroma {
    pub fn from_wire(s: &str) -> Option<Self> {
        match s {
            "4:4:4" => Some(Self::Yuv444),
            "4:2:0" => Some(Self::Yuv420),
            _ => None,
        }
    }

    /// `ColorModel::RGB` codes the samples with an identity matrix — no
    /// chroma channels to subsample, which is how ravif expresses 4:4:4.
    fn color_model(self) -> ColorModel {
        match self {
            Self::Yuv444 => ColorModel::RGB,
            Self::Yuv420 => ColorModel::YCbCr,
        }
    }
}

/// sharp's `avif()` options. `bitdepth` (10/12) and `tune` are not
/// implemented and are rejected by name at the recipe layer.
#[derive(Clone, Copy, Debug)]
pub struct AvifOptions {
    pub quality: u8,
    /// sharp's scale: 0 (fastest) ..= 9 (slowest).
    pub effort: u8,
    /// Always rejected by `encode_avif_opts` when `true` — the vendored
    /// `rav1e` never enters true AV1 lossless mode (its `base_q_idx` floor
    /// is 1, not 0). See the module doc.
    pub lossless: bool,
    pub chroma_subsampling: AvifChroma,
}

impl Default for AvifOptions {
    fn default() -> Self {
        Self {
            quality: 50,
            effort: 4,
            lossless: false,
            chroma_subsampling: AvifChroma::Yuv444,
        }
    }
}

fn avif_error(e: impl std::fmt::Display) -> Error {
    Error::Png(format!("avif encode failed: {e}"))
}

/// sharp's AVIF `effort` (0 fastest … 9 slowest) → rav1e speed (10 fastest …
/// 1 slowest). The recipe pipeline (`raster_recipe_output::output_from_wire`)
/// passes `effort` straight through into [`AvifOptions`] and calls this
/// function via `encode_avif_opts` rather than re-deriving the mapping
/// itself, so there is exactly one place this table can drift.
pub(crate) fn avif_speed_for(effort: u8) -> u8 {
    10 - effort.min(9)
}

pub fn encode_avif_opts(
    raster: &RasterImage,
    options: &AvifOptions,
    exif: Option<&[u8]>,
) -> Result<Vec<u8>> {
    // The vendored `rav1e` never reaches true AV1 lossless mode: its
    // `base_q_idx` is floored at 1 (`select_ac_qi(..).max(1)` in
    // `rate.rs`), a floor `segmentation.rs` documents as deliberate, and
    // `encoder.rs::write_tx_blocks` panics on an unencoded lossless block.
    // Quality 100 is therefore rav1e's finest *lossy* step, not lossless —
    // it happens to round-trip exactly on smooth test images, but that is
    // not a general guarantee. See the module doc.
    if options.lossless {
        return Err(Error::UnsupportedFormat(
            "AVIF lossless encode is not supported: the vendored rav1e never \
             enters AV1 lossless mode (qidx clamped to 1). Proposed ticket: \
             'maple: true AVIF lossless once rav1e supports qidx 0'."
                .into(),
        ));
    }
    // The vendored ravif 0.13 hard-codes `ChromaSampling::Cs444` in every
    // encode path (`av1encoder.rs`), and `encode_raw_planes_8_bit`'s own doc
    // says "chroma subsampling is not supported, and it's a bad idea for
    // AVIF anyway" — `ColorModel::YCbCr` only swaps the BT.601 colour-
    // transform matrix, it never actually halves the chroma plane
    // resolution. Shipping `Yuv420` as if it worked would silently produce
    // a 4:4:4 file under a "4:2:0" label, so it is a named error instead of
    // a no-op.
    if options.chroma_subsampling == AvifChroma::Yuv420 {
        return Err(Error::UnsupportedFormat(
            "AVIF 4:2:0 chroma subsampling is not supported: the vendored ravif \
             0.13 encoder always emits 4:4:4 chroma planes, so requesting 4:2:0 \
             would silently produce a 4:4:4 file. Pass \
             { chromaSubsampling: '4:4:4' } (the default). Proposed ticket: \
             'maple: AVIF 4:2:0 chroma subsampling — needs a ravif that \
             exposes Cs420'."
                .into(),
        ));
    }
    let speed = avif_speed_for(options.effort);
    let quality = f32::from(options.quality.clamp(1, 100));
    let model = options.chroma_subsampling.color_model();
    let base = Encoder::new()
        .with_quality(quality)
        .with_alpha_quality(quality)
        .with_speed(speed)
        .with_internal_color_model(model);
    let encoder = match exif {
        Some(block) => base.with_exif(block.to_vec()),
        None => base,
    };
    let (w, h) = (raster.width as usize, raster.height as usize);
    let encoded = if raster.channels == 4 {
        let pixels: Vec<RGBA8> = raster
            .data
            .chunks_exact(4)
            .map(|p| RGBA8::new(p[0], p[1], p[2], p[3]))
            .collect();
        encoder.encode_rgba(Img::new(pixels.as_slice(), w, h))
    } else {
        let pixels: Vec<RGB8> = raster
            .data
            .chunks_exact(3)
            .map(|p| RGB8::new(p[0], p[1], p[2]))
            .collect();
        encoder.encode_rgb(Img::new(pixels.as_slice(), w, h))
    }
    .map_err(avif_error)?;
    Ok(encoded.avif_file)
}

/// WebP. Lossless only — see the module doc and the plan's decision D6.
pub fn encode_webp_opts(raster: &RasterImage, lossless: bool) -> Result<Vec<u8>> {
    if !lossless {
        return Err(Error::UnsupportedFormat(
            "WebP lossy encode is not supported: Maple's WebP encoder is lossless-only \
             (pure-Rust constraint). Pass { lossless: true } or choose avif/jpeg."
                .into(),
        ));
    }
    let mut out: Vec<u8> = Vec::new();
    image::codecs::webp::WebPEncoder::new_lossless(&mut out)
        .encode(
            &raster.data,
            raster.width,
            raster.height,
            if raster.channels == 4 {
                image::ExtendedColorType::Rgba8
            } else {
                image::ExtendedColorType::Rgb8
            },
        )
        .map_err(|e| Error::Png(format!("webp encode failed: {e}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(w: u32, h: u32, alpha: bool) -> RasterImage {
        let channels = if alpha { 4 } else { 3 };
        let data = (0..h)
            .flat_map(|y| {
                (0..w).flat_map(move |x| {
                    let r = (x * 255 / (w - 1)) as u8;
                    let g = (y * 255 / (h - 1)) as u8;
                    let mut px = vec![r, g, 128];
                    if alpha {
                        px.push(if x < w / 2 { 255 } else { 64 });
                    }
                    px
                })
            })
            .collect();
        RasterImage {
            width: w,
            height: h,
            channels,
            data,
            orientation: crate::image::ExifOrientation::Normal,
        }
    }

    fn opts() -> AvifOptions {
        AvifOptions {
            quality: 60,
            effort: 9,
            lossless: false,
            chroma_subsampling: AvifChroma::Yuv444,
        }
    }

    #[test]
    fn encodes_an_avif_that_decodes_back() {
        let src = gradient(32, 24, false);
        let bytes = encode_avif_opts(&src, &opts(), None).unwrap();
        assert_eq!(&bytes[4..8], b"ftyp");
        let decoded = crate::avif_decode::decode_avif(&bytes).unwrap();
        assert_eq!((decoded.width, decoded.height), (32, 24));
    }

    #[test]
    fn alpha_survives_an_avif_round_trip() {
        let src = gradient(32, 24, true);
        let bytes = encode_avif_opts(&src, &opts(), None).unwrap();
        let decoded = crate::avif_decode::decode_avif(&bytes).unwrap();
        assert_eq!(decoded.channels, 4);
        assert!(decoded.data[3] > 200, "the opaque half lost its alpha");
        let right = ((24 / 2 * 32 + 30) * 4 + 3) as usize;
        assert!(
            decoded.data[right] < 120,
            "the translucent half lost its alpha"
        );
    }

    #[test]
    fn four_two_zero_is_a_named_error_not_a_silent_four_four_four() {
        // The vendored ravif 0.13 has no real 4:2:0 path (see the guard's
        // comment in `encode_avif_opts`) — requesting it must fail loudly
        // rather than silently hand back a 4:4:4 file under a 4:2:0 label.
        let src = gradient(32, 24, false);
        let err = encode_avif_opts(
            &src,
            &AvifOptions {
                chroma_subsampling: AvifChroma::Yuv420,
                ..opts()
            },
            None,
        )
        .unwrap_err();
        let message = format!("{err}");
        assert!(message.contains("4:2:0"), "got: {message}");
    }

    #[test]
    fn lossless_is_a_named_error_not_a_silent_lossy_encode() {
        // The vendored rav1e can't reach qidx 0 (see the module doc and the
        // guard's comment in `encode_avif_opts`), so `lossless: true` must
        // fail loudly rather than silently hand back a lossy file under a
        // lossless label.
        let src = gradient(16, 16, false);
        let err = encode_avif_opts(
            &src,
            &AvifOptions {
                lossless: true,
                ..opts()
            },
            None,
        )
        .unwrap_err();
        let message = format!("{err}");
        assert!(message.contains("lossless"), "got: {message}");
    }

    #[test]
    fn avif_speed_for_pins_effort_to_speed() {
        // sharp effort 0 (fastest) ..= 9 (slowest) -> rav1e speed 10 ..= 1.
        // Must stay equal to `raster_recipe_exec::avif_speed` (Tier 1 pins
        // this mapping) so the recipe path and this direct path agree.
        assert_eq!(avif_speed_for(0), 10);
        assert_eq!(avif_speed_for(4), 6);
        assert_eq!(avif_speed_for(9), 1);
    }

    #[test]
    fn an_exif_item_is_written_into_the_container() {
        let exif = b"II\x2a\x00\x08\x00\x00\x00\x00\x00".to_vec();
        let bytes = encode_avif_opts(&gradient(16, 16, false), &opts(), Some(&exif)).unwrap();
        assert!(
            bytes.windows(4).any(|w| w == b"Exif"),
            "no Exif item in the AVIF"
        );
    }

    #[test]
    fn webp_lossless_round_trips_with_alpha() {
        let src = gradient(16, 16, true);
        let bytes = encode_webp_opts(&src, true).unwrap();
        assert_eq!(&bytes[..4], b"RIFF");
        let decoded = crate::raster::decode_raster(&bytes, Some("webp")).unwrap();
        assert_eq!((decoded.channels, decoded.data), (4, src.data));
    }

    #[test]
    fn webp_lossy_is_a_named_error_not_a_silent_fallback() {
        let err = encode_webp_opts(&gradient(8, 8, false), false).unwrap_err();
        let message = format!("{err}");
        assert!(message.contains("lossless"), "got: {message}");
    }
}
