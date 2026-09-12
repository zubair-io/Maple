use super::bundle::parse;
use super::matcher::find;
use super::resolve::resolve;
use super::test_support::sample_bundle;
use crate::lens_profile::{LensQuery, Source};

fn query(focal: f64, f_number: Option<f64>, focus_m: Option<f64>) -> LensQuery<'static> {
    LensQuery {
        make: "SONY",
        camera: "ILCE-7RM4",
        lens: "FE 24-70mm F4 ZA OSS",
        focal_mm: focal,
        f_number,
        focus_m,
    }
}

#[test]
fn a_shot_inside_the_calibrated_range_resolves_every_family_exactly() {
    let db = parse(&sample_bundle()).unwrap();
    let m = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    let res = resolve(&db, &m, 9504.0, 6336.0, &query(24.0, Some(5.6), Some(5.0))).unwrap();
    assert!(
        matches!(&res.source, Source::Lensfun { maker, model, db_version } if maker == "Sony" && model == "FE 24-70mm f/4 ZA OSS" && db_version == "12f5976 (2026-09-11)")
    );
    assert!(res.calibration.distortion.is_some() && res.calibration.ca.is_some());
    let v = res.calibration.vignette.expect("vignette");
    assert_eq!(
        v.radial,
        [f64::from(-0.2f32), f64::from(0.3f32), f64::from(-0.4f32)]
    );
    assert!(res.approximations.is_empty(), "{:?}", res.approximations);
    assert_eq!(res.distortion_samples.len(), 1);
    assert_eq!(res.vignette_samples[0].weight, 1.0);
}

#[test]
fn missing_distance_or_aperture_is_not_an_approximation_for_geometry() {
    let db = parse(&sample_bundle()).unwrap();
    let m = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    let res = resolve(&db, &m, 9504.0, 6336.0, &query(24.0, None, None)).unwrap();
    assert!(res.calibration.distortion.is_some());
    // Vignetting depends on aperture, which the shot did not record: the
    // resolver picks the smallest calibrated aperture and says so.
    assert!(
        res.approximations
            .iter()
            .all(|a| a.starts_with("Vignetting")),
        "{:?}",
        res.approximations
    );
}

#[test]
fn out_of_range_focal_and_aperture_are_reported_not_refused() {
    let db = parse(&sample_bundle()).unwrap();
    let m = find(&db, "SONY", "ILCE-7RM4", "FE 24-70mm F4 ZA OSS").unwrap();
    let res = resolve(
        &db,
        &m,
        9504.0,
        6336.0,
        &query(300.0, Some(11.0), Some(5.0)),
    )
    .unwrap();
    assert!(res.approximations.iter().any(|a| a.contains("focal")));
    assert!(res.approximations.iter().any(|a| a.contains("aperture")));
    assert!(resolve(&db, &m, 9504.0, 6336.0, &query(0.0, None, None)).is_err());
}
