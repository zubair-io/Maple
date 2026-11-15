use super::*;
use crate::camera::Camera;

fn images(n: usize) -> Vec<GraphImage> {
    (0..n)
        .map(|_| GraphImage {
            camera: Camera::new([0.0; 3], 500.0, 0.0, 0.0, 640, 480),
            prior_rotation: None,
        })
        .collect()
}

fn fix(x: f64, y: f64) -> Option<GpsPrior> {
    Some(GpsPrior {
        lat_deg: 48.0 + y / 111_195.0,
        lon_deg: 2.0 + x / (111_195.0 * 48.0_f64.to_radians().cos()),
        relative_altitude_m: None,
    })
}

#[test]
fn proximity_adds_cross_pass_pairs_with_explainable_distances() {
    let fixes = vec![
        fix(0.0, 0.0),
        fix(20.0, 0.0),
        fix(20.2, 20.0),
        fix(0.1, 20.1),
        None,
    ];
    let provider = GpsPriorProvider {
        fixes: &fixes,
        ground: &[],
    };
    let nominations = provider.nominations(5);
    assert!(nominations
        .iter()
        .any(|n| (n.a, n.b) == (0, 3) && (n.distance_m - 20.1).abs() < 0.1));
    assert!(nominations
        .iter()
        .all(|n| n.distance_m <= n.limit_m && n.b < 4));
    assert_eq!(
        provider.candidates(&images(5)),
        provider.candidates(&images(5))
    );
    assert_eq!(provider.name(), "gps-proximity");
}

#[test]
fn fanout_is_bounded_even_for_identical_fixes() {
    let fixes = vec![fix(0.0, 0.0); 100];
    let pairs = GpsPriorProvider {
        fixes: &fixes,
        ground: &[],
    }
    .candidates(&images(100));
    for i in 0..100 {
        assert!(pairs.iter().filter(|&&(a, b)| a == i || b == i).count() <= GPS_MAX_NEIGHBOURS);
    }
}

#[test]
fn missing_invalid_or_remote_fixes_do_not_nominate() {
    let fixes = vec![
        fix(0.0, 0.0),
        fix(1.0, 0.0),
        fix(2.0, 0.0),
        fix(3.0, 0.0),
        fix(1e6, 0.0),
        Some(GpsPrior {
            lat_deg: f64::NAN,
            lon_deg: 0.0,
            relative_altitude_m: None,
        }),
        None,
    ];
    let pairs = GpsPriorProvider {
        fixes: &fixes,
        ground: &[],
    }
    .candidates(&images(7));
    assert!(pairs.iter().all(|&(_, b)| b < 4));
}
