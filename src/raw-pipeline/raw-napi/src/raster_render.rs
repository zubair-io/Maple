//! Raster v2 render bindings (#3509 Task 4): `raster_render_buf` /
//! `raster_from_raw_render_buf`, mirroring `raw-ffi/src/raster_v2.rs`'s
//! `maple_raster_render_buf` (line 157) and `maple_raster_from_raw_render_buf`
//! (line 211) — the second-generation raster C ABI (one general render entry
//! point: fit, filter, orientation, format, quality, AVIF effort).
//!
//! The Tier-1 resize/tensor operations (`raster.rs`'s older, narrower C ABI)
//! live in the sibling `raster_resize` module instead — split out purely to
//! stay inside the repo's file-size budget (`tools/check-file-budget.sh`);
//! `raster_resize.rs` imports [`RasterBufResult`] from here for its own
//! buffer-returning ops so both modules share one result shape.
//!
//! `fit_from`/`filter_from`/`avif_speed_from` below are byte-for-byte copies
//! of `raster_v2.rs`'s private helpers of the same name (lines 28-56) — not
//! re-derived, per the task brief's explicit warning that a mismatched flag
//! bit or filter enum value would silently diverge bun:ffi-vs-napi output,
//! exactly the kind of parity bug CLAUDE.md's "parity before features"
//! principle exists to prevent (here: bun:ffi-vs-napi parity, same
//! discipline as Apple-vs-Web).
//!
//! Both operations are CPU-bound (decode + resample + encode), so each is a
//! `Task`/`AsyncTask`, per this crate's established policy (see `lib.rs`'s
//! module doc and `raster_probe.rs`). Every JS-visible outcome is
//! `Ok({ ok: false, error })`, never a rejected `Promise` — matching the
//! `{ ok: boolean; buffer?: Buffer; error?: string }` shape `rasterRenderBuf`/
//! `rasterFromRawRenderBuf` already return from the `bun:ffi` backend
//! (`src/maple/src/native-raster-v2.ts`).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::export::ExportFormat;
use raw_core::raster::{
    decode_raster, resize_raster, FilterAlg, RasterImage, ResizeFit, ResizeOptions,
};
use raw_core::raster_encode::{encode_raster_opts, RasterEncodeOptions};
use raw_core::view::encode::TargetPrimaries;

use crate::error::error_message;

const FLAG_FILL: u32 = 1;
const FLAG_AUTO_ORIENT: u32 = 2;
const FLAG_ALLOW_ENLARGE: u32 = 4;
const FLAG_COVER: u32 = 8;

fn fit_from(flags: u32) -> ResizeFit {
    if flags & FLAG_COVER != 0 {
        ResizeFit::Cover
    } else if flags & FLAG_FILL != 0 {
        ResizeFit::Fill
    } else {
        ResizeFit::Inside
    }
}

fn filter_from(filter: u32) -> FilterAlg {
    match filter {
        1 => FilterAlg::Bilinear,
        2 => FilterAlg::Nearest,
        _ => FilterAlg::Lanczos3,
    }
}

/// AVIF effort, one-based on the wire so "unset" is distinguishable from
/// sharp's `effort: 0`: `0` = unset (rav1e speed 6, the encoder default),
/// `1..=10` = sharp effort 0 (fastest) … 9 (slowest), mapped to rav1e speed
/// `11 - wire` (10 = fastest … 1 = slowest). Values above 10 clamp to 10.
fn avif_speed_from(wire_effort: u8) -> u8 {
    if wire_effort == 0 {
        6
    } else {
        11 - wire_effort.min(10)
    }
}

pub(crate) fn parse_format(format: Option<&str>) -> std::result::Result<ExportFormat, String> {
    match format {
        None => Ok(ExportFormat::Jpeg),
        Some(s) => {
            ExportFormat::from_str(s).ok_or_else(|| "unrecognized export format string".to_string())
        }
    }
}

struct RenderParams {
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format: ExportFormat,
    quality: u8,
    /// One-based wire value — see [`avif_speed_from`].
    effort: u8,
}

/// Shared body: orient → resize → alpha-aware encode. Mirrors
/// `raster_v2.rs`'s `render_into`, minus the caller-owned-buffer sizing
/// dance — this returns an owned `Vec<u8>` directly.
fn render_v2(mut raster: RasterImage, p: &RenderParams) -> std::result::Result<Vec<u8>, String> {
    if p.flags & FLAG_AUTO_ORIENT != 0 {
        raster.auto_orient();
    }
    let opts = ResizeOptions {
        width: if p.width == 0 { raster.width } else { p.width },
        height: if p.height == 0 {
            raster.height
        } else {
            p.height
        },
        fit: fit_from(p.flags),
        filter: filter_from(p.filter),
        without_enlargement: p.flags & FLAG_ALLOW_ENLARGE == 0,
        ..Default::default()
    };
    let resized = resize_raster(&raster, &opts).map_err(|e| format!("resizing failed: {e}"))?;
    let quality = if p.quality == 0 {
        85
    } else {
        p.quality.clamp(1, 100)
    };
    // `encode_raster_opts`, not the Tier-1 `encode_raster`: alpha stays for
    // PNG/WebP/AVIF and composites over black for JPEG/TIFF, matching every
    // other v2/recipe encode path (see `raster_v2.rs`'s own comment on why
    // this matters — a transparent pixel's stored colour must never leak
    // into a JPEG). The v2 C ABI has no colourspace parameter, so this stays
    // sRGB, matching it byte-for-byte.
    encode_raster_opts(
        &resized,
        &RasterEncodeOptions {
            format: p.format,
            quality,
            avif_speed: avif_speed_from(p.effort),
            primaries: TargetPrimaries::Srgb,
        },
    )
    .map_err(|e| format!("encoding raster failed: {e}"))
}

/// Shared `{ ok, buffer?, error? }` shape for every v2 render operation and
/// the Tier-1 buffer resize in `raster_resize.rs` — matches
/// `rasterResizeToBuf`/`rasterRenderBuf`/`rasterFromRawRenderBuf`'s return
/// type in `src/maple/src/native.ts` / `native-raster-v2.ts`.
#[napi(object)]
pub struct RasterBufResult {
    pub ok: bool,
    pub buffer: Option<Buffer>,
    pub error: Option<String>,
}

impl RasterBufResult {
    pub(crate) fn ok(bytes: Vec<u8>) -> Self {
        Self {
            ok: true,
            buffer: Some(bytes.into()),
            error: None,
        }
    }

    pub(crate) fn err(message: String) -> Self {
        Self {
            ok: false,
            buffer: None,
            error: Some(message),
        }
    }
}

// ---------------------------------------------------------------------
// raster_render_buf — mirrors `raster_v2.rs`'s `maple_raster_render_buf`
// (line 157).
// ---------------------------------------------------------------------

pub struct RasterRenderBufTask {
    pub(crate) bytes: Vec<u8>,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) flags: u32,
    pub(crate) filter: u32,
    pub(crate) format: Option<String>,
    pub(crate) quality: u8,
    pub(crate) effort: u8,
}

impl Task for RasterRenderBufTask {
    type Output = RasterBufResult;
    type JsValue = RasterBufResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let format = match parse_format(self.format.as_deref()) {
            Ok(f) => f,
            Err(e) => return Ok(RasterBufResult::err(e)),
        };
        let raster = match decode_raster(&self.bytes, None) {
            Ok(r) => r,
            Err(e) => {
                return Ok(RasterBufResult::err(error_message(
                    "failed to decode raster",
                    e,
                )))
            }
        };
        let params = RenderParams {
            width: self.width,
            height: self.height,
            flags: self.flags,
            filter: self.filter,
            format,
            quality: self.quality,
            effort: self.effort,
        };
        Ok(match render_v2(raster, &params) {
            Ok(bytes) => RasterBufResult::ok(bytes),
            Err(e) => RasterBufResult::err(e),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// General v2 render entry point: decode → orient → resize (fit/filter) →
/// encode (format/quality/AVIF effort). See the module doc for the `flags`
/// and `filter` wire encodings. Resolves the same shape `rasterRenderBuf`
/// already returns from the `bun:ffi` backend.
///
/// The argument count matches `maple_raster_render_buf`'s C ABI parameter
/// list one-for-one on purpose — see the module doc — so
/// `too_many_arguments` is a byte-for-byte parity requirement here, not
/// something to refactor away.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn raster_render_buf(
    bytes: Buffer,
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format: Option<String>,
    quality: u8,
    effort: u8,
) -> AsyncTask<RasterRenderBufTask> {
    AsyncTask::new(RasterRenderBufTask {
        bytes: bytes.to_vec(),
        width,
        height,
        flags,
        filter,
        format,
        quality,
        effort,
    })
}

// ---------------------------------------------------------------------
// raster_from_raw_render_buf — mirrors `raster_v2.rs`'s
// `maple_raster_from_raw_render_buf` (line 211).
// ---------------------------------------------------------------------

pub struct RasterFromRawRenderBufTask {
    pub(crate) pixels: Vec<u8>,
    pub(crate) src_width: u32,
    pub(crate) src_height: u32,
    pub(crate) channels: u32,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) flags: u32,
    pub(crate) filter: u32,
    pub(crate) format: Option<String>,
    pub(crate) quality: u8,
    pub(crate) effort: u8,
}

impl Task for RasterFromRawRenderBufTask {
    type Output = RasterBufResult;
    type JsValue = RasterBufResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let format = match parse_format(self.format.as_deref()) {
            Ok(f) => f,
            Err(e) => return Ok(RasterBufResult::err(e)),
        };
        let raster = match RasterImage::from_raw(
            self.src_width,
            self.src_height,
            self.channels.min(255) as u8,
            self.pixels.clone(),
        ) {
            Ok(r) => r,
            Err(e) => {
                return Ok(RasterBufResult::err(error_message(
                    "invalid raw pixel input",
                    e,
                )))
            }
        };
        // Auto-orient is meaningless with no source metadata — the C ABI
        // masks the bit out before rendering (`raster_v2.rs` line 246).
        let flags = self.flags & !FLAG_AUTO_ORIENT;
        let params = RenderParams {
            width: self.width,
            height: self.height,
            flags,
            filter: self.filter,
            format,
            quality: self.quality,
            effort: self.effort,
        };
        Ok(match render_v2(raster, &params) {
            Ok(bytes) => RasterBufResult::ok(bytes),
            Err(e) => RasterBufResult::err(e),
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Same as [`raster_render_buf`] but from caller-decoded interleaved 8-bit
/// pixels (`channels` 1, 3 or 4) instead of an encoded file. The auto-orient
/// flag is ignored (no source metadata to orient from). Resolves the same
/// shape `rasterFromRawRenderBuf` already returns from the `bun:ffi`
/// backend.
///
/// See [`raster_render_buf`]'s doc for why `too_many_arguments` is allowed
/// here: the count matches `maple_raster_from_raw_render_buf`'s C ABI
/// one-for-one.
#[allow(clippy::too_many_arguments)]
#[napi]
pub fn raster_from_raw_render_buf(
    pixels: Buffer,
    src_width: u32,
    src_height: u32,
    channels: u32,
    width: u32,
    height: u32,
    flags: u32,
    filter: u32,
    format: Option<String>,
    quality: u8,
    effort: u8,
) -> AsyncTask<RasterFromRawRenderBufTask> {
    AsyncTask::new(RasterFromRawRenderBufTask {
        pixels: pixels.to_vec(),
        src_width,
        src_height,
        channels,
        width,
        height,
        flags,
        filter,
        format,
        quality,
        effort,
    })
}
