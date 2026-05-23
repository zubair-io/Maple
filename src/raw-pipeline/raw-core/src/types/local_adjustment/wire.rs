//! Wire format for `LocalAdjustment` in XMP sidecars (Slice 1 of #280).
//!
//! Slice 1 ships a single XMP attribute `papp:LocalAdjustments` whose value
//! is compact JSON: an array of `{mask, adjustments}` objects. We use
//! `serde_json::Value` directly (no `Serialize`/`Deserialize` derives on the
//! schema types) to keep the `types` module free of serde plumbing.
//!
//! **Long-run goal:** switch to canonical `crs:GradientBasedCorrections` +
//! `crs:CircularGradientBasedCorrections` nested-RDF form. That requires
//! extending the attribute-only XMP walker (`xmp::parse`) to track `Bag` /
//! `li` state — a separate slice. Because no UI ships in Slice 1, no
//! user-authored sidecars exist yet, so this format can be revised without
//! breaking compat.

use super::{LocalAdjustment, Mask, PartialAdjustments, Point2};
use serde_json::{json, Value};

/// Encode `layers` to a JSON string suitable for use as the
/// `papp:LocalAdjustments` attribute value. Empty `layers` produces `"[]"`.
pub fn encode_local_adjustments(layers: &[LocalAdjustment]) -> String {
    let arr: Vec<Value> = layers.iter().map(layer_to_json).collect();
    Value::Array(arr).to_string()
}

/// Decode a `papp:LocalAdjustments` JSON string back into a `Vec`. Unknown
/// keys are silently ignored (forward-compat). Missing or malformed mask
/// fields return an error so corrupt sidecars don't silently lose layers.
pub fn decode_local_adjustments(s: &str) -> Result<Vec<LocalAdjustment>, String> {
    let v: Value = serde_json::from_str(s).map_err(|e| format!("invalid JSON: {e}"))?;
    let arr = v
        .as_array()
        .ok_or_else(|| "LocalAdjustments wire format must be a JSON array".to_string())?;
    arr.iter().map(layer_from_json).collect()
}

fn layer_to_json(l: &LocalAdjustment) -> Value {
    json!({
        "mask": mask_to_json(&l.mask),
        "adjustments": adjustments_to_json(&l.adjustments),
    })
}

fn layer_from_json(v: &Value) -> Result<LocalAdjustment, String> {
    let obj = v.as_object().ok_or_else(|| "layer must be an object".to_string())?;
    let mask = mask_from_json(
        obj.get("mask")
            .ok_or_else(|| "layer missing `mask`".to_string())?,
    )?;
    let adjustments = adjustments_from_json(
        obj.get("adjustments")
            .ok_or_else(|| "layer missing `adjustments`".to_string())?,
    )?;
    Ok(LocalAdjustment { mask, adjustments })
}

fn mask_to_json(m: &Mask) -> Value {
    match *m {
        Mask::Linear {
            start,
            end,
            feather,
        } => json!({
            "type": "linear",
            "start": [start.x, start.y],
            "end": [end.x, end.y],
            "feather": feather,
        }),
        Mask::Radial {
            center,
            radii,
            angle,
            feather,
            invert,
        } => json!({
            "type": "radial",
            "center": [center.x, center.y],
            "radii": [radii.x, radii.y],
            "angle": angle,
            "feather": feather,
            "invert": invert,
        }),
    }
}

fn mask_from_json(v: &Value) -> Result<Mask, String> {
    let obj = v.as_object().ok_or_else(|| "mask must be an object".to_string())?;
    let ty = obj
        .get("type")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "mask missing `type`".to_string())?;
    match ty {
        "linear" => Ok(Mask::Linear {
            start: point_from_json(obj.get("start"), "start")?,
            end: point_from_json(obj.get("end"), "end")?,
            feather: f32_from_json(obj.get("feather"), "feather")?,
        }),
        "radial" => Ok(Mask::Radial {
            center: point_from_json(obj.get("center"), "center")?,
            radii: point_from_json(obj.get("radii"), "radii")?,
            angle: f32_from_json(obj.get("angle"), "angle")?,
            feather: f32_from_json(obj.get("feather"), "feather")?,
            invert: obj
                .get("invert")
                .and_then(|x| x.as_bool())
                .unwrap_or(false),
        }),
        other => Err(format!("unknown mask type: {other}")),
    }
}

fn point_from_json(v: Option<&Value>, name: &str) -> Result<Point2, String> {
    let arr = v
        .and_then(|x| x.as_array())
        .ok_or_else(|| format!("mask field `{name}` must be a [x, y] array"))?;
    if arr.len() != 2 {
        return Err(format!("mask field `{name}` must have exactly 2 elements"));
    }
    let x = arr[0]
        .as_f64()
        .ok_or_else(|| format!("mask field `{name}`[0] must be numeric"))? as f32;
    let y = arr[1]
        .as_f64()
        .ok_or_else(|| format!("mask field `{name}`[1] must be numeric"))? as f32;
    Ok(Point2::new(x, y))
}

fn f32_from_json(v: Option<&Value>, name: &str) -> Result<f32, String> {
    v.and_then(|x| x.as_f64())
        .map(|x| x as f32)
        .ok_or_else(|| format!("mask field `{name}` must be numeric"))
}

fn adjustments_to_json(a: &PartialAdjustments) -> Value {
    let mut obj = serde_json::Map::new();
    if let Some(v) = a.exposure {
        obj.insert("exposure".into(), json!(v));
    }
    if let Some(v) = a.contrast {
        obj.insert("contrast".into(), json!(v));
    }
    if let Some(v) = a.highlights {
        obj.insert("highlights".into(), json!(v));
    }
    if let Some(v) = a.shadows {
        obj.insert("shadows".into(), json!(v));
    }
    if let Some(v) = a.whites {
        obj.insert("whites".into(), json!(v));
    }
    if let Some(v) = a.blacks {
        obj.insert("blacks".into(), json!(v));
    }
    if let Some(v) = a.saturation {
        obj.insert("saturation".into(), json!(v));
    }
    if let Some(v) = a.vibrance {
        obj.insert("vibrance".into(), json!(v));
    }
    if let Some(v) = a.temperature {
        obj.insert("temperature".into(), json!(v));
    }
    if let Some(v) = a.tint {
        obj.insert("tint".into(), json!(v));
    }
    Value::Object(obj)
}

fn adjustments_from_json(v: &Value) -> Result<PartialAdjustments, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| "adjustments must be an object".to_string())?;
    let g = |k: &str| -> Result<Option<f32>, String> {
        match obj.get(k) {
            Some(x) => x
                .as_f64()
                .map(|v| Some(v as f32))
                .ok_or_else(|| format!("adjustment `{k}` must be numeric")),
            None => Ok(None),
        }
    };
    Ok(PartialAdjustments {
        exposure: g("exposure")?,
        contrast: g("contrast")?,
        highlights: g("highlights")?,
        shadows: g("shadows")?,
        whites: g("whites")?,
        blacks: g("blacks")?,
        saturation: g("saturation")?,
        vibrance: g("vibrance")?,
        temperature: g("temperature")?,
        tint: g("tint")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_empty_layers_is_empty_array() {
        assert_eq!(encode_local_adjustments(&[]), "[]");
    }

    #[test]
    fn decode_empty_array_is_empty_vec() {
        let v = decode_local_adjustments("[]").unwrap();
        assert!(v.is_empty());
    }

    #[test]
    fn round_trip_linear_mask() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Linear {
                start: Point2::new(0.1, 0.2),
                end: Point2::new(0.8, 0.9),
                feather: 0.4,
            },
            adjustments: PartialAdjustments {
                exposure: Some(1.5),
                shadows: Some(-25.0),
                ..Default::default()
            },
        }];
        let encoded = encode_local_adjustments(&layers);
        let decoded = decode_local_adjustments(&encoded).unwrap();
        assert_eq!(decoded, layers, "linear-mask layer must round-trip");
    }

    #[test]
    fn round_trip_radial_mask() {
        let layers = vec![LocalAdjustment {
            mask: Mask::Radial {
                center: Point2::new(0.5, 0.5),
                radii: Point2::new(0.3, 0.2),
                angle: 1.5,
                feather: 0.6,
                invert: true,
            },
            adjustments: PartialAdjustments {
                exposure: Some(-0.7),
                temperature: Some(200.0),
                ..Default::default()
            },
        }];
        let encoded = encode_local_adjustments(&layers);
        let decoded = decode_local_adjustments(&encoded).unwrap();
        assert_eq!(decoded, layers, "radial-mask layer must round-trip");
    }

    #[test]
    fn round_trip_multi_layer() {
        let layers = vec![
            LocalAdjustment::linear(
                Point2::new(0.0, 0.0),
                Point2::new(1.0, 0.0),
                PartialAdjustments {
                    exposure: Some(1.0),
                    ..Default::default()
                },
            ),
            LocalAdjustment::radial(
                Point2::new(0.5, 0.5),
                Point2::new(0.2, 0.2),
                PartialAdjustments {
                    exposure: Some(-1.0),
                    ..Default::default()
                },
            ),
        ];
        let encoded = encode_local_adjustments(&layers);
        let decoded = decode_local_adjustments(&encoded).unwrap();
        assert_eq!(decoded, layers);
    }

    #[test]
    fn decode_unknown_mask_type_errors() {
        let bad = r#"[{"mask":{"type":"brush"},"adjustments":{}}]"#;
        assert!(decode_local_adjustments(bad).is_err());
    }

    #[test]
    fn decode_missing_mask_field_errors() {
        let bad = r#"[{"adjustments":{}}]"#;
        assert!(decode_local_adjustments(bad).is_err());
    }

    #[test]
    fn decode_silently_accepts_unknown_adjustment_keys() {
        // Forward-compat: unknown keys must not error.
        let s = r#"[{"mask":{"type":"linear","start":[0,0],"end":[1,0],"feather":0},"adjustments":{"exposure":1.0,"futureSlider":42}}]"#;
        let v = decode_local_adjustments(s).unwrap();
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].adjustments.exposure, Some(1.0));
    }
}
