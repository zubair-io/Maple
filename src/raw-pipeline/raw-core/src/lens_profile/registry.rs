//! Content-addressed process cache. Hosts persist imported bytes and reload
//! them before opening a sidecar; no proprietary profile pack is bundled.

use super::{LensProfile, LensQuery, Resolution};
use crate::{
    pipeline::pano::opcode_apply::{scale_active_area, LensCorrectionScales},
    pipeline::pano::opcodes::ActiveAreaRect,
    AdjustmentModel, Image, RawImage,
};
use std::{
    collections::BTreeMap,
    sync::{Arc, OnceLock, RwLock},
};

const MAX_CACHE_BYTES: usize = 64 * 1024 * 1024;
static CACHE: OnceLock<RwLock<BTreeMap<String, (usize, Arc<LensProfile>)>>> = OnceLock::new();

fn cache() -> &'static RwLock<BTreeMap<String, (usize, Arc<LensProfile>)>> {
    CACHE.get_or_init(|| RwLock::new(BTreeMap::new()))
}

/// `lcp1` pins both the exact document bytes and Maple's interpretation
/// version. `-ack` is a sidecar record of explicit approximation acceptance.
pub fn profile_id(reference: &str) -> Result<(&str, bool), String> {
    let (id, acknowledged) = if let Some(id) = reference.strip_prefix("lcp1:") {
        (id, false)
    } else if let Some(id) = reference.strip_prefix("lcp1-ack:") {
        (id, true)
    } else {
        return Err("Unsupported LCP reference version".into());
    };
    if id.len() != 64
        || !id
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
    {
        return Err("Invalid LCP content digest".into());
    }
    Ok((id, acknowledged))
}

/// Register user-owned LCP bytes in this process. Returns the canonical
/// exact-match reference and human-readable inventory for the import UI.
pub fn register(xml: &str) -> Result<serde_json::Value, String> {
    let id = blake3::hash(xml.as_bytes()).to_hex().to_string();
    let profile = Arc::new(super::parse(xml)?);
    let mut registry = cache().write().map_err(|_| "LCP cache lock failed")?;
    if !registry.contains_key(&id) {
        if registry.values().map(|(bytes, _)| bytes).sum::<usize>() + xml.len() > MAX_CACHE_BYTES {
            return Err("LCP session cache is full; reopen the image session".into());
        }
        registry.insert(id.clone(), (xml.len(), Arc::clone(&profile)));
    }
    let first = profile.samples.first().ok_or("LCP contains no samples")?;
    Ok(
        serde_json::json!({"version":1,"reference":format!("lcp1:{id}"),
        "make":first.properties.get("Make"),"camera":first.properties.get("Model"),
        "lens":first.properties.get("Lens"),"name":first.properties.get("ProfileName"),
        "sampleCount":profile.samples.len()}),
    )
}

pub fn resolve_for_raw(raw: &RawImage, reference: &str) -> Result<Option<Resolution>, String> {
    // Authored embedded corrections win even when the sidecar also names an
    // imported profile. They must never be compounded with an external warp.
    if reference.is_empty() || raw.opcode_list3.is_some() {
        return Ok(None);
    }
    let (id, _) = profile_id(reference)?;
    let profile = cache()
        .read()
        .map_err(|_| "LCP cache lock failed")?
        .get(id)
        .map(|(_, profile)| Arc::clone(profile))
        .ok_or(
            "The sidecar's LCP profile is not in the local cache; import the original profile",
        )?;
    let query = LensQuery {
        make: raw
            .lens_metadata
            .camera_make
            .as_deref()
            .unwrap_or(&raw.camera_make),
        camera: raw
            .lens_metadata
            .camera_model
            .as_deref()
            .unwrap_or(&raw.camera_model),
        lens: raw.lens_metadata.lens_model.as_deref().unwrap_or(""),
        focal_mm: raw.focal_length.unwrap_or(0.0) as f64,
        f_number: raw.aperture.map(f64::from),
        focus_m: raw.lens_metadata.focus_m,
    };
    let mut resolution = profile.resolve(&query)?;
    let area = raw
        .lens_metadata
        .active_area
        .unwrap_or(ActiveAreaRect::full(raw.width, raw.height));
    for sample in resolution
        .distortion_samples
        .iter()
        .chain(&resolution.ca_samples)
        .chain(&resolution.vignette_samples)
    {
        let properties = &profile.samples[sample.index].properties;
        if let (Ok(w), Ok(h)) = (
            super::model::number(properties, "ImageWidth", None),
            super::model::number(properties, "ImageLength", None),
        ) {
            if w <= 0.0 || h <= 0.0 || area.height == 0 {
                return Err("Invalid LCP calibration image dimensions".into());
            }
            let aspect_distance = ((w / h) / (area.width as f64 / area.height as f64) - 1.0).abs();
            if aspect_distance > 0.005 {
                resolution.approximations.push(format!(
                    "Calibration aspect differs from sensor active area by {:.2}%",
                    aspect_distance * 100.0
                ));
            }
        } else {
            resolution
                .approximations
                .push("Calibration image dimensions are missing".into());
        }
    }
    resolution.approximations.sort();
    resolution.approximations.dedup();
    Ok(Some(resolution))
}

/// Shared CPU/GPU decode entry, after demosaic and before default crop. The
/// caller handles OpcodeList3 first; the guard here independently enforces it.
pub fn apply_for_raw(
    raw: &RawImage,
    model: &AdjustmentModel,
    image: &mut Image,
    sensor_scale: f32,
) -> crate::Result<()> {
    let scales = LensCorrectionScales::from_model(model);
    if scales == LensCorrectionScales::NONE {
        return Ok(());
    }
    let Some(resolution) =
        resolve_for_raw(raw, &model.lens_profile).map_err(crate::Error::Pipeline)?
    else {
        return Ok(());
    };
    if !resolution.approximations.is_empty()
        && !profile_id(&model.lens_profile)
            .map_err(crate::Error::Pipeline)?
            .1
    {
        return Err(crate::Error::Pipeline(format!(
            "LCP approximation requires acknowledgement: {}",
            resolution.approximations.join("; ")
        )));
    }
    let area = raw
        .lens_metadata
        .active_area
        .unwrap_or(ActiveAreaRect::full(raw.width, raw.height));
    let scaled = scale_active_area(area, sensor_scale, image.width, image.height);
    super::apply(image, &resolution.calibration, scaled, scales).map_err(crate::Error::Pipeline)
}

impl Resolution {
    pub fn metadata(&self) -> serde_json::Value {
        let samples = |entries: &[super::SampleWeight]| {
            entries.iter().map(|s| serde_json::json!({
            "index":s.index,"weight":s.weight,"focalMm":s.focal_mm,"apertureApex":s.aperture_apex,"focusM":s.focus_m,
        })).collect::<Vec<_>>()
        };
        serde_json::json!({"source":"lcp","confidence":if self.approximations.is_empty() {"in-range"} else {"approximate"},
            "approximations":self.approximations,"unsupported":self.unsupported,
            "distortion":samples(&self.distortion_samples),"ca":samples(&self.ca_samples),"vignetting":samples(&self.vignette_samples)})
    }
}
