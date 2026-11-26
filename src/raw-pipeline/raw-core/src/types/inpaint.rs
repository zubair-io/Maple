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
    /// Size in normalized full-image coords, `[du, dv]` in `(0, 1]`; the
    /// rectangle must stay inside the frame (`origin + extent <= 1` per axis).
    pub extent: [f32; 2],
    /// Scene-linear Rec.2020 RGB, row-major, `len == width * height`.
    pub pixels: Vec<[f32; 3]>,
    /// Coverage / feather in `[0, 1]`, row-major, `len == width * height`.
    pub coverage: Vec<f32>,
}

/// Why a patch's layout was refused.
#[derive(Clone, Copy, Debug, PartialEq, thiserror::Error)]
pub enum InpaintPatchError {
    #[error("inpaint patch: zero dimension {width}x{height}")]
    ZeroDimension { width: u32, height: u32 },
    #[error("inpaint patch: {width}x{height} overflows the sample count")]
    DimensionOverflow { width: u32, height: u32 },
    #[error("inpaint patch: {width}x{height} exceeds {MAX_PATCH_SIDE} samples on a side")]
    DimensionTooLarge { width: u32, height: u32 },
    #[error(
        "inpaint patch: origin {origin:?} extent {extent:?} is not a finite, non-empty rectangle inside the frame"
    )]
    Placement { origin: [f32; 2], extent: [f32; 2] },
    #[error("inpaint patch: {pixels} RGB and {coverage} coverage samples for {width}x{height}")]
    BufferLength {
        width: u32,
        height: u32,
        pixels: usize,
        coverage: usize,
    },
}

/// Longest side a patch may have. Beyond 2^24 an `f32` cannot represent every
/// sample index, so the compositor's `(w - 1) as f32` would round up to `w`.
pub(crate) const MAX_PATCH_SIDE: u32 = 1 << 24;

impl InpaintPatch {
    /// Constant-time layout check: non-zero dimensions, a finite placement
    /// inside the frame, and both buffers at the declared length. Sample
    /// values are checked where a patch crosses the byte codec
    /// (`pipeline::patch_to_bytes` / `pipeline::patch_from_bytes`), not here.
    pub fn check_layout(&self) -> Result<(), InpaintPatchError> {
        let samples = patch_sample_count(self.width, self.height, self.origin, self.extent)?;
        if self.pixels.len() != samples || self.coverage.len() != samples {
            return Err(InpaintPatchError::BufferLength {
                width: self.width,
                height: self.height,
                pixels: self.pixels.len(),
                coverage: self.coverage.len(),
            });
        }
        Ok(())
    }

    /// True when [`Self::check_layout`] passes. The compositor skips a patch
    /// that fails it rather than panicking or writing outside the frame.
    pub fn is_valid(&self) -> bool {
        self.check_layout().is_ok()
    }
}

/// Sample count of a patch header, or why the header is refused. The count is
/// bounded by `u32` because the compositor indexes samples in `u32`.
pub(crate) fn patch_sample_count(
    width: u32,
    height: u32,
    origin: [f32; 2],
    extent: [f32; 2],
) -> Result<usize, InpaintPatchError> {
    if width == 0 || height == 0 {
        return Err(InpaintPatchError::ZeroDimension { width, height });
    }
    if width > MAX_PATCH_SIDE || height > MAX_PATCH_SIDE {
        return Err(InpaintPatchError::DimensionTooLarge { width, height });
    }
    let samples = width
        .checked_mul(height)
        .ok_or(InpaintPatchError::DimensionOverflow { width, height })?;
    if !is_frame_rect([origin[0], origin[1], extent[0], extent[1]]) {
        return Err(InpaintPatchError::Placement { origin, extent });
    }
    Ok(samples as usize)
}

/// True for a finite, non-empty `[x, y, w, h]` inside the unit frame. NaN fails
/// every comparison; the far edges are summed in f32, as the compositor does.
fn is_frame_rect([x, y, w, h]: [f32; 4]) -> bool {
    x >= 0.0 && y >= 0.0 && w > 0.0 && h > 0.0 && x + w <= 1.0 && y + h <= 1.0
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

/// The only record schema this build reads and writes.
const REMOVAL_SCHEMA: u64 = 2;

/// Why the `papp:InpaintRemovals` attribute was refused.
#[derive(Clone, Debug, PartialEq, thiserror::Error)]
pub enum RemovalRecordError {
    #[error("invalid JSON: {0}")]
    Json(String),
    #[error("InpaintRemovals wire format must be a JSON array")]
    NotAnArray,
    #[error("unsupported removal schema {found}; this build reads schema 2")]
    UnsupportedSchema { found: String },
    #[error("removal `{field}` is missing or malformed")]
    MalformedField { field: &'static str },
    #[error("removal region {region:?} is not a finite, non-empty rectangle inside the frame")]
    Region { region: [f32; 4] },
    #[error("removal `{field}` is not a plain file name")]
    FileName { field: &'static str },
    #[error("removal `{field}` is not finite")]
    NonFiniteBake { field: &'static str },
}

impl RemovalRecordError {
    /// True when the reader before #3933 already refused this input, so a
    /// sidecar carrying it must keep failing to parse. Every other refusal is
    /// new in #3933 and only keeps its record from being applied.
    pub fn was_refused_before_3933(&self) -> bool {
        match self {
            Self::Json(_) | Self::NotAnArray | Self::MalformedField { .. } => true,
            Self::UnsupportedSchema { .. }
            | Self::Region { .. }
            | Self::FileName { .. }
            | Self::NonFiniteBake { .. } => false,
        }
    }
}

/// What the tolerant reader made of the `papp:InpaintRemovals` attribute: the
/// removals this build applies, and a typed cause for each one it refused.
#[derive(Clone, Debug, PartialEq)]
pub struct DecodedRemovals {
    pub removals: Vec<Removal>,
    pub refused: Vec<RemovalRecordError>,
}

/// Encode removals to the `papp:InpaintRemovals` attribute value (compact JSON
/// array). Empty input produces `"[]"`.
///
/// # Errors
/// Refuses a removal the reader would refuse, so every encoded record reads back.
pub fn encode_removals(removals: &[Removal]) -> Result<String, RemovalRecordError> {
    removals.iter().try_for_each(Removal::check)?;
    let arr: Vec<Value> = removals.iter().map(removal_to_json).collect();
    Ok(Value::Array(arr).to_string())
}

impl Removal {
    fn check(&self) -> Result<(), RemovalRecordError> {
        if !is_frame_rect(self.region) {
            return Err(RemovalRecordError::Region {
                region: self.region,
            });
        }
        if !is_file_name(&self.patch_ref) {
            return Err(RemovalRecordError::FileName { field: "patch" });
        }
        if !is_file_name(&self.model_version) {
            return Err(RemovalRecordError::FileName { field: "model" });
        }
        let grade = [
            ("bake.temp", self.bake.temperature),
            ("bake.tint", self.bake.tint),
            ("bake.ev", self.bake.exposure),
        ];
        match grade.iter().find(|(_, value)| !value.is_finite()) {
            Some(&(field, _)) => Err(RemovalRecordError::NonFiniteBake { field }),
            None => Ok(()),
        }
    }
}

/// True for a single file-name component: non-empty, not `.` or `..`, and free
/// of path separators and NUL.
fn is_file_name(s: &str) -> bool {
    !s.is_empty() && s != "." && s != ".." && !s.contains(['/', '\\', '\0'])
}

/// Decode the `papp:InpaintRemovals` attribute. **Tolerant reader** (mirrors
/// `local_adjustment::decode_local_adjustments`): elements not tagged
/// `"kind":"removal"` are skipped (forward-compat for future kinds), and only a
/// recognized removal with a corrupt field returns `Err`. A recognized removal
/// tagged with a schema other than 2 is refused, never read as schema 2; a
/// record with no `schema` key predates the tag and reads as schema 2.
pub fn decode_removals(s: &str) -> Result<Vec<Removal>, RemovalRecordError> {
    let elements = removal_elements(s)?;
    let mut out = Vec::with_capacity(elements.len());
    for el in &elements {
        if let Some(r) = removal_from_json(el)? {
            out.push(r);
        }
    }
    Ok(out)
}

/// Sidecar-level reader: reports every refusal instead of stopping at the first.
/// Each record is judged on its own, so a record refused only by a check new in
/// #3933 (see [`RemovalRecordError::was_refused_before_3933`]) never drops its
/// valid neighbours. The caller must still fail the sidecar when any cause was
/// already refused before #3933. An attribute that is not a JSON array applies
/// nothing and reports one cause.
pub fn decode_removals_tolerant(s: &str) -> DecodedRemovals {
    let elements = match removal_elements(s) {
        Ok(elements) => elements,
        Err(cause) => {
            return DecodedRemovals {
                removals: Vec::new(),
                refused: vec![cause],
            }
        }
    };
    let mut decoded = DecodedRemovals {
        removals: Vec::with_capacity(elements.len()),
        refused: Vec::new(),
    };
    for el in &elements {
        match removal_from_json(el) {
            Ok(Some(r)) => decoded.removals.push(r),
            Ok(None) => {}
            Err(cause) => decoded.refused.push(cause),
        }
    }
    decoded
}

fn removal_elements(s: &str) -> Result<Vec<Value>, RemovalRecordError> {
    match serde_json::from_str(s) {
        Ok(Value::Array(elements)) => Ok(elements),
        Ok(_) => Err(RemovalRecordError::NotAnArray),
        Err(e) => Err(RemovalRecordError::Json(e.to_string())),
    }
}

fn removal_to_json(r: &Removal) -> Value {
    json!({
        "schema": REMOVAL_SCHEMA,
        "kind": "removal",
        "region": [r.region[0], r.region[1], r.region[2], r.region[3]],
        "patch": r.patch_ref,
        "model": r.model_version,
        "bake": { "temp": r.bake.temperature, "tint": r.bake.tint, "ev": r.bake.exposure },
    })
}

/// `Ok(Some)` = a recognized removal; `Ok(None)` = an element this build doesn't
/// recognize (skip); `Err` = a removal with a corrupt field (fail loudly).
fn removal_from_json(v: &Value) -> Result<Option<Removal>, RemovalRecordError> {
    let obj = match v.as_object() {
        Some(o) => o,
        None => return Ok(None),
    };
    if obj.get("kind").and_then(|x| x.as_str()) != Some("removal") {
        return Ok(None); // unknown element kind → skip
    }
    let region = region_from_json(obj.get("region"))?;
    let string_field = |field: &'static str| {
        obj.get(field)
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .ok_or(RemovalRecordError::MalformedField { field })
    };
    let patch_ref = string_field("patch")?;
    let model_version = string_field("model")?;
    let bake = bake_from_json(obj.get("bake"))?;
    // Shape errors above are the ones the reader refused before #3933; the
    // checks below are new, so they come last and never mask a shape error.
    if let Some(schema) = obj.get("schema") {
        if schema.as_u64() != Some(REMOVAL_SCHEMA) {
            return Err(RemovalRecordError::UnsupportedSchema {
                found: schema.to_string(),
            });
        }
    }
    let removal = Removal {
        region,
        patch_ref,
        model_version,
        bake,
    };
    removal.check()?;
    Ok(Some(removal))
}

fn region_from_json(v: Option<&Value>) -> Result<[f32; 4], RemovalRecordError> {
    let malformed = RemovalRecordError::MalformedField { field: "region" };
    let numbers: Vec<f32> = v
        .and_then(|x| x.as_array())
        .ok_or(malformed.clone())?
        .iter()
        .map(|e| e.as_f64().map(|x| x as f32))
        .collect::<Option<_>>()
        .ok_or(malformed.clone())?;
    numbers.try_into().map_err(|_| malformed)
}

fn bake_from_json(v: Option<&Value>) -> Result<BakeGrade, RemovalRecordError> {
    let obj = v
        .and_then(|x| x.as_object())
        .ok_or(RemovalRecordError::MalformedField { field: "bake" })?;
    let grade = |key: &str, field: &'static str| {
        obj.get(key)
            .and_then(|x| x.as_f64())
            .map(|x| x as f32)
            .ok_or(RemovalRecordError::MalformedField { field })
    };
    Ok(BakeGrade {
        temperature: grade("temp", "bake.temp")?,
        tint: grade("tint", "bake.tint")?,
        exposure: grade("ev", "bake.ev")?,
    })
}

#[cfg(test)]
#[path = "inpaint_tests.rs"]
mod tests;
