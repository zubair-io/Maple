//! Focused tests for local mesh warp interpolation scaffolding.

use pano_core::warp::{
    build_local_warp_fields, Canvas, CanvasParams, LocalWarpDisplacement, LocalWarpField,
    LocalWarpObservation, LocalWarpOptions, ProjectionPoint,
};
use pano_core::Projection;

const EPS: f32 = 1.0e-6;

fn test_canvas() -> Canvas {
    Canvas {
        width: 11,
        height: 11,
        projection: Projection::Rectilinear,
        params: CanvasParams::Rectilinear {
            focal: 10.0,
            cx: 5.0,
            cy: 5.0,
        },
    }
}

fn test_options() -> LocalWarpOptions {
    LocalWarpOptions {
        mesh_cols: 3,
        mesh_rows: 3,
        max_displacement_px: 32.0,
    }
}

fn assert_displacement_close(actual: LocalWarpDisplacement, expected: LocalWarpDisplacement) {
    assert!(
        (actual.dx - expected.dx).abs() <= EPS,
        "dx mismatch: actual={} expected={}",
        actual.dx,
        expected.dx
    );
    assert!(
        (actual.dy - expected.dy).abs() <= EPS,
        "dy mismatch: actual={} expected={}",
        actual.dy,
        expected.dy
    );
}

#[test]
fn no_op_sampling_returns_zero_displacement() {
    let canvas = test_canvas();
    let field = LocalWarpField::no_op(&canvas, test_options()).unwrap();

    for (x, y) in [(0.0, 0.0), (5.0, 5.0), (10.0, 10.0), (2.5, 7.5)] {
        assert_displacement_close(
            field.sample(x, y).expect("sample should be in bounds"),
            LocalWarpDisplacement::ZERO,
        );
    }
}

#[test]
fn sampling_at_mesh_vertices_is_exact() {
    let canvas = test_canvas();
    let displacements = vec![
        LocalWarpDisplacement::new(0.0, 0.0),
        LocalWarpDisplacement::new(1.0, 0.0),
        LocalWarpDisplacement::new(2.0, 0.0),
        LocalWarpDisplacement::new(0.0, 1.0),
        LocalWarpDisplacement::new(1.0, 1.0),
        LocalWarpDisplacement::new(2.0, 1.0),
        LocalWarpDisplacement::new(0.0, 2.0),
        LocalWarpDisplacement::new(1.0, 2.0),
        LocalWarpDisplacement::new(2.0, 2.0),
    ];
    let field = LocalWarpField::try_new(canvas.width, canvas.height, 3, 3, displacements).unwrap();

    for row in 0..field.mesh_rows() {
        for col in 0..field.mesh_cols() {
            let (x, y) = field.vertex_canvas_position(col, row).unwrap();
            let expected = field.vertex(col, row).unwrap();
            assert_displacement_close(field.sample(x, y).unwrap(), expected);
        }
    }
}

#[test]
fn bilinear_sampling_interpolates_cell_center() {
    let canvas = test_canvas();
    let displacements = vec![
        LocalWarpDisplacement::new(0.0, 0.0),
        LocalWarpDisplacement::new(2.0, 0.0),
        LocalWarpDisplacement::new(0.0, 0.0),
        LocalWarpDisplacement::new(0.0, 2.0),
        LocalWarpDisplacement::new(2.0, 2.0),
        LocalWarpDisplacement::new(0.0, 0.0),
        LocalWarpDisplacement::new(0.0, 0.0),
        LocalWarpDisplacement::new(0.0, 0.0),
        LocalWarpDisplacement::new(0.0, 0.0),
    ];
    let field = LocalWarpField::try_new(canvas.width, canvas.height, 3, 3, displacements).unwrap();

    let center = field.sample(2.5, 2.5).expect("cell center should sample");
    assert_displacement_close(center, LocalWarpDisplacement::new(1.0, 1.0));
}

#[test]
fn sampling_bounds_are_inclusive_for_canvas_and_reject_outside() {
    let canvas = test_canvas();
    let field = LocalWarpField::constant(
        &canvas,
        test_options(),
        LocalWarpDisplacement::new(3.0, -4.0),
    )
    .unwrap();

    assert!(field.sample(0.0, 0.0).is_some());
    assert!(field.sample(10.0, 10.0).is_some());
    assert!(field.sample(-0.001, 5.0).is_none());
    assert!(field.sample(5.0, -0.001).is_none());
    assert!(field.sample(10.001, 5.0).is_none());
    assert!(field.sample(5.0, 10.001).is_none());
}

#[test]
fn constant_field_samples_same_displacement_across_canvas() {
    let canvas = test_canvas();
    let expected = LocalWarpDisplacement::new(3.25, -1.5);
    let field = LocalWarpField::constant(&canvas, test_options(), expected).unwrap();

    for (x, y) in [(0.0, 0.0), (1.25, 9.5), (5.0, 5.0), (10.0, 10.0)] {
        assert_displacement_close(field.sample(x, y).unwrap(), expected);
        let warped = field.warp_canvas_point(x, y).unwrap();
        assert!((warped.0 - (x + expected.dx)).abs() <= EPS);
        assert!((warped.1 - (y + expected.dy)).abs() <= EPS);
    }
}

#[test]
fn observations_build_clamped_constant_field_per_image() {
    let canvas = test_canvas();
    let options = LocalWarpOptions {
        mesh_cols: 2,
        mesh_rows: 2,
        max_displacement_px: 4.0,
    };
    let obs = [
        LocalWarpObservation::new(
            0,
            5.0,
            5.0,
            ProjectionPoint::rectilinear(0.0, 0.0),
            LocalWarpDisplacement::new(6.0, -2.0),
            1.0,
        ),
        LocalWarpObservation::new(
            0,
            6.0,
            5.0,
            ProjectionPoint::rectilinear(0.1, 0.0),
            LocalWarpDisplacement::new(6.0, -2.0),
            1.0,
        ),
    ];

    let result = build_local_warp_fields(2, &canvas, &obs, options).unwrap();
    assert_eq!(result.diagnostics.used_observation_count, 2);
    assert_eq!(result.diagnostics.constant_field_count, 1);
    assert_eq!(result.diagnostics.no_op_field_count, 1);

    let image_0 = result.field_for_image(0).unwrap();
    assert_displacement_close(
        image_0.sample(5.0, 5.0).unwrap(),
        LocalWarpDisplacement::new(4.0, -2.0),
    );

    let image_1 = result.field_for_image(1).unwrap();
    assert_displacement_close(
        image_1.sample(5.0, 5.0).unwrap(),
        LocalWarpDisplacement::ZERO,
    );
}
