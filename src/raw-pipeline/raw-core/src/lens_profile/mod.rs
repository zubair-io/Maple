//! Imported LCP parsing, deterministic matching, and optical correction (#2435).
//!
//! A profile is calibration input, not permission to apply an approximate
//! match. Keep every sample and model, including duplicate calibration keys.
//! Only verified legacy model forms enter the decode stage. Distribution of
//! third-party calibration packs remains separate from user-owned imports.

pub mod model;
mod resolve;
mod xml;
pub use resolve::{LensQuery, Resolution, SampleWeight};
mod apply;
pub use apply::apply;
mod registry;
pub use registry::{
    apply_for_raw, clear_cache, embedded_metadata, profile_id, register, resolve_for_raw,
};

pub fn corrections_enabled(model: &crate::AdjustmentModel) -> bool {
    use crate::pipeline::pano::opcode_apply::LensCorrectionScales;
    LensCorrectionScales::from_model(model) != LensCorrectionScales::NONE
}

/// Lens EXIF and calibration frame captured during the original RAW decode.
#[derive(Clone, Debug, Default)]
pub struct LensMetadata {
    pub camera_make: Option<String>,
    pub camera_model: Option<String>,
    pub lens_model: Option<String>,
    pub focus_m: Option<f64>,
    pub active_area: Option<crate::pipeline::pano::opcodes::ActiveAreaRect>,
}

use std::collections::BTreeMap;

/// Adobe camera-profile namespace, independent of the chosen XML prefix.
pub const CAMERA_NS: &str = "http://ns.adobe.com/photoshop/1.0/camera-profile";

#[derive(Clone, Debug, PartialEq)]
pub struct LensProfile {
    pub samples: Vec<LensSample>,
}

/// Properties retain their authored spelling/value, including unknown model
/// parameters. Inspecting a newer profile must not silently erase its terms.
#[derive(Clone, Debug, PartialEq)]
pub struct LensSample {
    pub properties: BTreeMap<String, String>,
    pub models: Vec<LensModel>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct LensModel {
    pub namespace: String,
    pub kind: String,
    pub text: String,
    pub properties: BTreeMap<String, String>,
    pub children: Vec<LensModel>,
}

/// Parse one bounded document, supporting attribute and element LCP encodings.
/// The caller owns filesystem access; this also works on browser-owned bytes.
pub fn parse(xml: &str) -> Result<LensProfile, String> {
    xml::parse(xml)
}

impl LensProfile {
    /// Diagnostic JSON only. Authored model parameters are not renderer-ready
    /// coefficients, and no sample is selected or interpolated by inspection.
    pub fn inspection(&self) -> serde_json::Value {
        serde_json::json!({
            "inspectionVersion": 1,
            "sampleCount": self.samples.len(),
            "samples": self.samples.iter().map(|s| serde_json::json!({
                "properties": s.properties,
                "models": s.models.iter().map(LensModel::inspection).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
        })
    }
}

impl LensModel {
    fn inspection(&self) -> serde_json::Value {
        serde_json::json!({
            "namespace": self.namespace,
            "kind": self.kind,
            "text": self.text,
            "properties": self.properties,
            "children": self.children.iter().map(Self::inspection).collect::<Vec<_>>(),
        })
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_registry;
#[cfg(test)]
mod tests_resolve;
