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
    bytes: Vec<u8>,
    ext: String,
    prepared: Option<PreparedDetail>,
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
            bytes: bytes.to_vec(),
            ext: ext.to_owned(),
            prepared: None,
        })
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
            let model = match &xmp {
                Some(x) => raw_core::xmp::parse(x).map_err(js_error)?,
                None => raw_core::xmp::AdjustmentModel::default(),
            };
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
