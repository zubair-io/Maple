//! LCP import and resolver metadata; called on the decode worker (#2435).
use wasm_bindgen::prelude::*;

/// Display facts for the same decoded image and selected profile used by the
/// render. A metadata failure never replaces a successfully developed image.
pub(crate) fn metadata(
    raw: &raw_core::RawImage,
    model: &raw_core::AdjustmentModel,
) -> Option<String> {
    if model.lens_profile.is_empty() {
        return None;
    }
    raw_core::lens_profile::resolve_for_raw(raw, &model.lens_profile)
        .ok()
        .flatten()
        .map(|resolution| {
            let mut value = resolution.metadata();
            value["reference"] = model.lens_profile.clone().into();
            value["enabled"] = raw_core::lens_profile::corrections_enabled(model).into();
            value.to_string()
        })
}

#[wasm_bindgen(js_name = registerLensProfile)]
pub fn register_lens_profile(xml: &str) -> Result<String, JsError> {
    raw_core::lens_profile::register(xml)
        .map(|value| value.to_string())
        .map_err(|e| JsError::new(&e))
}

#[wasm_bindgen(js_name = selectedLensProfile)]
/// Cache restoration needs no external bytes when every correction is disabled.
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

#[wasm_bindgen(js_name = resolveLensProfile)]
pub fn resolve_lens_profile(bytes: &[u8], ext: &str, reference: &str) -> Result<String, JsError> {
    let key = raw_core::decode_cache::CacheKey::from_bytes(bytes);
    let raw = raw_core::decode_cache::decode_bytes_cached(&key, bytes, ext)
        .map_err(|e| JsError::new(&e.to_string()))?;
    let metadata = raw_core::lens_profile::resolve_for_raw(&raw, reference)
        .map_err(|e| JsError::new(&e))?
        .map(|resolution| resolution.metadata().to_string())
        .unwrap_or_else(|| raw_core::lens_profile::embedded_metadata(&raw).to_string());
    Ok(metadata)
}

#[cfg(test)]
mod tests {
    use super::selected_lens_profile;

    #[test]
    fn cache_selection_uses_core_enablement_and_later_attributes() {
        let reference = format!("lcp1:{}", "a".repeat(64));
        let attr = format!(r#"papp:LensProfile="{reference}""#);
        let xml = |extra: &str| format!(r#"<rdf:Description {attr} {extra}/>"#);
        assert_eq!(selected_lens_profile(&xml("")).unwrap(), reference);
        assert_eq!(
            selected_lens_profile(&xml(r#"crs:LensProfileEnable="0""#)).unwrap(),
            ""
        );
        assert_eq!(selected_lens_profile(&xml(r#"crs:LensProfileDistortionScale="0" crs:LensProfileChromaticAberrationScale="0" crs:LensProfileVignettingScale="0""#)).unwrap(), "");
        let commented = format!(r#"<!-- papp:LensProfile="ignored" -->{}"#, xml(""));
        assert_eq!(selected_lens_profile(&commented).unwrap(), reference);
    }
}
