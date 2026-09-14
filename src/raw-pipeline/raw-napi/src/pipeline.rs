//! Raster pipeline (bitmap recipe) + analyze bindings (#3509 Task 5): the
//! single most important task in the whole plan — `raster_pipeline_buf` is
//! what `runPipeline` in `src/maple/src/builder-exec.ts` calls, which backs
//! `toBuffer()`/`toFile()` for every non-RAW-develop input. Blur, sharpen,
//! resize, composite and the rest of `@justmaple/maple`'s builder chain all
//! flow through this one operation, so a bug here would silently affect the
//! bulk of the package's actual sharp-parity surface once Task 7 wires it in.
//!
//! Mirrors `raw-ffi/src/raster_pipeline.rs`'s `maple_raster_pipeline_buf`
//! (line 34) and `raw-ffi/src/raster_analyze.rs`'s `maple_raster_analyze_buf`
//! (line 22) — but neither `raw_core::raster_recipe::parse_recipe` nor
//! `raw_core::raster_analyze::analyze` needs any JSON marshalling done at
//! this layer: `parse_recipe` already takes the recipe as a plain `&str` and
//! `analyze` already RETURNS its JSON reply as a plain `String` (built with
//! `serde_json::json!`/`Map` internally — see that function). So, unlike the
//! task brief's anticipation, this file adds no `serde_json` dependency to
//! `raw-napi`'s `Cargo.toml`: both raw-ffi C-ABI functions this ports do
//! their own JSON encode/decode entirely inside `raw-core`, and the recipe
//! JSON / aux sidecar / analyze request and reply all pass straight through
//! this crate as `String`/`Buffer` napi types with nothing left for this
//! layer to parse. (Recorded here so a later reader doesn't wonder where the
//! promised dependency went.)
//!
//! Both operations are CPU-bound (decode, run every op, encode; or decode
//! plus stats for analyze), so each is a `Task`/`AsyncTask`, per this
//! crate's established policy (see `lib.rs`'s module doc). Every JS-visible
//! outcome is `Ok({ ok: false, error })`, never a rejected `Promise` —
//! matching the `{ ok: boolean; ...; error?: string }` shapes
//! `rasterPipelineBuf` / `rasterAnalyzeBuf` already return from the
//! `bun:ffi` backend (`src/maple/src/native-raster-pipeline.ts`,
//! `src/maple/src/native-raster-analyze.ts`).

use napi::bindgen_prelude::*;
use napi_derive::napi;
use raw_core::raster_analyze::analyze;
use raw_core::raster_recipe::parse_recipe;
use raw_core::raster_recipe_exec::run_recipe;

/// Mirrors `RasterPipelineResult` in
/// `src/maple/src/native-raster-pipeline.ts` (lines 14-21): `{ ok: boolean;
/// buffer?: Buffer; width?: number; height?: number; channels?: number;
/// error?: string }`.
#[napi(object)]
pub struct RasterPipelineResult {
    pub ok: bool,
    pub buffer: Option<Buffer>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub channels: Option<u32>,
    pub error: Option<String>,
}

impl RasterPipelineResult {
    fn err(message: String) -> Self {
        Self {
            ok: false,
            buffer: None,
            width: None,
            height: None,
            channels: None,
            error: Some(message),
        }
    }
}

/// Backs [`raster_pipeline_buf`] — mirrors `raw-ffi/src/raster_pipeline.rs`'s
/// `maple_raster_pipeline_buf`: parse the recipe, run every op against
/// `input` (with `aux` as the flat side-car buffer any `AuxRef` in the
/// recipe indexes into — composite overlay pixels, a supplied ICC/EXIF
/// block), encode, return.
pub struct RasterPipelineBufTask {
    pub(crate) input: Vec<u8>,
    pub(crate) recipe_json: String,
    pub(crate) aux: Vec<u8>,
}

impl Task for RasterPipelineBufTask {
    type Output = RasterPipelineResult;
    type JsValue = RasterPipelineResult;

    fn compute(&mut self) -> Result<Self::Output> {
        let recipe = match parse_recipe(&self.recipe_json) {
            Ok(r) => r,
            Err(e) => return Ok(RasterPipelineResult::err(e.to_string())),
        };
        let result = match run_recipe(&recipe, &self.input, &self.aux) {
            Ok(r) => r,
            Err(e) => return Ok(RasterPipelineResult::err(e.to_string())),
        };
        Ok(RasterPipelineResult {
            ok: true,
            buffer: Some(result.bytes.into()),
            width: Some(result.width),
            height: Some(result.height),
            channels: Some(result.channels as u32),
            error: None,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Execute a bitmap recipe (schema v1, see `raw_core::raster_recipe`)
/// against `input`, with `aux` as the flat side-car buffer for any
/// composite-layer or ICC/EXIF bytes the recipe's ops reference. Resolves
/// the same shape `rasterPipelineBuf` already returns from the `bun:ffi`
/// backend. This is the entry point every non-RAW-develop `toBuffer()`/
/// `toFile()` call in `@justmaple/maple` goes through.
#[napi]
pub fn raster_pipeline_buf(
    input: Buffer,
    recipe_json: String,
    aux: Buffer,
) -> AsyncTask<RasterPipelineBufTask> {
    AsyncTask::new(RasterPipelineBufTask {
        input: input.to_vec(),
        recipe_json,
        aux: aux.to_vec(),
    })
}

/// Mirrors `RasterAnalyzeBinding`'s return type in
/// `src/maple/src/native-raster-analyze.ts` (lines 20-25): `{ ok: boolean;
/// json?: string; error?: string }`.
#[napi(object)]
pub struct RasterAnalyzeResult {
    pub ok: bool,
    pub json: Option<String>,
    pub error: Option<String>,
}

/// Backs [`raster_analyze_buf`] — mirrors `raw-ffi/src/raster_analyze.rs`'s
/// `maple_raster_analyze_buf`. `raw_core::raster_analyze::analyze` already
/// returns its reply as a JSON `String` (see the module doc), so unlike the
/// C-ABI version there is no `NEED_LARGER_BUFFER` retry dance to reproduce —
/// that exists purely to size a caller-owned C buffer, which a napi `String`
/// return has no equivalent of.
pub struct RasterAnalyzeBufTask {
    pub(crate) input: Vec<u8>,
    pub(crate) request_json: String,
}

impl Task for RasterAnalyzeBufTask {
    type Output = RasterAnalyzeResult;
    type JsValue = RasterAnalyzeResult;

    fn compute(&mut self) -> Result<Self::Output> {
        Ok(match analyze(&self.input, &self.request_json) {
            Ok(json) => RasterAnalyzeResult {
                ok: true,
                json: Some(json),
                error: None,
            },
            Err(e) => RasterAnalyzeResult {
                ok: false,
                json: None,
                error: Some(e.to_string()),
            },
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Answer a small JSON `request` (`{"v":1,"what":["metadata","stats"]}`)
/// about `input` with a small JSON reply — the read-only companion to
/// [`raster_pipeline_buf`]. Resolves the same shape `rasterAnalyzeBuf`
/// already returns from the `bun:ffi` backend.
#[napi]
pub fn raster_analyze_buf(input: Buffer, request_json: String) -> AsyncTask<RasterAnalyzeBufTask> {
    AsyncTask::new(RasterAnalyzeBufTask {
        input: input.to_vec(),
        request_json,
    })
}
