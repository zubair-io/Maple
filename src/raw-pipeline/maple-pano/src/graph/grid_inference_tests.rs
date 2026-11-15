use super::*;
use crate::ingest::{GimbalPrior, GpsPrior};

fn captures(layout: GridLayout, n: usize, jitter: f64) -> Vec<FramePriors> {
    (0..n)
        .map(|i| {
            let (r, c) = layout.cell(i).unwrap();
            let noise = if i % 2 == 0 { jitter } else { -jitter };
            FramePriors {
                gps: Some(GpsPrior {
                    lat_deg: 48.0 + (r as f64 * 30.0 + noise) / 111_195.0,
                    lon_deg: 2.0
                        + (c as f64 * 20.0 - noise) / (111_195.0 * 48.0_f64.to_radians().cos()),
                    relative_altitude_m: None,
                }),
                ..Default::default()
            }
        })
        .collect()
}

#[test]
fn infers_dimensions_and_both_capture_orders_with_gps_jitter() {
    for order in [GridOrder::Raster, GridOrder::Serpentine] {
        let layout = GridLayout {
            rows: 3,
            cols: 4,
            order,
            diagonals: false,
        };
        for n in [10, 12] {
            assert_eq!(infer_grid(&captures(layout, n, 0.8)), Some(layout));
        }
    }
}

#[test]
fn refuses_missing_stationary_collinear_and_irregular_metadata() {
    assert_eq!(infer_grid(&vec![FramePriors::default(); 12]), None);
    let layout = GridLayout {
        rows: 3,
        cols: 4,
        order: GridOrder::Raster,
        diagonals: false,
    };
    let mut priors = captures(layout, 12, 0.0);
    for p in &mut priors {
        p.gps = priors_first_fix();
    }
    assert_eq!(infer_grid(&priors), None);
    let mut priors = captures(layout, 12, 0.0);
    for (i, p) in priors.iter_mut().enumerate() {
        p.gps.as_mut().unwrap().lat_deg = 48.0;
        p.gps.as_mut().unwrap().lon_deg = 2.0 + i as f64 * 0.001;
    }
    assert_eq!(infer_grid(&priors), None);
    let mut priors = captures(layout, 12, 0.0);
    priors[5].gps.as_mut().unwrap().lat_deg += 0.01;
    assert_eq!(infer_grid(&priors), None);
}

fn priors_first_fix() -> Option<GpsPrior> {
    Some(GpsPrior {
        lat_deg: 48.0,
        lon_deg: 2.0,
        relative_altitude_m: None,
    })
}

#[test]
fn infers_pose_grid_across_yaw_wrap_but_not_nadir_yaw_noise() {
    let layout = GridLayout {
        rows: 3,
        cols: 4,
        order: GridOrder::Serpentine,
        diagonals: false,
    };
    let mut priors: Vec<_> = (0..12)
        .map(|i| {
            let (r, c) = layout.cell(i).unwrap();
            FramePriors {
                gimbal: Some(GimbalPrior {
                    yaw_deg: (170.0 + c as f64 * 10.0 + 180.0).rem_euclid(360.0) - 180.0,
                    pitch_deg: r as f64 * 10.0 - 10.0,
                    roll_deg: 0.0,
                }),
                ..Default::default()
            }
        })
        .collect();
    assert_eq!(infer_grid(&priors), Some(layout));
    for p in &mut priors {
        p.gimbal.as_mut().unwrap().pitch_deg = -90.0;
    }
    assert_eq!(infer_grid(&priors), None);
}
