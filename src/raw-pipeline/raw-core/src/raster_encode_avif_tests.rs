//! Tests for [`super`]'s AVIF and WebP encoders, in a sibling file (the
//! `#[path]` pattern `raster_encode_jpeg.rs`/`raster_encode_png.rs`/
//! `raster_encode_tiff.rs` already use) so the encoder module itself stays
//! inside the file-size budget.

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
        bitdepth: 8,
    }
}

/// The `pixi` (pixel information) box records bits-per-channel for every
/// channel in the item. Parsed by hand rather than through a decoder so the
/// assertion is on the bytes Maple actually wrote, not on whatever depth a
/// decoder chooses to hand back.
fn pixi_bits(bytes: &[u8]) -> Vec<u8> {
    let at = bytes
        .windows(4)
        .position(|w| w == b"pixi")
        .expect("no pixi box in the AVIF");
    // `pixi`: 4-byte size, 'pixi', 4-byte version+flags, 1-byte channel
    // count, then one byte of depth per channel.
    let count = bytes[at + 8] as usize;
    bytes[at + 9..at + 9 + count].to_vec()
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

/// `Encoder::new()` starts at `BitDepth::Auto`, which the vendored ravif
/// resolves to `Ten` — and libheif's prebuilt decoders (sharp's, i.e. every
/// reader left in the fleet during the #3499 migration) cannot decode a
/// 10-bit AV1 bitstream at all. The default MUST therefore write 8, and the
/// `pixi` box is where that is observable without a decoder.
#[test]
fn the_default_bit_depth_is_eight_in_the_pixi_box() {
    let bytes = encode_avif_opts(&gradient(32, 24, false), &opts(), None).unwrap();
    assert_eq!(pixi_bits(&bytes), vec![8, 8, 8]);
    // `AvifOptions::default()` (what a bare `avif()` with no options maps to)
    // must agree with the explicit 8 above, not fall back to ravif's Auto.
    let defaulted =
        encode_avif_opts(&gradient(32, 24, false), &AvifOptions::default(), None).unwrap();
    assert_eq!(pixi_bits(&defaulted), vec![8, 8, 8]);
}

/// The other depth ravif implements. A caller who explicitly asks for 10
/// gets 10 — the point of honouring the option rather than pinning 8 and
/// rejecting the key.
#[test]
fn bitdepth_ten_is_honoured_and_reaches_the_pixi_box() {
    let bytes = encode_avif_opts(
        &gradient(32, 24, false),
        &AvifOptions {
            bitdepth: 10,
            ..opts()
        },
        None,
    )
    .unwrap();
    assert_eq!(pixi_bits(&bytes), vec![10, 10, 10]);
}

/// The alpha item is a second AV1 bitstream with its own `pixi`-declared
/// depth (ravif applies `with_bit_depth` to both), so the RGBA path needs its
/// own pin: a 10-bit alpha plane fails to decode for the same reason a
/// 10-bit colour plane does.
#[test]
fn the_rgba_path_also_writes_eight_bit() {
    let bytes = encode_avif_opts(&gradient(32, 24, true), &opts(), None).unwrap();
    assert!(
        pixi_bits(&bytes).iter().all(|&d| d == 8),
        "got {:?}",
        pixi_bits(&bytes)
    );
}

/// 12 is a real sharp `heif()` value (`[8, 10, 12]`) that `ravif`'s
/// `BitDepth` has no variant for — it must be a named rejection, not a
/// silent 10-bit file under a 12-bit label.
#[test]
fn bitdepth_twelve_is_a_named_error() {
    let err = encode_avif_opts(
        &gradient(16, 16, false),
        &AvifOptions {
            bitdepth: 12,
            ..opts()
        },
        None,
    )
    .unwrap_err();
    let message = format!("{err}");
    assert!(message.contains("12"), "got: {message}");
    assert!(message.contains("bitdepth"), "got: {message}");
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

/// A 64x64 gradient-plus-bounded-noise source — the shape of real
/// photographic content, deliberately avoiding `gradient()`'s wrap-around
/// moire (which is the right stressor for a byte-exact round trip and the
/// wrong one for a lossy size/quality comparison). Mirrors the `photographic()`
/// helper in `src/maple/test/oracle.test.ts` exactly, so a number measured
/// here and a number measured through the oracle describe the same source.
fn photographic(w: u32, h: u32) -> Vec<u8> {
    let mut state: u32 = 7;
    let mut data = Vec::with_capacity((w * h * 3) as usize);
    for y in 0..h {
        for x in 0..w {
            state = state.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (((state >> 22) & 31) as i32) - 16;
            let clamp = |v: i32| v.clamp(0, 255) as u8;
            data.push(clamp(x as i32 * 4 + noise));
            data.push(clamp(y as i32 * 4 + noise));
            data.push(clamp(128 + ((x + y) as i32 >> 1) + noise));
        }
    }
    data
}

/// The size/quality trade the fix for #3583 turns on: with 4:4:4 chroma
/// fixed either way (ravif has no other subsampling — see the module doc),
/// `ColorModel::YCbCr` must beat `ColorModel::RGB` on file size at every
/// quality this encoder actually ships (30, 50, 80), at the same speed
/// `encode_avif_opts` uses for `AvifOptions::default()`'s `effort: 4`.
/// Encodes with both models directly (bypassing `encode_avif_opts`, which —
/// after the fix — only ever reaches `YCbCr`) so this test still means
/// something if that function's own default ever changes again.
#[test]
fn ycbcr_beats_rgb_on_size_at_every_quality() {
    let (w, h) = (64usize, 64usize);
    let data = photographic(w as u32, h as u32);
    let pixels: Vec<RGB8> = data
        .chunks_exact(3)
        .map(|p| RGB8::new(p[0], p[1], p[2]))
        .collect();
    let speed = avif_speed_for(4); // `AvifOptions::default()`'s effort.
    let encode = |model: ColorModel, quality: f32| -> usize {
        Encoder::new()
            .with_quality(quality)
            .with_alpha_quality(quality)
            .with_speed(speed)
            .with_bit_depth(BitDepth::Eight)
            .with_internal_color_model(model)
            .encode_rgb(Img::new(pixels.as_slice(), w, h))
            .unwrap()
            .avif_file
            .len()
    };
    // Measured on this fixture: q30 410→397 B (-3%), q50 838→584 B (-30%),
    // q80 1760→1122 B (-36%) — see the module doc and the closing-pass
    // report for the corresponding PSNR costs.
    for quality in [30.0f32, 50.0, 80.0] {
        let rgb_len = encode(ColorModel::RGB, quality);
        let ycbcr_len = encode(ColorModel::YCbCr, quality);
        assert!(
            ycbcr_len < rgb_len,
            "quality {quality}: YCbCr ({ycbcr_len} B) did not beat RGB ({rgb_len} B)"
        );
    }
}

/// The PSNR half of the same trade `ycbcr_beats_rgb_on_size_at_every_quality`
/// measures for size: `ColorModel::YCbCr` must not cost more than 1 dB
/// against the source at any of the three qualities this encoder ships,
/// which is the fidelity price for the size win above.
#[test]
fn ycbcr_psnr_cost_versus_rgb_stays_under_one_db() {
    fn psnr(a: &[u8], b: &[u8]) -> f64 {
        let n = a.len().min(b.len());
        let mse: f64 = (0..n)
            .map(|i| {
                let d = f64::from(a[i]) - f64::from(b[i]);
                d * d
            })
            .sum::<f64>()
            / n as f64;
        if mse == 0.0 {
            f64::INFINITY
        } else {
            10.0 * (255.0 * 255.0 / mse).log10()
        }
    }

    let (w, h) = (64usize, 64usize);
    let data = photographic(w as u32, h as u32);
    let pixels: Vec<RGB8> = data
        .chunks_exact(3)
        .map(|p| RGB8::new(p[0], p[1], p[2]))
        .collect();
    let speed = avif_speed_for(4);
    let encode_and_decode = |model: ColorModel, quality: f32| -> f64 {
        let bytes = Encoder::new()
            .with_quality(quality)
            .with_alpha_quality(quality)
            .with_speed(speed)
            .with_bit_depth(BitDepth::Eight)
            .with_internal_color_model(model)
            .encode_rgb(Img::new(pixels.as_slice(), w, h))
            .unwrap()
            .avif_file;
        let decoded = crate::avif_decode::decode_avif(&bytes).unwrap();
        psnr(&decoded.data, &data)
    };
    // Measured on this fixture: q30 costs 0.26 dB (28.93→28.67), q50 and q80
    // are actually FREE — YCbCr's decorrelation wins on fidelity too (q50
    // 30.02→30.11, q80 34.09→34.86) — see the module doc and the
    // closing-pass report.
    for quality in [30.0f32, 50.0, 80.0] {
        let rgb_db = encode_and_decode(ColorModel::RGB, quality);
        let ycbcr_db = encode_and_decode(ColorModel::YCbCr, quality);
        let cost = rgb_db - ycbcr_db;
        assert!(
            cost < 1.0,
            "quality {quality}: YCbCr cost {cost:.2} dB against RGB ({rgb_db:.2} vs {ycbcr_db:.2})"
        );
    }
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
