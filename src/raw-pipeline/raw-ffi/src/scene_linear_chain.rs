//! Per-tick scene-linear chain (Option C) — collapses the duplicate
//! Apple-Metal kernel chain (WB → tone → vibrance → saturation →
//! clarity → texture → dehaze → nr_luminance → AgX) into a single FFI
//! call into the canonical Rust implementation.
//!
//! Sharpen + nr_color stay on the GPU (Metal compute) — they're too
//! expensive on CPU to hit the per-tick budget. Everything else has CPU
//! cost <2ms at viewport size and runs here so Rust is the single
//! source of truth for those algorithms.
//!
//! Caller-provided input and output buffers. Note: the FFI entry itself
//! is a thin shim, but `raw_core::pipeline::apply_scene_linear_chain`
//! currently returns an owned `Vec<u16>` that we `copy_from_slice` into
//! `out_ptr` — so there is one intermediate heap allocation of
//! `8 * width * height` bytes per call. Removing it requires refactoring
//! the raw-core entry to write into a caller-provided slice and is
//! tracked separately. Input and output are both packed fp16 RGBA
//! (8 bytes/pixel),
//! `extendedLinearITUR_2020` scene-linear, straight alpha. Output is
//! post-AgX (display-linear Rec.2020) when `skip_agx == 0`, scene-linear
//! when non-zero. The `skip_agx` flag exists for the non-RAW path:
//! HEIF / JPEG / PNG / screenshot input is already display-encoded, so
//! AgX would double-tone-map (white compresses to ~0.82). See
//! `processSceneLinearNonRaw` in `ImageEditPipeline.swift` for the
//! matching commit `4a8c655`.

use crate::error::set_last_error;

/// C-ABI mirror of the slider subset that the per-tick chain consumes.
/// Kept flat (all f32) so cbindgen / Swift's `@_silgen_name` import
/// produce a layout-compatible struct on both sides.
///
/// Field order matches the Swift `MapleAdjustmentParams` initialiser at
/// `PipelineRenderer.swift::makeAdjustmentParams` byte-for-byte —
/// changing the order here means changing it there.
#[repr(C)]
pub struct MapleAdjustmentParams {
    pub temperature: f32,
    pub tint: f32,
    pub exposure: f32,
    pub contrast: f32,
    pub highlights: f32,
    pub shadows: f32,
    pub whites: f32,
    pub blacks: f32,
    pub vibrance: f32,
    pub saturation: f32,
    pub clarity: f32,
    pub texture: f32,
    pub nr_luminance: f32,
    pub dehaze: f32,
    pub decoded_temperature: f32,
    pub decoded_tint: f32,
    /// 1 = skip the AgX view transform (non-RAW path: input is already
    /// display-encoded). 0 = apply AgX (RAW path).
    pub skip_agx: u32,
    /// User-selectable display Look (ticket #515). The byte is mapped
    /// through `raw_core::view::look::Look::from(u8)`:
    ///   - `0` = `Look::Neutral`  (identity, scene-referred output)
    ///   - `1` = `Look::Default`  (empirical LUT — new-user default)
    /// Hosts that have not been updated yet leave this at `1` (the
    /// `AdjustmentModel::default()` Look).
    ///
    /// Placed at the end of the struct so adding the field does not shift
    /// the offset of any earlier field — the FFI ABI for existing fields
    /// stays binary-compatible with pre-#515 callers that re-bind to the
    /// new header.
    pub look_mode: u8,
    /// Brightness — scene-linear midtone-band gain, `[-100, 100]` (#1102,
    /// tone/zoom design § 4.1). Runs inside `scene_tone_controls` between
    /// exposure and highlights. Appended at the end (after `look_mode`)
    /// per the same offset-stable ABI convention; a pre-#1102 caller that
    /// re-binds to the new header leaves it 0 = identity.
    pub brightness: f32,
    /// Vignette amount — scene-linear radial EV gain, `[-100, 100]`
    /// (#1109, tone/zoom design § 10.1); negative darkens corners. Runs
    /// after `local_adjustments`, before the (omitted) sharpen. Appended
    /// at the struct tail per the offset-stable ABI convention; an un-set
    /// tail field reads 0 = identity.
    pub vignette_amount: f32,
    /// Vignette feather — mask transition softness, `[0, 100]` (#1109).
    /// Inert while `vignette_amount` is 0 (the stage short-circuits), so
    /// the 0 a stale caller leaves here is harmless; live hosts pass the
    /// model's value (default 50).
    pub vignette_feather: f32,
    /// Film grain (#1110, tone/zoom design § 10.2) — display-linear
    /// deterministic noise, applied with AgX (skipped together on the
    /// non-RAW `skip_agx` path). Appended at the struct tail per the
    /// offset-stable ABI convention; un-set amount reads 0 = identity
    /// (size / roughness inert at amount 0).
    pub grain_amount: f32,
    pub grain_size: f32,
    pub grain_roughness: f32,
    /// Split toning (#1111, tone/zoom design § 10.3) — display-linear
    /// Oklab tint, applied with AgX (post-AgX, before grain; skipped
    /// together on the non-RAW `skip_agx` path). Appended at the struct
    /// tail; un-set saturations read 0 = identity (hues / balance inert
    /// at zero saturation).
    pub split_tone_shadow_hue: f32,
    pub split_tone_shadow_saturation: f32,
    pub split_tone_highlight_hue: f32,
    pub split_tone_highlight_saturation: f32,
    pub split_tone_balance: f32,
    // --- HSL 8-band adjustments (#1112) — scene-linear Oklab; appended at
    //     the tail, un-set reads 0 = identity. ---
    pub hsl_hue_red: f32,
    pub hsl_hue_orange: f32,
    pub hsl_hue_yellow: f32,
    pub hsl_hue_green: f32,
    pub hsl_hue_aqua: f32,
    pub hsl_hue_blue: f32,
    pub hsl_hue_purple: f32,
    pub hsl_hue_magenta: f32,
    pub hsl_sat_red: f32,
    pub hsl_sat_orange: f32,
    pub hsl_sat_yellow: f32,
    pub hsl_sat_green: f32,
    pub hsl_sat_aqua: f32,
    pub hsl_sat_blue: f32,
    pub hsl_sat_purple: f32,
    pub hsl_sat_magenta: f32,
    pub hsl_lum_red: f32,
    pub hsl_lum_orange: f32,
    pub hsl_lum_yellow: f32,
    pub hsl_lum_green: f32,
    pub hsl_lum_aqua: f32,
    pub hsl_lum_blue: f32,
    pub hsl_lum_purple: f32,
    pub hsl_lum_magenta: f32,
    // --- target display primaries — view-tail display_encode matrix (#1337).
    //     Appended at the struct tail per the offset-stable ABI convention; a
    //     pre-#1337 caller that re-binds to the new header leaves this at 0 =
    //     sRGB (legacy-compatible default, bit-identical output). 1 = Display P3
    //     (SMPTE RP 431-2, D65 white point). The OETF is unchanged for both. ---
    pub target_primaries: u32,
    /// Input shape tag (#1331): 0 = PostDcpRec2020Fp16 (RAW, historic default),
    /// 1 = LinearRec2020Fp16 (pano PNG — WB stays engaged with decoded=6500/0),
    /// 2 = SrgbGammaEncoded8 (JPEG/HEIF — CPU pre-pass done at session open).
    /// Appended at the struct tail AFTER `target_primaries`; a stale host leaves
    /// it 0 = RAW.
    pub input_shape: u32,
    /// Per-camera noise profile from the decoded `RawImage` (PR #1709 review
    /// finding). When non-null and `noise_profile_len > 0`, the Rust NR stage
    /// uses the profile for scene-noise-adaptive sigma estimation instead of
    /// the ISO-only fallback. A stale host that never sets this field leaves
    /// the pointer NULL and len 0, which the Rust side maps to `None`
    /// (identical to the pre-fix behaviour). Appended at the struct tail
    /// AFTER `input_shape` per the offset-stable ABI convention.
    ///
    /// The pointed-to data must remain valid for the duration of the FFI call.
    /// The Rust side does NOT free this pointer.
    pub noise_profile_ptr: *const f32,
    /// Number of f32 elements pointed to by `noise_profile_ptr`. 0 when no
    /// profile is available (treated identically to a null pointer).
    pub noise_profile_len: u32,
    /// ISO speed at capture from `RawImage::iso`. 0 is treated as 100 on the
    /// Rust side (the pre-fix hardcoded fallback). A stale host leaves this 0.
    pub iso: u32,
    // --- WB slider frame (#1781) — the decode-exported `SliderFrame` data
    //     (`MapleSceneLinearBufferF32.wb_frame_*`, passed back verbatim by the
    //     host). When present (`wb_frame_scene_cct > 0`) the chain derives its
    //     WB delta in the SAME camera-calibration frame the develop chain
    //     interprets the sliders in, closing the live-vs-refine WB seam.
    //     Appended at the struct tail per the offset-stable ABI convention: a
    //     stale host leaves all six fields 0 ⇒ frame absent ⇒ the legacy
    //     generic CAT16 delta, bit-identical to pre-#1781 output. ---
    /// Cold calibration endpoint (XYZ→camera), row-major 3×3.
    pub wb_frame_m_cold: [f32; 9],
    pub wb_frame_cct_cold: f32,
    /// Warm calibration endpoint (XYZ→camera), row-major 3×3. Equal to the
    /// cold endpoint (with equal CCTs) for a single-calibration frame.
    pub wb_frame_m_warm: [f32; 9],
    pub wb_frame_cct_warm: f32,
    /// The frame's as-shot CCT — the slider's identity temperature. 0 ⇒ the
    /// whole frame block is absent.
    pub wb_frame_scene_cct: f32,
    /// The frame's as-shot tint (in-frame estimate).
    pub wb_frame_as_shot_tint: f32,
}

/// Rebuild the raw-core [`raw_core::stages::wb_camera::SliderFrameExport`]
/// from the six flat `wb_frame_*` fields (#1781). An absent frame
/// (`scene_cct <= 0`, e.g. a zero-initialised stale host) maps to
/// `SliderFrameExport::ABSENT`, whose `is_present()` is false — consumers
/// then keep the legacy generic-CAT16 path.
pub(crate) fn wb_frame_from_flat(
    m_cold: &[f32; 9],
    cct_cold: f32,
    m_warm: &[f32; 9],
    cct_warm: f32,
    scene_cct: f32,
    as_shot_tint: f32,
) -> raw_core::stages::wb_camera::SliderFrameExport {
    let mat = |m: &[f32; 9]| {
        raw_core::math::Matrix3([[m[0], m[1], m[2]], [m[3], m[4], m[5]], [m[6], m[7], m[8]]])
    };
    raw_core::stages::wb_camera::SliderFrameExport {
        m_cold: mat(m_cold),
        cct_cold,
        m_warm: mat(m_warm),
        cct_warm,
        scene_cct,
        as_shot_tint,
    }
}

/// Run the cheap-stage scene-linear chain over a caller-provided fp16 RGBA
/// buffer. Returns 0 on success, non-zero on error (call `maple_last_error`).
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `8 * width * height` bytes (= `4 * width * height` fp16 lanes). The
/// caller owns both buffers. This entry does not free anything, but does
/// perform one intermediate heap allocation of the same size as the output
/// buffer (the wrapped `raw_core` entry returns an owned `Vec<u16>` which
/// is then copied into `out_ptr`).
/// `out_ptr` may alias `in_ptr` only if the caller is willing to lose the
/// input on error — current implementation copies the result at the end
/// so partial in-place is safe but partial-write semantics are undefined
/// on error. Recommend distinct buffers.
///
/// `params` must be a valid pointer to a `MapleAdjustmentParams` struct
/// the caller owns for the duration of this call.
#[no_mangle]
pub unsafe extern "C" fn maple_apply_scene_linear_chain(
    in_ptr: *const u16,
    width: u32,
    height: u32,
    params: *const MapleAdjustmentParams,
    out_ptr: *mut u16,
) -> i32 {
    if in_ptr.is_null() || params.is_null() || out_ptr.is_null() {
        set_last_error("apply_scene_linear_chain: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "apply_scene_linear_chain: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    // checked_mul (not saturating_mul) — on overflow we want to bail with
    // an error rc, not return usize::MAX and feed that to from_raw_parts
    // (UB). The RGBA byte product `width * height * 4` reaches ~2^66 at
    // max u32 inputs, which DOES overflow a 64-bit usize (max 2^64-1) —
    // so the checked_mul guards are required, not defensive padding. The
    // earlier `width == 0 || height == 0` short-circuit already returned
    // before we get here, so the lanes computation can only land on a
    // strictly positive value or `None` (overflow).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "apply_scene_linear_chain: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };
    let p = &*params;

    // Build an AdjustmentModel from the C-ABI params. Fields the chain
    // uses get copied across; sharpen + nr_color stay default (they're
    // applied on the GPU after this call returns) and other fields keep
    // the AdjustmentModel::default() values so this matches the Rust
    // pipeline's behavior on the cheap-stage subset.
    let mut model = raw_core::xmp::AdjustmentModel::default();
    model.temperature = p.temperature;
    model.tint = p.tint;
    // FFI-supplied temperature and tint are ALWAYS explicit user state — the
    // Apple host serialises its live in-memory model and passes the values it
    // intends the pipeline to use verbatim.  Set both seen-flags to true so
    // `white_balance::resolve_wb` passes the values through unchanged.
    //
    // Without this, `resolve_wb` would fall through to its neither-seen branch
    // and compute `effective_tint = 0.0` regardless of the tint the host
    // supplied — zeroing any tint the user dialled in on every CPU refine render
    // while the GPU-live path applied it correctly, producing the horizontal
    // band visible when a refined region's WB differed from the live frame.
    // (#1725 / #1729)
    model.temperature_seen = true;
    model.tint_seen = true;
    model.exposure = p.exposure;
    model.brightness = p.brightness;
    model.contrast = p.contrast;
    model.highlights = p.highlights;
    model.shadows = p.shadows;
    model.whites = p.whites;
    model.blacks = p.blacks;
    model.vibrance = p.vibrance;
    model.saturation = p.saturation;
    model.clarity = p.clarity;
    model.texture = p.texture;
    model.nr_luminance = p.nr_luminance;
    model.dehaze = p.dehaze;
    model.vignette_amount = p.vignette_amount;
    model.vignette_feather = p.vignette_feather;
    model.grain_amount = p.grain_amount;
    model.grain_size = p.grain_size;
    model.grain_roughness = p.grain_roughness;
    model.split_tone_shadow_hue = p.split_tone_shadow_hue;
    model.split_tone_shadow_saturation = p.split_tone_shadow_saturation;
    model.split_tone_highlight_hue = p.split_tone_highlight_hue;
    model.split_tone_highlight_saturation = p.split_tone_highlight_saturation;
    model.split_tone_balance = p.split_tone_balance;
    // HSL 8-band adjustments (#1112)
    model.hue_adjustment_red = p.hsl_hue_red;
    model.hue_adjustment_orange = p.hsl_hue_orange;
    model.hue_adjustment_yellow = p.hsl_hue_yellow;
    model.hue_adjustment_green = p.hsl_hue_green;
    model.hue_adjustment_aqua = p.hsl_hue_aqua;
    model.hue_adjustment_blue = p.hsl_hue_blue;
    model.hue_adjustment_purple = p.hsl_hue_purple;
    model.hue_adjustment_magenta = p.hsl_hue_magenta;
    model.saturation_adjustment_red = p.hsl_sat_red;
    model.saturation_adjustment_orange = p.hsl_sat_orange;
    model.saturation_adjustment_yellow = p.hsl_sat_yellow;
    model.saturation_adjustment_green = p.hsl_sat_green;
    model.saturation_adjustment_aqua = p.hsl_sat_aqua;
    model.saturation_adjustment_blue = p.hsl_sat_blue;
    model.saturation_adjustment_purple = p.hsl_sat_purple;
    model.saturation_adjustment_magenta = p.hsl_sat_magenta;
    model.luminance_adjustment_red = p.hsl_lum_red;
    model.luminance_adjustment_orange = p.hsl_lum_orange;
    model.luminance_adjustment_yellow = p.hsl_lum_yellow;
    model.luminance_adjustment_green = p.hsl_lum_green;
    model.luminance_adjustment_aqua = p.hsl_lum_aqua;
    model.luminance_adjustment_blue = p.hsl_lum_blue;
    model.luminance_adjustment_purple = p.hsl_lum_purple;
    model.luminance_adjustment_magenta = p.hsl_lum_magenta;
    model.look = raw_core::view::look::Look::from(p.look_mode);

    // Non-RAW WB contract (#1331 / #1734): for a non-RAW shape the uploaded
    // buffer is ALREADY at the correct linear Rec.2020 D65 white point (the
    // 8-bit JPEG/HEIF path was linearised at session open; the 16-bit pano
    // path was never WB-encoded) — there is no "as-shot" anchor to preserve,
    // only the D65 baseline. So the temp/tint sliders apply as a DELTA off
    // D65 (`decoded = 6500.0/0.0`), the SAME contract the GPU-live chain's
    // `inputs_from_params` uses when the host supplies a decoded anchor:
    // `M_net = wb(live) · wb(6500, 0)⁻¹`, identity at the default slider
    // position, shifting correctly as the user drags temp/tint.
    //
    // Earlier this branch collapsed the delta to IDENTITY outright
    // (`decoded = (p.temperature, p.tint)`, forcing `live == decoded`
    // unconditionally) — that made the temp/tint sliders permanently inert
    // on this CPU refine path regardless of the GPU-live half of the fix,
    // which is worse than the original drag-time-pop bug: a drag would shift
    // the image live on the GPU chain then SNAP BACK to unshifted on the next
    // CPU refine tick. Anchoring to D65 here instead keeps both paths
    // agreeing on the same delta at every slider position.
    //
    // Scoped to non-RAW only (`p.input_shape != 0`): RAW callers (shape 0)
    // keep the pre-existing `decoded_temperature`/`decoded_tint` passthrough
    // unchanged — the as-shot-anchored behavior legacy/headless RAW callers
    // depend on (Copilot review on #1262) is untouched by this fix.
    let (decoded_temp, decoded_tint) = if p.input_shape == 0 {
        (p.decoded_temperature, p.decoded_tint)
    } else {
        (6500.0, 0.0)
    };

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    // Map the `target_primaries` u32 tag (#1337): 0 = sRGB (legacy / zero-init
    // default), 1 = Display P3.  Any other value falls back to sRGB —
    // matches the GPU-path convention (`Look::from` / `WbMethod` pattern).
    let primaries = raw_core::view::encode::TargetPrimaries::from_u32(p.target_primaries);

    // Decode the optional noise profile. `noise_profile_len == 0` or a null
    // pointer means "no profile" — pass `None` to the Rust chain so it falls
    // back to the ISO-based estimate (the pre-#1709 behaviour). When the host
    // provides a valid pointer + non-zero length, reconstruct a slice and
    // pass it through. The slice lifetime is bounded by this FFI call (the
    // host-owned buffer outlives the function call).
    let noise_profile_slice: Option<&[f32]> =
        if p.noise_profile_ptr.is_null() || p.noise_profile_len == 0 {
            None
        } else {
            // SAFETY: the caller guarantees the pointer is valid and aligned
            // for `noise_profile_len` f32 values for the duration of this call.
            Some(unsafe {
                std::slice::from_raw_parts(p.noise_profile_ptr, p.noise_profile_len as usize)
            })
        };
    let iso = if p.iso == 0 { 100 } else { p.iso };

    // WB slider frame (#1781): RAW shapes only — a non-RAW buffer has no
    // camera calibration and its D65-anchored delta stays on the generic
    // path. An absent frame (zeros) is `!is_present()` ⇒ legacy behaviour.
    let wb_frame = wb_frame_from_flat(
        &p.wb_frame_m_cold,
        p.wb_frame_cct_cold,
        &p.wb_frame_m_warm,
        p.wb_frame_cct_warm,
        if p.input_shape == 0 {
            p.wb_frame_scene_cct
        } else {
            0.0
        },
        p.wb_frame_as_shot_tint,
    );

    let out_vec = match raw_core::pipeline::apply_scene_linear_chain(
        in_slice,
        width,
        height,
        &model,
        decoded_temp,
        decoded_tint,
        Some(&wb_frame),
        p.skip_agx != 0,
        primaries,
        noise_profile_slice,
        iso,
    ) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("apply_scene_linear_chain: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "apply_scene_linear_chain: chain returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}

/// f32 sibling of [`maple_apply_scene_linear_chain`]. Identical semantics
/// (same stage order, same `MapleAdjustmentParams` struct, same error
/// codes) — the only difference is the buffer surface: input and output
/// are both packed f32 RGBA, row-major, 4 lanes per pixel
/// (`bytes_per_pixel = 16`).
///
/// Added in #487 to unblock the Apple end-to-end f32 migration: with the
/// fp16 entry, an f32 scene buffer would silently round-trip back to fp16
/// every slider tick, defeating the precision win of #482. New callers
/// holding a f32 scene buffer should prefer this entry.
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `16 * width * height` bytes (= `4 * width * height` f32 lanes). The
/// caller owns both buffers. Like the fp16 sibling this entry performs
/// one intermediate heap allocation of the same size as the output
/// buffer (the wrapped `raw_core` entry returns an owned `Vec<f32>`
/// which is then copied into `out_ptr`).
///
/// Returns 0 on success, non-zero on error (call `maple_last_error`).
// f32 chain entry lives in a sibling module (file-size budget); the
// `#[no_mangle]` symbol is unaffected by module placement.
#[path = "scene_linear_chain_f32_entry.rs"]
mod scene_linear_chain_f32_entry;
pub use scene_linear_chain_f32_entry::*;

/// Apply the canonical display **encode** to a post-AgX **display-linear
/// Rec.2020** f32 RGBA buffer: hue-preserving Oklab gamut compression
/// (`rec2020_to_srgb`, #438) followed by `srgb_gamma_encode`. Returns
/// **sRGB-gamma-encoded sRGB-primary** f32 RGBA.
///
/// This is the exact pair of view-encode stages the CPU/CLI reference runs
/// between AgX and the Auto Profile cube (`agx → rec2020_to_srgb →
/// srgb_gamma_encode → auto_profile`). The Apple canvas previously reached
/// sRGB implicitly at the CoreImage `createCGImage` boundary, which does a
/// per-channel clamp of the Rec.2020→sRGB matrix output — NOT the Oklab
/// chroma compression — so saturated wide-gamut greens clipped and diverged
/// from the reference (#871 / #877). Routing the Apple encode through this
/// entry makes the canvas gamut-correct by construction (it shares raw-core's
/// reference math), and lands the buffer in the [0,1]³ sRGB-gamma-encoded
/// sRGB-primary space the Auto Profile cube was fit/baked in, so the cube
/// applies on the matching domain.
///
/// `in_ptr` and `out_ptr` MUST point to buffers of size
/// `16 * width * height` bytes (= `4 * width * height` f32 lanes). The caller
/// owns both buffers. Like the chain entries this performs one intermediate
/// heap allocation of the output size (the wrapped `raw_core` entry returns
/// an owned `Vec<f32>` copied into `out_ptr`). `out_ptr` may alias `in_ptr`.
///
/// Returns 0 on success, non-zero on error (call `maple_last_error`).
#[no_mangle]
pub unsafe extern "C" fn maple_encode_display_srgb_f32(
    in_ptr: *const f32,
    width: u32,
    height: u32,
    out_ptr: *mut f32,
) -> i32 {
    if in_ptr.is_null() || out_ptr.is_null() {
        set_last_error("encode_display_srgb_f32: null pointer".into());
        return 1;
    }
    if width == 0 || height == 0 {
        set_last_error(format!(
            "encode_display_srgb_f32: zero dimension width={} height={}",
            width, height
        ));
        return 2;
    }
    // Same checked-multiply guards as the chain entries — at u32::MAX dims the
    // RGBA lane product is ~2^66, which exceeds 64-bit usize. Without the
    // guards the unchecked product would wrap and feed nonsense to
    // from_raw_parts (UB).
    let lanes = match (width as usize)
        .checked_mul(height as usize)
        .and_then(|p| p.checked_mul(4))
    {
        Some(n) => n,
        None => {
            set_last_error(format!(
                "encode_display_srgb_f32: pixel-count overflow width={} height={}",
                width, height
            ));
            return 3;
        }
    };

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);

    let out_vec = match raw_core::pipeline::encode_display_srgb_f32(in_slice, width, height) {
        Ok(v) => v,
        Err(e) => {
            set_last_error(format!("encode_display_srgb_f32: {}", e));
            return 8;
        }
    };
    if out_vec.len() != lanes {
        set_last_error(format!(
            "encode_display_srgb_f32: encode returned {} lanes, expected {}",
            out_vec.len(),
            lanes
        ));
        return 9;
    }

    let out_slice = std::slice::from_raw_parts_mut(out_ptr, lanes);
    out_slice.copy_from_slice(&out_vec);
    0
}
