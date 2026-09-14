//! Thumbnail extraction + RAW-develop-preview bindings (#3509 Task 6):
//! `render_thumbnail_avif_to_file` / `render_thumbnail_preview_jpeg_to_file`
//! / `render_develop_jpeg_to_file`, mirroring `raw-ffi/src/thumbnail.rs`'s
//! `maple_render_thumbnail_avif_to_file` (line 171) /
//! `maple_render_thumbnail_preview_jpeg_to_file` (line 198) and
//! `raw-ffi/src/render_develop.rs`'s `maple_render_develop_jpeg_to_file`
//! (line 42). Split from the sibling `develop_export.rs` purely to stay
//! inside the repo's file-size budget — same rationale as Task 4's
//! `raster_render.rs`/`raster_resize.rs` split.
//!
//! The two thumbnail operations extract and resize the RAW's already-
//! embedded JPEG preview (`raw_core::preview::extract_embedded_preview`) —
//! no full RAW decode — so they run directly on the calling `Task`'s own
//! worker thread. `render_develop_jpeg_to_file` DOES run a full RAW decode
//! (the same develop chain the canvas and `maple-cli` use), so it routes
//! through [`crate::develop_common::run_on_large_stack`]'s dedicated
//! big-stack thread; see that module's doc for the distinction.
//!
//! Every JS-visible outcome is `Ok(RasterFileResult { ok: false, error })`,
//! never a rejected `Promise` — matching the `{ ok: boolean; error?: string
//! }` shape all three already return from the `bun:ffi` backend
//! (`src/maple/src/native.ts`).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::pipeline::{render_from_raw_with_quality_and_source, RawInput, RenderQuality};
use std::path::Path;

use crate::develop_common::{atomic_write, load_xmp_model, run_on_large_stack};
use crate::raster_resize::RasterFileResult;

// ---------------------------------------------------------------------
// Shared thumbnail core — mirrors `thumbnail.rs`'s private
// `render_thumbnail_to_file`: extract the embedded preview, downsample to
// `max_px` on the long edge, bake in EXIF orientation, encode via `encode`,
// atomic-write to `out_path`.
// ---------------------------------------------------------------------

/// `(width, height, rgb, quality) -> Result<bytes>` — the shape both
/// `raw_core::avif::encode` and `raw_core::jpeg::encode` share, so
/// [`render_thumbnail_to_file`] can take either as a plain function pointer.
/// Named to satisfy `clippy::type_complexity` rather than to add any new
/// meaning.
type ThumbnailEncoder = fn(u32, u32, &[u8], u8) -> raw_core::error::Result<Vec<u8>>;

fn render_thumbnail_to_file(
    raw_path: &str,
    out_path: &str,
    max_px: u32,
    quality: u8,
    default_quality: u8,
    encode: ThumbnailEncoder,
    encode_err_label: &str,
) -> std::result::Result<(), String> {
    if max_px == 0 {
        return Err("max_px must be > 0".to_string());
    }
    if quality > 100 {
        return Err(format!("quality must be in [1, 100] (got {quality})"));
    }
    let q = if quality == 0 {
        default_quality
    } else {
        quality
    };

    let path = Path::new(raw_path);
    let raw_bytes = std::fs::read(path).map_err(|e| format!("raw read: {e}"))?;
    // Extension hint for rawler's format detection — same derivation as
    // `raw-ffi/src/thumbnail.rs`'s.
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let (dyn_img, orientation) =
        raw_core::preview::extract_embedded_preview(&raw_bytes, &ext).map_err(|e| e.to_string())?;
    let resized = raw_core::preview::resize_long_edge(dyn_img, max_px);
    let rgb_img = resized.to_rgb8();
    let (rw, rh) = rgb_img.dimensions();
    // Bake EXIF orientation into the pixels — the re-encode below carries no
    // EXIF of its own, so rotating here is the only chance to land an
    // upright thumbnail on disk.
    let (ow, oh, oriented) =
        raw_core::image::apply_orientation(rgb_img.as_raw(), rw, rh, orientation);
    let encoded =
        encode(ow, oh, &oriented, q).map_err(|e| format!("{encode_err_label} encode: {e}"))?;
    atomic_write(out_path, &encoded)
}

// ---------------------------------------------------------------------
// render_thumbnail_avif_to_file — mirrors `thumbnail.rs`'s
// `maple_render_thumbnail_avif_to_file` (line 171).
// ---------------------------------------------------------------------

pub struct RenderThumbnailAvifToFileTask {
    pub(crate) raw_path: String,
    pub(crate) out_path: String,
    pub(crate) max_px: u32,
    pub(crate) quality: u8,
}

impl Task for RenderThumbnailAvifToFileTask {
    type Output = RasterFileResult;
    type JsValue = RasterFileResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(
            match render_thumbnail_to_file(
                &self.raw_path,
                &self.out_path,
                self.max_px,
                self.quality,
                55,
                raw_core::avif::encode,
                "avif",
            ) {
                Ok(()) => RasterFileResult {
                    ok: true,
                    error: None,
                },
                Err(e) => RasterFileResult {
                    ok: false,
                    error: Some(e),
                },
            },
        )
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Extract an embedded JPEG preview from `raw_path`, downsample to `max_px`
/// on the long edge if necessary, AVIF-encode, and write atomically to
/// `out_path`. The 256px grid-thumbnail tier. `quality` is AVIF quality in
/// `[1, 100]`; `0` selects the default (55). Resolves the same shape
/// `renderThumbnailAvifToFile` already returns from the `bun:ffi` backend.
#[napi]
pub fn render_thumbnail_avif_to_file(
    raw_path: String,
    out_path: String,
    max_px: u32,
    quality: u8,
) -> AsyncTask<RenderThumbnailAvifToFileTask> {
    AsyncTask::new(RenderThumbnailAvifToFileTask {
        raw_path,
        out_path,
        max_px,
        quality,
    })
}

// ---------------------------------------------------------------------
// render_thumbnail_preview_jpeg_to_file — mirrors `thumbnail.rs`'s
// `maple_render_thumbnail_preview_jpeg_to_file` (line 198).
// ---------------------------------------------------------------------

pub struct RenderThumbnailPreviewJpegToFileTask {
    pub(crate) raw_path: String,
    pub(crate) out_path: String,
    pub(crate) max_px: u32,
    pub(crate) quality: u8,
}

impl Task for RenderThumbnailPreviewJpegToFileTask {
    type Output = RasterFileResult;
    type JsValue = RasterFileResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(
            match render_thumbnail_to_file(
                &self.raw_path,
                &self.out_path,
                self.max_px,
                self.quality,
                85,
                raw_core::jpeg::encode,
                "jpeg",
            ) {
                Ok(()) => RasterFileResult {
                    ok: true,
                    error: None,
                },
                Err(e) => RasterFileResult {
                    ok: false,
                    error: Some(e),
                },
            },
        )
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Extract an embedded JPEG preview from `raw_path`, downsample to `max_px`
/// on the long edge if necessary, JPEG-encode, and write atomically to
/// `out_path`. The 1280px VLM describe/OCR preview tier — kept JPEG because
/// every describe provider hardcodes `image/jpeg` as the media type it sends
/// upstream. `quality` is JPEG quality in `[1, 100]`; `0` selects the
/// default (85). Resolves the same shape `renderThumbnailPreviewJpegToFile`
/// already returns from the `bun:ffi` backend.
#[napi]
pub fn render_thumbnail_preview_jpeg_to_file(
    raw_path: String,
    out_path: String,
    max_px: u32,
    quality: u8,
) -> AsyncTask<RenderThumbnailPreviewJpegToFileTask> {
    AsyncTask::new(RenderThumbnailPreviewJpegToFileTask {
        raw_path,
        out_path,
        max_px,
        quality,
    })
}

// ---------------------------------------------------------------------
// render_develop_jpeg_to_file — mirrors `render_develop.rs`'s
// `maple_render_develop_jpeg_to_file` (line 42).
// ---------------------------------------------------------------------

pub struct RenderDevelopJpegToFileTask {
    pub(crate) raw_path: String,
    pub(crate) xmp_path: Option<String>,
    pub(crate) out_path: String,
    pub(crate) max_px: u32,
    pub(crate) quality: u8,
}

impl Task for RenderDevelopJpegToFileTask {
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

impl RenderDevelopJpegToFileTask {
    fn run(&self) -> std::result::Result<(), String> {
        if self.max_px == 0 {
            return Err("max_px must be > 0".to_string());
        }
        if self.quality > 100 {
            return Err(format!(
                "quality must be in [1, 100] (got {})",
                self.quality
            ));
        }
        let q = if self.quality == 0 { 82 } else { self.quality };

        let raw_path = self.raw_path.clone();
        let xmp_path = self.xmp_path.clone();
        let out_path = self.out_path.clone();
        let max_px = self.max_px;
        run_on_large_stack(move || {
            let model = load_xmp_model(xmp_path.as_deref())?;
            let path = Path::new(&raw_path);
            let raw_bytes = std::fs::read(path).map_err(|e| format!("raw read: {e}"))?;
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let raw_img = raw_core::decode::decode_bytes(&raw_bytes, ext)
                .map_err(|e| format!("decode: {e}"))?;
            let (w, h, bytes) = render_from_raw_with_quality_and_source(
                &raw_img,
                &model,
                RenderQuality::Amaze,
                Some(RawInput::Path(path)),
            )
            .map_err(|e| format!("render: {e}"))?;
            // The develop output is a tightly-packed, display-oriented
            // RGB888 buffer. Wrap → resize to the long-edge target →
            // JPEG-encode.
            let rgb = image::RgbImage::from_raw(w, h, bytes)
                .ok_or_else(|| "develop buffer size mismatch".to_string())?;
            let resized =
                raw_core::preview::resize_long_edge(image::DynamicImage::ImageRgb8(rgb), max_px);
            let rgb_img = resized.to_rgb8();
            let (rw, rh) = rgb_img.dimensions();
            let jpeg = raw_core::jpeg::encode(rw, rh, rgb_img.as_raw(), q)
                .map_err(|e| format!("jpeg encode: {e}"))?;
            atomic_write(&out_path, &jpeg)
        })
    }
}

/// Develop `raw_path` with `xmp_path` applied (`None` = neutral defaults),
/// downsample to `max_px` on the long edge, JPEG-encode, and write
/// atomically to `out_path`. Uses AMaZE demosaic (`RenderQuality::Amaze`) —
/// a cache-populating background stage, not the interactive fast path, so it
/// favours quality. `quality` is JPEG quality in `[1, 100]`; `0` selects the
/// default (82). Resolves the same shape `renderDevelopJpegToFile` already
/// returns from the `bun:ffi` backend.
///
/// Not currently reached from `src/maple/src/` (no `callNative` call site
/// exists for it yet), but `test/maple.test.ts` exercises the full
/// `NativeBinding` surface via `loadNativeBinding()` directly, so this is a
/// complete, real implementation rather than a stub.
#[napi]
pub fn render_develop_jpeg_to_file(
    raw_path: String,
    xmp_path: Option<String>,
    out_path: String,
    max_px: u32,
    quality: u8,
) -> AsyncTask<RenderDevelopJpegToFileTask> {
    AsyncTask::new(RenderDevelopJpegToFileTask {
        raw_path,
        xmp_path,
        out_path,
        max_px,
        quality,
    })
}
