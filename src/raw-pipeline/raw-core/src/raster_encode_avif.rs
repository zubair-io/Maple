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
//!
//! AVIF `bitdepth` IS honoured, for the two depths `ravif` implements: 8 and
//! 10. `Encoder::new()`'s own default is `BitDepth::Auto`, which the vendored
//! `ravif` resolves to `Ten` — and a 10-bit AV1 bitstream is undecodable by
//! libheif's prebuilt decoders, i.e. by sharp, which is exactly what still
//! reads Maple's output while #3499 migrates `src/api` off it. So the
//! encoder pins the depth explicitly on every call and defaults to 8, sharp's
//! own `heif()` default. sharp's third value, 12, is a named error.

use crate::error::{Error, Result};
use crate::raster::RasterImage;

use imgref::Img;
use ravif::{BitDepth, ColorModel, Encoder};
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

/// sharp's `avif()` options. `tune` is not a sharp option at all; every
/// other key `heif()` documents is honoured here.
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
    /// Bits per channel inside the AV1 bitstream: 8 or 10. sharp's own
    /// `heif()` default is 8, and 8 is what libheif's prebuilt decoders can
    /// read (sharp itself refuses anything but 8 on a prebuilt binary), so
    /// 8 is the default here too. 12 is a real sharp value `ravif` cannot
    /// produce and is rejected by name — see [`bit_depth_for`].
    ///
    /// `u16`, not `u8`: an out-of-range wire value (300) must reach
    /// `bit_depth_for`'s own error message intact rather than first being
    /// narrowed to `u8::MAX` (255) on the way in — see
    /// `raster_recipe_output.rs`.
    pub bitdepth: u16,
}

impl Default for AvifOptions {
    fn default() -> Self {
        Self {
            quality: 50,
            effort: 4,
            lossless: false,
            chroma_subsampling: AvifChroma::Yuv444,
            bitdepth: 8,
        }
    }
}

/// sharp's AVIF `bitdepth` (8 | 10 | 12) → `ravif`'s [`BitDepth`], which has
/// exactly two real variants: `Eight` and `Ten` (its `Auto` is documented as
/// "same as `Ten`"). 12 returns `None` so the caller can reject it by name
/// rather than silently writing 10-bit under a 12-bit label.
///
/// The default MUST stay 8. `Encoder::new()` starts at `BitDepth::Auto`,
/// which resolves to `Ten` — and a 10-bit AVIF is undecodable by libheif's
/// prebuilt AV1 decoders, which is what sharp, and therefore everything
/// still reading Maple's output during the #3499 migration, uses. Leaving
/// the builder's default in place is how AVIF output silently became
/// unreadable before this call was added.
fn bit_depth_for(bitdepth: u16) -> Option<BitDepth> {
    match bitdepth {
        8 => Some(BitDepth::Eight),
        10 => Some(BitDepth::Ten),
        _ => None,
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
    let depth = bit_depth_for(options.bitdepth).ok_or_else(|| {
        Error::UnsupportedFormat(format!(
            "AVIF bitdepth {} is not supported (8 or 10): the vendored ravif \
             0.13 exposes only 8- and 10-bit AV1 output. Proposed ticket: \
             'maple: 12-bit AVIF once ravif exposes BitDepth::Twelve'.",
            options.bitdepth
        ))
    })?;
    let speed = avif_speed_for(options.effort);
    let quality = f32::from(options.quality.clamp(1, 100));
    let model = options.chroma_subsampling.color_model();
    let base = Encoder::new()
        .with_quality(quality)
        .with_alpha_quality(quality)
        .with_speed(speed)
        .with_bit_depth(depth)
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
#[path = "raster_encode_avif_tests.rs"]
mod tests;
