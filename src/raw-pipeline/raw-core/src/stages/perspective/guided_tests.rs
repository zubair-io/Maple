use super::*;

fn solve_guides(
    lines: &[GuideLine],
    family: GuideFamily,
    ar: f32,
) -> Result<GuidedCorrection, &'static str> {
    super::solve_guides(lines, family, ar, Perspective::IDENTITY, 0.0)
}

fn fixture(p: Perspective, ar: f32) -> Vec<GuideLine> {
    let inverse = p.inverse_matrix(ar);
    [
        [-0.45, -0.5, -0.45, 0.5],
        [0.45, -0.5, 0.45, 0.5],
        [-0.5, -0.4, 0.5, -0.4],
        [-0.5, 0.4, 0.5, 0.4],
    ]
    .into_iter()
    .map(|[x1, y1, x2, y2]| {
        let a = inverse.project(x1, y1).unwrap();
        let b = inverse.project(x2, y2).unwrap();
        GuideLine([a.0, a.1, b.0, b.1])
    })
    .collect()
}

#[test]
fn four_guides_recover_the_export_homography_on_a_nonsquare_frame() {
    let expected = Perspective {
        vertical: -25.0,
        horizontal: 18.0,
        rotate: 4.0,
        ..Perspective::IDENTITY
    };
    let ar = 1.5;
    let lines = fixture(expected, ar);
    let solved = solve_guides(&lines, GuideFamily::Both, ar).unwrap();
    assert!(!solved.limited);
    assert!((solved.vertical - expected.vertical).abs() < 1e-3);
    assert!((solved.horizontal - expected.horizontal).abs() < 1e-3);
    assert!((solved.rotate - expected.rotate).abs() < 1e-3);
    let p = Perspective {
        vertical: solved.vertical,
        horizontal: solved.horizontal,
        rotate: solved.rotate,
        ..Perspective::IDENTITY
    };
    let h = p.matrix(ar);
    // At 10,000px long edge the same export homography must level every
    // guide to better than one pixel, not just reduce its convergence.
    for (i, line) in lines.iter().enumerate() {
        let [x1, y1, x2, y2] = line.0;
        let a = h.project(x1, y1).unwrap();
        let b = h.project(x2, y2).unwrap();
        let error = if i < 2 {
            (a.0 - b.0).abs()
        } else {
            (a.1 - b.1).abs()
        };
        assert!(error * 5_000.0 < 1.0, "guide {i}: {error}");
    }
}

#[test]
fn parallel_horizontal_guides_only_level_the_horizon() {
    let lines = fixture(
        Perspective {
            rotate: -6.0,
            ..Perspective::IDENTITY
        },
        1.6,
    );
    let solved = solve_guides(&lines[2..], GuideFamily::Horizontal, 1.6).unwrap();
    assert_eq!(solved.vertical, 0.0);
    assert_eq!(solved.horizontal, 0.0);
    assert!((solved.rotate + 6.0).abs() < 1e-3);
}

#[test]
fn two_vertical_guides_recover_keystone_and_rotation() {
    let p = Perspective {
        vertical: 40.0,
        rotate: 7.0,
        ..Perspective::IDENTITY
    };
    let lines = fixture(p, 1.5);
    let solved = solve_guides(&lines[..2], GuideFamily::Vertical, 1.5).unwrap();
    assert!((solved.vertical - p.vertical).abs() < 1e-3);
    assert!((solved.rotate - p.rotate).abs() < 1e-3);
    assert_eq!(solved.horizontal, 0.0);
}

#[test]
fn endpoint_reversal_and_unequal_lengths_do_not_change_the_solve() {
    let lines = fixture(
        Perspective {
            vertical: 25.0,
            horizontal: -15.0,
            rotate: -3.0,
            ..Perspective::IDENTITY
        },
        0.75,
    );
    let mut reordered = lines.clone();
    let [x1, y1, x2, y2] = reordered[0].0;
    reordered[0] = GuideLine([x2, y2, x1, y1]);
    let [x1, y1, x2, y2] = reordered[3].0;
    reordered[3] = GuideLine([x1, y1, (x1 + x2) / 2.0, (y1 + y2) / 2.0]);
    let a = solve_guides(&lines, GuideFamily::Both, 0.75).unwrap();
    let b = solve_guides(&reordered, GuideFamily::Both, 0.75).unwrap();
    assert!((a.rotate - b.rotate).abs() < 1e-3);
    assert!((a.vertical - b.vertical).abs() < 1e-3);
    assert!((a.horizontal - b.horizontal).abs() < 1e-3);
}

#[test]
fn unusable_guides_are_rejected_and_limits_are_reported() {
    assert!(solve_guides(&[], GuideFamily::Both, 1.0).is_err());
    let zero = GuideLine([0.0; 4]);
    assert!(solve_guides(&[zero, zero], GuideFamily::Vertical, 1.0).is_err());
    let same = GuideLine([0.0, -0.5, 0.0, 0.5]);
    assert!(solve_guides(&[same, same], GuideFamily::Vertical, 1.0).is_err());
    let lines = fixture(
        Perspective {
            rotate: 20.0,
            ..Perspective::IDENTITY
        },
        1.0,
    );
    let solved = solve_guides(&lines[2..], GuideFamily::Horizontal, 1.0).unwrap();
    assert!(solved.limited);
    assert_eq!(solved.rotate, 10.0);
    let mut invalid = lines;
    invalid[0].0[0] = f32::NAN;
    assert!(solve_guides(&invalid, GuideFamily::Both, 1.0).is_err());
}

#[test]
fn existing_geometry_is_replaced_and_crop_straighten_is_preserved() {
    let ar = 1.5;
    let expected = Perspective {
        vertical: -25.0,
        horizontal: 18.0,
        rotate: 20.0,
        ..Perspective::IDENTITY
    };
    let source = fixture(expected, ar);
    let current = Perspective {
        vertical: 12.0,
        horizontal: -7.0,
        rotate: -4.0,
        aspect: 60.0,
        scale: 115.0,
        x: 8.0,
        y: -3.0,
    };
    let displayed = source
        .iter()
        .map(|line| {
            let [x1, y1, x2, y2] = line.0;
            let h = current.matrix(ar);
            let a = h.project(x1, y1).unwrap();
            let b = h.project(x2, y2).unwrap();
            GuideLine([a.0, a.1, b.0, b.1])
        })
        .collect::<Vec<_>>();
    let crop_angle = 20.0_f32;
    for family in [
        GuideFamily::Both,
        GuideFamily::Vertical,
        GuideFamily::Horizontal,
    ] {
        let indices = if family == GuideFamily::Horizontal {
            2..4
        } else if family == GuideFamily::Both {
            0..4
        } else {
            0..2
        };
        let solved =
            super::solve_guides(&displayed[indices.clone()], family, ar, current, crop_angle)
                .unwrap();
        // Two-family correction reaches the proper final angle without first
        // clipping the 20-degree pre-crop solve to the +/-10-degree slider.
        if family == GuideFamily::Both {
            assert!(!solved.limited);
        }
        let final_p = Perspective {
            vertical: solved.vertical,
            horizontal: solved.horizontal,
            rotate: solved.rotate,
            ..current
        };
        let (sin, cos) = crop_angle.to_radians().sin_cos();
        let crop = Homography([cos, -sin / ar, 0.0, sin * ar, cos, 0.0, 0.0, 0.0, 1.0]);
        let h = crop.mul(&final_p.matrix(ar));
        // Both solves make both families parallel, with the vertical pair
        // authoritative for axis alignment (preserving arbitrary aspect).
        for line in &source[if family == GuideFamily::Both {
            0..2
        } else {
            indices
        }] {
            let [x1, y1, x2, y2] = line.0;
            let a = h.project(x1, y1).unwrap();
            let b = h.project(x2, y2).unwrap();
            let error = if family == GuideFamily::Horizontal {
                (a.1 - b.1).abs()
            } else {
                (a.0 - b.0).abs()
            };
            if !solved.limited {
                assert!(error * 5000.0 < 1.0, "{family:?}: {error}");
            }
        }
    }
}

#[test]
fn four_guides_export_parallel_vertical_edges_within_one_pixel() {
    let (w, h) = (900_u32, 600_u32);
    let ar = w as f32 / h as f32;
    let expected = Perspective {
        vertical: -25.0,
        horizontal: 18.0,
        rotate: 4.0,
        ..Perspective::IDENTITY
    };
    let lines = fixture(expected, ar);
    let solved = solve_guides(&lines, GuideFamily::Both, ar).unwrap();
    // Rasterise two actual converging source edges, then send their pixels
    // through the integer export tail, independent of the guide projection.
    let homography = expected.matrix(ar);
    let rgb = (0..h)
        .flat_map(|y| {
            (0..w).flat_map(move |x| {
                let nx = (x as f32 + 0.5) / (w as f32 / 2.0) - 1.0;
                let ny = (y as f32 + 0.5) / (h as f32 / 2.0) - 1.0;
                let (px, _) = homography.project(nx, ny).unwrap();
                let v = if (px.abs() - 0.45).abs() < 0.005 {
                    255_u8
                } else {
                    0
                };
                [v; 3]
            })
        })
        .collect::<Vec<_>>();
    let p = Perspective {
        vertical: solved.vertical,
        horizontal: solved.horizontal,
        rotate: solved.rotate,
        ..Perspective::IDENTITY
    };
    let exported = super::super::apply_int_rgb(&rgb, w, h, &p).unwrap();
    for range in [200..300, 600..700] {
        let centres = (150..450)
            .map(|y| {
                let (weight, moment) = range.clone().fold((0.0, 0.0), |(weight, moment), x| {
                    let v = f64::from(exported[(y * w as usize + x) * 3]);
                    (weight + v, moment + v * x as f64)
                });
                assert!(weight > 200.0);
                moment / weight
            })
            .collect::<Vec<_>>();
        let min = centres.iter().copied().fold(f64::INFINITY, f64::min);
        let max = centres.iter().copied().fold(f64::NEG_INFINITY, f64::max);
        assert!(max - min <= 1.0, "export edge drifted {}px", max - min);
    }
}
