//! A decoded mosaic retained across native-detail pans (#1107).
//! The bounded reference render supplies the exact AE/Auto artifacts that
//! its patch reuses. No full-sensor RGB buffer is allocated.

use raw_core::{
    image::RawImage,
    pipeline::{self, DetailContext, DetailRenderOptions, RawInput, RenderQuality, TileRect},
};
use wasm_bindgen::prelude::*;

/// Includes filter overlap, before any tile scratch allocation.
const MAX_WORKING_PIXELS: u64 = 8 * 1024 * 1024;

#[wasm_bindgen]
pub struct NativeDetailSession {
    raw: RawImage,
    original: raw_core::types::accepted_removal::ContentDigest,
    bytes: Vec<u8>,
    ext: String,
    prepared: Option<PreparedDetail>,
    saved_removals: Option<pipeline::ResolvedCalibrationRemovals>,
}

struct PreparedDetail {
    xmp: Option<String>,
    cap: u32,
    preview: bool,
    film_bytes: Vec<u8>,
    film: Option<raw_core::film::FilmLut>,
    context: DetailContext,
}

#[wasm_bindgen]
pub struct NativeDetailPatch {
    width: u32,
    height: u32,
    rgb: Vec<u8>,
}

impl NativeDetailPatch {
    pub(crate) fn from_rgb(width: u32, height: u32, rgb: Vec<u8>) -> Self {
        Self { width, height, rgb }
    }
}

#[wasm_bindgen]
impl NativeDetailPatch {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }
}

#[wasm_bindgen]
impl NativeDetailSession {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], ext: &str) -> Result<Self, JsError> {
        let raw = raw_core::decode::decode_bytes(bytes, ext).map_err(js_error)?;
        Ok(Self {
            raw,
            original: raw_core::types::accepted_removal::ContentDigest::for_bytes(bytes),
            bytes: bytes.to_vec(),
            ext: ext.to_owned(),
            prepared: None,
            saved_removals: None,
        })
    }

    /// Fixed pre-WB/HSM f32 RGB for a native generation context (#3955).
    /// rect is x,y,width,height in UNORIENTED DefaultCrop pixels. Reuses the
    /// retained RAW; current creative edits are excluded. Authoring is not enabled.
    pub fn removal_calibration_context(&self, rect: &[u32]) -> Result<Vec<f32>, JsError> {
        crate::removal_context::prepare(&self.raw, rect).map_err(js_error)
    }

    /// Fixed calibration recipe and original-byte identity. Read when opening
    /// removal authoring, never per stroke or slider tick.
    pub fn removal_calibration_source(&self) -> Result<String, JsError> {
        crate::removal_context::source(&self.raw, &self.original).map_err(js_error)
    }

    /// Gesture batch in oriented post-perspective, pre-user-crop UV. Null
    /// results are surround, never clamped edge selection (#3934).
    pub fn removal_map_points(&self, xmp: &str, request: &str) -> Result<String, JsError> {
        crate::removal_context::map_points(&self.raw, xmp, request).map_err(js_error)
    }

    /// Verify the complete saved stack once after companion reads. Manifest is
    /// [{"name":"<digest>.mask|f16","length":N}], bytes concatenated in that order.
    /// A failed preparation clears the old stack; no partial result is renderable.
    pub fn prepare_saved_removals(
        &mut self,
        xmp: &str,
        manifest: &str,
        bytes: &[u8],
    ) -> Result<String, JsError> {
        self.saved_removals = None;
        let stack = crate::removal_saved::prepare(&self.raw, &self.original, xmp, manifest, bytes)
            .map_err(js_error)?;
        let review = serde_json::to_string(stack.needs_review()).map_err(js_error)?;
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
    ) -> Result<crate::native_detail::NativeDetailPatch, JsError> {
        crate::removal_saved::render(
            self.saved_removals.as_ref(),
            &self.raw,
            &self.original,
            &self.bytes,
            &self.ext,
            xmp,
            cap,
            film,
        )
        .map_err(js_error)
    }

    /// Export accepted pixels without installed inference models or a re-decode.
    pub fn export_saved_removals(
        &self,
        xmp: &str,
        options: &str,
        film: &[u8],
    ) -> Result<crate::export::MapleExport, JsError> {
        crate::removal_saved::export(
            self.saved_removals.as_ref(),
            &self.raw,
            &self.original,
            &self.bytes,
            &self.ext,
            xmp,
            options,
            film,
        )
        .map_err(js_error)
    }

    /// `rect` = x,y,width,height in oriented DefaultCrop-relative pixels.
    /// `cap` and `preview` describe the canvas's last completed base render,
    /// not the patch. The same reference anchors survive subsequent pans.
    pub fn render_tile(
        &mut self,
        xmp: Option<String>,
        rect: &[u32],
        cap: u32,
        preview: bool,
        film_bytes: &[u8],
    ) -> Result<NativeDetailPatch, JsError> {
        if rect.len() != 4 || cap == 0 {
            return Err(JsError::new("invalid native-detail request"));
        }
        let cap =
            crate::cpu_budget::clamp_develop_long_edge(self.raw.width, self.raw.height, Some(cap))
                .unwrap_or(cap);
        let prepare = self.prepared.as_ref().is_none_or(|p| {
            p.xmp != xmp || p.cap != cap || p.preview != preview || p.film_bytes != film_bytes
        });
        if prepare {
            // Release prior artifacts before creating the new bounded reference.
            self.prepared = None;
            let model = crate::mask_registry::parse_model(xmp.as_deref()).map_err(js_error)?;
            let film = if film_bytes.is_empty() {
                None
            } else {
                Some(raw_core::film::decode_mlut(film_bytes).map_err(js_error)?)
            };
            let (_, _, _, context) = pipeline::render_detail_base(
                &self.raw,
                &model,
                RawInput::Bytes {
                    bytes: &self.bytes,
                    ext: &self.ext,
                },
                DetailRenderOptions {
                    quality: if preview {
                        RenderQuality::Preview
                    } else {
                        RenderQuality::Amaze
                    },
                    max_long_edge: cap,
                    film_lut: film.as_ref(),
                },
            )
            .map_err(js_error)?;
            self.prepared = Some(PreparedDetail {
                xmp,
                cap,
                preview,
                film_bytes: film_bytes.to_vec(),
                film,
                context,
            });
        }
        let prepared = self.prepared.as_ref().expect("prepared above");
        let (width, height, rgb) = pipeline::render_detail_tile(
            &self.raw,
            &prepared.context,
            TileRect {
                src_x: rect[0],
                src_y: rect[1],
                src_w: rect[2],
                src_h: rect[3],
                out_w: rect[2],
                out_h: rect[3],
            },
            prepared.film.as_ref(),
            MAX_WORKING_PIXELS,
        )
        .map_err(js_error)?;
        Ok(NativeDetailPatch { width, height, rgb })
    }
}

fn js_error(error: impl std::fmt::Display) -> JsError {
    JsError::new(&error.to_string())
}
