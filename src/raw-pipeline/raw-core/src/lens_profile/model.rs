//! Typed legacy LCP models. Newer/piecewise encodings remain inspectable but
//! cannot accidentally enter the renderer as a truncated polynomial (#2435).

use super::{LensModel, LensSample, CAMERA_NS};
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub focal: [f64; 2],
    pub center: [f64; 2],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Perspective {
    pub frame: Frame,
    pub radial: [f64; 3],
    pub tangential: [f64; 2],
    pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Vignette {
    pub frame: Frame,
    pub radial: [f64; 3],
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Chromatic {
    pub reference: Frame,
    pub relative: [Perspective; 2],
}

impl Chromatic {
    pub fn map(self, width: f64, height: f64, point: [f64; 2], channel: usize) -> [f64; 2] {
        if channel == 1 {
            return point;
        }
        let relative = self.relative[usize::from(channel == 2)];
        let normalized = self.reference.coordinates(width, height, point);
        relative
            .frame
            .pixels(width, height, relative.normalized(normalized))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Calibration {
    pub distortion: Option<Perspective>,
    /// Red/green and blue/green deviations; green is the reference plane.
    pub ca: Option<Chromatic>,
    pub vignette: Option<Vignette>,
    pub mean_error: f64,
}

impl Frame {
    /// LCP focal units are fractions of Dmax; centers are fractions of each
    /// dimension. Work in the unrotated calibration rectangle, before crop.
    pub fn coordinates(self, width: f64, height: f64, point: [f64; 2]) -> [f64; 2] {
        let maximum = width.max(height);
        [
            (point[0] - self.center[0] * width) / (self.focal[0] * maximum),
            (point[1] - self.center[1] * height) / (self.focal[1] * maximum),
        ]
    }

    pub fn pixels(self, width: f64, height: f64, point: [f64; 2]) -> [f64; 2] {
        let maximum = width.max(height);
        [
            point[0] * self.focal[0] * maximum + self.center[0] * width,
            point[1] * self.focal[1] * maximum + self.center[1] * height,
        ]
    }
}

impl Perspective {
    /// Brown–Conrady corrected-output to recorded-input coordinates. Unlike
    /// DNG's radius convention, this also supports unequal X/Y focal lengths.
    pub fn map(self, width: f64, height: f64, point: [f64; 2]) -> [f64; 2] {
        let normalized = self.frame.coordinates(width, height, point);
        self.frame
            .pixels(width, height, self.normalized(normalized))
    }

    fn normalized(self, [x, y]: [f64; 2]) -> [f64; 2] {
        let r2 = x * x + y * y;
        let [k1, k2, k3] = self.radial;
        let [p1, p2] = self.tangential;
        let radial = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3));
        [
            self.scale * (x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)),
            self.scale * (y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y),
        ]
    }
}

impl Vignette {
    /// LCP describes relative illumination. Correction is its reciprocal,
    /// not the forward attenuation polynomial or a truncated inverse series.
    pub fn gain(self, width: f64, height: f64, point: [f64; 2]) -> Option<f64> {
        let [x, y] = self.frame.coordinates(width, height, point);
        let r2 = x * x + y * y;
        let [k1, k2, k3] = self.radial;
        let illumination = 1.0 + r2 * (k1 + r2 * (k2 + r2 * k3));
        (illumination.is_finite() && illumination > 0.0).then(|| 1.0 / illumination)
    }
}

pub(super) fn calibration(sample: &LensSample) -> Result<Calibration, String> {
    let model = sample
        .models
        .iter()
        .find(|m| m.kind == "PerspectiveModel")
        .ok_or_else(|| "Only legacy PerspectiveModel calibration is supported".to_owned())?;
    if sample.models.len() != 1 || sample.models.iter().any(|m| m.kind != "PerspectiveModel") {
        return Err("Mixed or newer optical models are not supported".into());
    }
    let (props, children) = contents(model)?;
    reject_unknown(&props, PERSPECTIVE_FIELDS)?;
    let focal_mm = number(&sample.properties, "FocalLength", None)?;
    let sensor_factor = number(&sample.properties, "SensorFormatFactor", None)?;
    let fallback = focal_mm * sensor_factor / 35.0;
    let has_distortion = props
        .keys()
        .any(|key| PERSPECTIVE_FIELDS.contains(&key.as_str()));
    let distortion = has_distortion
        .then(|| perspective(&props, fallback))
        .transpose()?;
    let mut red = None;
    let mut green = None;
    let mut blue = None;
    let mut vignette = None;
    let mut seen = std::collections::BTreeSet::new();
    for child in children {
        if !seen.insert(&child.kind) {
            return Err(format!("Duplicate optical model {}", child.kind));
        }
        let (values, nested) = contents(child)?;
        if !nested.is_empty() {
            return Err(format!("Nested {} encoding is not supported", child.kind));
        }
        match child.kind.as_str() {
            "ChromaticRedGreenModel" => red = Some(perspective(&values, fallback)?),
            "ChromaticBlueGreenModel" => blue = Some(perspective(&values, fallback)?),
            // Green's distortion model is not applied a second time. Relative
            // red/blue models operate on the already distorted coordinates.
            "ChromaticGreenModel" => green = Some(perspective(&values, fallback)?.frame),
            "VignetteModel" => {
                reject_unknown(&values, VIGNETTE_FIELDS)?;
                vignette = Some(Vignette {
                    frame: frame(&values, fallback)?,
                    radial: coefficients(&values, "VignetteModelParam")?,
                });
            }
            _ => return Err(format!("Unsupported optical model {}", child.kind)),
        }
    }
    let ca = match (red, green, blue) {
        (Some(r), Some(g), Some(b)) => Some(Chromatic {
            reference: g,
            relative: [r, b],
        }),
        (None, None, None) => None,
        _ => return Err("Incomplete chromatic-aberration calibration".into()),
    };
    if distortion.is_none() && ca.is_none() && vignette.is_none() {
        return Err("No supported optical coefficients".into());
    }
    let mean_error = number(&props, "ResidualMeanError", Some(f64::MAX))?;
    if mean_error < 0.0 {
        return Err("ResidualMeanError cannot be negative".into());
    }
    Ok(Calibration {
        distortion,
        ca,
        vignette,
        mean_error,
    })
}

fn contents(model: &LensModel) -> Result<(BTreeMap<String, String>, Vec<&LensModel>), String> {
    if model.namespace != CAMERA_NS {
        return Err("Optical model has the wrong namespace".into());
    }
    let mut values = model.properties.clone();
    let mut children = Vec::new();
    for child in &model.children {
        if child.kind == "Description"
            && child.namespace == "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
        {
            for (key, value) in &child.properties {
                if values
                    .insert(key.clone(), value.clone())
                    .is_some_and(|old| old != *value)
                {
                    return Err(format!("Conflicting optical property {key}"));
                }
            }
            children.extend(&child.children);
        } else {
            children.push(child);
        }
    }
    if let Some(version) = values.get("Version") {
        if version != "1" && version != "2" {
            return Err(format!("Unsupported {} version {version}", model.kind));
        }
    }
    Ok((values, children))
}

const FRAME_FIELDS: &[&str] = &[
    "Version",
    "FocalLengthX",
    "FocalLengthY",
    "ImageXCenter",
    "ImageYCenter",
    "ResidualMeanError",
    "ResidualStandardDeviation",
];
const PERSPECTIVE_FIELDS: &[&str] = &[
    "RadialDistortParam1",
    "RadialDistortParam2",
    "RadialDistortParam3",
    "TangentialDistortParam1",
    "TangentialDistortParam2",
    "ScaleFactor",
];
const VIGNETTE_FIELDS: &[&str] = &[
    "VignetteModelParam1",
    "VignetteModelParam2",
    "VignetteModelParam3",
];

fn reject_unknown(values: &BTreeMap<String, String>, family: &[&str]) -> Result<(), String> {
    if let Some(key) = values
        .keys()
        .find(|key| !FRAME_FIELDS.contains(&key.as_str()) && !family.contains(&key.as_str()))
    {
        return Err(format!("Unsupported optical parameter {key}"));
    }
    Ok(())
}

fn perspective(values: &BTreeMap<String, String>, fallback: f64) -> Result<Perspective, String> {
    reject_unknown(values, PERSPECTIVE_FIELDS)?;
    let scale = number(values, "ScaleFactor", Some(1.0))?;
    if scale <= 0.0 {
        return Err("ScaleFactor must be positive".into());
    }
    Ok(Perspective {
        frame: frame(values, fallback)?,
        radial: coefficients(values, "RadialDistortParam")?,
        tangential: [
            number(values, "TangentialDistortParam1", Some(0.0))?,
            number(values, "TangentialDistortParam2", Some(0.0))?,
        ],
        scale,
    })
}

fn frame(values: &BTreeMap<String, String>, fallback: f64) -> Result<Frame, String> {
    let focal = [
        number(values, "FocalLengthX", Some(fallback))?,
        number(values, "FocalLengthY", Some(fallback))?,
    ];
    let center = [
        number(values, "ImageXCenter", Some(0.5))?,
        number(values, "ImageYCenter", Some(0.5))?,
    ];
    if focal.iter().any(|f| *f <= 0.0) || center.iter().any(|c| !(0.0..=1.0).contains(c)) {
        return Err("Invalid optical focal length or center".into());
    }
    Ok(Frame { focal, center })
}

fn coefficients(values: &BTreeMap<String, String>, prefix: &str) -> Result<[f64; 3], String> {
    Ok([
        number(values, &format!("{prefix}1"), Some(0.0))?,
        number(values, &format!("{prefix}2"), Some(0.0))?,
        number(values, &format!("{prefix}3"), Some(0.0))?,
    ])
}

pub(super) fn number(
    values: &BTreeMap<String, String>,
    key: &str,
    fallback: Option<f64>,
) -> Result<f64, String> {
    let value = match values.get(key) {
        Some(value) => value.parse::<f64>().map_err(|_| format!("Invalid {key}"))?,
        None => fallback.ok_or_else(|| format!("Missing {key}"))?,
    };
    if value.is_finite() {
        Ok(value)
    } else {
        Err(format!("Non-finite {key}"))
    }
}
