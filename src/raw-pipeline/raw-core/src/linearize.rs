use crate::image::{CfaPattern, ColorSpace, Image, RawImage};
use rayon::prelude::*;

/// Sensor linearization per spec § 3.2.
/// `linear = (raw - black) / (white - black)` clamped to [0, 1].
/// Produces a three-channel `Image` where only the CFA-appropriate channel is
/// populated per pixel; the other two are zero. (Demosaic fills them in.)
///
/// **Must NOT be called on `CfaPattern::LinearRgb` data** — that variant has
/// already-demosaiced interleaved RGB, not a Bayer mosaic, and `raw_data` is
/// `3 × w × h` instead of `w × h`. Use [`linearraw_to_camera_rgb`] instead.
///
/// ## DNG `LinearizationTable` (tag 50712 / 0xC618)
///
/// The DNG spec lets a producer ship a per-value LUT that maps encoded sensor
/// codes to linear codes (DNG 1.6 § "Linearization Table"). It is applied
/// **before** black-level subtraction and white-level normalization in the
/// conceptual pipeline.
///
/// **We do not apply it here.** Rawler 0.7.x applies the table during decode
/// itself — see `rawler/src/decoders/mod.rs::apply_linearization` (called at
/// line 641-642 of the Integer-sample-format path, immediately after the
/// decompressor and crop, before the data leaves the decoder). By the time
/// `raw_data` reaches this function, the LUT has already been remapped and
/// the values are linear codes in the `[0, 2^bits - 1]` range that
/// `BlackLevel` and `WhiteLevel` describe. Applying the LUT a second time
/// would double-remap and silently corrupt every DNG that ships the tag
/// (e.g. Sony ARQ pixel-shift, some Pentax / Leica bodies). See ticket #418
/// for the verification regression test
/// (`test_support::synth_dng` round-trip with a hand-crafted LUT).
///
/// Caveat: rawler's Float-sample-format path (`SampleFormat::IEEEFP`) carries
/// a `TODO: other corrections` and does **not** apply the LUT. No fixture we
/// ship hits that combination (linear-float DNG implies already-linearized
/// data; the LUT is exclusively a Bayer/integer feature in the wild). If a
/// future fixture ever combines `RawImageData::Float` with a present
/// `LinearizationTable`, revisit here.
pub fn sensor_linearize(raw: &RawImage) -> Image {
    sensor_linearize_region(raw, 0, 0, raw.width, raw.height)
}

/// Linearize a single rectangular region of the sensor. Output is an
/// `Image` of size `(rect_w, rect_h)` — only the requested rect is
/// processed, not the full sensor. Used by the tile path so a 100 MP
/// RAW doesn't pay the full ~480 ms of linearize work per visible tile;
/// instead each tile linearizes its ~512×512-region (with overlap) in
/// a few ms.
///
/// `rect_x` and `rect_y` MUST be even-aligned for Bayer-phase
/// preservation (the caller is `pad_and_clamp_mosaic_rect`, which
/// rounds the start corners down to even). The CFA pattern indexing
/// uses absolute sensor coords so the returned mosaic carries the
/// correct color-at-position assignments.
pub fn sensor_linearize_region(
    raw: &RawImage,
    rect_x: u32,
    rect_y: u32,
    rect_w: u32,
    rect_h: u32,
) -> Image {
    debug_assert_ne!(
        raw.cfa,
        CfaPattern::LinearRgb,
        "sensor_linearize must not be called on LinearRgb data; \
         use linearraw_to_camera_rgb instead. See ticket #07."
    );
    debug_assert!(
        rect_x + rect_w <= raw.width && rect_y + rect_h <= raw.height,
        "rect ({},{},{},{}) out of bounds for sensor ({},{})",
        rect_x,
        rect_y,
        rect_w,
        rect_h,
        raw.width,
        raw.height
    );

    let sensor_w = raw.width as usize;
    let rw = rect_w as usize;
    let mut img = Image::new(rect_w, rect_h, ColorSpace::CameraNativeMosaic);

    // Zero-area rect: nothing to linearize. Return the empty image rather
    // than reaching `par_chunks_mut(0)`, which panics ("chunk_size must
    // not be zero"). Unreachable via `decode_bytes` — it rejects zero-dim
    // sensors (#1087) — so this is defense in depth for direct callers
    // that build a `RawImage` by hand.
    if rect_w == 0 || rect_h == 0 {
        return img;
    }

    let wl = raw.white_level as f32;
    // `black_level` is per 2×2 position for Bayer and per CFA colour for
    // X-Trans — see `RawImage::black_level`.
    let black_by_colour = raw.cfa.is_xtrans();
    let transfers = crate::sensor_gain_maps::transfers_apply(raw);
    img.pixels
        .par_chunks_mut(rw)
        .enumerate()
        .for_each(|(local_y, row)| {
            let abs_y = rect_y as usize + local_y;
            let raw_row = &raw.raw_data[abs_y * sensor_w..(abs_y + 1) * sensor_w];
            for (local_x, px) in row.iter_mut().enumerate() {
                let abs_x = rect_x as usize + local_x;
                let color = raw.cfa.color_at(abs_x as u32, abs_y as u32) as usize;
                let bl_idx = if black_by_colour {
                    color
                } else {
                    ((abs_y & 1) << 1) | (abs_x & 1)
                };
                let bl = raw.black_level[bl_idx] as f32;
                let denom = (wl - bl).max(1.0);
                let raw_v = raw_row[abs_x] as f32;
                let v = ((raw_v - bl) / denom).clamp(0.0, 1.0);
                px[color] = raw.sensor_gain_maps.as_ref().map_or(v, |maps| {
                    maps.apply(abs_x as u32, abs_y as u32, 0, v, transfers)
                });
            }
        });
    img
}

/// LinearRaw decode entry. Reshape interleaved `[R₀ G₀ B₀ R₁ G₁ B₁ …]`
/// `raw.raw_data` into a `CameraNativeLinearRgb` `Image`, normalizing
/// per-channel by `(white_level - black_level)` and (for 8-bit lossy
/// LinearRaw) undoing the DNG Converter's implicit gamma encoding.
///
/// **Two flavors of LinearRaw exist in the wild:**
///
/// 1. **8-bit lossy linear DNG** (`Compression = LossyJPEG`,
///    `BitsPerSample = 8 8 8`, no `LinearizationTable`): the DNG
///    Converter writes data with WB pre-applied AND a perceptually-
///    uniform gamma curve (~2.4) before JPEG compression. We detect
///    via `white_level <= 255` and invert: `linear = encoded^2.4`. The
///    data stays WB-baked; DCP handles via `wb_already_baked = false`
///    (legacy `inv(CM) · AsShotNeutral` path — see lossy_8bit comment).
///
/// 2. **High-bit-depth linear DNG / Canon sRaw / iPhone LinearRaw**:
///    data is in **camera-RGB space** — a neutral patch reads as
///    `(K × asn_r, K, K × asn_b)`, the same shape the Bayer pipeline
///    produces post-demosaic. We just black-normalize; downstream
///    pre-gain in `pipeline/develop.rs` divides by AsShotNeutral so
///    neutrals enter DCP as `(1, 1, 1)`. `dcp::apply` handles it
///    identically to Bayer.
///
///    Verified by `examples/sraw_probe` (ticket #373): center-patch
///    R/G ≈ AsShotNeutral_R for Canon sRaw (5DM4) and iPhone 12 Pro —
///    camera-RGB, NOT pre-baked WB. The pre-#373 multiply by
///    AsShotNeutral cancelled with pre-gain (leaving camera-RGB into
///    DCP) but `dcp::profile_for` set `wb_already_baked = true`, so
///    Bradford used `inv(CM) · (1,1,1)` instead of
///    `inv(CM) · AsShotNeutral` — crushing R on Canon sRaw neutrals.
///
/// Skips both `sensor_linearize` and `demosaic::*` because the data is
/// already 3-channel RGB. Caller dispatches on
/// `raw.cfa == CfaPattern::LinearRgb`. See ticket #07.
pub fn linearraw_to_camera_rgb(raw: &RawImage) -> crate::Result<Image> {
    debug_assert_eq!(raw.cfa, CfaPattern::LinearRgb);
    let w = raw.width as usize;
    let h = raw.height as usize;
    let expected = 3 * w * h;
    if raw.raw_data.len() != expected {
        return Err(crate::Error::Decode {
            path: std::path::PathBuf::from("<linearraw>"),
            reason: format!(
                "LinearRaw raw_data length {} != 3 × {} × {} = {} (expected interleaved RGB)",
                raw.raw_data.len(),
                w,
                h,
                expected
            ),
        });
    }
    let wl = raw.white_level as f32;
    // LinearRaw `black_level` is per channel `[R, G, B, B]` — see
    // `RawImage::black_level`.
    let bl_r = raw.black_level[0] as f32;
    let bl_g = raw.black_level[1] as f32;
    let bl_b = raw.black_level[2] as f32;
    let denom_r = (wl - bl_r).max(1.0);
    let denom_g = (wl - bl_g).max(1.0);
    let denom_b = (wl - bl_b).max(1.0);

    // Distinguish 8-bit lossy (gamma-encoded) from high-bit-depth (linear).
    // 8-bit white_level == 255 is the unambiguous signal: any DNG-Converter lossy
    // linear DNG without a LinearizationTable lands here. High-bit-depth
    // lossy DNGs go through rawler's `apply_linearization` and arrive
    // already linearized at white_level = 65535 (or similar).
    let lossy_8bit = raw.white_level <= 255;
    let transfers = crate::sensor_gain_maps::transfers_apply(raw);
    let corrections = raw.sensor_gain_maps.as_ref();

    let mut img = Image::new(raw.width, raw.height, ColorSpace::CameraNativeLinearRgb);
    img.pixels.par_iter_mut().enumerate().for_each(|(idx, px)| {
        let off = idx * 3;
        let (x, y) = ((idx % w) as u32, (idx / w) as u32);
        let encoded = [
            ((raw.raw_data[off] as f32 - bl_r) / denom_r).clamp(0.0, 1.0),
            ((raw.raw_data[off + 1] as f32 - bl_g) / denom_g).clamp(0.0, 1.0),
            ((raw.raw_data[off + 2] as f32 - bl_b) / denom_b).clamp(0.0, 1.0),
        ];
        *px = std::array::from_fn(|plane| {
            let value = encoded[plane];
            // 8-bit lossy LinearRaw is gamma-encoded: invert the DNG
            // Converter's usual gamma 2.4, even where the file declares its
            // own OpcodeList2 transfer (`transfers_apply`, #5081). WB stays
            // baked; DCP derives `scene_white_xyz` from
            // `inv(CM) · AsShotNeutral` (legacy path), which matched the
            // reference better than `wb_already_baked = true`.
            let decoded = if lossy_8bit { value.powf(2.4) } else { value };
            corrections.map_or(decoded, |c| c.apply(x, y, plane as u32, decoded, transfers))
        });
    });
    Ok(img)
}

// Tests live in the sibling `linearize_tests.rs` so this file stays clear
// of the 570-line headroom gate (#4730 took it to 567); same `#[path]`
// split pattern as `image.rs` / `image_tests.rs`.
#[cfg(test)]
#[path = "linearize_tests.rs"]
mod tests;
