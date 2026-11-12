//! The layer form Kotlin edits: raw-core's `LocalAdjustment` for the shapes
//! Android authors (linear, radial and their ordered groups), as JSON.
//! Every value is raw-core's own; this module only names the fields.
use raw_core::types::local_adjustment::controls::LOCAL_CONTROLS;
use raw_core::types::{
    LocalAdjustment, Mask, MaskCombine, MaskComponent, MaskGroup, PartialAdjustments, Point2,
    RangeRefinement,
};
use serde_json::{json, Map, Value};

/// A layer plus where its XML came from: `slot` indexes the source
/// corrections of the document it was read from, and `sources[i]` the
/// source mask leaf of component `i`, so unknown metadata travels with it.
#[derive(Clone, Debug, PartialEq)]
pub struct AuthoredLayer {
    pub layer: LocalAdjustment,
    pub slot: Option<usize>,
    pub sources: Vec<Option<usize>>,
}

pub fn authorable(mask: &Mask) -> bool {
    match mask {
        Mask::Linear { .. } | Mask::Radial { .. } => true,
        Mask::Group(group) => {
            !group.components.is_empty()
                && group.components.iter().all(|component| {
                    matches!(component.mask(), Mask::Linear { .. } | Mask::Radial { .. })
                })
        }
        _ => false,
    }
}

fn adjustment_slot<'a>(a: &'a mut PartialAdjustments, name: &str) -> Option<&'a mut Option<f32>> {
    Some(match name {
        "exposure" => &mut a.exposure,
        "contrast" => &mut a.contrast,
        "highlights" => &mut a.highlights,
        "shadows" => &mut a.shadows,
        "whites" => &mut a.whites,
        "blacks" => &mut a.blacks,
        "hue" => &mut a.hue,
        "saturation" => &mut a.saturation,
        "vibrance" => &mut a.vibrance,
        "temperature" => &mut a.temperature,
        "tint" => &mut a.tint,
        "texture" => &mut a.texture,
        "clarity" => &mut a.clarity,
        "dehaze" => &mut a.dehaze,
        "sharpness" => &mut a.sharpness,
        "luminance_noise" => &mut a.luminance_noise,
        "defringe" => &mut a.defringe,
        _ => return None,
    })
}

fn point(p: Point2) -> Value {
    json!([p.x, p.y])
}

fn leaf_json(mask: &Mask) -> Value {
    match mask {
        Mask::Linear {
            start,
            end,
            feather,
        } => {
            json!({"kind": "linear", "start": point(*start), "end": point(*end), "feather": feather})
        }
        Mask::Radial {
            center,
            radii,
            angle,
            feather,
            invert,
        } => json!({"kind": "radial", "center": point(*center), "radii": point(*radii),
            "angle": angle, "feather": feather, "invert": invert}),
        _ => Value::Null,
    }
}

pub fn layer_json(layer: &AuthoredLayer) -> Value {
    let mask = match &layer.layer.mask {
        Mask::Group(group) => json!({
            "kind": "group",
            "opacity": group.opacity,
            "invert": group.invert,
            "components": group.components.iter().zip(&layer.sources).map(|(component, source)| json!({
                "combine": component.combine.name(),
                "invert": component.invert,
                "source": source,
                "mask": leaf_json(component.mask()),
            })).collect::<Vec<_>>(),
        }),
        leaf => leaf_json(leaf),
    };
    let mut adjustments = Map::new();
    let mut values = layer.layer.adjustments.clone();
    for control in LOCAL_CONTROLS {
        if let Some(Some(value)) = adjustment_slot(&mut values, control.name).map(|slot| *slot) {
            adjustments.insert(control.name.into(), json!(value));
        }
    }
    let range = layer.layer.range.map(|RangeRefinement::Color { hue_deg, hue_half_width_deg, chroma_min, l_min, l_max, feather }| json!({
        "hue_deg": hue_deg, "hue_half_width_deg": hue_half_width_deg, "chroma_min": chroma_min,
        "l_min": l_min, "l_max": l_max, "feather": feather,
    }));
    json!({"slot": layer.slot, "mask": mask, "adjustments": adjustments, "range": range})
}

fn number(value: &Value, key: &str) -> Result<f32, String> {
    let number = value
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("Mask layer is missing {key}"))? as f32;
    number
        .is_finite()
        .then_some(number)
        .ok_or_else(|| format!("Mask layer {key} is not finite"))
}

fn pair(value: &Value, key: &str) -> Result<Point2, String> {
    let pair = value
        .get(key)
        .and_then(Value::as_array)
        .filter(|pair| pair.len() == 2);
    let read = |index: usize| {
        pair.and_then(|pair| pair[index].as_f64())
            .map(|v| v as f32)
            .filter(|v| v.is_finite())
            .ok_or_else(|| format!("Mask layer {key} is not a finite point"))
    };
    Ok(Point2::new(read(0)?, read(1)?))
}

fn flag(value: &Value, key: &str) -> Result<bool, String> {
    value
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("Mask layer is missing {key}"))
}

fn index(value: &Value, key: &str) -> Result<Option<usize>, String> {
    match value.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(raw) => raw
            .as_u64()
            .map(|v| Some(v as usize))
            .ok_or_else(|| format!("Mask layer {key} is not an index")),
    }
}

fn leaf_from_json(value: &Value) -> Result<Mask, String> {
    match value.get("kind").and_then(Value::as_str) {
        Some("linear") => Ok(Mask::Linear {
            start: pair(value, "start")?,
            end: pair(value, "end")?,
            feather: number(value, "feather")?,
        }),
        Some("radial") => Ok(Mask::Radial {
            center: pair(value, "center")?,
            radii: pair(value, "radii")?,
            angle: number(value, "angle")?,
            feather: number(value, "feather")?,
            invert: flag(value, "invert")?,
        }),
        other => Err(format!("Unsupported mask shape {other:?}")),
    }
}

pub fn layer_from_json(value: &Value) -> Result<AuthoredLayer, String> {
    let mask_value = value.get("mask").ok_or("Mask layer has no mask")?;
    let slot = index(value, "slot")?;
    let (mask, sources) = if mask_value.get("kind").and_then(Value::as_str) == Some("group") {
        let components = mask_value
            .get("components")
            .and_then(Value::as_array)
            .filter(|components| !components.is_empty())
            .ok_or("A mask group needs at least one component")?;
        let mut sources = Vec::with_capacity(components.len());
        let mut parts = Vec::with_capacity(components.len());
        for component in components {
            let combine = match component.get("combine").and_then(Value::as_str) {
                Some(name) => MaskCombine::ALL
                    .into_iter()
                    .find(|combine| combine.name() == name)
                    .ok_or_else(|| format!("Unknown combine mode {name}"))?,
                None => return Err("Mask component has no combine mode".into()),
            };
            let leaf = leaf_from_json(component.get("mask").ok_or("Mask component has no mask")?)?;
            parts.push(
                MaskComponent::new(leaf, combine, flag(component, "invert")?)
                    .ok_or("Unsupported mask component")?,
            );
            sources.push(index(component, "source")?);
        }
        let group = MaskGroup {
            components: parts,
            opacity: number(mask_value, "opacity")?,
            invert: flag(mask_value, "invert")?,
        };
        (Mask::Group(group), sources)
    } else {
        (leaf_from_json(mask_value)?, vec![slot.map(|_| 0)])
    };
    let mut adjustments = PartialAdjustments::default();
    if let Some(values) = value.get("adjustments").and_then(Value::as_object) {
        for (name, raw) in values {
            let slot = adjustment_slot(&mut adjustments, name)
                .ok_or_else(|| format!("Unknown local control {name}"))?;
            let v = raw.as_f64().map(|v| v as f32).filter(|v| v.is_finite());
            *slot = Some(v.ok_or_else(|| format!("Local control {name} is not finite"))?);
        }
    }
    let range = match value.get("range") {
        None | Some(Value::Null) => None,
        Some(range) => Some(RangeRefinement::Color {
            hue_deg: number(range, "hue_deg")?,
            hue_half_width_deg: number(range, "hue_half_width_deg")?,
            chroma_min: number(range, "chroma_min")?,
            l_min: number(range, "l_min")?,
            l_max: number(range, "l_max")?,
            feather: number(range, "feather")?,
        }),
    };
    Ok(AuthoredLayer {
        layer: LocalAdjustment {
            mask,
            range,
            adjustments,
        },
        slot,
        sources,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group() -> AuthoredLayer {
        AuthoredLayer {
            layer: LocalAdjustment {
                mask: Mask::Group(MaskGroup {
                    components: vec![
                        MaskComponent::new(
                            Mask::Linear {
                                start: Point2::new(0.1, 0.2),
                                end: Point2::new(0.3, 0.4),
                                feather: 0.25,
                            },
                            MaskCombine::Add,
                            false,
                        )
                        .unwrap(),
                        MaskComponent::new(
                            Mask::Radial {
                                center: Point2::new(0.5, 0.5),
                                radii: Point2::new(0.2, 0.1),
                                angle: 0.7,
                                feather: 0.4,
                                invert: true,
                            },
                            MaskCombine::Intersect,
                            true,
                        )
                        .unwrap(),
                    ],
                    opacity: 0.8,
                    invert: true,
                }),
                range: Some(raw_core::types::SKIN_TONE_RANGE),
                adjustments: PartialAdjustments {
                    exposure: Some(0.3),
                    luminance_noise: Some(12.5),
                    hue: Some(-7.0),
                    ..Default::default()
                },
            },
            slot: Some(4),
            sources: vec![Some(1), None],
        }
    }

    #[test]
    fn every_field_survives_the_json_round_trip_exactly() {
        let layer = group();
        let text = layer_json(&layer).to_string();
        let back = layer_from_json(&serde_json::from_str(&text).unwrap()).unwrap();
        assert_eq!(back, layer);
    }

    #[test]
    fn controls_table_names_every_partial_adjustment_field() {
        let mut values = PartialAdjustments::default();
        for control in LOCAL_CONTROLS {
            *adjustment_slot(&mut values, control.name).unwrap() = Some(1.0);
        }
        assert_eq!(
            values,
            PartialAdjustments {
                exposure: Some(1.0),
                contrast: Some(1.0),
                highlights: Some(1.0),
                shadows: Some(1.0),
                whites: Some(1.0),
                blacks: Some(1.0),
                saturation: Some(1.0),
                vibrance: Some(1.0),
                temperature: Some(1.0),
                tint: Some(1.0),
                hue: Some(1.0),
                texture: Some(1.0),
                clarity: Some(1.0),
                dehaze: Some(1.0),
                sharpness: Some(1.0),
                luminance_noise: Some(1.0),
                defringe: Some(1.0),
            }
        );
    }

    #[test]
    fn malformed_layers_are_refused_not_defaulted() {
        for bad in [
            json!({"mask": {"kind": "linear", "start": [0.1], "end": [0.2, 0.3], "feather": 0.5}}),
            json!({"mask": {"kind": "group", "opacity": 1, "invert": false, "components": []}}),
            json!({"mask": {"kind": "brush"}}),
            json!({"mask": {"kind": "radial", "center": [0.5, 0.5], "radii": [0.2, 0.2], "angle": 0, "feather": 0.5, "invert": false}, "adjustments": {"glow": 1}}),
        ] {
            assert!(layer_from_json(&bad).is_err(), "{bad}");
        }
        assert!(!authorable(&Mask::Everywhere));
    }
}
