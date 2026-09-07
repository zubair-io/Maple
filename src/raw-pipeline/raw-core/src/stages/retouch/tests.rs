//! Unit gates for the repair stage. Every test builds its own synthetic
//! scene-linear buffer — no fixtures, so these run in CI without the
//! gitignored RAWs.

use super::*;
use crate::types::local_adjustment::Point2;
use crate::types::retouch::{RetouchKind, RetouchSpot};

fn img(w: u32, h: u32, fill: [f32; 3]) -> Image {
    let mut i = Image::new(w, h, ColorSpace::SceneLinearRec2020);
    i.pixels.fill(fill);
    i
}

fn at(img: &Image, x: u32, y: u32) -> [f32; 3] {
    img.pixels[(y * img.width + x) as usize]
}

/// A spot with a hard edge and full strength — the exact-copy configuration
/// the clone assertions need.
fn hard_spot(kind: RetouchKind, center: Point2, source: Point2, radius: f32) -> RetouchSpot {
    RetouchSpot {
        kind,
        center,
        source,
        radius,
        feather: 0.0,
        opacity: 1.0,
    }
}

#[test]
fn empty_spot_list_is_bit_identical() {
    let mut scene = img(64, 48, [0.2, 0.3, 0.4]);
    // A recognisable gradient so a stray write anywhere would show up.
    for (i, p) in scene.pixels.iter_mut().enumerate() {
        p[0] = i as f32 * 1e-4;
    }
    let before = scene.pixels.clone();
    apply(&mut scene, &[]).expect("empty list never fails");
    assert_eq!(scene.pixels, before);
}

#[test]
fn ineffective_spots_leave_the_buffer_untouched() {
    let mut scene = img(64, 48, [0.2, 0.3, 0.4]);
    let before = scene.pixels.clone();
    let spots = [
        // Zero radius.
        hard_spot(
            RetouchKind::Clone,
            Point2::new(0.5, 0.5),
            Point2::new(0.7, 0.5),
            0.0,
        ),
        // Source on the destination.
        hard_spot(
            RetouchKind::Clone,
            Point2::new(0.5, 0.5),
            Point2::new(0.5, 0.5),
            0.1,
        ),
        // Radius below half a pixel.
        hard_spot(
            RetouchKind::Clone,
            Point2::new(0.5, 0.5),
            Point2::new(0.7, 0.5),
            0.001,
        ),
    ];
    apply(&mut scene, &spots).unwrap();
    assert_eq!(scene.pixels, before);
    assert!(!has_effective_spots(&spots, (64, 48)));
}

#[test]
fn clone_copies_exact_source_pixels_inside_the_radius() {
    // Left half dark, right half bright: cloning right onto left must leave
    // the disc holding the bright value exactly.
    let mut scene = img(101, 101, [0.1, 0.1, 0.1]);
    for y in 0..101 {
        for x in 50..101 {
            scene.pixels[(y * 101 + x) as usize] = [0.8, 0.6, 0.4];
        }
    }
    // Centre at x = 25, source at x = 75; radius 0.05 * 101 ≈ 5 px.
    let spot = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.25, 0.5),
        Point2::new(0.75, 0.5),
        0.05,
    );
    apply(&mut scene, &[spot]).unwrap();

    // Dead centre and a pixel well inside the disc are the source value bit
    // for bit; a pixel outside is untouched.
    assert_eq!(at(&scene, 25, 50), [0.8, 0.6, 0.4]);
    assert_eq!(at(&scene, 27, 50), [0.8, 0.6, 0.4]);
    assert_eq!(at(&scene, 25, 48), [0.8, 0.6, 0.4]);
    assert_eq!(at(&scene, 40, 50), [0.1, 0.1, 0.1]);
    // The source region itself is never written.
    assert_eq!(at(&scene, 75, 50), [0.8, 0.6, 0.4]);
}

#[test]
fn opacity_scales_the_composite_linearly() {
    let mut scene = img(101, 101, [0.0, 0.0, 0.0]);
    for y in 0..101 {
        for x in 50..101 {
            scene.pixels[(y * 101 + x) as usize] = [1.0, 1.0, 1.0];
        }
    }
    let spot = RetouchSpot {
        opacity: 0.25,
        ..hard_spot(
            RetouchKind::Clone,
            Point2::new(0.25, 0.5),
            Point2::new(0.75, 0.5),
            0.05,
        )
    };
    apply(&mut scene, &[spot]).unwrap();
    let centre = at(&scene, 25, 50);
    assert!(
        (centre[0] - 0.25).abs() < 1e-6,
        "0.25 opacity over black from white must land at 0.25, got {centre:?}"
    );
}

#[test]
fn heal_preserves_the_destination_low_frequency_mean() {
    // Destination: flat mid grey. Source: a brighter flat field carrying a
    // zero-mean checker texture. Heal must import the texture and keep the
    // destination's own brightness.
    let dest_level = 0.20_f32;
    let source_level = 0.75_f32;
    let mut scene = img(161, 161, [dest_level, dest_level, dest_level]);
    for y in 0..161u32 {
        for x in 80..161u32 {
            let ripple = if (x / 2 + y / 2) % 2 == 0 {
                0.05
            } else {
                -0.05
            };
            let v = source_level + ripple;
            scene.pixels[(y * 161 + x) as usize] = [v, v, v];
        }
    }
    let spot = hard_spot(
        RetouchKind::Heal,
        Point2::new(0.25, 0.5),
        Point2::new(0.75, 0.5),
        0.06,
    );
    apply(&mut scene, &[spot]).unwrap();

    // Mean over the core of the healed disc.
    let cx = (0.25_f32 * 160.0).round() as i32;
    let cy = (0.5_f32 * 160.0).round() as i32;
    let r = (0.06_f32 * 161.0) as i32;
    let (mut sum, mut n) = (0.0_f64, 0u32);
    let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
    for dy in -(r / 2)..=(r / 2) {
        for dx in -(r / 2)..=(r / 2) {
            if dx * dx + dy * dy > (r / 2) * (r / 2) {
                continue;
            }
            let v = at(&scene, (cx + dx) as u32, (cy + dy) as u32)[0];
            sum += v as f64;
            lo = lo.min(v);
            hi = hi.max(v);
            n += 1;
        }
    }
    let mean = (sum / n as f64) as f32;
    assert!(
        (mean - dest_level).abs() < 0.02,
        "heal must keep the destination's low-frequency level {dest_level}, got {mean}"
    );
    // …and it must actually have imported detail, not just left flat grey.
    // The source ripple is ±0.05, so the healed disc must span most of that.
    assert!(
        hi - lo > 0.05,
        "heal must carry the source's high frequencies; healed range was {}",
        hi - lo
    );
}

#[test]
fn heal_never_produces_negative_scene_values() {
    // A near-black destination under a source with violent detail is the
    // case where the signed detail term could drive the result below zero.
    let mut scene = img(121, 121, [1e-5, 1e-5, 1e-5]);
    for y in 0..121u32 {
        for x in 60..121u32 {
            let v = if (x + y) % 2 == 0 { 4.0 } else { 0.0 };
            scene.pixels[(y * 121 + x) as usize] = [v, v, v];
        }
    }
    let spot = hard_spot(
        RetouchKind::Heal,
        Point2::new(0.25, 0.5),
        Point2::new(0.75, 0.5),
        0.08,
    );
    apply(&mut scene, &[spot]).unwrap();
    assert!(
        scene.pixels.iter().all(|p| p.iter().all(|c| *c >= 0.0)),
        "heal must not push scene-linear values below zero"
    );
}

#[test]
fn feather_coverage_is_monotone_from_centre_to_rim() {
    // Black destination, white source, fully feathered: the composited value
    // along a radius is the coverage profile, which must never rise.
    let mut scene = img(201, 201, [0.0, 0.0, 0.0]);
    for y in 0..201u32 {
        for x in 100..201u32 {
            scene.pixels[(y * 201 + x) as usize] = [1.0, 1.0, 1.0];
        }
    }
    let spot = RetouchSpot {
        feather: 1.0,
        ..hard_spot(
            RetouchKind::Clone,
            Point2::new(0.25, 0.5),
            Point2::new(0.75, 0.5),
            0.1,
        )
    };
    apply(&mut scene, &[spot]).unwrap();

    let cx = (0.25_f32 * 200.0).round() as u32;
    let cy = (0.5_f32 * 200.0).round() as u32;
    let radius_px = (0.1_f32 * 201.0).ceil() as u32;
    let mut previous = f32::INFINITY;
    for d in 0..=radius_px + 2 {
        let v = at(&scene, cx + d, cy)[0];
        assert!(
            v <= previous + 1e-6,
            "coverage rose at distance {d}: {v} > {previous}"
        );
        previous = v;
    }
    assert!(
        at(&scene, cx, cy)[0] > 0.99,
        "the core must be fully covered"
    );
    assert_eq!(
        at(&scene, cx + radius_px + 2, cy)[0],
        0.0,
        "beyond the radius nothing is written"
    );
}

#[test]
fn spots_at_the_frame_edge_are_clamped_not_dropped() {
    // Destination hard against the top-left corner: three quarters of the
    // disc is off-frame. The in-frame quarter must still be repaired, and no
    // index may go out of bounds.
    let mut scene = img(81, 81, [0.1, 0.1, 0.1]);
    for y in 0..81u32 {
        for x in 40..81u32 {
            scene.pixels[(y * 81 + x) as usize] = [0.9, 0.9, 0.9];
        }
    }
    let spot = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.0, 0.0),
        Point2::new(0.75, 0.75),
        0.1,
    );
    apply(&mut scene, &[spot]).unwrap();
    assert_eq!(at(&scene, 0, 0), [0.9, 0.9, 0.9]);
}

#[test]
fn a_spot_entirely_outside_the_frame_is_a_no_op() {
    let mut scene = img(41, 41, [0.3, 0.3, 0.3]);
    let before = scene.pixels.clone();
    let spot = hard_spot(
        RetouchKind::Clone,
        Point2::new(9.0, 9.0),
        Point2::new(0.5, 0.5),
        0.05,
    );
    apply(&mut scene, &[spot]).unwrap();
    assert_eq!(scene.pixels, before);
}

#[test]
fn spots_apply_in_list_order() {
    // Two clones onto the same destination: the second must win.
    let mut scene = img(101, 101, [0.0, 0.0, 0.0]);
    for y in 0..101u32 {
        scene.pixels[(y * 101 + 60) as usize] = [0.4, 0.4, 0.4];
        scene.pixels[(y * 101 + 80) as usize] = [0.9, 0.9, 0.9];
    }
    for y in 0..101u32 {
        for x in 55..70u32 {
            scene.pixels[(y * 101 + x) as usize] = [0.4, 0.4, 0.4];
        }
        for x in 75..90u32 {
            scene.pixels[(y * 101 + x) as usize] = [0.9, 0.9, 0.9];
        }
    }
    let first = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.2, 0.5),
        Point2::new(0.62, 0.5),
        0.03,
    );
    let second = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.2, 0.5),
        Point2::new(0.82, 0.5),
        0.03,
    );
    apply(&mut scene, &[first, second]).unwrap();
    assert_eq!(at(&scene, 20, 50), [0.9, 0.9, 0.9]);
}

#[test]
fn a_window_holding_the_whole_footprint_matches_the_full_frame_render() {
    let build = || {
        let mut s = img(129, 129, [0.15, 0.25, 0.35]);
        for y in 0..129u32 {
            for x in 64..129u32 {
                let v = 0.6 + ((x + y) % 3) as f32 * 0.02;
                s.pixels[(y * 129 + x) as usize] = [v, v * 0.9, v * 0.8];
            }
        }
        s
    };
    let spot = hard_spot(
        RetouchKind::Heal,
        Point2::new(0.25, 0.5),
        Point2::new(0.75, 0.5),
        0.05,
    );
    let mut full = build();
    apply(&mut full, &[spot]).unwrap();

    // The same buffer addressed as a window at the origin is the identity
    // case: same origin, same extent, so the result must be identical.
    let mut windowed = build();
    apply_windowed(&mut windowed, &[spot], (0, 0), (129, 129)).unwrap();
    assert_eq!(full.pixels, windowed.pixels);
}

#[test]
fn a_window_that_misses_every_spot_renders_without_error() {
    // Buffer covering frame rows 0..16 only; the spot lives at mid-frame.
    let mut tile = img(512, 16, [0.2, 0.2, 0.2]);
    let before = tile.pixels.clone();
    let spot = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.25, 0.5),
        Point2::new(0.75, 0.5),
        0.05,
    );
    apply_windowed(&mut tile, &[spot], (0, 0), (512, 512)).unwrap();
    assert_eq!(tile.pixels, before, "an untouched tile renders unchanged");
}

#[test]
fn a_window_that_clips_a_spot_is_refused_loudly() {
    // The destination disc straddles the bottom edge of this window.
    let mut tile = img(512, 260, [0.2, 0.2, 0.2]);
    let spot = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.5, 0.5),
        Point2::new(0.75, 0.5),
        0.05,
    );
    let err = apply_windowed(&mut tile, &[spot], (0, 0), (512, 512))
        .expect_err("a clipped spot must refuse the window");
    let msg = err.to_string();
    assert!(
        msg.contains("retouch spot 0") && msg.contains("#3409"),
        "the refusal must name the spot and the ticket, got: {msg}"
    );
}

#[test]
fn a_window_missing_only_the_source_is_refused() {
    // Destination fully inside the window, source far outside it.
    let mut tile = img(200, 512, [0.2, 0.2, 0.2]);
    let spot = hard_spot(
        RetouchKind::Clone,
        Point2::new(0.1, 0.5),
        Point2::new(0.9, 0.5),
        0.02,
    );
    let err = apply_windowed(&mut tile, &[spot], (0, 0), (512, 512))
        .expect_err("an out-of-window source must refuse the window");
    assert!(err.to_string().contains("source"));
}
