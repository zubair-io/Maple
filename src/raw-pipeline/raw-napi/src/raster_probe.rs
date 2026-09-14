//! Raster header-probe and native-size RGB8 decode bindings (#3509),
//! mirroring `raw-ffi/src/raster.rs`'s `maple_raster_probe_metadata(_buf)`
//! and `raw-ffi/src/raster_v2.rs`'s `maple_raster_decode_rgb8_buf`.
//!
//! All three are CPU-bound (a probe reads a header; a decode fully decompresses
//! a bitmap), so each is implemented with napi-rs's `Task`/`AsyncTask` pair,
//! which runs the work on N-API's own libuv worker pool and resolves a real JS
//! `Promise` — matching this crate's stated policy of using `Task`/`AsyncTask`
//! rather than pulling in a Tokio runtime (see `lib.rs`'s module doc).
//!
//! Every JS-visible outcome here is `Ok(RasterProbeResult { ok: false, .. })`
//! / `Ok(RasterDecodeResult { ok: false, .. })`, never a rejected `Promise`
//! (`Err(napi::Error)`), matching the `{ ok: boolean; error?: string }` shape
//! every other `NativeBinding` raster method already returns from the
//! `bun:ffi` backend (`src/maple/src/native.ts`,
//! `src/maple/src/native-raster-v2.ts`) — callers (`builder-metadata.ts`)
//! check `res.ok` rather than catching a throw for an expected "can't probe
//! /decode this" outcome. A real `Err(napi::Error)` is reserved for a
//! genuine napi/marshalling-level failure, which none of these three
//! operations can produce from valid JS-side input.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::raster::{decode_raster, probe_raster_metadata};

use crate::error::error_message;

/// Mirrors the `metadata` shape both `rasterProbeMetadata` and
/// `rasterProbeMetadataBuf` return in `src/maple/src/native.ts` (lines
/// 81-104): `width`/`height`/`channels`/`orientation` always present,
/// `format` modelled as optional here (napi has no tagged union) even though
/// both call sites populate it in practice.
#[napi(object)]
pub struct RasterMetadata {
    pub width: u32,
    pub height: u32,
    pub channels: u32,
    pub orientation: u32,
    pub format: Option<String>,
}

/// Mirrors `rasterProbeMetadata`/`rasterProbeMetadataBuf`'s return shape:
/// `{ ok: boolean; metadata?: {...}; error?: string }`. No numeric `code`
/// field — unlike the filename operations, neither `NativeBinding` raster
/// probe method's TS type carries one.
#[napi(object)]
pub struct RasterProbeResult {
    pub ok: bool,
    pub metadata: Option<RasterMetadata>,
    pub error: Option<String>,
}

/// Probe `bytes`' header for metadata, without decoding pixels. Shared by
/// both [`RasterProbeTask`] and [`RasterProbeBufTask`], the same way
/// `raw-ffi/src/raster.rs`'s `maple_raster_probe_metadata` and
/// `maple_raster_probe_metadata_buf` both call `raw_core`'s
/// `probe_raster_metadata` and marshal the same `RasterMetadata` shape.
fn probe_bytes(bytes: &[u8]) -> RasterProbeResult {
    match probe_raster_metadata(bytes) {
        Ok(meta) => RasterProbeResult {
            ok: true,
            metadata: Some(RasterMetadata {
                width: meta.width,
                height: meta.height,
                channels: meta.channels as u32,
                // `None` (an AVIF, whose transform is baked into the pixels)
                // is reported as 1 — matches raw-ffi's own
                // `meta.orientation.unwrap_or(1) as u32` in both
                // `maple_raster_probe_metadata` and `_buf`.
                orientation: meta.orientation.unwrap_or(1) as u32,
                format: Some(meta.format),
            }),
            error: None,
        },
        Err(e) => RasterProbeResult {
            ok: false,
            metadata: None,
            error: Some(error_message("metadata probing failed", e)),
        },
    }
}

/// Backs [`raster_probe_metadata`] — path-based probe, mirroring
/// `raw-ffi/src/raster.rs`'s `maple_raster_probe_metadata` (line 156): reads
/// the file itself (on the libuv worker thread, off the JS thread) and reuses
/// [`probe_bytes`] for the actual header parse, the same "read file then
/// reuse the buf path" structure `native.ts`'s own `rasterProbeMetadata`
/// bun:ffi implementation already uses (`rasterProbeMetadata` calls
/// `rasterProbeMetadataBuf` on the bytes it read).
pub struct RasterProbeTask {
    pub(crate) path: String,
}

impl Task for RasterProbeTask {
    type Output = RasterProbeResult;
    type JsValue = RasterProbeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let bytes = match std::fs::read(&self.path) {
            Ok(b) => b,
            Err(e) => {
                return Ok(RasterProbeResult {
                    ok: false,
                    metadata: None,
                    error: Some(error_message(
                        &format!("failed to read file {}", self.path),
                        e,
                    )),
                });
            }
        };
        Ok(probe_bytes(&bytes))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Fast metadata probing for a raster image file at `path`, without decoding
/// full pixels. Resolves the same shape `rasterProbeMetadata` already
/// returns from the `bun:ffi` backend.
#[napi]
pub fn raster_probe_metadata(path: String) -> AsyncTask<RasterProbeTask> {
    AsyncTask::new(RasterProbeTask { path })
}

/// Backs [`raster_probe_metadata_buf`] — mirrors
/// `raw-ffi/src/raster.rs`'s `maple_raster_probe_metadata_buf` (line 410).
pub struct RasterProbeBufTask {
    pub(crate) bytes: Vec<u8>,
}

impl Task for RasterProbeBufTask {
    type Output = RasterProbeResult;
    type JsValue = RasterProbeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(probe_bytes(&self.bytes))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Fast metadata probing for a raster image buffer already in memory.
/// Resolves the same shape `rasterProbeMetadataBuf` already returns from the
/// `bun:ffi` backend.
#[napi]
pub fn raster_probe_metadata_buf(bytes: Buffer) -> AsyncTask<RasterProbeBufTask> {
    AsyncTask::new(RasterProbeBufTask {
        bytes: bytes.to_vec(),
    })
}

/// Mirrors `rasterDecodeRgb8Buf`'s return shape in
/// `src/maple/src/native-raster-v2.ts` (lines 92-96): `{ ok: boolean; buffer?:
/// Buffer; width?: number; height?: number; error?: string }`.
#[napi(object)]
pub struct RasterDecodeResult {
    pub ok: bool,
    pub buffer: Option<Buffer>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub error: Option<String>,
}

/// Backs [`raster_decode_rgb8_buf`] — mirrors
/// `raw-ffi/src/raster_v2.rs`'s `maple_raster_decode_rgb8_buf` (line 270):
/// decode, optionally auto-orient, then drop to interleaved RGB8 (alpha
/// composited away, grey expanded) via `RasterImage::into_rgb8`. Unlike the
/// C-ABI version this has no `NEED_LARGER_BUFFER`/probe-then-size dance to
/// reproduce — that optimization exists purely to avoid a bun:ffi double
/// decode (`native-raster-v2.ts`'s `rgb8SizeFromProbe`); a napi `Buffer`
/// return already avoids the caller-owned-buffer sizing problem the C ABI
/// has, so this decodes once and hands back a `Buffer` of exactly the right
/// size.
pub struct RasterDecodeTask {
    pub(crate) bytes: Vec<u8>,
    pub(crate) auto_orient: bool,
}

impl Task for RasterDecodeTask {
    type Output = RasterDecodeResult;
    type JsValue = RasterDecodeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let mut raster = match decode_raster(&self.bytes, None) {
            Ok(r) => r,
            Err(e) => {
                return Ok(RasterDecodeResult {
                    ok: false,
                    buffer: None,
                    width: None,
                    height: None,
                    error: Some(error_message("failed to decode raster", e)),
                });
            }
        };
        if self.auto_orient {
            raster.auto_orient();
        }
        let rgb = raster.into_rgb8();
        Ok(RasterDecodeResult {
            ok: true,
            buffer: Some(rgb.data.into()),
            width: Some(rgb.width),
            height: Some(rgb.height),
            error: None,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Decode `bytes` to native-size interleaved RGB8 (alpha dropped/composited,
/// grey expanded), optionally auto-orienting per the source's EXIF
/// orientation first. Resolves the same shape `rasterDecodeRgb8Buf` already
/// returns from the `bun:ffi` backend.
#[napi]
pub fn raster_decode_rgb8_buf(bytes: Buffer, auto_orient: bool) -> AsyncTask<RasterDecodeTask> {
    AsyncTask::new(RasterDecodeTask {
        bytes: bytes.to_vec(),
        auto_orient,
    })
}
