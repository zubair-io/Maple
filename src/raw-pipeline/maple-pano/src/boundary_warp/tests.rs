//! Synthetic gates for the boundary warp (#5571). Footprints are analytic
//! shapes in output pixels, rasterised onto a proxy grid for the solve and
//! re-evaluated on a grid four times finer to check full-resolution
//! coverage.

use super::*;
use crate::prng::SplitMix64;

const W: u32 = 400;
const H: u32 = 200;
const FINE: u32 = 4;

type Shape = fn(f64, f64) -> bool;

fn footprint(shape: Shape) -> Footprint {
    Footprint::from_fn(W, H, false, |x, y| shape(x as f64 + 0.5, y as f64 + 0.5))
}

fn solved(shape: Shape, t: f64) -> BoundaryWarpOutcome {
    solve(&footprint(shape), t)
}

/// A cylindrical sweep's bow-tie: top and bottom edges curve in toward the
/// ends, which are cut slightly short.
fn curved_sweep(x: f64, y: f64) -> bool {
    let s = (2.0 * x / W as f64 - 1.0).powi(2);
    x > 6.0 && x < W as f64 - 6.0 && y > 8.0 + 26.0 * s && y < H as f64 - 8.0 - 26.0 * s
}

/// A frame rectangle levelled by 3°: the canvas bounds it, so the four
/// corner triangles are uncovered.
fn levelled_tilt(x: f64, y: f64) -> bool {
    let (c, s) = (3f64.to_radians().cos(), 3f64.to_radians().sin());
    let (dx, dy) = (x - W as f64 / 2.0, y - H as f64 / 2.0);
    let (rx, ry) = (c * dx + s * dy, -s * dx + c * dy);
    rx.abs() < 184.0 && ry.abs() < 89.0
}

/// A tile-strategy strip: four overlapping frames with drift and roll.
fn tile_scatter(x: f64, y: f64) -> bool {
    [
        (60.0, 96.0, 2.0),
        (150.0, 108.0, -1.5),
        (245.0, 94.0, 1.0),
        (335.0, 104.0, -2.0),
    ]
    .iter()
    .any(|&(cx, cy, deg): &(f64, f64, f64)| {
        let (c, s) = (deg.to_radians().cos(), deg.to_radians().sin());
        let (dx, dy) = (x - cx, y - cy);
        (c * dx + s * dy).abs() < 58.0 && (-s * dx + c * dy).abs() < 82.0
    })
}

fn sweep_with_hole(x: f64, y: f64) -> bool {
    curved_sweep(x, y) && (x - 200.0).hypot(y - 100.0) > 18.0
}

fn two_islands(x: f64, y: f64) -> bool {
    (x > 20.0 && x < 180.0 || x > 220.0 && x < 380.0) && y > 20.0 && y < 180.0
}

fn speck(x: f64, y: f64) -> bool {
    (x - 200.0).abs() < 3.0 && (y - 100.0).abs() < 3.0
}

/// Two strips meeting at a right angle: a rest mesh pinned to this edge
/// folds at the inner corner.
fn l_shape(x: f64, y: f64) -> bool {
    x > 10.0 && y > 10.0 && y < 190.0 && (y < 90.0 || x < 160.0) && x < 390.0
}

fn full_rect(x: f64, y: f64) -> bool {
    x >= 0.0 && y >= 0.0
}

/// Each supported shape with its ceiling on the largest local area
/// magnification at full strength, about 5 % above the measured value
/// (3.13, 1.29, 4.32). One-way ratchet.
const SUPPORTED: [(&str, Shape, f64); 3] = [
    ("curved sweep", curved_sweep, 3.3),
    ("levelled tilt", levelled_tilt, 1.35),
    ("tile scatter", tile_scatter, 4.55),
];

/// Fraction of pixels of the `FINE`× output grid whose unwarped position
/// lies in `shape`.
fn full_res_coverage(map: &BoundaryWarp, shape: Shape) -> f64 {
    let (fw, fh) = (W * FINE, H * FINE);
    let warp = map.on_canvas(fw, fh);
    let covered = (0..fh)
        .flat_map(|y| (0..fw).map(move |x| (x as f64 + 0.5, y as f64 + 0.5)))
        .filter(|&(px, py)| {
            let (ux, uy) = warp.unwarp(px, py);
            shape(ux / FINE as f64, uy / FINE as f64)
        })
        .count();
    covered as f64 / (fw as usize * fh as usize) as f64
}

#[test]
fn strength_zero_builds_no_map() {
    let outcome = solved(curved_sweep, 0.0);
    assert!(outcome.map.is_none());
    assert_eq!(outcome.report.status, BoundaryWarpStatus::Off);
    assert_eq!(outcome.report.applied, 0.0);
}

#[test]
fn supported_footprints_fill_the_rectangle_at_full_strength() {
    for (name, shape, _) in SUPPORTED {
        let outcome = solved(shape, 1.0);
        let map = outcome
            .map
            .unwrap_or_else(|| panic!("{name}: {:?}", outcome.report.status));
        assert_eq!(outcome.report.status, BoundaryWarpStatus::Applied, "{name}");
        assert!(
            full_res_coverage(&map, shape) == 1.0,
            "{name}: {}",
            full_res_coverage(&map, shape)
        );
        assert!(outcome.report.predicted_coverage == 1.0, "{name}");
    }
}

#[test]
fn no_cell_folds_and_stretch_stays_bounded() {
    for (name, shape, stretch_ceiling) in SUPPORTED {
        let report = solved(shape, 1.0).report;
        assert!(
            report.min_jacobian >= MIN_JACOBIAN_RATIO,
            "{name}: {}",
            report.min_jacobian
        );
        assert!(
            report.max_stretch <= stretch_ceiling,
            "{name}: {}",
            report.max_stretch
        );
    }
}

#[test]
fn intermediate_strengths_blend_linearly_and_coverage_grows() {
    let full = solved(curved_sweep, 1.0).map.expect("applied");
    let full = full.on_canvas(W, H);
    let mut rng = SplitMix64::new(7);
    let mut last_coverage = solved(curved_sweep, 0.0).report.predicted_coverage;
    for t in [0.25, 0.5, 0.75] {
        let outcome = solved(curved_sweep, t);
        assert_eq!(outcome.report.applied, t);
        let map = outcome.map.expect("applied");
        let warp = map.on_canvas(W, H);
        for _ in 0..500 {
            let (px, py) = (rng.next_range(0.0, W as f64), rng.next_range(0.0, H as f64));
            let (ux, uy) = warp.unwarp(px, py);
            let (fx, fy) = full.unwarp(px, py);
            assert!((ux - ((1.0 - t) * px + t * fx)).abs() < 1e-9);
            assert!((uy - ((1.0 - t) * py + t * fy)).abs() < 1e-9);
        }
        assert!(outcome.report.predicted_coverage > last_coverage, "t = {t}");
        last_coverage = outcome.report.predicted_coverage;
    }
}

#[test]
fn holes_stay_holes() {
    let outcome = solved(sweep_with_hole, 1.0);
    let map = outcome.map.expect("a footprint with a hole is supported");
    let hole_fraction = std::f64::consts::PI * 18.0 * 18.0 / (W * H) as f64;
    let uncovered = 1.0 - full_res_coverage(&map, sweep_with_hole);
    assert!(
        uncovered > 0.5 * hole_fraction && uncovered < 2.0 * hole_fraction,
        "{uncovered} vs a hole of {hole_fraction}"
    );
}

#[test]
fn a_folding_rest_mesh_is_clamped_short_of_the_fold() {
    let outcome = solved(l_shape, 1.0);
    let report = outcome.report;
    assert_eq!(report.status, BoundaryWarpStatus::ClampedFold);
    assert!(
        report.applied > MIN_APPLIED && report.applied < 1.0,
        "{}",
        report.applied
    );
    assert!(
        report.min_jacobian >= MIN_JACOBIAN_RATIO - 1e-9,
        "{}",
        report.min_jacobian
    );
    let map = outcome.map.expect("a clamped warp still applies");
    let unwarped = solved(l_shape, 0.0).report.predicted_coverage;
    assert!(full_res_coverage(&map, l_shape) > unwarped);
}

#[test]
fn unsupported_footprints_are_refused() {
    let refused = |fp: &Footprint| solve(fp, 1.0).report.status;
    assert_eq!(
        refused(&footprint(two_islands)),
        BoundaryWarpStatus::RefusedDisconnected
    );
    assert_eq!(refused(&footprint(speck)), BoundaryWarpStatus::RefusedEmpty);
    assert_eq!(
        refused(&Footprint::new(0, H, Vec::new(), false)),
        BoundaryWarpStatus::RefusedEmpty
    );
    let ring = Footprint::from_fn(W, H, true, |x, y| {
        curved_sweep(x as f64 + 0.5, y as f64 + 0.5)
    });
    let outcome = solve(&ring, 1.0);
    assert_eq!(outcome.report.status, BoundaryWarpStatus::RefusedFullWrap);
    assert!(outcome.map.is_none() && outcome.report.status.is_refused());
}

#[test]
fn a_full_rectangle_barely_moves() {
    let map = solved(full_rect, 1.0).map.expect("applied");
    let warp = map.on_canvas(W, H);
    for (px, py) in [(0.5, 0.5), (200.0, 100.0), (399.5, 199.5), (10.0, 190.0)] {
        let (ux, uy) = warp.unwarp(px, py);
        assert!(
            (ux - px).abs() < 2.5 && (uy - py).abs() < 2.5,
            "({px}, {py}) → ({ux}, {uy})"
        );
    }
}

#[test]
fn solving_is_deterministic() {
    assert_eq!(solved(tile_scatter, 0.8).map, solved(tile_scatter, 0.8).map);
}

#[test]
fn unwarped_bounds_hold_every_unwarped_point() {
    let map = solved(levelled_tilt, 1.0).map.expect("applied");
    let warp = map.on_canvas(W * FINE, H * FINE);
    let mut rng = SplitMix64::new(11);
    for _ in 0..50 {
        let (x0, y0) = (rng.next_range(0.0, 1500.0), rng.next_range(0.0, 700.0));
        let (x1, y1) = (
            x0 + rng.next_range(1.0, 100.0),
            y0 + rng.next_range(1.0, 100.0),
        );
        let (bx0, by0, bx1, by1) = warp.unwarped_bounds(x0, y0, x1, y1);
        for k in 0..=20 {
            for l in 0..=20 {
                let p = (
                    x0 + (x1 - x0) * k as f64 / 20.0,
                    y0 + (y1 - y0) * l as f64 / 20.0,
                );
                let (ux, uy) = warp.unwarp(p.0, p.1);
                assert!(
                    ux >= bx0 - 1e-9 && ux <= bx1 + 1e-9 && uy >= by0 - 1e-9 && uy <= by1 + 1e-9
                );
            }
        }
    }
}

/// The output position whose unwarp is `u`, by Newton's method.
fn warp_forward(warp: &CanvasWarp<'_>, u: (f64, f64)) -> (f64, f64) {
    let mut p = u;
    for _ in 0..50 {
        let f = warp.unwarp(p.0, p.1);
        let (ex, ey) = (f.0 - u.0, f.1 - u.1);
        if ex.hypot(ey) < 1e-9 {
            break;
        }
        let h = 1e-4;
        let fx = warp.unwarp(p.0 + h, p.1);
        let fy = warp.unwarp(p.0, p.1 + h);
        let (a, b, c, d) = (
            (fx.0 - f.0) / h,
            (fy.0 - f.0) / h,
            (fx.1 - f.1) / h,
            (fy.1 - f.1) / h,
        );
        let det = a * d - b * c;
        p = (p.0 - (d * ex - b * ey) / det, p.1 - (a * ey - c * ex) / det);
    }
    p
}

/// RMS distance, in output pixels, of a source line's warped image from its
/// own best-fit line.
fn bending_px(warp: &CanvasWarp<'_>, from: (f64, f64), to: (f64, f64)) -> f64 {
    let pts: Vec<(f64, f64)> = (0..=64)
        .map(|k| k as f64 / 64.0)
        .map(|s| {
            warp_forward(
                warp,
                (from.0 + s * (to.0 - from.0), from.1 + s * (to.1 - from.1)),
            )
        })
        .collect();
    let n = pts.len() as f64;
    let (mx, my) = pts
        .iter()
        .fold((0.0, 0.0), |(a, b), p| (a + p.0 / n, b + p.1 / n));
    let (sxx, sxy, syy) = pts.iter().fold((0.0, 0.0, 0.0), |(a, b, c), p| {
        let (dx, dy) = (p.0 - mx, p.1 - my);
        (a + dx * dx, b + dx * dy, c + dy * dy)
    });
    let angle = 0.5 * (2.0 * sxy).atan2(sxx - syy);
    let normal = (-angle.sin(), angle.cos());
    (pts.iter()
        .map(|p| ((p.0 - mx) * normal.0 + (p.1 - my) * normal.1).powi(2))
        .sum::<f64>()
        / n)
        .sqrt()
}

/// Line bending on the curved sweep at full strength, the measured stand-in
/// for a line-preserving term (#5570 decision 1): 3.59 px measured, about
/// 5 % headroom. One-way ratchet.
const LINE_BENDING_BUDGET_PX: f64 = 3.75;

#[test]
fn straight_lines_bend_within_budget() {
    let map = solved(curved_sweep, 1.0).map.expect("applied");
    let warp = map.on_canvas(W, H);
    let lines = [
        ((20.0, 100.0), (380.0, 100.0)),
        ((20.0, 60.0), (380.0, 60.0)),
        ((100.0, 30.0), (100.0, 170.0)),
        ((200.0, 15.0), (200.0, 185.0)),
        ((300.0, 30.0), (300.0, 170.0)),
    ];
    let worst = lines
        .iter()
        .map(|&(a, b)| bending_px(&warp, a, b))
        .fold(0.0, f64::max);
    eprintln!("worst line bending: {worst:.4} px on a {W}×{H} canvas");
    assert!(worst <= LINE_BENDING_BUDGET_PX, "{worst}");
}

#[test]
fn the_fold_limit_stops_before_a_cell_turns_over() {
    // A 3×3 node grid whose centre node, at full strength, crosses past its
    // right-hand neighbour: the blend folds partway there.
    let (cols, rows) = (3, 3);
    let mut full = grid::blend(&[(0.0, 0.0); 9], cols, rows, 0.0);
    full[4] = (1.2, 0.5);
    let limit = grid::fold_limit(&full, cols, rows, (2.0, 2.0), MIN_JACOBIAN_RATIO);
    assert!(limit > 0.0 && limit < 1.0, "{limit}");
    let at_limit = grid::blend(&full, cols, rows, limit);
    let worst = grid::min_jacobian(&at_limit, cols, rows, (2.0, 2.0));
    assert!((worst - MIN_JACOBIAN_RATIO).abs() < 1e-9, "{worst}");
    let past = grid::blend(&full, cols, rows, (limit + 1.0) / 2.0);
    assert!(grid::min_jacobian(&past, cols, rows, (2.0, 2.0)) < MIN_JACOBIAN_RATIO);
}

#[test]
fn a_finer_footprint_is_coarsened_and_still_fully_covered() {
    let (w, h) = (1414u32, 707u32);
    let scaled = |x: u32, y: u32| {
        let (x, y) = (
            (x as f64 + 0.5) * W as f64 / w as f64,
            (y as f64 + 0.5) * H as f64 / h as f64,
        );
        tile_scatter(x, y)
    };
    let outcome = solve(&Footprint::from_fn(w, h, false, scaled), 1.0);
    assert_eq!(outcome.report.status, BoundaryWarpStatus::Applied);
    assert_eq!(outcome.report.predicted_coverage, 1.0);
}
