//! Legacy 8-bit sRGB render surface: `MapleRender`, `render_bytes`,
//! `render_bytes_sized`, plus the `as_shot_wb` As-Shot WB estimate shared
//! with every other render family in this crate (scene-linear fp16 in
//! `scene_linear.rs`, and — gpu-gated — `gpu_render.rs` / `web_live_session.rs`).
//! Split out of `lib.rs` (file-size budget) mirroring `raw-ffi`'s own
//! `render.rs`, which carries the same "legacy 8-bit sRGB entries"
//! grouping (`maple_render_file`, `maple_render_bytes`) for the C ABI.
//! `render_bytes_with_film`/`render_bytes_sized_with_film` moved out to
//! `render_film.rs` (#3182 — this file was at the file-budget ceiling and
//! the film variants needed no code here beyond `MapleRender::new`, already
//! `pub(crate)` for `gpu_render.rs`'s use).
//!
//! wasm-bindgen exports items regardless of which module declares them (see
//! `preview.rs`'s `extract_embedded_preview`, which has never needed a
//! crate-root re-export) — `MapleRender` and `as_shot_wb` ARE re-exported
//! from `lib.rs` anyway, but only so the existing `crate::MapleRender` /
//! `crate::as_shot_wb` paths in `gpu_render.rs`, `web_live_session.rs`, and
//! `tests.rs` keep compiling unchanged; the JS-facing API surface
//! (`render_bytes`, `render_bytes_sized`, `MapleRender`'s getters) is
//! byte-identical to before this split.

use raw_core::xmp as xmp_mod;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct MapleRender {
    width: u32,
    height: u32,
    full_width: u32,
    full_height: u32,
    rgb: Vec<u8>,
    as_shot_temperature: f32,
    as_shot_tint: f32,
    has_lens_corrections: bool,
    lens_correction_ca_inert: bool,
}

impl MapleRender {
    /// Internal constructor used by every render entry in this crate that
    /// isn't in THIS module (`gpu_render.rs`'s `render_bytes_gpu`,
    /// `render_film.rs`'s film-look siblings) — same-module entries
    /// (`render_bytes`, `render_bytes_sized`, `develop_non_raw` below) build
    /// the struct literal directly. Unconditional (not gpu/wasm32-gated,
    /// unlike before #3182): `render_film.rs`'s functions run in the default
    /// (gpu feature OFF) native-host test build too, so a cfg-gated ctor
    /// would leave them with no way to construct a `MapleRender` there. The
    /// GPU one-shot develops fit to a viewport target (#1080), so its caller
    /// passes the NATIVE oriented dims (`native_render_dims`) for `full_*`
    /// explicitly — the same contract `render_bytes_sized` fills (#1101).
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        width: u32,
        height: u32,
        full_width: u32,
        full_height: u32,
        rgb: Vec<u8>,
        as_shot_temperature: f32,
        as_shot_tint: f32,
        has_lens_corrections: bool,
        lens_correction_ca_inert: bool,
    ) -> Self {
        Self {
            width,
            height,
            full_width,
            full_height,
            rgb,
            as_shot_temperature,
            as_shot_tint,
            has_lens_corrections,
            lens_correction_ca_inert,
        }
    }
}

#[wasm_bindgen]
impl MapleRender {
    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.width
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Oriented dimensions a full-resolution render of the SAME RAW would
    /// produce (`raw_core::pipeline::native_render_dims`). Equal to
    /// `width`/`height` on the full-res entries; on `render_bytes_sized` they
    /// carry the native dims so the caller can do fit/100% zoom math while
    /// holding only a viewport-sized buffer (#1101).
    #[wasm_bindgen(getter)]
    pub fn full_width(&self) -> u32 {
        self.full_width
    }
    #[wasm_bindgen(getter)]
    pub fn full_height(&self) -> u32 {
        self.full_height
    }
    /// RGB bytes (3 per pixel). **Clones the full frame on every JS access**
    /// (the wasm-side buffer stays alive alongside the JS copy until `free()` /
    /// GC) — prefer the consuming [`MapleRender::take_rgb`] when the render is
    /// only read once (#1080).
    #[wasm_bindgen(getter)]
    pub fn rgb(&self) -> Vec<u8> {
        self.rgb.clone()
    }
    /// Consume the RGB buffer WITHOUT cloning: moves the bytes out to JS and
    /// leaves an empty buffer behind, so peak memory is one frame, not two
    /// (#1080). The scalar getters (`width`/`height`/As-Shot WB) stay valid
    /// after the take; a subsequent `rgb`/`take_rgb` returns an empty array.
    pub fn take_rgb(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.rgb)
    }
    /// Camera "As Shot" correlated colour temperature in Kelvin, in the WB
    /// slider frame (`dcp::estimate_as_shot_cct_tint` — the temperature at
    /// which the WB stage is an identity for this image). Seeds the UI's
    /// Temperature slider on a fresh open; display-only (#1892).
    #[wasm_bindgen(getter)]
    pub fn as_shot_temperature(&self) -> f32 {
        self.as_shot_temperature
    }
    /// Camera "As Shot" tint in slider units (±150, ACR's span), from the
    /// same frame-consistent estimate as `as_shot_temperature`. Seeds the
    /// UI's Tint slider on a fresh open; display-only (#1892).
    #[wasm_bindgen(getter)]
    pub fn as_shot_tint(&self) -> f32 {
        self.as_shot_tint
    }
    /// Whether this RAW carries a DNG `OpcodeList3` (`RawImage::has_lens_corrections`,
    /// #3182 — mirrors Apple's `EditSession.hasLensCorrections`). `false` for
    /// every non-DNG RAW and for `develop_non_raw`'s already-decoded input.
    /// Disables the web Lens Corrections panel when `false`.
    #[wasm_bindgen(getter)]
    pub fn has_lens_corrections(&self) -> bool {
        self.has_lens_corrections
    }
    /// Whether the CA slider is a structural no-op for this RAW —
    /// `RawImage::lens_correction_ca_inert`: true when there's no
    /// `WarpRectilinear` opcode, or every one carries a single (not
    /// per-plane) coefficient set. Mirrors Apple's `EditSession.lensCorrectionCaInert`.
    /// Meaningless (defaults `true`) whenever `has_lens_corrections` is `false`.
    #[wasm_bindgen(getter)]
    pub fn lens_correction_ca_inert(&self) -> bool {
        self.lens_correction_ca_inert
    }
}

/// As-shot `(temperature, tint)` in the WB SLIDER FRAME — the pair the app's
/// WB sliders display for an untouched image (#1892).
///
/// Delegates to `raw_core::color::dcp::estimate_as_shot_cct_tint`, the same
/// frame-consistent estimate the Apple decode export (#1781) hydrates
/// sliders from: `SliderFrame::scene_cct` plus the perpendicular-axis tint
/// projection of the scene illuminant — NOT the old log2(B/R) heuristic,
/// which on off-locus bodies disagreed with the render's identity point by
/// thousands of Kelvin and the whole tint range (test_0002, H2D-39: 7625 K /
/// 0 vs the frame's 5520 K / −144.4).
///
/// This value is for DISPLAY seeding only — the render paths leave a fresh
/// open at `AdjustmentModel::default()` so `wb_camera::resolve_target`'s
/// As-Shot sentinel makes the develop an exact no-op; pushing the estimate
/// into the model would round-trip it through the explicit-target math
/// instead (see `resolve_target`'s doc).
///
/// The estimator's `Result` is never `Err` in practice (every profile
/// resolver tier constructs `Ok`); the fallback keeps this total without a
/// second error path.
pub(crate) fn as_shot_wb(raw_img: &raw_core::image::RawImage) -> (f32, f32) {
    raw_core::color::dcp::estimate_as_shot_cct_tint(raw_img).unwrap_or_else(|_| {
        (
            raw_core::stages::white_balance::estimate_cct_from_neutral(raw_img.as_shot_neutral),
            0.0,
        )
    })
}

/// Render a RAW from bytes (WASM-friendly — no filesystem path needed).
///
/// `ext` is a lowercase file extension like `"dng"`, `"cr2"`, `"arw"` so
/// rawler can disambiguate formats when magic is ambiguous.
///
/// `xmp` is optional XMP sidecar content as a UTF-8 string (not a path).
/// When `xmp` is `None` the caller is opening a brand-new RAW (no prior
/// user adjustments): the model stays at `AdjustmentModel::default()`, whose
/// untouched `(6500, 0)` pair is `wb_camera::resolve_target`'s As-Shot
/// sentinel — the develop resolves it to the slider frame's own as-shot
/// point and white balance is an exact no-op. The frame-consistent as-shot
/// estimate rides the return value (`as_shot_temperature`/`as_shot_tint`)
/// purely so the UI can seed its sliders; it is deliberately NOT written
/// into the model, which would demote the exact sentinel into a
/// float-rounded explicit target (#1892 — the pre-fix push used a crude
/// log2(B/R) heuristic and shifted every fresh open).
///
/// Memory budget (#2661): a full-native-resolution CPU develop of a sensor
/// over [`crate::cpu_budget::FULL_DEVELOP_MAX_SENSOR_PX`] cannot fit the
/// 4 GiB wasm32 heap (9.2 GB measured peak on the 100 MP reference — the
/// alloc abort is an unrecoverable trap that poisons the instance). Such
/// sensors develop through the sized chain at the clamp instead; the
/// buffer's real dims ride `width`/`height` and the native dims
/// `full_width`/`full_height`, exactly like [`render_bytes_sized`].
#[wasm_bindgen]
pub fn render_bytes(raw: &[u8], ext: &str, xmp: Option<String>) -> Result<MapleRender, JsError> {
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);
    // #3182 — decode-time facts, not view-dependent, so both branches below
    // share the same pair.
    let has_lens_corrections = raw_img.has_lens_corrections();
    let lens_correction_ca_inert = raw_img.lens_correction_ca_inert();

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    // Export/display path: AMaZE by default (#940) — cost-equivalent to
    // bilinear since the tiled kernel (#1887) and matches the Apple
    // refine/export selection.
    let quality = raw_core::pipeline::RenderQuality::Amaze;
    let source = Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext });
    match crate::cpu_budget::clamp_develop_long_edge(raw_img.width, raw_img.height, None) {
        None => {
            let (w, h, bytes) = raw_core::pipeline::render_from_raw_with_quality_and_source(
                &raw_img, &model, quality, source,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(MapleRender {
                width: w,
                height: h,
                full_width: w,
                full_height: h,
                rgb: bytes,
                as_shot_temperature,
                as_shot_tint,
                has_lens_corrections,
                lens_correction_ca_inert,
            })
        }
        Some(cap) => {
            let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
            let (w, h, bytes) = raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
                &raw_img, &model, quality, source, cap,
            )
            .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(MapleRender {
                width: w,
                height: h,
                full_width,
                full_height,
                rgb: bytes,
                as_shot_temperature,
                as_shot_tint,
                has_lens_corrections,
                lens_correction_ca_inert,
            })
        }
    }
}

/// Sized variant of [`render_bytes`] — the display-encoded counterpart of the
/// Apple FFI's `maple_render_bytes_scene_linear_sized` sizing contract (#1101,
/// spec §5.1): develops through raw-core's early-downsample chain so every
/// post-demosaic stage runs on a buffer capped at `max_long_edge`, then runs
/// the IDENTICAL view tail (`render_sized_from_raw_with_quality_and_source`
/// shares its body with the unsized entry). Never upscales — a cap at or
/// above the native long edge renders byte-identically to [`render_bytes`].
///
/// `quality_preview = true` runs the half-res Preview demosaic (the web
/// fast-phase cost profile, matching Apple's editor first paint); `false`
/// runs AMaZE (the refine phase; the full-quality default since #940).
/// `max_long_edge` must be > 0.
///
/// The returned [`MapleRender`] carries the sized buffer in `width`/`height`
/// and the NATIVE oriented dims in `full_width`/`full_height`
/// (`native_render_dims`), so the editor can do fit/100% zoom math without a
/// full-res decode.
#[wasm_bindgen]
pub fn render_bytes_sized(
    raw: &[u8],
    ext: &str,
    xmp: Option<String>,
    quality_preview: bool,
    max_long_edge: u32,
) -> Result<MapleRender, JsError> {
    if max_long_edge == 0 {
        return Err(JsError::new(
            "render_bytes_sized: max_long_edge must be > 0",
        ));
    }
    let raw_img =
        raw_core::decode::decode_bytes(raw, ext).map_err(|e| JsError::new(&e.to_string()))?;

    // As-shot derivation — IDENTICAL to `render_bytes` so a sized cold open
    // seeds the same sliders. Display-only; a fresh open renders at the
    // As-Shot sentinel, never at a pushed pair (#1892 — see `render_bytes`).
    let (as_shot_temperature, as_shot_tint) = as_shot_wb(&raw_img);
    let has_lens_corrections = raw_img.has_lens_corrections(); // #3182
    let lens_correction_ca_inert = raw_img.lens_correction_ca_inert();

    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };

    let quality = if quality_preview {
        raw_core::pipeline::RenderQuality::Preview
    } else {
        // Full-quality path: AMaZE by default (#940).
        raw_core::pipeline::RenderQuality::Amaze
    };
    // #2661: clamp the request so the develop fits the 4 GiB wasm32 heap —
    // a cap near the native long edge of a >32 MP sensor otherwise runs the
    // full-res demosaic branch and aborts the instance (7.2 GB measured at
    // cap 8192 on the 100 MP reference).
    let effective_long_edge = crate::cpu_budget::clamp_develop_long_edge(
        raw_img.width,
        raw_img.height,
        Some(max_long_edge),
    )
    .unwrap_or(max_long_edge);
    let (full_width, full_height) = raw_core::pipeline::native_render_dims(&raw_img);
    let (w, h, bytes) = raw_core::pipeline::render_sized_from_raw_with_quality_and_source(
        &raw_img,
        &model,
        quality,
        Some(raw_core::pipeline::RawInput::Bytes { bytes: raw, ext }),
        effective_long_edge,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(MapleRender {
        width: w,
        height: h,
        full_width,
        full_height,
        rgb: bytes,
        as_shot_temperature,
        as_shot_tint,
        has_lens_corrections,
        lens_correction_ca_inert,
    })
}

/// Develop an already browser-decoded non-RAW (jpg/png/heic/webp/…) image
/// through the per-tick adjustment chain and encode the result to display
/// sRGB u8 RGB (#3039).
///
/// This is the Web mirror of Apple's `ImageEditPipeline.processSceneLinearNonRaw`
/// / `applyChainAndEncodeViaFusedFFI(skipAgX: true, decodedTemperature: 6500,
/// decodedTint: 0, …)`: `render_bytes`/`render_bytes_sized` above take RAW
/// FILE bytes and run them through `raw_core::decode::decode_bytes`, which
/// only understands sensor RAW formats — there is no path from there to a
/// developed JPEG. Before this entry existed, the caller
/// (`RawPipelineService.decode()`) special-cased non-RAW extensions to a
/// pure `createImageBitmap` + 2D-canvas readback with NO adjustment model
/// applied at all — correct for the FIRST paint, but every later slider tick
/// re-ran the exact same unadjusted decode, silently dropping every edit
/// (#3039). That gap never touched this crate, which is why it produced no
/// worker/WASM activity to debug.
///
/// `in_f32_rgba` is NOT a file's bytes — it is the caller's own
/// sRGB→linear→Rec.2020 conversion of the already browser-decoded pixels
/// (`decodeNonRawToSceneLinearF32` on the Web side), packed f32 RGBA,
/// row-major, 4 lanes/pixel, alpha ignored — the same layout
/// `apply_scene_linear_chain_f32` / `encode_display_srgb_f32` already
/// document and that `RenderActor.renderPreview`'s non-RAW branch feeds on
/// Apple (there via `decodeSceneLinearNonRaw` + CoreImage instead of a
/// browser canvas, same colour math).
///
/// `skip_agx: true` always: non-RAW input is already display-tone-mapped by
/// whatever camera or renderer produced it, so running it through AgX (a
/// scene-referred view transform) would double-tone-map — see
/// `ChainOptions::skip_agx`'s doc and `processSceneLinearNonRaw`'s comment
/// for the same reasoning on Apple. The WB baseline is fixed at the decode
/// default (6500 K / 0 tint) — a developed image carries no camera As-Shot
/// metadata, so (like Apple) the WB slider's own default IS the identity
/// point.
///
/// Returns the SAME `MapleRender` shape `render_bytes` does (u8 RGB, full
/// size == develop size — there is no separate "native" size for an
/// already-decoded buffer), so the worker's existing `decode-success` /
/// `take_rgb()` / `free()` handling needs no changes to consume this.
#[wasm_bindgen]
pub fn develop_non_raw(
    in_f32_rgba: &[f32],
    width: u32,
    height: u32,
    xmp: Option<String>,
) -> Result<MapleRender, JsError> {
    let model = match xmp {
        Some(x) => xmp_mod::parse(&x).map_err(|e| JsError::new(&e.to_string()))?,
        None => xmp_mod::AdjustmentModel::default(),
    };
    let opts = raw_core::pipeline::ChainOptions {
        skip_agx: true,
        ..Default::default()
    };
    let chained = raw_core::pipeline::apply_scene_linear_chain_f32(
        in_f32_rgba,
        width,
        height,
        &model,
        &opts,
    )
    .map_err(|e| JsError::new(&e.to_string()))?;
    let encoded = raw_core::pipeline::encode_display_srgb_f32(&chained, width, height)
        .map_err(|e| JsError::new(&e.to_string()))?;

    // Pack sRGB-gamma-encoded f32 [0,1] RGBA -> u8 RGB (drop alpha), matching
    // every other entry in this file's `MapleRender.rgb` contract.
    let mut rgb = Vec::with_capacity((width as usize) * (height as usize) * 3);
    for px in encoded.chunks_exact(4) {
        rgb.push(f32_unit_to_u8(px[0]));
        rgb.push(f32_unit_to_u8(px[1]));
        rgb.push(f32_unit_to_u8(px[2]));
    }
    Ok(MapleRender {
        width,
        height,
        full_width: width,
        full_height: height,
        rgb,
        as_shot_temperature: 6500.0,
        as_shot_tint: 0.0,
        // #3182: an already browser-decoded non-RAW image carries no DNG
        // OpcodeList3 — the Lens Corrections panel is disabled for it, same
        // as Apple's `EditSession` default.
        has_lens_corrections: false,
        lens_correction_ca_inert: true,
    })
}

/// Clamp-and-round a display-encoded [0,1] f32 lane to a u8 byte.
fn f32_unit_to_u8(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}
