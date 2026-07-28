//! Per-tick scene-linear chain (Option C) — collapses the duplicate
//! Apple-Metal kernel chain (WB → tone → vibrance → saturation →
//! clarity → texture → dehaze → nr_luminance → AgX) into a single FFI
//! call into the canonical Rust implementation.
//!
//! Sharpen + nr_color used to stay on the Apple side's own Metal compute
//! kernels because they're too expensive on CPU to hit the per-tick
//! budget. Those kernels were deleted in #1043 (epic #925 P5b) — the
//! wgpu/WGSL chain is the shipping GPU path now — so this chain carries
//! them too, and Rust is the single source of truth for every stage in
//! the chain rather than all-but-two.
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
    /// after `local_adjustments`, before `sharpen`. Appended
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
    /// The RENDER PROFILE's CM (row-major 3×3, XYZ→camera — the
    /// conjugation basis the post-DCP WB delta is built in (#1904
    /// GPU-live seam fix) when the #1967 fields below are absent. Zero ⇒
    /// host predates #1904.
    pub wb_frame_render_cm: [f32; 9],
    // --- #1967: render-profile linear-core detail, enabling an EXACT
    //     per-target/per-anchor conjugation basis instead of the single
    //     fixed `wb_frame_render_cm`. Appended at the struct tail per the
    //     offset-stable ABI convention: a stale host leaves every field
    //     below 0/absent ⇒ the #1904 fixed-C fallback, bit-identical
    //     output (asserted by `zero_frame_params_reproduce_legacy_wb_matrix`). ---
    /// `profile.forward_matrix`, row-major 3×3. All-zero ⇒ `None`.
    pub wb_frame_render_forward_matrix: [f32; 9],
    /// `profile.scene_white_xyz`, Y-normalized.
    pub wb_frame_render_scene_white_xyz: [f32; 3],
    /// `profile.wb_already_baked` as a 0.0/1.0 flag.
    pub wb_frame_render_wb_already_baked: f32,
    /// Render profile's own dual-illuminant CM pair (distinct from
    /// `wb_frame_m_cold`/`wb_frame_m_warm` above, which are the VALUE
    /// frame's). `wb_frame_render_cct_warm - wb_frame_render_cct_cold <
    /// 1.0` ⇒ absent (single-illuminant render profile).
    pub wb_frame_render_cm_cold: [f32; 9],
    pub wb_frame_render_cct_cold: f32,
    pub wb_frame_render_cm_warm: [f32; 9],
    pub wb_frame_render_cct_warm: f32,
    /// Render profile's FM pair (optional per side per the DNG spec).
    /// All-zero ⇒ that side's FM absent.
    pub wb_frame_render_fm_cold: [f32; 9],
    pub wb_frame_render_fm_warm: [f32; 9],
    // --- Black & white mix (#276) — the mode toggle plus 8 per-band
    //     luminance weights over the SAME hue bands as `hsl_*`. Appended at
    //     the struct tail per the offset-stable ABI convention: a stale host
    //     leaves `bw_active` at 0 ⇒ colour render, bit-identical output. ---
    /// 0 = colour (default), non-zero = black & white. Carried as f32 so the
    /// host marshalling stays a single float assignment like every other
    /// slider in this struct.
    pub bw_active: f32,
    pub bw_mix_red: f32,
    pub bw_mix_orange: f32,
    pub bw_mix_yellow: f32,
    pub bw_mix_green: f32,
    pub bw_mix_aqua: f32,
    pub bw_mix_blue: f32,
    pub bw_mix_purple: f32,
    pub bw_mix_magenta: f32,
    // --- colour grading (#275) — the rest of the Color Grading panel
    //     beyond the five `split_tone_*` sliders above (which are ACR's
    //     `crs:SplitToning*` shadow/highlight pairs and balance). Appended
    //     at the struct tail per the offset-stable ABI convention; a stale
    //     host leaves every field 0 = identity. ---
    pub color_grade_shadow_luminance: f32,
    pub color_grade_midtone_hue: f32,
    pub color_grade_midtone_saturation: f32,
    pub color_grade_midtone_luminance: f32,
    pub color_grade_highlight_luminance: f32,
    pub color_grade_global_hue: f32,
    pub color_grade_global_saturation: f32,
    pub color_grade_global_luminance: f32,
    // --- sharpen + chroma NR (#1043) — the two spatial stages the chain
    //     used to omit while the Apple shell re-applied them post-AgX with
    //     its own Metal kernels. Those kernels are gone (epic #925 P5b), so
    //     the chain now runs both at their canonical scene-linear positions
    //     (`vignette` → `sharpen` → `nr_luminance` → `nr_color`), matching
    //     `develop` and the wgpu/WGSL live chain. Appended at the struct
    //     tail per the offset-stable ABI convention: a stale host leaves
    //     every field 0, and both stages short-circuit at amount 0 — so
    //     pre-#1043 callers keep bit-identical output. NOTE that 0 here is
    //     deliberately NOT `AdjustmentModel::default()` (40 / 25): the
    //     host must opt in explicitly, exactly as it does for every other
    //     tail field. ---
    pub sharpen_amount: f32,
    pub sharpen_radius: f32,
    pub sharpen_detail: f32,
    pub sharpen_masking: f32,
    pub nr_color: f32,
    // --- local adjustments (#1698) — the vector-mask layer stack, in the flat
    //     wire `raw_core::types::local_adjustment::flat` defines (24 f32 per
    //     layer). Appended at the struct tail per the offset-stable ABI
    //     convention: a stale host leaves the pointer NULL and the length 0,
    //     which maps to an empty stack, and `local_adjustments::apply`
    //     early-returns — bit-identical to pre-#1698 output.
    //
    //     This is the CPU twin of `MapleGpuLiveParams.local_adjustments_*`.
    //     Both entries must carry it: the CPU chain is the GPU-live path's
    //     fallback and its oracle, so a mask that rendered on one and not the
    //     other would be a live-vs-fallback seam.
    //
    //     The pointed-to data must remain valid for the duration of the call;
    //     the Rust side copies it out and does NOT free the pointer. ---
    pub local_adjustments_ptr: *const f32,
    /// Number of f32 elements at `local_adjustments_ptr`. Must be a multiple of
    /// 24; a trailing partial record is dropped rather than rejected.
    pub local_adjustments_len: usize,
}

/// Decode the local-adjustment layer stack (#1698) out of the C params. NULL or
/// zero-length — every host with no masks, including one built against a
/// pre-#1698 header — yields an empty Vec, which makes
/// `local_adjustments::apply` early-return, so the output stays bit-identical
/// to pre-#1698.
///
/// Shared by BOTH chain entries (`maple_apply_scene_linear_chain` and its f32
/// sibling), which each build their own `AdjustmentModel` from the same params
/// struct. One function rather than two copies: a field that only one of them
/// decoded would render masks on the fp16 path and not the f32 one.
///
/// # Safety
/// `p.local_adjustments_ptr` must be valid for `p.local_adjustments_len` `f32`
/// reads, or null.
pub(crate) unsafe fn read_local_adjustments(
    p: &MapleAdjustmentParams,
) -> Vec<raw_core::types::LocalAdjustment> {
    if p.local_adjustments_ptr.is_null() || p.local_adjustments_len == 0 {
        return Vec::new();
    }
    raw_core::types::layers_from_flat(std::slice::from_raw_parts(
        p.local_adjustments_ptr,
        p.local_adjustments_len,
    ))
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

    // Slider -> model + chain-input mapping is shared with the f32 entry and
    // the `_with_patches` siblings (#1486); see `scene_linear_chain_inputs.rs`.
    let ci = chain_inputs_from_params(p);
    let opts = ci.options(p.skip_agx != 0);

    let in_slice = std::slice::from_raw_parts(in_ptr, lanes);
    let out_vec = match raw_core::pipeline::apply_scene_linear_chain(
        in_slice, width, height, &ci.model, &opts,
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
// Shared params -> chain-input mapping (#1486), used by every entry below.
#[path = "scene_linear_chain_inputs.rs"]
mod scene_linear_chain_inputs;
pub(crate) use scene_linear_chain_inputs::*;

// f32 chain entry lives in a sibling module (file-size budget); the
// `#[no_mangle]` symbol is unaffected by module placement.
#[path = "scene_linear_chain_f32_entry.rs"]
mod scene_linear_chain_f32_entry;
pub use scene_linear_chain_f32_entry::*;

// Patch-compositing entries (#1486) live in a sibling module (file-size
// budget); the `#[no_mangle]` symbols are unaffected by module placement.
#[path = "scene_linear_chain_patches.rs"]
mod scene_linear_chain_patches;
// The C symbols are exported by `#[no_mangle]`, so this re-export exists only
// to give the Rust-side tests a path to them; it is unused in a non-test build.
#[allow(unused_imports)]
pub use scene_linear_chain_patches::{
    maple_apply_scene_linear_chain_f32_with_patches, maple_apply_scene_linear_chain_with_patches,
};

// The display-encode entry lives in a sibling module (file-size budget); the
// `#[no_mangle]` symbol is unaffected by module placement.
#[path = "scene_linear_chain_encode_entry.rs"]
mod scene_linear_chain_encode_entry;
pub use scene_linear_chain_encode_entry::*;
