//! One source identity for the fixed calibration experiment (#3955).
use crate::{
    color::{dcp, illuminant::Illuminant, profile_loader},
    error::{Error, Result},
    image::{CfaPattern, CropRect, RawImage},
    math::Matrix3,
    types::accepted_removal::{ContentDigest, SourceAnchor},
};

/// Bump when decoder/calibration/prefix semantics of this fixed plate change.
/// This is deliberately separate from the display-output epoch: a view or
/// creative-grade update must not invalidate the source plate.
const CALIBRATION_ANCHOR_REVISION: u32 = 1;

fn matrix_inputs(
    matrices: &std::collections::HashMap<Illuminant, Matrix3>,
) -> Vec<(String, [[u32; 3]; 3])> {
    let mut values: Vec<_> = matrices
        .iter()
        .map(|(illuminant, matrix)| {
            let key = match illuminant {
                Illuminant::StdA => "a".into(),
                Illuminant::D50 => "d50".into(),
                Illuminant::D55 => "d55".into(),
                Illuminant::D65 => "d65".into(),
                Illuminant::Other(k) => format!("other:{k}"),
            };
            (key, matrix.0.map(|row| row.map(f32::to_bits)))
        })
        .collect();
    values.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    values
}

/// `original` must be the digest of bytes used to decode this retained RAW.
/// Hosts retain that digest at decode time; this entry performs no file I/O,
/// image rendering, or per-slider work. Hash recipe inputs, never rendered
/// pixels or computed CCT/matrices (whose transcendental rounding can differ
/// across targets). Original bytes bind the full embedded camera metadata.
pub fn removal_calibration_source_anchor(
    raw: &RawImage,
    original: &ContentDigest,
) -> Result<SourceAnchor> {
    original.validate().map_err(Error::Pipeline)?;
    if !raw.baseline_exposure.is_finite()
        || raw
            .as_shot_neutral
            .iter()
            .any(|v| !v.is_finite() || *v <= 0.0)
        || raw.as_shot_cct.is_some_and(|v| !v.is_finite() || v <= 0.0)
        || raw
            .color_matrices
            .values()
            .chain(raw.forward_matrices.values())
            .any(|matrix| matrix.0.iter().flatten().any(|v| !v.is_finite()))
    {
        return Err(Error::Pipeline(
            "removal source calibration metadata is invalid".into(),
        ));
    }
    let crop = raw
        .crop_rect
        .and_then(|c| CropRect::clamped(c.x, c.y, c.w, c.h, raw.width, raw.height))
        .unwrap_or(CropRect {
            x: 0,
            y: 0,
            w: raw.width,
            h: raw.height,
        });
    if crop.w == 0 || crop.h == 0 {
        return Err(Error::Pipeline(
            "removal source has no native pixels".into(),
        ));
    }
    let (profile, source) = dcp::profile_for_with_source(raw)?;
    super::removal_calibration::matrices(&profile)?;
    let calibration_source = match source {
        dcp::ProfileSource::EmbeddedFull { .. } => "embedded-full",
        dcp::ProfileSource::BundleConfident => "bundle",
        dcp::ProfileSource::EmbeddedCmOnly { .. } => "embedded-cm",
        dcp::ProfileSource::RawlerFallback => "fallback",
    };
    let cfa = match raw.cfa {
        CfaPattern::Rggb => serde_json::json!(["rggb"]),
        CfaPattern::Bggr => serde_json::json!(["bggr"]),
        CfaPattern::Grbg => serde_json::json!(["grbg"]),
        CfaPattern::Gbrg => serde_json::json!(["gbrg"]),
        CfaPattern::LinearRgb => serde_json::json!(["linear-rgb"]),
        CfaPattern::XTrans(pattern) => serde_json::json!(["xtrans", pattern.to_vec()]),
    };
    let active_area = raw
        .lens_metadata
        .active_area
        .map(|r| [r.left, r.top, r.width, r.height]);
    // Alias-table changes can choose a different profile without changing
    // profiles.bin. Bind the actual resolved key as well as the bundle bytes.
    let resolved_bundle = profile_loader::lookup_profile(raw).map(|p| &p.unique_camera_model);
    let recipe = serde_json::json!({
        "plate":"maple-removal-linear-calibration","revision":CALIBRATION_ANCHOR_REVISION,
        "profile_bundle":profile_loader::bundled_profile_version(),
        "resolved_bundle":resolved_bundle,
        "sensor":[raw.width,raw.height],"crop":[crop.x,crop.y,crop.w,crop.h],"cfa":cfa,
        "active_area":active_area,"black_level":raw.black_level,"white_level":raw.white_level,
        "as_shot_neutral":raw.as_shot_neutral.map(f32::to_bits),
        "as_shot_cct":raw.as_shot_cct.map(f32::to_bits),
        "baseline_exposure":raw.baseline_exposure.to_bits(),
        "camera":[raw.camera_make,raw.camera_model],"unique_camera_model":raw.unique_camera_model,
        "embedded_cm":matrix_inputs(&raw.color_matrices),"embedded_fm":matrix_inputs(&raw.forward_matrices),
        "calibration_source":calibration_source
    });
    let bytes = serde_json::to_vec(&recipe).map_err(|e| Error::Pipeline(e.to_string()))?;
    Ok(SourceAnchor {
        original: original.clone(),
        decode: ContentDigest::for_bytes(&bytes),
        width: crop.w,
        height: crop.h,
    })
}

#[cfg(test)]
#[path = "removal_calibration_anchor_tests.rs"]
mod tests;
