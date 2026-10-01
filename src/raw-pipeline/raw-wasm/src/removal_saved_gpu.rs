//! Cold saved-render bindings on the existing WebGPU RAW owner (#3955).
use crate::web_live_session::WebLiveSession;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
impl WebLiveSession {
    /// Verify the complete saved stack once after companion reads. Manifest is
    /// [{"name":"<digest>.mask|f16","length":N}], bytes concatenated in that order.
    /// A failed preparation clears the old stack; no partial result is renderable.
    pub fn prepare_saved_removals(
        &mut self,
        xmp: &str,
        manifest: &str,
        bytes: &[u8],
    ) -> Result<String, JsValue> {
        self.saved_removals = None;
        let stack =
            crate::removal_saved::prepare(&self.raw_img, &self.original, xmp, manifest, bytes)
                .map_err(|e| JsValue::from_str(&e.to_string()))?;
        let review = serde_json::to_string(stack.needs_review())
            .map_err(|e| JsValue::from_str(&e.to_string()))?;
        self.saved_removals = Some(stack);
        Ok(review)
    }

    /// Cold saved-result inspection, using the retained RAW and verified assets.
    /// cap=0 means native; this does not install a GPU slider prefix (#3955).
    pub fn render_saved_removals(
        &self,
        xmp: &str,
        cap: u32,
        film: &[u8],
    ) -> Result<crate::native_detail::NativeDetailPatch, JsValue> {
        crate::removal_saved::render(
            self.saved_removals.as_ref(),
            &self.raw_img,
            &self.original,
            &self.raw,
            &self.ext,
            xmp,
            cap,
            film,
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    /// Export accepted pixels without installed inference models or a re-decode.
    pub fn export_saved_removals(
        &self,
        xmp: &str,
        options: &str,
        film: &[u8],
    ) -> Result<crate::export::MapleExport, JsValue> {
        crate::removal_saved::export(
            self.saved_removals.as_ref(),
            &self.raw_img,
            &self.original,
            &self.raw,
            &self.ext,
            xmp,
            options,
            film,
        )
        .map_err(|e| JsValue::from_str(&e.to_string()))
    }
}
