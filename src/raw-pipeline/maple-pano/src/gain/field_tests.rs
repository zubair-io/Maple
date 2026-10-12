use crate::ingest::{PlanarImage, ValidityMask};

use super::field::{ExposureField, ExposureFieldSummary, NodeGrid, MAX_NODES_PER_VIEW};
use super::field_solve::{solve_layers, LumaLayer};

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
fn applying_a_field_scales_valid_pixels_by_a_positive_factor_only() {
    let grid = NodeGrid {
        nx: 2,
        ny: 2,
        periodic_x: false,
    };
    let f = field(grid, vec![-0.6, 0.6, 0.6, -0.6]);
    let canvas = crate::canvas::CanvasSpec::full_sphere(4).expect("canvas");
    let mut strip = image(8, 2, |x, _| (x % 3 != 0).then_some(0.25 * x as f32));
    let before = strip.clone();
    f.apply_to_strip(0, &mut strip, &canvas, 1);
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
    let solved = solve_layers(&layers, (w as usize, h as usize), false);
    println!("{:?}", solved.summary);
    assert!(solved.summary.max_unknowns_per_view <= MAX_NODES_PER_VIEW);
    assert!(solved.summary.max_unknowns_per_view > MAX_NODES_PER_VIEW / 2);
    assert!(solved.summary.step_rms_after < 0.2 * solved.summary.step_rms_before);
}
