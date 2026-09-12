//! A matched bundled lens → `Resolution`, through the same selection and
//! interpolation the LCP path uses (`resolve_records`), so both profile
//! kinds behave identically at every focal length, aperture and distance.

use super::bundle::Database;
use super::calibration::{chromatic, distortion, vignette};
use super::matcher::Match;
use crate::lens_profile::model::Calibration;
use crate::lens_profile::resolve::{resolve_records, target_axes, Record};
use crate::lens_profile::{LensQuery, Resolution, Source};

/// Lensfun's distortion and TCA samples have no distance axis; treating them
/// as calibrated at infinity keeps the axis defined without ever reading
/// as out of range (the query's own distance is used when it has one).
const INFINITY_M: f64 = 1000.0;

pub fn resolve(
    db: &Database,
    matched: &Match<'_>,
    width: f64,
    height: f64,
    query: &LensQuery<'_>,
) -> Result<Resolution, String> {
    if !query.focal_mm.is_finite() || query.focal_mm <= 0.0 {
        return Err("A positive focal length is required to match a profile".into());
    }
    let target = target_axes(query);
    let crop = matched.camera.crop;
    let lens = matched.lens;
    let (aperture, focus) = (
        target[1].unwrap_or(0.0),
        target[2].map(|v| 1.0 / v).unwrap_or(INFINITY_M),
    );
    let empty = || Calibration {
        distortion: None,
        ca: None,
        vignette: None,
        mean_error: 0.0,
    };
    let mut records = Vec::new();
    for (i, s) in lens.distortion.iter().enumerate() {
        let calibration = Calibration {
            distortion: Some(distortion(s, crop, width, height)),
            ..empty()
        };
        records.push(Record::lensfun(i, s.focal, aperture, focus, calibration));
    }
    let base = records.len();
    for (i, s) in lens.tca.iter().enumerate() {
        let calibration = Calibration {
            ca: Some(chromatic(s, crop, width, height)),
            ..empty()
        };
        records.push(Record::lensfun(
            base + i,
            s.focal,
            aperture,
            focus,
            calibration,
        ));
    }
    let base = records.len();
    let mut unsupported = Vec::new();
    for (i, s) in lens.vignetting.iter().enumerate() {
        let v = vignette(s, crop, width, height);
        // A polynomial fitted on a smaller or squarer frame can cross zero
        // before this sensor's corners; that sample cannot serve this shot.
        let corners = [
            [0.0, 0.0],
            [width - 1.0, 0.0],
            [0.0, height - 1.0],
            [width - 1.0, height - 1.0],
        ];
        if corners.iter().any(|c| v.gain(width, height, *c).is_none()) {
            unsupported.push(format!(
                "Vignetting sample {}mm f/{} does not cover this frame's corners",
                s.focal, s.aperture
            ));
            continue;
        }
        let calibration = Calibration {
            vignette: Some(v),
            ..empty()
        };
        let apex = 2.0 * s.aperture.log2();
        records.push(Record::lensfun(
            base + i,
            s.focal,
            apex,
            s.distance,
            calibration,
        ));
    }
    if records.is_empty() {
        return Err("The bundled lens carries no usable calibration".into());
    }
    resolve_records(
        records,
        target,
        unsupported,
        Source::Lensfun {
            maker: lens.maker.clone(),
            model: lens.model.clone(),
            db_version: format!("{} ({})", db.version.commit, db.version.date),
        },
    )
}
