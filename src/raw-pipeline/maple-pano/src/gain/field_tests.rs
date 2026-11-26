use crate::ingest::{PlanarImage, ValidityMask};

use super::field::{
    periodic_axes, ExposureField, ExposureFieldSummary, NodeGrid, MAX_NODES_PER_VIEW,
};
use super::field_solve::{mismatch_weight, solve_layers, LumaLayer};

fn field(grid: NodeGrid, values: Vec<f32>) -> ExposureField {
    ExposureField {
        grid,
        views: vec![Some(values)],
        summary: ExposureFieldSummary {
            lattice: (grid.nx, grid.ny),
            unknowns: 0,
            max_unknowns_per_view: 0,
            max_abs_log: 0.0,
            step_rms_before: 0.0,
            step_rms_after: 0.0,
        },
    }
}

fn image(w: u32, h: u32, value: impl Fn(u32, u32) -> Option<f32>) -> PlanarImage {
    let mut mask = ValidityMask::new_filled(w, h, false);
    let plane: Vec<f32> = (0..w * h)
        .map(|i| {
            let (x, y) = (i % w, i / w);
            value(x, y).map_or(0.0, |v| {
                mask.set(x, y, true);
                v
            })
        })
        .collect();
    PlanarImage::from_planes(w, h, plane.clone(), plane.clone(), plane, mask)
}

#[test]
fn periodic_lattice_is_continuous_across_the_wrap() {
    let grid = NodeGrid {
        nx: 4,
        ny: 2,
        periodic_x: true,
        periodic_y: false,
    };
    let f = field(grid, vec![0.4, 0.0, 0.0, -0.2, 0.4, 0.0, 0.0, -0.2]);
    let (left, right) = (
        f.log_correction(0, 1e-9, 0.5),
        f.log_correction(0, 1.0 - 1e-9, 0.5),
    );
    assert!((left - right).abs() < 1e-6, "{left} vs {right}");
    assert!((left - 0.4).abs() < 1e-6);
}

#[test]
fn transverse_lattice_is_continuous_across_the_row_wrap() {
    let grid = NodeGrid {
        nx: 2,
        ny: 4,
        periodic_x: false,
        periodic_y: true,
    };
    let f = field(grid, vec![0.4, 0.4, 0.0, 0.0, 0.0, 0.0, -0.2, -0.2]);
    let (top, bottom) = (
        f.log_correction(0, 0.5, 1e-9),
        f.log_correction(0, 0.5, 1.0 - 1e-9),
    );
    assert!((top - bottom).abs() < 1e-6, "{top} vs {bottom}");
    assert!((top - 0.4).abs() < 1e-6);
    let first_row_neighbours: Vec<usize> = grid.neighbours(0).collect();
    assert!(
        first_row_neighbours.contains(&6),
        "{first_row_neighbours:?}"
    );
}

#[test]
fn a_full_wrap_canvas_wraps_its_periodic_axis_only() {
    use crate::canvas::CanvasSpec;
    use crate::math::Mat3;
    use crate::project::Projection;
    use std::f64::consts::{PI, TAU};

    let wrapped = |projection, full_wrap| {
        let canvas = CanvasSpec::with_window(
            projection,
            64,
            128,
            -0.5,
            PI,
            1.0 / 64.0,
            -TAU / 128.0,
            Mat3::identity(),
            full_wrap,
        )
        .expect("canvas");
        periodic_axes(&canvas)
    };
    assert_eq!(
        wrapped(Projection::TransverseCylindrical, true),
        (false, true)
    );
    assert_eq!(
        wrapped(Projection::TransverseSpherical, true),
        (false, true)
    );
    assert_eq!(wrapped(Projection::Cylindrical, true), (true, false));
    assert_eq!(
        wrapped(Projection::TransverseCylindrical, false),
        (false, false)
    );
}

#[test]
fn applying_a_field_scales_valid_pixels_by_a_positive_factor_only() {
    let grid = NodeGrid {
        nx: 2,
        ny: 2,
        periodic_x: false,
        periodic_y: false,
    };
    let f = field(grid, vec![-0.6, 0.6, 0.6, -0.6]);
    let canvas = crate::canvas::CanvasSpec::full_sphere(4).expect("canvas");
    let mut strip = image(8, 2, |x, _| (x % 3 != 0).then_some(0.25 * x as f32));
    let before = strip.clone();
    f.apply_to_strip(0, &mut strip, &canvas, (0, 1));
    for i in 0..strip.r.len() {
        let (x, y) = ((i % 8) as u32, (i / 8) as u32);
        if before.validity.get(x, y) {
            let ratio = strip.r[i] / before.r[i].max(1e-9);
            assert!(before.r[i] == 0.0 || ratio > 0.0, "factor at {i} = {ratio}");
        } else {
            assert_eq!(
                strip.r[i], before.r[i],
                "invalid pixel {i} must be untouched"
            );
        }
    }
    assert_ne!(strip.r, before.r);
}

#[test]
fn sparse_footprints_coarsen_the_lattice_under_the_node_cap() {
    let (w, h) = (900_u32, 600_u32);
    let sparse = |gain: f32| {
        move |x: u32, y: u32| {
            (x % 2 == 0 && y % 2 == 0).then_some(0.5 * gain * (1.0 + x as f32 / w as f32))
        }
    };
    let layers = [
        LumaLayer::from_warped(&image(w, h, sparse(1.0))),
        LumaLayer::from_warped(&image(w, h, sparse(1.2))),
    ];
    let solved = solve_layers(&layers, (w as usize, h as usize), (false, false));
    println!("{:?}", solved.summary);
    assert!(solved.summary.max_unknowns_per_view <= MAX_NODES_PER_VIEW);
    assert!(solved.summary.max_unknowns_per_view > MAX_NODES_PER_VIEW / 2);
    assert!(solved.summary.step_rms_after < 0.2 * solved.summary.step_rms_before);
}

#[test]
fn mismatched_texture_node_does_not_drive_the_field() {
    let (w, h) = (256_u32, 256_u32);
    let checker = |x: u32, y: u32, invert: bool| {
        let hi = ((x + y) % 2 == 0) != invert;
        if hi {
            0.8
        } else {
            0.2
        }
    };
    let a = image(w, h, |x, y| {
        Some(if x < w / 2 { 0.5 } else { checker(x, y, false) })
    });
    let b = image(w, h, |x, y| {
        Some(if x < w / 2 {
            0.5
        } else {
            checker(x, y, true) * 0.6_f32.exp()
        })
    });
    let layers = [LumaLayer::from_warped(&a), LumaLayer::from_warped(&b)];
    let solved = solve_layers(&layers, (w as usize, h as usize), (false, false));
    for view in 0..2 {
        let c = solved.log_correction(view, 0.75, 0.5);
        assert!(
            c.abs() < 0.05,
            "view {view} correction {c} driven by mismatch"
        );
    }
}

#[test]
fn aligned_texture_offset_still_fits() {
    let (w, h) = (256_u32, 256_u32);
    let scene = |x: u32, _y: u32| 0.4 + 0.3 * (x as f32 / w as f32);
    let layers = [
        LumaLayer::from_warped(&image(w, h, |x, y| Some(scene(x, y)))),
        LumaLayer::from_warped(&image(w, h, |x, y| Some(scene(x, y) * 0.4_f32.exp()))),
    ];
    let solved = solve_layers(&layers, (w as usize, h as usize), (false, false));
    let split = solved.log_correction(1, 0.5, 0.5) - solved.log_correction(0, 0.5, 0.5);
    assert!(split < -0.25, "aligned offset not fitted: split {split}");
}

#[test]
fn mismatch_weight_follows_the_rfc_form() {
    assert_eq!(mismatch_weight(0.0, 0.0), 1.0);
    assert!((mismatch_weight(0.5, 0.0) - 1.0 / 9.0_f64.powi(9)).abs() < 1e-12);
    assert_eq!(mismatch_weight(2.0, 0.0), mismatch_weight(0.5, 0.0));
    assert!(mismatch_weight(0.1, 0.0) < mismatch_weight(0.01, 0.0));
    assert!((mismatch_weight(0.0, 2.0) - (-2.0_f64).exp()).abs() < 1e-12);
}

#[test]
fn chroma_mismatch_does_not_masquerade_as_exposure() {
    let (w, h) = (128, 128);
    let a = image(w, h, |_, _| Some(0.5));
    let mut b = a.clone();
    b.r.fill(0.0001);
    b.g.fill(0.0001);
    b.b.fill(2.5);
    let layers = [LumaLayer::from_warped(&a), LumaLayer::from_warped(&b)];
    let solved = solve_layers(&layers, (w as usize, h as usize), (false, false));
    assert!(solved.summary.max_abs_log < 0.01, "{:?}", solved.summary);
}

#[test]
fn mismatched_outliers_within_each_node_are_downweighted() {
    let (w, h) = (256, 256);
    let a = image(w, h, |_, _| Some(0.5));
    let b = image(w, h, |x, y| Some(if (x + y) % 2 == 0 { 1.0 } else { 0.5 }));
    let layers = [LumaLayer::from_warped(&a), LumaLayer::from_warped(&b)];
    let solved = solve_layers(&layers, (w as usize, h as usize), (false, false));
    assert!(solved.summary.max_abs_log < 0.01, "{:?}", solved.summary);
}
