//! Carrier for a baked synthetic-raw inpaint patch: scene-linear Rec.2020
//! pixels + a coverage (feather) mask, placed by normalized coordinates in the
//! full DefaultCrop image. Resolution-agnostic on purpose — the composite stage
//! resamples it onto whatever buffer size the render path is using
//! (viewport / full / tile). No I/O here (mirrors the `types` module contract).
//!
//! [`Removal`] is the small, persistable half: the mask region + a content-hash
//! reference to the baked patch asset + the bake-grade snapshot. It round-trips
//! through the XMP `papp:InpaintRemovals` attribute (compact JSON, tolerant
//! reader); the patch *pixels* never enter XMP — they live in
//! `.maple/inpaint/<patch_ref>.f16` (see `pipeline::patch_to_bytes`).

use serde_json::{json, Value};

/// A fixed-resolution inpaint patch in scene-linear Rec.2020.
#[derive(Clone, Debug, PartialEq)]
pub struct InpaintPatch {
    /// Patch native pixel dimensions.
    pub width: u32,
    pub height: u32,
    /// Top-left placement in normalized full-image coords, `[u, v]` in `[0, 1]`.
    pub origin: [f32; 2],
    /// Size in normalized full-image coords, `[du, dv]` in `(0, 1]`.
    pub extent: [f32; 2],
    /// Scene-linear Rec.2020 RGB, row-major, `len == width * height`.
    pub pixels: Vec<[f32; 3]>,
    /// Coverage / feather in `[0, 1]`, row-major, `len == width * height`.
    pub coverage: Vec<f32>,
}

impl InpaintPatch {
    /// True when dimensions are non-zero, extent positive, and both buffers
    /// have the declared length. A malformed patch is skipped by the compositor
    /// rather than panicking — a corrupt cache entry must not crash a render.
    pub fn is_valid(&self) -> bool {
        let n = (self.width as usize) * (self.height as usize);
        self.width > 0
            && self.height > 0
            && self.extent[0] > 0.0
            && self.extent[1] > 0.0
            && self.pixels.len() == n
            && self.coverage.len() == n
    }
}

/// Bake-time grade snapshot — the WB/exposure state the patch's inverse was
/// computed against. Needed to re-grade the composited patch coherently and to
/// regenerate it deterministically if the cached asset is evicted (design doc
/// §3c / §5).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BakeGrade {
    pub temperature: f32,
    pub tint: f32,
    pub exposure: f32,
}

/// Persisted metadata for one baked removal. Small enough to live in the
/// sidecar; the patch *pixels* do not (they are referenced by `patch_ref`).
#[derive(Clone, Debug, PartialEq)]
pub struct Removal {
    /// Removal region in normalized full-image coords: `[x, y, w, h]` in `[0, 1]`.
    pub region: [f32; 4],
    /// Content hash of the baked patch asset (e.g. `"blake3:…"`), resolving to
    /// `.maple/inpaint/<patch_ref>.f16`.
    pub patch_ref: String,
    /// Model identity the patch was generated with — part of the cache key and
    /// the deterministic-regeneration recipe.
    pub model_version: String,
    /// The grade the patch's inverse was baked against.
    pub bake: BakeGrade,
}

/// Encode removals to the `papp:InpaintRemovals` attribute value (compact JSON
/// array). Empty input produces `"[]"`.
pub fn encode_removals(removals: &[Removal]) -> String {
    let arr: Vec<Value> = removals.iter().map(removal_to_json).collect();
    Value::Array(arr).to_string()
}

/// Decode the `papp:InpaintRemovals` attribute. **Tolerant reader** (mirrors
/// `local_adjustment::decode_local_adjustments`): elements not tagged
/// `"kind":"removal"` are skipped (forward-compat for future kinds), and only a
/// recognized removal with a corrupt field returns `Err`.
pub fn decode_removals(s: &str) -> Result<Vec<Removal>, String> {
    let v: Value = serde_json::from_str(s).map_err(|e| format!("invalid JSON: {e}"))?;
    let arr = v
        .as_array()
        .ok_or_else(|| "InpaintRemovals wire format must be a JSON array".to_string())?;
    let mut out = Vec::with_capacity(arr.len());
    for el in arr {
        if let Some(r) = removal_from_json(el)? {
            out.push(r);
        }
    }
    Ok(out)
}

fn removal_to_json(r: &Removal) -> Value {
    json!({
        "schema": 2,
        "kind": "removal",
        "region": [r.region[0], r.region[1], r.region[2], r.region[3]],
        "patch": r.patch_ref,
        "model": r.model_version,
        "bake": { "temp": r.bake.temperature, "tint": r.bake.tint, "ev": r.bake.exposure },
    })
}

/// `Ok(Some)` = a recognized removal; `Ok(None)` = an element this build doesn't
/// recognize (skip); `Err` = a removal with a corrupt field (fail loudly).
fn removal_from_json(v: &Value) -> Result<Option<Removal>, String> {
    let obj = match v.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };
    if obj.get("kind").and_then(|x| x.as_str()) != Some("removal") {
        return Ok(None); // unknown element kind → skip
    }
    let region = region_from_json(obj.get("region"))?;
    let patch_ref = obj
        .get("patch")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "removal missing string `patch`".to_string())?
        .to_string();
    let model_version = obj
        .get("model")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "removal missing string `model`".to_string())?
        .to_string();
    let bake = bake_from_json(obj.get("bake"))?;
    Ok(Some(Removal {
        region,
        patch_ref,
        model_version,
        bake,
    }))
}

fn region_from_json(v: Option<&Value>) -> Result<[f32; 4], String> {
    let arr = v
        .and_then(|x| x.as_array())
        .ok_or_else(|| "removal `region` must be a [x, y, w, h] array".to_string())?;
    if arr.len() != 4 {
        return Err("removal `region` must have exactly 4 elements".to_string());
    }
    let mut out = [0.0f32; 4];
    for (i, e) in arr.iter().enumerate() {
        out[i] = e
            .as_f64()
            .ok_or_else(|| format!("removal region[{i}] must be numeric"))? as f32;
    }
    Ok(out)
}

fn bake_from_json(v: Option<&Value>) -> Result<BakeGrade, String> {
    let obj = v
        .and_then(|x| x.as_object())
        .ok_or_else(|| "removal `bake` must be an object".to_string())?;
    let g = |k: &str| -> Result<f32, String> {
        obj.get(k)
            .and_then(|x| x.as_f64())
            .map(|x| x as f32)
            .ok_or_else(|| format!("removal bake.{k} must be numeric"))
    };
    Ok(BakeGrade {
        temperature: g("temp")?,
        tint: g("tint")?,
        exposure: g("ev")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Removal {
        Removal {
            region: [0.25, 0.1, 0.5, 0.4],
            patch_ref: "blake3:deadbeef".to_string(),
            model_version: "lama-bigl-1".to_string(),
            bake: BakeGrade {
                temperature: 5500.0,
                tint: 4.0,
                exposure: 0.3,
            },
        }
    }

    #[test]
    fn encode_empty_is_empty_array() {
        assert_eq!(encode_removals(&[]), "[]");
    }

    #[test]
    fn round_trips_single_and_multi() {
        let one = sample();
        let mut two = sample();
        two.patch_ref = "blake3:cafe".to_string();
        two.region = [0.0, 0.0, 1.0, 1.0];
        let removals = vec![one, two];
        let encoded = encode_removals(&removals);
        let decoded = decode_removals(&encoded).unwrap();
        assert_eq!(decoded, removals);
    }

    #[test]
    fn decode_skips_unknown_kind_keeps_removal() {
        // A future element kind next to a valid removal must not drop the removal.
        let r = sample();
        let s = format!(
            r#"[{{"kind":"sky-replace","schema":9}},{}]"#,
            removal_to_json(&r)
        );
        let decoded = decode_removals(&s).unwrap();
        assert_eq!(decoded, vec![r]);
    }

    #[test]
    fn decode_skips_non_object_and_untagged() {
        let s = r#"[42, "x", {}, {"region":[0,0,1,1]}]"#;
        assert!(decode_removals(s).unwrap().is_empty());
    }

    #[test]
    fn decode_corrupt_removal_errors() {
        // Tagged as a removal but region is malformed → loud error, not skipped.
        let s = r#"[{"kind":"removal","region":[0,0,1],"patch":"x","model":"m","bake":{"temp":5500,"tint":0,"ev":0}}]"#;
        assert!(decode_removals(s).is_err());
    }

    #[test]
    fn decode_removal_missing_patch_errors() {
        let s = r#"[{"kind":"removal","region":[0,0,1,1],"model":"m","bake":{"temp":5500,"tint":0,"ev":0}}]"#;
        assert!(decode_removals(s).is_err());
    }
}
