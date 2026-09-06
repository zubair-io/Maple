//! Deterministic camera/lens matching and bounded interpolation (#2435).

use super::{
    model::{self, Calibration, Chromatic, Frame, Perspective, Vignette},
    LensProfile, LensSample,
};

#[derive(Clone, Debug)]
pub struct LensQuery<'a> {
    pub make: &'a str,
    pub camera: &'a str,
    pub lens: &'a str,
    pub focal_mm: f64,
    /// Photographic f-number, converted to the LCP ApertureValue APEX axis.
    pub f_number: Option<f64>,
    pub focus_m: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SampleWeight {
    pub index: usize,
    pub weight: f64,
    pub focal_mm: f64,
    pub aperture_apex: f64,
    pub focus_m: f64,
}

#[derive(Clone, Debug)]
pub struct Resolution {
    pub calibration: Calibration,
    /// Per-family evidence, since many profiles store separate sample sets.
    pub distortion_samples: Vec<SampleWeight>,
    pub ca_samples: Vec<SampleWeight>,
    pub vignette_samples: Vec<SampleWeight>,
    /// Nonempty means application requires explicit user acknowledgement.
    pub approximations: Vec<String>,
    /// Unsupported records remain visible even if another family is usable.
    pub unsupported: Vec<String>,
}

struct Record {
    index: usize,
    axes: [f64; 3],
    focal: f64,
    aperture: f64,
    focus: f64,
    calibration: Calibration,
    /// Stable authored content tie-break, independent of document order.
    key: String,
}

impl LensProfile {
    pub fn resolve(&self, query: &LensQuery<'_>) -> Result<Resolution, String> {
        if query.make.trim().is_empty()
            || query.camera.trim().is_empty()
            || query.lens.trim().is_empty()
        {
            return Err("Camera and lens identity are required to match a profile".into());
        }
        if !query.focal_mm.is_finite() || query.focal_mm <= 0.0 {
            return Err("A positive focal length is required to match a profile".into());
        }
        let mut records = Vec::new();
        let mut unsupported = Vec::new();
        for (index, sample) in self.samples.iter().enumerate() {
            if !matches(sample, query) {
                continue;
            }
            match Record::new(index, sample) {
                Ok(record) => records.push(record),
                Err(error) => unsupported.push(format!("Sample {index}: {error}")),
            }
        }
        if records.is_empty() {
            return Err(if unsupported.is_empty() {
                "No exact camera/lens RAW profile match".into()
            } else {
                unsupported.join("; ")
            });
        }
        let mut approximations = Vec::new();
        let positive = |v: Option<f64>| v.filter(|v| v.is_finite() && *v > 0.0);
        let target = [
            Some(query.focal_mm.ln()),
            positive(query.f_number).map(|v| 2.0 * v.log2()),
            positive(query.focus_m).map(|v| 1.0 / v),
        ];
        let distortion = select(&records, &target, 0, &mut approximations);
        let ca = select(&records, &target, 1, &mut approximations);
        let vignette = select(&records, &target, 2, &mut approximations);
        let calibration = Calibration {
            distortion: blend_perspective(&distortion, |r| r.calibration.distortion.unwrap()),
            ca: if ca.is_empty() {
                None
            } else {
                Some(Chromatic {
                    reference: blend_frame(&ca, |r| r.calibration.ca.unwrap().reference),
                    relative: std::array::from_fn(|channel| {
                        blend_perspective(&ca, |r| r.calibration.ca.unwrap().relative[channel])
                            .unwrap()
                    }),
                })
            },
            vignette: blend_vignette(&vignette),
            mean_error: distortion
                .iter()
                .chain(&ca)
                .chain(&vignette)
                .map(|(r, w)| r.calibration.mean_error * w)
                .fold(0.0, f64::max),
        };
        approximations.sort();
        approximations.dedup();
        Ok(Resolution {
            calibration,
            distortion_samples: evidence(&distortion),
            ca_samples: evidence(&ca),
            vignette_samples: evidence(&vignette),
            approximations,
            unsupported,
        })
    }
}

fn normalize(value: &str) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

fn matches(sample: &LensSample, query: &LensQuery<'_>) -> bool {
    let eq = |key: &str, expected: &str| {
        sample
            .properties
            .get(key)
            .is_some_and(|v| normalize(v) == normalize(expected))
    };
    eq("Make", query.make)
        && (eq("Model", query.camera) || eq("UniqueCameraModel", query.camera))
        && (eq("Lens", query.lens) || eq("LensPrettyName", query.lens))
        && sample
            .properties
            .get("CameraRawProfile")
            .is_some_and(|v| v.eq_ignore_ascii_case("true"))
}

impl Record {
    fn new(index: usize, sample: &LensSample) -> Result<Self, String> {
        let focal = model::number(&sample.properties, "FocalLength", None)?;
        let aperture = model::number(&sample.properties, "ApertureValue", None)?;
        let focus = model::number(&sample.properties, "FocusDistance", None)?;
        if focal <= 0.0 || focus <= 0.0 {
            return Err("Non-positive calibration distance".into());
        }
        Ok(Self {
            index,
            focal,
            aperture,
            focus,
            axes: [focal.ln(), aperture, 1.0 / focus],
            calibration: model::calibration(sample)?,
            key: format!("{sample:?}"),
        })
    }
}

fn select<'a>(
    records: &'a [Record],
    target: &[Option<f64>; 3],
    family: usize,
    approximations: &mut Vec<String>,
) -> Vec<(&'a Record, f64)> {
    let candidates = records
        .iter()
        .filter(|r| match family {
            0 => r.calibration.distortion.is_some(),
            1 => r.calibration.ca.is_some(),
            _ => r.calibration.vignette.is_some(),
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Vec::new();
    }
    // Vignetting depends on aperture; geometric and relative CA calibrations
    // use focal length and focus. Aperture ties select the best measured fit.
    let axes: &[usize] = if family == 2 { &[0, 1, 2] } else { &[0, 2] };
    let mut output = Vec::new();
    interpolate(
        &candidates,
        target,
        axes,
        1.0,
        family,
        approximations,
        &mut output,
    );
    output
}

fn interpolate<'a>(
    records: &[&'a Record],
    target: &[Option<f64>; 3],
    axes: &[usize],
    weight: f64,
    family: usize,
    approximations: &mut Vec<String>,
    output: &mut Vec<(&'a Record, f64)>,
) {
    let Some((&axis, remaining)) = axes.split_first() else {
        // Error first, then authored content; duplicate tuple ordering cannot
        // change rendered coefficients. No arithmetic averaging of repeats.
        let best = records
            .iter()
            .min_by(|a, b| {
                a.calibration
                    .mean_error
                    .total_cmp(&b.calibration.mean_error)
                    .then_with(|| a.key.cmp(&b.key))
            })
            .unwrap();
        output.push((best, weight));
        return;
    };
    let min = records
        .iter()
        .map(|r| r.axes[axis])
        .min_by(f64::total_cmp)
        .unwrap();
    let max = records
        .iter()
        .map(|r| r.axes[axis])
        .max_by(f64::total_cmp)
        .unwrap();
    let desired = target[axis].unwrap_or_else(|| {
        approximations.push(format!(
            "{}: missing {} metadata",
            family_name(family),
            axis_name(axis)
        ));
        // Longest focus distance is smallest reciprocal distance. This choice
        // is exposed as an approximation and never silently auto-applied.
        min
    });
    let clamped = desired.clamp(min, max);
    if (clamped - desired).abs() > 1e-9 {
        approximations.push(format!(
            "{}: {} outside calibrated range (distance {:.6})",
            family_name(family),
            axis_name(axis),
            (clamped - desired).abs()
        ));
    }
    let low = records
        .iter()
        .map(|r| r.axes[axis])
        .filter(|v| *v <= clamped)
        .max_by(f64::total_cmp)
        .unwrap();
    let high = records
        .iter()
        .map(|r| r.axes[axis])
        .filter(|v| *v >= clamped)
        .min_by(f64::total_cmp)
        .unwrap();
    for (value, fraction) in if low == high {
        vec![(low, 1.0)]
    } else {
        vec![
            (low, (high - clamped) / (high - low)),
            (high, (clamped - low) / (high - low)),
        ]
    } {
        let next = records
            .iter()
            .copied()
            .filter(|r| r.axes[axis] == value)
            .collect::<Vec<_>>();
        interpolate(
            &next,
            target,
            remaining,
            weight * fraction,
            family,
            approximations,
            output,
        );
    }
}

fn axis_name(axis: usize) -> &'static str {
    [
        "log focal length",
        "aperture APEX",
        "reciprocal focus distance",
    ][axis]
}
fn family_name(family: usize) -> &'static str {
    ["Distortion", "Chromatic aberration", "Vignetting"][family]
}

fn evidence(records: &[(&Record, f64)]) -> Vec<SampleWeight> {
    records
        .iter()
        .map(|(r, weight)| SampleWeight {
            index: r.index,
            weight: *weight,
            focal_mm: r.focal,
            aperture_apex: r.aperture,
            focus_m: r.focus,
        })
        .collect()
}

fn blend_frame(records: &[(&Record, f64)], get: impl Fn(&Record) -> Frame) -> Frame {
    Frame {
        focal: std::array::from_fn(|i| records.iter().map(|(r, w)| get(r).focal[i] * w).sum()),
        center: std::array::from_fn(|i| records.iter().map(|(r, w)| get(r).center[i] * w).sum()),
    }
}

fn blend_perspective(
    records: &[(&Record, f64)],
    get: impl Fn(&Record) -> Perspective,
) -> Option<Perspective> {
    if records.is_empty() {
        return None;
    }
    Some(Perspective {
        frame: blend_frame(records, |r| get(r).frame),
        radial: std::array::from_fn(|i| records.iter().map(|(r, w)| get(r).radial[i] * w).sum()),
        tangential: std::array::from_fn(|i| {
            records.iter().map(|(r, w)| get(r).tangential[i] * w).sum()
        }),
        scale: records.iter().map(|(r, w)| get(r).scale * w).sum(),
    })
}

fn blend_vignette(records: &[(&Record, f64)]) -> Option<Vignette> {
    if records.is_empty() {
        return None;
    }
    Some(Vignette {
        frame: blend_frame(records, |r| r.calibration.vignette.unwrap().frame),
        radial: std::array::from_fn(|i| {
            records
                .iter()
                .map(|(r, w)| r.calibration.vignette.unwrap().radial[i] * w)
                .sum()
        }),
    })
}
