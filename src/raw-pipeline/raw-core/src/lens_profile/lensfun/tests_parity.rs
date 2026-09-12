//! Parity with `liblensfun` at exact sample points, from
//! `test-fixtures/qualification/lensfun-reference.json` (Task 1 of the
//! plan): the same camera, lens, focal, aperture, distance and image size
//! must give the same source coordinates and vignetting factors.

use super::calibration::{chromatic, distortion, vignette};
use super::database;
use super::names::{canonical, canonical_camera};
use serde::Deserialize;

const TOLERANCE_PX: f64 = 0.05;
const TOLERANCE_GAIN: f64 = 1e-4;

#[derive(Deserialize)]
struct Reference {
    db_commit: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
struct Identity {
    maker: String,
    model: String,
}

#[derive(Deserialize)]
struct Case {
    camera: Identity,
    lens: Identity,
    crop: f64,
    width: f64,
    height: f64,
    focal: f64,
    aperture: f64,
    distance: f64,
    points: Vec<[f64; 2]>,
    distortion: Vec<[f64; 2]>,
    tca: Vec<[[f64; 2]; 3]>,
    vignetting: Vec<f64>,
}

fn reference() -> Reference {
    serde_json::from_str(include_str!(
        "../../../../../../test-fixtures/qualification/lensfun-reference.json"
    ))
    .expect("reference JSON")
}

/// The harness passed `case.crop` to lfModifier; the DB camera only
/// identifies the mount.
fn find_case<'a>(case: &Case) -> (&'a super::Camera, &'a super::Lens) {
    let db = database();
    let camera = db
        .cameras
        .iter()
        .find(|c| {
            canonical_camera(&c.maker, &c.model)
                == canonical_camera(&case.camera.maker, &case.camera.model)
        })
        .expect("camera in bundle");
    let wanted = canonical(&case.lens.maker, &case.lens.model);
    let lens = db
        .lenses
        .iter()
        .filter(|l| {
            std::iter::once(&l.model)
                .chain(&l.names)
                .any(|n| canonical(&l.maker, n) == wanted)
        })
        .filter(|l| case.crop / l.crop >= super::matcher::MIN_CROP_RATIO)
        .min_by(|a, b| (case.crop / a.crop).total_cmp(&(case.crop / b.crop)))
        .expect("lens in bundle");
    (camera, lens)
}

#[test]
fn reference_was_recorded_against_the_bundled_snapshot() {
    assert_eq!(reference().db_commit, database().version.commit);
}

#[test]
fn distortion_matches_liblensfun_at_sample_focals() {
    for case in reference().cases {
        let (camera, lens) = find_case(&case);
        let sample = lens
            .distortion
            .iter()
            .find(|s| (s.focal - case.focal).abs() < 1e-6)
            .expect("exact distortion sample focal");
        let p = distortion(sample, case.crop, case.width, case.height);
        for (point, expected) in case.points.iter().zip(&case.distortion) {
            let got = p.map(case.width, case.height, *point);
            assert!(
                (got[0] - expected[0]).abs() < TOLERANCE_PX
                    && (got[1] - expected[1]).abs() < TOLERANCE_PX,
                "{} {} @{}mm point {:?}: got {:?} want {:?}",
                lens.maker,
                lens.model,
                case.focal,
                point,
                got,
                expected
            );
        }
    }
}

#[test]
fn tca_matches_liblensfun_at_sample_focals() {
    for case in reference().cases {
        let (camera, lens) = find_case(&case);
        let Some(sample) = lens
            .tca
            .iter()
            .find(|s| (s.focal - case.focal).abs() < 1e-6)
        else {
            // A lens without TCA data: liblensfun leaves every channel where it was.
            for (point, expected) in case.points.iter().zip(&case.tca) {
                for channel in expected {
                    assert_eq!(channel, point);
                }
            }
            continue;
        };
        let c = chromatic(sample, case.crop, case.width, case.height);
        for (point, expected) in case.points.iter().zip(&case.tca) {
            for channel in 0..3 {
                let got = c.map(case.width, case.height, *point, channel);
                let want = expected[channel];
                assert!(
                    (got[0] - want[0]).abs() < TOLERANCE_PX
                        && (got[1] - want[1]).abs() < TOLERANCE_PX,
                    "{} {} @{}mm channel {channel} point {:?}: got {:?} want {:?}",
                    lens.maker,
                    lens.model,
                    case.focal,
                    point,
                    got,
                    want
                );
            }
        }
    }
}

#[test]
fn vignetting_matches_liblensfun_at_sample_settings() {
    for case in reference().cases {
        let (camera, lens) = find_case(&case);
        let sample = lens.vignetting.iter().find(|s| {
            (s.focal - case.focal).abs() < 1e-6
                && (s.aperture - case.aperture).abs() < 1e-6
                && (s.distance - case.distance).abs() < 1e-6
        });
        let Some(sample) = sample else {
            assert!(
                case.vignetting.iter().all(|f| (*f - 1.0).abs() < 1e-9),
                "no sample, expected identity"
            );
            continue;
        };
        let v = vignette(sample, case.crop, case.width, case.height);
        for (point, expected) in case.points.iter().zip(&case.vignetting) {
            let gain = v
                .gain(case.width, case.height, *point)
                .expect("positive illumination");
            assert!(
                (gain - expected).abs() < TOLERANCE_GAIN,
                "{} {} @{}mm f/{} point {:?}: gain {} want {}",
                lens.maker,
                lens.model,
                case.focal,
                case.aperture,
                point,
                gain,
                expected
            );
        }
    }
}
