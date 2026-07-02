#![cfg(test)]

use super::*;

/// Canonical Fuji X-Trans pattern (matches the test_0008.RAF
/// fixture's XTransLayout). Used for synthetic constructions in
/// the unit tests.
const FUJI_PATTERN: [u8; 36] = [
    1, 1, 0, 1, 1, 2, 1, 1, 2, 1, 1, 0, 2, 0, 1, 0, 2, 1, 1, 1, 2, 1, 1, 0, 1, 1, 0, 1, 1, 2, 0, 2,
    1, 2, 0, 1,
];

fn xtrans_uniform(w: u32, h: u32, r: f32, g: f32, b: f32) -> (Image, CfaPattern) {
    let cfa = CfaPattern::XTrans(FUJI_PATTERN);
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            let v = match c {
                0 => r,
                1 => g,
                2 => b,
                _ => 0.0,
            };
            img.pixels[(y * w + x) as usize][c] = v;
        }
    }
    (img, cfa)
}

#[test]
fn xtrans_bilinear_uniform_input_produces_uniform_output() {
    let (mosaic, cfa) = xtrans_uniform(36, 36, 0.4, 0.5, 0.6);
    let out = xtrans_bilinear(&mosaic, cfa);
    // Interior pixels — strict tolerance. Border pixels can drift
    // because the 3×3 window collapses to fewer R/B samples.
    for y in 4..32 {
        for x in 4..32 {
            let p = out.pixels[y * 36 + x];
            assert!((p[0] - 0.4).abs() < 1e-4, "R: {}", p[0]);
            assert!((p[1] - 0.5).abs() < 1e-4, "G: {}", p[1]);
            assert!((p[2] - 0.6).abs() < 1e-4, "B: {}", p[2]);
        }
    }
}

#[test]
fn xtrans_bilinear_output_space_is_camera_native_rgb() {
    let (mosaic, cfa) = xtrans_uniform(12, 12, 0.1, 0.1, 0.1);
    let out = xtrans_bilinear(&mosaic, cfa);
    assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
}

#[test]
fn markesteijn_uniform_input_produces_uniform_output() {
    let (mosaic, cfa) = xtrans_uniform(36, 36, 0.4, 0.5, 0.6);
    let out = markesteijn(&mosaic, cfa);
    // Interior pixels under the 2-px margin.
    for y in 4..32 {
        for x in 4..32 {
            let p = out.pixels[y * 36 + x];
            assert!((p[0] - 0.4).abs() < 5e-3, "R at ({},{}): {}", x, y, p[0]);
            assert!((p[1] - 0.5).abs() < 5e-3, "G at ({},{}): {}", x, y, p[1]);
            assert!((p[2] - 0.6).abs() < 5e-3, "B at ({},{}): {}", x, y, p[2]);
        }
    }
}

#[test]
fn markesteijn_output_space_is_camera_native_rgb() {
    let (mosaic, cfa) = xtrans_uniform(16, 16, 0.1, 0.1, 0.1);
    let out = markesteijn(&mosaic, cfa);
    assert_eq!(out.space, ColorSpace::CameraNativeLinearRgb);
}

#[test]
fn markesteijn_small_image_falls_back_to_bilinear() {
    // 6×6 is below the 7-px Markesteijn threshold so we get the
    // bilinear path. With mirror-correct CFA lookup at the border,
    // bilinear of a uniform input converges exactly because every
    // 3×3-or-5×5 window carries non-zero counts for all channels.
    let (mosaic, cfa) = xtrans_uniform(6, 6, 0.2, 0.3, 0.4);
    let out = markesteijn(&mosaic, cfa);
    assert_eq!(out.width, 6);
    assert_eq!(out.height, 6);
    for p in &out.pixels {
        assert!((p[0] - 0.2).abs() < 1e-4, "R: {}", p[0]);
        assert!((p[1] - 0.3).abs() < 1e-4, "G: {}", p[1]);
        assert!((p[2] - 0.4).abs() < 1e-4, "B: {}", p[2]);
    }
}

#[test]
fn markesteijn_resolves_finer_detail_than_xtrans_bilinear() {
    // Synthetic detail patch: a high-contrast checkerboard at
    // 2-pixel period, modulated by the X-Trans CFA. A simple
    // bilinear demosaicer will blur the checkerboard; Markesteijn's
    // directional/color-difference reconstruction preserves it.
    //
    // The HF-energy metric is the sum of L1 green-channel gradients
    // (∂x + ∂y) over the interior. Higher = more detail preserved.
    let cfa = CfaPattern::XTrans(FUJI_PATTERN);
    let (w, h) = (36u32, 36u32);
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    // Encode a checkerboard scene as the CFA-appropriate channel at
    // each pixel. Cell value alternates per 2×2 block.
    for y in 0..h {
        for x in 0..w {
            let block = ((x / 2) + (y / 2)) & 1;
            let v = if block == 0 { 0.2 } else { 0.8 };
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = v;
        }
    }

    let bi = xtrans_bilinear(&img, cfa);
    let mk = markesteijn(&img, cfa);
    let hf_energy = |buf: &Image| -> f64 {
        let mut s = 0.0_f64;
        let wu = buf.width as usize;
        let hu = buf.height as usize;
        for y in 4..hu - 4 {
            for x in 4..wu - 4 {
                let i = y * wu + x;
                let dx = (buf.pixels[i + 1][1] - buf.pixels[i - 1][1]).abs();
                let dy = (buf.pixels[i + wu][1] - buf.pixels[i - wu][1]).abs();
                s += (dx + dy) as f64;
            }
        }
        s
    };
    let hf_bi = hf_energy(&bi);
    let hf_mk = hf_energy(&mk);
    eprintln!(
        "xtrans HF energy: bilinear={:.3} markesteijn={:.3} ratio={:.3}×",
        hf_bi,
        hf_mk,
        hf_mk / hf_bi
    );
    // Markesteijn must preserve at least as much HF energy as
    // bilinear on this synthetic patch. The 1.0 floor (no slack) is
    // intentional — the algorithm's job is detail recovery; if it
    // doesn't beat bilinear on a 2-pixel checkerboard there is no
    // reason to ship it.
    assert!(
        hf_mk >= hf_bi,
        "Markesteijn HF energy {:.3} below bilinear HF energy {:.3} \
         (ratio {:.3}) — Markesteijn must preserve at least as much \
         detail as bilinear on a 2-pixel checkerboard",
        hf_mk,
        hf_bi,
        hf_mk / hf_bi
    );
}

/// xtrans_bilinear must preserve the measured center-channel value
/// exactly — only the two missing channels at each site are
/// interpolated. Before #420's review fix, the kernel averaged the
/// center sample with its same-channel neighbours, which biased the
/// measured value on any non-uniform scene (a no-op for uniform
/// patches, but a real blur of the sampled data — and the
/// Markesteijn seed pass inherits the bias).
///
/// Construct a "saturated patch": every cell holds its CFA-channel
/// value 1.0, except one off-center cell that holds a known
/// outlier. Demosaic and assert the outlier survives verbatim at
/// the same channel slot at its own coordinates.
#[test]
fn xtrans_bilinear_preserves_measured_center_channel() {
    let cfa = CfaPattern::XTrans(FUJI_PATTERN);
    let (w, h) = (12u32, 12u32);
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    // Saturate every cell at 0.5 in its own channel.
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            img.pixels[(y * w + x) as usize][c] = 0.5;
        }
    }
    // Pick a sample slot well inside the interior so it isn't
    // touched by the 5×5 widen-on-edge path. Put a known outlier in
    // its measured channel only.
    let (sx, sy) = (5u32, 5u32);
    let sc = cfa.color_at(sx, sy) as usize;
    let outlier = 0.93_f32;
    img.pixels[(sy * w + sx) as usize][sc] = outlier;

    let out = xtrans_bilinear(&img, cfa);
    let p = out.pixels[(sy * w + sx) as usize];
    // The center-channel value at (sx, sy) must equal the measured
    // sample, byte-for-byte. The other two channels are
    // neighbour-averaged and don't see the outlier.
    assert_eq!(
        p[sc], outlier,
        "xtrans_bilinear must preserve the measured center-channel \
         sample exactly, got {} expected {} at channel {}",
        p[sc], outlier, sc
    );
}

/// Regression test for the `directional_green` CFA-lookup
/// coordinate-mismatch bug (PR #465 review comment 2): when the
/// gradient picker selects a direction whose walk crosses the
/// image border on the *unclamped* coords, the CFA lookup wraps
/// modulo 6 to a different channel from the one `at()` actually
/// returns (which clamps to the border). The fix clamps both
/// to the same coord. We assert markesteijn output finiteness +
/// no negative values on a non-uniform mosaic that exercises the
/// 2-px interior margin in every column (x ∈ {2, 3}). Before the
/// fix this could surface as a non-green sample being averaged
/// in as green at columns near the left edge.
#[test]
fn markesteijn_edge_column_directional_green_is_consistent() {
    let cfa = CfaPattern::XTrans(FUJI_PATTERN);
    let (w, h) = (24u32, 24u32);
    let mut img = Image::new(w, h, ColorSpace::CameraNativeMosaic);
    // Non-uniform but smooth scene: gradient in x. The
    // directional_green axis walk picks H most of the time on
    // this scene, and the H walk steps land on the left border
    // for x ∈ {2, 3} with k=2,3. That's the path the bug was on.
    for y in 0..h {
        for x in 0..w {
            let c = cfa.color_at(x, y) as usize;
            let v = 0.1 + 0.7 * (x as f32 / (w - 1) as f32);
            img.pixels[(y * w + x) as usize][c] = v;
        }
    }
    let out = markesteijn(&img, cfa);
    // For x in the interior-margin columns, the reconstructed
    // green plane must be (a) finite, (b) non-negative, and
    // (c) within the input range [0.1, 0.8] padded by a small
    // tolerance for the color-difference reconstruction's
    // chroma cross-talk. Before the fix, the bad CFA lookup
    // could let non-green samples through `directional_green`,
    // surfacing here as G values outside the input range.
    let tol = 0.05_f32;
    for y in 2..(h - 2) {
        for x in 2..=3 {
            let p = out.pixels[(y * w + x) as usize];
            assert!(
                p[1].is_finite(),
                "G at ({},{}) is non-finite: {}",
                x,
                y,
                p[1]
            );
            assert!(p[1] >= -tol, "G at ({},{}) is negative: {}", x, y, p[1]);
            assert!(
                p[1] <= 0.8 + tol,
                "G at ({},{}) above input range: {} (max ≈ 0.8 + {})",
                x,
                y,
                p[1],
                tol
            );
        }
    }
}

/// Markesteijn must not produce NaN / inf on zero input.
#[test]
fn markesteijn_no_nan_on_zero_input() {
    let cfa = CfaPattern::XTrans(FUJI_PATTERN);
    let mosaic = Image::new(20, 20, ColorSpace::CameraNativeMosaic);
    let out = markesteijn(&mosaic, cfa);
    for p in &out.pixels {
        assert!(p[0].is_finite() && p[1].is_finite() && p[2].is_finite());
        assert!(p[0].abs() < 1e-3);
        assert!(p[1].abs() < 1e-3);
        assert!(p[2].abs() < 1e-3);
    }
}
