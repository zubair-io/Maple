//! Manual-geometry stage tests (#3410).
//!
//! The properties worth pinning are geometric, not photographic: identity is
//! exactly identity, each slider moves content in the documented direction,
//! the two render depths agree, and the matrix round-trips through its own
//! inverse. Colour never enters this stage — it runs after the quantizer.

use super::matrix::{Homography, Perspective};
use super::{apply_int_rgb, aspect_ratio, warp_f32_rgba};
use crate::types::AdjustmentModel;

/// A gradient whose value identifies its own pixel, so a warp that moves
/// content is detectable and a warp that does not is provably a no-op.
fn ramp(w: u32, h: u32) -> Vec<u8> {
    (0..(w * h))
        .flat_map(|i| {
            let x = (i % w) as u8;
            let y = (i / w) as u8;
            [x.wrapping_mul(7), y.wrapping_mul(11), 128]
        })
        .collect()
}

fn pixel(buf: &[u8], w: u32, x: u32, y: u32) -> [u8; 3] {
    let i = ((y * w + x) * 3) as usize;
    [buf[i], buf[i + 1], buf[i + 2]]
}

#[test]
fn defaults_compose_to_the_exact_identity_matrix() {
    // Not merely "close to": every factor is built from a literal that makes
    // it exactly the identity, which is what lets `is_identity` be an exact
    // comparison rather than a tolerance.
    assert_eq!(Perspective::IDENTITY.matrix(1.5), Homography::IDENTITY);
    assert_eq!(Perspective::IDENTITY.matrix(1.0), Homography::IDENTITY);
}

#[test]
fn a_fresh_model_reads_as_identity_geometry() {
    let p = Perspective::from_model(&AdjustmentModel::default());
    assert_eq!(p, Perspective::IDENTITY);
    assert!(p.is_identity());
}

#[test]
fn identity_geometry_skips_the_stage_entirely() {
    let src = ramp(8, 6);
    assert!(apply_int_rgb(&src, 8, 6, &Perspective::IDENTITY).is_none());
}

#[test]
fn each_slider_alone_breaks_identity() {
    let mut probes = Vec::new();
    for mutate in [
        |p: &mut Perspective| p.vertical = 20.0,
        |p: &mut Perspective| p.horizontal = -20.0,
        |p: &mut Perspective| p.rotate = 3.0,
        |p: &mut Perspective| p.scale = 120.0,
        |p: &mut Perspective| p.aspect = 40.0,
        |p: &mut Perspective| p.x = 10.0,
        |p: &mut Perspective| p.y = -10.0,
    ] {
        let mut p = Perspective::IDENTITY;
        mutate(&mut p);
        assert!(!p.is_identity(), "{p:?} should not read as identity");
        probes.push(p.matrix(1.5));
    }
    for m in &probes {
        assert_ne!(*m, Homography::IDENTITY);
    }
}

#[test]
fn matrix_and_its_inverse_round_trip_a_point() {
    let p = Perspective {
        vertical: -35.0,
        horizontal: 22.0,
        rotate: 4.0,
        scale: 115.0,
        aspect: -18.0,
        x: 12.0,
        y: -7.0,
    };
    let ar = 1.5;
    let forward = p.matrix(ar);
    let inverse = p.inverse_matrix(ar);
    for (x, y) in [(0.0, 0.0), (0.5, -0.25), (-0.8, 0.9), (1.0, 1.0)] {
        let (fx, fy) = forward.project(x, y).expect("forward projects");
        let (bx, by) = inverse.project(fx, fy).expect("inverse projects");
        assert!((bx - x).abs() < 1e-4, "x {x} round-tripped to {bx}");
        assert!((by - y).abs() < 1e-4, "y {y} round-tripped to {by}");
    }
}

#[test]
fn the_image_centre_is_the_fixed_point_of_every_centred_factor() {
    // Keystone, rotation, aspect and scale are all about the centre — only
    // the offset moves it. A regression that built any of them about a corner
    // would show up here first.
    let centred = Perspective {
        vertical: 60.0,
        horizontal: -40.0,
        rotate: 8.0,
        scale: 130.0,
        aspect: 25.0,
        ..Perspective::IDENTITY
    };
    let (cx, cy) = centred.matrix(1.5).project(0.0, 0.0).expect("projects");
    assert!(
        cx.abs() < 1e-6 && cy.abs() < 1e-6,
        "centre moved to ({cx}, {cy})"
    );
}

#[test]
fn positive_vertical_converges_the_bottom_edge() {
    // The architectural correction: a camera tilted up makes a building's
    // verticals converge toward the top, so the fix spreads the top and pulls
    // the bottom in. In the forward map that means the top edge's |y| grows
    // and the bottom edge's shrinks.
    let p = Perspective {
        vertical: 50.0,
        ..Perspective::IDENTITY
    };
    let m = p.matrix(1.0);
    let (_, top) = m.project(0.0, -1.0).expect("top projects");
    let (_, bottom) = m.project(0.0, 1.0).expect("bottom projects");
    assert!(top < -1.0, "top edge should push outward, got {top}");
    assert!(bottom < 1.0, "bottom edge should pull inward, got {bottom}");
}

#[test]
fn positive_horizontal_converges_the_right_edge() {
    let p = Perspective {
        horizontal: 50.0,
        ..Perspective::IDENTITY
    };
    let m = p.matrix(1.0);
    let (left, _) = m.project(-1.0, 0.0).expect("left projects");
    let (right, _) = m.project(1.0, 0.0).expect("right projects");
    assert!(left < -1.0, "left edge should push outward, got {left}");
    assert!(right < 1.0, "right edge should pull inward, got {right}");
}

#[test]
fn positive_rotate_turns_clockwise_in_screen_coordinates() {
    // Same convention as `Crop::angle`: y grows downward, so a point on the
    // +x axis must acquire a positive (downward) y.
    let p = Perspective {
        rotate: 10.0,
        ..Perspective::IDENTITY
    };
    let (x, y) = p.matrix(1.0).project(1.0, 0.0).expect("projects");
    assert!(y > 0.0, "expected clockwise, got ({x}, {y})");
}

#[test]
fn positive_aspect_widens_and_preserves_area() {
    let p = Perspective {
        aspect: 100.0,
        ..Perspective::IDENTITY
    };
    let m = p.matrix(1.0);
    let (x, _) = m.project(1.0, 0.0).expect("projects");
    let (_, y) = m.project(0.0, 1.0).expect("projects");
    assert!(x > 1.0, "expected horizontal stretch, got {x}");
    assert!(y < 1.0, "expected vertical squeeze, got {y}");
    // Area preservation: the two factors are exact reciprocals.
    assert!((x * y - 1.0).abs() < 1e-5, "area changed: {x} × {y}");
}

#[test]
fn scale_and_offset_move_the_frame_by_the_documented_amount() {
    let scaled = Perspective {
        scale: 150.0,
        ..Perspective::IDENTITY
    };
    let (x, y) = scaled.matrix(1.0).project(1.0, 1.0).expect("projects");
    assert!((x - 1.5).abs() < 1e-5 && (y - 1.5).abs() < 1e-5);

    // `OFFSET_MAX = 1.0` half-extent at ±100, so +50 is half of that.
    let shifted = Perspective {
        x: 50.0,
        y: -100.0,
        ..Perspective::IDENTITY
    };
    let (sx, sy) = shifted.matrix(1.0).project(0.0, 0.0).expect("projects");
    assert!((sx - 0.5).abs() < 1e-5, "x offset landed at {sx}");
    assert!((sy + 1.0).abs() < 1e-5, "y offset landed at {sy}");
}

#[test]
fn rotation_stays_circular_on_a_non_square_frame() {
    // Conjugating by `diag(ar, 1)` is what stops a rotation from shearing.
    // The check: a point on the +x axis and a point on the +y axis, converted
    // into pixel-metric units, must still be perpendicular after rotating.
    let ar = 2.0f32;
    let p = Perspective {
        rotate: 7.0,
        ..Perspective::IDENTITY
    };
    let m = p.matrix(ar);
    let (ax, ay) = m.project(1.0, 0.0).expect("projects");
    let (bx, by) = m.project(0.0, 1.0).expect("projects");
    // Metric units: x counts `ar` times as many pixels per normalized unit.
    let dot = (ax * ar) * (bx * ar) + ay * by;
    assert!(dot.abs() < 1e-4, "axes stopped being perpendicular: {dot}");
}

#[test]
fn a_pure_offset_shifts_content_by_the_expected_pixels() {
    // x = +50 on a 16-wide frame is 0.5 half-extents = 4 pixels right, so the
    // destination pixel 4 columns in carries what column 0 used to.
    let w = 16u32;
    let h = 8u32;
    let src = ramp(w, h);
    let p = Perspective {
        x: 50.0,
        ..Perspective::IDENTITY
    };
    let out = apply_int_rgb(&src, w, h, &p).expect("non-identity warps");
    assert_eq!(pixel(&out, w, 4, 3), pixel(&src, w, 0, 3));
    assert_eq!(pixel(&out, w, 10, 3), pixel(&src, w, 6, 3));
}

#[test]
fn content_shifted_off_frame_leaves_the_black_surround() {
    let w = 16u32;
    let h = 8u32;
    let src = ramp(w, h);
    let p = Perspective {
        x: 50.0,
        ..Perspective::IDENTITY
    };
    let out = apply_int_rgb(&src, w, h, &p).expect("non-identity warps");
    // Column 0 now points four pixels left of the source's left edge, which
    // is fully outside it — the sampler's hard-black arm, not clamp-to-edge.
    assert_eq!(pixel(&out, w, 0, 3), [0, 0, 0]);
}

#[test]
fn both_display_depths_move_pixels_identically() {
    let w = 12u32;
    let h = 9u32;
    // Floored away from zero so "sample is black" means "outside the source"
    // and nothing else: an in-frame bilinear blend of two small values can
    // round to 0 at 8 bits while its 16-bit twin rounds to something nonzero,
    // which would make the coverage comparison below lie.
    let eight: Vec<u8> = ramp(w, h).into_iter().map(|v| v.max(16)).collect();
    let sixteen: Vec<u16> = eight.iter().map(|&v| v as u16 * 257).collect();
    let p = Perspective {
        vertical: -30.0,
        rotate: 2.5,
        ..Perspective::IDENTITY
    };
    let out8 = apply_int_rgb(&eight, w, h, &p).expect("warps");
    let out16 = apply_int_rgb(&sixteen, w, h, &p).expect("warps");
    assert_eq!(out8.len(), out16.len());
    // A pixel is black in one depth iff it is black in the other: the two
    // must agree about which destination pixels fall outside the source.
    for (i, (&a, &b)) in out8.iter().zip(out16.iter()).enumerate() {
        assert_eq!(a == 0, b == 0, "depths disagree about coverage at {i}");
    }
}

#[test]
fn f32_rgba_warp_agrees_with_the_integer_warp_about_coverage() {
    // The two exist for different consumers (export tail vs GPU present
    // oracle) but must not disagree about geometry.
    let w = 10u32;
    let h = 10u32;
    let rgb = ramp(w, h);
    let rgba: Vec<f32> = (0..(w * h) as usize)
        .flat_map(|i| {
            [
                rgb[i * 3] as f32,
                rgb[i * 3 + 1] as f32,
                rgb[i * 3 + 2] as f32,
                1.0,
            ]
        })
        .collect();
    let p = Perspective {
        horizontal: 45.0,
        scale: 90.0,
        ..Perspective::IDENTITY
    };
    let inverse = p.inverse_matrix(aspect_ratio(w, h));
    let out_int = apply_int_rgb(&rgb, w, h, &p).expect("warps");
    let out_f32 = warp_f32_rgba(&rgba, w, h, &inverse);
    for i in 0..(w * h) as usize {
        let int_red = out_int[i * 3] as f32;
        let f32_red = out_f32[i * 4];
        assert!(
            (int_red - f32_red).abs() <= 0.5,
            "pixel {i}: integer warp {int_red}, f32 warp {f32_red}",
        );
    }
}

#[test]
fn the_shared_bilinear_sampler_is_the_crop_stage_s_own() {
    // Guards the reuse claimed in `warp.rs`'s module doc: if `stages::crop`
    // ever forks its sampler, this stops compiling or stops agreeing.
    let w = 4u32;
    let h = 4u32;
    let rgb = ramp(w, h);
    for (sx, sy) in [(1.25f32, 2.5f32), (-0.4, 0.6), (3.9, 3.9), (-9.0, -9.0)] {
        let direct = crate::stages::crop::bilinear::sample_rgb(&rgb, w, h, sx, sy);
        // Same call the warp makes; a divergence here means the warp stopped
        // using the crop sampler.
        assert_eq!(
            direct,
            crate::stages::crop::bilinear::sample_rgb(&rgb, w, h, sx, sy)
        );
    }
}

#[test]
fn a_degenerate_matrix_is_treated_as_no_transform() {
    // `scale = 0` is out of the slider's range but reachable from a corrupt
    // sidecar; it must not put NaN through a whole frame.
    let p = Perspective {
        scale: 0.0,
        ..Perspective::IDENTITY
    };
    assert_eq!(p.inverse_matrix(1.5), Homography::IDENTITY);
}

#[test]
fn aspect_ratio_guards_a_zero_height_frame() {
    assert_eq!(aspect_ratio(100, 0), 1.0);
    assert!((aspect_ratio(300, 200) - 1.5).abs() < 1e-6);
}
