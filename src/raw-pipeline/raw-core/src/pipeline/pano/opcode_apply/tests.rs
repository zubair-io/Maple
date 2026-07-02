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
    apply_gain_map(&mut img, &g, aa);
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
    apply_gain_map(&mut img, &g, aa);
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
    apply_gain_map(&mut img, &g, aa);
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
    apply_gain_map(&mut field, &g, aa);
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
    apply_gain_map(&mut vignetted, &g, aa);
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
    apply_warp_rectilinear(&mut img, &identity_warp(), ActiveAreaRect::full(w, h));
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
    apply_warp_rectilinear(&mut img, &warp, ActiveAreaRect::full(w, h));
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
    apply_warp_rectilinear(&mut img, &warp, ActiveAreaRect::full(w, h));
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
    apply_warp_rectilinear(&mut img, &warp, aa);
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
    apply_warp_rectilinear(&mut corrected, &warp, aa);
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
    let applied = apply_opcode_list3(&mut img, &list, aa);
    assert_eq!(applied, vec!["GainMap(2x2x1)", "WarpRectilinear(1 planes)"]);
    assert!(
        (img.pixels[0][0] - 0.5).abs() < 1e-6,
        "gain ran before warp"
    );
}
