//! The presented → frame map the mask overlay draws and picks through:
//! the crop's inverse, then the manual geometry's, as the preview samples.
use super::*;

const NO_CROP: Crop = Crop {
    top: 0.0,
    left: 0.0,
    bottom: 1.0,
    right: 1.0,
    angle: 0.0,
};

fn project(m: &[f64; 9], x: f64, y: f64) -> (f64, f64) {
    let w = m[6] * x + m[7] * y + m[8];
    (
        (m[0] * x + m[1] * y + m[2]) / w,
        (m[3] * x + m[4] * y + m[5]) / w,
    )
}

fn close(got: (f64, f64), want: (f64, f64), what: &str) {
    assert!(
        (got.0 - want.0).abs() < 1e-4 && (got.1 - want.1).abs() < 1e-4,
        "{what}: {got:?} != {want:?}"
    );
}

/// The render's own composition: the presented point `q` (normalised) reaches
/// the frame through the crop's inverse, then the geometry's inverse — so the
/// geometry's forward map of the frame point lands on the crop's inverse of `q`.
fn assert_matches_render(m: &[f64; 9], crop: Crop, perspective: Perspective, what: &str) {
    let (w, h) = (400, 300);
    let forward = perspective.matrix(aspect_ratio(w, h));
    let crop = CropPresentation::new(&crop, w, h).inverse;
    for (qx, qy) in [(0.5, 0.5), (0.1, 0.2), (0.9, 0.15), (0.3, 0.85), (0.8, 0.7)] {
        let (fx, fy) = project(m, qx, qy);
        let warped = forward
            .project((2.0 * fx - 1.0) as f32, (2.0 * fy - 1.0) as f32)
            .unwrap();
        let cropped = crop
            .project((2.0 * qx - 1.0) as f32, (2.0 * qy - 1.0) as f32)
            .unwrap();
        close(
            (f64::from(warped.0), f64::from(warped.1)),
            (f64::from(cropped.0), f64::from(cropped.1)),
            what,
        );
    }
}

#[test]
fn the_crop_frame_maps_the_presented_crop_onto_the_full_frame() {
    let mut out = [0.0; 9];
    let geometry = [0.0, 0.0, 0.0, 100.0, 0.0, 0.0, 0.0];
    assert!(unsafe {
        maple_android_mask_frame(
            400,
            300,
            0.0,
            0.0,
            1.0,
            1.0,
            0.0,
            geometry.as_ptr(),
            out.as_mut_ptr(),
        )
    });
    assert_eq!(out, [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    assert!(unsafe {
        maple_android_mask_frame(
            400,
            300,
            0.2,
            0.25,
            0.8,
            0.75,
            0.0,
            geometry.as_ptr(),
            out.as_mut_ptr(),
        )
    });
    for (got, want) in out
        .iter()
        .zip([0.5, 0.0, 0.25, 0.0, 0.6, 0.2, 0.0, 0.0, 1.0])
    {
        assert!((got - want).abs() < 1e-6, "{out:?}");
    }
    let crop = Crop {
        top: 0.1,
        left: 0.1,
        bottom: 0.9,
        right: 0.9,
        angle: 10.0,
    };
    let tilted = presentation_to_frame(400, 300, crop, Perspective::IDENTITY);
    close(
        project(&tilted, 0.5, 0.5),
        (0.5, 0.5),
        "a centred crop keeps the centre",
    );
    assert!(
        tilted[1].abs() > 1e-3,
        "a straightened crop rotates the frame"
    );
    assert_matches_render(&tilted, crop, Perspective::IDENTITY, "straightened crop");
}

#[test]
fn the_frame_map_carries_the_manual_geometry_the_render_applies() {
    // An X offset of 50 moves the image half a half-extent right: the
    // presented centre shows the frame a quarter of the width to its left.
    let offset = Perspective {
        x: 50.0,
        ..Perspective::IDENTITY
    };
    let m = presentation_to_frame(400, 300, NO_CROP, offset);
    close(project(&m, 0.5, 0.5), (0.25, 0.5), "offset");
    assert_matches_render(&m, NO_CROP, offset, "offset");

    // A keystone is projective: no affine map reproduces it.
    let keystone = Perspective {
        vertical: 40.0,
        ..Perspective::IDENTITY
    };
    let m = presentation_to_frame(400, 300, NO_CROP, keystone);
    assert!(m[7].abs() > 1e-3, "{m:?}");
    assert_matches_render(&m, NO_CROP, keystone, "keystone");

    let rotated = Perspective {
        rotate: 10.0,
        ..Perspective::IDENTITY
    };
    let crop = Crop {
        top: 0.1,
        left: 0.2,
        bottom: 0.9,
        right: 0.7,
        angle: 5.0,
    };
    let m = presentation_to_frame(400, 300, crop, rotated);
    assert_matches_render(&m, crop, rotated, "rotate + crop");
    let crop_only = presentation_to_frame(400, 300, crop, Perspective::IDENTITY);
    let (a, b) = (project(&m, 0.1, 0.2), project(&crop_only, 0.1, 0.2));
    assert!(
        (a.0 - b.0).abs() > 1e-3 || (a.1 - b.1).abs() > 1e-3,
        "the geometry rotation moves the frame point"
    );
}
