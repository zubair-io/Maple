//! Tier-1 raster resize + tensor bindings (#3509 Task 4): `raster_resize_to_file`
//! / `raster_resize_to_buf` / `raster_extract_tensor`, mirroring
//! `raw-ffi/src/raster.rs`'s `maple_raster_resize_to_file` (line 30),
//! `maple_raster_resize_to_buf` (line 312) and `maple_raster_extract_tensor_buf`
//! (line 213) — the original, narrower raster C ABI (a `fit: u32` bitset —
//! bit0 Fill vs Inside, bit1 auto-orient, bit2 allow-enlargement — fixed
//! Lanczos3/Bilinear filters, RGB-only encode via `export::encode_raster`).
//!
//! The second-generation render entry points (`raster_render_buf` /
//! `raster_from_raw_render_buf`, with their own `flags`/`filter`/`effort`
//! wire encoding) live in the sibling `raster_render` module — this file
//! imports [`crate::raster_render::RasterBufResult`] from there so both
//! modules share one `{ ok, buffer?, error? }` shape. Split purely to stay
//! inside the repo's file-size budget (`tools/check-file-budget.sh`).
//!
//! All three operations are CPU-bound (decode + resample + encode, or a full
//! decode for the tensor path), so each is a `Task`/`AsyncTask`, per this
//! crate's established policy (see `lib.rs`'s module doc). Every JS-visible
//! outcome is `Ok({ ok: false, error })`, never a rejected `Promise` —
//! matching the shapes `rasterResizeToFile`/`rasterResizeToBuf`/
//! `rasterExtractTensor` already return from the `bun:ffi` backend
//! (`src/maple/src/native.ts`).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::export::{encode_raster, ExportFormat};
use raw_core::raster::{
    decode_raster, extract_tensor, resize_raster, FilterAlg, ResizeFit, ResizeOptions,
    TensorLayout, TensorNormalize,
};
use std::path::Path;

use crate::error::error_message;
use crate::raster_render::RasterBufResult;

/// `{ ok, error? }` — matches `rasterResizeToFile`'s return type.
#[napi(object)]
pub struct RasterFileResult {
    pub ok: bool,
    pub error: Option<String>,
}

// ---------------------------------------------------------------------
// raster_resize_to_file — mirrors `raster.rs`'s `maple_raster_resize_to_file`
// (line 30).
// ---------------------------------------------------------------------

/// `fit`: bit0 Fill (vs Inside), bit1 auto-orient, bit2 allow-enlargement —
/// the Tier-1 encoding, distinct from `raster_render`'s v2 `flags` bitset
/// (no Cover bit). Filter is always Lanczos3, matching `raster.rs`'s
/// hard-coded choice.
pub struct RasterResizeToFileTask {
    pub(crate) input_path: String,
    pub(crate) out_path: String,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) fit: u32,
    pub(crate) format: Option<String>,
    pub(crate) quality: u8,
}

impl Task for RasterResizeToFileTask {
    type Output = RasterFileResult;
    type JsValue = RasterFileResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match self.run() {
            Ok(()) => RasterFileResult {
                ok: true,
                error: None,
            },
            Err(e) => RasterFileResult {
                ok: false,
                error: Some(e),
            },
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl RasterResizeToFileTask {
    fn run(&self) -> std::result::Result<(), String> {
        if self.width == 0 || self.height == 0 {
            return Err("target width and height must be non-zero".to_string());
        }
        let in_path = Path::new(&self.input_path);
        let in_bytes = std::fs::read(in_path)
            .map_err(|e| format!("failed to read input file {}: {e}", self.input_path))?;
        let ext_hint = in_path.extension().and_then(|e| e.to_str());
        let mut raster = decode_raster(&in_bytes, ext_hint)
            .map_err(|e| error_message("failed to decode raster", e))?;

        if (self.fit & 2) != 0 {
            raster.auto_orient();
        }
        let resize_fit = if (self.fit & 1) == 1 {
            ResizeFit::Fill
        } else {
            ResizeFit::Inside
        };
        let without_enlargement = (self.fit & 4) == 0;
        let resize_opts = ResizeOptions {
            width: self.width,
            height: self.height,
            fit: resize_fit,
            filter: FilterAlg::Lanczos3,
            without_enlargement,
            ..Default::default()
        };
        let resized = resize_raster(&raster, &resize_opts)
            .map_err(|e| error_message("resizing failed", e))?;

        let out_format = match &self.format {
            Some(f) => ExportFormat::from_str(f)
                .ok_or_else(|| "unrecognized export format string".to_string())?,
            None => Path::new(&self.out_path)
                .extension()
                .and_then(|e| e.to_str())
                .and_then(ExportFormat::from_str)
                .unwrap_or(ExportFormat::Jpeg),
        };
        let q = if self.quality == 0 {
            85
        } else {
            self.quality.clamp(1, 100)
        };
        let out_bytes = encode_raster(&resized, out_format, q)
            .map_err(|e| error_message("encoding raster failed", e))?;

        // Atomic write, matching `raster.rs`'s own tmp-then-rename.
        let tmp_path = format!("{}.{}.tmp", self.out_path, std::process::id());
        std::fs::write(&tmp_path, &out_bytes)
            .map_err(|e| format!("writing tmp file failed: {e}"))?;
        std::fs::rename(&tmp_path, &self.out_path).map_err(|e| {
            let _ = std::fs::remove_file(&tmp_path);
            format!("renaming to {} failed: {e}", self.out_path)
        })?;
        Ok(())
    }
}

/// Resize a raster image file and encode it to `out_path`. See
/// [`RasterResizeToFileTask`] for the `fit` bit encoding. Resolves the same
/// shape `rasterResizeToFile` already returns from the `bun:ffi` backend.
#[napi]
pub fn raster_resize_to_file(
    input_path: String,
    out_path: String,
    width: u32,
    height: u32,
    fit: u32,
    format: Option<String>,
    quality: u8,
) -> AsyncTask<RasterResizeToFileTask> {
    AsyncTask::new(RasterResizeToFileTask {
        input_path,
        out_path,
        width,
        height,
        fit,
        format,
        quality,
    })
}

// ---------------------------------------------------------------------
// raster_resize_to_buf — mirrors `raster.rs`'s `maple_raster_resize_to_buf`
// (line 312).
// ---------------------------------------------------------------------

/// Same Tier-1 `fit` bitset as [`RasterResizeToFileTask`]; no out-path
/// extension to fall back on, so an absent `format` defaults straight to
/// Jpeg, matching `raster.rs` line 381.
pub struct RasterResizeToBufTask {
    pub(crate) bytes: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) fit: u32,
    pub(crate) format: Option<String>,
    pub(crate) quality: u8,
}

impl Task for RasterResizeToBufTask {
    type Output = RasterBufResult;
    type JsValue = RasterBufResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match self.run() {
            Ok(bytes) => RasterBufResult::ok(bytes),
            Err(e) => RasterBufResult::err(e),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

impl RasterResizeToBufTask {
    fn run(&self) -> std::result::Result<Vec<u8>, String> {
        let mut raster = decode_raster(&self.bytes, None)
            .map_err(|e| error_message("failed to decode raster", e))?;
        if (self.fit & 2) != 0 {
            raster.auto_orient();
        }
        let target_w = if self.width == 0 {
            raster.width
        } else {
            self.width
        };
        let target_h = if self.height == 0 {
            raster.height
        } else {
            self.height
        };
        let resize_fit = if (self.fit & 1) == 1 {
            ResizeFit::Fill
        } else {
            ResizeFit::Inside
        };
        let without_enlargement = (self.fit & 4) == 0;
        let resize_opts = ResizeOptions {
            width: target_w,
            height: target_h,
            fit: resize_fit,
            filter: FilterAlg::Lanczos3,
            without_enlargement,
            ..Default::default()
        };
        let resized = resize_raster(&raster, &resize_opts)
            .map_err(|e| error_message("resizing failed", e))?;

        let out_format = match &self.format {
            Some(f) => ExportFormat::from_str(f)
                .ok_or_else(|| "unrecognized export format string".to_string())?,
            None => ExportFormat::Jpeg,
        };
        let q = if self.quality == 0 {
            85
        } else {
            self.quality.clamp(1, 100)
        };
        encode_raster(&resized, out_format, q)
            .map_err(|e| error_message("encoding raster failed", e))
    }
}

/// Resize a raster image buffer and encode the result to a returned buffer.
/// Resolves the same shape `rasterResizeToBuf` already returns from the
/// `bun:ffi` backend.
#[napi]
pub fn raster_resize_to_buf(
    bytes: Buffer,
    width: u32,
    height: u32,
    fit: u32,
    format: Option<String>,
    quality: u8,
) -> AsyncTask<RasterResizeToBufTask> {
    AsyncTask::new(RasterResizeToBufTask {
        bytes: bytes.to_vec(),
        width,
        height,
        fit,
        format,
        quality,
    })
}

// ---------------------------------------------------------------------
// raster_extract_tensor — mirrors `raster.rs`'s
// `maple_raster_extract_tensor_buf` (line 213).
// ---------------------------------------------------------------------

/// Mirrors `rasterExtractTensor`'s return shape in `src/maple/src/native.ts`
/// (`{ ok: boolean; tensor?: Float32Array; error?: string }`) — the
/// `TensorResult` shape (`width`/`height`/`channels`/`data`) is assembled a
/// layer up, in `builder-exec.ts`'s `resolveTensor`, from this plus the
/// caller's own `targetSize`; the native call itself only ever carries the
/// float payload.
#[napi(object)]
pub struct RasterTensorResult {
    pub ok: bool,
    pub tensor: Option<Float32Array>,
    pub error: Option<String>,
}

pub struct RasterExtractTensorTask {
    pub(crate) bytes: Vec<u8>,
    pub(crate) target_size: u32,
    pub(crate) layout: u32,
    pub(crate) normalize: u32,
}

impl Task for RasterExtractTensorTask {
    type Output = RasterTensorResult;
    type JsValue = RasterTensorResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let raster = match decode_raster(&self.bytes, None) {
            Ok(r) => r,
            Err(e) => {
                return Ok(RasterTensorResult {
                    ok: false,
                    tensor: None,
                    error: Some(error_message("failed to decode raster", e)),
                })
            }
        };

        let target_w = if self.target_size == 0 {
            raster.width
        } else {
            self.target_size
        };
        let target_h = if self.target_size == 0 {
            raster.height
        } else {
            self.target_size
        };

        let resized = if target_w != raster.width || target_h != raster.height {
            let resize_opts = ResizeOptions {
                width: target_w,
                height: target_h,
                fit: ResizeFit::Fill,
                filter: FilterAlg::Bilinear,
                without_enlargement: false,
                ..Default::default()
            };
            match resize_raster(&raster, &resize_opts) {
                Ok(r) => r,
                Err(e) => {
                    return Ok(RasterTensorResult {
                        ok: false,
                        tensor: None,
                        error: Some(error_message("tensor resize failed", e)),
                    })
                }
            }
        } else {
            raster
        };

        let t_layout = if self.layout == 1 {
            TensorLayout::Hwc
        } else {
            TensorLayout::Nchw
        };
        let t_norm = match self.normalize {
            1 => TensorNormalize::InsightFace,
            2 => TensorNormalize::ZeroToOne,
            _ => TensorNormalize::None,
        };

        match extract_tensor(&resized, t_layout, t_norm) {
            Ok(tensor) => Ok(RasterTensorResult {
                ok: true,
                tensor: Some(tensor.data.into()),
                error: None,
            }),
            Err(e) => Ok(RasterTensorResult {
                ok: false,
                tensor: None,
                error: Some(error_message("tensor extraction failed", e)),
            }),
        }
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Extract a Float32 tensor (planar NCHW or interleaved HWC, optionally
/// normalised) for AI/ML inference. Resolves the same `{ ok; tensor?;
/// error? }` shape `rasterExtractTensor` already returns from the `bun:ffi`
/// backend.
#[napi]
pub fn raster_extract_tensor(
    bytes: Buffer,
    target_size: u32,
    layout: u32,
    normalize: u32,
) -> AsyncTask<RasterExtractTensorTask> {
    AsyncTask::new(RasterExtractTensorTask {
        bytes: bytes.to_vec(),
        target_size,
        layout,
        normalize,
    })
}
