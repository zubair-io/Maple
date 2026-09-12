//! Imported LCP profiles on the render worker (#3479, slice 3 of #3395).
//!
//! The Web keeps user-owned `.lcp` bytes in IndexedDB (Hosted) or the server
//! cache (Self Hosted) and re-registers them into raw-core's process cache
//! before any decode that names one. These bindings are that bridge: the
//! import handshake (`register` + `resolve`), the sidecar selection the
//! worker restores against, and the cache reset used when the process cache
//! is full. The develop itself reads the cache through
//! `raw_core::lens_profile::apply_for_raw`; nothing here touches pixels.

use raw_core::image::RawImage;
use raw_core::AdjustmentModel;
use wasm_bindgen::prelude::*;

/// Resolver facts for the decoded image and the profile its model names —
/// the same pair the render just consumed, so the panel describes exactly
/// what was applied. `None` when the model names no profile, or when the
/// profile is not in the process cache (the develop has already failed
/// explicitly in that case whenever the correction was required). A RAW
/// with its own `OpcodeList3` reports `embedded`: raw-core gives authored
/// corrections priority and never resolves an external profile for it.
pub(crate) fn metadata(raw: &RawImage, model: &AdjustmentModel) -> Option<String> {
    let mut value = if raw.has_lens_corrections() {
        if model.lens_profile.is_empty() {
            return None;
        }
        embedded_metadata()
    } else {
        raw_core::lens_profile::evidence_for(raw, model)
            .ok()
            .flatten()?
    };
    value["reference"] = model.lens_profile.clone().into();
    value["enabled"] = raw_core::lens_profile::corrections_enabled(model).into();
    Some(value.to_string())
}

fn embedded_metadata() -> serde_json::Value {
    serde_json::json!({
        "source": "embedded",
        "confidence": "embedded",
        "approximations": [],
        "unsupported": [],
    })
}

/// Register user-owned LCP bytes in this worker's process cache. Returns
/// the inventory JSON (`reference`, `name`, `make`, `camera`, `lens`,
/// `sampleCount`) the import panel shows.
#[wasm_bindgen(js_name = registerLensProfile)]
pub fn register_lens_profile(xml: &str) -> Result<String, JsError> {
    raw_core::lens_profile::register(xml)
        .map(|value| value.to_string())
        .map_err(|e| JsError::new(&e))
}

/// Whether `xml` would fit the process cache. The worker clears the cache
/// (`clearLensProfiles`) and resets its restore memo when it would not, so
/// an import never fails on a cap the browser's own store does not share.
#[wasm_bindgen(js_name = lensProfileCacheHasRoom)]
pub fn lens_profile_cache_has_room(xml: &str) -> Result<bool, JsError> {
    raw_core::lens_profile::has_capacity(xml.len()).map_err(|e| JsError::new(&e))
}

/// Drop every registered profile. The worker calls this when a registration
/// reports the process cache full, then re-registers only what the next
/// render needs; its own restore memo is reset alongside.
#[wasm_bindgen(js_name = clearLensProfiles)]
pub fn clear_lens_profiles() -> Result<(), JsError> {
    raw_core::lens_profile::clear_cache().map_err(|e| JsError::new(&e))
}

/// The profile reference a sidecar selects, through the canonical parser,
/// or the empty string when no external bytes are needed: no selection, or
/// every correction disabled (master toggle off / all strengths zero).
#[wasm_bindgen(js_name = selectedLensProfile)]
pub fn selected_lens_profile(xmp: &str) -> Result<String, JsError> {
    raw_core::xmp::parse(xmp)
        .map(|model| {
            if raw_core::lens_profile::corrections_enabled(&model) {
                model.lens_profile
            } else {
                String::new()
            }
        })
        .map_err(|e| JsError::new(&e.to_string()))
}

/// Resolve a registered profile against a RAW for the import panel: the
/// camera/lens match, the selected calibration samples, reported
/// approximations and unsupported records. A mismatch or an unsupported
/// model is an error, never an approximation. A RAW carrying its own
/// `OpcodeList3` reports `embedded` so the panel can say those win.
#[wasm_bindgen(js_name = resolveLensProfile)]
pub fn resolve_lens_profile(bytes: &[u8], ext: &str, reference: &str) -> Result<String, JsError> {
    let key = raw_core::decode_cache::CacheKey::from_bytes(bytes);
    let raw = raw_core::decode_cache::decode_bytes_cached(&key, bytes, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let model = AdjustmentModel {
        lens_profile: reference.to_owned(),
        ..Default::default()
    };
    let metadata = raw_core::lens_profile::evidence_for(&raw, &model)
        .map_err(|e| JsError::new(&e))?
        .unwrap_or_else(embedded_metadata);
    Ok(metadata.to_string())
}

/// Every bundled Lensfun lens this RAW's body can carry, for the Lens
/// Corrections dropdown: `[{"slug","maker","model"}]`, `[]` when the body
/// is not in the bundle.
#[wasm_bindgen(js_name = compatibleLensProfiles)]
pub fn compatible_lens_profiles(bytes: &[u8], ext: &str) -> Result<String, JsError> {
    let key = raw_core::decode_cache::CacheKey::from_bytes(bytes);
    let raw = raw_core::decode_cache::decode_bytes_cached(&key, bytes, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(raw_core::lens_profile::compatible_lenses(&raw).to_string())
}

#[cfg(test)]
mod tests {
    use super::selected_lens_profile;

    #[test]
    fn selection_follows_core_enablement_and_the_canonical_parser() {
        let reference = format!("lcp1:{}", "a".repeat(64));
        let attr = format!(r#"papp:LensProfile="{reference}""#);
        let xml = |extra: &str| format!(r#"<rdf:Description {attr} {extra}/>"#);
        assert_eq!(selected_lens_profile(&xml("")).unwrap(), reference);
        assert_eq!(
            selected_lens_profile(&xml(r#"crs:LensProfileEnable="0""#)).unwrap(),
            ""
        );
        assert_eq!(
            selected_lens_profile(&xml(
                r#"crs:LensProfileDistortionScale="0" crs:LensProfileChromaticAberrationScale="0" crs:LensProfileVignettingScale="0""#
            ))
            .unwrap(),
            ""
        );
        let commented = format!(r#"<!-- papp:LensProfile="ignored" -->{}"#, xml(""));
        assert_eq!(selected_lens_profile(&commented).unwrap(), reference);
    }
}
