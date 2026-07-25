use super::super::opcodes::WarpPlaneParams;
use super::*;
use crate::image::ColorSpace;

fn flat_image(w: u32, h: u32, value: [f32; 3]) -> Image {
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    img.pixels.fill(value);
    img
}

fn gm(
    points_v: u32,
    points_h: u32,
    map_planes: u32,
    gains: Vec<f32>,
    area: (u32, u32),
) -> GainMapOpcode {
    GainMapOpcode {
        top: 0,
        left: 0,
        bottom: area.1,
        right: area.0,
        plane: 0,
        planes: 3,
        row_pitch: 1,
        col_pitch: 1,
        points_v,
        points_h,
        spacing_v: 1.0 / (points_v - 1).max(1) as f64,
        spacing_h: 1.0 / (points_h - 1).max(1) as f64,
        origin_v: 0.0,
        origin_h: 0.0,
        map_planes,
        gains,
    }
}

/// Hand-computed dng_sdk sampling check: 2×2 lattice over a 4×2
/// image. Pixel (row 0, col 0): v = 0.5/2 = 0.25, h = 0.5/4 = 0.125
/// → bilinear of the four lattice corners at (0.25, 0.125).
#[test]
fn gain_map_bilinear_matches_hand_computed_samples() {
    let aa = ActiveAreaRect::full(4, 2);
    let g = gm(2, 2, 1, vec![1.0, 2.0, 3.0, 4.0], (4, 2));
    let mut img = flat_image(4, 2, [1.0; 3]);
    apply_gain_map(&mut img, &g, aa, 1.0);
    // (0,0): top = 1 + (2-1)*0.125 = 1.125; bot = 3 + (4-3)*0.125 =
    // 3.125; gain = 1.125 + (3.125-1.125)*0.25 = 1.625.
    assert!(
        (img.pixels[0][0] - 1.625).abs() < 1e-6,
        "got {}",
        img.pixels[0][0]
    );
    // (1,3): v = 1.5/2 = 0.75, h = 3.5/4 = 0.875 →
    // top = 1.875, bot = 3.875, gain = 1.875 + 2*0.75 = 3.375.
    assert!(
        (img.pixels[7][0] - 3.375).abs() < 1e-6,
        "got {}",
        img.pixels[7][0]
    );
    // All three channels see the broadcast map_planes = 1 gain.
    assert_eq!(img.pixels[0][0], img.pixels[0][1]);
    assert_eq!(img.pixels[0][0], img.pixels[0][2]);
}

/// Per-plane lattice (map_planes = 3): channel c reads lattice
/// plane c; with a constant per-plane lattice the whole image
/// scales per channel.
#[test]
fn gain_map_per_plane_gains_apply_per_channel() {
    let aa = ActiveAreaRect::full(3, 3);
    let gains: Vec<f32> = std::iter::repeat([1.5f32, 2.0, 2.5])
        .take(4)
        .flatten()
        .collect();
    let g = gm(2, 2, 3, gains, (3, 3));
    let mut img = flat_image(3, 3, [1.0; 3]);
    apply_gain_map(&mut img, &g, aa, 1.0);
    for px in &img.pixels {
        assert!((px[0] - 1.5).abs() < 1e-6);
        assert!((px[1] - 2.0).abs() < 1e-6);
        assert!((px[2] - 2.5).abs() < 1e-6);
    }
}

/// The area rect limits the multiply; pixels right/below it (and
/// outside the active area) stay untouched.
#[test]
fn gain_map_respects_area_rect_and_active_area_offset() {
    // 6-wide buffer, active area = cols [1, 5), rows [0, 3).
    let aa = ActiveAreaRect {
        top: 0,
        left: 1,
        width: 4,
        height: 3,
    };
    let mut g = gm(2, 2, 1, vec![2.0; 4], (4, 3));
    g.right = 2; // area rect: cols [0, 2) of the active area only
    let mut img = flat_image(6, 3, [1.0; 3]);
    apply_gain_map(&mut img, &g, aa, 1.0);
    for row in 0..3usize {
        assert_eq!(img.pixels[row * 6][0], 1.0, "left of active area");
        for col in 1..3 {
            assert_eq!(img.pixels[row * 6 + col][0], 2.0, "inside rect");
        }
        for col in 3..6 {
            assert_eq!(img.pixels[row * 6 + col][0], 1.0, "outside rect");
        }
    }
}

/// Self-inverse: divide a flat field by the per-pixel sampled gain,
/// apply, and recover the flat field (the synthetic-vignette
/// flattening property the #1159 acceptance asks for).
#[test]
fn gain_map_flattens_a_synthetic_vignette() {
    let (w, h) = (24u32, 16u32);
    let aa = ActiveAreaRect::full(w, h);
    // Radial-ish lattice: corners gain 2, center 1.
    let gains = vec![
        2.0, 1.4, 2.0, //
        1.4, 1.0, 1.4, //
        2.0, 1.4, 2.0,
    ];
    let g = gm(3, 3, 1, gains, (w, h));
    // Per-pixel gain field = apply on a ones image.
    let mut field = flat_image(w, h, [1.0; 3]);
    apply_gain_map(&mut field, &g, aa, 1.0);
    // Vignetted scene = flat 0.5 divided by that field.
    let mut vignetted = flat_image(w, h, [0.5; 3]);
    for (v, f) in vignetted.pixels.iter_mut().zip(&field.pixels) {
        for c in 0..3 {
            v[c] /= f[c];
        }
    }
    let corner_before = vignetted.pixels[0][1];
    let center_before = vignetted.pixels[(h as usize / 2) * w as usize + w as usize / 2][1];
    assert!(
        corner_before < center_before * 0.7,
        "synthetic vignette must darken corners ({corner_before} vs {center_before})"
    );
    apply_gain_map(&mut vignetted, &g, aa, 1.0);
    for (i, px) in vignetted.pixels.iter().enumerate() {
        for c in 0..3 {
            assert!(
                (px[c] - 0.5).abs() < 1e-5,
                "pixel {i} channel {c}: {} after flattening",
                px[c]
            );
        }
    }
}

fn identity_warp() -> WarpRectilinearOpcode {
    WarpRectilinearOpcode {
        planes: vec![WarpPlaneParams {
            kr: [1.0, 0.0, 0.0, 0.0],
            kt: [0.0, 0.0],
        }],
        center_x: 0.5,
        center_y: 0.5,
    }
}

/// kr = {1,0,0,0}, kt = 0 maps every output pixel to itself —
/// bit-identical image (bilinear at integer coordinates is exact).
#[test]
fn warp_identity_params_are_a_noop() {
    let (w, h) = (9u32, 7u32);
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, px) in img.pixels.iter_mut().enumerate() {
        *px = [i as f32, i as f32 * 0.5, 100.0 - i as f32];
    }
    let before = img.pixels.clone();
    apply_warp_rectilinear(&mut img, &identity_warp(), ActiveAreaRect::full(w, h), 1.0, 1.0);
    assert_eq!(img.pixels, before);
}

/// Out-of-bounds source positions (kr0 > 1 pushes edge sources past
/// the frame) clamp to the edge: finite output, no black fill.
#[test]
fn warp_clamps_sources_outside_the_active_area() {
    let (w, h) = (16u32, 12u32);
    let mut img = flat_image(w, h, [0.25; 3]);
    let mut warp = identity_warp();
    warp.planes[0].kr = [1.2, 0.0, 0.0, 0.0];
    apply_warp_rectilinear(&mut img, &warp, ActiveAreaRect::full(w, h), 1.0, 1.0);
    for px in &img.pixels {
        for c in 0..3 {
            assert!(px[c].is_finite());
            assert!(
                (px[c] - 0.25).abs() < 1e-6,
                "flat field must stay flat, got {}",
                px[c]
            );
        }
    }
}

/// Distinct per-plane coefficient sets resample channels
/// independently (lateral CA): identity G/B stay put, a scaled R
/// set shifts channel 0 on a gradient.
#[test]
fn warp_per_plane_sets_act_per_channel() {
    let (w, h) = (33u32, 9u32);
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for row in 0..h as usize {
        for col in 0..w as usize {
            let v = col as f32;
            img.pixels[row * w as usize + col] = [v, v, v];
        }
    }
    let warp = WarpRectilinearOpcode {
        planes: vec![
            WarpPlaneParams {
                kr: [0.9, 0.0, 0.0, 0.0],
                kt: [0.0, 0.0],
            },
            WarpPlaneParams {
                kr: [1.0, 0.0, 0.0, 0.0],
                kt: [0.0, 0.0],
            },
            WarpPlaneParams {
                kr: [1.0, 0.0, 0.0, 0.0],
                kt: [0.0, 0.0],
            },
        ],
        center_x: 0.5,
        center_y: 0.5,
    };
    apply_warp_rectilinear(&mut img, &warp, ActiveAreaRect::full(w, h), 1.0, 1.0);
    // Column 4 (center 16.5): R sampled at 16.5 + (4-16.5)*0.9 =
    // 5.25 → 5.25; G/B stay 4.
    let px = img.pixels[4 * w as usize + 4];
    assert!((px[1] - 4.0).abs() < 1e-5, "G identity, got {}", px[1]);
    assert!((px[2] - 4.0).abs() < 1e-5, "B identity, got {}", px[2]);
    assert!(
        (px[0] - 5.25).abs() < 1e-4,
        "R from the 0.9 set, got {}",
        px[0]
    );
}

/// Pixels outside the active area never change.
#[test]
fn warp_leaves_pixels_outside_active_area_untouched() {
    let (w, h) = (20u32, 10u32);
    let aa = ActiveAreaRect {
        top: 0,
        left: 0,
        width: 16,
        height: h,
    };
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, px) in img.pixels.iter_mut().enumerate() {
        *px = [i as f32; 3];
    }
    let before = img.pixels.clone();
    let mut warp = identity_warp();
    warp.planes[0].kr = [0.8, 0.1, 0.0, 0.0];
    apply_warp_rectilinear(&mut img, &warp, aa, 1.0, 1.0);
    let mut changed_inside = false;
    for row in 0..h as usize {
        for col in 0..w as usize {
            let (got, was) = (
                img.pixels[row * w as usize + col],
                before[row * w as usize + col],
            );
            if col >= 16 {
                assert_eq!(got, was, "masked col {col} must pass through");
            } else if got != was {
                changed_inside = true;
            }
        }
    }
    assert!(
        changed_inside,
        "warp must actually resample inside the active area"
    );
}

// ---- The direction check (#1159 validation 3) ----------------------
//
// The warp model maps corrected→uncorrected. Synthesize a "captured"
// image by pushing an ideal straight line through the *numeric
// inverse* of the model (content of the ideal image at d lands at
// W(d) in the captured frame), then run the production
// `apply_warp_rectilinear` and verify the line's bow collapses. An
// implementation that gathers with the model inverted would *double*
// the bow instead — this test is what catches that.

/// |W(p)| for radial-only params: scalar radius map in pixels.
fn forward_radius(set: &WarpPlaneParams, r_px: f64, norm_radius: f64) -> f64 {
    let rr = ((r_px / norm_radius) * (r_px / norm_radius)).min(1.0);
    let [kr0, kr1, kr2, kr3] = set.kr;
    r_px * (kr0 + rr * (kr1 + rr * (kr2 + rr * kr3)))
}

/// Invert the radial map by bisection: find r_ideal with
/// |W(r_ideal)| = r_captured.
fn inverse_radius(set: &WarpPlaneParams, r_captured: f64, norm_radius: f64) -> f64 {
    let (mut lo, mut hi) = (0.0f64, norm_radius * 1.5);
    for _ in 0..60 {
        let mid = 0.5 * (lo + hi);
        if forward_radius(set, mid, norm_radius) < r_captured {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    0.5 * (lo + hi)
}

/// Subpixel center of the dark line on row `row`: darkness centroid.
fn line_center(img: &Image, row: usize) -> f64 {
    let w = img.width as usize;
    let (mut num, mut den) = (0.0f64, 0.0f64);
    for col in 0..w {
        let weight = (1.0 - img.pixels[row * w + col][1]) as f64;
        num += weight * col as f64;
        den += weight;
    }
    num / den
}

#[test]
fn warp_reduces_barrel_line_bow_not_doubles_it() {
    // PANO0001's real plane-0 radial coefficients (barrel: f(1) ≈ 0.92).
    let set = WarpPlaneParams {
        kr: [1.00181, -0.0664397, 0.0382406, -0.0531921],
        kt: [0.0, 0.0],
    };
    let (w, h) = (257u32, 257u32);
    let aa = ActiveAreaRect::full(w, h);
    let (cx, cy) = (0.5 * w as f64, 0.5 * h as f64);
    let norm_radius = f64::hypot(cx, cy);
    let line_x = 215.0f64; // ideal vertical line, well off-center

    // Captured frame: captured(s) = ideal(W⁻¹(s)) — for each pixel,
    // walk back through the inverse radial map and shade by the
    // ideal line profile (2 px ramp for subpixel measurement).
    let mut captured = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for row in 0..h as usize {
        for col in 0..w as usize {
            let (dx, dy) = (col as f64 - cx, row as f64 - cy);
            let r_cap = f64::hypot(dx, dy);
            let scale = if r_cap > 1e-9 {
                inverse_radius(&set, r_cap, norm_radius) / r_cap
            } else {
                1.0
            };
            let ideal_x = cx + dx * scale;
            let v = (((ideal_x - line_x).abs() - 1.0) / 2.0).clamp(0.0, 1.0) as f32;
            captured.pixels[row * w as usize + col] = [v, v, v];
        }
    }

    let bow = |img: &Image| -> f64 {
        let mid = line_center(img, (h / 2) as usize);
        let mut worst = 0.0f64;
        for row in [16usize, 48, 80, 176, 208, 240] {
            worst = worst.max((line_center(img, row) - mid).abs());
        }
        worst
    };
    let bow_captured = bow(&captured);
    assert!(
        bow_captured > 1.5,
        "synthetic barrel must visibly bow the line (got {bow_captured:.3} px)"
    );

    let mut corrected = captured.clone();
    let warp = WarpRectilinearOpcode {
        planes: vec![set],
        center_x: 0.5,
        center_y: 0.5,
    };
    apply_warp_rectilinear(&mut corrected, &warp, aa, 1.0, 1.0);
    let bow_corrected = bow(&corrected);
    assert!(
        bow_corrected < 0.4 && bow_corrected < bow_captured / 4.0,
        "correction must straighten the line, not double the bow: \
             captured {bow_captured:.3} px → corrected {bow_corrected:.3} px"
    );
    // And the line lands back at its ideal position.
    let mid = line_center(&corrected, (h / 2) as usize);
    assert!(
        (mid - line_x).abs() < 0.5,
        "line center {mid:.2} must return to ideal {line_x}"
    );
}

// ---- `scale_active_area` (regression: raw-core panic at
// opcode_apply/mod.rs:189, "index out of bounds: the len is 6144 but the
// index is 6144") ----------------------------------------------------
//
// The unsized develop chain used to pass a raw-sensor-coordinate
// ActiveAreaRect straight to `apply_opcode_list3` even when Preview
// quality's half-res demosaic had already halved the buffer. A DNG
// whose ActiveArea spans the full sensor width (left=0) walks its warp
// loop's `col` up to `raw_width`, so `aa_left + col` reaches exactly
// `raw_width` — one past a half-res buffer whose width is `raw_width /
// 2`. test_0000.DNG (12288×8192, ActiveArea full-width, one
// WarpRectilinear opcode) is the real-world repro; this test reproduces
// the same shape synthetically so it doesn't depend on fixtures.

/// A full-sensor-width ActiveArea scaled by the Preview-quality half-res
/// divisor must land exactly on the half-res buffer's bounds, not one
/// past them.
#[test]
fn scale_active_area_halves_a_full_width_rect_to_fit_the_preview_buffer() {
    let raw_w = 12288u32;
    let raw_h = 8192u32;
    let aa = ActiveAreaRect::full(raw_w, raw_h);
    let (buf_w, buf_h) = (raw_w / 2, raw_h / 2);
    let scaled = scale_active_area(aa, 0.5, buf_w, buf_h);
    assert_eq!(scaled.left, 0);
    assert_eq!(scaled.top, 0);
    assert_eq!(scaled.width, buf_w, "must reach the buffer's right edge exactly");
    assert_eq!(scaled.height, buf_h, "must reach the buffer's bottom edge exactly");
    assert!(
        scaled.left + scaled.width <= buf_w,
        "scaled rect must fit the buffer width"
    );
    assert!(
        scaled.top + scaled.height <= buf_h,
        "scaled rect must fit the buffer height"
    );
}

/// Actually applying a WarpRectilinear opcode with the unscaled rect
/// against a half-res buffer must no longer panic — the direct
/// regression check for opcode_apply/mod.rs:189. Uses the exact
/// dimensions/geometry test_0000.DNG hits (full-width ActiveArea, real
/// buffer width divisible by 2).
#[test]
fn apply_opcode_list3_does_not_panic_when_aa_is_prescaled_for_a_half_res_buffer() {
    let raw_w = 12288u32;
    let raw_h = 8192u32;
    let aa_raw = ActiveAreaRect::full(raw_w, raw_h);
    let (buf_w, buf_h) = (raw_w / 2, raw_h / 2);
    let scaled_aa = scale_active_area(aa_raw, 0.5, buf_w, buf_h);

    let mut img = flat_image(buf_w, buf_h, [0.25; 3]);
    let list = OpcodeList3 {
        opcodes: vec![PanoOpcode::WarpRectilinear(identity_warp())],
        skipped_unknown: 0,
    };
    // Must not panic; a still-unscaled `aa_raw` against this half-res
    // buffer is exactly the crash this test guards against.
    let applied = apply_opcode_list3(&mut img, &list, scaled_aa, LensCorrectionScales::FULL);
    assert_eq!(applied, vec!["WarpRectilinear(1 planes)"]);
}

/// A no-op scale (1.0) is the identity, matching the pano path (always
/// `RenderQuality::Full`, so `aa` never needs rescaling).
#[test]
fn scale_active_area_is_identity_at_scale_one() {
    let aa = ActiveAreaRect {
        top: 3,
        left: 5,
        width: 40,
        height: 20,
    };
    let scaled = scale_active_area(aa, 1.0, 100, 100);
    assert_eq!(scaled, aa);
}

/// Independent per-field rounding can push `left + width` one past a
/// non-power-of-two buffer edge; the clamp must still hold, never
/// panic-inducing overflow.
#[test]
fn scale_active_area_clamps_odd_rounding_to_the_buffer() {
    // raw right edge lands exactly at raw_w; scale is deliberately not a
    // clean divisor so left/width round independently.
    let raw_w = 101u32;
    let aa = ActiveAreaRect {
        top: 0,
        left: 51,
        width: 50,
        height: 1,
    };
    let buf_w = 50u32;
    let scale = buf_w as f32 / raw_w as f32;
    let scaled = scale_active_area(aa, scale, buf_w, 1);
    assert!(
        scaled.left + scaled.width <= buf_w,
        "left {} + width {} must not exceed buffer width {}",
        scaled.left,
        scaled.width,
        buf_w
    );
}

/// List order is preserved and labels surface what ran.
#[test]
fn apply_list3_runs_in_list_order_and_reports_labels() {
    let (w, h) = (8u32, 8u32);
    let aa = ActiveAreaRect::full(w, h);
    let list = OpcodeList3 {
        opcodes: vec![
            PanoOpcode::GainMap(gm(2, 2, 1, vec![2.0; 4], (w, h))),
            PanoOpcode::WarpRectilinear(identity_warp()),
        ],
        skipped_unknown: 0,
    };
    let mut img = flat_image(w, h, [0.25; 3]);
    let applied = apply_opcode_list3(&mut img, &list, aa, LensCorrectionScales::FULL);
    assert_eq!(applied, vec!["GainMap(2x2x1)", "WarpRectilinear(1 planes)"]);
    assert!(
        (img.pixels[0][0] - 0.5).abs() < 1e-6,
        "gain ran before warp"
    );
}

// ---------------------------------------------------------------------
// FixVignetteRadial (#376)
// ---------------------------------------------------------------------

fn vignette(k0: f64) -> FixVignetteRadialOpcode {
    FixVignetteRadialOpcode {
        k: [k0, 0.0, 0.0, 0.0, 0.0],
        center_x: 0.5,
        center_y: 0.5,
    }
}

/// The gain follows `1 + k0·t` with `t` the squared center distance
/// normalized so `t = 1` at the farthest corner — hand-computed against
/// the same `Lerp(0, dim, c)` center and max-corner radius the warp uses,
/// so the two opcodes share one coordinate system.
#[test]
fn fix_vignette_radial_matches_the_hand_computed_gain_curve() {
    let (w, h) = (21u32, 21u32);
    let aa = ActiveAreaRect::full(w, h);
    let mut img = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut img, &vignette(0.5), aa, 1.0);

    // Center convention: cx = 0.5 * 21 = 10.5, cy likewise. Corner radius
    // is hypot(max(10.5, 10.5), max(10.5, 10.5)) = 10.5·√2, so
    // norm_radius² = 220.5.
    let (cx, cy, r2) = (10.5f64, 10.5f64, 220.5f64);
    for (col, row) in [(10usize, 10usize), (0, 0), (20, 10), (5, 17)] {
        let (dx, dy) = (col as f64 - cx, row as f64 - cy);
        let t = ((dx * dx + dy * dy) / r2).min(1.0);
        let expected = (1.0 + 0.5 * t) as f32;
        let got = img.pixels[row * w as usize + col][1];
        assert!(
            (got - expected).abs() < 1e-6,
            "gain at ({col},{row}): expected {expected}, got {got}"
        );
    }
}

/// The multiplied result is deliberately NOT clamped to 1.0 the way
/// dng_sdk clamps its bounded stage buffers: nothing before the view
/// transform may clip (scene-linear invariant, and the same policy
/// `apply_gain_map` already documents).
#[test]
fn fix_vignette_radial_does_not_clip_the_scene_linear_result() {
    let (w, h) = (9u32, 9u32);
    let mut img = flat_image(w, h, [4.0; 3]);
    apply_fix_vignette_radial(&mut img, &vignette(0.75), ActiveAreaRect::full(w, h), 1.0);
    let corner = img.pixels[0][0];
    assert!(
        corner > 4.0,
        "a >1 corner gain must brighten past the input, got {corner}"
    );
    assert!(corner.is_finite());
}

/// Pixels outside the active area are masked sensor columns that
/// DefaultCrop discards — the gain must not touch them.
#[test]
fn fix_vignette_radial_leaves_pixels_outside_active_area_untouched() {
    let (w, h) = (20u32, 8u32);
    let aa = ActiveAreaRect {
        top: 0,
        left: 0,
        width: 14,
        height: h,
    };
    let mut img = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut img, &vignette(0.6), aa, 1.0);
    for row in 0..h as usize {
        for col in 14..w as usize {
            assert_eq!(
                img.pixels[row * w as usize + col],
                [1.0; 3],
                "masked col {col} must pass through"
            );
        }
    }
}

// ---------------------------------------------------------------------
// LensCorrectionScales (#376)
// ---------------------------------------------------------------------

/// Every family scaled to zero leaves the buffer bit-identical, and the
/// list reports nothing as applied.
#[test]
fn zero_scales_skip_every_opcode_bit_identically() {
    let (w, h) = (12u32, 10u32);
    let aa = ActiveAreaRect::full(w, h);
    let list = OpcodeList3 {
        opcodes: vec![
            PanoOpcode::GainMap(gm(2, 2, 1, vec![2.0; 4], (w, h))),
            PanoOpcode::FixVignetteRadial(vignette(0.5)),
            PanoOpcode::WarpRectilinear(WarpRectilinearOpcode {
                planes: vec![WarpPlaneParams {
                    kr: [0.85, 0.1, 0.0, 0.0],
                    kt: [0.0, 0.0],
                }],
                center_x: 0.5,
                center_y: 0.5,
            }),
        ],
        skipped_unknown: 0,
    };
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for (i, px) in img.pixels.iter_mut().enumerate() {
        *px = [i as f32, i as f32 * 0.5, 100.0 - i as f32];
    }
    let before = img.pixels.clone();
    let applied = apply_opcode_list3(&mut img, &list, aa, LensCorrectionScales::NONE);
    assert!(applied.is_empty(), "nothing ran, got {applied:?}");
    assert_eq!(img.pixels, before);
}

/// A half-strength vignetting scale lands exactly halfway between the
/// identity and the vendor's authored gain, for both gain opcodes.
#[test]
fn vignetting_scale_blends_gain_opcodes_toward_identity() {
    let (w, h) = (17u32, 17u32);
    let aa = ActiveAreaRect::full(w, h);

    let mut full = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut full, &vignette(0.8), aa, 1.0);
    let mut half = flat_image(w, h, [1.0; 3]);
    apply_fix_vignette_radial(&mut half, &vignette(0.8), aa, 0.5);
    for (f, hh) in full.pixels.iter().zip(half.pixels.iter()) {
        let expected = 1.0 + 0.5 * (f[1] - 1.0);
        assert!((hh[1] - expected).abs() < 1e-6);
    }

    let map = gm(2, 2, 1, vec![1.0, 2.0, 3.0, 4.0], (w, h));
    let mut full_map = flat_image(w, h, [1.0; 3]);
    apply_gain_map(&mut full_map, &map, aa, 1.0);
    let mut half_map = flat_image(w, h, [1.0; 3]);
    apply_gain_map(&mut half_map, &map, aa, 0.5);
    for (f, hh) in full_map.pixels.iter().zip(half_map.pixels.iter()) {
        let expected = 1.0 + 0.5 * (f[1] - 1.0);
        assert!((hh[1] - expected).abs() < 1e-6);
    }
}

/// Dropping the CA scale to zero while distortion stays at full strength
/// must collapse all three planes onto the green plane's geometry — the
/// definition of "correct distortion, leave lateral CA alone". Verified
/// against a warp built from green's coefficient set alone, which is the
/// independent expression of the same result.
#[test]
fn zero_ca_scale_collapses_every_plane_onto_the_green_warp() {
    let (w, h) = (33u32, 9u32);
    let gradient = || {
        let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
        for row in 0..h as usize {
            for col in 0..w as usize {
                let v = col as f32;
                img.pixels[row * w as usize + col] = [v, v * 2.0, v * 3.0];
            }
        }
        img
    };
    let set = |kr0: f64| WarpPlaneParams {
        kr: [kr0, 0.0, 0.0, 0.0],
        kt: [0.0, 0.0],
    };
    let per_plane = WarpRectilinearOpcode {
        planes: vec![set(0.9), set(1.0), set(1.1)],
        center_x: 0.5,
        center_y: 0.5,
    };
    let green_only = WarpRectilinearOpcode {
        planes: vec![set(1.0)],
        center_x: 0.5,
        center_y: 0.5,
    };
    let aa = ActiveAreaRect::full(w, h);

    let mut no_ca = gradient();
    apply_warp_rectilinear(&mut no_ca, &per_plane, aa, 1.0, 0.0);
    let mut reference = gradient();
    apply_warp_rectilinear(&mut reference, &green_only, aa, 1.0, 1.0);
    assert_eq!(no_ca.pixels, reference.pixels);

    // Sanity: at full CA the three planes really do diverge, so the test
    // above is not passing on a warp that was per-plane in name only.
    let mut with_ca = gradient();
    apply_warp_rectilinear(&mut with_ca, &per_plane, aa, 1.0, 1.0);
    assert_ne!(with_ca.pixels, reference.pixels);
}

/// Dropping the distortion scale to zero while CA stays at full strength
/// keeps only each plane's deviation from green — so the green plane
/// itself becomes an exact no-op while R and B still shift.
#[test]
fn zero_distortion_scale_keeps_only_the_per_plane_ca_deviation() {
    let (w, h) = (33u32, 9u32);
    let mut img = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    for row in 0..h as usize {
        for col in 0..w as usize {
            let v = col as f32;
            img.pixels[row * w as usize + col] = [v, v, v];
        }
    }
    let before = img.pixels.clone();
    let set = |kr0: f64| WarpPlaneParams {
        kr: [kr0, 0.0, 0.0, 0.0],
        kt: [0.0, 0.0],
    };
    let warp = WarpRectilinearOpcode {
        planes: vec![set(0.9), set(1.05), set(1.1)],
        center_x: 0.5,
        center_y: 0.5,
    };
    apply_warp_rectilinear(&mut img, &warp, ActiveAreaRect::full(w, h), 0.0, 1.0);
    // Green's deviation from itself is zero, so its blended set is the
    // identity and the plane resamples in place.
    for (got, was) in img.pixels.iter().zip(before.iter()) {
        assert!(
            (got[1] - was[1]).abs() < 1e-5,
            "green must be untouched, got {} want {}",
            got[1],
            was[1]
        );
    }
    let mid = 4 * w as usize + 6;
    assert!(
        (img.pixels[mid][0] - before[mid][0]).abs() > 1e-3,
        "red still carries its CA deviation"
    );
}

/// The master switch overrides the three scales, and 100 maps to exactly
/// 1.0 so a default model reproduces the vendor's math bit-for-bit.
#[test]
fn scales_from_model_honour_the_master_switch_and_full_strength_default() {
    assert_eq!(
        LensCorrectionScales::from_model(&AdjustmentModel::default()),
        LensCorrectionScales::FULL
    );

    let off = AdjustmentModel {
        lens_profile_enable: LensProfileEnable::Off,
        lens_correction_distortion: 100.0,
        lens_correction_ca: 100.0,
        lens_correction_vignetting: 100.0,
        ..AdjustmentModel::default()
    };
    assert_eq!(
        LensCorrectionScales::from_model(&off),
        LensCorrectionScales::NONE,
        "crs:LensProfileEnable=0 must override the scales"
    );

    // Out-of-range sidecar values clamp instead of amplifying or
    // inverting the vendor's correction.
    let wild = AdjustmentModel {
        lens_correction_distortion: 250.0,
        lens_correction_ca: -40.0,
        lens_correction_vignetting: 50.0,
        ..AdjustmentModel::default()
    };
    let s = LensCorrectionScales::from_model(&wild);
    assert_eq!((s.distortion, s.ca, s.vignetting), (1.0, 0.0, 0.5));
}
