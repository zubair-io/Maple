//! Quantize / dither tests, split from `encode.rs` (#2683 file-budget
//! split — same pattern as `encode_p3_tests.rs` / `encode_gamut_guard.rs`).
//!
//! Every test here targets [`quantize_u8`] / [`dither_and_quantize`] and the
//! 8-bit dithering they apply. sRGB-path and P3-path tests stay split into
//! `encode.rs` / `encode_p3_tests.rs` respectively.

use super::*;

#[test]
fn quantize_produces_expected_length() {
    let mut img = Image::new(4, 4, ColorSpace::DisplayLinearSrgb);
    let bytes = quantize_u8(&mut img);
    assert_eq!(bytes.len(), 4 * 4 * 3);
}

#[test]
fn quantize_black_is_zero() {
    // Display-linear 0 → sRGB-encoded 0 → u8 0.
    let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
    let bytes = quantize_u8(&mut img);
    assert!(bytes.iter().all(|b| *b == 0));
}

#[test]
fn quantize_white_is_255() {
    // Display-linear 1.0 → sRGB-encoded 1.0 → u8 255.
    let mut img = Image::new(2, 2, ColorSpace::DisplayLinearSrgb);
    for p in &mut img.pixels {
        *p = [1.0, 1.0, 1.0];
    }
    let bytes = quantize_u8(&mut img);
    assert!(bytes.iter().all(|b| *b == 255));
}

#[test]
fn dither_breaks_up_smooth_gradient() {
    // Smooth scene-linear gradient — the un-dithered post-gamma
    // output has visible run-length plateaus (multiple columns
    // sharing the same u8), so the band as a whole spans far fewer
    // u8 values than columns. That ratio IS the banding signal.
    // Bayer ±0.5 LSB jitter must strictly increase the unique-count
    // (gradient picks up more steps, plateaus break apart).
    //
    // Pick scene-linear [0, 0.02] — a deep-shadow band where the
    // sRGB gamma curve is locally flat; the un-dithered path
    // collapses 512 columns into a small handful of u8 values
    // (textbook sky-banding).
    let w = 512u32;
    let h = 8u32;
    let mut img = Image::new(w, h, ColorSpace::DisplayLinearSrgb);
    for y in 0..h as usize {
        for x in 0..w as usize {
            let v = (x as f32 / (w - 1) as f32) * 0.02;
            img.pixels[y * w as usize + x] = [v, v, v];
        }
    }

    // Un-dithered baseline — mirrors the pre-#441 quantize body.
    let mut undith_seen = [false; 256];
    for p in &img.pixels {
        let g = srgb_gamma(p[0]);
        let b = (g * 255.0 + 0.5).clamp(0.0, 255.0) as u8;
        undith_seen[b as usize] = true;
    }
    let undith_unique = undith_seen.iter().filter(|&&b| b).count();

    let bytes = quantize_u8(&mut img);
    let mut dith_seen = [false; 256];
    for chunk in bytes.chunks_exact(3) {
        dith_seen[chunk[0] as usize] = true;
    }
    let dith_unique = dith_seen.iter().filter(|&&b| b).count();

    // Also count column-to-column "transitions" — how often
    // adjacent columns in a single row hold different u8 values.
    // The banding artefact IS the long flat plateau: un-dithered
    // adjacent columns frequently share a u8, transitions << w-1.
    // Dither breaks the plateau boundaries — transitions across
    // an 8-row tile should approach w-1.
    let row_transitions = |row: &[u8]| -> usize { row.windows(2).filter(|p| p[0] != p[1]).count() };
    let mut undith_row = Vec::with_capacity(w as usize);
    for x in 0..w as usize {
        let v = (x as f32 / (w - 1) as f32) * 0.02;
        let g = srgb_gamma(v);
        undith_row.push((g * 255.0 + 0.5).clamp(0.0, 255.0) as u8);
    }
    let undith_tx = row_transitions(&undith_row);
    // Average transitions across the dithered tile rows.
    let mut dith_tx_total = 0usize;
    for y in 0..h as usize {
        let row: Vec<u8> = (0..w as usize)
            .map(|x| bytes[(y * w as usize + x) * 3])
            .collect();
        dith_tx_total += row_transitions(&row);
    }
    let dith_tx_avg = dith_tx_total / h as usize;

    eprintln!(
        "shadow ramp [0, 0.02] over {w}x{h}: \
         un-dithered={undith_unique} unique u8 ({undith_tx} col transitions), \
         dithered={dith_unique} unique u8 ({dith_tx_avg} avg col transitions)"
    );

    // Same unique-count range bounds (no clipping introduced).
    assert_eq!(
        undith_unique, dith_unique,
        "dither must not change the span of u8 values (it only \
         re-distributes them spatially): un={undith_unique} \
         d={dith_unique}",
    );
    // Banding signature: un-dithered transitions are a small
    // fraction of column count (long plateaus). Dither must lift
    // the per-row transition count substantially.
    assert!(
        dith_tx_avg > undith_tx * 3,
        "dither must break plateaus — expected at least 3x more \
         column transitions; un-dithered={undith_tx} \
         dithered_avg={dith_tx_avg}",
    );
    // And dither transitions should be a substantial fraction of
    // w-1 (the upper bound is every adjacent pair differing). The
    // observed value on this fixture is ~253/511 — well above the
    // banding-prone un-dithered 39.
    assert!(
        dith_tx_avg as u32 >= w / 4,
        "dither transitions {dith_tx_avg} should be a substantial \
         fraction of column count (≥ {})",
        w / 4,
    );
}

#[test]
fn dither_preserves_mean_on_solid_color() {
    // 16×16 of mid-gray. After gamma, scene 0.18 → display-encoded
    // ≈ 0.461 → u8 ≈ 117.5. Bayer dither produces a mix of 117 and
    // 118; nothing should land further than ±1 LSB from 117.5
    // (i.e. all outputs ∈ {117, 118}).
    let mut img = Image::new(16, 16, ColorSpace::DisplayLinearSrgb);
    for p in &mut img.pixels {
        *p = [0.18, 0.18, 0.18];
    }
    let bytes = quantize_u8(&mut img);
    let mut min_b = u8::MAX;
    let mut max_b = u8::MIN;
    let mut sum: u32 = 0;
    for &b in &bytes {
        min_b = min_b.min(b);
        max_b = max_b.max(b);
        sum += b as u32;
    }
    // ±1 LSB band: max - min ≤ 1.
    assert!(
        max_b - min_b <= 1,
        "solid colour dithered to >1 LSB span: [{min_b}, {max_b}]",
    );
    let mean = sum as f32 / bytes.len() as f32;
    // Tile mean = 0; centered around the un-dithered value 117.5.
    assert!(
        (mean - 117.5).abs() < 1.0,
        "dithered mean {mean} drifted from un-dithered ~117.5",
    );
}

#[test]
fn quantize_mid_gray_lands_near_118() {
    // Display-linear 0.18 → sRGB-encoded ≈ 0.461 → u8 ≈ 118. This is
    // the classic mid-gray placement in display-encoded sRGB; the
    // Maple AgX polynomial is calibrated to land scene 0.18 here.
    let mut img = Image::new(1, 1, ColorSpace::DisplayLinearSrgb);
    img.pixels[0] = [0.18, 0.18, 0.18];
    let bytes = quantize_u8(&mut img);
    for &b in &bytes {
        assert!(
            (b as i32 - 118).abs() <= 2,
            "mid-gray u8 = {}, expected near 118",
            b
        );
    }
}
